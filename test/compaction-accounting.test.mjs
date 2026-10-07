/**
 * Compaction accounting in the cost replay.
 *
 * `timeline()` models the re-sent prefix, and a compaction changes what that
 * prefix is. The rule it has to get right: **only a compaction that produced a
 * summary replaces the history it covers.** A failed one — the harness records
 * `error: "summarization truncated at the token cap (incomplete checkpoint)"`
 * on the `compaction/end` row and emits no `compaction/summary` — leaves that
 * history in the prefix, still re-sent and still billed.
 *
 * Clearing the entries on every `compaction/end` wrote off whole sessions.
 * Measured on the real store: `session-ce8655d1` ran 28 compactions of which 25
 * failed, so the replay folded it to `1 entries / 0 tokens` while its 1124 tool
 * results and 235 turns were still in the prefix — which also made the reported
 * baseline (and therefore every savings percentage) a lower bound.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { timeline } from './audit.mjs';

const line = (event) => JSON.stringify(event);
const answer = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: seq,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const compaction = (type, seq, extra = {}) => ({
  type,
  seq,
  time: seq,
  data: { compactionId: 'c1', turn: 1, ...extra },
});

test('a failed compaction does not write off the history it never replaced', () => {
  const raw = [
    line(answer(0, 'first answer')),
    line(compaction('compaction/start', 1)),
    line(compaction('compaction/end', 2, { error: 'summarization truncated at the token cap (incomplete checkpoint)' })),
    line(answer(3, 'second answer')),
  ].join('\n');
  const { entries } = timeline(raw);
  assert.equal(entries.length, 2, 'no summary replaced anything, so both answers are still in the prefix');
});

test('a compaction that produced a summary still resets the accounting', () => {
  const raw = [
    line(answer(0, 'first answer')),
    line(compaction('compaction/start', 1)),
    line(compaction('compaction/summary', 2)),
    line(compaction('compaction/end', 3)),
    line(answer(4, 'second answer')),
  ].join('\n');
  const { entries } = timeline(raw);
  assert.equal(entries.length, 1, 'the summary replaced the history before it');
});

test('the reset still happens per compaction, not once per session', () => {
  const raw = [
    line(answer(0, 'one')),
    line(compaction('compaction/start', 1)),
    line(compaction('compaction/summary', 2)),
    line(compaction('compaction/end', 3)),
    line(answer(4, 'two')),
    line(compaction('compaction/start', 5)),
    line(compaction('compaction/end', 6, { error: 'summarization truncated at the token cap (incomplete checkpoint)' })),
    line(answer(7, 'three')),
  ].join('\n');
  const { entries } = timeline(raw);
  assert.equal(entries.length, 2, 'only the successful compaction folds history away');
});
