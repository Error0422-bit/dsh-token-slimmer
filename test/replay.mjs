/**
 * Replay real tool results out of a recorded session log.
 *
 * This is the honest denominator for the slimmer: instead of synthetic
 * fixtures it decompresses a real `session.v4.jsonl.zstd` transcript, extracts
 * every `tool/result` event the model actually saw, and reports both the
 * size distribution per tool and what the kernel would have removed.
 *
 * Usage:
 *   node test/replay.mjs                 # largest non-current session under $DSH_HOME
 *   node test/replay.mjs <log.zstd> ...  # explicit logs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

import { estimateTokens, resolveOptions, slimContent, shortDigest } from '../slim.js';

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/a/.dsh';
const SESSIONS = join(DSH_HOME, 'sessions');
const options = resolveOptions({});

/** Every `.jsonl.zstd` transcript under the sessions tree, largest first. */
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
  walk(SESSIONS);
  return found.sort((left, right) => right.size - left.size);
}

/** Concatenate every text block of one message payload. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decompress a transcript that persists as a sequence of appended zstd frames.
 * `zstdDecompressSync` stops after the first frame, so frames are located by
 * magic number and decoded individually; a magic-number byte pattern occurring
 * inside frame content simply fails to decode and is skipped.
 * @param {Buffer} buffer - raw `.jsonl.zstd` bytes.
 * @returns {string} the concatenated JSONL text.
 */
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
      // Not a frame header.
    }
  }
  return Buffer.concat(pieces).toString('utf8');
}

/** Pull `{ tool, text, args }` out of every tool/result line of one transcript. */
function extractResults(raw) {
  const results = [];
  const callById = new Map();
  const pending = [];
  let events = 0;
  let sample;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    events++;
    if (event.type === 'tool/call') {
      const callId = event.data?.callId;
      if (typeof callId === 'string') {
        callById.set(callId, {
          name: event.data?.name,
          args: typeof event.data?.arguments === 'string' ? event.data.arguments : '',
        });
      }
      continue;
    }
    if (event.type !== 'tool/result') continue;
    if (sample === undefined) sample = JSON.stringify(event);
    pending.push(event);
  }
  for (const event of pending) {
    const message = event.data?.message;
    if (message === undefined) continue;
    const text = textOf(message.content);
    if (text.length === 0) continue;
    const callId = message.toolCallId ?? message.source?.callId;
    const call = callId === undefined ? undefined : callById.get(callId);
    results.push({
      tool: toolNameOf(event, message, call?.name),
      args: call?.args ?? '',
      text,
    });
  }
  return { results, events, sample };
}

/** Resolve the producing tool's name across the transcript's recorded shapes. */
function toolNameOf(event, message, resolved) {
  return (
    resolved ??
    message.source?.toolName ??
    event.data?.toolName ??
    event.data?.name ??
    event.data?.call?.name ??
    'unknown'
  );
}

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2).map((path) => ({ path })) : findLogs().slice(0, 3);
if (targets.length === 0) {
  console.log('no session logs found');
  process.exit(0);
}

console.log('\n=== Real tool results replayed from recorded sessions ===\n');

const perTool = new Map();
const probes = [];
let grandIn = 0;
let grandOut = 0;
let grandCount = 0;
let unchanged = 0;
let replayable = 0;
let repeatResults = 0;
let repeatTokens = 0;
let firstSeen = 0;
let firstSeenTokens = 0;

for (const target of targets) {
  let raw;
  try {
    raw = decompressTranscript(readFileSync(target.path));
  } catch (error) {
    console.log(`  skip ${target.path}: ${error.message}`);
    continue;
  }
  const { results, events, sample } = extractResults(raw);
  if (results.some((result) => result.tool === 'unknown') && probes.length < 2) {
    if (sample !== undefined) probes.push(`tool/result: ${sample.slice(0, 700)}`);
  }
  if (results.length === 0) {
    console.log(`  no tool/result extracted from ${target.path}`);
    if (sample !== undefined) console.log(`  sample event: ${sample.slice(0, 1200)}`);
    continue;
  }
  let logIn = 0;
  let logOut = 0;
  const seenCalls = new Map();
  let logRepeat = 0;
  let logRepeatTokens = 0;
  let logIdentical = 0;
  for (const result of results) {
    const tokensIn = estimateTokens(result.text);
    // Repeat detection: same tool with byte-identical arguments, keyed by a
    // content digest, is exactly the case a session-scoped deduper can replace
    // with a pointer instead of re-sending the payload.
    const callKey = `${result.tool}\u0000${result.args}`;
    const digest = shortDigest(result.text);
    const prior = seenCalls.get(callKey);
    if (prior === undefined) {
      seenCalls.set(callKey, digest);
      firstSeen++;
      firstSeenTokens += tokensIn;
    } else {
      repeatResults++;
      repeatTokens += tokensIn;
      logRepeat++;
      logRepeatTokens += tokensIn;
      if (prior === digest) logIdentical++;
    }
    const slimmed = slimContent([{ type: 'text', text: result.text }], result.tool, options);
    const tokensOut = slimmed === null ? tokensIn : slimmed.stats.tokensOut;
    logIn += tokensIn;
    logOut += tokensOut;
    grandIn += tokensIn;
    grandOut += tokensOut;
    grandCount++;
    if (slimmed === null) unchanged++;
    else replayable++;
    const bucket = perTool.get(result.tool) ?? { count: 0, tokensIn: 0, tokensOut: 0, chars: 0 };
    bucket.count++;
    bucket.tokensIn += tokensIn;
    bucket.tokensOut += tokensOut;
    bucket.chars += result.text.length;
    perTool.set(result.tool, bucket);
  }
  const name = target.path.split(/[\\/]/).slice(-2, -1)[0] ?? target.path;
  console.log(
    `  ${name.padEnd(46)} ${String(results.length).padStart(5)} results  ` +
      `${String(logIn).padStart(9)} -> ${String(logOut).padStart(9)} tokens  ${pct(logIn, logOut)}`,
  );
  console.log(
    `  ${''.padEnd(46)} ${String(events).padStart(5)} log events | ` +
      `${logRepeat} repeated calls (${logIdentical} byte-identical) = ${logRepeatTokens} tokens`,
  );
}

console.log('\n=== By tool (all replayed sessions) ===\n');
const rows = [...perTool.entries()].sort((left, right) => right[1].tokensIn - left[1].tokensIn);
console.log(`  ${'tool'.padEnd(18)}${'calls'.padStart(7)}${'avg tokens'.padStart(12)}${'total in'.padStart(12)}${'total out'.padStart(12)}${'saved'.padStart(9)}`);
for (const [tool, bucket] of rows) {
  console.log(
    `  ${tool.padEnd(18)}${String(bucket.count).padStart(7)}` +
      `${String(Math.round(bucket.tokensIn / bucket.count)).padStart(12)}` +
      `${String(bucket.tokensIn).padStart(12)}${String(bucket.tokensOut).padStart(12)}` +
      `${pct(bucket.tokensIn, bucket.tokensOut).padStart(9)}`,
  );
}

console.log(
  `\n  ${grandCount} tool results, ${grandIn} -> ${grandOut} tokens, overall ${pct(grandIn, grandOut)}`,
);
console.log(`  ${replayable} results changed, ${unchanged} passed through untouched`);
console.log(
  `  repeat surface: ${repeatResults} of ${grandCount} calls re-issued an existing ` +
    `(tool, arguments) pair, carrying ${repeatTokens} tokens`,
);
console.log(
  `  first-time surface: ${firstSeen} calls / ${firstSeenTokens} tokens` +
    (repeatTokens > 0 ? `  → dedup ceiling ≈ ${pct(repeatTokens + grandOut, grandOut)} of all result tokens` : ''),
);
if (rows.length > 0) {
  const heaviest = rows[0];
  console.log(
    `  heaviest surface: ${heaviest[0]} (${heaviest[1].count} calls, ${heaviest[1].tokensIn} tokens)`,
  );
}
console.log(`  digest sample: ${shortDigest(String(grandIn))}\n`);
if (probes.length > 0) {
  console.log('=== event shape probe (tools still unresolved) ===\n');
  for (const probe of probes) console.log(`${probe}\n`);
}

/** Percent of input tokens removed. */
function pct(before, after) {
  if (before === 0) return '0.0%';
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}
