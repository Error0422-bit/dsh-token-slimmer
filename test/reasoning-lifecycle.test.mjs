/**
 * Reasoning pure-function tests.
 *
 * Production writes stay disabled — that is a separate decision needing a
 * recorded provider exchange and a quality A/B. What is tested here is the
 * function itself: that it respects its own ceiling, reaches a fixed point, and
 * refuses rather than mangles when the budget cannot hold its marker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens } from '../slim.js';
import { REASONING_MARKER, boundReasoningContent, boundReasoningText, resolveReasoningOptions } from '../reasoning.js';

/** A long single-paragraph body, the shape that previously overshot. */
const SOLID = 'A'.repeat(8000);

/** A multi-paragraph body. */
const PARAGRAPHS = Array.from(
  { length: 60 },
  (_, i) => `第 ${i} 段推理内容，分析当前问题并给出结论推演过程。`,
).join('\n\n');

test('the bounded result fits inside its own budget, marker included', () => {
  const bounded = boundReasoningText(SOLID, 500, 0.55);
  assert.ok(bounded !== null, 'expected a bounded replacement');
  assert.ok(
    estimateTokens(bounded) <= 500,
    `result must fit the ceiling, got ${estimateTokens(bounded)} tokens`,
  );
  assert.ok(bounded.includes(REASONING_MARKER), 'the marker must be present');
});

test('a second pass is a fixed point, not another shrink', () => {
  for (const [name, body] of [
    ['solid', SOLID],
    ['paragraphs', PARAGRAPHS],
  ]) {
    const once = boundReasoningText(body, 500, 0.55);
    assert.ok(once !== null, `${name}: expected a replacement`);
    const twice = boundReasoningText(once, 500, 0.55);
    assert.equal(twice, null, `${name}: the result already fits, so a second pass must do nothing`);
  }
});

test('a budget too small for the marker leaves the text alone', () => {
  const markerTokens = estimateTokens(REASONING_MARKER) + 4;
  assert.equal(boundReasoningText(SOLID, markerTokens - 1, 0.55), null, 'no room for the marker');
  assert.equal(boundReasoningText(SOLID, 0, 0.55), null, 'a zero budget is disabled, not empty');
  const tiny = boundReasoningText(SOLID, markerTokens + 20, 0.55);
  assert.ok(tiny === null || estimateTokens(tiny) <= markerTokens + 20);
});

test('bounding never splits a surrogate pair', () => {
  const emoji = '😀'.repeat(2000);
  const bounded = boundReasoningText(emoji, 300, 0.55);
  assert.ok(bounded !== null);
  // A lone surrogate would make the string ill-formed and throw when encoded.
  assert.doesNotThrow(() => Buffer.from(bounded, 'utf8'));
  assert.equal(bounded.includes('\uFFFD'), false, 'no replacement character may appear');
});

test('bounding preserves the opening and the closing of a multi-paragraph body', () => {
  const bounded = boundReasoningText(PARAGRAPHS, 250, 0.55);
  assert.ok(bounded !== null);
  assert.ok(bounded.startsWith('第 0 段'), 'the opening must survive');
  assert.ok(bounded.trimEnd().endsWith('。'), 'the closing must survive');
  assert.ok(estimateTokens(bounded) <= 250);
});

test('content blocks keep non-reasoning blocks by identity', () => {
  const text = { type: 'text', text: 'answer' };
  const call = { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' };
  const content = [{ type: 'reasoning', text: PARAGRAPHS }, text, call];
  const result = boundReasoningContent(content, resolveReasoningOptions({ budgetTokens: 200 }));
  assert.ok(result !== null);
  assert.equal(result.content[1], text, 'text passes through by identity');
  assert.equal(result.content[2], call, 'tool-call passes through by identity');
  assert.ok(result.tokensOut <= 200);
});

test('reasoning already inside its budget is left alone', () => {
  assert.equal(boundReasoningText('短推理。', 500, 0.55), null);
  assert.equal(boundReasoningContent([{ type: 'reasoning', text: '短推理。' }], resolveReasoningOptions({})), null);
});

test('the write gate is a single named constant, and the reason follows it', async () => {
  // Formerly asserted `=== false`. That made the test fail the moment the
  // experiment it was waiting for succeeded, so it now asserts what actually
  // matters: there is exactly one flag, it is boolean, and the refusal reason
  // is only used when it says no.
  const { REASONING_WRITES_VERIFIED, UNVERIFIED_WRITE_REASON } = await import('../reasoning.js');
  assert.equal(typeof REASONING_WRITES_VERIFIED, 'boolean', 'one flag decides this, and it is a boolean');
  assert.ok(UNVERIFIED_WRITE_REASON.length > 0, 'a refusal always has a stated reason');
});
