/**
 * A session stand-in for offline tests.
 *
 * The plugin touches four things on `ctx.agent.session`: `surface.nodes`,
 * `eventAt(seq)`, `append(type, data, opts)`, and `header.id`. This implements
 * exactly those with real append and replace semantics, so a test can assert
 * *how many writes happened* — which is the whole question for the reasoning
 * pass, where the default must be zero.
 *
 * @module test/helpers/fake-session
 */

/**
 * Create a session double.
 * @param {object[]} [seed] - initial events, in order.
 * @returns {object} a session-shaped object plus test-only accessors.
 */
export function createFakeSession(seed = []) {
  /** Every appended event, including non-surface ones. */
  const log = seed.map((event, index) => ({ seq: index, time: Date.now() + index, ...event }));
  /** Indices into `log` that are currently on the model-visible surface. */
  let nodes = log.filter((event) => event.type !== 'log-only').map((event) => event.seq);

  /** Count of surface-affecting writes, which is what tests assert on. */
  let surfaceWrites = 0;
  /** Count of this plugin's own reasoning-bound decisions. */
  let boundedWrites = 0;

  return {
    header: { id: 'fake-session' },

    surface: {
      get nodes() {
        return [...nodes];
      },
    },

    eventAt(seq) {
      return log[seq];
    },

    append(type, data, opts) {
      const seq = log.length;
      const event = { seq, time: Date.now(), type, data };
      log.push(event);
      // A plugin-owned durable decision is an append of its own event type, not
      // a surface replacement: the session rejects `assistant/message` carrying
      // `surfaceOp: replace`, because such a message may not cite the nodes it
      // shadows and a replacement must cite all of them.
      if (type === 'token-slimmer/reasoning-bounded') boundedWrites++;
      const op = opts?.surfaceOp;
      if (op === undefined || op === 'append') {
        if (type !== 'log-only') nodes.push(seq);
      } else if (op.op === 'replace') {
        const start = nodes.indexOf(op.startSeq);
        const end = nodes.indexOf(op.endSeq);
        if (start === -1 || end === -1 || end < start) {
          throw new Error(`fake-session: replace range ${op.startSeq}-${op.endSeq} is not on the surface`);
        }
        nodes = [...nodes.slice(0, start), seq, ...nodes.slice(end + 1)];
        surfaceWrites++;
      }
      return event;
    },

    /** Seed a message-shaped event the way the harness would. */
    seedMessage(type, message) {
      return this.append(type, { message }, { surfaceOp: 'append' });
    },

    /** Total events in the log. */
    get logLength() {
      return log.length;
    },

    /** Surface-affecting replacements performed so far. */
    get replaceCount() {
      return surfaceWrites;
    },

    /**
     * Reasoning-bound decisions published so far.
     *
     * The count a test should assert on for a rewrite: the mechanism is an
     * append of this plugin's own event type, interpreted by a registered
     * message projection, not a surface replacement.
     */
    get boundedCount() {
      return boundedWrites;
    },

    /** Everything currently on the surface, resolved to events. */
    surfaceEvents() {
      return nodes.map((seq) => log[seq]);
    },
  };
}

/**
 * An assistant message carrying reasoning, shaped like the recorded events.
 * @param {string} reasoning - reasoning body.
 * @param {string} [text] - visible reply text.
 * @returns {object} the message payload.
 */
export function assistantWithReasoning(reasoning, text = 'ok') {
  return {
    role: 'assistant',
    source: { kind: 'model', provider: 'fake', model: 'fake-1' },
    content: [
      { type: 'reasoning', text: reasoning },
      { type: 'text', text },
    ],
  };
}

/**
 * A minimal plugin context exposing just what `apply` registers against.
 * @returns {{ ctx: object, counts: object, handlers: object }} the double.
 */
export function createFakeContext() {
  const handlers = new Map();
  const counts = { on: 0 };
  return {
    handlers,
    counts,
    ctx: {
      on(name, handler) {
        counts.on++;
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
        return () => {};
      },
      get() {
        return undefined;
      },
      logger: { warn() {}, info() {}, debug() {} },
    },
  };
}
