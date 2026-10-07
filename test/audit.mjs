/**
 * Cost audit: where the input tokens actually go.
 *
 * A tool result is not paid for once. It enters the surface, and every later
 * request in the session re-sends it. So the true cost of one result is
 * `tokens × remaining steps`, and that product — not the character count —
 * is the thing worth optimizing.
 *
 * This reconstructs each recorded session's step sequence, attributes the
 * re-send cost to each surface message, and reports what a budget applied to
 * *aged* results would recover. Aged results are the safe target: the model has
 * already acted on them, so shrinking them does not remove live evidence.
 *
 * Usage: node test/audit.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

import { estimateTokens, resolveOptions, shortDigest, slimContent } from '../slim.js';

const options = resolveOptions({});

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/a/.dsh';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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

/** Decode an appended-frame transcript. Exported for reuse; see {@link timeline}. */
export function decompressTranscript(buffer) {
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

/** Text of one message payload. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** Reasoning text of one message payload, kept separate from visible text. */
function reasoningOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * Build one session's timeline: the ordered surface entries, plus the step
 * index at which each entered. Events of interest are the durable ones that a
 * later request re-sends.
 *
 * Exported so the cost-replay comparison can charge the same timeline twice —
 * once as recorded, once with the kernel applied — instead of re-deriving the
 * surface semantics and drifting from this one.
 */
export function timeline(raw) {
  const callById = new Map();
  const entries = [];
  let step = 0;
  /** Whether the compaction in progress produced a summary to fold history into. */
  let summarised = false;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'tool/call') {
      if (typeof event.data?.callId === 'string') callById.set(event.data.callId, event.data.name);
      continue;
    }
    if (event.type === 'step/start') {
      step++;
      continue;
    }
    if (event.type === 'compaction/start') summarised = false;
    if (event.type === 'compaction/summary') summarised = true;
    if (event.type === 'compaction/end') {
      // Only a compaction that produced a summary replaces the history it
      // covers — the summary is what those entries were folded into. A failed
      // compaction records an `error` and no summary, and leaves the history
      // exactly where it was: still in the prefix, still re-sent, still billed.
      // Clearing on every end therefore wrote off whole sessions, which is how
      // vrolant — 28 compactions, 25 of them failed — folded to a single entry
      // and zero resend cost while its 1124 tool results were still re-sent.
      if (summarised) entries.length = 0;
      summarised = false;
      continue;
    }
    const message = event.data?.message;
    if (message === undefined) continue;
    const text = textOf(message.content);
    const reasoning = reasoningOf(message.content);
    if (text.length === 0 && reasoning.length === 0) continue;
    const role = message.role ?? 'unknown';
    let tool = null;
    if (role === 'tool') {
      const callId = message.toolCallId ?? message.source?.callId;
      tool = callById.get(callId) ?? 'unknown';
    }
    entries.push({
      step,
      role,
      tool,
      text,
      tokens: estimateTokens(text),
      reasoningTokens: estimateTokens(reasoning),
      reasoningDigest: reasoning.length === 0 ? null : shortDigest(reasoning),
    });
  }
  return { entries, steps: step };
}

const logs = findLogs().slice(0, 8);
console.log('\n=== Input-token cost audit (real recorded sessions) ===\n');
console.log(
  '  Every surface entry is re-sent on each later request in the session, so its\n' +
    '  real cost is tokens x remaining steps. "Aged" = entered more than 8 steps ago.\n',
);

const totals = {
  sessions: 0,
  steps: 0,
  resendTokens: 0,
  toolResendTokens: 0,
  agedToolResendTokens: 0,
  agedToolTokens: 0,
  agedToolCount: 0,
  toolCount: 0,
  largestAged: [],
  allTools: [],
  reasoningTokens: 0,
  reasoningResendTokens: 0,
  reasoningEntries: 0,
};
const perTool = new Map();

for (const log of logs) {
  let raw;
  try {
    raw = decompressTranscript(readFileSync(log.path));
  } catch {
    continue;
  }
  const { entries, steps } = timeline(raw);
  if (steps === 0 || entries.length === 0) continue;
  totals.sessions++;
  totals.steps += steps;

  let sessionResend = 0;
  for (const entry of entries) {
    const remaining = Math.max(0, steps - entry.step);
    const cost = entry.tokens * remaining;
    sessionResend += cost;
    totals.resendTokens += cost;
    if (entry.reasoningTokens > 0) {
      totals.reasoningTokens += entry.reasoningTokens;
      totals.reasoningResendTokens += entry.reasoningTokens * remaining;
      totals.reasoningEntries++;
    }
    if (entry.role === 'tool') {
      totals.toolCount++;
      totals.toolResendTokens += cost;
      const bucket = perTool.get(entry.tool) ?? { count: 0, tokens: 0, cost: 0, agedCost: 0 };
      bucket.count++;
      bucket.tokens += entry.tokens;
      bucket.cost += cost;
      perTool.set(entry.tool, bucket);
      if (remaining > 8) {
        totals.agedToolCount++;
        totals.agedToolTokens += entry.tokens;
        totals.agedToolResendTokens += cost;
        bucket.agedCost += cost;
      }
      totals.allTools.push({
        tool: entry.tool,
        tokens: entry.tokens,
        remaining,
        cost,
        digest: shortDigest(entry.text),
        text: entry.text,
      });
      if (remaining > 8) {
        totals.largestAged.push({ tool: entry.tool, tokens: entry.tokens, remaining, cost, digest: shortDigest(entry.text) });
      }
    }
  }
  const name = log.path.split(/[\\/]/).slice(-2, -1)[0] ?? log.path;
  console.log(
    `  ${name.padEnd(46)} ${String(steps).padStart(4)} steps  ` +
      `${String(entries.length).padStart(5)} entries  resend cost ${String(sessionResend).padStart(10)} tokens`,
  );
}

console.log('\n=== Where the re-send cost sits ===\n');
const toolShare = (totals.toolResendTokens / totals.resendTokens) * 100;
const agedShare = (totals.agedToolResendTokens / totals.resendTokens) * 100;
console.log(`  sessions audited           ${totals.sessions}    steps ${totals.steps}`);
console.log(`  total re-send cost         ${totals.resendTokens} tokens`);
console.log(
  `  from tool results          ${totals.toolResendTokens} tokens  (${toolShare.toFixed(1)}% of all re-send cost, ${totals.toolCount} results)`,
);
console.log(
  `  from AGED tool results     ${totals.agedToolResendTokens} tokens  (${agedShare.toFixed(1)}%)  ` +
    `${totals.agedToolCount} results, ${totals.agedToolTokens} tokens of raw text`,
);

console.log('\n=== Aged re-send cost by tool ===\n');
const rows = [...perTool.entries()].sort((left, right) => right[1].agedCost - left[1].agedCost);
console.log(`  ${'tool'.padEnd(18)}${'calls'.padStart(7)}${'aged'.padStart(7)}${'aged tokens'.padStart(14)}${'aged re-send'.padStart(15)}${'share'.padStart(9)}`);
for (const [tool, bucket] of rows) {
  if (bucket.agedCost === 0) continue;
  console.log(
    `  ${tool.padEnd(18)}${String(bucket.count).padStart(7)}${String(Math.round(bucket.count * 0)).padStart(7)}` +
      `${String(Math.round(bucket.tokens)).padStart(14)}${String(Math.round(bucket.agedCost)).padStart(15)}` +
      `${((bucket.agedCost / totals.resendTokens) * 100).toFixed(1).padStart(9)}%`,
  );
}

console.log('\n=== What an aged-result budget would recover ===\n');
console.log('  budget = ceiling applied to each aged tool result, in tokens');
console.log(`  ${'budget'.padStart(9)}${'recovered'.padStart(12)}${'of total'.padStart(11)}${'results hit'.padStart(13)}`);
for (const budget of [500, 1000, 2000, 4000, 8000]) {
  let recovered = 0;
  let hit = 0;
  for (const entry of totals.largestAged) {
    if (entry.tokens <= budget) continue;
    hit++;
    // The model has already consumed this result; what remains is a pointer.
    recovered += (entry.tokens - budget) * entry.remaining;
  }
  console.log(
    `${String(budget).padStart(9)}${String(Math.round(recovered)).padStart(12)}` +
      `${((recovered / totals.resendTokens) * 100).toFixed(1).padStart(10)}%${String(hit).padStart(13)}`,
  );
}

console.log('\n=== Two places a budget can be applied ===\n');
console.log('  B) LATE / AGED (compaction-time): rewrites history the provider already');
console.log('     cached, so every later request re-processes the changed suffix.');
console.log('  A) FIRST ENTRY (tools/post-execute): the content has never been sent, so');
console.log('     bounding it breaks no KV prefix cache. Cost: the model may re-ask.');
console.log('');
console.log(`  ${'budget'.padStart(9)}${'B recovered'.padStart(14)}${'B of total'.padStart(13)}${'A recovered'.padStart(14)}${'A of total'.padStart(13)}`);
for (const budget of [500, 1000, 2000, 4000, 8000]) {
  let agedRecovered = 0;
  for (const entry of totals.largestAged) {
    if (entry.tokens <= budget) continue;
    agedRecovered += (entry.tokens - budget) * entry.remaining;
  }
  // First-entry bounding applies to every result the model received, and the
  // saving repeats on every later step the result stays on the surface.
  let firstRecovered = 0;
  for (const entry of totals.allTools) {
    if (entry.tokens <= budget) continue;
    firstRecovered += (entry.tokens - budget) * entry.remaining;
  }
  console.log(
    `${String(budget).padStart(9)}${String(Math.round(agedRecovered)).padStart(14)}` +
      `${((agedRecovered / totals.resendTokens) * 100).toFixed(1).padStart(12)}%` +
      `${String(Math.round(firstRecovered)).padStart(14)}` +
      `${((firstRecovered / totals.resendTokens) * 100).toFixed(1).padStart(12)}%`,
  );
}

const payloadCounts = new Map();
for (const entry of totals.allTools) payloadCounts.set(entry.digest, (payloadCounts.get(entry.digest) ?? 0) + 1);
const reAsked = [...payloadCounts.values()].filter((count) => count > 1).length;
console.log(
  `\n  ${totals.allTools.length} results carried ${payloadCounts.size} distinct payloads; ` +
    `${reAsked} payloads were delivered more than once.`,
);
console.log(
  '  → Bounding at first entry therefore needs an escape hatch: a repeated\n' +
    '    identical call must return full text, or the model can never recover a cut.',
);

console.log('\n=== Simulated billing effect of the shipped defaults ===\n');
{
  // Apply the kernel to every real tool result exactly as the plugin would at
  // first entry, then weight each result's saving by how many later requests
  // would have re-sent it. That weighted figure is what the invoice sees.
  let weightedBefore = 0;
  let weightedAfter = 0;
  let touched = 0;
  const perToolSim = new Map();
  for (const entry of totals.allTools) {
    const slimmed = slimContent([{ type: 'text', text: entry.text }], entry.tool, options);
    const after = slimmed === null ? entry.tokens : slimmed.stats.tokensOut;
    if (slimmed !== null) touched++;
    weightedBefore += entry.tokens * entry.remaining;
    weightedAfter += after * entry.remaining;
    const bucket = perToolSim.get(entry.tool) ?? { before: 0, after: 0, hit: 0 };
    bucket.before += entry.tokens * entry.remaining;
    bucket.after += after * entry.remaining;
    if (slimmed !== null) bucket.hit++;
    perToolSim.set(entry.tool, bucket);
  }
  console.log(`  ${'tool'.padEnd(18)}${'results'.padStart(9)}${'slimmed'.padStart(9)}${'weighted before'.padStart(17)}${'weighted after'.padStart(16)}${'saved'.padStart(9)}`);
  for (const [tool, bucket] of [...perToolSim.entries()].sort((l, r) => r[1].before - l[1].before)) {
    if (bucket.hit === 0) continue;
    console.log(
      `  ${tool.padEnd(18)}${String(totals.allTools.filter((e) => e.tool === tool).length).padStart(9)}` +
        `${String(bucket.hit).padStart(9)}${String(Math.round(bucket.before)).padStart(17)}` +
        `${String(Math.round(bucket.after)).padStart(16)}` +
        `${(((bucket.before - bucket.after) / bucket.before) * 100).toFixed(1).padStart(8)}%`,
    );
  }
  const savedPct = ((weightedBefore - weightedAfter) / weightedBefore) * 100;
  console.log(
    `\n  weighted tool-result cost  ${Math.round(weightedBefore)} -> ${Math.round(weightedAfter)} tokens  ` +
      `(${savedPct.toFixed(1)}% saved)`,
  );
  console.log(`  ${touched} of ${totals.allTools.length} results changed; the rest passed through byte-identical`);
  const sessionWide = (savedPct * totals.toolResendTokens) / totals.resendTokens;
  console.log(
    `  tool results are ${((totals.toolResendTokens / totals.resendTokens) * 100).toFixed(1)}% of all re-send cost, ` +
      `so the session-wide reduction is ≈ ${sessionWide.toFixed(1)}%`,
  );
}

console.log('\n=== Reasoning blocks (the surface no bound currently covers) ===\n');
{
  // `totals.resendTokens` counts visible text only, so the denominator here is
  // the sum of both surfaces. Reporting reasoning against the text-only total
  // would overstate it — the same mistake as trusting a compression ratio
  // without checking what it removed.
  const combined = totals.resendTokens + totals.reasoningResendTokens;
  console.log(
    `  ${totals.reasoningEntries} assistant messages carried reasoning, ` +
      `${totals.reasoningTokens} tokens of raw reasoning text`,
  );
  console.log(
    `  re-sent on every later step: ${totals.reasoningResendTokens} tokens  ` +
      `(${((totals.reasoningResendTokens / combined) * 100).toFixed(1)}% of ALL re-send cost)`,
  );
  console.log(
    `  visible tool/message text:   ${totals.resendTokens} tokens  ` +
      `(${((totals.resendTokens / combined) * 100).toFixed(1)}%)`,
  );
  console.log(`  --- combined: ${combined} tokens ---`);
  console.log(
    '  → reasoning is assistant content, not a tool result, so tools/post-execute\n' +
      '    never sees it. Nothing in the DSH plugin set bounds this surface.',
  );
}

const top = totals.largestAged.sort((left, right) => right.cost - left.cost).slice(0, 8);
console.log('\n=== Largest aged offenders ===\n');
console.log(`  ${'tool'.padEnd(14)}${'tokens'.padStart(10)}${'steps left'.padStart(12)}${'re-send cost'.padStart(15)}  digest`);
for (const entry of top) {
  console.log(
    `  ${entry.tool.padEnd(14)}${String(entry.tokens).padStart(10)}${String(entry.remaining).padStart(12)}` +
      `${String(Math.round(entry.cost)).padStart(15)}  ${entry.digest}`,
  );
}
console.log('');
