/**
 * Human-inspection harness: show what the kernel actually does to real tool
 * output, so the compression ratio is never taken on trust.
 *
 * Prints the largest examples per tool side by side at a readable width, plus a
 * structural summary (blank runs, repeat runs, over-long lines) that explains
 * where the saving came from.
 *
 * Usage:
 *   node test/inspect.mjs [tool] [count]      # defaults: pwsh, 2
 *   node test/inspect.mjs web_fetch 1
 *   node test/inspect.mjs list                # every tool, biggest example only
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

import { resolveOptions, slimContent } from '../slim.js';

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/a/.dsh';
const options = resolveOptions({});
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

/** Every `{ tool, text }` pair recorded across the given logs. */
function collect(logs) {
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
      results.push(event);
    }
    for (const event of results) {
      const message = event.data?.message;
      if (message === undefined) continue;
      const text = (message.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (text.length === 0) continue;
      const callId = message.toolCallId ?? message.source?.callId;
      out.push({ tool: names.get(callId) ?? 'unknown', text });
    }
  }
  return out;
}

/** Structural description of one text payload. */
function anatomy(text) {
  const lines = text.split('\n');
  let blankRuns = 0;
  let longestBlankRun = 0;
  let run = 0;
  let repeatedRuns = 0;
  let longestRepeat = 0;
  let repeat = 0;
  let overLong = 0;
  let longestLine = 0;
  let previous = null;
  for (const line of lines) {
    longestLine = Math.max(longestLine, line.length);
    if (line.trim().length === 0) {
      run++;
      longestBlankRun = Math.max(longestBlankRun, run);
    } else {
      if (run > 1) blankRuns++;
      run = 0;
    }
    if (line.length > 400) overLong++;
    if (previous !== null && line === previous && line.trim().length > 0) {
      repeat++;
      longestRepeat = Math.max(longestRepeat, repeat + 1);
    } else {
      if (repeat > 0) repeatedRuns++;
      repeat = 0;
    }
    previous = line;
  }
  if (run > 1) blankRuns++;
  if (repeat > 0) repeatedRuns++;
  return {
    lines: lines.length,
    longestLine,
    overLong,
    blankRuns,
    longestBlankRun,
    repeatedRuns,
    longestRepeat,
  };
}

/** Truncate one side of a diff view without hiding its shape. */
function clip(text, width) {
  const lines = text.split('\n');
  if (lines.length <= width) return text;
  const head = lines.slice(0, Math.floor(width * 0.6));
  const tail = lines.slice(-Math.floor(width * 0.4));
  return [...head, `        ⋯ [${lines.length - head.length - tail.length} lines hidden by this viewer] ⋯`, ...tail].join('\n');
}

const args = process.argv.slice(2);
const mode = args[0] ?? 'pwsh';
const count = Number(args[1] ?? 2);
const all = collect(findLogs().slice(0, 6));
const byTool = new Map();
for (const entry of all) {
  if (!byTool.has(entry.tool)) byTool.set(entry.tool, []);
  byTool.get(entry.tool).push(entry);
}

const tools = mode === 'list' ? [...byTool.keys()] : [mode];
for (const tool of tools) {
  const entries = (byTool.get(tool) ?? []).sort((left, right) => right.text.length - left.text.length);
  if (entries.length === 0) {
    console.log(`\n### ${tool}: no samples`);
    continue;
  }
  const limit = mode === 'list' ? 1 : count;
  for (const entry of entries.slice(0, limit)) {
    const slimmed = slimContent([{ type: 'text', text: entry.text }], tool, options);
    const after = slimmed === null ? entry.text : slimmed.blocks[0].text;
    const before = anatomy(entry.text);
    const post = anatomy(after);
    console.log(`\n${'='.repeat(78)}`);
    console.log(`### ${tool} — ${entry.text.length} -> ${after.length} chars`);
    console.log(
      `    before: ${before.lines} lines, longest ${before.longestLine} chars, ` +
        `${before.overLong} over-long, ${before.blankRuns} blank runs (max ${before.longestBlankRun}), ` +
        `${before.repeatedRuns} repeat runs (max ${before.longestRepeat})`,
    );
    console.log(
      `    after:  ${post.lines} lines, longest ${post.longestLine} chars, ` +
        `${post.overLong} over-long, ${post.blankRuns} blank runs, ${post.repeatedRuns} repeat runs`,
    );
    if (slimmed !== null) {
      const s = slimmed.stats;
      console.log(
        `    transforms: ${s.carriageReturnsDropped} CR, ${s.trailingWhitespaceDropped} trailing-ws chars, ` +
          `${s.identicalLinesFolded} folded-repeat lines, ${s.blankLinesFolded} folded-blank lines, ` +
          `${s.linesTruncated} truncated lines`,
      );
    }
    console.log(`\n--- BEFORE (${entry.text.length} chars) ---`);
    console.log(clip(entry.text, 40));
    console.log(`\n--- AFTER (${after.length} chars) ---`);
    console.log(clip(after, 40));
  }
}
console.log('');
