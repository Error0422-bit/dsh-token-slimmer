/**
 * Configuration and lifecycle tests.
 *
 * The question these answer is not "does compression work" but "does the
 * default touch anything it should not". Reasoning rewriting is off by default
 * and refused even when asked for, because no recorded exchange confirms this
 * harness's provider accepts a rewritten assistant message. A test that only
 * checked the happy path of that feature would be worse than no test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

test('every module the package imports is shipped by the package', () => {
  // A module that is imported but missing from `files` ships a package that
  // cannot load at all — the import fails at activate time, on the user's
  // machine, after install. This caught metrics.js the moment it was wired into
  // index.js, and it exists so the next new module cannot repeat it.
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
  const shipped = new Set(manifest.files ?? []);
  const missing = [];

  const sources = readdirSync(pluginRoot).filter((name) => name.endsWith('.js'));
  for (const source of sources) {
    const body = readFileSync(join(pluginRoot, source), 'utf8');
    for (const match of body.matchAll(/from '\.\/([A-Za-z0-9_.-]+\.js)'/g)) {
      const dependency = match[1];
      if (!shipped.has(dependency)) missing.push(`${source} imports ${dependency}`);
    }
  }

  assert.deepEqual(missing, [], `modules imported but not listed in package.json files:\n  ${missing.join('\n  ')}`);
  assert.ok(shipped.has('cordis.patch.yml'), 'the bundle patch is the plugin entry point and must ship');
  assert.ok(shipped.has('bin/slim.mjs'), 'the CLI must ship');
});

import { apply, splitConfig } from '../index.js';
import { REASONING_DEFAULTS, REASONING_WRITES_VERIFIED, resolveReasoningOptions } from '../reasoning.js';
import { resolveOptions } from '../slim.js';
import { assistantWithReasoning, createFakeContext, createFakeSession } from './helpers/fake-session.mjs';

/** Run `body` with a throwaway stats directory. */
function withTempStats(body) {
  const dir = mkdtempSync(join(tmpdir(), 'slim-config-'));
  try {
    return body(join(dir, 'stats.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Trigger every registered `agent/pre-step` listener. */
async function firePreStep(handlers, agent, step = 2) {
  const listeners = handlers.get('agent/pre-step') ?? [];
  for (const listener of listeners) {
    await listener({ agent, step, turn: 1, messages: [], signal: new AbortController().signal }, async () => ({
      kind: 'enter',
      messages: [],
    }));
  }
}

test('reasoning is off by default and dry by default', () => {
  assert.equal(REASONING_DEFAULTS.strategy, 'never', 'the default must not rewrite anything');
  assert.equal(REASONING_DEFAULTS.dryRun, true, 'the default must not write');
});

test('the default config registers no reasoning listener at all', () => {
  withTempStats((statsPath) => {
    const { ctx, handlers } = createFakeContext();
    apply(ctx, { statsPath });
    assert.equal(
      (handlers.get('agent/pre-step') ?? []).length,
      0,
      'strategy never must not register a pre-step listener',
    );
    assert.equal((handlers.get('tools/post-execute') ?? []).length, 1, 'tool-result bounding stays registered');
  });
});

test('an explicit rewrite strategy writes nothing while the provider is unverified', async () => {
  await withTempStats(async (statsPath) => {
    const session = createFakeSession();
    session.seedMessage('assistant/message', assistantWithReasoning('思考过程。'.repeat(400)));
    const { ctx, handlers } = createFakeContext();
    apply(ctx, { statsPath, reasoning: { strategy: 'newest', dryRun: false } });
    assert.equal((handlers.get('agent/pre-step') ?? []).length, 1, 'a non-never strategy registers the listener');

    await firePreStep(handlers, { session });
    // The gate, not the constant, is what this asserts: a write happens only
    // when the constant says the provider contract has been verified. Pinning
    // the constant's value would make the test fail the day the experiment
    // succeeds — which is the opposite of what it is for.
    //
    // Asserted on `boundedCount` rather than `replaceCount`: the write is an
    // append of this plugin's own event type interpreted by a message
    // projection. A surface replacement is impossible here — the session forbids
    // `assistant/message` from citing the nodes it shadows, and requires a
    // replacement to cite all of them.
    assert.equal(
      session.boundedCount,
      REASONING_WRITES_VERIFIED ? 1 : 0,
      'a durable rewrite is published exactly when writes are verified',
    );
  });
});

test('dry run still measures the candidate without writing', async () => {
  await withTempStats(async (statsPath) => {
    const session = createFakeSession();
    session.seedMessage('assistant/message', assistantWithReasoning('思考过程。'.repeat(400)));
    const { ctx, handlers } = createFakeContext();
    apply(ctx, { statsPath, reasoning: { strategy: 'newest', dryRun: true } });
    await firePreStep(handlers, { session });
    assert.equal(session.boundedCount, 0, 'a dry run must not write');
  });
});

test('headRatio accepts a fraction and rejects everything else', () => {
  assert.equal(resolveReasoningOptions({ headRatio: 0.55 }).headRatio, 0.55);
  assert.equal(resolveReasoningOptions({ headRatio: 0 }).headRatio, 0);
  assert.equal(resolveReasoningOptions({ headRatio: 1 }).headRatio, 1);
  for (const bad of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    assert.throws(
      () => resolveReasoningOptions({ headRatio: bad }),
      /finite number between 0 and 1/,
      `headRatio ${String(bad)} must be rejected`,
    );
  }
});

test('token budgets and durations stay non-negative integers', () => {
  assert.equal(resolveReasoningOptions({ budgetTokens: 0 }).budgetTokens, 0);
  for (const bad of [-1, 1.5, Number.NaN]) {
    assert.throws(() => resolveReasoningOptions({ budgetTokens: bad }), /non-negative integer/);
    assert.throws(() => resolveReasoningOptions({ coldAfterMs: bad }), /non-negative integer/);
  }
});

test('the kernel keeps its own validation contract', () => {
  assert.doesNotThrow(() => resolveOptions({ headBudgetRatio: 0.55 }));
  for (const bad of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveOptions({ headBudgetRatio: bad }), /strictly between/);
  }
  for (const bad of [-1, 1.5, Number.NaN]) {
    assert.throws(() => resolveOptions({ maxResultTokens: bad }), /non-negative integer/);
  }
});

test('the config split still routes plugin-owned keys away from the kernel', () => {
  const { kernel, plugin } = splitConfig({
    maxResultTokens: 2000,
    reasoning: { strategy: 'auto' },
    statsPath: 'x.json',
  });
  assert.deepEqual(Object.keys(kernel), ['maxResultTokens']);
  assert.deepEqual(Object.keys(plugin).sort(), ['reasoning', 'statsPath']);
});

test('an unknown strategy is refused rather than silently ignored', () => {
  assert.throws(() => resolveReasoningOptions({ strategy: 'aggressive' }), /must be one of/);
});
