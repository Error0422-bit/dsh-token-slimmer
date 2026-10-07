/**
 * Fidelity tests.
 *
 * The contract these defend: if the model reads something, it reads what was
 * actually there. The first release stripped trailing whitespace and folded
 * repeated lines from every payload regardless of shape, which rewrote string
 * literals — a Python triple-quoted block lost the spaces that were its
 * content, a Markdown hard break collapsed into an ordinary newline. A model
 * that reads altered content and writes it back produces a confident wrong
 * edit, which is the worst failure this plugin can cause.
 *
 * Reductions are now opt-in per content shape: only `log` output may receive
 * them, and only while enabled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectContentType, resolveTransforms } from '../policy.js';
import { resolveOptions, slimContent, slimGenericText, slimReadText } from '../slim.js';
import { asReadResult } from './fixtures/source-samples.mjs';

const options = resolveOptions({});

/** Every payload here must survive `slimReadText` byte-for-byte. */
const FAITHFUL_SAMPLES = [
  ['template literal with trailing spaces', 'const value = `first  \nsecond`;'],
  ['markdown hard break', 'line one  \nline two\n'],
  ['python triple-quoted block', 's = """\nvalue with two spaces  \n  and indentation\n"""\n'],
  ['makefile tab indentation', 'build:\n\techo compiling\n\t@echo done\n'],
  ['crlf line endings', 'alpha\r\nbeta\r\ngamma\r\n'],
  ['trailing blank lines', 'alpha\nbeta\n\n\n\n'],
  ['json with repeated elements', JSON.stringify([{ a: 1 }, { a: 1 }, { a: 1 }], null, 2)],
  ['integer beyond safe range', '{"id": 9007199254740993, "next": 9007199254740995}'],
  ['one very long line', `config=${'x'.repeat(3000)}`],
];

for (const [name, body] of FAITHFUL_SAMPLES) {
  test(`read output is byte-faithful: ${name}`, () => {
    const payload = asReadResult('C:/fixtures/sample.txt', body);
    const result = slimReadText(payload, options);
    assert.equal(result.text, payload, 'a read result within budget must not be altered at all');
    assert.equal(result.changed, false);
    assert.equal(result.stats.carriageReturnsDropped, 0);
    assert.equal(result.stats.trailingWhitespaceDropped, 0);
    assert.equal(result.stats.identicalLinesFolded, 0);
    assert.equal(result.stats.blankLinesFolded, 0);
  });
}

test('a 41-token read sample is returned untouched', () => {
  const body = 'const a = 1;\nconst b = 2;\nconst c = 3;';
  const payload = asReadResult('C:/fixtures/small.ts', body);
  assert.equal(slimReadText(payload, options).text, payload);
});

test('an over-budget read keeps its literals when it is split', () => {
  // The literal with meaningful trailing spaces sits in the middle, where a
  // positional policy would have dropped it and where the old normalizer would
  // have stripped it even if kept.
  const lines = [];
  for (let index = 0; index < 1500; index++) lines.push(`const filler${index} = ${index};`);
  lines.splice(750, 0, 'const sensitive = `keep  \nthese`;');
  const payload = asReadResult('C:/fixtures/mixed.ts', lines.join('\n'));
  const result = slimReadText(payload, resolveOptions({ readMaxResultTokens: 1200 }));
  assert.ok(result.stats.omittedLines > 0, 'the payload should be bounded');
  const sensitiveLine = result.text.split('\n').find((row) => row.includes('const sensitive'));
  assert.ok(sensitiveLine !== undefined, 'the surviving literal must keep its exact spacing');
});

test('non-log passive output is byte-faithful too', () => {
  for (const [name, body] of FAITHFUL_SAMPLES) {
    const result = slimGenericText(body, options);
    assert.equal(result.text, body, `${name} must survive passive handling`);
  }
});

test('log output still receives the log reductions when enabled', () => {
  const rows = Array.from({ length: 400 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} processed ok`);
  const payload = rows.join('\n');
  assert.equal(detectContentType(payload), 'log');
  const result = slimGenericText(payload, options);
  assert.ok(result.stats.identicalLinesFolded > 0 || result.stats.omittedLines > 0, 'a log should still compress');
});

test('log reductions can be turned off by configuration', () => {
  const rows = Array.from({ length: 20 }, () => '2026-05-01T10:00:00Z INFO identical line with padding here');
  const payload = rows.join('\n');
  const off = resolveOptions({ foldRepeatedLines: false, stripCarriageReturns: false, stripTrailingWhitespace: false });
  const result = slimGenericText(payload, off);
  assert.equal(result.stats.identicalLinesFolded, 0);
});

test('resolveTransforms is faithful unless the shape and config both allow it', () => {
  const cases = [
    ['read', 'log'],
    ['read', 'code'],
    ['pwsh', 'code'],
    ['pwsh', 'json'],
    ['pwsh', 'diff'],
    ['pwsh', 'table'],
    ['pwsh', 'text'],
  ];
  for (const [toolName, contentType] of cases) {
    const transforms = resolveTransforms({ toolName, contentType, options });
    assert.deepEqual(
      transforms,
      {
        stripCarriageReturns: false,
        stripTrailingWhitespace: false,
        foldRepeatedLines: false,
        foldBlankRuns: false,
      },
      `${toolName}/${contentType} must be byte-faithful`,
    );
  }
  const log = resolveTransforms({ toolName: 'pwsh', contentType: 'log', options });
  assert.equal(log.foldBlankRuns, true, 'logs keep blank-run collapsing');
});

test('the lower-level default is conservative, not permissive', () => {
  // A caller reaching slimGenericText without a policy must get fidelity, not
  // the old behaviour, or a future refactor silently reintroduces the damage.
  const text = 'value  \nnext\n';
  assert.equal(slimGenericText(text, options).text, text);
});

test('a bounded payload still reports what it removed', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => `row ${i} ${'p'.repeat(30)}`);
  const result = slimContent([{ type: 'text', text: rows.join('\n') }], 'pwsh', options);
  assert.ok(result !== null);
  assert.ok(result.stats.omittedLines > 0);
  assert.ok(result.blocks[0].text.includes('slimmed v1'), 'omissions must be announced in-band');
});
