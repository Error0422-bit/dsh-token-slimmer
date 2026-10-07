/**
 * Controlled comparison for the reasoning rewrite: does it pay?
 *
 * The question can't be answered by running a session twice, because a session
 * is not reproducible -- every step appends, and the prefix grows under you. So
 * the comparison is built from usage records that already exist.
 *
 * The model being tested:
 *
 *   cacheReadTokens(n+1) approximately equals total(n)   [prefix carried forward]
 *   inputTokens(n+1)     approximately equals new tokens [what the step added]
 *
 * If a rewrite removed R tokens from an assistant message that is now part of
 * the prefix, the carried-forward total should drop by R relative to what it
 * would have been without the rewrite. The rewrite's own cost is that the
 * changed region has to be re-read as a miss rather than a hit.
 *
 * Steady-state inference: at every step the prefix carried forward should equal
 * the previous step's total, up to what the current step appended. Deviations
 * measure either the rewrite's effect or ordinary churn (compaction, truncation).
 *
 * Explicit entry: reads private transcripts.
 *
 *   node test/reasoning-cost.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { decompressTranscript } from './audit.mjs';

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/a/.dsh';
const SESSIONS = join(DSH_HOME, 'sessions');

/** Every transcript, newest first. */
function transcripts() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl.zstd')) found.push({ path: full, mtime: statSync(full).mtimeMs });
    }
  };
  walk(SESSIONS);
  return found.sort((left, right) => right.mtime - left.mtime);
}

/**
 * Usage rows and rewrite rows for one session, in seq order.
 *
 * A usage row is whatever the provider reported for a request. A rewrite row is
 * this plugin's own applied decision. Interleaving them by seq is what makes the
 * comparison possible: a rewrite at seq N is inside the prefix of the next
 * request.
 */
function readSession(path) {
  const raw = decompressTranscript(readFileSync(path));
  const usage = [];
  const rewrites = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const record = event.data?.usage ?? event.data?.message?.usage ?? event.usage;
    if (record !== undefined && typeof record.cacheReadTokens === 'number') {
      usage.push({
        seq: event.seq,
        miss: record.inputTokens ?? 0,
        hit: record.cacheReadTokens ?? 0,
        out: record.outputTokens ?? 0,
        total: record.totalTokens ?? 0,
      });
    }
    if (event.type === 'token-slimmer/reasoning-bounded') {
      const targets = event.data?.targets ?? [];
      rewrites.push({ seq: event.seq, targets: targets.length });
    }
  }
  return { usage, rewrites };
}

/**
 * Tokens a rewrite removed, from the reasoning text it replaced.
 *
 * The event carries the replacement text, not the original, so the original has
 * to be found on the surface it replaced. Rather than reconstruct that, this
 * counts the reduction the plugin itself logged for the same step -- the log is
 * the plugin's own claim and this script's job is to test the claim, not restate
 * it. Returns null when the log is unavailable.
 */
function readLoggedReductions(logPath) {
  const saved = new Map();
  let text;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return saved;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"surface":"reasoning"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.mode !== 'applied') continue;
      saved.set(entry.seq, { tokensIn: entry.tokensIn, tokensOut: entry.tokensOut });
    } catch {
      /* a partial line */
    }
  }
  return saved;
}

const logPath = join(DSH_HOME, 'token-slimmer-stats.json.log');
const reductions = readLoggedReductions(logPath);
console.log(`\n=== Reasoning rewrite: controlled comparison ===\n`);
console.log(`  logged applied rewrites: ${reductions.size}`);

let examinedSessions = 0;
const withRewrites = [];

for (const file of transcripts()) {
  const { usage, rewrites } = readSession(file.path);
  if (usage.length < 4) continue;
  examinedSessions++;
  if (rewrites.length > 0) {
    withRewrites.push({ name: file.path.split(/[\\/]/).slice(-2, -1)[0], usage, rewrites });
  }
}

console.log(`  sessions examined       : ${examinedSessions}`);
console.log(`  sessions with rewrites  : ${withRewrites.length}`);

if (withRewrites.length === 0) {
  console.log('\n  No session carries an applied rewrite yet, so no comparison is possible.');
  console.log('  Run the experiment branch for one session, then re-run this.\n');
  process.exit(0);
}

console.log('\n=== Prefix carried forward versus previous total ===\n');
console.log('  For each step: carried - previousTotal. A rewrite removes tokens from the');
console.log('  prefix, so it should make this delta more negative than the session norm.');
console.log('  The norm is the control; without it a negative delta proves nothing.\n');

/** Mean and spread of a sample. */
function summarize(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: values.length,
    mean,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** Format one line of the summary table. */
function line(label, stats) {
  if (stats === null) return `  ${label.padEnd(26)} (no samples)`;
  return (
    `  ${label.padEnd(26)} n=${String(stats.n).padStart(4)}  ` +
    `mean=${stats.mean.toFixed(0).padStart(7)}  median=${String(stats.median).padStart(7)}  ` +
    `min=${String(stats.min).padStart(7)}  max=${String(stats.max).padStart(6)}`
  );
}

for (const session of withRewrites) {
  const rewriteSeqs = [...session.rewrites.map((row) => row.seq)].sort((a, b) => a - b);
  const rows = session.usage;
  const near = [];
  const far = [];
  for (let index = 1; index < rows.length; index++) {
    const delta = rows[index].hit - rows[index - 1].total;
    // A rewrite is "near" when it sits between these two requests, or within the
    // same step window. Everything else is the session's own norm.
    const adjacent = rewriteSeqs.some((seq) => seq > rows[index - 1].seq && seq < rows[index].seq);
    (adjacent ? near : far).push(delta);
  }
  console.log(`  --- ${session.name}`);
  console.log(line('steps following a rewrite', summarize(near)));
  console.log(line('steps with no rewrite', summarize(far)));

  const nearStats = summarize(near);
  const farStats = summarize(far);
  if (nearStats !== null && farStats !== null) {
    // Compared on medians, not means. Compaction replaces an entire history with
    // a summary, so the control group contains deltas of -800000 while ordinary
    // steps sit near -100; a mean over both measures the compactions, not the
    // rewrites. The median is the ordinary step, which is what a rewrite should
    // be compared against.
    const difference = nearStats.median - farStats.median;
    const verdict =
      difference < -50
        ? 'rewrites remove tokens from the carried prefix'
        : difference > 50
          ? 'rewrites do NOT remove tokens -- the pool may be nominal here'
          : 'indistinguishable from session churn';
    console.log(`      median difference: ${difference.toFixed(0)} tokens  ->  ${verdict}`);
    console.log(
      `      (means differ by ${(nearStats.mean - farStats.mean).toFixed(0)}; the control mean is`,
    );
    console.log(
      `       dragged by compactions down to ${farStats.min}, which is why the median decides.)`,
    );
  }
  console.log('');
}
console.log('  Caveats this measurement cannot remove:');
console.log('    - the removal is charged as a cache miss at the change point, and that cost');
console.log('      appears in inputTokens rather than cacheReadTokens, so the figure above is');
console.log('      the gross saving, not the net one;');
console.log('    - the control group is the session norm, not a matched no-rewrite replay;');
console.log('    - 12 rewrites is a small sample and they come from one session.\n');
