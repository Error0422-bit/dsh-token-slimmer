/**
 * Budget comparison over real recorded sessions.
 *
 * Answers one question with data instead of taste: how much does the tool-result
 * ceiling actually buy, and what does lowering it cost? Run it after changing a
 * default so the new number is measured rather than asserted.
 *
 * Usage: node test/budget-swap.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

import { resolveOptions, slimContent } from '../slim.js';

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/a/.dsh';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Budget pairs to compare. */
const CANDIDATES = [
  { label: '4000 / 12000', config: { maxResultTokens: 4000, readMaxResultTokens: 12000 } },
  { label: '3000 / 8000', config: { maxResultTokens: 3000, readMaxResultTokens: 8000 } },
  { label: '2000 / 5000', config: { maxResultTokens: 2000, readMaxResultTokens: 5000 } },
  { label: '1500 / 4000', config: { maxResultTokens: 1500, readMaxResultTokens: 4000 } },
];

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

/** Every `{ tool, text }` tool result across the given logs. */
function collectResults(logs) {
  const out = [];
  for (const log of logs) {
    let raw;
    try {
      raw = decompressTranscript(readFileSync(log.path));
    } catch {
      continue;
    }
    const names = new Map();
    const results = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'tool/call') {
        if (typeof event.data?.callId === 'string') names.set(event.data.callId, event.data.name);
        continue;
      }
      if (event.type !== 'tool/result') continue;
      const message = event.data?.message;
      if (message === undefined) continue;
      const text = (message.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (text.length === 0) continue;
      const callId = message.toolCallId ?? message.source?.callId;
      results.push({ tool: names.get(callId) ?? 'unknown', text });
    }
    out.push(...results);
  }
  return out;
}

const results = collectResults(findLogs().slice(0, 8));
console.log(`\n=== Budget comparison over ${results.length} real tool results ===\n`);
console.log(`  ${'budget (generic/read)'.padEnd(24)}${'tokens in'.padStart(12)}${'tokens out'.padStart(12)}${'saved'.padStart(9)}${'results cut'.padStart(13)}`);

const rows = [];
for (const candidate of CANDIDATES) {
  const options = resolveOptions(candidate.config);
  let tokensIn = 0;
  let tokensOut = 0;
  let cut = 0;
  for (const result of results) {
    const slimmed = slimContent([{ type: 'text', text: result.text }], result.tool, options);
    if (slimmed === null) continue;
    tokensIn += slimmed.stats.tokensIn;
    tokensOut += slimmed.stats.tokensOut;
    cut++;
  }
  const savedPct = tokensIn === 0 ? 0 : ((tokensIn - tokensOut) / tokensIn) * 100;
  rows.push({ label: candidate.label, savedPct, cut, tokensIn, tokensOut });
  console.log(
    `  ${candidate.label.padEnd(24)}${String(tokensIn).padStart(12)}${String(tokensOut).padStart(12)}` +
      `${`${savedPct.toFixed(1)}%`.padStart(9)}${String(cut).padStart(13)}`,
  );
}

console.log('\n  "results cut" is how many of the results were touched at all.');
console.log('  A low count with a high saving means the ceiling only reaches genuine outliers.\n');
