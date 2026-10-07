/**
 * Plugin-side recovery integration.
 *
 * The store has its own tests; these cover the wiring in `index.js`, which is
 * where the promise is actually made or broken:
 *
 *   - a lossy result is published only after its original is safely stored
 *   - the marker hands back a real path, not a re-run instruction
 *   - a snapshot that fails downgrades the call to the untouched result
 *   - a read of a recovery file is never itself compressed
 *
 * The failure cases matter more than the happy path. A plugin that publishes a
 * bounded result it cannot restore has told the model something untrue, and the
 * model has no way to notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, resolveRecoveryOptions, RECOVERY_NOTE_PLACEHOLDER } from '../index.js';
import { resolveOptions, slimContent } from '../slim.js';
import { syntheticLog } from './fixtures/source-samples.mjs';
import { asReadResult } from './fixtures/source-samples.mjs';
import { createFakeContext } from './helpers/fake-session.mjs';

/** A fresh temporary directory, removed when the test ends. */
function tempDir(t, prefix = 'slim-integration-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Install the plugin against a fake context and hand back its listeners. */
function install(dir, recovery) {
  const { ctx, handlers } = createFakeContext();
  apply(ctx, {
    statsPath: join(dir, 'stats.json'),
    recovery: recovery ?? { rootDir: join(dir, 'store') },
  });
  return handlers;
}

/** A tool result carrying one long text block. */
function longResult() {
  return [{ type: 'text', text: syntheticLog(2500, { errorCount: 4 }) }];
}

/** Invoke the registered post-execute waterfall to completion. */
async function postExecute(handlers, exec, result) {
  const listeners = handlers.get('tools/post-execute') ?? [];
  assert.equal(listeners.length, 1, 'expected exactly one post-execute listener');
  return listeners[0](exec, result, async () => ({ kind: 'accept' }));
}

/** Invoke the registered pre-execute waterfall to completion. */
async function preExecute(handlers, exec) {
  const listeners = handlers.get('tools/pre-execute') ?? [];
  for (const listener of listeners) await listener(exec, async () => ({ kind: 'allow' }));
}

/**
 * Force the running totals to disk.
 *
 * The plugin flushes every 25 events and at session disposal, so a test that
 * wants to assert on `stats.json` has to trigger the disposal path rather than
 * assume a flush already happened.
 */
async function flushStats(handlers) {
  for (const listener of handlers.get('agent/disposed') ?? []) await listener();
}

/** Read the flushed stats snapshot. */
function readStats(dir) {
  return JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'));
}

test('a bounded result is published with a path to its saved original', async (t) => {
  const dir = tempDir(t);
  const handlers = install(dir);
  const content = longResult();
  const exec = { name: 'pwsh', callId: 'c1', arguments: {} };

  const decision = await postExecute(handlers, exec, { content });
  assert.notEqual(decision.content, undefined, 'a bounded result should replace the content');
  const text = decision.content[0].text;

  assert.ok(text.includes('full original:'), 'the marker must point somewhere concrete');
  assert.equal(
    text.includes(RECOVERY_NOTE_PLACEHOLDER),
    false,
    'the placeholder must not survive into the published text',
  );

  // The path in the marker is real, and reading it returns the original text.
  const path = /full original: (.+?) — read it/.exec(text)?.[1];
  assert.ok(typeof path === 'string' && existsSync(path), `marker path should exist: ${path}`);
  assert.equal(readFileSync(path, 'utf8'), content[0].text, 'the saved file is the original text');
});

test('the recovered file is byte-identical to what the tool returned', async (t) => {
  const dir = tempDir(t);
  const handlers = install(dir);
  const original = `line one  \nline two\r\n${syntheticLog(1200)}`;
  const content = [{ type: 'text', text: original }];
  const decision = await postExecute(handlers, { name: 'pwsh', callId: 'c2', arguments: {} }, { content });
  const path = /full original: (.+?) — read it/.exec(decision.content[0].text)?.[1];
  assert.equal(readFileSync(path, 'utf8'), original, 'whitespace and line endings included');
});

test('a failed snapshot returns the original untouched and says why', async (t) => {
  const dir = tempDir(t);
  // Point the store at a path that cannot be a directory.
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'not a directory', 'utf8');
  const handlers = install(dir, { rootDir: blocked });

  const content = longResult();
  const decision = await postExecute(handlers, { name: 'pwsh', callId: 'c3', arguments: {} }, { content });

  assert.equal(
    decision.content,
    undefined,
    'nothing may be published when the original could not be stored',
  );
  await flushStats(handlers);
  const stats = readStats(dir);
  assert.equal(stats.recoveryUnavailable, 1);
  assert.ok(stats.recoveryFailureReason !== null, 'the reason must be recorded, not swallowed');
  assert.equal(stats.recoverySaved, 0);
});

test('a result that needed no bounding stores nothing', async (t) => {
  const dir = tempDir(t);
  const handlers = install(dir);
  const content = [{ type: 'text', text: 'short and already fine' }];
  const decision = await postExecute(handlers, { name: 'pwsh', callId: 'c4', arguments: {} }, { content });
  assert.equal(decision.content, undefined);
  assert.ok(!existsSync(join(dir, 'store')) || readdirIsEmpty(join(dir, 'store')), 'no snapshot for nothing');
});

/** Whether a directory is absent or holds nothing. */
function readdirIsEmpty(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return true;
  }
}

test('recovery can be turned off entirely', async (t) => {
  const dir = tempDir(t);
  const handlers = install(dir, { enabled: false, rootDir: join(dir, 'store') });
  const content = longResult();
  const decision = await postExecute(handlers, { name: 'pwsh', callId: 'c5', arguments: {} }, { content });
  // Bounding still happens; it simply makes no recoverability promise.
  assert.notEqual(decision.content, undefined);
  assert.equal(decision.content[0].text.includes('full original:'), false);
  assert.equal((handlers.get('tools/pre-execute') ?? []).length, 0, 'no bypass listener when disabled');
});

test('a read of a recovery file is never compressed', async (t) => {
  const dir = tempDir(t);
  const handlers = install(dir);
  const content = longResult();

  const first = await postExecute(handlers, { name: 'pwsh', callId: 'c6', arguments: {} }, { content });
  const path = /full original: (.+?) — read it/.exec(first.content[0].text)?.[1];
  assert.ok(typeof path === 'string');

  // The model now reads that path back. The result is a long log again, so
  // without the bypass it would be bounded a second time and the round trip
  // would return a bounded view of the original it asked for.
  const readExec = { name: 'read', callId: 'c7', arguments: { file_path: path } };
  await preExecute(handlers, readExec);
  const readResult = [{ type: 'text', text: `<path>${path}</path>\n<type>file</type>\n<content>\n${content[0].text}\n</content>` }];
  const decision = await postExecute(handlers, readExec, { content: readResult });

  assert.equal(decision.content, undefined, 'a recovery read must pass through untouched');

  await flushStats(handlers);
  const stats = readStats(dir);
  assert.equal(stats.recoveryBypassed, 1, 'the bypass must be counted');
});

test('the bypass does not leak onto ordinary reads', async (t) => {
  const dir = tempDir(t);
  const handlers = install(dir);
  const ordinary = join(dir, 'ordinary.txt');
  const body = syntheticLog(2500);
  writeFileSync(ordinary, body, 'utf8');

  const readExec = { name: 'read', callId: 'c8', arguments: { file_path: ordinary } };
  await preExecute(handlers, readExec);
  // Rendered the way the read tool renders it, line numbers included, so the
  // read-specific path is the one under test.
  const payload = asReadResult(ordinary, body);
  const decision = await postExecute(handlers, readExec, { content: [{ type: 'text', text: payload }] });

  assert.notEqual(decision.content, undefined, 'a read of a file we did not write may still be bounded');
  await flushStats(handlers);
  assert.equal(readStats(dir).recoveryBypassed, 0, 'an ordinary read must not be treated as a recovery read');
});

test('content that quotes the recovery sentence survives the plugin untouched', async (t) => {
  // The defect this replaced: the plugin rewrote the sentence anywhere it
  // appeared, so reading a file that merely *contains* it returned fabricated
  // content — including this repository's own source and any diff of it.
  //
  // Asserted through the pipeline rather than against a helper, because the
  // pipeline is where the substitution used to happen and a helper-level test
  // would not have caught it.
  const dir = tempDir(t);
  const handlers = install(dir);
  const quotation = [
    `export const RECOVERY_NOTE_PLACEHOLDER = '${RECOVERY_NOTE_PLACEHOLDER}';`,
    `// the tool prints ${RECOVERY_NOTE_PLACEHOLDER} into every bounded payload`,
    'const quoted = `⟪[... 2 lines omitted (slimmed v1)]⟫`;',
    ...Array.from({ length: 2000 }, (_, i) => `2026-05-01T10:00:00Z INFO row=${i} payload ok`),
  ].join('\n');

  const decision = await postExecute(
    handlers,
    { name: 'pwsh', callId: 'quoted-1', arguments: {} },
    { content: [{ type: 'text', text: quotation }] },
  );
  assert.notEqual(decision.content, undefined, 'the payload should be bounded');

  const out = decision.content[0].text;
  // The quotation must appear exactly as it did in the input.
  assert.ok(
    out.includes(`export const RECOVERY_NOTE_PLACEHOLDER = '${RECOVERY_NOTE_PLACEHOLDER}';`),
    'a source line defining the sentence must survive verbatim',
  );
  assert.ok(
    out.includes(`// the tool prints ${RECOVERY_NOTE_PLACEHOLDER} into every bounded payload`),
    'prose quoting the sentence must survive verbatim',
  );
  // And no filesystem path may be injected into ordinary content.
  assert.equal(
    /[A-Za-z]:\\[^\s]*token-slimmer-results/.test(out),
    false,
    'a private store path must never appear in content that merely quoted the sentence',
  );
});

test('the plugin writes its real instruction into its own markers', async (t) => {
  const dir = tempDir(t);
  const handlers = install(dir);
  const content = longResult();
  const decision = await postExecute(handlers, { name: 'pwsh', callId: 'marker-1', arguments: {} }, { content });

  const out = decision.content[0].text;
  assert.ok(out.includes('full original:'), 'a genuine marker carries the real instruction');
  assert.equal(
    out.includes(RECOVERY_NOTE_PLACEHOLDER),
    false,
    'no marker is left holding the placeholder',
  );
  assert.ok(out.includes('(slimmed v1)]⟫'), 'the marker still closes');
});

test('recovery options are validated', () => {
  assert.equal(resolveRecoveryOptions(undefined).enabled, true);
  assert.equal(resolveRecoveryOptions({}).maxBytes, 256 * 1024 * 1024);
  assert.throws(() => resolveRecoveryOptions({ nope: 1 }), /unknown recovery option/);
  assert.throws(() => resolveRecoveryOptions({ enabled: 'yes' }), /must be a boolean/);
  assert.throws(() => resolveRecoveryOptions({ maxBytes: 0 }), /positive integer/);
  assert.throws(() => resolveRecoveryOptions({ rootDir: 5 }), /must be a string/);
});

test('the kernel still emits the placeholder the plugin replaces', () => {
  // Two modules agreeing on one literal is the kind of coupling that breaks
  // silently, so it is asserted rather than assumed.
  const rows = Array.from({ length: 3000 }, (_, i) => `row ${i} ${'p'.repeat(30)}`);
  const result = slimContent([{ type: 'text', text: rows.join('\n') }], 'pwsh', resolveOptions({}));
  assert.ok(result.blocks[0].text.includes(RECOVERY_NOTE_PLACEHOLDER));
});

test('the counters and the ledger describe the same bytes', async (t) => {
  // Review round 2, finding G. index.js renders twice when recovery is on: the
  // first pass produces a candidate, the second writes the real recovery paths.
  // Those paths are longer than the placeholder the first pass wrote, so the
  // second pass can be pushed back over budget and withdraw more content — the
  // two passes genuinely diverge. Recording the first pass's stats while
  // publishing the second pass's output made every derived rate optimistic and
  // disagreed with the ledger, which measures what was actually published.
  const dir = tempDir(t);
  const handlers = install(dir);
  const big = Array.from({ length: 2500 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`).join('\n');
  const decision = await postExecute(handlers, { name: 'pwsh', callId: 'agree-1', arguments: {} }, { content: [{ type: 'text', text: big }] });
  assert.notEqual(decision.content, undefined, 'the result was bounded');
  await flushStats(handlers);

  const stats = readStats(dir);
  const ledgerOut = stats.metrics.applied.inputTokens - stats.metrics.estimatedAppliedSavings;
  assert.equal(
    stats.tokensOut,
    ledgerOut,
    `totals.tokensOut (${stats.tokensOut}) must equal what the ledger recorded as published (${ledgerOut})`,
  );
  assert.ok(stats.recoverySaved > 0, 'this result took the two-pass path, which is the case under test');
});
