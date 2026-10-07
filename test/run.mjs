/**
 * Verification suite for the token-slimmer kernel.
 *
 * Every case runs against real bytes: real harness source files read through
 * the real `read` envelope format, and real transformed output produced by
 * wrapping the files in the exact envelope `dsh-tool-fs` emits. The suite
 * asserts both the compression ratio and the invariants that keep the model
 * able to recover anything that was removed.
 *
 * Run with: node test/run.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

import {
  canonicalArgs,
  DEFAULTS,
  estimateTokens,
  joinReadEnvelope,
  resolveOptions,
  shortDigest,
  slimContent,
  slimGenericText,
  slimReadText,
  splitReadEnvelope,
} from '../slim.js';

import { splitConfig } from '../index.js';
import { scoreLines, selectByImportance } from '../importance.js';
import { detectContentType, hasAnalysisIntent, resolvePolicy } from '../policy.js';
import { boundReasoningContent, boundReasoningText, planReasoningPass, resolveReasoningOptions } from '../reasoning.js';
import { syntheticJson, syntheticLog, syntheticSource } from './fixtures/source-samples.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const options = resolveOptions({});

/**
 * Options with the lossy log transforms explicitly enabled.
 *
 * These are off in the shipped defaults so that a caller gets fidelity without
 * asking; the tests that check the reductions have to opt in the way a deployer
 * would. Passing them implicitly was how the defaults came to contradict the
 * `=== true` gate in `resolveTransforms`.
 */
const logReductionOptions = resolveOptions({
  stripCarriageReturns: true,
  stripTrailingWhitespace: true,
  foldRepeatedLines: true,
});

/**
 * Run passive output through the plugin path, where a content policy applies.
 *
 * Calling `slimGenericText` directly is byte-faithful by design — the low-level
 * default is conservative so a refactor cannot reintroduce the whitespace
 * damage. Log reductions are only reachable through the policy plus an explicit
 * option, which is what this exercises when asked to.
 */
const slimPassive = (text, toolName = 'pwsh', opts = options) =>
  slimContent([{ type: 'text', text }], toolName, opts);

let cases = 0;
let failures = 0;

/**
 * Run one named case, reporting pass or failure without aborting the suite.
 * @param {string} name - case name.
 * @param {() => void} body - assertions.
 */
function test(name, body) {
  cases++;
  try {
    body();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n').join('\n        ')}`);
  }
}

/** Render a file's bytes exactly the way the `read` tool renders them. */
function asReadResult(absolutePath, text) {
  const lines = text.split('\n');
  const numbered = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
  return [
    `<path>${absolutePath}</path>`,
    '<type>file</type>',
    '<content>',
    numbered,
    '',
    `(End of file - total ${lines.length} lines)`,
    '</content>',
  ].join('\n');
}

/** Ratio of tokens removed, as a percentage string. */
function saved(stats) {
  if (stats.tokensIn === 0) return '0.0%';
  return `${(((stats.tokensIn - stats.tokensOut) / stats.tokensIn) * 100).toFixed(1)}%`;
}

console.log('\n=== 1. Envelope round-trip and invariants ===\n');

// Portable synthetic fixtures replace the harness sources this suite used to
// read from an absolute path under one machine's home directory. Set
// DSH_SOURCE_ROOT to point the corpus measurement at real code instead.
const bigSourcePath = 'C:/fixtures/synthetic-module.ts';
const bigSource = syntheticSource(3700);
const readResult = asReadResult(bigSourcePath, bigSource);

test('read envelope splits into prefix + body + tail with no byte loss', () => {
  const parts = splitReadEnvelope(readResult);
  assert.ok(parts !== null, 'expected a read envelope');
  const rebuilt = joinReadEnvelope(parts, parts.body);
  assert.equal(rebuilt, readResult, 'round-trip must be byte-identical');
});

test('a body containing the closing tag or a paren line still splits correctly', () => {
  const nasty = [
    '<path>C:/tmp/nasty.html</path>',
    '<type>file</type>',
    '<content>',
    '1: <div>',
    '</content>',
    '2: (paren line)',
    '',
    '(End of file - total 2 lines)',
    '</content>',
  ].join('\n');
  const parts = splitReadEnvelope(nasty);
  assert.ok(parts !== null);
  assert.equal(joinReadEnvelope(parts, parts.body), nasty);
  assert.ok(parts.body.endsWith('2: (paren line)'), parts.body);
  assert.ok(parts.tail.includes('(End of file - total 2 lines)'), parts.tail);
});

test('splitReadEnvelope returns null for non-read content', () => {
  assert.equal(splitReadEnvelope('plain shell output\nsecond line'), null);
  assert.equal(splitReadEnvelope('<path>x</path>\nnot a read envelope'), null);
});

test('slimmed read result keeps its envelope and continuation footer', () => {
  const result = slimReadText(readResult, options);
  assert.ok(result.text.startsWith(`<path>${bigSourcePath}</path>\n<type>file</type>\n<content>\n`));
  assert.ok(result.text.endsWith('\n</content>'));
  assert.ok(/\(End of file - total \d+ lines\)/.test(result.text), 'footer must survive');
});

test('line numbers stay parseable and strictly increasing', () => {
  const result = slimReadText(readResult, options);
  const parts = splitReadEnvelope(result.text);
  assert.ok(parts !== null);
  let previous = 0;
  let seen = 0;
  for (const line of parts.body.split('\n')) {
    const match = /^(\d+):/.exec(line);
    if (match === null) {
      assert.ok(line.startsWith('⟪'), `unexpected non-numbered line: ${line.slice(0, 60)}`);
      continue;
    }
    const number = Number(match[1]);
    assert.ok(number > previous, `line numbers must increase (${previous} -> ${number})`);
    previous = number;
    seen++;
  }
  assert.ok(seen > 100, `expected many surviving lines, saw ${seen}`);
});

console.log('\n=== 2. Compression on real harness source ===\n');

test('a real source file is slimmed and the saving is measured', () => {
  const result = slimReadText(readResult, options);
  const stats = result.stats;
  console.log(
    `        dsh-tools/lib/index.js: ${stats.charsIn} -> ${stats.charsOut} chars, ` +
      `${stats.tokensIn} -> ${stats.tokensOut} tokens (${saved(stats)}), ` +
      `lines ${stats.linesIn} -> ${stats.linesOut}`,
  );
  assert.ok(stats.tokensOut <= stats.tokensIn, 'tokens must never go up');
  assert.equal(result.text.length, stats.charsOut);
});

test('a modest source file passes through untouched by default', () => {
  const small = asReadResult('C:/fixtures/small.ts', syntheticSource(60));
  const result = slimReadText(small, options);
  assert.equal(result.stats.omittedLines, 0, 'a small file must not be bounded');
});

test('a very large source file is bounded by default and stays recoverable', () => {
  const big = asReadResult('C:/tmp/big.txt', Array.from({ length: 9000 }, (_, index) => `const v${index} = ${index};`).join('\n'));
  const result = slimReadText(big, options);
  const marker = /⟪\[\.\.\. (\d+) lines, (\d+) tokens omitted — lines (\d+)-(\d+)\. re-read with offset=(\d+) to restore/.exec(result.text);
  assert.ok(marker !== null, 'expected a bounded body with a recovery marker');
  const [, count, , first, last, resume] = marker;
  assert.equal(Number(count), Number(last) - Number(first) + 1, 'the count must match the stated range');
  assert.equal(Number(resume), Number(first), 'the resume offset must be the first omitted line');
  assert.ok(result.stats.omittedLines > 0);
  console.log(
    `        9000-line file: ${result.stats.tokensIn} -> ${result.stats.tokensOut} tokens ` +
      `(${saved(result.stats)}), ${result.stats.omittedLines} lines omitted and recoverable`,
  );
});

test('a passive result is bounded at the lower ceiling than a read', () => {
  const body = Array.from({ length: 3000 }, (_, index) => `row ${index} ${'p'.repeat(30)}`).join('\n');
  const passive = slimGenericText(body, options);
  const active = slimReadText(asReadResult('C:/tmp/x.txt', body), options);
  assert.ok(passive.stats.omittedLines > 0, 'a long shell result should be bounded');
  assert.ok(
    active.stats.omittedLines < passive.stats.omittedLines,
    `read must be bounded less aggressively (${active.stats.omittedLines} vs ${passive.stats.omittedLines})`,
  );
});

test('bounding can be switched off entirely', () => {
  const unbounded = resolveOptions({ maxResultTokens: 0, readMaxResultTokens: 0 });
  const big = asReadResult('C:/tmp/big.txt', Array.from({ length: 9000 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(slimReadText(big, unbounded).stats.omittedLines, 0);
  assert.equal(slimGenericText('x\n'.repeat(9000), unbounded).stats.omittedLines, 0);
});

test('an unsplittable payload makes the result ineligible for bounding', () => {
  // Mirrors the real case this guard exists for: a GitHub API response whose
  // body is one 18 KB base64 line. Bounding it would strip the payload and
  // leave the model with a four-line header it cannot act on.
  const payload = `{"name":"x.py","encoding":"base64","content":"${'QUJDREVG'.repeat(2400)}"}`;
  const response = [
    'Fetched https://api.example.test/contents/x.py (HTTP 200)',
    '',
    'External web content follows.',
    '',
    payload,
  ].join('\n');
  const result = slimGenericText(response, options);
  assert.equal(result.stats.omittedLines, 0, 'a payload-bearing result must not be bounded');
  assert.ok(result.text.includes(payload), 'the payload must survive verbatim');
});

test('a payload split across many short lines is still bounded', () => {
  // Same total size, no single long line: this is the case bounding is for.
  const rows = Array.from({ length: 4000 }, (_, index) => `2026-05-01T00:00:00Z INFO shard=${index} ok`);
  const result = slimGenericText(rows.join('\n'), options);
  assert.ok(result.stats.omittedLines > 0, 'a long multi-line log should still be bounded');
  assert.ok(result.text.includes('slimmed v1'), result.text.slice(0, 200));
});

test('slimming is deterministic: the same input yields the same output', () => {
  const first = slimReadText(readResult, options);
  const second = slimReadText(readResult, options);
  assert.equal(first.text, second.text, 'a pure kernel must be reproducible');
});

test('the marker is an announcement, not a receipt', () => {
  // The kernel used to treat its own marker as proof of prior work, which made
  // the text the source of truth: any payload containing that string was
  // exempted from bounding. It no longer does. "Already processed" is a fact
  // about a caller's state, not about the bytes, and determinism — not a
  // receipt — is what makes a repeated call safe.
  const once = slimReadText(readResult, options);
  assert.ok(once.text.includes('slimmed v1'), 'a bounded payload announces itself');
  const twice = slimReadText(once.text, options);
  assert.notEqual(twice.text, once.text, 'a second pass must not be skipped on the marker alone');
});

test('a payload quoting the marker in ordinary text is still bounded', () => {
  const decoy = `the string (slimmed v1) appears here as prose, not as a receipt`;
  const rows = Array.from({ length: 2000 }, (_, i) => `row ${i} ${'p'.repeat(30)}`);
  const payload = asReadResult('C:/tmp/decoy.txt', [decoy, ...rows].join('\n'));
  const result = slimReadText(payload, resolveOptions({ readMaxResultTokens: 1000 }));
  assert.ok(result.stats.omittedLines > 0, 'the marker in plain content must not exempt the payload');
});

console.log('\n=== 3. Line-level rules on crafted input ===\n');

test('CRLF line endings are dropped for log output only', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `2026-05-01T10:00:${String(i).padStart(2, '0')}Z INFO line ${i}`);
  const result = slimPassive(`${rows.join('\r\n')}\r\n`, 'pwsh', logReductionOptions);
  assert.ok(result !== null, 'a log payload should be transformed');
  assert.equal(result.blocks[0].text.includes('\r'), false, 'log output may drop carriage returns');
  assert.equal(result.stats.carriageReturnsDropped, rows.length);
});

test('CRLF is preserved for non-log output', () => {
  const input = 'const a = 1;\r\nconst b = 2;\r\n';
  const result = slimGenericText(input, options);
  assert.equal(result.text, input, 'code must keep its line endings');
});

test('trailing whitespace is dropped for log output only', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `2026-05-01T10:00:${String(i).padStart(2, '0')}Z INFO line ${i}   `);
  const result = slimPassive(`${rows.join('\n')}\n`, 'pwsh', logReductionOptions);
  assert.ok(result !== null);
  assert.equal(result.blocks[0].text.includes('   \n'), false, 'log lines may lose their padding');
});

test('trailing whitespace survives for non-log output', () => {
  const input = 'const a = 1;   \nconst b = 2;\t\t\n';
  const result = slimGenericText(input, options);
  assert.equal(result.text, input, 'code must keep its trailing whitespace');
});

test('long runs of identical log lines fold to one line plus a count', () => {
  const line = '2026-01-01 00:00:00 WARN cache miss for shard-0000000000000000000';
  const input = Array.from({ length: 40 }, () => line).join('\n');
  const result = slimPassive(input, 'pwsh', logReductionOptions);
  assert.ok(result !== null, 'a log payload should be transformed');
  assert.ok(result.blocks[0].text.includes('⟪×40 identical lines⟫'), result.blocks[0].text.slice(0, 200));
  assert.equal(result.stats.identicalLinesFolded, 39);
  assert.ok(result.stats.tokensOut * 10 < result.stats.tokensIn, 'expected >10x reduction');
});

test('identical source lines are never folded', () => {
  const line = 'const repeated = computeSomethingExpensive(withArguments);';
  const input = Array.from({ length: 40 }, () => line).join('\n');
  const result = slimGenericText(input, options);
  assert.equal(result.text, input, 'code must not be folded');
  assert.equal(result.stats.identicalLinesFolded, 0);
});

test('short repeated lines such as closing braces are never folded', () => {
  const input = 'if (a) {\n}\n}\n}\n}\n}\n}\n';
  const result = slimGenericText(input, options);
  assert.equal(result.text, input);
  assert.equal(result.stats.identicalLinesFolded, 0);
});

test('blank-line runs collapse for log output only', () => {
  // Content detection needs at least five non-blank lines before it calls
  // something a log, so the sample carries enough real entries around the gap.
  const before = Array.from({ length: 5 }, (_, i) => `2026-05-01T10:00:0${i}Z INFO before ${i}`);
  const after = Array.from({ length: 5 }, (_, i) => `2026-05-01T10:00:1${i}Z INFO after ${i}`);
  const input = `${before.join('\n')}\n${'\n'.repeat(30)}${after.join('\n')}\n`;
  const result = slimPassive(input);
  assert.ok(result !== null, 'a log payload should be transformed');
  assert.ok(result.blocks[0].text.includes('⟪+28 blank lines⟫'), result.blocks[0].text);
  assert.equal(result.stats.blankLinesFolded, 28);
});

test('blank-line runs survive in source', () => {
  const input = `function a() {\n${'\n'.repeat(6)}  return 1;\n}\n`;
  const result = slimGenericText(input, options);
  assert.equal(result.text, input, 'source keeps its blank lines');
});

test('over-long single lines are truncated with an in-band marker when enabled', () => {
  const truncating = resolveOptions({ genericMaxLineChars: 400 });
  // Prose, not one unbroken run: a dense line reads as a payload and is now
  // exempted from truncation on purpose (see the density rule). Cutting text
  // that has spaces in it is the case this setting exists for.
  const input = `prefix\n${'alpha beta gamma delta '.repeat(300)}\nsuffix\n`;
  const result = slimGenericText(input, truncating);
  assert.ok(result.text.includes('\u22ee\u27ea[...'), 'expected a truncation marker');
  assert.match(result.text, /chars omitted .*slimmed v1/, 'the marker names its version');
  const long = result.text.split('\n')[1];
  assert.ok(long.length < 500, `line still ${long.length} chars`);
  assert.equal(result.stats.linesTruncated, 1);
  assert.equal(result.stats.payloadLinesPreserved, 0);
});

test('over-long lines are left intact by default (payloads survive)', () => {
  const payload = `{"content":"${'QUJD'.repeat(1200)}"}`;
  const input = `Fetched https://example.test/x (HTTP 200)\n\n${payload}\n`;
  const result = slimGenericText(input, options);
  assert.equal(result.stats.linesTruncated, 0);
  assert.ok(result.text.includes(payload), 'the payload must survive verbatim');
});

test('template folding merges log lines that differ only in volatile fields', () => {
  const aggressive = resolveOptions({ foldTemplatedLines: true, foldRepeatedLines: true });
  const input = Array.from(
    { length: 12 },
    (_, index) =>
      `[2026-04-2${index % 9}T10:11:12.345Z] req=550e8400-e29b-41d4-a716-44665544000${index % 9} status=ok`,
  ).join('\n');
  const result = slimGenericText(input, aggressive);
  assert.ok(result.text.includes('identical-pattern lines'), result.text);
  assert.ok(result.stats.templatedLinesFolded >= 9, String(result.stats.templatedLinesFolded));
  console.log(
    `        12 volatile log lines: ${result.stats.tokensIn} -> ${result.stats.tokensOut} tokens (${saved(result.stats)})`,
  );
});

console.log('\n=== 4. Token bound and recoverability ===\n');

test('importance scoring keeps error lines that a head/tail policy would drop', () => {
  // The failure sits at line ~600 of 1200: outside any head or tail window a
  // positional policy would keep.
  const lines = [];
  for (let index = 0; index < 1200; index++) {
    lines.push(index === 600 ? 'ERROR: connection refused by upstream shard 7' : `2026-05-01T00:00:00Z INFO step ${index} completed normally`);
  }
  const payload = asReadResult('C:/tmp/log.txt', lines.join('\n'));
  const result = slimReadText(payload, resolveOptions({ readMaxResultTokens: 2000 }));
  assert.ok(result.stats.omittedLines > 0, 'expected the payload to be bounded');
  assert.ok(
    result.text.includes('ERROR: connection refused by upstream shard 7'),
    'the single error line must survive bounding',
  );
});

test('importance scoring keeps numeric outliers', () => {
  const lines = [];
  for (let index = 0; index < 600; index++) {
    lines.push(`request ${index} latency_ms=100`);
  }
  lines.splice(300, 0, 'request 300 latency_ms=99999');
  const result = slimGenericText(lines.join('\n'), resolveOptions({ maxResultTokens: 1500 }));
  assert.ok(result.stats.omittedLines > 0, 'expected the payload to be bounded');
  assert.ok(result.text.includes('99999'), 'the numeric outlier must survive bounding');
});

test('every omitted run is announced, even a single line', () => {
  const lines = [];
  for (let index = 0; index < 900; index++) lines.push(`row ${index} payload ${'q'.repeat(40)}`);
  const payload = asReadResult('C:/tmp/x.txt', lines.join('\n'));
  const result = slimReadText(payload, resolveOptions({ readMaxResultTokens: 1200 }));
  const kept = result.text.split('\n').filter((row) => /^\d+:/.test(row)).length;
  const announced = [...result.text.matchAll(/\u27ea[^\u27eb]*\u27eb/g)].length;
  assert.ok(announced > 0, 'expected omission markers');
  assert.ok(kept < lines.length, 'expected lines to be dropped');
});

test('an over-budget read omits the middle and names the exact line range', () => {
  const many = Array.from({ length: 20000 }, (_, index) => `line ${index + 1} payload ${'z'.repeat(20)}`).join('\n');
  const huge = asReadResult('C:/tmp/huge.txt', many);
  const result = slimReadText(huge, resolveOptions({ readMaxResultTokens: 4000 }));
  const match =
    /⟪\[\.\.\. (\d+) lines, (\d+) tokens omitted — lines (\d+)-(\d+)\. re-read with offset=(\d+) to restore/.exec(result.text);
  assert.ok(match !== null, 'expected an omission marker naming the range');
  const [, count, , first, last, resume] = match;
  assert.equal(Number(count), Number(last) - Number(first) + 1, 'count must match the stated range');
  assert.equal(Number(resume), Number(first), 'the resume offset must be the first omitted line');
  assert.ok(result.stats.tokensOut < 4200, `body should respect the budget, got ${result.stats.tokensOut}`);
  console.log(
    `        20000-line file: ${result.stats.tokensIn} -> ${result.stats.tokensOut} tokens ` +
      `(${saved(result.stats)}), ${result.stats.omittedLines} lines omitted and recoverable`,
  );
});

test('a read under budget is never omitted', () => {
  const small = asReadResult('C:/tmp/small.txt', 'a\nb\nc');
  const result = slimReadText(small, options);
  assert.equal(result.stats.omittedLines, 0);
});

console.log('\n=== 5. No-change discipline ===\n');

test('clean input produces no replacement at all', () => {
  const clean = asReadResult('C:/tmp/clean.txt', 'const a = 1;\nconst b = 2;');
  const result = slimReadText(clean, options);
  assert.equal(result.changed, false, 'clean input must not be rewritten');
});

test('slimContent returns null when nothing would shrink', () => {
  const blocks = [{ type: 'text', text: 'short and already minimal' }];
  assert.equal(slimContent(blocks, 'pwsh', options), null);
});

test('slimContent never touches non-text blocks', () => {
  const log = Array.from({ length: 400 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} processed ok`).join('\n');
  const image = { type: 'image', attachment: { attachmentId: 'x' } };
  const result = slimContent([{ type: 'text', text: log }, image], 'read_image', options);
  assert.ok(result !== null);
  assert.equal(result.blocks[1], image, 'image block must pass through by identity');
});

test('a non-text-only result is left alone', () => {
  const image = { type: 'image', attachment: { attachmentId: 'x' } };
  assert.equal(slimContent([image], 'read_image', options), null);
});

test('disabled plugin is a strict no-op', () => {
  const off = resolveOptions({ enabled: false });
  assert.equal(slimContent([{ type: 'text', text: 'a\r\nb\r\n' }], 'pwsh', off), null);
});

console.log('\n=== 6. Call identity and the repeat escape hatch ===\n');

test('canonicalArgs collapses key order so equal calls share one identity', () => {
  const a = canonicalArgs({ file_path: 'x.ts', offset: 1 });
  const b = canonicalArgs({ offset: 1, file_path: 'x.ts' });
  assert.equal(a, b, 'property order must not change identity');
  assert.notEqual(canonicalArgs({ a: 1 }), canonicalArgs({ a: 2 }));
});

test('canonicalArgs tolerates the loop\'s raw-string fallback', () => {
  assert.equal(canonicalArgs('{not json'), '{not json');
  assert.equal(canonicalArgs({ a: [1, { b: 2 }] }), canonicalArgs({ a: [1, { b: 2 }] }));
});

test('fullText bypasses every transform, so a repeat gets the original back', () => {
  const log = Array.from({ length: 400 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} processed ok`).join('\n');
  const blocks = [{ type: 'text', text: log }];
  assert.notEqual(slimContent(blocks, 'pwsh', options), null, 'first call is slimmed');
  assert.equal(slimContent(blocks, 'pwsh', options, true), null, 'a repeat must be returned untouched');
});

test('shortDigest is stable and distinguishes different inputs', () => {
  assert.equal(shortDigest('abc'), shortDigest('abc'));
  assert.notEqual(shortDigest('abc'), shortDigest('abd'));
  assert.equal(shortDigest('abc').length, 12);
});

console.log('\n=== 7. Option validation ===\n');

test('unknown options fail loudly', () => {
  assert.throws(() => resolveOptions({ nope: 1 }), /unknown option/);
});

test('the config split keeps plugin-owned keys out of the kernel', () => {
  const { kernel, plugin } = splitConfig({
    maxResultTokens: 4000,
    reasoning: { strategy: 'auto' },
    statsPath: 'C:/tmp/stats.json',
  });
  assert.equal(kernel.maxResultTokens, 4000);
  assert.equal(Object.hasOwn(kernel, 'reasoning'), false, 'kernel must never receive `reasoning`');
  assert.equal(Object.hasOwn(kernel, 'statsPath'), false, 'kernel must never receive `statsPath`');
  assert.deepEqual(plugin.reasoning, { strategy: 'auto' });
  assert.equal(plugin.statsPath, 'C:/tmp/stats.json');
});

test('the shipped config resolves end to end without throwing', () => {
  // Regression guard: activation failed on reload the first time a `reasoning`
  // block was added to the row, because the kernel validated the whole config.
  const shipped = {
    maxResultTokens: 2000,
    readMaxResultTokens: 5000,
    fullTextOnRepeat: true,
    reasoning: { strategy: 'auto', budgetTokens: 500, coldAfterMs: 300000, dryRun: false },
  };
  const { kernel, plugin } = splitConfig(shipped);
  assert.doesNotThrow(() => resolveOptions(kernel));
  assert.doesNotThrow(() => resolveReasoningOptions(plugin.reasoning));
});

test('bad numeric options fail loudly', () => {
  assert.throws(() => resolveOptions({ repeatedLineMinRun: 1 }), /at least 2/);
  assert.throws(() => resolveOptions({ maxResultTokens: -5 }), /non-negative integer/);
  assert.throws(() => resolveOptions({ headBudgetRatio: 2 }), /strictly between/);
});

test('bad reasoning options fail loudly', () => {
  assert.throws(() => resolveReasoningOptions({ strategy: 'sometimes' }), /must be one of/);
  assert.throws(() => resolveReasoningOptions({ nope: 1 }), /unknown reasoning option/);
  assert.throws(() => resolveReasoningOptions({ budgetTokens: -1 }), /non-negative integer/);
});

console.log('\n=== 7d. Scoring internals ===\n');

test('scoreLines marks error lines additive and scores them highest', () => {
  const lines = ['INFO all good', 'ERROR disk full', 'INFO still fine'];
  const { scores, additive } = scoreLines(lines, {});
  assert.ok(additive.has(1), 'the error line must be additive');
  assert.equal(additive.has(0), false);
  assert.ok(scores[1] > scores[0], 'the error line must outscore a plain line');
});

test('scoreLines flags numeric outliers as additive', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `latency=${100 + (i % 3)}`);
  lines.push('latency=999999');
  const { additive } = scoreLines(lines, {});
  assert.ok(additive.has(30), 'the outlier must be additive');
});

test('scoreLines applies a type boost only for recognised keys', () => {
  const lines = ['@@ -1,3 +1,4 @@', 'plain text here'];
  const boosted = scoreLines(lines, { boost: { hunk: 5000 } });
  const ignored = scoreLines(lines, { boost: { nonexistentKey: 5000 } });
  assert.ok(boosted.scores[0] > ignored.scores[0], 'a known boost key must raise the score');
  assert.deepEqual(ignored.scores, scoreLines(lines, {}).scores, 'an unknown key must be ignored');
});

test('every protected line survives even when protection exceeds the budget', () => {
  // The defect this guards: protection used to compete for budget like any
  // other candidate, so 40 error lines under a 100-token ceiling kept 7 of them
  // and silently dropped the rest. A bounded payload missing its errors is
  // worse than an unbounded one.
  const lines = Array.from({ length: 40 }, (_, i) => `ERROR failure number ${i} in subsystem alpha`);
  const selection = selectByImportance(lines, 100, { isRead: false }, resolveOptions({}));
  assert.equal(selection.keep.length, 40, 'all 40 protected lines must survive');
  assert.equal(selection.protectedLines, 40);
  assert.equal(selection.budgetExceeded, true, 'the overflow must be reported, not hidden');
  assert.ok(selection.overflowReason.includes('protected lines'), selection.overflowReason);
});

test('a single oversized protected line still survives', () => {
  const lines = [`ERROR ${'detail '.repeat(200)}`, ...Array.from({ length: 50 }, (_, i) => `filler ${i}`)];
  const selection = selectByImportance(lines, 20, { isRead: false }, resolveOptions({}));
  assert.ok(selection.keep.includes(0), 'the oversized error line must be kept');
  assert.equal(selection.budgetExceeded, true);
});

test('a numeric outlier survives a budget that cannot hold it', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `latency=${100 + (i % 3)}`);
  lines.push(`latency=${'9'.repeat(400)}`);
  const selection = selectByImportance(lines, 50, { isRead: false }, resolveOptions({}));
  assert.ok(selection.keep.includes(40), 'the anomaly must be kept');
  assert.equal(selection.budgetExceeded, true);
});

test('a value too large to represent poisons no column and is kept', () => {
  // A several-hundred-digit literal parses to Infinity. Left in the column it
  // makes the mean Infinity and the deviation NaN, which silently suppresses
  // every genuine anomaly in that column.
  const lines = Array.from({ length: 30 }, (_, i) => `bytes=${100 + (i % 5)}`);
  lines.push(`bytes=${'9'.repeat(400)}`);
  lines.push('bytes=999999');
  const selection = selectByImportance(lines, 40, { isRead: false }, resolveOptions({}));
  assert.ok(selection.keep.includes(30), 'the unrepresentable value must be kept');
  assert.ok(selection.keep.includes(31), 'the genuine outlier in the same column must still be detected');
});

test('selection returns indices in ascending order', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `row ${i} ${'p'.repeat(30)}`);
  const selection = selectByImportance(lines, 400, { isRead: false }, resolveOptions({}));
  const sorted = [...selection.keep].sort((a, b) => a - b);
  assert.deepEqual(selection.keep, sorted, 'kept indices must preserve original order');
  assert.ok(selection.tokens <= 400, `selection must respect the budget, used ${selection.tokens}`);
});

test('a kept long line does not block bounding of the rest', () => {
  // The guard exists to stop half-payloads. A long line the selection keeps is
  // not a half-payload, so it must not veto the whole compression.
  const lines = [`CONFIG=${'x'.repeat(5000)}`];
  for (let index = 0; index < 3000; index++) lines.push(`row ${index} ${'p'.repeat(30)}`);
  const payload = asReadResult('C:/tmp/mixed.txt', lines.join('\n'));
  const result = slimReadText(payload, resolveOptions({ readMaxResultTokens: 2000 }));
  assert.ok(result.stats.omittedLines > 0, 'the multi-line tail must still be bounded');
});

console.log('\n=== 7c. Content type and intent policy ===\n');

test('content type detection separates the shapes it claims to', () => {
  assert.equal(detectContentType('@@ -1,4 +1,6 @@\n context\n+added\n'), 'diff');
  assert.equal(detectContentType('diff --git a/x b/x\nindex 1..2\n'), 'diff');
  assert.equal(detectContentType('src/app.ts:42:const x = 1;\nsrc/lib.ts:9:export default'), 'search');
  assert.equal(detectContentType('{"items":[1,2,3]}'), 'json');
  assert.equal(detectContentType('[{"a":1},{"a":2}]'), 'json');
  const log = Array.from({ length: 20 }, (_, i) => `2026-05-01T10:00:0${i % 10}Z INFO step ${i}`);
  assert.equal(detectContentType(log.join('\n')), 'log');
  const code = 'import { a } from "b";\n\nexport function run() {\n  return a;\n}\n';
  assert.equal(detectContentType(code), 'code');
  assert.equal(detectContentType('a|b|c\n1|2|3\n4|5|6\n7|8|9\n'), 'table');
  assert.equal(detectContentType('just some ordinary prose about nothing in particular'), 'text');
});

test('malformed or truncated JSON is still recognised as JSON-shaped', () => {
  assert.equal(detectContentType('{"a":1,"b":'), 'json');
});

test('analysis intent is detected in both languages', () => {
  assert.ok(hasAnalysisIntent('分析一下这个日志'));
  assert.ok(hasAnalysisIntent('帮我看看为什么失败'));
  assert.ok(hasAnalysisIntent('please debug this test failure'));
  assert.ok(hasAnalysisIntent('Can you explain what this traceback means?'));
  assert.equal(hasAnalysisIntent('把文件复制到 tmp 目录'), false);
  assert.equal(hasAnalysisIntent(''), false);
});

test('resolvePolicy scales the budget by content type and intent', () => {
  const plain = resolvePolicy({ contentType: 'text', analysisIntent: false, baseBudget: 4000 });
  assert.equal(plain.budget, 4000);
  const code = resolvePolicy({ contentType: 'code', analysisIntent: false, baseBudget: 4000 });
  assert.ok(code.budget > 4000, 'code should be given room to keep structure');
  const log = resolvePolicy({ contentType: 'log', analysisIntent: false, baseBudget: 4000 });
  assert.ok(log.budget < 4000, 'logs compress well and should be bounded tighter');
  const analysed = resolvePolicy({ contentType: 'log', analysisIntent: true, baseBudget: 4000 });
  assert.equal(analysed.budget, log.budget * 2, 'analysis intent doubles the budget');
});

test('looking at the same prose, analysis intent keeps strictly more', () => {
  const rows = Array.from({ length: 1500 }, (_, i) => `2026-05-01T00:00:00Z INFO shard=${i} processed ok`);
  const payload = rows.join('\n');
  const calm = slimContent([{ type: 'text', text: payload }], 'pwsh', options, false, { analysisIntent: false });
  const intent = slimContent([{ type: 'text', text: payload }], 'pwsh', options, false, { analysisIntent: true });
  assert.ok(calm !== null && intent !== null);
  assert.ok(
    intent.stats.tokensOut > calm.stats.tokensOut,
    `analysis intent must keep more (${intent.stats.tokensOut} vs ${calm.stats.tokensOut})`,
  );
  assert.equal(calm.stats.contentTypes[0], 'log');
});

test('a diff keeps its hunk headers under bounding', () => {
  const lines = [];
  for (let hunk = 0; hunk < 60; hunk++) {
    lines.push(`@@ -${hunk * 10},7 +${hunk * 10},8 @@ function part${hunk}()`);
    for (let row = 0; row < 12; row++) lines.push(` context line ${hunk}:${row} ${'c'.repeat(30)}`);
    lines.push(`+added line for hunk ${hunk} ${'a'.repeat(30)}`);
  }
  const result = slimContent([{ type: 'text', text: lines.join('\n') }], 'pwsh', options);
  assert.ok(result !== null);
  assert.equal(result.stats.contentTypes[0], 'diff');
  const keptHunks = [...result.blocks[0].text.matchAll(/^@@ -\d+/gm)].length;
  assert.ok(keptHunks > 0, 'at least some hunk headers must survive');
  assert.ok(result.stats.omittedLines > 0, 'the payload should still be bounded');
});

console.log('\n=== 7b. Reasoning surface ===\n');

test('a long reasoning blob is bounded at paragraph boundaries', () => {
  const blob = Array.from({ length: 40 }, (_, index) => `第 ${index} 段推理内容，描述当前问题的分析过程。`).join('\n\n');
  const bounded = boundReasoningText(blob, 200, 0.55);
  assert.ok(bounded !== null, 'expected a bounded replacement');
  assert.ok(bounded.includes('elided by token-slimmer'));
  assert.ok(estimateTokens(bounded) < 260, `expected a bounded result, got ${estimateTokens(bounded)}`);
  assert.ok(bounded.startsWith('第 0 段'), 'the opening must survive');
  assert.ok(bounded.endsWith('。'), 'the closing must survive');
});

test('reasoning already within budget is left alone', () => {
  assert.equal(boundReasoningText('短推理。', 500, 0.55), null);
});

test('bounding reasoning preserves text and tool-call blocks by identity', () => {
  const text = { type: 'text', text: 'answer' };
  const call = { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' };
  const content = [{ type: 'reasoning', text: '想。'.repeat(400) }, text, call];
  const result = boundReasoningContent(content, resolveReasoningOptions({ budgetTokens: 100 }));
  assert.ok(result !== null);
  assert.equal(result.content[0].type, 'reasoning');
  assert.equal(result.content[1], text, 'text block must pass through by identity');
  assert.equal(result.content[2], call, 'tool-call block must pass through by identity');
});

test('planReasoningPass picks exactly what each strategy claims', () => {
  const targets = [
    { index: 0, seq: 10, overBudget: true },
    { index: 1, seq: 11, overBudget: true },
    { index: 2, seq: 12, overBudget: true },
  ];
  // Everything is unsent here: the strategies are being compared on their own
  // terms, with the sent/unsent split held constant and permissive.
  const allUnsent = new Set([10, 11, 12]);
  assert.equal(planReasoningPass(targets, 'never', true, allUnsent).length, 0);
  assert.equal(planReasoningPass(targets, 'newest', false, allUnsent).length, 1);
  assert.equal(planReasoningPass(targets, 'newest', true, allUnsent).length, 1);
  assert.equal(planReasoningPass(targets, 'cold', false, allUnsent).length, 0, 'cold must not run warm');
  assert.equal(planReasoningPass(targets, 'cold', true, allUnsent).length, 3);
  assert.equal(planReasoningPass(targets, 'all', false, allUnsent).length, 3);
  assert.equal(planReasoningPass(targets, 'auto', false, allUnsent).length, 1, 'auto bounds the newest every step');
  assert.equal(planReasoningPass(targets, 'auto', true, allUnsent).length, 3, 'auto sweeps the rest when cold');

  // With no unsent set, a writing strategy selects nothing: no write is provably
  // free, and the pass no longer makes a bet that it is.
  for (const strategy of ['newest', 'all', 'auto']) {
    assert.deepEqual(
      planReasoningPass(targets, strategy, false),
      [],
      `${strategy} must not write when nothing is provably unsent`,
    );
  }
  // A cold window is the one condition under which sent content is fair game.
  assert.equal(planReasoningPass(targets, 'cold', true).length, 3);
});

test('a writing strategy only touches messages the request has not sent', () => {
  // The rule this enforces: bounding an unsent message is free, bounding a sent
  // one re-bills the suffix from the change point at the miss rate. Measured,
  // that costs about ten times what the removal saves, so the candidate set is
  // split by that fact rather than by position.
  const targets = [
    { index: 0, seq: 10, overBudget: true },
    { index: 1, seq: 11, overBudget: true },
    { index: 2, seq: 12, overBudget: true },
  ];
  const newestUnsent = new Set([12]);

  assert.deepEqual(
    planReasoningPass(targets, 'newest', false, newestUnsent).map((t) => t.seq),
    [12],
    'newest takes the newest unsent message',
  );
  assert.deepEqual(
    planReasoningPass(targets, 'all', false, newestUnsent).map((t) => t.seq),
    [12],
    'all means every unsent message, not every message',
  );
  assert.deepEqual(
    planReasoningPass(targets, 'newest', false, new Set()).map((t) => t.seq),
    [],
    'with nothing unsent there is nothing free to write',
  );
  // The cold path is deliberately exempt: a lapsed cache is what makes a sent
  // message cheap again, which is the only reason that path exists.
  assert.equal(planReasoningPass(targets, 'cold', true, new Set()).length, 3);
});

test('newest never reaches back to an older message when the newest fits', () => {
  // The defect this guards: `newest` used to mean "the last over-budget target",
  // so a short latest reply let it select an older, long message that had
  // already been carried by a request — invalidating a warm prefix, which is
  // the one cost the strategy exists to avoid.
  const targets = [
    { index: 0, seq: 10, overBudget: true },
    { index: 1, seq: 11, overBudget: true },
    { index: 2, seq: 12, overBudget: false },
  ];
  const allUnsent = new Set([10, 11, 12]);
  for (const strategy of ['newest', 'auto']) {
    assert.deepEqual(
      planReasoningPass(targets, strategy, false, allUnsent),
      [],
      `${strategy} must select nothing when the newest message fits`,
    );
  }
  assert.equal(
    planReasoningPass(targets, 'all', false, allUnsent).length,
    2,
    'all still reaches the over-budget ones',
  );
  assert.equal(planReasoningPass(targets, 'cold', true, allUnsent).length, 2, 'cold sweeps them only in a cold window');
});

test('planReasoningPass returns nothing for an empty surface', () => {
  for (const strategy of ['never', 'newest', 'cold', 'all', 'auto']) {
    assert.deepEqual(planReasoningPass([], strategy, true), []);
  }
});

console.log('\n=== 8. Performance on a worst-case corpus ===\n');

test('a 1 MB read result slims in well under a second', () => {
  const oneMb = Array.from({ length: 16000 }, (_, index) => `${index}: value = ${index} ${'q'.repeat(50)}`).join('\n');
  const payload = asReadResult('C:/tmp/megabyte.txt', oneMb);
  const started = process.hrtime.bigint();
  const result = slimReadText(payload, resolveOptions({ readMaxResultTokens: 10000 }));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    `        ${(payload.length / 1024).toFixed(0)} KB -> ${(result.text.length / 1024).toFixed(0)} KB, ` +
      `${result.stats.tokensIn} -> ${result.stats.tokensOut} tokens (${saved(result.stats)}) in ${elapsedMs.toFixed(1)} ms`,
  );
  assert.ok(elapsedMs < 1000, `took ${elapsedMs.toFixed(1)} ms`);
});

console.log('\n=== 9. Aggregate corpus measurement ===\n');

// Synthetic by default so the suite runs anywhere. Point DSH_SOURCE_ROOT at a
// real checkout to measure actual code instead — the numbers differ, and the
// synthetic ones say nothing about any particular repository.
const sourceRoot = process.env.DSH_SOURCE_ROOT ?? null;
const syntheticCorpus = [
  ['synthetic module (large)', syntheticSource(3700)],
  ['synthetic module (medium)', syntheticSource(1200)],
  ['synthetic log', syntheticLog(2500, { errorCount: 4 })],
  ['synthetic json', syntheticJson(200)],
];
const corpus = [];
if (sourceRoot === null) {
  for (const [label, text] of syntheticCorpus) corpus.push({ label, text });
  console.log('  (synthetic fixtures — set DSH_SOURCE_ROOT to measure real sources)');
} else {
  for (const relative of [
    'dsh-tools/lib/index.js',
    'dsh-tool-fs/lib/index.js',
    'dsh-agent-loop/lib/index.js',
    'dsh-client-ui-chat/lib/index.js',
  ]) {
    const absolute = join(sourceRoot, relative);
    try {
      corpus.push({ label: relative, text: readFileSync(absolute, 'utf8') });
    } catch {
      /* skip a source the checkout does not have */
    }
  }
  if (corpus.length === 0) {
    console.log(`  (DSH_SOURCE_ROOT=${sourceRoot} held no known sources; skipped)`);
  }
}

let totalIn = 0;
let totalOut = 0;
for (const entry of corpus) {
  const result = slimReadText(asReadResult(`C:/fixtures/${entry.label}`, entry.text), options);
  totalIn += result.stats.tokensIn;
  totalOut += result.stats.tokensOut;
  console.log(
    `  ${entry.label.padEnd(34)} ${String(result.stats.tokensIn).padStart(7)} -> ` +
      `${String(result.stats.tokensOut).padStart(7)} tokens  ${saved(result.stats).padStart(6)}`,
  );
}
const corpusSaved = ((totalIn - totalOut) / totalIn) * 100;
console.log(
  `  ${'TOTAL'.padEnd(34)} ${String(totalIn).padStart(7)} -> ${String(totalOut).padStart(7)} tokens  ` +
    `${corpusSaved.toFixed(1)}%`,
);

console.log(`\n${cases - failures}/${cases} passed\n`);
if (failures > 0) process.exitCode = 1;
