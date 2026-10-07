/**
 * What a reasoning budget would actually pay, and what it would cost.
 *
 * Reasoning is the largest single re-send surface on this machine (47% of all
 * re-send cost), and it sits in assistant messages, so `tools/post-execute`
 * never sees it. Whether bounding it is worth anything depends entirely on
 * *when* the bound is applied, because applying it late rewrites a prefix the
 * provider already cached.
 *
 * This script prices three implementations off real transcripts and real
 * DeepSeek Flash rates:
 *
 *   A    no bound (status quo)
 *   B1   bound each reasoning block at first entry, before any request carried it
 *   B2   bound the whole reasoning history, which invalidates the cached prefix
 *   B2c  bound history only inside a confirmed-cold window (idle past the cache TTL)
 *
 * Usage: node test/reasoning.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

import { estimateTokens } from '../slim.js';

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/a/.dsh';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DeepSeek Flash, ¥ per 1M tokens. Peak rates; off-peak is half. */
const PRICE = { hit: 0.04, miss: 2.0 };
/** Ratio of an uncached input token to a cached one. */
const MISS_MULTIPLE = PRICE.miss / PRICE.hit;

/** Budgets to price, in tokens per reasoning block. 0 means "no bound". */
const BUDGETS = [0, 250, 500, 1000, 2000];

/** Idle gaps that plausibly outlive a provider prefix cache, in milliseconds. */
const COLD_GAPS = [
  { label: '5 min', ms: 5 * 60 * 1000 },
  { label: '15 min', ms: 15 * 60 * 1000 },
  { label: '1 h', ms: 60 * 60 * 1000 },
];

/** Every transcript under the sessions tree, largest first. */
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

/** Decode an appended-frame transcript. */
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
 * Rebuild one session as a step-indexed timeline carrying, for every assistant
 * message, the reasoning it produced and the wall-clock time it landed.
 */
function timeline(raw) {
  const steps = [];
  const entries = [];
  let step = 0;
  let current = null;
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
      current = { index: step, time: event.time ?? null, reasoningTokens: 0, contextTokens: 0 };
      steps.push(current);
      continue;
    }
    if (event.type === 'compaction/end') {
      entries.length = 0;
      continue;
    }
    const message = event.data?.message;
    if (message === undefined) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
    const reasoning = content.filter((b) => b?.type === 'reasoning').map((b) => b.text).join('');
    const textTokens = estimateTokens(text);
    const reasoningTokens = estimateTokens(reasoning);
    if (textTokens === 0 && reasoningTokens === 0) continue;
    if (reasoningTokens > 0 && current !== null) current.reasoningTokens += reasoningTokens;
    entries.push({ step, reasoningTokens, textTokens, time: event.time ?? null });
  }
  return { steps, entries };
}

const logs = findLogs().slice(0, 8);
console.log('\n=== Reasoning budget: benefit vs cost, priced at DeepSeek Flash peak ===\n');
console.log(`  cached input ¥${PRICE.hit}/M, uncached ¥${PRICE.miss}/M  →  an uncached token costs ${MISS_MULTIPLE}x a cached one\n`);

let totalReasoningTokens = 0;
let totalWeighted = 0;
let totalContextWeighted = 0;
const perSession = [];

for (const log of logs) {
  let raw;
  try {
    raw = decompressTranscript(readFileSync(log.path));
  } catch {
    continue;
  }
  const { steps, entries } = timeline(raw);
  const lastStep = steps.length;
  if (lastStep === 0) continue;
  const reasoning = entries.filter((entry) => entry.reasoningTokens > 0);
  if (reasoning.length === 0) continue;

  let weighted = 0;
  for (const entry of reasoning) weighted += entry.reasoningTokens * Math.max(0, lastStep - entry.step);

  // A late bound rewrites a prefix the provider already cached, so one request
  // reprocesses the whole live context at the uncached rate. `contextWeighted`
  // already includes the reasoning tokens, so it — not its sum with `weighted`
  // — is the denominator for the reasoning share.
  let contextWeighted = 0;
  for (const entry of entries) contextWeighted += (entry.textTokens + entry.reasoningTokens) * Math.max(0, lastStep - entry.step);

  // What bounding this session's reasoning at 500 tokens would recover, if the
  // bound were applied before any request carried the content.
  let b1Saved = 0;
  for (const entry of reasoning) {
    if (entry.reasoningTokens <= 500) continue;
    b1Saved += (entry.reasoningTokens - 500) * Math.max(0, lastStep - entry.step);
  }

  totalReasoningTokens += reasoning.reduce((sum, entry) => sum + entry.reasoningTokens, 0);
  totalWeighted += weighted;
  totalContextWeighted += contextWeighted;
  perSession.push({
    name: log.path.split(/[\\/]/).slice(-2, -1)[0] ?? log.path,
    stepCount: lastStep,
    blocks: reasoning.length,
    reasoningTokens: reasoning.reduce((sum, entry) => sum + entry.reasoningTokens, 0),
    weighted,
    b1Saved,
    avgContext: contextWeighted / Math.max(1, lastStep),
  });
}

console.log('=== Surface size ===\n');
console.log(`  reasoning raw text        ${totalReasoningTokens} tokens`);
console.log(`  reasoning re-sent cost    ${totalWeighted} tokens`);
console.log(`  everything re-sent        ${totalContextWeighted} tokens`);
console.log(`  reasoning share           ${((totalWeighted / totalContextWeighted) * 100).toFixed(1)}%  (of all re-send cost)`);

console.log('\n=== Reasoning block size distribution ===\n');
const sizes = [];
for (const log of logs) {
  let raw;
  try {
    raw = decompressTranscript(readFileSync(log.path));
  } catch {
    continue;
  }
  const { entries } = timeline(raw);
  for (const entry of entries) if (entry.reasoningTokens > 0) sizes.push(entry.reasoningTokens);
}
sizes.sort((a, b) => a - b);
const pick = (q) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))] ?? 0;
console.log(`  ${sizes.length} blocks | mean ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)} | p50 ${pick(0.5)} | p75 ${pick(0.75)} | p90 ${pick(0.9)} | p99 ${pick(0.99)} | max ${sizes.at(-1)}`);

console.log('\n=== A — current state ===\n');
console.log('  benefit  ¥0.00   cost  ¥0.00   (visibility only; the 47% keeps being re-sent)');

console.log('\n=== B1 — bound at first entry (breaks no cache) ===\n');
console.log(`  ${'budget'.padStart(8)}${'blocks cut'.padStart(12)}${'tokens saved'.padStart(15)}${'rate ¥/M'.padStart(11)}${'¥ / 8 sessions'.padStart(16)}`);
const b1Rows = [];
for (const budget of BUDGETS) {
  if (budget === 0) continue;
  let saved = 0;
  let cut = 0;
  for (const log of logs) {
    let raw;
    try {
      raw = decompressTranscript(readFileSync(log.path));
    } catch {
      continue;
    }
    const { steps, entries } = timeline(raw);
    const lastStep = steps.length;
    for (const entry of entries) {
      if (entry.reasoningTokens <= budget) continue;
      cut++;
      saved += (entry.reasoningTokens - budget) * Math.max(0, lastStep - entry.step);
    }
  }
  const yuan = (saved / 1e6) * PRICE.hit;
  b1Rows.push({ budget, saved, cut, yuan });
  console.log(
    `${String(budget).padStart(8)}${String(cut).padStart(12)}${String(saved).padStart(15)}` +
      `${String(PRICE.hit).padStart(11)}${('¥' + yuan.toFixed(3)).padStart(16)}`,
  );
}
console.log('  cost: none — the content was never sent, so no cached prefix changes.');

console.log('\n=== B2 — bound reasoning history unconditionally ===\n');
console.log('  Model: the whole history is rewritten once, at the most favourable moment');
console.log('  (step 1), so the gain is the full B1 recovery. The cost is one request');
console.log(`  reprocessing the live context at ¥${PRICE.miss}/M instead of ¥${PRICE.hit}/M.\n`);
console.log(`  ${'session'.padEnd(24)}${'steps'.padStart(7)}${'avg ctx'.padStart(10)}${'bust ¥'.padStart(10)}${'gain ¥'.padStart(10)}${'net ¥'.padStart(10)}`);
let netTotal = 0;
let bustTotal = 0;
let gainTotal = 0;
for (const session of perSession) {
  const avgContext = Math.round(session.avgContext);
  // A cold-prefix rewrite re-processes the live context once at the uncached rate.
  const bustYuan = (avgContext / 1e6) * (PRICE.miss - PRICE.hit);
  const gainYuan = (session.b1Saved / 1e6) * PRICE.hit;
  const net = gainYuan - bustYuan;
  netTotal += net;
  bustTotal += bustYuan;
  gainTotal += gainYuan;
  console.log(
    `  ${session.name.slice(0, 22).padEnd(24)}${String(session.stepCount).padStart(7)}${String(avgContext).padStart(10)}` +
      `${bustYuan.toFixed(3).padStart(10)}${gainYuan.toFixed(3).padStart(10)}${net.toFixed(3).padStart(10)}`,
  );
}
console.log(
  `\n  totals: gain ¥${gainTotal.toFixed(3)}  bust ¥${bustTotal.toFixed(3)}  net ¥${netTotal.toFixed(3)}` +
    `  → ${netTotal < 0 ? 'NET LOSS' : 'net gain'}`,
);

console.log('\n=== The break-even condition ===\n');
console.log('  Rewriting history pays only when');
console.log('      (remaining steps − 1) × fraction removed  >  49');
console.log(`  because one busted request costs ${MISS_MULTIPLE}x a cached one, minus the one you were paying anyway.\n`);
console.log(`  ${'fraction removed'.padStart(18)}${'steps needed'.padStart(15)}`);
for (const fraction of [0.1, 0.25, 0.47, 0.7, 0.9]) {
  console.log(`${(fraction * 100).toFixed(0).padStart(17)}%${String(Math.ceil(49 / fraction) + 1).padStart(15)}`);
}
const longest = Math.max(...perSession.map((s) => s.stepCount));
const meanSteps = Math.round(perSession.reduce((a, s) => a + s.stepCount, 0) / perSession.length);
console.log(`\n  observed sessions: longest ${longest} steps, mean ${meanSteps} steps.`);
console.log('  At the measured reasoning share (~47%), clearing the bar needs ~106 steps.');

console.log('\n=== B2c — bound history only inside a cold window ===\n');
console.log('  A cold window is safe: the cache already lapsed, so rewriting the prefix costs nothing.');
console.log('');
console.log(`  ${'TTL assumed'.padStart(13)}${'cold windows'.padStart(15)}${'reasoning in them'.padStart(19)}${'¥ recoverable'.padStart(16)}`);
for (const gap of COLD_GAPS) {
  let windows = 0;
  let tokensInWindows = 0;
  let saved = 0;
  for (const log of logs) {
    let raw;
    try {
      raw = decompressTranscript(readFileSync(log.path));
    } catch {
      continue;
    }
    const { steps, entries } = timeline(raw);
    const reasoningTimes = entries.filter((e) => e.reasoningTokens > 0 && e.time !== null);
    for (const entry of reasoningTimes) {
      // Find the next step's time to measure the idle gap after this block.
      const next = steps.find((s) => s.index > entry.step && s.time !== null);
      if (next === undefined || next.time === null || entry.time === null) continue;
      if (next.time - entry.time < gap.ms) continue;
      windows++;
      // Everything already on the surface at a cold point can be recompacted.
      const prior = reasoningTimes.filter((e) => e.step <= entry.step);
      const priorTokens = prior.reduce((sum, e) => sum + e.reasoningTokens, 0);
      tokensInWindows += priorTokens;
      saved += (priorTokens / 1e6) * PRICE.hit;
    }
  }
  console.log(
    `${gap.label.padStart(13)}${String(windows).padStart(15)}${String(tokensInWindows).padStart(19)}` +
      `${('¥' + saved.toFixed(3)).padStart(16)}`,
  );
}
console.log('');
