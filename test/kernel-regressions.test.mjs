/**
 * Kernel regression cases carried over from the round-two repair plan (task C).
 *
 * Each shape here either behaved wrong at some point or was never covered. They
 * live in their own file because they are about the kernel surviving specific
 * real-world payloads, not about any one feature:
 *
 *   - content that quotes our own marker must not be mistaken for finished work;
 *   - forty errors with stack traces must all survive with their context;
 *   - many small gaps must each be announced, not silently merged into one;
 *   - non-text blocks must pass through by identity, untouched and uncounted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens,
  looksLikePayload as slimLooksLikePayload,
  resolveOptions,
  slimContent,
  slimGenericText,
  slimReadText,
} from '../slim.js';
import { scoreLines } from '../importance.js';
import { asReadResult } from './fixtures/source-samples.mjs';

const options = resolveOptions({ maxResultTokens: 2000, readMaxResultTokens: 2000 });

test('content quoting the marker is not mistaken for finished work', () => {
  // The kernel once treated its own marker as proof of prior processing, which
  // made the text the source of truth. Prose about this file, a diff of it, a
  // log line quoting it — all were exempted from bounding entirely.
  const quotation = 'the tool writes ⟪[... 3 lines omitted (slimmed v1)]⟫ into every bounded payload';
  const filler = Array.from({ length: 2000 }, (_, i) => `2026-05-01T10:00:00Z INFO row=${i} payload ok`);
  const body = [quotation, ...filler].join('\n');

  const direct = slimGenericText(body, resolveOptions({ maxResultTokens: 800 }));
  assert.ok(direct.stats.omittedLines > 0, 'quoting the marker must not exempt the payload');

  const wrapped = slimReadText(asReadResult('C:/tmp/quoted.txt', body), resolveOptions({ readMaxResultTokens: 800 }));
  assert.ok(wrapped.stats.omittedLines > 0, 'the same holds for a quoted payload inside a read envelope');
});

test('forty errors with stack traces keep every error and its context', () => {
  // A protected line is nothing without the frame above it: an exception type
  // reads fine alone, but the call site is what makes it actionable.
  const lines = [];
  for (let group = 0; group < 40; group++) {
    lines.push(`2026-05-01T10:00:${String(group % 60).padStart(2, '0')}Z INFO shard=${group} request start`);
    lines.push(`2026-05-01T10:00:00Z ERROR shard=${group} TypeError: cannot read property 'id' of undefined`);
    lines.push(`    at handleRequest (C:/app/src/server/handler-${group}.js:42:11)`);
    lines.push(`    at process (C:/app/src/runtime/dispatch.js:${100 + group}:5)`);
    lines.push(`2026-05-01T10:00:00Z INFO shard=${group} request end status=500`);
  }
  const text = lines.join('\n');
  const result = slimContent([{ type: 'text', text }], 'pwsh', resolveOptions({ maxResultTokens: 3000 }));
  assert.ok(result !== null);
  const out = result.blocks[0].text;

  for (let group = 0; group < 40; group++) {
    assert.ok(out.includes(`ERROR shard=${group} `), `error ${group} must survive`);
    assert.ok(out.includes(`handler-${group}.js`), `the frame naming error ${group}'s call site must survive`);
  }
});

test('many small gaps are each announced', () => {
  // Every omitted run gets its own marker. Silently merging them would hide
  // where the holes are, which is exactly what a reader needs to navigate.
  const lines = [];
  for (let index = 0; index < 400; index++) {
    // Keep something every 40th line so the result is many short gaps rather
    // than one big one.
    if (index % 40 === 0) lines.push(`${index}: function section${index}() {`);
    else lines.push(`  const value${index} = compute(${index});`);
  }
  const text = lines.join('\n');
  const result = slimContent([{ type: 'text', text }], 'pwsh', resolveOptions({ maxResultTokens: 400 }));
  assert.ok(result !== null);
  const markers = [...result.blocks[0].text.matchAll(/⟪\[[^⟫]*⟫/g)].map((match) => match[0]);
  assert.ok(markers.length > 1, `expected several gaps, found ${markers.length}`);
  for (const marker of markers) {
    assert.match(marker, /omitted/, `every gap must say it omitted something: ${marker}`);
  }
});

test('non-text blocks pass through by identity and are not counted as text', () => {
  const image = { type: 'image', attachment: { attachmentId: 'img-1', bytes: 12345 } };
  const file = { type: 'file', attachment: { attachmentId: 'file-1' } };
  const unknown = { type: 'some-future-block', payload: { nested: true } };
  const rows = Array.from({ length: 2500 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);

  const blocks = [image, { type: 'text', text: rows.join('\n') }, file, unknown];
  const result = slimContent(blocks, 'pwsh', options);
  assert.ok(result !== null);
  assert.equal(result.blocks[0], image, 'the leading image is the same object');
  assert.equal(result.blocks[2], file, 'the trailing file block is the same object');
  assert.equal(result.blocks[3], unknown, 'an unrecognised block type is passed through, never dropped');
  assert.equal(result.blocks.length, 4, 'interleaving is preserved');
});

test('budget accounting claims text tokens only', () => {
  // The ledger estimates text tokens. An image or an attachment has a cost, but
  // it is not this estimator's to claim — reporting it would make the savings
  // figure describe something the kernel never measured.
  const rows = Array.from({ length: 2500 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);
  const text = rows.join('\n');
  const image = { type: 'image', attachment: { attachmentId: 'img-1', bytes: 900000 } };

  const plain = slimContent([{ type: 'text', text }], 'pwsh', options);
  const mixed = slimContent([{ type: 'text', text }, image], 'pwsh', options);
  assert.ok(plain !== null && mixed !== null);
  assert.equal(
    mixed.stats.tokensIn,
    plain.stats.tokensIn,
    'adding a non-text block must not change the text token accounting',
  );
  assert.equal(mixed.stats.tokensOut, plain.stats.tokensOut);
});

test('a read envelope keeps its frame and its footer', () => {
  const rows = Array.from({ length: 2500 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);
  const payload = asReadResult('C:/fixtures/one.log', rows.join('\n'));
  const result = slimContent([{ type: 'text', text: payload }], 'read', resolveOptions({ readMaxResultTokens: 1000 }));
  assert.ok(result !== null);
  const out = result.blocks[0].text;
  assert.ok(out.startsWith('<path>C:/fixtures/one.log</path>'), 'the path line survives');
  assert.ok(out.includes('</content>'), 'the closing tag survives');
  assert.ok(result.stats.omittedLines > 0, 'the body was actually bounded');
});

test('a payload with one unbreakable line is left alone rather than truncated', () => {
  // `payloadLineGuardChars` is the safety valve for content that cannot be
  // recovered by re-reading a range: a base64 blob, a minified bundle, one
  // enormous JSON line. Bounding it would destroy it.
  const blob = `data=${'A'.repeat(60000)}`;
  const text = `${blob}\n${'tail line\n'.repeat(500)}`;
  const result = slimContent([{ type: 'text', text }], 'pwsh', resolveOptions({ maxResultTokens: 200 }));
  assert.equal(result, null, 'an unsplittable payload must pass through untouched');
});

test('bounding is deterministic across repeated runs of the same input', () => {
  const rows = Array.from({ length: 3000 }, (_, i) =>
    i % 300 === 0 ? `2026-05-01T10:00:00Z ERROR shard=${i}` : `2026-05-01T10:00:00Z INFO row=${i} ok`,
  );
  const text = rows.join('\n');
  const first = slimContent([{ type: 'text', text }], 'pwsh', options);
  const second = slimContent([{ type: 'text', text }], 'pwsh', options);
  assert.ok(first !== null && second !== null);
  assert.equal(first.blocks[0].text, second.blocks[0].text, 'a pure kernel must be reproducible');
  assert.equal(first.stats.tokensOut, second.stats.tokensOut);
});

test('the payload-density test recognises CJK as prose, not as a blob', () => {
  // ZCode's finding H: CJK is written without spaces, so a Chinese paragraph
  // measured at a density of 1.0 — identical to base64 — and
  // `genericMaxLineChars` could never reach it. Every CJK character is a word,
  // which is the property the density test is actually looking for.
  const payloads = [
    'Q'.repeat(400),
    'function a(b){return b+1}var c=[1,2,3];'.repeat(15),
  ];
  for (const line of payloads) {
    assert.equal(slimLooksLikePayload(line), true, `should read as payload: ${line.slice(0, 24)}…`);
  }

  const texts = [
    'alpha beta gamma delta '.repeat(20),
    '中文段落'.repeat(80),
    '中文、段落。'.repeat(60),
    '中文 abc 段落'.repeat(50),
    'SELECT a, b, c FROM t WHERE x = 1 '.repeat(15),
    '        const value = compute(1);'.repeat(12),
  ];
  for (const line of texts) {
    assert.equal(slimLooksLikePayload(line), false, `should read as text: ${line.slice(0, 24)}…`);
  }

  // Degenerate inputs must not throw or be mistaken for payload.
  assert.equal(slimLooksLikePayload(''), false);
  assert.equal(slimLooksLikePayload(' '.repeat(100)), false);
  assert.equal(slimLooksLikePayload('\t'.repeat(100)), false);
});

test('a Chinese paragraph is bounded rather than passed through unbounded', () => {
  // The end-to-end consequence of finding H: with the setting on, a long CJK
  // line is now subject to the ceiling instead of being invisible to it.
  const cjk = '这是一段很长的中文说明文字，用来验证截断逻辑对中日韩文本是否生效。'.repeat(30);
  const result = slimGenericText(cjk, resolveOptions({ genericMaxLineChars: 200 }));
  assert.ok(result.stats.linesTruncated > 0, 'the CJK line must be reachable by the ceiling');
  assert.match(result.text, /chars omitted .*slimmed v1/, 'and the marker names its version');
});

test('the estimator never reports zero for content that has bytes', () => {
  for (const sample of ['a', 'ab', '中', '😀', 'a\nb', ' '.repeat(100)]) {
    assert.ok(estimateTokens(sample) > 0, `estimateTokens(${JSON.stringify(sample)}) must not be zero`);
  }
  assert.equal(estimateTokens(''), 0, 'empty is genuinely empty');
});

/**
 * A routine service log: 900 lines, one buried ERROR and one FATAL at 448/449,
 * heartbeats every 150 lines, and request ids whose digit count varies
 * (`req-a` vs `req-1f4`), which is what a real one looks like.
 */
function serviceLog() {
  const lines = [];
  for (let i = 0; i < 900; i++) {
    const t = `2026-05-01T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`;
    if (i === 447) lines.push(`${t} ERROR worker-3 pool exhausted: max=32 active=32 queued=417 rejected=1 requestId=req-9f3a2b`);
    else if (i === 448) lines.push(`${t} FATAL worker-3 shed load: dropping requestId=req-9f3a2b reason=pool-exhausted`);
    else if (i % 150 === 0) lines.push(`${t} INFO heartbeat shard=${i % 8} rss=512mb`);
    else lines.push(`${t} INFO request served requestId=req-${i.toString(16)} latency=${20 + (i % 90)}ms status=200`);
  }
  return lines;
}

test('a routine service log keeps its budget: shifting identifiers are not anomalies', () => {
  // Measured defect. `numericAnomalies` mined digits by position in the line, so
  // any field whose digit count varies (`requestId=req-1f4` versus `req-a`)
  // shifted every later column and merged unrelated fields into one bimodal
  // column. 2σ over that mixture branded 22% of the routine INFO lines as
  // outliers, and additives are taken unconditionally, so those lines spent the
  // budget themselves: a 200-token request rendered 7,452 tokens, and the
  // production 2,000-token ceiling rendered the very same 7,452 — the ceiling
  // did nothing at all, which is the one thing this kernel exists to prevent.
  //
  // The fix is stable field identity (a `label=value` pair keys its own column)
  // plus a guard that a column branding a large share of its own values is not
  // an outlier test. A genuinely dominant error rate stays visible because the
  // ERROR/FATAL lines are protected by the error patterns, not by the anomaly
  // rule: both must still survive here.
  const lines = serviceLog();
  const result = slimGenericText(lines.join('\n'), resolveOptions({ maxResultTokens: 2000 }));

  assert.match(result.text, /pool exhausted/, 'the buried ERROR line must survive');
  assert.match(result.text, /shed load/, 'the buried FATAL line must survive');
  assert.ok(result.stats.omittedLines > 400, `routine traffic must still be bounded, omitted ${result.stats.omittedLines}`);

  const rendered = estimateTokens(result.text);
  assert.ok(rendered <= 2000 * 1.5, `the ceiling must bind: ${rendered} tokens rendered for a 2000-token budget`);
  assert.ok(
    result.stats.protectedLines <= 20,
    `a routine log protects only what says what happened, protected ${result.stats.protectedLines} lines`,
  );
});

test('a real outlier in a labelled column is still an anomaly', () => {
  // The guard must not cost the feature it guards: one slow request among a
  // thousand uniform ones is exactly what the anomaly rule is for.
  const lines = Array.from({ length: 200 }, (_, i) => `latency=${40 + (i % 3)}ms status=200`);
  lines.push('latency=9999ms status=200');
  const { additive } = scoreLines(lines, {});
  assert.ok(additive.has(200), 'the single slow request must be additive');
  assert.equal(additive.size, 1, `only the outlier is an anomaly, flagged ${additive.size}`);
});
