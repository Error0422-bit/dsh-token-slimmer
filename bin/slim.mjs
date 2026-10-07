#!/usr/bin/env node
/**
 * Portable entry point for the slimming kernel and its recovery store.
 *
 * The kernel is pure functions with no harness dependency, so the only thing
 * binding it to DSH is where it is called from. This CLI is the smallest bridge
 * that makes it usable anywhere else — any agent that can run a shell command,
 * any hook that can pipe text.
 *
 *   cat huge.log | slim --budget 2000
 *   slim --file build.log --type log
 *   slim --json < output.txt                  # stats on stdout, text on stderr
 *   slim --kind read --budget 12000 < result.txt
 *   slim --full < output.txt                  # pass through, no transform
 *   slim --save-original ./store < out.txt    # keep the original, then bound
 *   slim --restore <artifact-id> --store ./store [--offset 1 --limit 50]
 *
 * Exit codes: 0 when the input was bounded, 3 when it passed through unchanged,
 * 1 on a usage or recovery error. `3` is not a failure: it means there was
 * nothing worth doing, which a caller that only wants the text can ignore.
 *
 * @module dsh-token-slimmer/cli
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { detectContentType, hasAnalysisIntent, resolvePolicy } from '../policy.js';
import { createRecoveryStore, RecoveryError } from '../recovery-store.js';
import { resolveOptions, slimGenericText, slimReadText } from '../slim.js';

/** Parse `--flag value` and `--flag` pairs without pulling in a dependency. */
function parseArgs(argv) {
  const out = {
    kind: 'generic',
    json: false,
    full: false,
    intent: false,
    file: null,
    budget: null,
    type: null,
    saveOriginal: null,
    restore: null,
    store: null,
    block: null,
    offset: null,
    limit: null,
  };
  /** Flags that consume the next argument. */
  const takesValue = new Map([
    ['--budget', 'budget'],
    ['-b', 'budget'],
    ['--kind', 'kind'],
    ['-k', 'kind'],
    ['--type', 'type'],
    ['-t', 'type'],
    ['--file', 'file'],
    ['-f', 'file'],
    ['--save-original', 'saveOriginal'],
    ['--restore', 'restore'],
    ['--store', 'store'],
    ['--block', 'block'],
    ['--offset', 'offset'],
    ['--limit', 'limit'],
  ]);
  const numeric = new Set(['budget', 'block', 'offset', 'limit']);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--full') {
      out.full = true;
      continue;
    }
    if (arg === '--intent') {
      out.intent = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    const key = takesValue.get(arg);
    if (key !== undefined) {
      const raw = argv[++index];
      if (raw === undefined) {
        process.stderr.write(`slim: ${arg} needs a value\n`);
        process.exit(1);
      }
      out[key] = numeric.has(key) ? Number(raw) : raw;
      if (numeric.has(key) && !Number.isFinite(out[key])) {
        process.stderr.write(`slim: ${arg} needs a number, got ${raw}\n`);
        process.exit(1);
      }
      continue;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`slim: unknown flag "${arg}"\n`);
      process.exit(1);
    }
    out.file = arg;
  }
  return out;
}

const USAGE = `slim — bound tool output before it reaches an LLM context

Usage:
  slim [options] [file]        read stdin when no file is given

Budgeting:
  -b, --budget <tokens>   token budget for the result (default: 2000 passive, 5000 read)
  -k, --kind <kind>       "read" for read-tool envelopes, else "generic"
  -t, --type <type>       force a content type instead of detecting one
      --intent            treat the caller's request as analysis (doubles budget)
      --json              print stats to stdout and the text to stderr
      --full              write the input through with no transform at all

Recovery:
      --save-original <dir>   store the original before bounding, print its artifact id
      --store <dir>           the directory a store lives in
      --restore <artifact-id> write the saved original back out instead of bounding
      --block <index>         which saved block to restore (default: the first)
      --offset <line>         first line to restore, 1-based (default: 1)
      --limit <lines>         how many lines to restore (default: to the end)

  -h, --help              this message

Content types: diff, json, log, search, table, code, text

Notes:
  A restored original is written byte-for-byte: no trailing newline is added,
  and no transform is applied. Recovery reads the snapshot taken when
  --save-original ran; it never re-runs the command that produced the text, so
  it cannot recover output that was never saved.
`;

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  process.stdout.write(USAGE);
  process.exit(0);
}

/** Write text exactly as given, adding nothing. */
function writeRaw(text) {
  process.stdout.write(text);
}

// ---------------------------------------------------------------------------
// Restore mode: read a snapshot back and stop.
// ---------------------------------------------------------------------------

if (args.restore !== null) {
  if (args.store === null) {
    process.stderr.write('slim: --restore needs --store <directory>\n');
    process.exit(1);
  }
  const store = createRecoveryStore({ rootDir: args.store });
  try {
    const result = store.read({
      artifactId: args.restore,
      blockIndex: args.block ?? undefined,
      offset: args.offset ?? 1,
      limit: args.limit ?? undefined,
    });
    writeRaw(result.text);
    if (args.json === true) {
      process.stderr.write(
        `${JSON.stringify(
          {
            artifactId: args.restore,
            path: result.path,
            offset: result.offset,
            totalLines: result.totalLines,
          },
          null,
          2,
        )}\n`,
      );
    }
    // Nothing was rewritten and nothing was lost, so this is not the "unchanged"
    // code: the caller asked for a file and got it.
    process.exit(0);
  } catch (error) {
    const code = error instanceof RecoveryError ? error.code : 'UNKNOWN';
    process.stderr.write(`slim: restore failed (${code}): ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Read the input.
// ---------------------------------------------------------------------------

let input;
try {
  input = args.file === null ? readFileSync(0, 'utf8') : readFileSync(args.file, 'utf8');
} catch (error) {
  process.stderr.write(`slim: cannot read input: ${String(error)}\n`);
  process.exit(1);
}

if (input.length === 0) process.exit(3);

// `--full` is a promise about the bytes, not about the tool: it writes exactly
// what it was handed and claims nothing about output it never saw.
if (args.full === true) {
  writeRaw(input);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Bound the input, optionally keeping the original first.
// ---------------------------------------------------------------------------

const kind = args.kind === 'read' ? 'read' : 'generic';
const options = resolveOptions(
  args.budget === null
    ? {}
    : kind === 'read'
      ? { readMaxResultTokens: args.budget }
      : { maxResultTokens: args.budget },
);

// `--type` and `--intent` must reach the kernel, not just the stats output.
// Passing them only into the report was a real defect: the flags parsed, the
// JSON claimed a policy, and the compression ignored both.
const detected = args.type ?? detectContentType(input);
const intent = args.intent || hasAnalysisIntent(input.slice(0, 2000));
const policy = resolvePolicy({
  contentType: detected,
  analysisIntent: intent,
  baseBudget: kind === 'read' ? options.readMaxResultTokens : options.maxResultTokens,
  toolName: kind === 'read' ? 'read' : undefined,
  options,
});
const result = kind === 'read' ? slimReadText(input, options, policy) : slimGenericText(input, options, policy);

// The original is persisted before the bounded text is published, and only when
// bounding actually removed something. A snapshot of an unchanged payload is
// just a copy.
let recovery = null;
let recoveryError = null;
if (args.saveOriginal !== null && result.changed) {
  try {
    const store = createRecoveryStore({ rootDir: args.saveOriginal });
    const saved = store.save({ sessionId: 'cli', callId: 'cli', blocks: [{ type: 'text', text: input }] });
    recovery = { artifactId: saved.artifactId, store: store.rootDir };
  } catch (error) {
    // A failed snapshot downgrades the run: the bounded text is still usable,
    // but nobody may claim the original is recoverable from here.
    recoveryError = error instanceof Error ? error.message : String(error);
  }
}

// The text goes out byte-for-byte as produced; no trailing newline is invented.
const sink = args.json === true ? process.stderr : process.stdout;
sink.write(result.text);

if (args.json === true) {
  process.stdout.write(
    `${JSON.stringify(
      {
        type: detected,
        analysisIntent: intent,
        changed: result.changed,
        linesIn: result.stats.linesIn,
        linesOut: result.stats.linesOut,
        tokensIn: result.stats.tokensIn,
        tokensOut: result.stats.tokensOut,
        omittedLines: result.stats.omittedLines,
        budgetExceeded: result.stats.budgetExceeded === true,
        overflowReason: result.stats.overflowReason ?? null,
        recovery,
        recoveryUnavailable: recoveryError,
        savedPercent:
          result.stats.tokensIn === 0
            ? 0
            : Number(
                (((result.stats.tokensIn - result.stats.tokensOut) / result.stats.tokensIn) * 100).toFixed(2),
              ),
      },
      null,
      2,
    )}\n`,
  );
}

process.exit(result.changed ? 0 : 3);
