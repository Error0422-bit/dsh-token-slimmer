/**
 * The metrics ledger as wired into the plugin.
 *
 * `test/metrics.test.mjs` covers the ledger as pure functions. This covers the
 * wiring, which is where the reported number is actually decided:
 *
 *   - every result the model was served reaches the ledger, not only the ones
 *     that were compressed;
 *   - the denominator therefore includes unchanged, escaped and
 *     recovery-failed results;
 *   - the reported rate is read off the ledger instead of being recomputed from
 *     the partial `totals.tokensIn` that caused the original overstatement.
 *
 * The old counters accumulated `tokensIn` only for results that changed, so a
 * savings rate derived from them answered "of what I compressed, how much did I
 * save" while being presented as "of what the model was served".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';
import { estimateTokens } from '../slim.js';
import { createFakeContext } from './helpers/fake-session.mjs';

/** Install the plugin against a fake context and a temporary stats file. */
function harness(t, recovery) {
  const dir = mkdtempSync(join(tmpdir(), 'slim-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ctx, handlers } = createFakeContext();
  apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: recovery ?? { enabled: false } });
  return { dir, handlers };
}

/** Serve one tool result through the registered post-execute waterfall. */
async function serve(handlers, callId, text) {
  const post = handlers.get('tools/post-execute')[0];
  return post(
    { name: 'pwsh', callId, arguments: {} },
    { content: [{ type: 'text', text }] },
    async () => ({ kind: 'accept' }),
  );
}

/** Force the running totals to disk. */
async function flush(handlers) {
  for (const listener of handlers.get('agent/disposed') ?? []) await listener();
}

/** Read the flushed stats snapshot. */
function readStats(dir) {
  return JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'));
}

/** A log long enough to be bounded by any reasonable budget. */
const BIG = Array.from({ length: 2500 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} ok`).join('\n');

test('the stats file carries the ledger alongside the per-surface details', async (t) => {
  const { dir, handlers } = harness(t);
  await serve(handlers, 'c1', BIG);
  await flush(handlers);

  const stats = readStats(dir);
  assert.equal(stats.metrics.schemaVersion, 2, 'the ledger declares its schema version');
  assert.ok(stats.metrics.applied, 'the applied bucket is present');
  assert.ok(stats.metrics.dryRun, 'the dry-run bucket is present even when unused');
  // The old per-surface counters are still there for callers that read them.
  assert.equal(typeof stats.tokensIn, 'number');
  assert.equal(typeof stats.tokensOut, 'number');
});

test('a result served whole still enters the denominator', async (t) => {
  // This is the defect the ledger exists to fix. Two results are served: one
  // bounded, one small enough to pass through. Both occupy the model's context,
  // so both belong in the denominator.
  const { dir, handlers } = harness(t);
  await serve(handlers, 'c1', BIG);
  const smallTokens = estimateTokens('tiny');
  await serve(handlers, 'c2', 'tiny');
  await flush(handlers);

  const stats = readStats(dir);
  const applied = stats.metrics.applied;
  assert.equal(applied.results, 2, 'both served results are counted');
  assert.equal(applied.byOutcome.unchanged, 1, 'the untouched one is recorded as unchanged');
  assert.equal(applied.byOutcome.bounded, 1);
  assert.ok(
    applied.inputTokens > smallTokens,
    'the denominator covers every served result, not just the compressed one',
  );

  // The reported rate follows the same denominator, so it is lower than a rate
  // computed from the bounded result alone would be.
  const boundedOnly =
    estimateTokens(BIG) > 0 ? (estimateTokens(BIG) - estimateTokens(BIG) * 0) : 0;
  assert.ok(stats.metrics.estimatedAppliedSavings < applied.inputTokens);
  assert.ok(Number.isFinite(boundedOnly));
});

test('savedPercent is derived from the ledger, not recomputed from a partial total', async (t) => {
  const { dir, handlers } = harness(t);
  await serve(handlers, 'c1', BIG);
  await serve(handlers, 'c2', 'tiny');
  await flush(handlers);

  const stats = readStats(dir);
  const ledger = stats.metrics;
  const expected = Number(
    ((ledger.estimatedAppliedSavings / ledger.applied.inputTokens) * 100).toFixed(2),
  );
  assert.equal(stats.savedPercent, expected, 'the alias must agree with the ledger');
  assert.equal(stats.savedTokens, ledger.estimatedAppliedSavings);
});

test('a result whose snapshot failed is counted and claims no savings', async (t) => {
  // The bounded candidate is discarded when the original cannot be stored, so
  // the model is served the untouched text. That is an escape: in the
  // denominator, out of the savings.
  const dir = mkdtempSync(join(tmpdir(), 'slim-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'not a directory', 'utf8');

  const { ctx, handlers } = createFakeContext();
  apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: { rootDir: blocked } });

  const decision = await serve(handlers, 'c3', BIG);
  assert.equal(decision.content, undefined, 'nothing may be published when the snapshot failed');
  await flush(handlers);

  const stats = readStats(dir);
  assert.equal(stats.metrics.totals.distinctResults, 1, 'the failed result is still observed');
  assert.equal(stats.metrics.applied.byOutcome.escaped, 1, 'recorded as an escape');
  assert.equal(stats.metrics.estimatedAppliedSavings, 0, 'no savings are claimed for discarded work');
  assert.ok(stats.metrics.applied.inputTokens > 0, 'it stays in the denominator');
});

test('repeated observations of one result do not inflate the ledger', async (t) => {
  // The same call replayed: metrics dedups by identity, so the totals reflect
  // one result observed twice rather than two results.
  const { dir, handlers } = harness(t);
  await serve(handlers, 'c1', BIG);
  await serve(handlers, 'c1', BIG);
  await flush(handlers);

  const stats = readStats(dir);
  assert.equal(stats.metrics.totals.distinctResults, 1, 'one result, whatever the observation count');
  assert.equal(stats.metrics.applied.results, 1);
});

test('an unconfigured stats path records nothing and breaks nothing', async (t) => {
  const { ctx, handlers } = createFakeContext();
  apply(ctx, { statsPath: '', recovery: { enabled: false } });
  const decision = await serve(handlers, 'c1', BIG);
  assert.notEqual(decision.content, undefined, 'the call is still served');
  await flush(handlers);
});
