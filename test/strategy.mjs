/**
 * Strategy backtest: replay real sessions step by step and charge each strategy
 * what it would actually have cost.
 *
 * This exists because "auto picks the right method per session" is only a claim
 * until it is checked against something. Every strategy here runs over the same
 * recorded step sequence, the same real idle gaps, and the same real DeepSeek
 * Flash rates, so the comparison is a measurement rather than an argument.
 *
 * Charging model, per step:
 *   - the request carries everything already on the surface
 *   - a strategy that rewrites only the newest assistant message rewrites
 *     content no request has carried yet, so the request is billed at the
 *     cached rate
 *   - a strategy that rewrites an older message invalidates the cached prefix,
 *     so that request is billed at the uncached rate
 *
 * Usage: node test/strategy.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

import { planReasoningPass, resolveReasoningOptions } from '../reasoning.js';
import { estimateTokens } from '../slim.js';

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/a/.dsh';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const PRICE = { hit: 0.04, miss: 2.0 };
const BUDGET = 500;

/** Strategies to compare, plus the idle threshold that defines a cold window. */
const STRATEGIES = ['never', 'newest', 'cold', 'all', 'auto'];
const COLD_MS = 5 * 60 * 1000;

function findLogs() {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl.zstd')) found.push({ path, size: statSync(path).size });
    }
  };
  walk(join(DSH_HOME, 'sessions'));
  return found.sort((left, right) => right.size - left.size);
}

function decompressTranscript(buffer) {
  const offsets = [];
  let index = 0;
  while ((index = buffer.indexOf(ZSTD_MAGIC, index)) !== -1) {
    offsets.push(index);
    index += 4;
  }
  const pieces = [];
  for (const offset of offsets) {
    try {
      pieces.push(zstdDecompressSync(buffer.subarray(offset)));
    } catch {
      /* not a frame header */
    }
  }
  return Buffer.concat(pieces).toString('utf8');
}

/**
 * Reduce one transcript to the step-indexed facts the backtest needs: what the
 * surface held when each step began, and every reasoning block with the step
 * that produced it.
 */
function buildSession(raw) {
  const steps = [];
  const blocks = [];
  let step = 0;
  let current = null;
  // Running totals of everything that has entered the surface so far.
  let otherTokens = 0;
  let reasoningTotal = 0;
  let blockId = 0;

  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'step/start') {
      step++;
      current = { index: step, time: event.time ?? null, otherTokens, reasoningTotal };
      steps.push(current);
      continue;
    }
    if (event.type === 'compaction/end') {
      // The summary replaces what came before; model the reset so the backtest
      // does not charge for history the session no longer carries.
      otherTokens = 0;
      reasoningTotal = 0;
      continue;
    }
    const message = event.data?.message;
    if (message === undefined) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    let messageOther = 0;
    for (const block of content) {
      if (block?.type === 'text') messageOther += estimateTokens(block.text);
      else if (block?.type === 'reasoning') {
        const tokens = estimateTokens(block.text);
        reasoningTotal += tokens;
        blocks.push({ id: blockId++, step, tokens });
      }
    }
    if (message.role !== 'assistant') messageOther += messageOther === 0 ? 0 : 0;
    otherTokens += messageOther;
  }
  return { steps, blocks };
}

/**
 * Charge one strategy over one session.
 * @returns {{cost: number, bustedSteps: number, bounded: number}}
 */
function charge(session, strategy) {
  const { steps, blocks } = session;
  const lastStep = steps.length;
  if (lastStep === 0) return { cost: 0, bustedSteps: 0, bounded: 0 };
  const state = new Map();
  let cost = 0;
  let bustedSteps = 0;
  let bounded = 0;

  for (let index = 1; index < lastStep; index++) {
    const step = steps[index];
    const previous = steps[index - 1];
    const cold =
      step.time !== null && previous.time !== null && step.time - previous.time > COLD_MS;

    // Everything produced strictly before this step is on the surface now.
    const visible = blocks.filter((block) => block.step < step.index);
    const overBudget = visible.filter((block) => (state.get(block.id) ?? block.tokens) > BUDGET);
    const selected = planReasoningPass(
      overBudget.map((block, order) => ({ ...block, index: order })),
      strategy,
      cold,
    );

    let busted = false;
    for (const target of selected) {
      // A block produced before the previous step was carried by that step's
      // request, so rewriting it now invalidates the cached prefix — unless this
      // step is naturally cold, in which case the prefix would be reprocessed
      // whatever this strategy did.
      if (!cold && target.step < step.index - 1) busted = true;
      if ((state.get(target.id) ?? target.tokens) > BUDGET) {
        state.set(target.id, BUDGET);
        bounded++;
      }
    }
    if (busted) bustedSteps++;

    let contextTokens = step.otherTokens;
    for (const block of visible) contextTokens += state.get(block.id) ?? block.tokens;
    // A cold step is billed uncached for every strategy alike, so it is a fair
    // baseline rather than a cost this strategy caused.
    cost += (contextTokens / 1e6) * (busted || cold ? PRICE.miss : PRICE.hit);
  }
  return { cost, bustedSteps, bounded };
}

const logs = findLogs().slice(0, 8);
resolveReasoningOptions({ strategy: 'auto', budgetTokens: BUDGET });

console.log('\n=== Strategy backtest over real sessions ===\n');
console.log(`  budget ${BUDGET} tokens/block, cold window ${COLD_MS / 60000} min,`);
console.log(`  cached ¥${PRICE.hit}/M vs uncached ¥${PRICE.miss}/M (${PRICE.miss / PRICE.hit}x)\n`);

const sessions = [];
for (const log of logs) {
  let raw;
  try {
    raw = decompressTranscript(readFileSync(log.path));
  } catch {
    continue;
  }
  const session = buildSession(raw);
  if (session.blocks.length === 0 || session.steps.length === 0) continue;
  sessions.push({ name: log.path.split(/[\\/]/).slice(-2, -1)[0] ?? log.path, ...session });
}

console.log(`  ${'session'.padEnd(24)}${'steps'.padStart(7)}${'reason blocks'.padStart(14)}  ` +
  STRATEGIES.map((s) => s.padStart(9)).join(''));
const columnTotals = Object.fromEntries(STRATEGIES.map((s) => [s, 0]));
const detail = Object.fromEntries(STRATEGIES.map((s) => [s, { bounded: 0, busted: 0 }]));

for (const session of sessions) {
  const cells = [];
  for (const strategy of STRATEGIES) {
    const result = charge(session, strategy);
    columnTotals[strategy] += result.cost;
    detail[strategy].bounded += result.bounded;
    detail[strategy].busted += result.bustedSteps;
    cells.push(`¥${result.cost.toFixed(3)}`.padStart(9));
  }
  console.log(
    `  ${session.name.slice(0, 22).padEnd(24)}${String(session.steps.length).padStart(7)}` +
      `${String(session.blocks.length).padStart(14)}  ${cells.join('')}`,
  );
}

console.log(`\n  ${'TOTAL'.padEnd(24)}${''.padStart(7)}${''.padStart(14)}  ` +
  STRATEGIES.map((s) => `¥${columnTotals[s].toFixed(3)}`.padStart(9)).join(''));

console.log('\n=== Relative to doing nothing ===\n');
const baseline = columnTotals.never;
console.log(`  ${'strategy'.padEnd(12)}${'cost ¥'.padStart(11)}${'vs never'.padStart(12)}${'blocks bounded'.padStart(16)}${'cache-busting steps'.padStart(20)}`);
for (const strategy of STRATEGIES) {
  const delta = columnTotals[strategy] - baseline;
  const sign = delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`;
  console.log(
    `  ${strategy.padEnd(12)}${columnTotals[strategy].toFixed(3).padStart(11)}${sign.padStart(12)}` +
      `${String(detail[strategy].bounded).padStart(16)}${String(detail[strategy].busted).padStart(20)}`,
  );
}

console.log('\n=== Verdict ===\n');
const winner = STRATEGIES.reduce((best, s) => (columnTotals[s] < columnTotals[best] ? s : best), 'never');
console.log(`  cheapest strategy: ${winner}`);
console.log(
  `  auto vs newest:    ${columnTotals.auto === columnTotals.newest ? 'identical (no cold window changed the plan)' : `auto differs by ¥${(columnTotals.auto - columnTotals.newest).toFixed(3)}`}`,
);
console.log(
  `  auto vs all:       ${columnTotals.auto <= columnTotals.all ? `auto is ¥${(columnTotals.all - columnTotals.auto).toFixed(3)} cheaper` : 'AUTO IS WORSE — do not ship'}`,
);
console.log(
  `  all vs never:      ${columnTotals.all <= baseline ? `all saves ¥${(baseline - columnTotals.all).toFixed(3)}` : `all LOSES ¥${(columnTotals.all - baseline).toFixed(3)}`}`,
);
console.log('');
