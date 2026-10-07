/**
 * Metrics ledger tests.
 *
 * The defects these defend against: the old summary reported one `savedTokens`
 * number that mixed "this run actually sent fewer tokens" with "a dry run
 * could have", and its denominator skipped every result that was left
 * unchanged — so a pass that compressed nothing still printed a healthy
 * percentage. The same dry-run candidate also re-banked its predicted saving
 * every time it was observed, and cost was derived by guessing that a whole
 * request was either all cache-hit or all-miss.
 *
 * Interfaces specified by 2026-09-28 task 5 as amended by
 * 2026-09-29 (superseding on conflict): `recordResult`, `summarizeMetrics`
 * with `schemaVersion: 2`, `predictionKeyOf`, `priceUsage`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  METRICS_SCHEMA_VERSION,
  createMetricsState,
  predictionKeyOf,
  priceUsage,
  recordResult,
  summarizeMetrics,
} from '../metrics.js';

/** Relative tolerance for currency-scale floats; far tighter than the gap being asserted. */
function almostEqual(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

const RATES = {
  version: 7,
  provider: 'fake',
  model: 'fake-1',
  currency: 'CNY',
  effectiveFrom: '2026-01-01',
  tier: 'standard',
  hitPerMillion: 0.04,
  missPerMillion: 0.4,
  outputPerMillion: 4,
  reasoningOutputPerMillion: 4,
};

test('the denominator counts every result: 25%, not 50%', () => {
  const state = createMetricsState();
  recordResult(state, { id: 'r1', mode: 'applied', beforeTokens: 1000, afterTokens: 500, changed: true });
  recordResult(state, { id: 'r2', mode: 'applied', beforeTokens: 1000, afterTokens: 1000, changed: false });

  const summary = summarizeMetrics(state);
  assert.equal(summary.schemaVersion, METRICS_SCHEMA_VERSION);
  assert.equal(summary.schemaVersion, 2);
  assert.equal(summary.applied.inputTokens, 2000);
  assert.equal(summary.applied.estimatedTokensSaved, 500);
  assert.equal(summary.estimatedAppliedSavings, 500);
  almostEqual(summary.applied.savingsRate, 0.25);
  almostEqual(summary.savingsRate, 0.25);
});

test('unchanged, escaped, and recovery-failed results all stay in the denominator', () => {
  const state = createMetricsState();
  recordResult(state, { id: 'r1', mode: 'applied', beforeTokens: 1000, afterTokens: 500, changed: true });
  recordResult(state, { id: 'r2', mode: 'applied', beforeTokens: 800, afterTokens: 800, changed: false, escaped: true });
  recordResult(state, {
    id: 'r3',
    mode: 'applied',
    beforeTokens: 200,
    afterTokens: 200,
    changed: false,
    escaped: true,
    escapeReason: 'recovery-unavailable',
  });

  const summary = summarizeMetrics(state);
  assert.equal(summary.applied.inputTokens, 2000);
  assert.equal(summary.applied.estimatedTokensSaved, 500);
  assert.equal(summary.applied.byOutcome.escaped, 2);
  almostEqual(summary.applied.savingsRate, 0.25);
});

test('a dry-run candidate banks its prediction once, no matter how often it is observed', () => {
  const state = createMetricsState();
  const key = predictionKeyOf({ sessionId: 's1', seq: 7, contentHash: 'c1', optionsHash: 'o1' });
  for (let i = 0; i < 3; i++) {
    recordResult(state, { id: key, mode: 'dryRun', beforeTokens: 2000, afterTokens: 2, changed: true });
  }

  const summary = summarizeMetrics(state);
  assert.equal(summary.dryRun.estimatedPotentialTokensSaved, 1998);
  assert.equal(summary.estimatedPotentialSavings, 1998);
  assert.equal(summary.dryRun.observations, 3);
  assert.equal(summary.applied.estimatedTokensSaved, 0);
});

test('the same reasoning seen across three pre-steps with zero replacements banks zero applied savings', () => {
  const state = createMetricsState();
  const key = predictionKeyOf({ sessionId: 's1', seq: 12, contentHash: 'abc', optionsHash: 'def' });
  for (let step = 0; step < 3; step++) {
    recordResult(state, { id: key, mode: 'dryRun', beforeTokens: 2000, afterTokens: 2000, changed: false });
  }

  const summary = summarizeMetrics(state);
  assert.equal(summary.applied.estimatedTokensSaved, 0);
  assert.equal(summary.dryRun.estimatedPotentialTokensSaved, 0);
  assert.equal(summary.dryRun.observations, 3);
});

test('a dry-run candidate that later applies moves its saving exactly once', () => {
  const state = createMetricsState();
  const key = predictionKeyOf({ sessionId: 's1', seq: 3, contentHash: 'c', optionsHash: 'o' });
  recordResult(state, { id: key, mode: 'dryRun', beforeTokens: 1000, afterTokens: 400, changed: true });
  recordResult(state, { id: key, mode: 'applied', beforeTokens: 1000, afterTokens: 400, changed: true });
  recordResult(state, { id: key, mode: 'applied', beforeTokens: 1000, afterTokens: 400, changed: true });

  const summary = summarizeMetrics(state);
  assert.equal(summary.applied.estimatedTokensSaved, 600);
  assert.equal(summary.estimatedAppliedSavings, 600);
  assert.equal(summary.dryRun.estimatedPotentialTokensSaved, 0);
  assert.equal(summary.totals.observations, 3);
  assert.equal(summary.dryRun.observations, 1);
});

test('the legacy savedTokens alias tracks applied savings only', () => {
  const state = createMetricsState();
  recordResult(state, { id: 'r1', mode: 'applied', beforeTokens: 1000, afterTokens: 500, changed: true });
  const key = predictionKeyOf({ sessionId: 's1', seq: 1, contentHash: 'c', optionsHash: 'o' });
  recordResult(state, { id: key, mode: 'dryRun', beforeTokens: 9000, afterTokens: 90, changed: true });

  const summary = summarizeMetrics(state);
  assert.equal(summary.savedTokens, 500);
  assert.equal(summary.savedTokens, summary.applied.estimatedTokensSaved);
  assert.equal(summary.estimatedPotentialSavings, 8910);
});

test('event-level log carries ids and counters, never text or call arguments', () => {
  const state = createMetricsState();
  recordResult(state, { id: 'r1', mode: 'applied', beforeTokens: 1000, afterTokens: 500, changed: true });
  recordResult(state, {
    id: 'r2',
    mode: 'applied',
    beforeTokens: 10,
    afterTokens: 10,
    changed: false,
    escaped: true,
    escapeReason: 'payload-line-guard',
    toolName: 'read',
  });

  const allowed = new Set(['kind', 'id', 'mode', 'beforeTokens', 'afterTokens', 'changed', 'escaped', 'escapeReason', 'toolName', 'observedAt']);
  for (const event of state.events) {
    for (const key of Object.keys(event)) {
      assert.ok(allowed.has(key), `unexpected event field: ${key}`);
    }
  }
  assert.equal(state.events.length, 2);
});

test('separate states never share a ledger', () => {
  const a = createMetricsState();
  const b = createMetricsState();
  recordResult(a, { id: 'r1', mode: 'applied', beforeTokens: 1000, afterTokens: 500, changed: true });

  const summaryB = summarizeMetrics(b);
  assert.equal(summaryB.applied.inputTokens, 0);
  assert.equal(summaryB.applied.estimatedTokensSaved, 0);
});

test('priceUsage sums per-request hit, miss, and output costs', () => {
  const priced = priceUsage(
    { requestId: 'req-1', provider: 'fake', model: 'fake-1', hitTokens: 2000, missTokens: 500, outputTokens: 300 },
    RATES,
  );
  assert.equal(priced.hitCost, (2000 * RATES.hitPerMillion) / 1e6);
  assert.equal(priced.missCost, (500 * RATES.missPerMillion) / 1e6);
  assert.equal(priced.outputCost, (300 * RATES.outputPerMillion) / 1e6);
  almostEqual(priced.total, 8e-5 + 2e-4 + 1.2e-3);
  assert.deepEqual(priced.unknown, []);
});

test('priceUsage reports unknown for missing fields instead of guessing zero', () => {
  const priced = priceUsage({ requestId: 'req-2', provider: 'fake', model: 'fake-1', outputTokens: 100 }, RATES);
  assert.equal(priced.hitCost, 'unknown');
  assert.equal(priced.missCost, 'unknown');
  assert.equal(priced.outputCost, (100 * RATES.outputPerMillion) / 1e6);
  assert.equal(priced.total, 'unknown');
  assert.deepEqual(priced.unknown, ['hitTokens', 'missTokens']);
});

test('reasoning tokens already inside output are not billed again', () => {
  const included = priceUsage(
    {
      requestId: 'req-3',
      provider: 'fake',
      model: 'fake-1',
      hitTokens: 1000,
      missTokens: 0,
      outputTokens: 500,
      reasoningOutputTokens: 300,
      reasoningIncludedInOutput: true,
    },
    RATES,
  );
  assert.equal(included.reasoningOutputCost, 0);
  assert.equal(included.reasoningBilling, 'included-in-output');
  almostEqual(included.total, (1000 * 0.04) / 1e6 + (500 * 4) / 1e6);

  const separate = priceUsage(
    {
      requestId: 'req-4',
      provider: 'fake',
      model: 'fake-1',
      hitTokens: 1000,
      missTokens: 0,
      outputTokens: 500,
      reasoningOutputTokens: 300,
      reasoningIncludedInOutput: false,
    },
    RATES,
  );
  assert.equal(separate.reasoningOutputCost, (300 * RATES.reasoningOutputPerMillion) / 1e6);
  almostEqual(separate.total, (1000 * 0.04) / 1e6 + (500 * 4) / 1e6 + (300 * 4) / 1e6);
});

test('rates are versioned and carry provider, model, currency, effective date, and tier', () => {
  const priced = priceUsage({ requestId: 'req-5', hitTokens: 1000 }, RATES);
  assert.equal(priced.ratesVersion, 7);
  assert.equal(priced.provider, 'fake');
  assert.equal(priced.model, 'fake-1');
  assert.equal(priced.currency, 'CNY');

  const unpriced = priceUsage({ requestId: 'req-6', hitTokens: 1000 }, {});
  assert.equal(unpriced.hitCost, 'unknown');
  assert.equal(unpriced.currency, 'unknown');
  assert.equal(unpriced.total, 'unknown');
});

test('usage summaries keep their provenance: usage-derived, never simulated', () => {
  const state = createMetricsState();
  recordResult(state, { id: 'r1', mode: 'applied', beforeTokens: 1000, afterTokens: 500, changed: true });
  const priced = priceUsage(
    { requestId: 'req-1', provider: 'fake', model: 'fake-1', hitTokens: 2000, missTokens: 0, outputTokens: 100 },
    RATES,
  );
  state.usage.push(priced);

  const summary = summarizeMetrics(state);
  assert.equal(summary.usage.requests, 1);
  assert.equal(summary.usage.source, 'usage');
  almostEqual(summary.usage.costTotal, (2000 * 0.04) / 1e6 + (100 * 4) / 1e6);

  const textOnly = summarizeMetrics(createMetricsState());
  assert.equal(textOnly.usage.source, 'none');
  assert.equal(textOnly.usage.costTotal, null);
});
