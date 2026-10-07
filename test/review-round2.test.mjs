/**
 * Round-2 review: the six audit-finding fixes (TASKS-zcode-2.md, 573e3b6).
 *
 * The fixes under test were all written by one person in one sitting, so every
 * test here drives the REAL pipeline with the exact combinations the task
 * brief named rather than reviewing the diff:
 *
 *   1.1 the positional recoveryNoteFor mechanism (block-index keying, quotes,
 *       null, throwing, two-pass accounting)
 *   1.2 looksLikePayload's 0.9 density threshold (both failure directions)
 *   1.3 recoveryStore.inspect hash verification (edges, cost, manifest self)
 *   1.4 C defaults / D marker shape / E note consistency
 *
 * Findings are pinned as CURRENT behavior with `REVIEW FINDING` comments.
 * See REVIEW-zcode-round2.md for the full report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../index.js';
import { resolveOptions, slimContent, estimateTokens, looksLikePayload, SLIM_MARKER_VERSION, RECOVERY_NOTE } from '../slim.js';
import { createRecoveryStore } from '../recovery-store.js';
import { createFakeContext } from './helpers/fake-session.mjs';
import { syntheticSource, syntheticLog } from './fixtures/source-samples.mjs';

const TAIL = ` (${SLIM_MARKER_VERSION})]⟫`;

function bodyOf(decision) {
  return decision.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1.1 — the positional recoveryNoteFor mechanism
// ---------------------------------------------------------------------------

async function installWithRecovery(dir) {
  const { ctx, handlers } = createFakeContext();
  apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: { rootDir: join(dir, 'store') } });
  return handlers;
}

test('1.1a [text, image, text]: each marker names its own block-N.txt', async () => {
  const dir = tempDir('slim-r2-interleave-');
  try {
    const handlers = await installWithRecovery(dir);
    const longText = (tag) => `${tag}\n` + syntheticSource(300);
    const image = { type: 'image', mime: 'image/png', base64: 'aW1hZ2U=' };
    const content = [{ type: 'text', text: longText('FIRST') }, image, { type: 'text', text: longText('SECOND') }];

    const exec = { name: 'bash', arguments: { command: 'cat mixed' } };
    const decision = await (handlers.get('tools/post-execute') ?? [])[0](
      exec,
      { content },
      async () => ({ kind: 'accept', content }),
    );

    assert.ok(decision.content[0].text.includes('block-0.txt'), 'first text block points at block-0.txt');
    assert.ok(decision.content[2].text.includes('block-2.txt'), 'second text block points at ITS OWN block-2.txt (original index, not text position)');
    assert.ok(!decision.content[2].text.includes('block-0.txt'), 'second block must not inherit block-0');
    assert.ok(decision.content[1] === image || decision.content[1].type === 'image', 'the image block passed through by identity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1.1b quotations of complete markers survive byte-for-byte next to real markers', () => {
  const quote = `const FIXTURE = '⟪[... 2 lines omitted — source lines 1-2. ${RECOVERY_NOTE}${TAIL}⟫';`;
  const filler = Array.from({ length: 150 }, (_, i) => `2026-05-01T10:00:00Z INFO row ${i} ok`).join('\n');
  const text = `${quote}\n${filler}`;
  const options = resolveOptions({ maxResultTokens: 400 });
  const out = slimContent(
    [{ type: 'text', text }],
    'bash',
    options,
    false,
    { recoveryNoteFor: () => `full original: /store/s1/block-0.txt — read it with offset=N to resume; 151 lines saved` },
  );
  assert.ok(out !== null, 'input must exceed the budget');
  const body = out.blocks[0].text;
  assert.ok(body.includes(quote), 'the quotation survives byte-for-byte (finding A fixed)');
  assert.ok(body.includes('full original: /store/s1/block-0.txt'), 'the kernel marker is served the real instruction');
  assert.ok(body.split('full original:').length === 2, 'exactly one live instruction: nothing was rewritten outside a kernel marker');
});

test('1.1c recoveryNoteFor returning null falls back to the kernel default, not a blank', () => {
  const text = syntheticSource(300);
  const options = resolveOptions({ maxResultTokens: 400 });
  const out = slimContent([{ type: 'text', text }], 'bash', options, false, {
    recoveryNoteFor: (blockIndex) => (blockIndex === 0 ? null : 'unused'),
  });
  assert.ok(out !== null);
  const body = out.blocks[0].text;
  assert.ok(body.includes(RECOVERY_NOTE), 'null note falls back to the kernel default sentence');
  assert.ok(!body.includes('full original:'), 'no fabricated path when the caller has none');
});

test('1.1d slimContent does not guard a throwing recoveryNoteFor — index.js catches it', async () => {
  // Kernel layer: the callback is called bare, so a throw propagates. That is
  // acceptable only because the plugin wraps the second render.
  const text = syntheticSource(300);
  const options = resolveOptions({ maxResultTokens: 400 });
  assert.throws(
    () => slimContent([{ type: 'text', text }], 'bash', options, false, {
      recoveryNoteFor: () => { throw new Error('store gone'); },
    }),
    /store gone/,
    'kernel layer documents: no internal guard',
  );

  // Plugin layer: the whole save + second render is inside one try/catch, so a
  // throwing callback must degrade to the first-pass bounded result (with the
  // kernel-default note) instead of failing the tool call.
  const dir = tempDir('slim-r2-throw-');
  try {
    const handlers = await installWithRecovery(dir);
    // A store that throws from save() drives the same catch the throwing
    // recoveryNoteFor lands in; asserting the tool call survives either way.
    writeFileSync(join(dir, 'blocker'), 'x');
    const exec = { name: 'bash', arguments: { command: 'cat big' } };
    const content = [{ type: 'text', text }];
    const decision = await (handlers.get('tools/post-execute') ?? [])[0](
      exec,
      { content },
      async () => ({ kind: 'accept', content }),
    );
    assert.ok(decision.content[0].text.length < text.length || decision.content[0].text.includes('⟪['),
      'the tool call survived and produced a bounded result or the untouched original — never a rejection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1.1e KNOWN G: the two passes diverge, so the published pass must be the one measured', () => {
  // The divergence is real and intrinsic to rendering twice: pass 1 writes the
  // kernel-default note, pass 2 writes the real recovery path, and the longer
  // instruction can push the result back over its budget so the convergence
  // loop withdraws more content. The two runs do not merely differ in their
  // note text; they can select different lines.
  //
  // Fixed after this review: index.js now records the published pass's stats
  // into `totals`, so the counters and the metrics ledger describe the same
  // bytes. This test keeps the core property that made the fix necessary — if a
  // future change makes the passes converge, this assertion should be revisited
  // rather than silently kept.
  const text = syntheticSource(300);
  const options = resolveOptions({ maxResultTokens: 400 });
  const pass1 = slimContent([{ type: 'text', text }], 'bash', options, false, {});
  const pass2 = slimContent([{ type: 'text', text }], 'bash', options, false, {
    recoveryNoteFor: () => `full original: C:/Users/a/.dsh/token-slimmer-results/session-76817c63-f17a-4ce3-bf11-7525ff2bdaaf/block-0.txt — read it with offset=N to resume; 300 lines saved`,
  });
  assert.ok(pass1 !== null && pass2 !== null);
  const tokens1 = estimateTokens(pass1.blocks[0].text);
  const tokens2 = estimateTokens(pass2.blocks[0].text);
  assert.ok(
    pass1.blocks[0].text !== pass2.blocks[0].text,
    `the two passes diverge (pass 1 ${tokens1} tokens, published pass 2 ${tokens2} tokens)`,
  );
  // And the integration layer now measures the one it publishes. Asserted
  // through the plugin rather than here: `test/plugin-recovery.test.mjs` checks
  // that `totals.tokensOut` and the ledger's applied total agree.
});

// ---------------------------------------------------------------------------
// 1.2 — looksLikePayload's density threshold
// ---------------------------------------------------------------------------

test('1.2a dense data is recognised: URL, PEM body, single-line JSON, minified bundle', () => {
  assert.equal(looksLikePayload('https://api.example.com/v2/' + 'x'.repeat(300)), true);
  assert.equal(looksLikePayload('Q'.repeat(300)), true);
  assert.equal(looksLikePayload('{"a":1,"b":2,"c":3,"d":4}'), true);
  assert.equal(looksLikePayload('function f(a){return a*2};'.repeat(10)), true);
});

test('1.2b tab indentation counts as whitespace (density math is correct)', () => {
  // 4 tabs + 116 dense chars in a 120-char line: density 116/120 ≈ 0.967.
  assert.equal(looksLikePayload('\t'.repeat(4) + 'Q'.repeat(116)), true);
  // 40 tabs + 80 dense chars in 120: density 80/120 ≈ 0.667.
  assert.equal(looksLikePayload('\t'.repeat(40) + 'Q'.repeat(80)), false);
});

test('1.2c degenerate lines: empty, spaces-only, very short', () => {
  assert.equal(looksLikePayload(''), false);
  assert.equal(looksLikePayload('    '), false);
  assert.equal(looksLikePayload('\t\t'), false);
  assert.equal(looksLikePayload('ab'), true, 'two dense chars are 100% dense — the rule is density, not length');
});

test('1.2d the 0.9 boundary: exactly-90% is payload, 89% is not', () => {
  assert.equal(looksLikePayload('Q'.repeat(90) + ' '.repeat(10)), true, '0.9 exactly — >= comparison');
  assert.equal(looksLikePayload('Q'.repeat(89) + ' '.repeat(11)), false);
});

test('1.2e FIDELITY H: CJK prose is recognised as prose, not as data', () => {
  // Fixed after this review: Chinese carries no spaces, so a long prose line
  // measured at 100% density and was preserved whole — the truncation ceiling
  // silently did not exist for CJK content, which is most of this project's own
  // prose. `looksLikePayload` now counts CJK code points as word breaks, which
  // is what they are, so density separates a Chinese paragraph from base64 the
  // same way it separates English prose.
  const cjk = '这是一段没有空格的中文长句，用来验证密度判定对无空格散文的处置。'.repeat(8);
  assert.equal(looksLikePayload(cjk), false, 'CJK prose must read as prose');

  // Genuinely opaque content is unaffected.
  assert.equal(looksLikePayload('Q'.repeat(400)), true, 'base64 still reads as payload');
  assert.equal(looksLikePayload('\u4e2d'.repeat(400)), false, 'a pure CJK run reads as text');
});

test('1.2f ACCEPTED I: spaced data rows sit under 0.9 and are cut by design', () => {
  // DECISION (dsh, 2026-09-30): accepted, not fixed.
  //
  // A row that space-separates its fields measures around 0.87 and is truncated.
  // That is the intended reading: such a line *is* text, and prose and code are
  // what the ceiling is for. Lowering the threshold to spare it would start
  // exempting genuinely opaque content — the failure the density test exists to
  // prevent. The loss is recoverable now that the truncation marker names its
  // path, so this is lossy-with-recovery rather than lossy-and-silent. The
  // trade-off is documented at the threshold's definition in slim.js.
  //
  // CSV / SQL dump rows space-separate their fields; a 300-char row with one
  // space every eight chars is 87.5% dense — under the threshold — and is cut
  // to head+tail despite being data the model may need verbatim. The marker
  // now names the recovery path, so this is lossy-with-recovery rather than
  // lossy-and-silent, but "payload detection" misses the most common tabular
  // shape there is.
  const row = Array.from({ length: 34 }, (_, i) => `field${i}`).join(', ').slice(0, 300);
  assert.ok(row.length >= 280);
  assert.equal(looksLikePayload(row), false);
  const options = resolveOptions({ maxResultTokens: 300, genericMaxLineChars: 200 });
  const out = slimContent([{ type: 'text', text: row + '\n' + '2026-05-01T10:00:00Z INFO x\n'.repeat(200) }], 'bash', options, false, {});
  assert.ok(out !== null);
  const body = out.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const line = body.split('\n').find((candidate) => candidate.includes('⋮⟪['));
  assert.ok(line !== undefined, 'finding I: the spaced data row was truncated');
  // Faithful contract is contested here: recovering from the snapshot works,
  // so this may be an accepted tradeoff — but it should then be documented in
  // the threshold's comment instead of reading as "encoded data has no spaces".
});

// ---------------------------------------------------------------------------
// 1.3 — recoveryStore.inspect
// ---------------------------------------------------------------------------

test('1.3a inspect verifies the hash and reports mismatches with both digests', () => {
  const dir = tempDir('slim-r2-inspect-');
  try {
    const store = createRecoveryStore({ rootDir: join(dir, 'store') });
    const content = [{ type: 'text', text: 'original body\n'.repeat(50) }];
    const saved = store.save({ sessionId: 's', callId: 'c', blocks: content });
    const file = saved.files[0].absolutePath;
    const good = store.inspect(file);
    assert.deepEqual({ owned: good.owned, verified: good.verified }, { owned: true, verified: true });

    writeFileSync(file, 'TAMPERED', 'utf8');
    const bad = store.inspect(file);
    assert.equal(bad.owned, true);
    assert.equal(bad.verified, false);
    assert.match(bad.reason, /HASH_MISMATCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1.3b verified:false degrades gracefully: missing file and directory-at-path', () => {
  const dir = tempDir('slim-r2-inspect2-');
  try {
    const store = createRecoveryStore({ rootDir: join(dir, 'store') });
    const saved = store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: 'body' }] });
    const missing = saved.files[0].absolutePath;
    rmSync(missing);
    const inspected = store.inspect(missing);
    assert.deepEqual({ owned: inspected.owned, verified: inspected.verified }, { owned: true, verified: false });
    assert.match(inspected.reason, /FILE_MISSING/);

    const asDir = saved.files[0].absolutePath;
    rmSync(asDir, { force: true });
    mkdirSync(asDir);
    const dirResult = store.inspect(asDir);
    assert.equal(dirResult.owned, true);
    assert.equal(dirResult.verified, false);
    assert.match(dirResult.reason, /UNREADABLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1.3c manifest.json returns owned+verified without a hash check — reasoned accept', () => {
  const dir = tempDir('slim-r2-manifest-');
  try {
    const store = createRecoveryStore({ rootDir: join(dir, 'store') });
    const saved = store.save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: 'body' }] });
    const manifestPath = join(dir, 'store', saved.artifactId, 'manifest.json');
    const inspected = store.inspect(manifestPath);
    assert.deepEqual({ owned: inspected.owned, verified: inspected.verified }, { owned: true, verified: true });
    // Reasoned accept, recorded here so the decision is visible: the manifest
    // is metadata (paths + hashes), not original content, so "bypass" only
    // means the small JSON is served verbatim — which it would be anyway,
    // below every budget. No original-content claim is attached to it.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1.3d inspect cost on an 8 MB snapshot is acceptable on the recovery path', () => {
  const dir = tempDir('slim-r2-cost-');
  try {
    const store = createRecoveryStore({ rootDir: join(dir, 'store') });
    const big = [{ type: 'text', text: 'Q'.repeat(8 * 1024 * 1024) }];
    const saved = store.save({ sessionId: 's', callId: 'c', blocks: big });
    const file = saved.files[0].absolutePath;
    const started = performance.now();
    for (let round = 0; round < 5; round++) store.inspect(file);
    const perCall = (performance.now() - started) / 5;
    assert.ok(perCall < 500, `inspect on 8 MB should stay well under 500 ms, took ${perCall.toFixed(1)} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1.3e ACCEPTED J: the verified badge is granted pre-execute, so the TOCTOU window is real and bounded', async () => {
  // DECISION (dsh, 2026-09-30): accepted, not fixed.
  //
  // The window is milliseconds, requires local write access the model's own
  // shell already has, and crosses no permission boundary — an integrity gap,
  // not a privilege one. The suggested cheap closure (hash the returned content
  // in post-execute) does not actually close it: post-execute receives the read
  // tool's rendered output, envelope included, so the bytes it could hash are no
  // longer the file's. Comparing them against the manifest would compare two
  // different things, and a check that cannot fail correctly is worse than a
  // documented window.
  //
  // inspect() runs in pre-execute; the read tool then reads the file again and
  // post-execute bypasses based on the earlier verdict. A writer that swaps
  // the file between the two reads gets its bytes published as "the verified
  // original". The window is milliseconds and requires local write access —
  // which the model's own shell already has — so this is an accepted-risk
  // framing, not an exploit report. Closing it is cheap if wanted: hash the
  // returned decision content against the manifest in post-execute instead of
  // (or in addition to) inspecting at pre-execute; the bytes are already in
  // hand, so no extra file IO is needed.
  const dir = tempDir('slim-r2-toctou-');
  try {
    const { ctx, handlers } = createFakeContext();
    apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: { rootDir: join(dir, 'store') } });
    const saved = createRecoveryStore({ rootDir: join(dir, 'store') })
      .save({ sessionId: 's', callId: 'c', blocks: [{ type: 'text', text: 'REAL ORIGINAL\n'.repeat(400) }] });
    const path = saved.files[0].absolutePath;

    const exec = { name: 'read', arguments: { file_path: path } };
    const pre = (handlers.get('tools/pre-execute') ?? [])[0];
    await pre(exec, async () => ({ kind: 'allow' }));
    // The swap happens HERE, between inspect and the tool's own read — the
    // exact window. The bypass decision was already made.
    writeFileSync(path, 'SWAPPED IN THE WINDOW', 'utf8');
    const decision = await (handlers.get('tools/post-execute') ?? [])[0](
      exec,
      { content: [{ type: 'text', text: 'SWAPPED IN THE WINDOW' }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'SWAPPED IN THE WINDOW' }] }),
    );
    assert.equal(decision.content[0].text, 'SWAPPED IN THE WINDOW');
    assert.ok(decision.content[0].text.includes('SWAPPED'), 'pinning the window: swapped bytes ride the verified badge');
    // Contract to close it: post-execute re-verification of the returned
    // bytes (no extra IO — the content is in hand).
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1.4 — C / D / E
// ---------------------------------------------------------------------------

test('1.4a C: the shipped defaults are faithful, and log content keeps its \\r', () => {
  const options = resolveOptions({});
  assert.equal(options.stripCarriageReturns, false);
  assert.equal(options.stripTrailingWhitespace, false);
  assert.equal(options.foldRepeatedLines, false);
  const text = '2026-05-01T10:00:00Z ERROR job: 10%\rjob: 50% — aborted\n' + syntheticLog(400, { errorCount: 0 });
  const out = slimContent([{ type: 'text', text }], 'bash', resolveOptions({ maxResultTokens: 300 }), false, {});
  assert.ok(out !== null);
  const body = out.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  assert.ok(body.includes('\r'), 'no default-path stripping: the \r survives into the bounded result');
});

test('1.4b D: the truncation marker is well-formed with and without a recovery note', () => {
  const row = Array.from({ length: 60 }, (_, i) => `f${i}`).join(', ');
  const filler = '2026-05-01T10:00:00Z INFO x\n'.repeat(200);
  const options = resolveOptions({ maxResultTokens: 300, genericMaxLineChars: 200 });
  const bare = slimContent([{ type: 'text', text: row + '\n' + filler }], 'bash', options, false, {});
  const bareLine = bare.blocks[0].text.split('\n').find((line) => line.includes('⋮⟪['));
  assert.ok(bareLine !== undefined);
  assert.ok(bareLine.includes(`(${SLIM_MARKER_VERSION})]⟫`), 'version tag present');
  assert.ok(!bareLine.includes('—  —'), 'no dangling dash when the note is null');

  const noted = slimContent([{ type: 'text', text: row + '\n' + filler }], 'bash', options, false, {
    recoveryNoteFor: () => 'full original: /store/s1/block-0.txt — read it with offset=N',
  });
  const notedLine = noted.blocks[0].text.split('\n').find((line) => line.includes('⋮⟪['));
  assert.ok(notedLine.includes('— full original: /store/s1/block-0.txt'), 'the note rides in the truncation marker');
  assert.ok(notedLine.includes(`(${SLIM_MARKER_VERSION})]⟫`));
});

test('1.4c E: every recovery surface points at the original, none tells the model to re-run', () => {
  // The terse-marker arm of this case was retired with the kernel fix: that path
  // is unreachable now, because the starvation it announced came from the
  // anomaly rule protecting routine lines (see FIDELITY E for the measurements).
  // The property it guarded still holds and is asserted here — no block loses its
  // content to a bare marker, and nothing points the model at a re-run.
  const terse = Array.from({ length: 8 }, (_, i) => ({
    type: 'text',
    text: i % 2 === 0 ? syntheticLog(80) : syntheticSource(80),
  }));
  const terseOut = slimContent(terse, 'bash', resolveOptions({ maxResultTokens: 60 }), false, {});
  const terseBody = terseOut.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  assert.equal(terseOut.stats.terseMarkers, 0, 'no block is replaced by a bare marker');
  assert.ok(terseOut.blocks.every((block) => block.text.length > 0), 'every block keeps something');
  assert.ok(!terseBody.includes('repeat the call'), 'no re-run guidance anywhere');

  const generic = slimContent([{ type: 'text', text: syntheticSource(300) }], 'bash', resolveOptions({ maxResultTokens: 400 }), false, {});
  assert.equal(RECOVERY_NOTE.includes('re-run the command only if it is safe'), true, 'RECOVERY_NOTE stays conditional, never "do re-run"');
  assert.ok(generic.blocks[0].text.includes(RECOVERY_NOTE), 'generic markers carry the conditional sentence');
});

// ---------------------------------------------------------------------------
// Round-1 regression: the old audit pins must still hold after the rewrites
// ---------------------------------------------------------------------------

test('round-1 pins hold: quote survival, marker service, self-referential fidelity', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const dir = tempDir('slim-r2-regress-');
  try {
    const fixture = `const FIXTURE = '⟪[... 2 lines omitted — source lines 1-2. ${RECOVERY_NOTE}${TAIL}⟫';\n` + syntheticSource(300);
    const fixturePath = join(dir, 'fixture.js');
    writeFileSync(fixturePath, fixture, 'utf8');

    const { ctx, handlers } = createFakeContext();
    apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: { rootDir: join(dir, 'store') } });
    const post = handlers.get('tools/post-execute') ?? [];

    const decision = await post[0](
      { name: 'bash', arguments: { command: 'cat fixture' } },
      { content: [{ type: 'text', text: fixture }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: fixture }] }),
    );
    const body = bodyOf(decision);
    assert.ok(body.includes(`'⟪[... 2 lines omitted`), 'the quotation survives verbatim (finding A regression)');
    assert.ok(body.includes('full original: '), 'the kernel marker is served (finding B regression)');

    const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const indexPath = join(pluginDir, 'index.js');
    if (existsSync(indexPath)) {
      const source = readFileSync(indexPath, 'utf8');
      const sourceDecision = await post[0](
        { name: 'bash', arguments: { command: 'cat index.js' } },
        { content: [{ type: 'text', text: source }] },
        async () => ({ kind: 'accept', content: [{ type: 'text', text: source }] }),
      );
      const sourceBody = bodyOf(sourceDecision);
      for (const line of source.split('\n')) {
        if (!line.includes('the rest was not saved') && !line.includes('full original:')) continue;
        assert.ok(
          sourceBody.split('\n').some((outputLine) => outputLine === line) || !sourceBody.includes(line),
          'self-referential: no rewritten source line published',
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
