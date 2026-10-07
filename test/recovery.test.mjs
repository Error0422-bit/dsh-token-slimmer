/**
 * Recovery store tests.
 *
 * The contract under test is narrow and load-bearing: a lossy result must be
 * restorable to the exact text the plugin received, without running the tool
 * again. The first assertion in this file is the one that matters — execute
 * once, compress, recover three times, and the execution count stays at one.
 * Everything else defends an edge of that promise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecoveryStore, defaultStoreDir, RecoveryError, sha256 } from '../recovery-store.js';
import { asReadResult, syntheticLog } from './fixtures/source-samples.mjs';

/** A store rooted at a fresh temporary directory, cleaned up after the test. */
function withStore(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slim-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createRecoveryStore({ rootDir: dir, ...config }) };
}

/**
 * A tool that counts how many times it actually ran.
 *
 * This is the whole point of the module: recovery must read the saved original,
 * so any test that recovers by calling this again would show a count above one.
 * @param {() => string} produce - the tool body.
 * @returns {{ executions: number, run: () => string }} the instrumented tool.
 */
function countingTool(produce) {
  return {
    executions: 0,
    run() {
      this.executions += 1;
      return produce();
    },
  };
}

/**
 * Run `body` expecting a `RecoveryError`, and hand it back.
 *
 * `assert.throws` returns nothing, so a test that wants to inspect `error.code`
 * — which is the stable part of this module's contract — needs the object.
 * @param {() => unknown} body - the call expected to fail.
 * @returns {RecoveryError} the thrown error.
 */
function expectRecoveryError(body) {
  try {
    body();
  } catch (error) {
    assert.ok(error instanceof RecoveryError, `expected a RecoveryError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to throw');
}

/** A payload of exactly the requested character length, with structure. */
function sampleOfLength(length) {
  const filler = syntheticLog(400, { errorCount: 3 });
  const base = asReadResult('C:/fixtures/sample.log', filler);
  if (base.length >= length) return base.slice(0, length);
  return base + '\n'.repeat(length - base.length);
}

test('one execution, a compression, three recoveries: the tool runs once', (t) => {
  const { store } = withStore(t);
  const original = sampleOfLength(18489);
  const tool = countingTool(() => original);

  const blocks = [{ type: 'text', text: tool.run() }];
  assert.equal(tool.executions, 1);

  // The bounded result the plugin would publish instead of the original.
  const bounded = asReadResult('C:/fixtures/sample.log', '[bounded view]');
  assert.notEqual(bounded, original);

  const saved = store.save({ sessionId: 's-1', callId: 'c-1', blocks });
  for (let attempt = 0; attempt < 3; attempt++) {
    const recovered = store.read({ artifactId: saved.artifactId });
    assert.equal(recovered.text, original, `recovery ${attempt + 1} must return the original bytes`);
  }
  assert.equal(tool.executions, 1, 'recovery must never re-run the tool');
  assert.equal(saved.totalBytes, Buffer.byteLength(original, 'utf8'));
});

test('an 18,489 character sample comes back whole', (t) => {
  const { store } = withStore(t);
  const original = sampleOfLength(18489);
  assert.equal(original.length, 18489);
  const saved = store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: original }] });
  const recovered = store.read({ artifactId: saved.artifactId });
  assert.equal(recovered.text.length, 18489);
  assert.equal(sha256(recovered.text), sha256(original));
  assert.equal(recovered.totalLines, original.split('\n').length);
});

test('a line range reads back exactly that range', (t) => {
  const { store } = withStore(t);
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1} payload`);
  const original = lines.join('\n');
  const saved = store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: original }] });
  const range = store.read({ artifactId: saved.artifactId, offset: 101, limit: 5 });
  assert.equal(range.offset, 101);
  assert.equal(range.text, lines.slice(100, 105).join('\n'));
  assert.equal(range.totalLines, 500);
});

test('multiple text blocks are stored and read independently', (t) => {
  const { store } = withStore(t);
  const blocks = [
    { type: 'text', text: 'first block body' },
    { type: 'image', attachment: { attachmentId: 'x' } },
    { type: 'text', text: 'second block body' },
  ];
  const saved = store.save({ sessionId: 's', callId: 'c', blocks });
  assert.deepEqual(
    saved.files.map((file) => file.blockIndex),
    [0, 2],
    'only text blocks are persisted, keeping their original indices',
  );
  assert.equal(store.read({ artifactId: saved.artifactId, blockIndex: 0 }).text, 'first block body');
  assert.equal(store.read({ artifactId: saved.artifactId, blockIndex: 2 }).text, 'second block body');
  assert.throws(() => store.read({ artifactId: saved.artifactId, blockIndex: 1 }), /no block 1/);
});

test('non-text content is refused rather than silently saved as nothing', (t) => {
  const { store } = withStore(t);
  assert.throws(
    () => store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'image', attachment: {} }] }),
    /no text blocks/,
  );
  assert.throws(() => store.save({ sessionId: 's', callId: 'c', blocks: [] }), /nothing to save/);
});

test('a save that would exceed the quota is refused and leaves nothing behind', (t) => {
  const { store } = withStore(t, { maxBytes: 2048 });
  const big = 'x'.repeat(4096);
  const error = expectRecoveryError(() =>
    store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: big }] }),
  );
  assert.equal(error.code, 'QUOTA_EXCEEDED');
  assert.equal(store.list().length, 0, 'a refused save must not leave a partial artifact');
  assert.equal(store.usedBytes(), 0);
});

test('the quota admits what fits and refuses what follows', (t) => {
  const { store } = withStore(t, { maxBytes: 2000 });
  const fits = store.save({ sessionId: 's', callId: 'c1', blocks: [{ type: 'text', text: 'y'.repeat(500) }] });
  assert.ok(fits.artifactId);
  assert.throws(
    () => store.save({ sessionId: 's', callId: 'c2', blocks: [{ type: 'text', text: 'z'.repeat(1800) }] }),
    /quota exhausted/,
  );
});

test('a missing artifact reports itself rather than returning empty text', (t) => {
  const { store } = withStore(t);
  const error = expectRecoveryError(() => store.read({ artifactId: 'does-not-exist' }));
  assert.equal(error.code, 'ARTIFACT_NOT_FOUND');
});

test('a deleted block file reports itself', (t) => {
  const { dir, store } = withStore(t);
  const saved = store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: 'body' }] });
  rmSync(join(dir, saved.artifactId, saved.files[0].path));
  const error = expectRecoveryError(() => store.read({ artifactId: saved.artifactId }));
  assert.equal(error.code, 'FILE_MISSING');
});

test('a tampered block is detected instead of served', (t) => {
  const { dir, store } = withStore(t);
  const saved = store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: 'authentic body' }] });
  const path = join(dir, saved.artifactId, saved.files[0].path);
  writeFileSync(path, 'tampered body', 'utf8');
  const error = expectRecoveryError(() => store.read({ artifactId: saved.artifactId }));
  assert.equal(error.code, 'HASH_MISMATCH');
  assert.match(error.message, /changed on disk/);
});

test('the store survives a restart: a fresh instance reads what the old one wrote', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = sampleOfLength(5000);
  const first = createRecoveryStore({ rootDir: dir });
  const saved = first.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: original }] });

  // A second instance shares no in-memory state with the first.
  const second = createRecoveryStore({ rootDir: dir });
  assert.equal(second.read({ artifactId: saved.artifactId }).text, original);
  assert.equal(second.list().length, 1);
});

test('ownsPath trusts only files the store registered', (t) => {
  const { dir, store } = withStore(t);
  const saved = store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: 'body' }] });
  const blockPath = join(dir, saved.artifactId, saved.files[0].path);
  assert.equal(store.ownsPath(blockPath), true);
  assert.equal(store.ownsPath(join(dir, saved.artifactId, 'manifest.json')), true);

  // A file dropped into the store's own tree is not a trusted original.
  const stray = join(dir, saved.artifactId, 'block-9.txt');
  writeFileSync(stray, 'not mine', 'utf8');
  assert.equal(store.ownsPath(stray), false);

  // Neither is anything outside the root, nor a directory in it.
  assert.equal(store.ownsPath(join(dir, 'elsewhere.txt')), false);
  assert.equal(store.ownsPath('C:/Windows/System32/drivers/etc/hosts'), false);
  assert.equal(store.ownsPath(join(dir, 'not-an-artifact', 'block-0.txt')), false);
  assert.equal(store.ownsPath(''), false);
});

test('two stores with different roots do not see each other', (t) => {
  const one = withStore(t);
  const two = withStore(t);
  const saved = one.store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: 'private' }] });
  assert.throws(() => two.store.read({ artifactId: saved.artifactId }), /no saved original/);
  assert.equal(two.store.ownsPath(join(one.dir, saved.artifactId, 'block-0.txt')), false);
});

test('parallel saves all land and stay independent', (t) => {
  const { store } = withStore(t);
  const saved = Array.from({ length: 12 }, (_, i) =>
    store.save({ sessionId: 's', callId: `c-${i}`, blocks: [{ type: 'text', text: `payload ${i}` }] }),
  );
  const ids = new Set(saved.map((entry) => entry.artifactId));
  assert.equal(ids.size, 12, 'every artifact gets its own id');
  for (let index = 0; index < saved.length; index++) {
    assert.equal(store.read({ artifactId: saved[index].artifactId }).text, `payload ${index}`);
  }
  assert.equal(store.list().length, 12);
});

test('a broken manifest reads as absent rather than throwing', (t) => {
  const { dir, store } = withStore(t);
  const saved = store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: 'body' }] });
  writeFileSync(join(dir, saved.artifactId, 'manifest.json'), '{ truncated', 'utf8');
  assert.throws(() => store.read({ artifactId: saved.artifactId }), /no saved original/);
  assert.equal(store.list().length, 0);
});

test('session ids are recorded but never used as a path', (t) => {
  const { dir, store } = withStore(t);
  const hostile = '../../etc/passwd';
  const saved = store.save({ sessionId: hostile, callId: 'c', blocks: [{ type: 'text', text: 'body' }] });
  assert.equal(store.read({ artifactId: saved.artifactId }).text, 'body');
  const entries = readFileSync(join(dir, saved.artifactId, 'manifest.json'), 'utf8');
  assert.ok(entries.includes(hostile), 'the raw session id is preserved in the manifest for attribution');
  assert.ok(saved.artifactId !== hostile);
});

test('the default store directory is per session and under DSH home', () => {
  const path = defaultStoreDir('abc-123', 'C:/fake/home');
  assert.ok(path.startsWith('C:\\fake\\home') || path.startsWith('C:/fake/home'), path);
  assert.ok(path.includes('token-slimmer-results'), path);
  assert.ok(path.includes('abc-123'), path);
});

test('a store refuses to be constructed without somewhere to write', () => {
  assert.throws(() => createRecoveryStore({}), /rootDir/);
  assert.throws(() => createRecoveryStore({ rootDir: '' }), /rootDir/);
  assert.throws(() => createRecoveryStore({ rootDir: 'C:/tmp', maxBytes: 0 }), /maxBytes/);
});
