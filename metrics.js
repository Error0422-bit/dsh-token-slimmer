/**
 * Metrics ledger: what compression actually saved, and what a request cost.
 *
 * The module answers two questions the old `savedTokens` total conflated:
 * how many tokens this run *did not send* because they were bounded before
 * their first request (applied), and how many a disabled pass *would have*
 * saved (dry run, banked once per candidate no matter how often it is
 * observed). Unchanged, escaped, and recovery-failed results stay in the
 * denominator — a pass that compressed nothing must print 0%, not a healthy
 * fraction of a denominator that only counted its wins.
 *
 * Money is never derived from token estimates: `priceUsage` bills only
 * per-request hit/miss/output usage against explicit versioned rates, and
 * reports `unknown` for anything it lacks instead of guessing zero. Pure
 * functions only — persistence and the audit trail stay in `index.js`.
 *
 * Interfaces specified by 2026-09-28 task 5, amended by the 2026-09-29
 * follow-up (which supersedes on conflict).
 *
 * @module metrics
 */

/** Summary shape version; bumped when field semantics change. */
export const METRICS_SCHEMA_VERSION = 2;

/**
 * Create an isolated ledger state. Every plugin instance gets its own; two
 * states never share entries, and nothing here is module-level.
 * @returns {{schemaVersion: number, results: Map, usage: object[], events: object[], totals: object}}
 */
export function createMetricsState() {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    /** id → classification entry; the single source of per-result truth. */
    results: new Map(),
    /** Priced usage records, as returned by `priceUsage`. */
    usage: [],
    /** Event-level log. Ids and counters only — never text or call arguments. */
    events: [],
    totals: { applied: freshTotals(), dryRun: freshTotals() },
  };
}

function freshTotals() {
  return {
    results: 0,
    inputTokens: 0,
    estimatedTokensSaved: 0,
    byOutcome: { bounded: 0, unchanged: 0, escaped: 0 },
  };
}

/**
 * Build the dry-run dedup key from its four required dimensions. A partial
 * key would silently merge distinct candidates, so all of them are required.
 * @param {{sessionId: string|number, seq: number, contentHash: string, optionsHash: string}} parts
 * @returns {string} the composite key, usable as a `recordResult` id.
 */
export function predictionKeyOf({ sessionId, seq, contentHash, optionsHash }) {
  for (const [name, value] of [['sessionId', sessionId], ['seq', seq], ['contentHash', contentHash], ['optionsHash', optionsHash]]) {
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`predictionKeyOf: ${name} is required`);
    }
  }
  return [sessionId, seq, contentHash, optionsHash].join('\u0000');
}

function requireTokens(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`recordResult: ${name} must be a finite number`);
  }
}

/**
 * Record one observation of a tool result (or reasoning candidate) against
 * the ledger. The first record of an id fixes its classification; later
 * records only bump the observation count. A dry-run candidate that later
 * applies moves its saving from the potential bucket to the applied bucket
 * exactly once — idempotent re-application never re-banks it.
 *
 * @param {object} state - ledger state from `createMetricsState`.
 * @param {object} observation
 * @param {string} observation.id - result identity, or a `predictionKeyOf` composite.
 * @param {'applied'|'dryRun'} [observation.mode='applied']
 * @param {number} observation.beforeTokens - tokens the result occupied on the surface.
 * @param {number} observation.afterTokens - tokens it occupies after bounding.
 * @param {boolean} [observation.changed] - false when served whole.
 * @param {boolean} [observation.escaped] - true for escape hatches (repeat, guard, recovery fallback).
 * @param {string} [observation.escapeReason]
 * @param {string} [observation.toolName]
 */
export function recordResult(state, { id, mode = 'applied', beforeTokens, afterTokens, changed, escaped, escapeReason, toolName }) {
  if (typeof id !== 'string' || id === '') throw new TypeError('recordResult: id must be a non-empty string');
  if (mode !== 'applied' && mode !== 'dryRun') throw new TypeError(`recordResult: unknown mode ${String(mode)}`);
  requireTokens(beforeTokens, 'beforeTokens');
  requireTokens(afterTokens, 'afterTokens');

  const entry = state.results.get(id);
  if (entry === undefined) {
    state.results.set(id, {
      mode,
      beforeTokens,
      afterTokens,
      changed: changed === true,
      escaped: escaped === true,
    });
    bank(state, mode, beforeTokens, afterTokens, changed === true, escaped === true);
  } else if (mode === 'applied' && entry.mode === 'dryRun') {
    // The write actually happened: move the banked prediction once.
    unbank(state, 'dryRun', entry.beforeTokens, entry.afterTokens, entry.changed, entry.escaped);
    entry.mode = 'applied';
    entry.beforeTokens = beforeTokens;
    entry.afterTokens = afterTokens;
    entry.changed = changed === true;
    entry.escaped = escaped === true;
    bank(state, 'applied', beforeTokens, afterTokens, entry.changed, entry.escaped);
  }
  state.events.push({
    kind: 'result',
    id,
    mode,
    beforeTokens,
    afterTokens,
    changed: changed === true,
    escaped: escaped === true,
    ...(escapeReason !== undefined ? { escapeReason } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    observedAt: Date.now(),
  });
}

function savingsOf(beforeTokens, afterTokens, changed, escaped) {
  if (!changed || escaped) return 0;
  return Math.max(0, beforeTokens - afterTokens);
}

function bank(state, bucket, beforeTokens, afterTokens, changed, escaped) {
  const totals = state.totals[bucket];
  totals.results += 1;
  totals.inputTokens += beforeTokens;
  totals.estimatedTokensSaved += savingsOf(beforeTokens, afterTokens, changed, escaped);
  if (escaped) totals.byOutcome.escaped += 1;
  else if (!changed) totals.byOutcome.unchanged += 1;
  else totals.byOutcome.bounded += 1;
}

function unbank(state, bucket, beforeTokens, afterTokens, changed, escaped) {
  const totals = state.totals[bucket];
  totals.results -= 1;
  totals.inputTokens -= beforeTokens;
  totals.estimatedTokensSaved -= savingsOf(beforeTokens, afterTokens, changed, escaped);
  if (escaped) totals.byOutcome.escaped -= 1;
  else if (!changed) totals.byOutcome.unchanged -= 1;
  else totals.byOutcome.bounded -= 1;
}

function rateCost(tokens, perMillion, unknown, usageField, rateField) {
  const hasTokens = typeof tokens === 'number' && Number.isFinite(tokens);
  const hasRate = typeof perMillion === 'number' && Number.isFinite(perMillion);
  if (!hasTokens) {
    unknown.push(usageField);
    return 'unknown';
  }
  if (!hasRate) {
    unknown.push(rateField);
    return 'unknown';
  }
  return (tokens * perMillion) / 1e6;
}

/**
 * Price one request's usage against explicit versioned rates. Missing usage
 * fields or missing rates yield `'unknown'` — never a guessed zero, and never
 * an all-hit/all-miss derivation. Reasoning tokens that the provider already
 * billed inside output are marked `included-in-output` and not charged again.
 *
 * @param {object} usage - {requestId?, provider?, model?, hitTokens?, missTokens?,
 *   outputTokens?, reasoningOutputTokens?, reasoningIncludedInOutput?}.
 * @param {object} rates - {version, provider, model, currency, effectiveFrom, tier,
 *   hitPerMillion, missPerMillion, outputPerMillion, reasoningOutputPerMillion?}.
 * @returns {object} priced record; numeric costs or `'unknown'` per component.
 */
export function priceUsage(usage, rates) {
  const unknown = [];
  const hitCost = rateCost(usage.hitTokens, rates.hitPerMillion, unknown, 'hitTokens', 'rates.hitPerMillion');
  const missCost = rateCost(usage.missTokens, rates.missPerMillion, unknown, 'missTokens', 'rates.missPerMillion');
  const outputCost = rateCost(usage.outputTokens, rates.outputPerMillion, unknown, 'outputTokens', 'rates.outputPerMillion');

  let reasoningOutputCost = 0;
  let reasoningBilling = 'not-reported';
  if (usage.reasoningIncludedInOutput === true) {
    reasoningBilling = 'included-in-output';
  } else if (usage.reasoningOutputTokens !== undefined) {
    reasoningOutputCost = rateCost(
      usage.reasoningOutputTokens,
      rates.reasoningOutputPerMillion,
      unknown,
      'reasoningOutputTokens',
      'rates.reasoningOutputPerMillion',
    );
    reasoningBilling = 'separate';
  }

  const components = [hitCost, missCost, outputCost, reasoningOutputCost];
  const total = components.some((value) => value === 'unknown')
    ? 'unknown'
    : components.reduce((sum, value) => sum + value, 0);

  return {
    kind: 'usage',
    requestId: usage.requestId,
    provider: rates.provider ?? usage.provider ?? 'unknown',
    model: rates.model ?? usage.model ?? 'unknown',
    currency: rates.currency ?? 'unknown',
    ratesVersion: rates.version ?? 'unknown',
    effectiveFrom: rates.effectiveFrom,
    tier: rates.tier,
    hitCost,
    missCost,
    outputCost,
    reasoningOutputCost,
    reasoningBilling,
    total,
    unknown,
  };
}

function rateOf(inputTokens, estimatedTokensSaved) {
  if (inputTokens === 0) return 0;
  return estimatedTokensSaved / inputTokens;
}

/**
 * Summarize the ledger. Groups are canonical (`applied` / `dryRun`); the
 * flat `estimatedAppliedSavings` / `estimatedPotentialSavings` fields and the
 * legacy `savedTokens` alias (applied savings only) mirror them for callers.
 * Cost totals come solely from priced usage records — with none, the summary
 * says `none` rather than simulating a bill.
 *
 * @param {object} state - ledger state from `createMetricsState`.
 */
export function summarizeMetrics(state) {
  const applied = state.totals.applied;
  const dryRun = state.totals.dryRun;
  const usageRecords = state.usage;
  const anyUnknownCost = usageRecords.some((record) => record.total === 'unknown');
  const costTotal = usageRecords.length === 0
    ? null
    : anyUnknownCost
      ? 'unknown'
      : usageRecords.reduce((sum, record) => sum + record.total, 0);

  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    totals: {
      observations: state.events.length,
      distinctResults: state.results.size,
      appliedResults: applied.results,
      dryRunCandidates: dryRun.results,
    },
    applied: {
      results: applied.results,
      inputTokens: applied.inputTokens,
      estimatedTokensSaved: applied.estimatedTokensSaved,
      savingsRate: rateOf(applied.inputTokens, applied.estimatedTokensSaved),
      byOutcome: { ...applied.byOutcome },
    },
    dryRun: {
      candidates: dryRun.results,
      observations: state.events.filter((event) => event.mode === 'dryRun').length,
      inputTokens: dryRun.inputTokens,
      estimatedPotentialTokensSaved: dryRun.estimatedTokensSaved,
      potentialSavingsRate: rateOf(dryRun.inputTokens, dryRun.estimatedTokensSaved),
    },
    estimatedAppliedSavings: applied.estimatedTokensSaved,
    estimatedPotentialSavings: dryRun.estimatedTokensSaved,
    savingsRate: rateOf(applied.inputTokens, applied.estimatedTokensSaved),
    savedTokens: applied.estimatedTokensSaved,
    usage: {
      requests: usageRecords.length,
      source: usageRecords.length === 0 ? 'none' : 'usage',
      costTotal,
    },
  };
}
