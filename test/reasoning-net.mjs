/**
 * Net cost of a reasoning rewrite: does the removal pay for its own cache miss?
 *
 * The gross measurement (`reasoning-cost.mjs`) showed rewrites do remove tokens
 * from the carried prefix -- by a median of ~950-2000 versus the session norm.
 * That is only one side of the ledger.
 *
 * The other side: a rewrite changes the prefix, so the provider cannot reuse the
 * cached suffix from the change point. Everything after it is re-read as a miss
 * on the next request. That cost does not appear in `cacheReadTokens` -- it
 * appears in `inputTokens` of the step immediately following the rewrite.
 *
 * So the hypothesis is testable from data already recorded:
 *
 *     inputTokens(step after a rewrite)  >  inputTokens(ordinary step)
 *
 * If the step after a rewrite shows no elevation, the rewrite did not cause a
 * re-read, and its gross saving is net. If it does show elevation, the two can
 * be compared directly.
 *
 * Explicit entry: reads private transcripts.
 *
 *   node test/reasoning-net.mjs
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

/** Usage rows and rewrite positions for one session, in seq order. */
function readSession(path) {
  const raw = decompressTranscript(readFileSync(path));
  const usage = [];
  const rewrites = [];
  let step = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'step/start') {
      step++;
      continue;
    }
    const record = event.data?.usage ?? event.data?.message?.usage ?? event.usage;
    if (record !== undefined && typeof record.cacheReadTokens === 'number') {
      usage.push({
        seq: event.seq,
        step,
        miss: record.inputTokens ?? 0,
        hit: record.cacheReadTokens ?? 0,
        out: record.outputTokens ?? 0,
      });
    }
    if (event.type === 'token-slimmer/reasoning-bounded') {
      rewrites.push({ seq: event.seq, step });
    }
  }
  return { usage, rewrites };
}

/** Mean, median and count of a sample. */
function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    n: values.length,
    mean,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** One summary line. */
function line(label, stats) {
  if (stats === null) return `  ${label.padEnd(30)} (no samples)`;
  return (
    `  ${label.padEnd(30)} n=${String(stats.n).padStart(4)}  ` +
    `mean=${stats.mean.toFixed(0).padStart(8)}  median=${String(stats.median).padStart(8)}  ` +
    `max=${String(stats.max).padStart(8)}`
  );
}

/** Rates, matching strategy.mjs so the two measurements are comparable. */
const CACHED_PER_MILLION = 0.04;
const UNCACHED_PER_MILLION = 2;

console.log('\n=== Reasoning rewrite: the other side of the ledger ===\n');
console.log(`  rates: cached ¥${CACHED_PER_MILLION}/M   uncached ¥${UNCACHED_PER_MILLION}/M`);
console.log(`  ratio: ${UNCACHED_PER_MILLION / CACHED_PER_MILLION}x\n`);

const sessionsWithRewrites = [];
for (const file of transcripts()) {
  const session = readSession(file.path);
  if (session.usage.length < 4) continue;
  if (session.rewrites.length > 0) {
    sessionsWithRewrites.push({
      name: file.path.split(/[\\/]/).slice(-2, -1)[0],
      ...session,
    });
  }
}

if (sessionsWithRewrites.length === 0) {
  console.log('  No session carries an applied rewrite.\n');
  process.exit(0);
}

for (const session of sessionsWithRewrites) {
  const rows = session.usage;
  const rewriteSeqs = session.rewrites.map((row) => row.seq).sort((a, b) => a - b);

  const afterRewrite = [];
  const ordinary = [];
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    // A step is "after a rewrite" when a rewrite event sits between the two
    // requests: that is the request whose cache the rewrite invalidated.
    const invalidated = rewriteSeqs.some((seq) => seq > previous.seq && seq < current.seq);
    (invalidated ? afterRewrite : ordinary).push(current.miss);
  }

  console.log(`  --- ${session.name}   (${session.rewrites.length} rewrites, ${rows.length} steps)`);
  console.log(line('miss tokens, step after rewrite', summarize(afterRewrite)));
  console.log(line('miss tokens, ordinary step', summarize(ordinary)));

  const after = summarize(afterRewrite);
  const base = summarize(ordinary);
  if (after !== null && base !== null) {
    const excessMiss = after.median - base.median;
    console.log(`      excess miss at the change point: ${excessMiss.toFixed(0)} tokens (median)`);

    // The gross saving measured by reasoning-cost.mjs, recomputed here so the two
    // sides come from one script and one sample.
    const drops = [];
    for (let index = 1; index < rows.length; index++) {
      const invalidated = rewriteSeqs.some((seq) => seq > rows[index - 1].seq && seq < rows[index].seq);
      if (invalidated) drops.push(rows[index].hit - rows[index - 1].hit - rows[index - 1].miss);
    }
    const drop = summarize(drops);
    if (drop !== null) {
      console.log(`      gross prefix reduction         : ${(-drop.median).toFixed(0)} tokens (median)`);
      const savedPerStep = (-drop.median / 1e6) * CACHED_PER_MILLION;
      const paidOnce = (Math.max(0, excessMiss) / 1e6) * (UNCACHED_PER_MILLION - CACHED_PER_MILLION);
      console.log(`      saved per remaining step       : ¥${savedPerStep.toFixed(8)}`);
      console.log(`      paid once at the change point  : ¥${paidOnce.toFixed(8)}`);
      if (savedPerStep > 0) {
        const breakEven = paidOnce / savedPerStep;
        console.log(`      -> break-even at ${breakEven.toFixed(1)} remaining steps`);
        console.log(
          `      -> ${breakEven <= 1 ? 'pays immediately' : `needs ~${Math.ceil(breakEven)} more re-sends to pay off`}`,
        );
      }
    }
  }
  console.log('');
}

// How many steps remain, on average, after a point in a session? That is what
// the break-even has to be compared against -- and it is computable, which makes
// the verdict arithmetic rather than a matter of opinion.
console.log('=== Remaining steps after a rewrite (the break-even target) ===\n');
for (const session of sessionsWithRewrites) {
  const total = session.usage.length + 1;
  const remaining = session.rewrites.map((row) => {
    const index = session.usage.findIndex((usage) => usage.seq > row.seq);
    return index === -1 ? 0 : total - index;
  });
  const stats = summarize(remaining);
  if (stats !== null) {
    console.log(line(`${session.name.slice(0, 24)}`, stats));
  }
}
console.log('');
