/**
 * Recovery instruction delivery, from both directions.
 *
 * This file started as ZCode's independent review of a651901, which pinned two
 * holes as current behaviour (AUDIT FINDING A and B). Both were real, and both
 * had the same root cause: the plugin wrote a placeholder and then searched the
 * finished text for it. A search cannot tell an instruction from a quotation,
 * and content that quotes a marker is ordinary content — this repository's own
 * fixtures, diffs of them, prose about them.
 *
 * The mechanism is now positional instead of textual: the plugin passes a
 * `recoveryNoteFor` callback into the kernel, which writes the real instruction
 * into each marker as it renders it. Nothing searches afterwards, so both holes
 * close at once and the two directions the original brief named can be satisfied
 * together rather than trading off:
 *
 *   - too loose  → content that quotes a marker gets rewritten (findings A/B)
 *   - too tight  → a real marker keeps the placeholder, so the model is told to
 *                  re-run a command instead of where its original is stored
 *
 * These tests drive the pipeline, not a helper. The substitution happened inside
 * the pipeline; a helper-level test would have passed while the product was
 * broken, which is exactly how the original defect reached a live session.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, RECOVERY_NOTE_PLACEHOLDER } from '../index.js';
import { SLIM_MARKER_VERSION, RECOVERY_NOTE } from '../slim.js';
import { createFakeContext } from './helpers/fake-session.mjs';
import { syntheticLog } from './fixtures/source-samples.mjs';

/** A fresh temp directory removed when the test ends. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slim-subst-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Install the plugin and hand back its registered waterfalls. */
function install(dir) {
  const { ctx, handlers } = createFakeContext();
  apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: { rootDir: join(dir, 'store') } });
  return handlers;
}

/** Run one tool result through the registered post-execute waterfall. */
async function serve(handlers, callId, text) {
  const post = handlers.get('tools/post-execute')[0];
  return post(
    { name: 'pwsh', callId, arguments: {} },
    { content: [{ type: 'text', text }] },
    async () => ({ kind: 'accept' }),
  );
}

/** A payload long enough to be bounded, with an optional prefix. */
function payload(prefix = '') {
  const rows = Array.from({ length: 2500 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);
  return prefix.length === 0 ? rows.join('\n') : `${prefix}\n${rows.join('\n')}`;
}

/** A complete marker as it appears in ordinary text — a fixture, a diff, prose. */
function quotedMarker() {
  return `⟪[... 2 lines omitted — source lines 1-2. ${RECOVERY_NOTE} (${SLIM_MARKER_VERSION})]⟫`;
}

test('a real marker carries the instruction, not the placeholder', async (t) => {
  const handlers = install(tempDir(t));
  const decision = await serve(handlers, 'm1', payload());
  const out = decision.content[0].text;

  assert.ok(out.includes('full original:'), 'the model must be told where its original is');
  assert.equal(out.includes(RECOVERY_NOTE_PLACEHOLDER), false, 'no marker may keep the placeholder');
  assert.ok(out.includes(`(${SLIM_MARKER_VERSION})]⟫`), 'the marker still closes');
});

test('an earlier quotation is not rewritten, and the real marker still is', async (t) => {
  // Finding A, closed. The quotation comes first and the kernel's own marker
  // later; a first-match rewrite hit the quotation and left the real marker
  // holding the placeholder, so the model got a live path in a quoted fixture
  // and no path at all where it needed one.
  const handlers = install(tempDir(t));
  const quoted = `const FIXTURE = '${quotedMarker()}';`;
  const decision = await serve(handlers, 'm2', payload(quoted));
  const out = decision.content[0].text;

  const quotationAt = out.indexOf(`const FIXTURE = '`);
  const quotationEnd = out.indexOf(`';`, quotationAt);
  const quotation = out.slice(quotationAt, quotationEnd + 2);
  assert.equal(quotation, quoted, 'the quotation must survive byte-for-byte');

  // The kernel's own marker still got its instruction. Checked on the text after
  // the quotation, because the quotation legitimately still contains the
  // sentence — it is a quotation of it, which is the whole point.
  const afterQuotation = out.slice(quotationEnd + 2);
  assert.ok(afterQuotation.includes('full original:'), 'the real marker must still be served');
  assert.equal(
    afterQuotation.includes(RECOVERY_NOTE_PLACEHOLDER),
    false,
    'and must not keep the placeholder',
  );
  assert.ok(afterQuotation.includes(`(${SLIM_MARKER_VERSION})]⟫`), 'the marker still closes');
});

test('a quotation of a complete marker is not an instruction', async (t) => {
  // Finding B, closed. Even alone, a quoted marker carries the exact tail a
  // pattern would need — so pattern matching had to rewrite it.
  const handlers = install(tempDir(t));
  const decision = await serve(handlers, 'm3', payload(quotedMarker()));
  const out = decision.content[0].text;

  assert.ok(
    out.includes(quotedMarker()),
    'a quotation of a marker must survive verbatim',
  );
  assert.equal(
    /[A-Za-z]:[\\/][^\s]*token-slimmer-results/.test(out.slice(0, out.indexOf('2026-05-01'))),
    false,
    'no store path may be injected into leading content',
  );
});

test('nothing is injected into content with no markers at all', async (t) => {
  const handlers = install(tempDir(t));
  const decision = await serve(handlers, 'm4', payload(`the sentence ${RECOVERY_NOTE_PLACEHOLDER} appears here as prose`));
  const out = decision.content[0].text;

  assert.ok(
    out.includes(`the sentence ${RECOVERY_NOTE_PLACEHOLDER} appears here as prose`),
    'prose containing the sentence must survive verbatim',
  );
});

test('a marker is served its own block file, not another block’s', async (t) => {
  // Positional delivery keys on the block index, so a result that interleaves
  // text with images must still point each marker at its own snapshot.
  const dir = tempDir(t);
  const handlers = install(dir);
  const image = { type: 'image', attachment: { attachmentId: 'img-1' } };
  const first = payload();
  const second = payload(`SECOND-BLOCK-MARKER\n${syntheticLog(600)}`);

  const post = handlers.get('tools/post-execute')[0];
  const decision = await post(
    { name: 'pwsh', callId: 'm5', arguments: {} },
    { content: [{ type: 'text', text: first }, image, { type: 'text', text: second }] },
    async () => ({ kind: 'accept' }),
  );

  assert.notEqual(decision.content, undefined);
  assert.equal(decision.content[1], image, 'the image passes through by identity');
  const paths = [...decision.content[0].text.matchAll(/full original: (\S+)/g)].map((m) => m[1]);
  const secondPaths = [...decision.content[2].text.matchAll(/full original: (\S+)/g)].map((m) => m[1]);
  const all = [...paths, ...secondPaths];
  assert.ok(all.length > 0, 'at least one marker carries an instruction');
  assert.equal(new Set(all).size, all.length, 'each marker points at its own file');
  for (const path of all) {
    assert.match(path, /block-\d+\.txt$/, `a block file, not a bare name: ${path}`);
  }
});
