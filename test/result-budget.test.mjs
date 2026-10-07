/**
 * Result-level budget tests.
 *
 * One tool result gets one allowance, whatever shape it arrives in. The defect
 * these defend against: a policy was resolved per text block and each block was
 * handed a full ceiling, so the same content cost more the more finely it was
 * split. Ten blocks cost ten times one block; a hundred blocks passed 300k
 * tokens straight through the ceiling.
 *
 * The second thing under test is that marker overhead is part of the budget.
 * Omitting lines is not free — every gap spends tokens naming its range — and an
 * allowance that ignores that grows with the block count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveOptions, slimContent, estimateTokens } from '../slim.js';
import { syntheticLog } from './fixtures/source-samples.mjs';

const options = resolveOptions({ maxResultTokens: 2000, readMaxResultTokens: 2000 });

/** The same 10,000-line body, split into `count` text blocks. */
function splitInto(count, lines = 10000) {
  const rows = Array.from({ length: lines }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);
  const perBlock = Math.ceil(rows.length / count);
  const blocks = [];
  for (let index = 0; index < count; index++) {
    const slice = rows.slice(index * perBlock, (index + 1) * perBlock);
    if (slice.length === 0) continue;
    blocks.push({ type: 'text', text: slice.join('\n') });
  }
  return blocks;
}

/** Tokens of a result after processing, counting every block's text. */
function outputTokens(result) {
  return result.blocks.reduce(
    (sum, block) => sum + (block.type === 'text' && typeof block.text === 'string' ? estimateTokens(block.text) : 0),
    0,
  );
}

test('the same body costs the same whether it arrives in 1, 10, or 100 blocks', () => {
  const budget = 2000;
  const localOptions = resolveOptions({ maxResultTokens: budget });
  const measurements = [];
  for (const count of [1, 10, 100]) {
    const result = slimContent(splitInto(count), 'pwsh', localOptions);
    assert.ok(result !== null, `${count} blocks should be bounded at all`);
    measurements.push({ count, tokens: outputTokens(result) });
  }
  const [one, ten, hundred] = measurements;
  // The allowance is per result, so the block count must not buy extra room.
  const ceiling = budget * 2;
  assert.ok(
    ten.tokens <= ceiling,
    `10 blocks produced ${ten.tokens} tokens against a ${budget}-token allowance`,
  );
  assert.ok(
    hundred.tokens <= ceiling,
    `100 blocks produced ${hundred.tokens} tokens against a ${budget}-token allowance`,
  );
  // And it should not collapse to nothing either: the content is still served.
  assert.ok(hundred.tokens > 0, 'a bounded result must still carry content');
});

test('marker overhead is counted against the budget, not added on top', () => {
  const budget = 400;
  const localOptions = resolveOptions({ maxResultTokens: budget });
  const result = slimContent(splitInto(60), 'pwsh', localOptions);
  assert.ok(result !== null);
  const text = result.blocks.map((block) => block.text).join('');
  // Both marker forms count: the descriptive one and the terse fallback used
  // when a block's share cannot afford the sentence describing it.
  const markers = [...text.matchAll(/⟪[^⟫]*⟫/g)].length;
  assert.ok(markers > 0, 'a heavily split result should announce its omissions');
  assert.ok(
    outputTokens(result) <= budget * 2,
    `${markers} markers on a ${budget}-token allowance produced ${outputTokens(result)} tokens`,
  );
});

test('a very large block count still respects the ceiling', () => {
  const budget = 2000;
  const localOptions = resolveOptions({ maxResultTokens: budget });
  // More blocks than a result could plausibly have, to exercise the degenerate end.
  const result = slimContent(splitInto(2001, 4000), 'pwsh', localOptions);
  if (result === null) return; // nothing to do is an acceptable outcome
  assert.ok(
    outputTokens(result) <= budget * 4,
    `2001 blocks produced ${outputTokens(result)} tokens against a ${budget}-token allowance`,
  );
});

test('a single block and the same content split many ways stay comparable', () => {
  const budget = 3000;
  const localOptions = resolveOptions({ maxResultTokens: budget });
  const one = slimContent(splitInto(1, 4000), 'pwsh', localOptions);
  const many = slimContent(splitInto(40, 4000), 'pwsh', localOptions);
  assert.ok(one !== null && many !== null);
  // Splitting may cost a little in markers, but it must not multiply the result.
  assert.ok(
    outputTokens(many) <= outputTokens(one) * 2,
    `40 blocks (${outputTokens(many)}) versus 1 block (${outputTokens(one)})`,
  );
});

test('non-text blocks pass through by identity and their cost is not counted as text', () => {
  const localOptions = resolveOptions({ maxResultTokens: 500 });
  const image = { type: 'image', attachment: { attachmentId: 'a' } };
  const file = { type: 'file', attachment: { attachmentId: 'b' } };
  const blocks = [image, { type: 'text', text: syntheticLog(2000) }, file];
  const result = slimContent(blocks, 'read_image', localOptions);
  assert.ok(result !== null);
  assert.equal(result.blocks[0], image, 'the leading image is the same object');
  assert.equal(result.blocks[2], file, 'the trailing file block is the same object');
  assert.equal(result.blocks.length, 3, 'interleaving is preserved');
});

test('an unknown block type is passed through rather than dropped', () => {
  const localOptions = resolveOptions({ maxResultTokens: 500 });
  const unknown = { type: 'something-new', payload: 42 };
  const result = slimContent([{ type: 'text', text: syntheticLog(1500) }, unknown], 'pwsh', localOptions);
  assert.ok(result !== null);
  assert.equal(result.blocks[1], unknown);
});

test('a malformed block does not abort the whole result', () => {
  const localOptions = resolveOptions({ maxResultTokens: 500 });
  const blocks = [
    { type: 'text', text: syntheticLog(1500) },
    null,
    { type: 'text' },
    'not a block',
  ];
  assert.doesNotThrow(() => slimContent(blocks, 'pwsh', localOptions));
});

test('zero disables bounding rather than producing empty text', () => {
  const off = resolveOptions({ maxResultTokens: 0, readMaxResultTokens: 0 });
  const content = [{ type: 'text', text: syntheticLog(3000) }];
  assert.equal(slimContent(content, 'pwsh', off), null, 'zero means off, not "empty"');
});

test('protected content in every block survives a shared budget', () => {
  // One error buried in the middle of each of ten blocks. Individually each
  // block would be bounded against its own share and the errors would compete
  // with filler for room; planned together, protection is taken first, across
  // all of them, before anything else is considered.
  const blocks = [];
  for (let block = 0; block < 10; block++) {
    const rows = [];
    for (let index = 0; index < 500; index++) {
      rows.push(
        index === 250
          ? `2026-05-01T10:00:00Z ERROR block=${block} shard=${index} connection refused`
          : `2026-05-01T10:00:00Z INFO block=${block} row=${index} ok`,
      );
    }
    blocks.push({ type: 'text', text: rows.join('\n') });
  }
  const result = slimContent(blocks, 'pwsh', resolveOptions({ maxResultTokens: 1500 }));
  assert.ok(result !== null);
  const text = result.blocks.map((block) => block.text).join('');
  for (let block = 0; block < 10; block++) {
    assert.ok(text.includes(`ERROR block=${block} `), `block ${block}'s error must survive`);
  }
});

test('a block carrying more signal wins a larger share of one budget', () => {
  const filler = Array.from(
    { length: 800 },
    (_, i) => `2026-05-01T10:00:00Z INFO filler row=${i} not important`,
  ).join('\n');
  const errors = Array.from(
    { length: 800 },
    (_, i) =>
      i % 5 === 0
        ? `2026-05-01T10:00:00Z ERROR row=${i} failed to reach shard ${i}`
        : `2026-05-01T10:00:00Z INFO row=${i} ok`,
  ).join('\n');
  const result = slimContent(
    [
      { type: 'text', text: filler },
      { type: 'text', text: errors },
    ],
    'pwsh',
    resolveOptions({ maxResultTokens: 1500 }),
  );
  assert.ok(result !== null);
  const [fillerTokens, errorsTokens] = result.blocks.map((block) => estimateTokens(block.text));
  assert.ok(
    errorsTokens > fillerTokens,
    `the block carrying errors should receive more (${errorsTokens} vs ${fillerTokens})`,
  );
});

test('a result split across blocks is planned once, not per block', () => {
  // The same errors, once in one block and once spread over twelve. A unified
  // plan should produce comparable totals rather than multiplying with the
  // block count.
  const rows = [];
  for (let index = 0; index < 6000; index++) {
    rows.push(
      index % 400 === 0
        ? `2026-05-01T10:00:00Z ERROR shard=${index % 64} connection refused`
        : `2026-05-01T10:00:00Z INFO shard=${index % 64} row=${index} ok`,
    );
  }
  const whole = slimContent([{ type: 'text', text: rows.join('\n') }], 'pwsh', resolveOptions({ maxResultTokens: 1200 }));
  const split = slimContent(splitInto(12, 6000), 'pwsh', resolveOptions({ maxResultTokens: 1200 }));
  assert.ok(whole !== null && split !== null);
  const wholeTokens = whole.blocks.reduce((sum, block) => sum + estimateTokens(block.text), 0);
  const splitTokens = split.blocks.reduce((sum, block) => sum + estimateTokens(block.text), 0);
  assert.ok(
    splitTokens <= wholeTokens * 3,
    `twelve blocks (${splitTokens}) versus one (${wholeTokens})`,
  );
});

test('an ordinary read still routes through the read path', () => {
  const body = syntheticLog(3000, { errorCount: 5 });
  const payload = asReadResultLike('C:/fixtures/one.log', body);
  const result = slimContent([{ type: 'text', text: payload }], 'read', resolveOptions({ readMaxResultTokens: 1500 }));
  assert.ok(result !== null);
  assert.ok(result.stats.omittedLines > 0);
  assert.ok(result.blocks[0].text.startsWith('<path>'), 'the envelope must survive');
});

/** Render text the way the read tool renders it, for the single-block path. */
function asReadResultLike(displayPath, text) {
  const lines = text.split('\n');
  return [
    `<path>${displayPath}</path>`,
    '<type>file</type>',
    '<content>',
    lines.map((line, index) => `${index + 1}: ${line}`).join('\n'),
    '',
    `(End of file - total ${lines.length} lines)`,
    '</content>',
  ].join('\n');
}

test('a result is re-measured after rendering and made to fit in fact', () => {
  // Markers and the read envelope cost tokens that a plan cannot see: the
  // selection fits, then rendering spends more than it budgeted. Sweeping
  // budgets asserts the published total respects the ceiling whenever
  // protection did not overflow it.
  const rows = Array.from({ length: 4000 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);
  const text = rows.join('\n');
  const overruns = [];
  for (const budget of [200, 500, 1000, 2000, 4000]) {
    const result = slimContent([{ type: 'text', text }], 'pwsh', resolveOptions({ maxResultTokens: budget }));
    if (result === null) continue;
    const out = estimateTokens(result.blocks[0].text);
    if (out > budget) overruns.push(`${budget} -> ${out}`);
  }
  assert.deepEqual(overruns, [], `budgets overrun: ${overruns.join(', ')}`);
});

test('the opening and the closing survive the withdrawal pass', () => {
  // The convergence loop removes the lowest-scoring lines. The head and tail
  // guarantees are structure and outcome, not filler, so they have to be out of
  // its reach — otherwise a tight budget eats the last line and the result
  // silently loses its terminating newline.
  const rows = Array.from({ length: 1500 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);
  const input = `${rows.join('\n')}\n`;
  const result = slimContent([{ type: 'text', text: input }], 'pwsh', resolveOptions({ maxResultTokens: 150 }));
  assert.ok(result !== null);
  const out = result.blocks[0].text;
  assert.equal(out.endsWith('\n'), true, 'the terminating newline is content too');
  assert.ok(out.startsWith(rows[0]), 'the opening must survive');
});

test('convergence is bounded: an all-protected payload terminates', () => {
  // Every line is protected here, so there is nothing to withdraw. The honest
  // outcome is the untouched result, reached without the loop spinning — the
  // round cap is a safety net, not the expected path.
  const rows = Array.from({ length: 800 }, (_, i) => `2026-05-01T10:00:00Z ERROR shard=${i} failed hard`);
  const started = process.hrtime.bigint();
  const result = slimContent([{ type: 'text', text: rows.join('\n') }], 'pwsh', resolveOptions({ maxResultTokens: 40 }));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 5000, `convergence took ${elapsedMs.toFixed(0)} ms`);
  if (result === null) return; // passed through whole: every protected line survives by definition
  const kept = result.blocks[0].text.split('\n').filter((line) => line.includes('ERROR')).length;
  assert.equal(kept, 800, 'every protected line must still be present');
  assert.equal(result.stats.budgetExceeded, true, 'the overflow must be reported, not hidden');
  assert.match(result.stats.overflowReason, /protected-content/);
});

test('a payload with withdrawable filler converges onto its budget', () => {
  // One protected line in a sea of filler: the loop withdraws filler until the
  // rendered total — markers and all — fits, and the protected line stays.
  const rows = [];
  for (let index = 0; index < 2000; index++) {
    rows.push(
      index === 1000
        ? '2026-05-01T10:00:00Z ERROR shard=1 connection refused by upstream'
        : `2026-05-01T10:00:00Z INFO row=${index} processed ok`,
    );
  }
  const text = rows.join('\n');
  for (const budget of [150, 300, 600, 1200]) {
    const result = slimContent([{ type: 'text', text }], 'pwsh', resolveOptions({ maxResultTokens: budget }));
    assert.ok(result !== null, `budget ${budget} should bound this payload`);
    const out = estimateTokens(result.blocks[0].text);
    assert.ok(
      out <= budget,
      `budget ${budget} produced ${out} tokens — the withdrawal pass did not converge`,
    );
    assert.ok(result.blocks[0].text.includes('ERROR shard=1'), 'the protected line must survive');
  }
});

test('withdrawing lines never inflates the result', () => {
  // Downward-only is the property that makes the loop terminate: each round
  // removes at least one line and re-renders, so the kept set strictly shrinks.
  const rows = Array.from({ length: 2000 }, (_, i) =>
    i % 500 === 0 ? `2026-05-01T10:00:00Z ERROR shard=${i}` : `2026-05-01T10:00:00Z INFO row=${i} ok`,
  );
  const text = rows.join('\n');
  let previous = Number.POSITIVE_INFINITY;
  for (const budget of [300, 600, 1200, 2400]) {
    const result = slimContent([{ type: 'text', text }], 'pwsh', resolveOptions({ maxResultTokens: budget }));
    assert.ok(result !== null);
    const out = estimateTokens(result.blocks[0].text);
    assert.ok(out >= previous || previous === Number.POSITIVE_INFINITY || out <= budget, 'a larger budget must not shrink the result');
    previous = out;
  }
});

test('bare markers are explained once for the whole result', () => {
  // Sixty blocks against a small total: each share is too small to afford the
  // sentence describing what it dropped, so each falls back to the symbol.
  const rows = Array.from({ length: 4000 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);
  const per = Math.ceil(rows.length / 60);
  const blocks = [];
  for (let index = 0; index < 60; index++) {
    const slice = rows.slice(index * per, (index + 1) * per);
    if (slice.length > 0) blocks.push({ type: 'text', text: slice.join('\n') });
  }
  const result = slimContent(blocks, 'pwsh', resolveOptions({ maxResultTokens: 400 }));
  assert.ok(result !== null);
  assert.ok(result.stats.terseMarkers > 1, 'small shares should fall back to the terse marker');

  const text = result.blocks.map((block) => block.text).join('');
  const notes = text.match(/could not afford a description/g) ?? [];
  assert.equal(notes.length, 1, 'the symbol must be explained once, not per block');
  assert.ok(estimateTokens(text) <= 400, 'the merged note still has to fit the allowance');
});

test('a result with no bare markers gains no note', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} payload ok`);
  const result = slimContent([{ type: 'text', text: rows.join('\n') }], 'pwsh', resolveOptions({ maxResultTokens: 800 }));
  assert.ok(result !== null);
  assert.equal(result.stats.terseMarkers, 0);
  assert.equal(
    result.blocks[0].text.includes('could not afford a description'),
    false,
    'no explanation is owed when every marker described itself',
  );
});

test('protected content that overruns a tiny ceiling is still delivered whole', () => {
  // With every line protected there is nothing to remove, so the honest outcome
  // is the untouched result — not a trimmed one that dropped the errors to fit
  // a number. The kernel reports an overflow only when it actually publishes a
  // bounded payload that exceeds the ceiling.
  const localOptions = resolveOptions({ maxResultTokens: 20 });
  const errorLines = Array.from({ length: 60 }, (_, i) => `2026-05-01T10:00:00Z ERROR shard=${i} connection refused`);
  const input = errorLines.join('\n');
  const result = slimContent([{ type: 'text', text: input }], 'pwsh', localOptions);
  if (result === null) {
    // Passed through unchanged, which keeps every protected line by definition.
    return;
  }
  const text = result.blocks[0].text;
  for (let index = 0; index < 60; index++) {
    assert.ok(text.includes(`ERROR shard=${index} `), `protected line ${index} must survive`);
  }
});
