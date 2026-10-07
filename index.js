/**
 * dsh-token-slimmer — bound and normalize what a session keeps re-sending.
 *
 * ## The cost model, measured
 *
 * A message is not paid for once. It enters the surface, and every later request
 * in the session re-sends it. On 8 recorded sessions from this machine
 * (2,373 steps), weighting each surface entry by the number of later requests
 * that re-sent it:
 *
 *   - everything re-sent          82,811,400 tokens
 *   - tool results                33,722,853   (40.7%)
 *   - reasoning blocks            38,816,942   (46.9%)
 *
 * ## Two surfaces, two mechanisms, one shared principle
 *
 * Tool results are bounded at `tools/post-execute`, before they ever enter a
 * request. Reasoning lives in assistant messages and is bounded at
 * `agent/pre-step` through a surface replacement.
 *
 * The shared principle is that a bound is only free when the content it rewrites
 * has never been carried by a request. Bounding content before its first send
 * cannot invalidate a provider prefix; rewriting history that was already
 * cached re-bills the whole suffix from the change point.
 *
 * ## Why the default strategy predicts nothing
 *
 * The break-even for rewriting cached history is
 * `(remaining steps − 1) × fraction removed > 49`, since an uncached input token
 * costs 50x a cached one at DeepSeek Flash rates. `remaining steps` cannot be
 * known at decision time, so `all` is a bet — and on the measured sessions that
 * bet loses (net −¥0.145). `auto` composes only the two cases that are free
 * regardless of session length: bound the newest assistant message (never sent
 * yet), and bound everything inside a cold window (the cache already lapsed).
 *
 * @module @local/dsh-token-slimmer
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { hasAnalysisIntent } from './policy.js';
import { createMetricsState, predictionKeyOf, recordResult, summarizeMetrics } from './metrics.js';
import { createRecoveryStore, defaultStoreDir, RecoveryError } from './recovery-store.js';
import {
  boundReasoningContent,
  planReasoningPass,
  reasoningBoundedPayload,
  reasoningBoundedProjection,
  REASONING_BOUNDED_EVENT,
  reasoningTokensOf,
  REASONING_WRITES_VERIFIED,
  resolveReasoningOptions,
  UNVERIFIED_WRITE_REASON,
} from './reasoning.js';
import { canonicalArgs, estimateTokens, resolveOptions, shortDigest, slimContent } from './slim.js';

/** Cordis plugin identity. */
export const name = 'token-slimmer';

/** This plugin narrows tool results and assistant reasoning before they are sent. */
export const inject = ['tools', 'sessions'];

/** Largest number of tracked call identities before the oldest entries are dropped. */
const MAX_TRACKED_CALLS = 20000;

/** How many events may pass before running totals are flushed to disk. */
const FLUSH_EVERY = 25;

/** Resolve the stats file, or null when reporting is disabled. */
function statsPathOf(config) {
  if (config?.statsPath === '') return null;
  if (typeof config?.statsPath === 'string' && config.statsPath.length > 0) return config.statsPath;
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
  return join(home, 'token-slimmer-stats.json');
}

/**
 * Config keys this plugin consumes itself rather than forwarding to the
 * compression kernel.
 *
 * The split exists because both halves validate loudly against unknown keys: a
 * `reasoning` object handed to the kernel is an error, and a kernel option
 * handed to the reasoning resolver is an error too. Keeping one flat config
 * without this split is what produced an activation failure the first time this
 * plugin was reloaded, so the split is a tested function rather than two
 * ad-hoc spreads.
 */
export const PLUGIN_OWNED_KEYS = Object.freeze(['reasoning', 'statsPath', 'recovery']);

/** Defaults for the recovery store. */
export const RECOVERY_DEFAULTS = Object.freeze({
  /**
   * Whether the plugin persists originals before publishing a lossy result.
   *
   * On by default because its failure mode is safe: if the store cannot be
   * written, the plugin returns the original text unchanged rather than
   * publishing something it cannot restore.
   */
  enabled: true,
  /** Root directory; empty means one directory per session under DSH home. */
  rootDir: '',
  /** Ceiling for everything the store keeps. */
  maxBytes: 256 * 1024 * 1024,
});

/**
 * Validate the recovery options.
 * @param {object} [raw] - the `recovery` config object.
 * @returns {Readonly<typeof RECOVERY_DEFAULTS>} the resolved options.
 */
export function resolveRecoveryOptions(raw) {
  const out = { ...RECOVERY_DEFAULTS };
  if (raw === undefined) return Object.freeze(out);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('token-slimmer: "recovery" must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!(key in RECOVERY_DEFAULTS)) throw new Error(`token-slimmer: unknown recovery option "${key}"`);
    const value = raw[key];
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw new Error('token-slimmer: recovery.enabled must be a boolean');
    } else if (key === 'rootDir') {
      if (typeof value !== 'string') throw new Error('token-slimmer: recovery.rootDir must be a string');
    } else if (key === 'maxBytes') {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('token-slimmer: recovery.maxBytes must be a positive integer');
      }
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

/**
 * The phrase the kernel writes where a recovery instruction goes.
 *
 * The kernel is pure and cannot know a path, so on its own it emits this fixed
 * sentence. The plugin no longer substitutes it after the fact — it passes a
 * `recoveryNoteFor` into the kernel so the real instruction is written as the
 * marker is rendered. That change came from two defects with one root cause:
 *
 *   1. A global search-and-replace rewrote any content containing the sentence,
 *      including this file's own definition of it, so reading this module back
 *      through a bounded tool result returned fabricated source carrying a
 *      private filesystem path.
 *   2. When a quotation of a complete marker appeared before the kernel's own,
 *      `replace` without `/g` rewrote the quotation and left the real marker
 *      still holding the placeholder — the instruction never materialised at
 *      all.
 *
 * Both are the same mistake: inferring intent from a string. A search cannot
 * tell an instruction from a quotation. This constant remains exported because
 * the kernel's own default and this value must stay one spelling, and tests
 * assert that they do.
 */
export const RECOVERY_NOTE_PLACEHOLDER = 'the rest was not saved; re-run the command only if it is safe to repeat';

/**
 * Split one raw plugin config into kernel options and plugin-owned options.
 * @param {object} [config] - the raw `config` from the loader row.
 * @returns {{ kernel: object, plugin: object }} the two validated-on-use halves.
 */
export function splitConfig(config) {
  const kernel = {};
  const plugin = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (PLUGIN_OWNED_KEYS.includes(key)) plugin[key] = value;
    else kernel[key] = value;
  }
  return { kernel, plugin };
}

/**
 * Install the slimmer.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context; registrations dispose with it.
 * @param {object} [config] - validated by {@link resolveOptions}; throws on unknown keys.
 */
export function apply(ctx, config) {
  const { kernel, plugin } = splitConfig(config);
  const options = resolveOptions(kernel);
  if (!options.enabled) return;
  const reasoningOptions = resolveReasoningOptions(plugin.reasoning);

  const statsPath = statsPathOf(plugin);
  const eventLogPath = statsPath === null ? null : `${statsPath}.log`;

  /** Per-agent call-identity counters, collected with the agent. */
  const callCounts = new WeakMap();
  /** Per-agent wall-clock of the previous step admission, for cold detection. */
  const lastStepAt = new WeakMap();
  /** Per-agent memo of the last-scanned user message, keyed by its surface seq. */
  const intentMemo = new WeakMap();

  const recoveryOptions = resolveRecoveryOptions(plugin.recovery);
  /** One store per session, so recovery files stay attributable. */
  const stores = new Map();
  /** Bound on retained stores; a finished session's directory stays on disk. */
  const MAX_STORES = 64;
  /** Tool calls that are reading a file this plugin wrote for recovery. */
  const recoveryReads = new WeakSet();

  // Record what this instance actually resolved, once, at activation.
  //
  // Added after five restarts produced no reasoning activity and no way to tell
  // why: the file on disk said `strategy: newest, budgetTokens: 100`, the log
  // said nothing at all, and the two facts are consistent with the plugin
  // reading the file, reading nothing, or reading something else entirely.
  // Guessing between those costs a restart each. This costs one line.
  if (eventLogPath !== null) {
    try {
      appendFileSync(
        eventLogPath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          surface: 'activation',
          maxResultTokens: options.maxResultTokens,
          readMaxResultTokens: options.readMaxResultTokens,
          fullTextOnRepeat: options.fullTextOnRepeat,
          reasoningStrategy: reasoningOptions.strategy,
          reasoningBudgetTokens: reasoningOptions.budgetTokens,
          reasoningDryRun: reasoningOptions.dryRun,
          writesVerified: REASONING_WRITES_VERIFIED,
          recoveryEnabled: recoveryOptions.enabled,
        })}\n`,
      );
    } catch {
      /* diagnostics must never block activation */
    }
  }

  /**
   * The recovery store for one agent's session.
   *
   * Keyed by session id rather than by agent so two agents in the same session
   * share one store, and capped so a long-lived process does not accumulate
   * handles it will never use again.
   *
   * @param {object} agent - the calling agent.
   * @returns {object} the store.
   */
  function storeFor(agent) {
    const sessionId = String(agent?.session?.header?.id ?? 'unknown');
    let store = stores.get(sessionId);
    if (store === undefined) {
      store = createRecoveryStore({
        rootDir:
          recoveryOptions.rootDir.length > 0 ? recoveryOptions.rootDir : defaultStoreDir(sessionId),
        maxBytes: recoveryOptions.maxBytes,
      });
      if (stores.size >= MAX_STORES) {
        const oldest = stores.keys().next();
        if (oldest.done !== true) stores.delete(oldest.value);
      }
      stores.set(sessionId, store);
    }
    return store;
  }

  /**
   * Whether the user's most recent message asks for analysis.
   *
   * Memoised per agent against the message's seq: this runs on every tool
   * result, and re-scanning the surface each time would put a real cost on the
   * path this plugin exists to make cheaper.
   *
   * @param {object} agent - the calling agent.
   * @returns {boolean} whether analysis intent is present.
   */
  function analysisIntentFor(agent) {
    const session = agent?.session;
    const nodes = session?.surface?.nodes;
    if (nodes === undefined) return false;
    for (let index = nodes.length - 1; index >= 0; index--) {
      const seq = nodes[index];
      const event = session.eventAt(seq);
      if (event?.type !== 'user/message') continue;
      const memo = intentMemo.get(agent);
      if (memo !== undefined && memo.seq === seq) return memo.value;
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join(' ');
      const value = hasAnalysisIntent(text);
      intentMemo.set(agent, { seq, value });
      return value;
    }
    return false;
  }

  const totals = {
    startedAt: new Date().toISOString(),
    // Tool-result surface.
    resultsSeen: 0,
    resultsBounded: 0,
    resultsEscaped: 0,
    charsIn: 0,
    charsOut: 0,
    tokensIn: 0,
    tokensOut: 0,
    omittedLines: 0,
    byTool: {},
    // Reasoning surface.
    reasoningPasses: 0,
    reasoningColdWindows: 0,
    reasoningBlocksBounded: 0,
    reasoningTokensIn: 0,
    reasoningTokensOut: 0,
    reasoningDryRuns: 0,
    reasoningWritesFailed: 0,
    reasoningWritesRefused: 0,
    reasoningRefusalReason: null,
    reasoningWritesVerified: REASONING_WRITES_VERIFIED,
    strategy: reasoningOptions.strategy,
    // Recovery surface.
    recoverySaved: 0,
    recoveryUnavailable: 0,
    recoveryFailureReason: null,
    recoveryBypassed: 0,
    /** Recovery reads whose file no longer matches the hash we recorded. */
    recoveryUnverified: 0,
    recoveryBytes: 0,
  };
  let sinceFlush = 0;

  /**
   * The accounting ledger for tool results.
   *
   * Every result that reaches the kernel is recorded, not only the ones that
   * were compressed. The old counters accumulated `tokensIn` solely for results
   * that changed, which quietly excluded unchanged, escaped and
   * recovery-failed results from the denominator and inflated every savings
   * rate derived from it. Here the denominator is every result the model was
   * served; only `estimatedTokensSaved` is conditional.
   */
  const metrics = createMetricsState();
  /** Fallback identity for a call that arrives without a callId. */
  let callOrdinal = 0;
  /**
   * A stable digest of the kernel options.
   *
   * Part of the ledger key so a configuration change does not silently merge
   * with observations made under the old one.
   */
  const optionsHash = shortDigest(
    JSON.stringify({
      maxResultTokens: options.maxResultTokens,
      readMaxResultTokens: options.readMaxResultTokens,
      fullTextOnRepeat: options.fullTextOnRepeat,
    }),
  );

  /** Tokens a result occupies across its text blocks. */
  function contentTokensOf(blocks) {
    let total = 0;
    for (const block of blocks) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        total += estimateTokens(block.text);
      }
    }
    return total;
  }

  /** Record one served result against the ledger. Never throws into a tool call. */
  function account(exec, observation) {
    const sessionId = String(exec.agent?.session?.header?.id ?? 'unknown');
    const seq = String(exec.callId ?? `#${++callOrdinal}`);
    recordResult(metrics, {
      id: predictionKeyOf({
        sessionId,
        seq,
        contentHash: shortDigest(observation.contentHashSource),
        optionsHash,
      }),
      mode: 'applied',
      beforeTokens: observation.beforeTokens,
      afterTokens: observation.afterTokens,
      changed: observation.changed,
      escaped: observation.escaped,
      escapeReason: observation.escapeReason,
      toolName: exec.name,
    });
  }

  /** Count one served call against its agent, returning the new count. */
  function countCall(agent, key) {
    if (agent === undefined || agent === null) return 1;
    let table = callCounts.get(agent);
    if (table === undefined) {
      table = new Map();
      callCounts.set(agent, table);
    }
    const next = (table.get(key) ?? 0) + 1;
    table.set(key, next);
    if (table.size > MAX_TRACKED_CALLS) {
      const kept = [...table.entries()].slice(-Math.floor(MAX_TRACKED_CALLS / 2));
      table.clear();
      for (const [keptKey, keptValue] of kept) table.set(keptKey, keptValue);
    }
    return next;
  }

  /** Persist running totals; reporting must never break a tool call. */
  function flush() {
    if (statsPath === null) return;
    try {
      const reasoning = totals.reasoningTokensIn - totals.reasoningTokensOut;
      const ledger = summarizeMetrics(metrics);
      // The denominator is every result the model was served, tool results and
      // reasoning alike. Deriving it from `totals.tokensIn` counted only the
      // results that changed, so the rate read high by construction.
      const denominator = ledger.applied.inputTokens + totals.reasoningTokensIn;
      const numerator = ledger.estimatedAppliedSavings + reasoning;
      const summary = {
        ...totals,
        // The authoritative ledger, alongside the per-surface details above.
        metrics: ledger,
        // Compatibility aliases, now sourced from the ledger rather than
        // recomputed from a partial denominator.
        savedTokens: numerator,
        savedPercent: denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2)),
        options: {
          maxResultTokens: options.maxResultTokens,
          readMaxResultTokens: options.readMaxResultTokens,
          fullTextOnRepeat: options.fullTextOnRepeat,
          reasoning: { ...reasoningOptions },
        },
      };
      mkdirSync(dirname(statsPath), { recursive: true });
      writeFileSync(statsPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    } catch {
      /* best-effort by design */
    }
  }

  /** Append one line to the audit trail. */
  function log(event) {
    if (eventLogPath === null) return;
    try {
      mkdirSync(dirname(eventLogPath), { recursive: true });
      appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      /* best-effort */
    }
  }

  // -------------------------------------------------------------------------
  // Surface 1: tool results, bounded before their first send.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Recovery: keep the original, and never compress a file we wrote ourselves.
  // -------------------------------------------------------------------------

  if (recoveryOptions.enabled) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (exec.name === 'read') {
          const path = exec.arguments?.file_path;
          if (typeof path === 'string' && path.length > 0) {
            const inspection = storeFor(exec.agent).inspect(path);
            if (inspection.owned && inspection.verified) {
              // Marked here and honoured in post-execute: a recovery read has to
              // arrive byte-for-byte, or the model gets a bounded view of the
              // original it asked for and the round trip was pointless.
              recoveryReads.add(exec);
              totals.recoveryBypassed++;
            } else if (inspection.owned) {
              // The path is ours but its bytes are not what we wrote. Publishing
              // them as "the saved original" would be a lie the model cannot
              // detect, so the read is treated as ordinary content and bounded
              // like anything else. Integrity is the whole promise of the
              // bypass; ownership alone is not enough to keep it.
              totals.recoveryUnverified++;
              const reason = inspection.reason ?? 'UNVERIFIED';
              if (totals.recoveryFailureReason === null) totals.recoveryFailureReason = reason;
              log({
                at: new Date().toISOString(),
                surface: 'recovery',
                tool: exec.name,
                callId: exec.callId,
                outcome: 'unverified-read',
                reason,
              });
            }
          }
        }
      } catch {
        // A store that cannot answer must not block the call it was asked about.
      }
      return next();
    });
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept') return decision;
    // A `value` replacement is the tool's own lossless outcome; leave it alone.
    if (Object.hasOwn(decision, 'value')) return decision;
    // A read of our own recovery file passes through untouched, whatever it holds.
    if (recoveryReads.has(exec)) return decision;
    const content = decision.content ?? result.content;
    if (!Array.isArray(content) || content.length === 0) return decision;

    totals.resultsSeen++;

    let fullText = false;
    if (options.fullTextOnRepeat) {
      const key = `${exec.name}\u0000${canonicalArgs(exec.arguments)}`;
      if (countCall(exec.agent, key) > 1) {
        fullText = true;
        totals.resultsEscaped++;
      }
    }

    const analysisIntent = analysisIntentFor(exec.agent);
    const slimmed = slimContent(content, exec.name, options, fullText, { analysisIntent });
    const beforeTokens = contentTokensOf(content);
    const contentHashSource = content
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\u0000');

    if (slimmed === null) {
      // Served whole. It still belongs in the denominator: a savings rate that
      // only counts the results we happened to compress answers a different
      // question than the one being asked.
      account(exec, {
        beforeTokens,
        afterTokens: beforeTokens,
        changed: false,
        escaped: fullText,
        escapeReason: fullText ? 'repeat' : undefined,
        contentHashSource,
      });
      return decision;
    }

    // The lossy candidate exists but is not published yet. The original is
    // persisted first, because a bounded result whose source cannot be reached
    // is just data loss — and re-running the tool is not recovery: a clock, a
    // counter, a live service or a mutable file all come back different.
    //
    // If the snapshot fails, the untouched text is returned and the failure is
    // recorded. Publishing the bounded version anyway would make the marker a
    // lie, and the model would have no way to tell.
    let published = slimmed.blocks;
    /** Stats of the pass whose output is actually published, when they differ. */
    let publishedStats = null;
    if (recoveryOptions.enabled) {
      try {
        const saved = storeFor(exec.agent).save({
          sessionId: String(exec.agent?.session?.header?.id ?? 'unknown'),
          callId: exec.callId,
          blocks: content,
        });
        const byIndex = new Map(saved.files.map((file) => [file.blockIndex, file]));
        // Render a second time, now that the paths exist, so the kernel writes
        // the real instruction into its own markers as it emits them.
        //
        // The previous design wrote a placeholder and then searched the finished
        // text for it. That cannot work: a search cannot tell an instruction from
        // a quotation, and content that quotes a marker — this repository's own
        // fixtures, diffs of them, prose about them — is ordinary content. The
        // first version rewrote those quotations, the second leaked the
        // placeholder into the markers it was meant to fill, and both are the
        // same defect: inferring intent from a string.
        const final = slimContent(content, exec.name, options, fullText, {
          analysisIntent,
          recoveryNoteFor: (blockIndex) => {
            const file = byIndex.get(blockIndex);
            if (file === undefined) return null;
            const location = file.absolutePath ?? file.path;
            return `full original: ${location} — read it with offset=N to resume; ${file.lines} lines saved`;
          },
        });
        if (final !== null) {
          published = final.blocks;
          publishedStats = final.stats;
        }
        totals.recoverySaved++;
        totals.recoveryBytes += saved.totalBytes;
      } catch (error) {
        totals.recoveryUnavailable++;
        const reason =
          error instanceof RecoveryError ? `${error.code}: ${error.message}` : String(error);
        if (totals.recoveryFailureReason === null) totals.recoveryFailureReason = reason;
        log({
          at: new Date().toISOString(),
          surface: 'recovery',
          tool: exec.name,
          callId: exec.callId,
          outcome: 'unavailable',
          reason,
        });
        // The bounded candidate was discarded, so nothing was actually saved.
        // Recording it as an escape keeps it in the denominator while claiming
        // no savings for work the model never received.
        account(exec, {
          beforeTokens,
          afterTokens: beforeTokens,
          changed: false,
          escaped: true,
          escapeReason: 'recovery-unavailable',
          contentHashSource,
        });
        return decision;
      }
    }

    const afterTokens = contentTokensOf(published);
    account(exec, {
      beforeTokens,
      afterTokens,
      changed: true,
      escaped: false,
      contentHashSource,
    });

    // The published pass's stats, not the first pass's.
    //
    // Rendering twice means two different totals can exist: the second pass
    // writes the real recovery paths, which are longer than the placeholder the
    // first pass wrote, so its marker overhead is higher and the convergence
    // loop withdraws more content. The two selections genuinely diverge — ZCode
    // measured 314 → 310 tokens on a fixture. Reporting the first pass while
    // publishing the second made every derived rate read optimistically, and
    // `account` already records the published bytes, so the ledger and the
    // counters disagreed about the same call.
    const stats = publishedStats ?? slimmed.stats;
    totals.resultsBounded++;
    totals.charsIn += stats.charsIn;
    totals.charsOut += stats.charsOut;
    totals.tokensIn += stats.tokensIn;
    totals.tokensOut += stats.tokensOut;
    totals.omittedLines += stats.omittedLines;
    const bucket = totals.byTool[exec.name] ?? { results: 0, tokensIn: 0, tokensOut: 0 };
    bucket.results++;
    bucket.tokensIn += stats.tokensIn;
    bucket.tokensOut += stats.tokensOut;
    totals.byTool[exec.name] = bucket;

    log({
      at: new Date().toISOString(),
      surface: 'tool-result',
      tool: exec.name,
      callId: exec.callId,
      tokensIn: stats.tokensIn,
      tokensOut: stats.tokensOut,
      omittedLines: stats.omittedLines,
      digest: shortDigest(`${stats.charsIn}:${stats.tokensIn}`),
    });

    if (++sinceFlush >= FLUSH_EVERY) {
      sinceFlush = 0;
      flush();
    }

    return { ...decision, kind: 'accept', content: published };
  });

  // -------------------------------------------------------------------------
  // Surface 2: assistant reasoning, bounded by a plugin-owned durable event.
  // -------------------------------------------------------------------------

  // Registered unconditionally, not only when a strategy is armed: the
  // definition has to be present for a session that already carries such an
  // event, which is what makes replay of an older log work. Registering it
  // lazily would make this plugin's own history unreadable to a reader that
  // loads it with strategy 'never'.
  ctx.sessions?.registerMessageProjection?.(reasoningBoundedProjection);

  if (reasoningOptions.strategy !== 'never') {
    ctx.on('agent/pre-step', async ({ agent, step, messages }, next) => {
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      try {
        // `messages` is the request this step is about to make. It is the only
        // place that knows which assistant messages are still unsent, and an
        // unsent message is the only one whose rewrite is free.
        runReasoningPass(agent, step, Array.isArray(messages) ? messages : []);
      } catch (error) {
        // A reasoning pass is an optimization; it must never block a step.
        //
        // But swallowing it silently is how this went undiagnosed across eight
        // restarts: the listener was registered, the chain handed back 'enter',
        // and nothing happened -- which is also exactly what a thrown error
        // looks like from outside, because this branch only reached the logger.
        totals.reasoningWritesFailed++;
        ctx.logger?.warn?.(`token-slimmer: reasoning pass failed: ${String(error)}`);
        log({
          at: new Date().toISOString(),
          surface: 'reasoning-error',
          step,
          error: String(error),
          stack: (error?.stack ?? '').split('\n').slice(0, 4).join(' | '),
        });
      }
      return decision;
    });
  }

  /**
   * Detect whether the provider's prefix cache plausibly lapsed since the last
   * step admission. The first step of a session reports false: with no previous
   * admission there is nothing to compare, and guessing "cold" there would spend
   * a cache the caller may actually have.
   *
   * @param {object} agent - the step's agent.
   * @param {Readonly<typeof reasoningOptions>} options - resolved reasoning options.
   * @returns {boolean} whether this step opens a cold window.
   */
  function detectCold(agent, options) {
    if (agent === undefined || agent === null) return false;
    const previous = lastStepAt.get(agent);
    const now = Date.now();
    lastStepAt.set(agent, now);
    if (previous === undefined) return false;
    return now - previous > options.coldAfterMs;
  }

  /**
   * Bound the reasoning of the assistant messages this strategy permits.
   *
   * A write is refused unless the provider's contract has been verified
   * (`REASONING_WRITES_VERIFIED`). With writes refused the pass still runs and
   * still records what it *would* have removed, so the candidate can be
   * measured without touching a session. That separation matters because the
   * failure mode of a bad write is a rejected request, not a smaller bill.
   *
   * @param {object} agent - the step's agent.
   * @param {number} step - the step being admitted.
   */
  /**
   * Which surface assistant messages are provably still unsent.
   *
   * The request this step is about to make carries `messages`, and the
   * assistant messages in it are the ones that will be sent for the first time.
   * They are the tail of the surface's assistant messages, because the surface
   * is ordered and a request never skips over history.
   *
   * So rather than match individual messages -- `MessageBase` carries an `id`
   * but no seq, so the mapping back to the surface is not available directly --
   * this counts them. The last N assistant surface events are the N the request
   * is about to carry.
   *
   * @param {object[]} messages - the request this step will make.
   * @param {{ seq: number }[]} targets - surface assistant messages in order.
   * @returns {Set<number>} seqs that have never been sent.
   */
  function provablyUnsentSeqs(messages, targets) {
    let pending = 0;
    for (const message of messages) {
      if (message?.role === 'assistant') pending++;
    }
    if (pending === 0) return new Set();
    const unsent = new Set();
    for (const target of targets.slice(Math.max(0, targets.length - pending))) {
      unsent.add(target.seq);
    }
    return unsent;
  }

  function runReasoningPass(agent, step, pendingMessages) {
    const session = agent?.session;
    if (session === undefined || session === null) {
      // Every early exit here was silent before, which made "the pass ran and
      // found nothing" indistinguishable from "the pass never got past its
      // guards". Each one now names itself and carries the shape it was handed.
      log({
        at: new Date().toISOString(),
        surface: 'reasoning-void',
        step,
        reason: 'no-session',
        agentType: typeof agent,
        agentKeys: agent === null || agent === undefined ? '(none)' : Object.keys(agent).slice(0, 10).join(','),
      });
      return;
    }
    const nodes = session.surface?.nodes;
    if (nodes === undefined) {
      log({
        at: new Date().toISOString(),
        surface: 'reasoning-void',
        step,
        reason: 'no-surface-nodes',
        sessionKeys: Object.keys(session).slice(0, 12).join(','),
      });
      return;
    }

    const cold = detectCold(agent, reasoningOptions);

    /**
     * Every assistant message on the surface, each tagged with whether it
     * exceeds the budget.
     *
     * Selection is expressed in terms of that flag, never of position in a
     * pre-filtered list: a `newest`-only policy that reads "the last over-budget
     * entry" reaches backwards to an already-sent message whenever the newest
     * reply happens to be short.
     */
    const targets = [];
    const seenTypes = new Map();
    for (const seq of nodes) {
      const event = session.eventAt(seq);
      const type = event?.type ?? '<none>';
      seenTypes.set(type, (seenTypes.get(type) ?? 0) + 1);
      if (event?.type !== 'assistant/message') continue;
      const message = event.data?.message;
      if (message === undefined) continue;
      const tokens = reasoningTokensOf(message.content);
      targets.push({
        index: targets.length,
        seq,
        data: event.data,
        message,
        tokens,
        overBudget: tokens > reasoningOptions.budgetTokens,
      });
    }

    // The newest assistant messages in the request this step is about to make
    // are the only ones provably still unsent; see provablyUnsentSeqs.
    const unsentSeqs = provablyUnsentSeqs(pendingMessages, targets);

    const selected = planReasoningPass(targets, reasoningOptions.strategy, cold, unsentSeqs);
    if (selected.length === 0) {
      // One line explaining why nothing was selected, written only when the
      // strategy is armed. Without it, "armed but idle" and "never armed" look
      // identical from outside: both produce zero log lines, and telling them
      // apart cost several restarts.
      if (reasoningOptions.strategy !== 'never') {
        log({
          at: new Date().toISOString(),
          surface: 'reasoning-idle',
          step,
          strategy: reasoningOptions.strategy,
          cold,
          surfaceNodes: nodes.length,
          candidates: targets.length,
          overBudget: targets.filter((target) => target.overBudget === true).length,
          nodeTypes: [...seenTypes.entries()].map(([type, count]) => `${type}:${count}`).join(' '),
        });
      }
      return;
    }

    const writeAllowed = reasoningOptions.dryRun === false && REASONING_WRITES_VERIFIED;
    totals.reasoningPasses++;
    if (cold) totals.reasoningColdWindows++;
    if (!writeAllowed && reasoningOptions.strategy !== 'never') {
      totals.reasoningWritesRefused += selected.length;
      if (totals.reasoningRefusalReason === null) totals.reasoningRefusalReason = UNVERIFIED_WRITE_REASON;
    }

    for (const target of selected) {
      const bounded = boundReasoningContent(target.message.content, reasoningOptions);
      if (bounded === null) continue;
      totals.reasoningBlocksBounded++;
      totals.reasoningTokensIn += bounded.tokensIn;
      totals.reasoningTokensOut += bounded.tokensOut;
      if (!writeAllowed) {
        totals.reasoningDryRuns++;
        log({
          at: new Date().toISOString(),
          surface: 'reasoning',
          step,
          mode: 'dry-run',
          cold,
          strategy: reasoningOptions.strategy,
          seq: target.seq,
          tokensIn: bounded.tokensIn,
          tokensOut: bounded.tokensOut,
          reason: REASONING_WRITES_VERIFIED ? 'dryRun' : 'unverified-write',
        });
        continue;
      }
      // A durable rewrite is published as this plugin's own event type, carrying
      // `ignorable: true`, and interpreted by a registered message projection.
      //
      // Route 1 — an `assistant/message` carrying `surfaceOp: replace` — is
      // closed by two rules that hold simultaneously: such a message may not
      // carry `sourceEventSeqs` ("it embeds its source stream"), and a
      // replacement must cite every node it shadows. With no sources the range
      // check can never pass, so every write threw:
      //
      //   surface replace: sourceEventSeqs must include every shadowed surface
      //   node; missing <seq>
      //
      // Route 2 works only with the marker: the harness refuses any stored row
      // whose type is outside its first-party catalog unless the row itself says
      // `ignorable: true` (`dsh-session-persistence` lib/index.js:184), that
      // catalog cannot be extended by a plugin, and `Session.append` had no
      // argument for the member — so the row was written anyway and the whole
      // session became unopenable, by this harness as much as by any other
      // ("contains event type token-slimmer/reasoning-bounded ... not marked
      // ignorable"). `append` now carries the option through to the envelope.
      //
      // A harness without that change drops the option silently, so the write
      // additionally stays behind REASONING_WRITES_VERIFIED: where the marker
      // cannot be recorded, the rewrite is not recorded at all.
      const payload = reasoningBoundedPayload([{ seq: target.seq, content: bounded.content }]);
      if (payload === null) continue;
      session.append(REASONING_BOUNDED_EVENT, payload, { ignorable: true });
      log({
        at: new Date().toISOString(),
        surface: 'reasoning',
        step,
        mode: 'applied',
        cold,
        strategy: reasoningOptions.strategy,
        seq: target.seq,
        tokensIn: bounded.tokensIn,
        tokensOut: bounded.tokensOut,
      });
    }

    if (++sinceFlush >= FLUSH_EVERY) {
      sinceFlush = 0;
      flush();
    }
  }

  ctx.on('agent/disposed', () => {
    flush();
  });
}
