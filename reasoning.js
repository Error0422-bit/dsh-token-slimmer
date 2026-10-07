/**
 * Reasoning budgeting for assistant messages.
 *
 * Reasoning is the largest single re-send surface in this harness's sessions
 * (46.9% of all re-send cost across 8 measured sessions). It lives in assistant
 * messages, so `tools/post-execute` never sees it and no tool-level guard can
 * bound it.
 *
 * ## Why the strategy is a function of cache state, not of predicted session length
 *
 * The break-even condition for rewriting history is
 * `(remaining steps − 1) × fraction removed > 49`, because one request that
 * reprocesses a cold prefix costs 50x a cached one. `remaining steps` is not
 * knowable when the decision has to be made, so any "always rewrite everything"
 * policy is a bet, and on the measured sessions that bet loses money
 * (net −¥0.145 across 8 sessions).
 *
 * Two situations avoid the bet entirely:
 *
 *   - The newest assistant message has never been carried by a request — the
 *     next one will be the first. Bounding it cannot invalidate anything.
 *   - A cold window means the provider's cache already lapsed, so the prefix is
 *     going to be reprocessed whatever happens. Rewriting it is then free.
 *
 * Both are observable at decision time. That is why `auto` composes exactly
 * these two and never predicts anything: it is the only strategy that can be
 * shown not to lose, without knowing how long the session will run.
 *
 * `all` is still available for callers who know their workload outruns the
 * break-even point, and it is deliberately absent from `auto`.
 *
 * @module dsh-token-slimmer/reasoning
 */

import { estimateTokens } from './slim.js';

/** Marker left in place of elided reasoning. */
export const REASONING_MARKER = '⟪[… reasoning elided by token-slimmer]⟫';

/** Defaults for the reasoning pass. */
export const REASONING_DEFAULTS = Object.freeze({
  /**
   * One of `never` | `newest` | `cold` | `all` | `auto`.
   *
   * - `never`  — leave reasoning alone. **The default.**
   * - `newest` — bound only the most recent assistant message.
   * - `cold`   — bound all of it, but only inside a detected cold window.
   * - `all`    — bound all of it on every step.
   * - `auto`   — `newest` always, escalating to all of it inside a cold window.
   *
   * Defaults to `never` because none of the rewriting modes has been validated
   * end to end. The backtest is real (8 sessions, 2,373 steps, zero
   * cache-busting steps at the time it was run), but it is a model of provider
   * behaviour, not provider behaviour: no run has confirmed that this harness's
   * DeepSeek route accepts a rewritten assistant message, nor that quality
   * survives. Two defects found after that backtest also invalidate its
   * `newest` result — see {@link WRITE_VERIFICATION}.
   */
  strategy: 'never',
  /** Token budget for a bounded reasoning block. */
  budgetTokens: 500,
  /** Idle time after which the provider's prefix cache is treated as lapsed. */
  coldAfterMs: 5 * 60 * 1000,
  /** Report what the pass would do without writing anything to the session. */
  dryRun: true,
  /** Share of the budget given to the opening paragraphs. */
  headRatio: 0.55,
});

/**
 * Whether rewriting assistant reasoning has been verified for this harness.
 *
 * Reasoning signing and replay rules differ per provider, and DSH's DeepSeek
 * route documents that whether reasoning is carried back depends on the request
 * shape. Until a provider's contract has been checked against a real response,
 * a write is refused rather than attempted: a message whose body changed while
 * its replay signature stayed the same is a protocol violation, and the failure
 * mode is a rejected request, not a smaller bill.
 *
 * Flip this only with evidence: a recorded exchange showing the rewritten
 * message accepted, plus an A/B on task quality. Turning it on makes
 * `strategy` meaningful; leaving it off makes every non-`never` strategy report
 * itself as unverified and fall back to leaving content alone.
 */
/**
 * Whether a rewritten assistant body may be written back to a session.
 *
 * Held at `false`. The mechanism is now correct — the write lands as a
 * plugin-owned event interpreted by a registered message projection, and an
 * experiment on 2026-10-06 confirmed the provider accepts a rewritten body
 * (`mode: "applied"`, 197 → 49 tokens, no request failure).
 *
 * Acceptance is not the same as profit, which is what keeps this false:
 *
 *  - reasoning is billed as context. `cacheReadTokens` grows step over step
 *    across a rewrite, so the surface-side pool is real rather than nominal.
 *  - but rewriting history that a request already carried re-bills the suffix
 *    from the change point. The break-even is `(remaining steps − 1) × fraction
 *    removed > 49` at the 50× cached/uncached ratio, and remaining steps are not
 *    knowable at decision time.
 *
 * So enabling this trades certain savings on never-sent content for a bet on how
 * much of the session is left. `auto` already takes that bet only where it is
 * free. Flipping this constant is a decision about the bet, not about the
 * mechanism — and it wants a controlled measurement first, which has not been
 * run.
 */
export const REASONING_WRITES_VERIFIED = false;

/** Reason text used wherever a write is refused. */
export const UNVERIFIED_WRITE_REASON =
  'reasoning rewrite is not verified for this provider: the route has been shown to accept a ' +
  'rewritten body, but not that the rewrite pays for itself. Run with dryRun: true to measure ' +
  'the candidate.';

/** Strategies that only observe. */
const READ_ONLY_STRATEGIES = new Set(['never']);


const NUMERIC_REASONING_KEYS = new Set(['budgetTokens', 'coldAfterMs']);
const STRATEGIES = new Set(['never', 'newest', 'cold', 'all', 'auto']);

/**
 * Validate and freeze the reasoning options.
 * @param {object} [raw] - the `reasoning` config object.
 * @returns {Readonly<typeof REASONING_DEFAULTS>} the resolved options.
 */
export function resolveReasoningOptions(raw) {
  const out = { ...REASONING_DEFAULTS };
  if (raw === undefined) return Object.freeze(out);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('token-slimmer: "reasoning" must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!(key in REASONING_DEFAULTS)) throw new Error(`token-slimmer: unknown reasoning option "${key}"`);
    const value = raw[key];
    if (key === 'strategy') {
      if (!STRATEGIES.has(value)) {
        throw new Error(`token-slimmer: reasoning.strategy must be one of ${[...STRATEGIES].join(', ')}`);
      }
    } else if (key === 'dryRun') {
      if (typeof value !== 'boolean') throw new Error('token-slimmer: reasoning.dryRun must be a boolean');
    } else if (key === 'headRatio') {
      // A fraction, not a count. Validating it with the integer group rejected
      // the only values it can usefully take, including the default.
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error('token-slimmer: reasoning.headRatio must be a finite number between 0 and 1');
      }
    } else if (NUMERIC_REASONING_KEYS.has(key)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`token-slimmer: reasoning.${key} must be a non-negative integer`);
      }
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

/**
 * Total tokens of reasoning across one content array.
 * @param {readonly { type: string, text?: string }[]} content - assistant content blocks.
 * @returns {number} estimated tokens.
 */
export function reasoningTokensOf(content) {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (block?.type === 'reasoning' && typeof block.text === 'string') total += estimateTokens(block.text);
  }
  return total;
}

/** Slice one paragraph-free blob near its proportional head/tail boundary. */
function sliceBlob(text, budget, headRatio) {
  const total = estimateTokens(text);
  const share = Math.max(1, Math.floor(text.length * (budget / Math.max(1, total))));
  const headChars = Math.floor(share * headRatio);
  const tailChars = share - headChars;
  return `${text.slice(0, headChars)}${REASONING_MARKER}${tailChars > 0 ? text.slice(text.length - tailChars) : ''}`;
}

/**
 * Bound one reasoning string, keeping whole opening and closing paragraphs.
 *
 * Reasoning reads as prose, so paragraph boundaries are the natural cut points;
 * only a single-paragraph blob falls back to proportional character slicing.
 *
 * @param {string} text - reasoning text.
 * @param {number} budget - token budget.
 * @param {number} headRatio - share of the budget given to the opening.
 * @returns {string | null} the bounded text, or null when it already fits.
 */
export function boundReasoningText(text, budget, headRatio) {
  if (budget <= 0) return null;
  if (estimateTokens(text) <= budget) return null;
  // The marker is part of what gets produced, so its cost comes out of the
  // budget before any text is allocated. Ignoring it made the result overshoot
  // its own ceiling, which made a second pass shrink it again and the function
  // oscillate instead of reaching a fixed point.
  const markerTokens = estimateTokens(REASONING_MARKER) + 4;
  const contentBudget = budget - markerTokens;
  // Too small to hold even the marker: leave the text alone rather than emit a
  // marker that says less than it costs.
  if (contentBudget <= 0) return null;
  const parts = text.split(/\n{2,}/).filter((part) => part.length > 0);
  if (parts.length <= 2) return sliceBlob(text, contentBudget, headRatio);
  const headBudget = Math.floor(contentBudget * headRatio);
  const tailBudget = Math.max(0, contentBudget - headBudget);
  const head = [];
  let spent = 0;
  for (const part of parts) {
    const cost = estimateTokens(part) + 2;
    if (spent + cost > headBudget) break;
    head.push(part);
    spent += cost;
  }
  const tail = [];
  spent = 0;
  for (let index = parts.length - 1; index >= head.length; index--) {
    const cost = estimateTokens(parts[index]) + 2;
    if (spent + cost > tailBudget) break;
    tail.unshift(parts[index]);
    spent += cost;
  }
  if (head.length === 0 && tail.length === 0) return sliceBlob(text, contentBudget, headRatio);
  return [...head, REASONING_MARKER, ...tail].join('\n\n');
}

/**
 * Replace every reasoning block of one content array with its bounded form.
 *
 * Text and tool-call blocks are passed through by identity: the assistant
 * message's non-reasoning content is what the conversation is actually made of,
 * and must survive byte-for-byte.
 *
 * @param {readonly object[]} content - assistant content blocks.
 * @param {Readonly<typeof REASONING_DEFAULTS>} options - resolved reasoning options.
 * @returns {{ content: object[], tokensIn: number, tokensOut: number } | null} replacement, or null.
 */
export function boundReasoningContent(content, options) {
  if (!Array.isArray(content) || content.length === 0) return null;
  const out = [];
  let touched = false;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const block of content) {
    if (block?.type !== 'reasoning' || typeof block.text !== 'string') {
      out.push(block);
      continue;
    }
    const before = estimateTokens(block.text);
    tokensIn += before;
    const bounded = boundReasoningText(block.text, options.budgetTokens, options.headRatio);
    if (bounded === null) {
      out.push(block);
      tokensOut += before;
      continue;
    }
    touched = true;
    out.push({ ...block, text: bounded });
    tokensOut += estimateTokens(bounded);
  }
  if (!touched) return null;
  return { content: out, tokensIn, tokensOut };
}

/**
 * Choose which reasoning-bearing surface nodes a pass may rewrite.
 *
 * Pure and synchronous on purpose: this is the decision the whole feature turns
 * on, so it is testable and replayable against recorded sessions rather than
 * only observable in production.
 *
 * Every target reports whether it is over budget, and selection is expressed in
 * terms of that flag rather than of position in a pre-filtered list. The earlier
 * signature took only over-budget targets, which made `newest` mean "the last
 * over-budget target" — so when the newest reply was short and an older one was
 * long, `newest` selected the *older* message. That message had already been
 * carried by a request, so rewriting it invalidated a warm prefix and broke the
 * single guarantee the strategy exists to provide.
 *
 * @param {{ index: number, overBudget: boolean }[]} targets - reasoning-bearing
 *   nodes in surface order; `overBudget` says whether the node exceeds the budget.
 * @param {string} strategy - one of `never` | `newest` | `cold` | `all` | `auto`.
 * @param {boolean} cold - whether a cold window was detected.
 * @returns {object[]} the selected targets.
 */
/**
 * Which messages a strategy may rewrite.
 *
 * The candidate set is split by a property that is not a preference but a fact:
 * whether the message has ever been carried by a request.
 *
 *  - **Unsent** — the message is part of the request this step is about to make,
 *    so it is in no cached prefix. Bounding it is free, and bounding it *now* is
 *    the only chance: once sent, the cost changes.
 *  - **Sent** — the message is already cached. Rewriting it invalidates the
 *    suffix from the change point, which is re-billed at the miss rate.
 *    Measured, that costs about ten times what the removal saves
 *    (`test/reasoning-net.mjs`: 77 removed against 733 invalidated, break-even
 *    at 467 remaining steps against 16 available).
 *
 * A strategy that only observes is unaffected. A strategy that writes is
 * restricted to the unsent set, because that restriction is what makes the write
 * free rather than merely permitted.
 *
 * @param {{ index: number, seq: number, overBudget: boolean }[]} targets
 *   every surface assistant message, in order.
 * @param {string} strategy - one of `never` | `newest` | `cold` | `all` | `auto`.
 * @param {boolean} cold - whether a cold window is detected.
 * @param {Set<number>} [unsentSeqs] - seqs the pending request has not sent yet.
 * @returns {object[]} the messages this pass may rewrite.
 */
export function planReasoningPass(targets, strategy, cold, unsentSeqs = new Set()) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  if (strategy === 'never') return [];
  const exceeding = targets.filter((target) => target.overBudget === true);

  // When the caller cannot say what is unsent, no write is provably free, so
  // nothing is selected. The previous behaviour was to select anyway and rely on
  // "the newest one is probably unsent" -- a bet whose expected value is
  // negative and which the measurements above let us stop making.
  const free = exceeding.filter((target) => unsentSeqs.has(target.seq));
  // The newest message, whether or not it is over budget. Selecting "the newest
  // over-budget one" instead would reach backwards past a short final reply to
  // an older message -- which is the defect `newest` exists to avoid, so the
  // over-budget test is applied to this one target rather than used as a filter.
  const newest = targets[targets.length - 1];
  const newestFree = newest.overBudget === true && unsentSeqs.has(newest.seq) ? [newest] : [];

  switch (strategy) {
    case 'newest':
      // The newest message this request will send for the first time. If it fits
      // its budget there is nothing to do, and reaching further back would
      // rewrite sent history at a cost the removal does not cover.
      return newestFree;
    case 'cold':
      // A cold window means the cache already lapsed, so sent content is fair
      // game again -- that is the one condition under which its rewrite is free.
      return cold ? exceeding : [];
    case 'all':
      // Only the unsent set: "all" has never meant "regardless of cost".
      return free;
    case 'auto':
      return cold ? exceeding : newestFree;
    default:
      throw new Error(`token-slimmer: unknown reasoning strategy "${strategy}"`);
  }
}

// ---------------------------------------------------------------------------
// Durable rewrite: the only mechanism the session accepts for this
// ---------------------------------------------------------------------------

/**
 * Event type this plugin owns for recording a reasoning rewrite.
 *
 * Published with `session.append`, interpreted by {@link reasoningBoundedProjection}.
 */
export const REASONING_BOUNDED_EVENT = 'token-slimmer/reasoning-bounded';

/** Whether a durable value is a plain JSON object. */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a durable value is a canonical non-negative sequence number. */
function isCanonicalSeq(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/**
 * Replace the reasoning text of one message, preserving every other block.
 *
 * Untouched blocks keep their identity so the session can tell what actually
 * changed. A message whose reasoning did not change returns null, and the
 * projection omits it entirely rather than publishing a no-op.
 *
 * @param {object} message - the message to rewrite.
 * @param {Map<number, string>} replacements - block index to new text.
 * @returns {object | null} the rewritten message, or null when nothing matched.
 */
function withBoundedReasoning(message, replacements) {
  if (!isPlainRecord(message) || !Array.isArray(message.content)) return null;
  let next = null;
  for (let index = 0; index < message.content.length; index++) {
    const replacement = replacements.get(index);
    if (replacement === undefined) continue;
    const block = message.content[index];
    if (!isPlainRecord(block) || block.type !== 'reasoning' || typeof block.text !== 'string') continue;
    if (block.text === replacement) continue;
    next ??= message.content.slice(0, index);
    next.push({ ...block, text: replacement });
  }
  if (next === null) return null;
  for (let index = next.length; index < message.content.length; index++) next.push(message.content[index]);
  return { ...message, content: next };
}

/**
 * Pure interpretation of a `token-slimmer/reasoning-bounded` event.
 *
 * This is how a plugin changes the content of an assistant message. The
 * alternative — appending an `assistant/message` carrying `surfaceOp: replace` —
 * cannot work, and the session states the reason twice over: such a message may
 * not carry `sourceEventSeqs` (it "embeds its source stream"), while a
 * replacement must cite every node it shadows. With no sources the range check
 * can never be satisfied, so every write threw:
 *
 *     surface replace: sourceEventSeqs must include every shadowed surface node
 *
 * That is why this feature produced no output for as long as it existed. Not
 * because a provider refused a rewritten body — the write never reached one.
 *
 * Registered via `ctx.sessions.registerMessageProjection` and published by
 * appending this event type with no `surfaceOp`. Detached readers that supply
 * this same definition reconstruct the same model input.
 */
export const reasoningBoundedProjection = {
  type: REASONING_BOUNDED_EVENT,
  /**
   * @param {object} event - the durable decision.
   * @param {object} context - the history preceding it.
   * @returns {Map<number, object>} changed messages keyed by their original seq.
   */
  project(event, context) {
    const data = event.data;
    if (!isPlainRecord(data) || !Array.isArray(data.targets) || data.targets.length === 0) {
      throw new Error(`${REASONING_BOUNDED_EVENT}: data must carry a nonempty targets array`);
    }
    const nodes = new Set(context.nodes);
    const messages = new Map();
    for (const target of data.targets) {
      if (!isPlainRecord(target) || !isCanonicalSeq(target.seq) || !Array.isArray(target.blocks) || target.blocks.length === 0) {
        throw new Error(`${REASONING_BOUNDED_EVENT}: each target needs a seq and a nonempty blocks array`);
      }
      const seq = target.seq;
      if (messages.has(seq)) throw new Error(`${REASONING_BOUNDED_EVENT}: duplicate target seq ${seq}`);
      if (!nodes.has(seq)) {
        throw new Error(`${REASONING_BOUNDED_EVENT}: target seq ${seq} is not a current surface node`);
      }
      const source = context.events[seq - context.baseSeq];
      if (source?.type !== 'assistant/message') {
        throw new Error(`${REASONING_BOUNDED_EVENT}: target seq ${seq} must be an assistant/message`);
      }
      const replacements = new Map();
      for (const entry of target.blocks) {
        if (!isPlainRecord(entry) || !Number.isSafeInteger(entry.blockIndex) || typeof entry.text !== 'string') {
          throw new Error(`${REASONING_BOUNDED_EVENT}: each block needs a blockIndex and text`);
        }
        replacements.set(entry.blockIndex, entry.text);
      }
      const message = context.messages.get(seq) ?? source.data?.message;
      const rewritten = withBoundedReasoning(message, replacements);
      if (rewritten !== null) messages.set(seq, rewritten);
    }
    return messages;
  },
};

/**
 * The payload an append should record, or null when there is nothing to write.
 *
 * Built beside the projection so the published shape and the interpreted shape
 * cannot drift apart — the session validates the durable value strictly, and a
 * mismatch there fails the write rather than the read.
 *
 * @param {{ seq: number, content: object[] }[]} selected - bounded targets.
 * @returns {{ targets: { seq: number, blocks: { blockIndex: number, text: string }[] }[] } | null}
 */
export function reasoningBoundedPayload(selected) {
  const targets = [];
  for (const target of selected) {
    const blocks = [];
    for (let index = 0; index < target.content.length; index++) {
      const block = target.content[index];
      if (!isPlainRecord(block) || block.type !== 'reasoning' || typeof block.text !== 'string') continue;
      blocks.push({ blockIndex: index, text: block.text });
    }
    if (blocks.length > 0) targets.push({ seq: target.seq, blocks });
  }
  return targets.length === 0 ? null : { targets };
}
