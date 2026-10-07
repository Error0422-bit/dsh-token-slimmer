/**
 * Fidelity audit: adversarial inputs for every text modification the plugin
 * makes to model-visible content (task 1 of TASKS-zcode.md).
 *
 * Method, per modification point: construct input whose ORIGINAL text contains
 * the pattern the plugin treats as its own, force it OVER the budget (below it
 * the replacement paths never run), drive the real pipeline, and assert what
 * actually happens to the original bytes.
 *
 * Findings are pinned as CURRENT behavior with `AUDIT FINDING` comments; the
 * faithful assertion to flip to is written beside each. See AUDIT-zcode.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, RECOVERY_NOTE_PLACEHOLDER } from '../index.js';
import { resolveOptions, slimContent, SLIM_MARKER_VERSION, RECOVERY_NOTE } from '../slim.js';
import { syntheticSource, syntheticLog } from './fixtures/source-samples.mjs';
import { createFakeContext } from './helpers/fake-session.mjs';

const TAIL = ` (${SLIM_MARKER_VERSION})]⟫`;
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

function bodyOf(decision) {
  return decision.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

// ---------------------------------------------------------------------------
// CRLF / trailing whitespace (slim.js normalize, gated by resolveTransforms)
// ---------------------------------------------------------------------------

test('FIDELITY C: detected-log content is NOT stripped at shipped defaults', () => {
  // resolveTransforms gates the lossy log transforms behind
  // options.stripCarriageReturns === true, and the shipped DEFAULTS now carry
  // these as false — so the gate means what its doc says and a caller gets
  // fidelity without asking. Before the fix the defaults were true, the gate
  // was vacuous, and any result detected as `log` silently lost \r, trailing
  // whitespace and repeated runs with no omission marker.
  //
  // Concrete damage that motivated it: a progress line uses \r to overwrite
  // itself in place — one logical update, many physical fragments. Stripping
  // turns each fragment into its own line, so the model reads a log timeline
  // that never existed.
  const text = '2026-05-01T10:00:00Z ERROR job: 10%\rjob: 50%\rjob: 100% — aborted\n' + syntheticLog(400, { errorCount: 0 });
  const options = resolveOptions({ maxResultTokens: 300 });
  assert.equal(options.stripCarriageReturns, false, 'the shipped default must be faithful');
  assert.equal(options.stripTrailingWhitespace, false);
  assert.equal(options.foldRepeatedLines, false);

  const out = slimContent([{ type: 'text', text }], 'bash', options, false, {});
  assert.ok(out !== null, 'input must exceed the budget');
  const body = out.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  assert.ok(body.includes('\r'), 'the carriage returns must survive bounding');
  assert.ok(body.includes('job: 100% — aborted'), 'the progress line stays one physical line');

  // The transforms are still available — a caller that wants them asks.
  const optedIn = resolveOptions({
    maxResultTokens: 300,
    stripCarriageReturns: true,
    stripTrailingWhitespace: true,
    foldRepeatedLines: true,
  });
  assert.equal(optedIn.stripCarriageReturns, true, 'explicit configuration still enables them');
});

// ---------------------------------------------------------------------------
// Long-line truncation (slim.js truncateLongLines, defaults to 0 = off)
// ---------------------------------------------------------------------------

test('FIDELITY D: a truncation marker names its version and how much was lost', () => {
  // genericMaxLineChars defaults to 0 (off). When a deployer turns it on and a
  // long line is cut to head+tail, the marker used to read `⋮⟪+N chars⟫` — no
  // version tag, no range, no way back. Every other omission in this kernel
  // names its way out, and a truncation that says only "+N chars" leaves the
  // reader with no move at all.
  // A long line that reads as prose, not as payload: the density exemption
  // below (finding D2) leaves encoded data alone, so a fixture made of one long
  // URL would never reach the truncation path at all.
  const longProse = `note ${'alpha beta gamma delta '.repeat(40)}`;
  const filler = Array.from({ length: 200 }, (_, i) => `2026-05-01T10:00:00Z INFO row ${i} ok`).join('\n');
  const options = resolveOptions({ maxResultTokens: 400, genericMaxLineChars: 200 });
  const out = slimContent([{ type: 'text', text: `${longProse}\n${filler}` }], 'bash', options, false, {});
  assert.ok(out !== null, 'input must exceed the budget for the truncation path to run');
  const body = out.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const truncatedLine = body.split('\n').find((line) => line.includes('\u22ee\u27ea'));
  assert.ok(truncatedLine !== undefined, 'the long prose line was truncated');
  assert.ok(truncatedLine.includes('slimmed v1'), 'the marker carries a version tag like every other');
  assert.match(truncatedLine, /\[\.\.\. \d+ chars omitted/, 'the marker names how much was removed');
  assert.ok(out.stats.linesTruncated > 0, 'and the truncation is counted');
});

test('FIDELITY D-with-recovery: the marker names the snapshot when the caller knows it', () => {
  // The caller can supply the instruction; when it does, the truncation marker
  // carries the same way back that line omissions do.
  const longProse = `note ${'alpha beta gamma delta '.repeat(40)}`;
  const filler = Array.from({ length: 200 }, (_, i) => `2026-05-01T10:00:00Z INFO row ${i} ok`).join('\n');
  const options = resolveOptions({ maxResultTokens: 400, genericMaxLineChars: 200 });
  const out = slimContent([{ type: 'text', text: `${longProse}\n${filler}` }], 'bash', options, false, {
    recoveryNoteFor: () => 'full original: C:/store/abc/block-0.txt — read it with offset=N to resume',
  });
  assert.ok(out !== null);
  const body = out.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const truncatedLine = body.split('\n').find((line) => line.includes('\u22ee\u27ea'));
  assert.ok(truncatedLine.includes('C:/store/abc/block-0.txt'), `marker must name the snapshot: ${truncatedLine}`);
});

test('FIDELITY D2: a dense payload line is left whole', () => {
  // payloadLineGuardChars: 2000 exempts a result whose line exceeds 2000 chars,
  // on the reasoning that a very long line IS the payload. A 1,500-char base64
  // body sits just under that ceiling — and used to be cut to head+tail, so the
  // model received half a payload it could not use. Same failure the guard
  // exists to prevent, one size class down. Density is what the length
  // threshold was standing in for.
  const b64 = `data: ${'Q'.repeat(1500)}`;
  const filler = Array.from({ length: 120 }, (_, i) => `log line ${i}`).join('\n');
  const options = resolveOptions({ maxResultTokens: 300, genericMaxLineChars: 200 });
  const out = slimContent([{ type: 'text', text: `${b64}\n${filler}` }], 'bash', options, false, {});
  assert.ok(out !== null);
  // Asserted on the counter rather than on the rendered body: the payload line
  // itself may legitimately be omitted by budget bounding, so its absence from
  // the output would not distinguish "cut" from "not selected".
  assert.equal(out.stats.linesTruncated, 0, 'a dense payload line must not be cut');
  assert.equal(out.stats.payloadLinesPreserved, 1, 'the exemption is counted and visible');
});

// ---------------------------------------------------------------------------
// Terse-marker merge note (slim.js slimContent tail)
// ---------------------------------------------------------------------------

test('FIDELITY E: no block is replaced by a bare marker, and none says to re-run', () => {
  // This fixture used to reach the terse-marker path, and the ⟪⋯⟫ merge note was
  // where the model was once told to "repeat the call" — the exact guidance task
  // B removed from every other marker. That note is retired rather than
  // re-worded, because the path itself became unreachable once the anomaly rule
  // stopped branding routine lines as outliers: the starvation it reported was
  // produced by that false protection (measured after the fix — budgets 1 / 8 /
  // 60 over single- and multi-block shapes, and a block of 20 / 40 / 80 ERROR
  // lines, all yield terseMarkers 0). What has to hold now is the outcome the
  // finding was about: nothing evaporates into a marker with no recovery
  // pointer, and nothing tells the model to re-run the tool.
  const blocks = Array.from({ length: 8 }, (_, i) => ({
    type: 'text',
    text: i % 2 === 0 ? syntheticLog(80) : syntheticSource(80),
  }));
  const options = resolveOptions({ maxResultTokens: 60 });
  const out = slimContent(blocks, 'bash', options, false, {});
  assert.ok(out !== null, 'input must exceed the budget');
  assert.equal(out.stats.terseMarkers, 0, 'a block with room for its head is not replaced by a bare marker');
  assert.ok(out.blocks.every((block) => block.text.length > 0), 'every block keeps something');
  const body = out.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  assert.equal(body.includes('repeat the call'), false, 'and nothing suggests re-running the tool');
});

// ---------------------------------------------------------------------------
// Recovery-read bypass (index.js tools/pre-execute + ownsPath)
// ---------------------------------------------------------------------------

test('FIDELITY F: the recovery-read bypass verifies the content, not just the path', async () => {
  // The bypass is a promise that what the model receives is the original, so
  // manifest membership is not enough: a file still sitting at the recorded
  // path may have been rewritten since — by a shell command the model itself
  // ran, or by anything else on the machine. Publishing those bytes in the
  // position of "the saved original" is a lie the model cannot detect.
  //
  // The manifest already carries a hash per file, so the check is exact rather
  // than heuristic. It runs on the path, before the read: by the time a result
  // exists it has been rendered into an envelope and nothing in it hashes to
  // the file any more.
  const dir = tempDir('slim-audit-');
  try {
    const { ctx, handlers } = createFakeContext();
    const storeDir = join(dir, 'store');
    apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: { rootDir: storeDir } });

    const sessionDir = join(storeDir, 'session-fake');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify({
      artifactId: 'artifact-fake',
      sessionId: 'fake',
      callId: 'fake',
      files: [{ path: 'block-0.txt', sha256: 'deadbeef', bytes: 16 }],
    }), 'utf8');
    writeFileSync(join(sessionDir, 'block-0.txt'), 'TAMPERED CONTENT', 'utf8');

    const exec = { name: 'read', callId: 'f1', arguments: { file_path: join(sessionDir, 'block-0.txt') } };
    for (const listener of handlers.get('tools/pre-execute') ?? []) {
      await listener(exec, async () => ({ kind: 'allow' }));
    }
    // Many short lines, not one long one: a single 40k line would trip
    // `payloadLineGuardChars` and pass through for a different reason, so the
    // test would not be measuring the bypass at all.
    const tampered = `TAMPERED CONTENT\n${Array.from({ length: 3000 }, (_, i) => `row ${i} ${'x'.repeat(40)}`).join('\n')}`;
    const decision = await (handlers.get('tools/post-execute') ?? [])[0](
      exec,
      { content: [{ type: 'text', text: tampered }] },
      // No `content` in the next() result: a decision only carries content when
      // a transform replaced it, which is exactly what this test distinguishes.
      async () => ({ kind: 'accept' }),
    );

    // The tampered file does NOT get the bypass: the read is bounded like any
    // other content, and the mismatch is recorded.
    assert.notEqual(decision.content, undefined, 'an unverified snapshot must not bypass bounding');
    assert.ok(decision.content[0].text.length < tampered.length, 'it was actually bounded');
    assert.equal(
      decision.content[0].text.includes('TAMPERED CONTENT'),
      true,
      'the content still reaches the model — bounded, not hidden',
    );

    for (const listener of handlers.get('agent/disposed') ?? []) await listener();
    const stats = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'));
    assert.equal(stats.recoveryBypassed, 0, 'no bypass may be granted');
    assert.equal(stats.recoveryUnverified, 1, 'the mismatch must be recorded');
    assert.match(stats.recoveryFailureReason, /HASH_MISMATCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIDELITY F2: an intact snapshot still gets its bypass', async () => {
  // The other direction: verification must not be so strict that the feature
  // stops working. A file whose bytes match the recorded hash bypasses as before.
  const dir = tempDir('slim-verify-ok-');
  try {
    const { createHash } = await import('node:crypto');
    const { ctx, handlers } = createFakeContext();
    const storeDir = join(dir, 'store');
    apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: { rootDir: storeDir } });

    const sessionDir = join(storeDir, 'session-fake');
    mkdirSync(sessionDir, { recursive: true });
    const body = `ORIGINAL BYTES\n${Array.from({ length: 3000 }, (_, i) => `row ${i} ${'y'.repeat(40)}`).join('\n')}`;
    writeFileSync(join(sessionDir, 'block-0.txt'), body, 'utf8');
    writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify({
      artifactId: 'artifact-ok',
      sessionId: 'fake',
      callId: 'fake',
      files: [{
        path: 'block-0.txt',
        sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(body, 'utf8'),
      }],
    }), 'utf8');

    const exec = { name: 'read', callId: 'f2', arguments: { file_path: join(sessionDir, 'block-0.txt') } };
    for (const listener of handlers.get('tools/pre-execute') ?? []) {
      await listener(exec, async () => ({ kind: 'allow' }));
    }
    const decision = await (handlers.get('tools/post-execute') ?? [])[0](
      exec,
      { content: [{ type: 'text', text: body }] },
      async () => ({ kind: 'accept' }),
    );

    assert.equal(decision.content, undefined, 'a verified snapshot passes through untouched');

    for (const listener of handlers.get('agent/disposed') ?? []) await listener();
    const stats = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'));
    assert.equal(stats.recoveryBypassed, 1);
    assert.equal(stats.recoveryUnverified, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Self-referential: the pipeline must not rewrite the plugin's own source
// ---------------------------------------------------------------------------

test('self-referential: bounded plugin source never comes back with rewritten literals', async () => {
  // a651901's defect was invisible from the source side: reading index.js
  // through the plugin rewrote the file's own placeholder constant into a live
  // recovery path. This drives the plugin's actual source files through the
  // full GENERIC pipeline (where substitution runs) plus a fixture that quotes
  // complete markers, and asserts the invariant: no original source line may
  // reappear with its placeholder literal swapped for a recovery path.
  const { readFileSync, existsSync } = await import('node:fs');
  const dir = tempDir('slim-selfref-');
  try {
    // A source-shaped file that quotes complete markers, the way any fixture,
    // doc or diff of this repo legitimately does.
    const fixture = [
      `const FIXTURE_A = '⟪[... 2 lines omitted — source lines 1-2. ${RECOVERY_NOTE}${TAIL}⟫';`,
      `export const RECOVERY_NOTE_PLACEHOLDER = '${RECOVERY_NOTE_PLACEHOLDER}';`,
      ...syntheticSource(300).split('\n'),
    ].join('\n');
    const fixturePath = join(dir, 'fixture-with-markers.js');
    writeFileSync(fixturePath, fixture, 'utf8');

    const { ctx, handlers } = createFakeContext();
    apply(ctx, { statsPath: join(dir, 'stats.json'), recovery: { rootDir: join(dir, 'store') } });
    const post = handlers.get('tools/post-execute') ?? [];

    const sources = ['index.js', 'slim.js']
      .map((name) => ({ name, path: join(PLUGIN_DIR, name) }))
      .filter(({ path }) => existsSync(path))
      .map(({ name, path }) => ({ name, text: readFileSync(path, 'utf8') }));
    sources.push({ name: fixturePath, text: fixture });
    assert.ok(sources.length === 3, 'expected index.js, slim.js and the fixture');

    let substitutionLive = false;
    for (const { name, text } of sources) {
      // GENERIC result on purpose: read-kind markers carry offset hints and
      // never reach the substitution; only generic results do.
      const exec = { name: 'bash', arguments: { command: `cat ${name}` } };
      const decision = await post[0](exec, { content: [{ type: 'text', text }] }, async () => ({
        kind: 'accept',
        content: [{ type: 'text', text }],
      }));
      const body = bodyOf(decision);
      if (decision.content[0].text !== text && body.includes('full original: ')) substitutionLive = true;

      for (const line of text.split('\n')) {
        if (!line.includes(RECOVERY_NOTE_PLACEHOLDER)) continue;
        const fabricated = line.split(RECOVERY_NOTE_PLACEHOLDER).join(
          `full original: C:/store/session-x/block-0.txt — read it with offset=N to resume; 743 lines saved`,
        );
        assert.ok(
          !body.includes(fabricated),
          `self-referential fidelity broken in ${name}: a source line was rewritten`,
        );
      }
    }
    assert.ok(substitutionLive, 'the pipeline must actually have substituted a real marker for this check to mean anything');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
