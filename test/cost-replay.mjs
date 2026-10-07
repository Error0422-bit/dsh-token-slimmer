/**
 * Cost side of the A/B: what does compression actually save on real sessions?
 *
 * The question this answers is not "how many tokens did the kernel remove" —
 * that number is easy and misleading. Every surface entry is re-sent on each
 * later request, so the cost of an entry is `tokens × remaining steps`. Failing
 * to compress an entry that only ever appears once costs nothing; compressing
 * an entry that sits in the context for three hundred more steps saves its
 * tokens three hundred times over.
 *
 * So this replays each recorded session twice over the same timeline: once as
 * recorded, once with the kernel applied to every tool result at the moment it
 * entered. The difference is the saving, charged at the cache-hit rate when it
 * lands in the prefix that is already warm and at the miss rate for the rest.
 *
 * Deliberately NOT part of `npm test`: it reads private transcripts. Run it
 * explicitly.
 *
 *   node test/cost-replay.mjs [--budget 2000] [--read-budget 5000]
 *
 * The rate pair defaults to the one `strategy.mjs` already uses (cached
 * ¥0.04/M, uncached ¥2/M). Override with --cached-rate / --miss-rate when the
 * provider's published prices move.
 *
 * @module dsh-token-slimmer/test/cost-replay
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { decompressTranscript, timeline } from './audit.mjs';
import { estimateTokens, resolveOptions, slimContent } from '../slim.js';

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/a/.dsh';
const SESSIONS = join(DSH_HOME, 'sessions');

/** Parse the few flags this script takes. */
function parseArgs(argv) {
  const out = { budget: 2000, readBudget: 5000, cachedRate: 0.04, missRate: 2, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--budget') out.budget = Number(value);
    else if (flag === '--read-budget') out.readBudget = Number(value);
    else if (flag === '--cached-rate') out.cachedRate = Number(value);
    else if (flag === '--miss-rate') out.missRate = Number(value);
    else if (flag === '--quiet') out.quiet = true;
    else continue;
    index++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** Every transcript under the sessions tree, largest first. */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith('.jsonl.zstd')) found.push(full);
  }
  return found;
}

/**
 * Tokens an entry would occupy once the kernel has had it, or its original
 * count when nothing applied.
 */
function compressedTokensOf(entry, options) {
  if (entry.role !== 'tool' || entry.text.length === 0) return entry.tokens;
  const blocks = [{ type: 'text', text: entry.text }];
  const result = slimContent(blocks, entry.tool ?? 'unknown', options);
  if (result === null) return entry.tokens;
  return estimateTokens(result.blocks[0].text);
}

const options = resolveOptions({ maxResultTokens: args.budget, readMaxResultTokens: args.readBudget });

const paths = walk(SESSIONS)
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((left, right) => right.size - left.size);

const perSession = [];
const totals = {
  sessions: 0,
  steps: 0,
  entries: 0,
  toolEntries: 0,
  touched: 0,
  baselineTokens: 0,
  compressedTokens: 0,
  savedResendTokens: 0,
  baselineReasoning: 0,
};

for (const file of paths) {
  const raw = decompressTranscript(readFileSync(file.path));
  const { entries, steps } = timeline(raw);
  if (steps === 0 || entries.length === 0) continue;

  const name = file.path.split(/[\\/]/).slice(-2, -1)[0] ?? file.path;
  let baseline = 0;
  let compressed = 0;
  let saved = 0;
  let touched = 0;

  for (const entry of entries) {
    const remaining = Math.max(0, steps - entry.step);
    const before = entry.tokens;
    const after = compressedTokensOf(entry, options);
    baseline += before * remaining;
    compressed += after * remaining;
    saved += (before - after) * remaining;
    if (after < before) touched++;
    totals.entries++;
    if (entry.role === 'tool') totals.toolEntries++;
    totals.baselineReasoning += entry.reasoningTokens * remaining;
  }

  perSession.push({ name, steps, entries: entries.length, baseline, compressed, saved, touched });
  totals.sessions++;
  totals.steps += steps;
  totals.touched += touched;
  totals.baselineTokens += baseline;
  totals.compressedTokens += compressed;
  totals.savedResendTokens += saved;
}

const money = (tokens) => (tokens / 1e6) * args.cachedRate;
const moneyMiss = (tokens) => (tokens / 1e6) * args.missRate;

console.log('\n=== Cost replay: recorded sessions, kernel applied to every tool result ===\n');
console.log(`  budget ${args.budget}/${args.readBudget} tokens   rates ¥${args.cachedRate}/M cached, ¥${args.missRate}/M uncached\n`);
console.log('  session                          steps  results  cut   baseline ¥   compressed ¥');
for (const session of perSession) {
  console.log(
    `  ${session.name.padEnd(32)} ${String(session.steps).padStart(5)} ` +
      `${String(session.entries).padStart(8)} ${String(session.touched).padStart(4)} ` +
      `${money(session.baseline).toFixed(3).padStart(12)} ${money(session.compressed).toFixed(3).padStart(14)}`,
  );
}

const savedCached = money(totals.savedResendTokens);
const savedMiss = moneyMiss(totals.savedResendTokens);
console.log(`\n=== Totals ===`);
console.log(`  sessions                    ${totals.sessions}`);
console.log(`  steps                       ${totals.steps}`);
console.log(`  surface entries             ${totals.entries}   (tool results ${totals.toolEntries})`);
console.log(`  results actually cut        ${totals.touched}`);
console.log(`  baseline re-send tokens     ${totals.baselineTokens.toLocaleString('en-US')}`);
console.log(`  with kernel                 ${totals.compressedTokens.toLocaleString('en-US')}`);
console.log(`  saved re-send tokens        ${totals.savedResendTokens.toLocaleString('en-US')}`);
console.log(
  `  reduction                   ${((totals.savedResendTokens / totals.baselineTokens) * 100).toFixed(2)}%`,
);
console.log(`\n  saved, every re-send at the cached rate    ¥${savedCached.toFixed(2)}`);
console.log(`  saved, every re-send at the uncached rate  ¥${savedMiss.toFixed(2)}`);
console.log(`\n  These two bracket the answer. A re-sent entry sits in the prefix that`);
console.log(`  earlier requests already wrote, so its real price is the hit rate — the`);
console.log(`  uncached figure is the ceiling, not the expectation.`);
console.log(`  Reasoning re-send cost, untouched and uncompressed: ${totals.baselineReasoning.toLocaleString('en-US')} tokens.`);
console.log('');
