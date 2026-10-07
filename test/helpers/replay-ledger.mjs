/**
 * Replay ledger: rebuild each request's visible surface from recorded events,
 * so a backtest bills what the request actually carried — nothing more.
 *
 * The defect this defends against: a ledger that treats every message it has
 * ever seen as permanently visible keeps billing replaced reasoning after a
 * compaction, manufacturing ghost history costs. The only thing that changes
 * visibility here is an actual `surfaceOp: replace` event — a `compaction`
 * marker alone removes nothing. Unknown event shapes are flagged and refuse a
 * complete cost conclusion rather than being silently skipped.
 *
 * The append/replace semantics deliberately mirror
 * `test/helpers/fake-session.mjs`; `replay-ledger.test.mjs` pins the two
 * together so they cannot drift.
 *
 * Events are the normalized shape `{seq, type, data, surfaceOp}`:
 * - `surfaceOp` `'append'` (or absent) puts a non-`log-only` event on the surface;
 * - `{op: 'replace', startSeq, endSeq}` swaps that surface range for the event;
 * - `'log-only'` never touches the surface — `type: 'request'` events mark the
 *   billable checkpoints and carry `{label, agentId, usage}`.
 *
 * @module test/helpers/replay-ledger
 */

/**
 * Build a normalized event log with the same surface semantics as a real
 * session. Scenario builder: invalid replace ranges throw here, early.
 * @param {{startSeq?: number}} [options] - base seq, for resumed-session logs.
 */
export function createEventLog({ startSeq = 0 } = {}) {
  const events = [];
  const nodes = [];

  function push(type, data, surfaceOp) {
    const event = { seq: startSeq + events.length, time: Date.now(), type, data, surfaceOp };
    events.push(event);
    return event;
  }

  function onSurface(seq) {
    return nodes.includes(seq);
  }

  return {
    events,

    /** Append a surface event (`log-only` types stay off the surface). */
    append(type, data) {
      const event = push(type, data, 'append');
      if (type !== 'log-only') nodes.push(event.seq);
      return event;
    },

    /** Replace a surface range with a new event, collapsing it to one node. */
    replace(startSeq, endSeq, type, data) {
      if (!onSurface(startSeq) || !onSurface(endSeq)) {
        throw new Error(`replay-ledger: replace range ${startSeq}-${endSeq} is not on the surface`);
      }
      const event = push(type, data, { op: 'replace', startSeq, endSeq });
      const start = nodes.indexOf(startSeq);
      const end = nodes.indexOf(endSeq);
      nodes.splice(start, end - start + 1, event.seq);
      return event;
    },

    /** Record an event that never reaches the surface. */
    logOnly(type, data) {
      return push(type, data, 'log-only');
    },

    /** Mark a billable request checkpoint (log-only, carries usage). */
    request({ label, agentId, usage } = {}) {
      return this.logOnly('request', { label, agentId, usage });
    },

    /** Surface node seqs right now (test convenience). */
    visibleSeqs() {
      return [...nodes];
    },
  };
}

function reasoningTokensOf(visibleEvents) {
  let total = 0;
  let known = true;
  for (const event of visibleEvents) {
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'reasoning') continue;
      if (typeof block.tokens === 'number' && Number.isFinite(block.tokens)) {
        total += block.tokens;
      } else {
        known = false;
      }
    }
  }
  return known ? total : 'unknown';
}

/**
 * Replay an event log and snapshot every request checkpoint.
 *
 * Returns `{requests, unknownEvents, conclusion}`; each request carries the
 * visible messages (`visible`) so a caller can run the real compression
 * pipeline over them, plus `visibleReasoningTokens` — the number a request
 * re-sent, or `'unknown'` when some reasoning block lacks a token estimate.
 * `conclusion` is `'no-data'` for an empty log, `'unknown-format'` when any
 * event could not be interpreted (its seqs are in `unknownEvents`), and
 * `'complete'` otherwise.
 *
 * @param {object[]} events - normalized events, any order.
 */
export function replayRequests(events) {
  if (!Array.isArray(events)) throw new TypeError('replayRequests: events must be an array');

  const nodes = [];
  const unknownEvents = [];
  const requests = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(sorted.map((event) => [event.seq, event]));

  for (const event of sorted) {
    const op = event.surfaceOp ?? 'append';
    if (op === 'append') {
      if (event.type !== 'log-only') nodes.push(event.seq);
    } else if (typeof op === 'object' && op !== null && op.op === 'replace') {
      const start = nodes.indexOf(op.startSeq);
      const end = nodes.indexOf(op.endSeq);
      if (start === -1 || end === -1 || end < start) {
        unknownEvents.push(event.seq);
        continue;
      }
      nodes.splice(start, end - start + 1, event.seq);
    } else if (op !== 'log-only') {
      unknownEvents.push(event.seq);
      continue;
    }

    if (event.type === 'request') {
      const agentId = event.data?.agentId;
      const visible = nodes
        .map((seq) => bySeq.get(seq))
        .filter((candidate) => candidate !== undefined)
        .filter((candidate) => {
          const owner = candidate.data?.agentId;
          return owner === undefined || agentId === undefined || owner === agentId;
        })
        .map((candidate) => ({ seq: candidate.seq, type: candidate.type, data: candidate.data }));
      requests.push({
        seq: event.seq,
        label: event.data?.label,
        agentId,
        usage: event.data?.usage,
        visible,
        visibleReasoningTokens: reasoningTokensOf(visible),
      });
    }
  }

  return {
    requests,
    unknownEvents,
    conclusion: events.length === 0 ? 'no-data' : unknownEvents.length > 0 ? 'unknown-format' : 'complete',
  };
}
