/**
 * Replay ledger tests.
 *
 * The defect these defend against: a backtest that treats every message it
 * has ever seen as permanently visible keeps billing replaced reasoning after
 * a compaction — manufacturing ghost history costs out of tokens no request
 * carried any more. The acceptance scenario: a 2,000-token reasoning block is
 * replaced by a 2-token summary; the session's billed input is 2,002 tokens
 * (0.00008008 at the test-constant 0.04/M hit rate), never 4,002
 * (0.00016008).
 *
 * The 0.04/M unified hit rate is a ledger-verification constant, not a price:
 * real costs come from per-request usage via `priceUsage`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeSession } from './helpers/fake-session.mjs';
import { createEventLog, replayRequests } from './helpers/replay-ledger.mjs';
import { priceUsage } from '../metrics.js';

/** A reasoning block carrying an explicit token estimate (metadata, not text length). */
function reasoningBlock(tokens) {
  return { type: 'reasoning', text: `reasoning-${tokens}`, tokens };
}

function assistantMessage(content, agentId) {
  return {
    message: { role: 'assistant', content },
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/** Relative tolerance for currency-scale floats. */
function almostEqual(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

const HIT_RATES = {
  version: 1,
  provider: 'fake',
  model: 'fake-1',
  currency: 'CNY',
  hitPerMillion: 0.04,
  missPerMillion: 0.4,
  outputPerMillion: 4,
};

test('replayRequests reproduces the fake-session surface at every checkpoint', () => {
  // Drive a real session double and capture its surface after each request;
  // the replayer must agree with it event for event.
  const session = createFakeSession();
  const ops = [];
  const sessionAppend = session.append.bind(session);
  session.append = (type, data, opts) => {
    ops.push(opts?.surfaceOp ?? 'append');
    return sessionAppend(type, data, opts);
  };

  const expectedSurfaces = [];
  const drive = {
    assistant(content) {
      session.append('message', assistantMessage(content), { surfaceOp: 'append' });
    },
    replace(startSeq, endSeq, content) {
      session.append('message', assistantMessage(content), { surfaceOp: { op: 'replace', startSeq, endSeq } });
    },
    request(label) {
      session.append('request', { label }, { surfaceOp: 'log-only' });
      expectedSurfaces.push(session.surfaceEvents().map((event) => event.seq));
    },
  };

  drive.assistant([reasoningBlock(500)]);
  drive.assistant([reasoningBlock(700)]);
  drive.request('r1');
  drive.replace(0, 1, [reasoningBlock(50)]);
  drive.request('r2');
  session.append('log-only', { note: 'not on the surface' }, { surfaceOp: 'log-only' });
  drive.request('r3');


  const events = Array.from({ length: session.logLength }, (_, i) => ({ ...session.eventAt(i), surfaceOp: ops[i] }));
  const { requests, conclusion } = replayRequests(events);
  assert.equal(conclusion, 'complete');
  assert.equal(requests.length, expectedSurfaces.length);
  requests.forEach((request, index) => {
    assert.deepEqual(
      request.visible.map((message) => message.seq),
      expectedSurfaces[index],
    );
  });
});

test('a replaced reasoning block is billed once: 0.00008008, never 0.00016008', () => {
  const log = createEventLog();
  log.request({ label: 'step-1' });
  log.append('message', assistantMessage([reasoningBlock(2000)]));
  log.request({ label: 'step-2' });
  log.replace(1, 1, 'message', assistantMessage([reasoningBlock(2)]));
  log.request({ label: 'step-3' });

  const { requests, conclusion } = replayRequests(log.events);
  assert.equal(conclusion, 'complete');
  assert.equal(requests[0].visibleReasoningTokens, 0);
  assert.equal(requests[1].visibleReasoningTokens, 2000);
  assert.equal(requests[2].visibleReasoningTokens, 2);

  const total = requests.reduce(
    // Labeled cache-scenario billing: every carried token is a hit, nothing
    // else is billed. The 0.04/M rate is a ledger-verification constant.
    (sum, request) => sum + priceUsage({ hitTokens: request.visibleReasoningTokens, missTokens: 0, outputTokens: 0 }, HIT_RATES).total,
    0,
  );
  almostEqual(total, 2002 * 0.04 / 1e6);
  almostEqual(total, 0.00008008);
  // The ghost double-billing this ledger exists to prevent:
  assert.ok(Math.abs(total - 0.00016008) > 1e-5, `total ${total} must not be the ghost figure`);
});

test('a partial replace keeps the nodes it did not cover', () => {
  const log = createEventLog();
  log.append('message', assistantMessage([reasoningBlock(500)]));
  log.append('message', assistantMessage([reasoningBlock(700)]));
  log.append('message', assistantMessage([reasoningBlock(900)]));
  log.request({ label: 'r1' });
  log.replace(0, 1, 'message', assistantMessage([reasoningBlock(50)]));
  log.request({ label: 'r2' });

  const { requests } = replayRequests(log.events);
  assert.equal(requests[0].visibleReasoningTokens, 2100);
  assert.equal(requests[1].visibleReasoningTokens, 950);
  assert.deepEqual(requests[1].visible.map((message) => message.seq), [4, 2]);
});

test('a retried result replaces its predecessor and is billed once', () => {
  const log = createEventLog();
  log.append('message', assistantMessage([reasoningBlock(300)]));
  log.replace(0, 0, 'message', assistantMessage([reasoningBlock(400)]));
  log.request({ label: 'after-retry' });

  const { requests } = replayRequests(log.events);
  assert.equal(requests[0].visibleReasoningTokens, 400);
  assert.deepEqual(requests[0].visible.map((message) => message.seq), [1]);
});

test('log-only events never reach the surface', () => {
  const log = createEventLog();
  log.append('message', assistantMessage([reasoningBlock(400)]));
  log.logOnly('note', { detail: 'internal bookkeeping' });
  log.request({ label: 'r1' });

  const { requests } = replayRequests(log.events);
  assert.equal(requests[0].visible.length, 1);
  assert.equal(requests[0].visibleReasoningTokens, 400);
});

test('a compaction marker removes nothing on its own', () => {
  const log = createEventLog();
  log.append('message', assistantMessage([reasoningBlock(1000)]));
  log.logOnly('compaction', { claimed: true });
  log.request({ label: 'after-compaction' });

  const { requests } = replayRequests(log.events);
  assert.equal(requests[0].visibleReasoningTokens, 1000);
});

test('a resumed session log with an offset base seq replays intact', () => {
  const log = createEventLog({ startSeq: 100 });
  log.append('message', assistantMessage([reasoningBlock(250)]));
  log.request({ label: 'resumed' });

  const { requests, conclusion } = replayRequests(log.events);
  assert.equal(conclusion, 'complete');
  assert.equal(requests[0].visibleReasoningTokens, 250);
  assert.deepEqual(requests[0].visible.map((message) => message.seq), [100]);
});

test('replayRequests does not depend on event order', () => {
  const log = createEventLog();
  log.append('message', assistantMessage([reasoningBlock(120)]));
  log.request({ label: 'r1' });
  log.append('message', assistantMessage([reasoningBlock(80)]));
  log.request({ label: 'r2' });

  const forward = replayRequests(log.events);
  const backward = replayRequests([...log.events].reverse());
  assert.deepEqual(
    forward.requests.map((request) => [request.label, request.visibleReasoningTokens]),
    backward.requests.map((request) => [request.label, request.visibleReasoningTokens]),
  );
});

test('per-agent streams are billed per agent', () => {
  const log = createEventLog();
  log.append('message', assistantMessage([reasoningBlock(300)], 'a'));
  log.append('message', assistantMessage([reasoningBlock(500)], 'b'));
  log.request({ label: 'a-only', agentId: 'a' });
  log.request({ label: 'b-only', agentId: 'b' });
  log.request({ label: 'shared' });

  const { requests } = replayRequests(log.events);
  assert.equal(requests[0].visibleReasoningTokens, 300);
  assert.equal(requests[1].visibleReasoningTokens, 500);
  assert.equal(requests[2].visibleReasoningTokens, 800);
});

test('an unknown event shape refuses a complete cost conclusion', () => {
  const log = createEventLog();
  log.append('message', assistantMessage([reasoningBlock(100)]));
  log.request({ label: 'r1' });
  const doctored = [
    ...log.events,
    { seq: 50, type: 'message', data: {}, surfaceOp: { op: 'replace', startSeq: 99, endSeq: 100 } },
    { seq: 51, type: 'message', data: {}, surfaceOp: 'teleport' },
  ];

  const { requests, unknownEvents, conclusion } = replayRequests(doctored);
  assert.equal(conclusion, 'unknown-format');
  assert.deepEqual(unknownEvents, [50, 51]);
  assert.equal(requests.length, 1);
});

test('an empty log says so instead of inventing a bill', () => {
  const { requests, unknownEvents, conclusion } = replayRequests([]);
  assert.equal(conclusion, 'no-data');
  assert.equal(requests.length, 0);
  assert.deepEqual(unknownEvents, []);
});

test('a reasoning block without a token estimate yields unknown, not zero', () => {
  const log = createEventLog();
  log.append('message', { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'no estimate' }] } });
  log.request({ label: 'r1' });

  const { requests } = replayRequests(log.events);
  assert.equal(requests[0].visibleReasoningTokens, 'unknown');
});
