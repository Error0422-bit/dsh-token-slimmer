/**
 * dsh-token-slimmer — deterministic, model-free context slimming kernel.
 *
 * Design contract:
 *  1. Every transform is either lossless or leaves an in-band marker naming
 *     exactly what was removed, so the model can always tell what it is missing.
 *  2. Nothing here calls a model, touches the network, or reads the filesystem.
 *     A compression step that costs a model call is a net loss on short inputs.
 *  3. Transforms run before content first enters the request, never after.
 *     Rewriting already-sent history invalidates the KV prefix cache; slimming
 *     the first occurrence does not.
 *  4. Every transform is optional and every output carries a measurement, so a
 *     change that does not actually shrink the text is discarded rather than
 *     applied.
 *
 * @module dsh-token-slimmer/slim
 */

import { planResultBudget, selectByImportance } from './importance.js';
import { detectContentType, resolvePolicy } from './policy.js';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Test one UTF-16 code unit for membership in the ranges where DeepSeek-family
 * tokenizers spend roughly one token per code point (CJK, kana, fullwidth).
 * @param {number} code - UTF-16 code unit.
 * @returns {boolean} whether the code point is token-dense.
 */
function isWideCode(code) {
  return (
    (code >= 0x2e80 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/** Latin/digit/space characters per token, measured on DeepSeek-family text. */
const NARROW_CHARS_PER_TOKEN = 3.6;

/**
 * Estimate the token cost of one string. Deliberately an over-estimate for
 * narrow text and an on-par estimate for wide text, so reported savings never
 * look better than reality.
 * @param {string} text - text to price.
 * @returns {number} estimated tokens, rounded up.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let wide = 0;
  let narrow = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isWideCode(code)) wide++;
    else narrow++;
  }
  return Math.ceil(wide + narrow / NARROW_CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Low-friction defaults tuned for a coding agent's tool surface. */
export const DEFAULTS = Object.freeze({
  /** Master switch; false makes the plugin a no-op. */
  enabled: true,
  /**
   * Drop the carriage return of CRLF input.
   *
   * Off by default, and the reason matters. `resolveTransforms` gates these on
   * an explicit `=== true`, precisely so that fidelity is what a caller gets
   * without asking — but the shipped defaults were `true`, so the gate was
   * vacuous and any result detected as `log` silently lost its CRLF, its
   * trailing whitespace and its repeated runs with no omission marker. The
   * default has to be the faithful value or the gate is decoration.
   */
  stripCarriageReturns: false,
  /** Drop spaces and tabs at end of line. Off by default for the same reason. */
  stripTrailingWhitespace: false,
  /** Replace long runs of byte-identical lines with one line plus a count. Off by default. */
  foldRepeatedLines: false,
  /** Minimum run length before identical lines are folded. */
  repeatedLineMinRun: 4,
  /** Minimum line length eligible for identical-run folding (protects `}` and short braces). */
  repeatedLineMinChars: 16,
  /**
   * Fold runs of lines that are identical after masking digits, hex ids, uuids,
   * timestamps and quoted strings. Much stronger on logs; off by default because
   * the replacement no longer shows every original value.
   */
  foldTemplatedLines: false,
  /** Minimum run length before template-equivalent lines are folded. */
  templatedLineMinRun: 3,
  /** Collapse a longer run of blank lines down to this many. */
  maxConsecutiveBlankLines: 2,
  /**
   * Truncate lines longer than this in non-`read` results (0 disables).
   * Off by default, and this default is load-bearing: real transcripts show
   * shell output dominated by hex/ascii dumps, base64 payloads and API JSON,
   * where a long line *is* the payload. Cutting it destroys the result, the
   * model re-runs the command, and the session pays more than it saved.
   */
  genericMaxLineChars: 0,
  /** Truncate lines longer than this in `read` results (0 disables). Same reasoning. */
  readMaxLineChars: 0,
  /** Head characters kept when a single line is truncated. */
  truncatedLineHeadChars: 200,
  /**
   * Token ceiling for one tool result the model did not explicitly size, such
   * as a shell command or a fetched page (0 disables).
   *
   * These defaults come from measuring this machine's own transcripts rather
   * than from intuition; `node test/budget-swap.mjs` reproduces the comparison,
   * and `node test/perf.mjs` shows the cost only lands on results that actually
   * exceed the ceiling.
   *
   * Lowering the ceiling is close to free because the scoring layer keeps
   * errors, numeric outliers, structural markers and novel lines additively,
   * independent of the budget: the ceiling decides how much of the *disposable*
   * remainder survives, and moving it barely widens the set of results affected.
   */
  maxResultTokens: 2000,
  /**
   * Token ceiling for a `read` result (0 disables).
   *
   * Higher than the passive ceiling on purpose: `read` output is content the
   * model asked for by path, usually to edit it, and the tool's own
   * `readMaxBytes` is a deliberate deployment setting. The marker hands back the
   * exact `offset` to resume, and a repeated identical read returns the whole
   * text, so a model that needs the full file can always get it.
   */
  readMaxResultTokens: 5000,
  /**
   * Share of the budget reserved for the opening and closing guarantees before
   * scoring distributes the rest. Structure usually lives at the top of a file
   * or the start of a log, and the closing lines carry the outcome.
   */
  headBudgetRatio: 0.55,
  /**
   * A single line longer than this makes the whole result ineligible for
   * bounding.
   *
   * Long lines are payloads — base64 file bodies from an API response, hex
   * dumps from a protocol trace, a minified bundle. They cannot be split
   * usefully: keeping the head and tail of such a result hands the model half a
   * payload it cannot use, which is strictly worse than either delivering it or
   * spilling it. Measured transcripts show exactly this case, where bounding
   * turned an 18 KB GitHub API response into a four-line header.
   */
  payloadLineGuardChars: 2000,
  /**
   * A repeated call with byte-identical arguments returns its result untouched.
   *
   * Off by default, and the name is why. It does not recover anything: it
   * re-runs the tool, so a result derived from a clock, a counter, a live
   * service or a mutable file comes back different — or does not come back at
   * all. It stays available as a compatibility option for callers whose second
   * execution is known to be identical, but the recovery path is
   * `recovery-store.js`, and the in-band marker now points there instead of
   * promising this.
   */
  fullTextOnRepeat: false,
});

const NUMERIC_KEYS = new Set([
  'repeatedLineMinRun',
  'repeatedLineMinChars',
  'templatedLineMinRun',
  'maxConsecutiveBlankLines',
  'genericMaxLineChars',
  'readMaxLineChars',
  'truncatedLineHeadChars',
  'maxResultTokens',
  'readMaxResultTokens',
  'payloadLineGuardChars',
]);

const BOOLEAN_KEYS = new Set([
  'enabled',
  'stripCarriageReturns',
  'stripTrailingWhitespace',
  'foldRepeatedLines',
  'foldTemplatedLines',
  'fullTextOnRepeat',
]);

/**
 * Validate and freeze a raw option bag, failing loudly on unknown keys.
 * @param {object} [raw] - options supplied through the plugin config.
 * @returns {Readonly<typeof DEFAULTS>} the resolved option set.
 */
export function resolveOptions(raw) {
  const input = raw ?? {};
  const out = { ...DEFAULTS };
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULTS)) throw new Error(`token-slimmer: unknown option "${key}"`);
    const value = input[key];
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`token-slimmer: "${key}" must be a boolean`);
    } else if (NUMERIC_KEYS.has(key)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`token-slimmer: "${key}" must be a non-negative integer`);
      }
    }
    out[key] = value;
  }
  const ratio = input.headBudgetRatio;
  if (ratio !== undefined) {
    if (typeof ratio !== 'number' || !(ratio > 0 && ratio < 1)) {
      throw new Error('token-slimmer: "headBudgetRatio" must be a number strictly between 0 and 1');
    }
    out.headBudgetRatio = ratio;
  }
  if (out.repeatedLineMinRun < 2) throw new Error('token-slimmer: "repeatedLineMinRun" must be at least 2');
  if (out.templatedLineMinRun < 2) throw new Error('token-slimmer: "templatedLineMinRun" must be at least 2');
  if (out.truncatedLineHeadChars < 1) {
    throw new Error('token-slimmer: "truncatedLineHeadChars" must be at least 1');
  }
  return Object.freeze(out);
}

/** Zeroed per-call counters, shared by both pipelines. */
function emptyStats() {
  return {
    charsIn: 0,
    charsOut: 0,
    tokensIn: 0,
    tokensOut: 0,
    linesIn: 0,
    linesOut: 0,
    carriageReturnsDropped: 0,
    trailingWhitespaceDropped: 0,
    linesTruncated: 0,
    charsTruncated: 0,
    identicalLinesFolded: 0,
    templatedLinesFolded: 0,
    blankLinesFolded: 0,
    omittedLines: 0,
    omittedTokens: 0,
    protectedLines: 0,
    budgetExceeded: false,
    overflowReason: null,
    /**
     * Dense payload lines that truncation left whole.
     *
     * Counted so the exemption is visible in the stats rather than silent: a
     * deployer who set a line ceiling and sees this figure knows the ceiling
     * declined to destroy something it could not replace.
     */
    payloadLinesPreserved: 0,
    /**
     * Blocks that reported their omission as the bare terse marker.
     *
     * A share too small to describe what it dropped says less rather than
     * spending more than it has, which keeps overhead from scaling with the
     * block count — but a bare marker explains nothing on its own, so
     * `slimContent` merges them into one note for the whole result.
     */
    terseMarkers: 0,
  };
}

/**
 * Add `addend` into `target` in place, type-aware.
 *
 * Counters accumulate; booleans latch; everything else overwrites. A blind `+=`
 * would silently turn `budgetExceeded: false` into `0` and lose the fact that a
 * bound overflowed, which is exactly the signal a caller needs in order to know
 * the result is larger than its budget.
 */
function mergeStats(target, addend) {
  for (const key of Object.keys(addend)) {
    const value = addend[key];
    if (typeof value === 'boolean') target[key] = target[key] === true || value;
    else if (typeof value === 'number') target[key] += value;
    else if (value !== null && value !== undefined) target[key] = value;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Line transforms
// ---------------------------------------------------------------------------

/**
 * The transforms a payload receives when no policy says otherwise: none.
 *
 * Conservative by construction so that calling a lower-level helper directly —
 * in a test, from another integration, or after a refactor — cannot silently
 * reintroduce the whitespace damage the fidelity work removed.
 */
const CONSERVATIVE_TRANSFORMS = Object.freeze({
  stripCarriageReturns: false,
  stripTrailingWhitespace: false,
  foldRepeatedLines: false,
  foldBlankRuns: false,
});

/**
 * Normalize line endings and trailing whitespace, but only where allowed.
 * @param {string} text - body text.
 * @param {Readonly<typeof DEFAULTS>} options - resolved options.
 * @param {ReturnType<typeof emptyStats>} stats - counters to update.
 * @param {object} [transforms] - allowed transforms, defaulting to none.
 * @returns {string} the normalized body.
 */
function normalize(text, options, stats, transforms = CONSERVATIVE_TRANSFORMS) {
  let out = text;
  if (transforms.stripCarriageReturns && out.includes('\r')) {
    const before = out.length;
    out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    stats.carriageReturnsDropped += before - out.length;
  }
  if (transforms.stripTrailingWhitespace) {
    const before = out.length;
    out = out.replace(/[ \t]+(?=\n)/g, '').replace(/[ \t]+$/, '');
    stats.trailingWhitespaceDropped += before - out.length;
  }
  return out;
}

/**
 * Fold runs of byte-identical lines, and optionally runs that become identical
 * once volatile substrings are masked. Blank runs are handled by
 * {@link foldBlankRuns}, so they are skipped here.
 * @param {string[]} lines - body lines.
 * @param {Readonly<typeof DEFAULTS>} options - resolved options.
 * @param {ReturnType<typeof emptyStats>} stats - counters to update.
 * @returns {string[]} folded lines.
 */
function foldRepeatedLines(lines, options, stats, transforms = CONSERVATIVE_TRANSFORMS) {
  if (!transforms.foldRepeatedLines && !options.foldTemplatedLines) return lines;
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trimEnd();

    // Byte-identical folding first: it preserves the actual repeated value.
    if (
      options.foldRepeatedLines &&
      trimmed.length >= options.repeatedLineMinChars &&
      /[A-Za-z0-9]/.test(trimmed)
    ) {
      const run = countIdentical(lines, index, trimmed);
      if (run >= options.repeatedLineMinRun) {
        out.push(trimmed, `⟪×${run} identical lines⟫`);
        stats.identicalLinesFolded += run - 1;
        index += run;
        continue;
      }
    }

    // Then template folding, and only when masking actually changed the line —
    // otherwise a run of short identical lines such as `}` would qualify.
    if (options.foldTemplatedLines && trimmed.length >= 8) {
      const key = templateOf(trimmed);
      if (key !== trimmed) {
        const run = countTemplated(lines, index, key);
        if (run >= options.templatedLineMinRun) {
          out.push(trimmed, `⟪×${run} identical-pattern lines⟫`);
          stats.templatedLinesFolded += run - 1;
          index += run;
          continue;
        }
      }
    }

    out.push(line);
    index++;
  }
  return out;
}

/** Count consecutive lines equal to `value` starting at `start`. */
function countIdentical(lines, start, value) {
  let count = 0;
  while (start + count < lines.length && lines[start + count].trimEnd() === value) count++;
  return count;
}

/** Mask volatile substrings so structurally identical lines compare equal. */
function templateOf(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>');
}

/** Count consecutive lines whose template equals `key` starting at `start`. */
function countTemplated(lines, start, key) {
  let count = 0;
  while (start + count < lines.length && templateOf(lines[start + count].trimEnd()) === key) count++;
  return count;
}

/**
 * Collapse runs of blank lines longer than the configured maximum.
 * @param {string[]} lines - body lines.
 * @param {Readonly<typeof DEFAULTS>} options - resolved options.
 * @param {ReturnType<typeof emptyStats>} stats - counters to update.
 * @returns {string[]} folded lines.
 */
function foldBlankRuns(lines, options, stats, transforms = CONSERVATIVE_TRANSFORMS) {
  if (!transforms.foldBlankRuns) return lines;
  const cap = options.maxConsecutiveBlankLines;
  if (cap < 0 || lines.length === 0) return lines;
  const out = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].trim().length !== 0) {
      out.push(lines[index]);
      index++;
      continue;
    }
    let run = 0;
    while (index + run < lines.length && lines[index + run].trim().length === 0) run++;
    const kept = Math.min(run, cap);
    for (let keptIndex = 0; keptIndex < kept; keptIndex++) out.push('');
    if (run > cap) {
      out.push(`⟪+${run - cap} blank lines⟫`);
      stats.blankLinesFolded += run - cap;
    }
    index += run;
  }
  return out;
}

/**
 * Non-space ratio above which a long line reads as one payload, not as text.
 *
 * `payloadLineGuardChars` exempts a result whose line exceeds 2000 characters,
 * on the reasoning that a very long line *is* the payload. A 1,500-character
 * base64 body sits just under that ceiling and was cut to head+tail anyway —
 * the model received half a payload it could not use, which is the same failure
 * the guard exists to prevent, one size class down. Density is the signal the
 * length threshold was standing in for: prose has spaces, encoded data does not.
 *
 * A CSV or SQL data row measures around 0.87 and is therefore still truncated.
 * That is the intended reading — such a line *is* text — and the truncation
 * marker now names its recovery path, so the loss is recoverable rather than
 * silent. Lowering the threshold to spare it would start exempting genuinely
 * opaque content.
 */
const PAYLOAD_DENSITY_THRESHOLD = 0.9;

/**
 * Whether a code point is CJK (or fullwidth punctuation), which counts as a
 * word break even though it is written without spaces.
 */
function isWordBreakCode(code) {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0xff00 && code <= 0xff60) // fullwidth forms
  );
}

/**
 * Whether a line reads as opaque data rather than prose.
 *
 * Whitespace is the primary signal. CJK counts as a break as well, and has to:
 * it is written without spaces, so a Chinese paragraph measures at a density of
 * 1.0 and `genericMaxLineChars` could never reach it at all. Every CJK character
 * is a word, which is exactly what the density test is looking for.
 *
 * @param {string} line - the line to judge.
 * @returns {boolean} true when it is dense enough to be a payload.
 */
export function looksLikePayload(line) {
  if (line.length === 0) return false;
  let breaks = 0;
  for (let index = 0; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if (code === 32 || code === 9 || isWordBreakCode(code)) breaks++;
  }
  return (line.length - breaks) / line.length >= PAYLOAD_DENSITY_THRESHOLD;
}

/**
 * Truncate over-long lines, keeping the head and a short tail so both the start
 * and the end of a minified or base64 payload stay visible.
 *
 * A line that reads as payload is left alone regardless of length: cutting it
 * produces something the reader cannot use and cannot check. The caller decides
 * whether that matters by choosing `maxChars`; this only refuses to make the
 * damage worse than the setting asked for.
 *
 * @param {string[]} lines - body lines.
 * @param {number} maxChars - per-line ceiling; 0 disables.
 * @param {Readonly<typeof DEFAULTS>} options - resolved options.
 * @param {ReturnType<typeof emptyStats>} stats - counters to update.
 * @param {string | null} [recoveryText] - instruction to name in the marker.
 * @returns {string[]} truncated lines.
 */
function truncateLongLines(lines, maxChars, options, stats, recoveryText = null) {
  if (maxChars <= 0) return lines;
  const head = Math.min(options.truncatedLineHeadChars, maxChars);
  const tail = Math.max(0, Math.floor((maxChars - head) / 4));
  return lines.map((line) => {
    if (line.length <= maxChars) return line;
    if (looksLikePayload(line)) {
      stats.payloadLinesPreserved += 1;
      return line;
    }
    const removed = line.length - head - tail;
    // The marker names the version and, when the caller supplied one, the way
    // back — every other omission in this kernel does, and a truncation that
    // says only "+N chars" leaves the reader with no move.
    const note = recoveryText === null ? '' : ` \u2014 ${recoveryText}`;
    const rebuilt = `${line.slice(0, head)}\u22ee\u27ea[... ${removed} chars omitted${note} (${SLIM_MARKER_VERSION})]\u27eb${tail > 0 ? line.slice(line.length - tail) : ''}`;
    stats.linesTruncated += 1;
    stats.charsTruncated += line.length - rebuilt.length;
    return rebuilt;
  });
}

/**
 * Marker written into every bounded payload.
 *
 * It is an *announcement*, not a receipt. An earlier revision also used a
 * versioned spelling of it to decide whether a payload had already been
 * processed, which made the text itself the source of truth: any ordinary
 * content that happened to contain the marker — prose about this file, a diff
 * of it, a log line quoting it — was treated as finished work and skipped
 * bounding entirely. The kernel is a pure function and does not need that
 * signal: the same input always yields the same output, so "already processed"
 * is answered by determinism, and anything a caller genuinely needs to know
 * about prior state belongs in the caller's own state, not in the bytes.
 */
const SLIM_MARKER_VERSION = 'slimmed v1';

/** The marker's version tag, exported so callers can anchor on it. */
export { SLIM_MARKER_VERSION };

/**
 * The sentence written where a recovery instruction goes on passive output.
 *
 * The kernel is pure and cannot know a path, so it emits this fixed text and
 * the plugin substitutes a real one once the original has been stored. Exported
 * so the two ends share one spelling instead of drifting literals.
 */
export const RECOVERY_NOTE =
  'the rest was not saved; re-run the command only if it is safe to repeat';

/**
 * Keep a token-bounded selection of a body, replacing each dropped run with a
 * marker that names the exact omitted line range and the way to get it back.
 *
 * The marker is load-bearing: it is the model's only signal that content was
 * removed and the only instruction that tells it how to recover the content.
 * @param {string[]} lines - body lines.
 * @param {number} budget - token ceiling for the body.
 * @param {Readonly<typeof DEFAULTS>} options - resolved options.
 * @param {ReturnType<typeof emptyStats>} stats - counters to update.
 * @param {'read' | 'generic'} kind - which recovery instruction the marker carries.
 * @param {object | null} [policy] - resolved policy, for type-specific scoring weights.
 * @returns {string[]} the bounded body.
 */
export function boundLines(lines, budget, options, stats, kind, policy = null, forcedKeep = null, recoveryText = null) {
  // `null` means bounding is switched off; `0` means this block has no room
  // left. Conflating them made a result split into many blocks — where each
  // share rounds down to zero — receive every block whole, which is the exact
  // inflation the result-level budget exists to prevent.
  if (budget === null || lines.length === 0) return lines;
  const joined = lines.join('\n');
  if (budget > 0 && estimateTokens(joined) <= budget) return lines;

  // A caller planning several blocks together supplies the selection; on its own
  // this block plans for itself within its share.
  const selection = forcedKeep === null
    ? selectByImportance(lines, budget, { isRead: kind === 'read', boost: policy?.boost }, options)
    : { keep: [...forcedKeep], protectedIndices: [], protectedLines: 0, protectedTokens: 0, budgetExceeded: false, overflowReason: null, scores: null, costs: null };
  let keepSet = new Set(selection.keep);

  const recovery =
    kind === 'read'
      ? (line) => recoveryText ?? `re-read with offset=${lineNumberOf(line)} to restore`
      // Not a recovery promise: re-running a command re-executes the tool, so
      // anything derived from a clock, a counter or a live service comes back
      // different. Only a saved snapshot restores the exact text.
      : () => recoveryText ?? RECOVERY_NOTE;

  if (keepSet.size === 0) {
    // Not one line of this block fits its share of the result budget. Returning
    // the block whole would defeat the budget — that is exactly how a hundred
    // small blocks passed hundreds of thousands of tokens straight through a
    // ceiling. Returning nothing would lose the content silently. The honest
    // outcome is a marker saying what happened and where to recover it.
    const omittedTokens = estimateTokens(joined);
    stats.omittedLines += lines.length;
    stats.omittedTokens += omittedTokens;
    stats.budgetExceeded = true;
    if (stats.overflowReason === null) {
      stats.overflowReason = `metadata-minimum: a ${budget}-token share holds none of this block's ${lines.length} lines`;
    }
    const detailed =
      `\u27ea[... all ${lines.length} lines, ${omittedTokens} tokens omitted \u2014 ` +
      `${recovery(lines[0] ?? '')} (${SLIM_MARKER_VERSION})]\u27eb`;
    // The description must fit the share it describes. Allowing a fixed
    // allowance here is what made overhead scale with the block count: sixty
    // blocks each spent a full-size marker and the total dwarfed the content it
    // replaced. The terse marker is the fallback, and `slimContent` merges the
    // per-block notes into one summary so the announcement is made once.
    if (estimateTokens(detailed) <= budget) return [detailed];
    stats.terseMarkers += 1;
    return [TERSE_OMISSION_MARKER];
  }

  // Nothing to gain when scoring selected everything.
  if (keepSet.size >= lines.length) return lines;

  // Protection can legitimately exceed the budget: the lines it holds carry
  // outcome information and are kept regardless. Reporting that is the caller's
  // only way to tell a bounded result from one that merely looks bounded.
  stats.protectedLines += selection.protectedLines;
  if (selection.budgetExceeded) {
    stats.budgetExceeded = true;
    if (stats.overflowReason === null) stats.overflowReason = selection.overflowReason;
  }

  // The payload guard inspects what bounding would actually drop, not the whole
  // result. Checking every line instead refused to compress any large file that
  // happened to contain one long line anywhere — including lines the selection
  // was going to keep anyway.
  const dropped = [];
  for (let index = 0; index < lines.length; index++) {
    if (!keepSet.has(index)) dropped.push(lines[index]);
  }
  if (hasUnbreakablePayload(dropped, 0, dropped.length, options.payloadLineGuardChars)) return lines;

  // The plan is a plan, not a guarantee: marker text and the read envelope cost
  // tokens that do not exist until rendering happens, so a selection that fits
  // on paper can still come out over. Render, measure the real total, and
  // withdraw the least valuable non-protected choices until it fits — strictly
  // downward, and bounded in rounds so a pathological input cannot spin.
  let rendered = null;
  if (budget > 0 && selection.scores !== null) {
    const { scores, costs } = selection;
    const protectedSet = new Set(selection.protectedIndices);
    for (let round = 0; ; round++) {
      rendered = renderSelection(lines, keepSet, kind, recoveryText);
      const total = estimateTokens(rendered.out.join('\n'));
      if (total <= budget) break;
      const removable = [...keepSet].filter((index) => !protectedSet.has(index));
      if (removable.length === 0) {
        // Everything left is protected. Hold it and say so; trimming it to fit a
        // number is how a bounded payload ends up missing the part that mattered.
        stats.budgetExceeded = true;
        if (stats.overflowReason === null) {
          stats.overflowReason =
            `protected-content: ${keepSet.size} protected lines need ${total} tokens; the budget is ${budget}`;
        }
        break;
      }
      if (round >= MAX_RENDER_ROUNDS) break;
      // Ascending score, so the least informative line is the first to go.
      removable.sort((left, right) => (scores[left] ?? 0) - (scores[right] ?? 0));
      const excess = total - budget;
      let freed = 0;
      for (const index of removable) {
        if (freed >= excess) break;
        keepSet.delete(index);
        // Withdrawing lines can also merge two gaps into one marker, so a little
        // credit on top of the line's own cost keeps the search from crawling.
        freed += (costs?.[index] ?? 0) + MARKER_SHRINK_CREDIT;
      }
      if (freed === 0) break;
    }
  }
  if (rendered === null) rendered = renderSelection(lines, keepSet, kind, recoveryText);

  stats.omittedLines += rendered.omittedLines;
  stats.omittedTokens += rendered.omittedTokens;
  return rendered.out;
}

/**
 * Render a selection into bounded lines, if any.
 *
 * Pure with respect to the shared counters — it reports what it dropped rather
 * than mutating them — because a caller re-renders while searching for a
 * selection whose real, post-marker total fits the budget.
 *
 * @param {string[]} lines - the body lines.
 * @param {Set<number>} keepSet - indices to retain.
 * @param {'read' | 'generic'} kind - which recovery instruction a marker carries.
 * @returns {{ out: string[], omittedLines: number, omittedTokens: number }} the rendering.
 */
function renderSelection(lines, keepSet, kind, recoveryText = null) {
  const recovery =
    kind === 'read'
      ? (line) => recoveryText ?? `re-read with offset=${lineNumberOf(line)} to restore`
      // Not a recovery promise: re-running a command re-executes the tool, so
      // anything derived from a clock, a counter or a live service comes back
      // different. Only a saved snapshot restores the exact text.
      : () => recoveryText ?? RECOVERY_NOTE;

  const out = [];
  let gapStart = -1;
  let gapCount = 0;
  let gapTokens = 0;
  let recoveryAnnounced = false;
  let omittedLines = 0;
  let omittedTokens = 0;

  /** Emit the pending gap. Every omitted run is announced, however short. */
  const flushGap = (endExclusive) => {
    if (gapCount === 0) return;
    const firstKept = lines[gapStart];
    const lastKept = lines[endExclusive - 1];
    const range =
      kind === 'read'
        ? `lines ${lineNumberOf(firstKept)}-${lineNumberOf(lastKept)}`
        : `source lines ${gapStart + 1}-${endExclusive}`;
    if (gapCount === 1) {
      out.push(`\u27ea[... ${range} omitted (${SLIM_MARKER_VERSION})]\u27eb`);
    } else if (!recoveryAnnounced) {
      recoveryAnnounced = true;
      out.push(
        `\u27ea[... ${gapCount} lines, ${gapTokens} tokens omitted \u2014 ${range}. ` +
          `${recovery(firstKept)} (${SLIM_MARKER_VERSION})]\u27eb`,
      );
    } else {
      out.push(`\u27ea[... ${gapCount} lines omitted, ${range} (${SLIM_MARKER_VERSION})]\u27eb`);
    }
    omittedLines += gapCount;
    omittedTokens += gapTokens;
    gapStart = -1;
    gapCount = 0;
    gapTokens = 0;
  };

  for (let index = 0; index < lines.length; index++) {
    if (keepSet.has(index)) {
      flushGap(index);
      out.push(lines[index]);
      continue;
    }
    if (gapCount === 0) gapStart = index;
    gapCount++;
    gapTokens += estimateTokens(lines[index]);
  }
  flushGap(lines.length);

  return { out, omittedLines, omittedTokens };
}

/** Parse `NNN: text` into its line number, or undefined when absent. */
function lineNumberOf(line) {
  const match = /^\s*(\d+)/.exec(line ?? '');
  return match === null ? '?' : Number(match[1]);
}

/**
 * Whether any line in `lines[start, end)` is longer than the payload guard.
 * @param {string[]} lines - candidate body.
 * @param {number} start - first index to inspect.
 * @param {number} end - exclusive end index.
 * @param {number} guard - character ceiling; 0 disables the check.
 * @returns {boolean} true when an unsplittable payload is present.
 */
function hasUnbreakablePayload(lines, start, end, guard) {
  if (guard <= 0) return false;
  for (let index = start; index < end; index++) {
    if (lines[index].length > guard) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Generic (non-read) pipeline
// ---------------------------------------------------------------------------

/**
 * Slim one non-`read` text payload.
 * @param {string} text - tool result text.
 * @param {Readonly<typeof DEFAULTS>} options - resolved options.
 * @returns {{ text: string, stats: ReturnType<typeof emptyStats>, changed: boolean }} result.
 */
/** The body lines a unified plan must agree on, matching what `boundLines` sees. */
function bodyLinesOf(text) {
  const parts = splitReadEnvelope(text);
  return parts === null || parts.body.length === 0 ? text.split('\n') : parts.body.split('\n');
}

export function slimGenericText(text, options, policy = null, forcedKeep = null, recoveryText = null) {
  const stats = emptyStats();
  stats.charsIn = text.length;
  stats.tokensIn = estimateTokens(text);
  stats.linesIn = countLines(text);
  // A caller that planned several blocks together indexed into the raw lines, so
  // anything that would change the line count has to stay off or the selection
  // would point at the wrong rows.
  const transforms = forcedKeep === null ? (policy?.transforms ?? CONSERVATIVE_TRANSFORMS) : CONSERVATIVE_TRANSFORMS;
  let lines = normalize(text, options, stats, transforms).split('\n');
  lines = foldRepeatedLines(lines, options, stats, transforms);
  lines = foldBlankRuns(lines, options, stats, transforms);
  lines = truncateLongLines(lines, options.genericMaxLineChars, options, stats, recoveryText);
  // `null` when the caller switched bounding off; a number otherwise, where 0
  // means the block has no room rather than no policy.
  const budget =
    policy === null ? (options.maxResultTokens === 0 ? null : options.maxResultTokens) : policy.budget;
  lines = boundLines(lines, budget, options, stats, 'generic', policy, forcedKeep, recoveryText);
  const body = lines.join('\n');
  stats.charsOut = body.length;
  stats.tokensOut = estimateTokens(body);
  stats.linesOut = lines.length;
  return { text: body, stats, changed: body !== text };
}

// ---------------------------------------------------------------------------
// read pipeline
// ---------------------------------------------------------------------------

const READ_PREFIX_MARKER = '</path>\n<type>file</type>\n<content>\n';
const READ_CLOSE = '</content>';
const NUMBERED_LINE = /^\d+:/;

/**
 * Split one `read` result into the envelope prefix, the numbered body, and the
 * untouched tail (the separator, the continuation footer, and the closing
 * newline). The body is located by scanning backwards for the last numbered
 * line rather than by matching a regex, so a file whose own content contains
 * `</content>` or a parentheses-only line is still split at the true boundary.
 *
 * Reassembly is `prefix + body + tail + '</content>'` and is byte-identical to
 * the input whenever `body` is unchanged.
 *
 * @param {string} text - rendered read result.
 * @returns {{ prefix: string, body: string, tail: string } | null} parts, or null when not a read envelope.
 */
export function splitReadEnvelope(text) {
  if (!text.startsWith('<path>') || !text.endsWith(READ_CLOSE)) return null;
  const marker = text.indexOf(READ_PREFIX_MARKER);
  if (marker === -1) return null;
  const prefixEnd = marker + READ_PREFIX_MARKER.length;
  const prefix = text.slice(0, prefixEnd);
  const inner = text.slice(prefixEnd, text.length - READ_CLOSE.length);
  const lines = inner.split('\n');
  let lastNumbered = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (NUMBERED_LINE.test(lines[index])) {
      lastNumbered = index;
      break;
    }
  }
  if (lastNumbered === -1) return { prefix, body: '', tail: inner };
  const body = lines.slice(0, lastNumbered + 1).join('\n');
  return { prefix, body, tail: inner.slice(body.length) };
}

/**
 * Reassemble a `read` result around a (possibly rewritten) body.
 * @param {{ prefix: string, tail: string }} parts - envelope parts from {@link splitReadEnvelope}.
 * @param {string} body - the numbered body to place between them.
 * @returns {string} the complete result text.
 */
export function joinReadEnvelope(parts, body) {
  return `${parts.prefix}${body}${parts.tail}${READ_CLOSE}`;
}

/**
 * Slim one `read` result: normalize, fold repeats, cap line width, then bound
 * the body by tokens while preserving the envelope and the continuation footer.
 * @param {string} text - rendered read result.
 * @param {Readonly<typeof DEFAULTS>} options - resolved options.
 * @returns {{ text: string, stats: ReturnType<typeof emptyStats>, changed: boolean }} result.
 */
export function slimReadText(text, options, policy = null, forcedKeep = null, recoveryText = null) {
  const stats = emptyStats();
  stats.charsIn = text.length;
  stats.tokensIn = estimateTokens(text);
  stats.linesIn = countLines(text);
  const parts = splitReadEnvelope(text);
  if (parts === null) return slimGenericText(text, options, policy, forcedKeep, recoveryText);
  if (parts.body.length === 0) {
    // An envelope whose body holds no numbered lines is not a shape this kernel
    // knows how to bound. Treating it as passive output is the honest fallback:
    // returning "nothing to do" would silently skip everything the envelope
    // actually carries, including payloads that are long enough to matter.
    return slimGenericText(text, options, policy, forcedKeep, recoveryText);
  }
  const transforms = forcedKeep === null ? (policy?.transforms ?? CONSERVATIVE_TRANSFORMS) : CONSERVATIVE_TRANSFORMS;
  const normalized = normalize(parts.body, options, stats, transforms);
  let lines = foldRepeatedLines(normalized.split('\n'), options, stats, transforms);
  lines = foldBlankRuns(lines, options, stats, transforms);
  lines = truncateLongLines(lines, options.readMaxLineChars, options, stats, recoveryText);
  // Same distinction as the passive path: `null` is "off", `0` is "no room".
  const budget =
    policy === null ? (options.readMaxResultTokens === 0 ? null : options.readMaxResultTokens) : policy.budget;
  lines = boundLines(lines, budget, options, stats, 'read', policy, forcedKeep, recoveryText);
  const body = lines.join('\n');
  const rebuilt = joinReadEnvelope(parts, body);
  stats.charsOut = rebuilt.length;
  stats.tokensOut = estimateTokens(rebuilt);
  stats.linesOut = lines.length;
  return { text: rebuilt, stats, changed: rebuilt !== text };
}

// ---------------------------------------------------------------------------
// Content-block entry point
// ---------------------------------------------------------------------------

/** Count the lines in one text payload without allocating a split for empty input. */
function countLines(text) {
  if (text.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
  return count;
}

/**
 * Slim every supported text block of one tool result.
 *
 * Returns `null` when nothing changed, and also when the rebuild is not
 * strictly smaller — a transform that does not pay for itself is discarded.
 *
 * @param {readonly { type: string, text?: string }[]} blocks - result content blocks.
 * @param {string} toolName - name of the tool that produced the result.
 * @param {Readonly<typeof DEFAULTS>} options - resolved options.
 * @returns {{ blocks: object[], stats: ReturnType<typeof emptyStats> } | null} replacement, or null.
 */
/**
 * Marker overhead reserved per text block when splitting a result's budget.
 *
 * Omitting lines costs tokens: every gap carries a marker naming its range and
 * how to recover it. Allocating the whole budget to content and *then* writing
 * markers is how a result split into a hundred blocks ended up far larger than
 * the same result kept whole — the ceiling applied to the text and nothing else,
 * so the overhead scaled with the block count and nothing counted it.
 *
 * The reserve is deliberately generous. Under-reserving shows up as a reported
 * `budgetExceeded`, which is honest; over-reserving only costs a little more
 * compression.
 */
const MARKER_RESERVE_TOKENS = 60;

/**
 * The marker used when a block's share cannot afford the descriptive one.
 *
 * A share smaller than the sentence that would describe it cannot pay for that
 * sentence. Saying less per block is the only way the total announcement cost
 * stays bounded; `slimContent` adds one merged note for the whole result.
 */
const TERSE_OMISSION_MARKER = '\u27ea\u22ef\u27eb';

/**
 * Rounds of render-measure-withdraw before giving up on convergence.
 *
 * The loop removes at least one line per round and stops early once the
 * rendered total fits, so the bound is a safety net for pathological inputs
 * rather than the expected path.
 */
const MAX_RENDER_ROUNDS = 8;

/**
 * Token credit for one withdrawn line, on top of the line's own cost.
 *
 * Removing lines can merge two gaps into a single marker, so the rendered total
 * drops by more than the line cost alone. Crediting a little of that keeps the
 * search from inching one line at a time.
 */
const MARKER_SHRINK_CREDIT = 6;

export function slimContent(blocks, toolName, options, fullText = false, context = null) {
  if (!options.enabled || fullText || !Array.isArray(blocks) || blocks.length === 0) return null;
  const stats = emptyStats();
  const isRead = toolName === 'read';
  const analysisIntent = context?.analysisIntent === true;
  /**
   * The recovery instruction to write into markers, when the caller already
   * knows it.
   *
   * Passing it in is what makes the substitution positional instead of textual:
   * the kernel writes the real sentence into its own markers as it renders them,
   * so nothing has to find markers again afterwards by matching a pattern. An
   * after-the-fact search cannot tell an instruction from a quotation, and
   * content that quotes a marker is ordinary content.
   *
   * Keyed by the block's index in the caller's own array — the same index a
   * recovery store reports — not by position within the text blocks, which
   * differ as soon as a result interleaves text and images.
   */
  const recoveryNoteFor =
    typeof context?.recoveryNoteFor === 'function' ? context.recoveryNoteFor : null;
  const baseBudget = isRead ? options.readMaxResultTokens : options.maxResultTokens;
  // A configured zero means the feature is off, which is a different thing from
  // "this block has no room". Handled here, at the boundary, so the kernel can
  // use 0 internally to mean an exhausted share.
  if (baseBudget === 0) return null;

  // One result, one budget. Resolving a policy per block and handing each one
  // its own ceiling meant a single result split into ten text blocks received
  // ten times the allowance — the same content cost more the more finely it was
  // chopped. The policy still varies per block (a result can carry both a diff
  // and a log tail), but the multipliers are collapsed to the largest one and
  // applied to the result exactly once.
  const textIndices = [];
  const textBlocks = [];
  const policies = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
      continue;
    }
    textIndices.push(index);
    textBlocks.push(block);
    policies.push(
      resolvePolicy({
        contentType: detectContentType(block.text),
        analysisIntent,
        baseBudget,
        toolName,
        options,
      }),
    );
  }

  /** Processed replacement for each text block, keyed by its original index. */
  const processed = new Map();
  const applied = [];
  let touched = false;

  if (textBlocks.length > 0) {
    const largestMultiplier =
      baseBudget === 0 ? 1 : Math.max(...policies.map((policy) => policy.budget / baseBudget));
    const totalBudget = Math.floor(baseBudget * largestMultiplier);

    // One plan for the whole result when it arrives in pieces. Planning each
    // block against its own share made the same content cost more the more
    // finely it was split, and let marker overhead grow with the block count
    // because nothing looked at the total.
    let forcedKeeps = null;
    if (textBlocks.length > 1) {
      const parts = textBlocks.map((block, position) => ({
        blockIndex: position,
        lines: isRead ? bodyLinesOf(block.text) : block.text.split('\n'),
        isRead,
        boost: policies[position].boost,
      }));
      const plan = planResultBudget(parts, Math.max(0, totalBudget - textBlocks.length * MARKER_RESERVE_TOKENS), options);
      forcedKeeps = parts.map((part) => plan.keeps.get(part.blockIndex) ?? new Set());
    }

    for (let position = 0; position < textBlocks.length; position++) {
      const block = textBlocks[position];
      const policy = { ...policies[position] };
      // A single block keeps its own share; several blocks were planned together.
      if (forcedKeeps === null) {
        policy.budget = Math.min(policy.budget, Math.max(0, totalBudget - MARKER_RESERVE_TOKENS));
      } else {
        policy.budget = 0;
      }
      applied.push(policy.type);
      const forced = forcedKeeps === null ? null : forcedKeeps[position];
      const blockRecovery =
        recoveryNoteFor === null ? null : recoveryNoteFor(textIndices[position]) ?? null;
      const result = isRead
        ? slimReadText(block.text, options, policy, forced, blockRecovery)
        : slimGenericText(block.text, options, policy, forced, blockRecovery);
      mergeStats(stats, result.stats);
      if (result.text !== block.text) {
        touched = true;
        processed.set(textIndices[position], { ...block, text: result.text });
      } else {
        processed.set(textIndices[position], block);
      }
    }
  }

  // Rebuilt in original order so a result mixing text and images keeps its
  // interleaving; non-text blocks pass through by identity.
  const out = [];
  for (let index = 0; index < blocks.length; index++) {
    out.push(processed.has(index) ? processed.get(index) : blocks[index]);
  }

  if (!touched || stats.charsOut >= stats.charsIn) return null;
  stats.contentTypes = applied;

  // Merge the bare markers into one note. Each block that could not afford a
  // description left `⟪⋯⟫`, which announces nothing on its own; saying it once
  // for the result costs less than describing it per block and is the only way
  // the model learns what the symbol means. Appended to the last text block, so
  // the note travels with the content it explains.
  if (stats.terseMarkers > 0) {
    const summary =
      `\u27ea\u22ef\u27eb marks ${stats.terseMarkers} block(s) whose share of this result's token budget ` +
      `could not afford a description: their lines were omitted, not emptied. ` +
      // Not "repeat the call": re-running a tool re-executes it, so anything
      // derived from a clock, a counter or a live service comes back different.
      // The original holds those lines, and where it lives is what the
      // per-marker instruction is for.
      `The original holds them.`;
    const lastIndex = textIndices[textIndices.length - 1];
    const last = out[lastIndex];
    if (last !== undefined && last.type === 'text') {
      out[lastIndex] = { ...last, text: `${last.text}\n${summary}` };
      stats.charsOut += summary.length + 1;
      stats.tokensOut += estimateTokens(summary);
    }
  }

  return { blocks: out, stats };
}

/**
 * Split one result's text budget across its text blocks, proportionally to how
 * much text each carries.
 *
 * Proportional allocation rather than an even split: a result whose first block
 * is a one-line header and whose second is the actual payload should spend its
 * budget where the content is. Blocks that carry no text get nothing.
 *
 * @param {readonly { text: string }[]} blocks - the text blocks of one result.
 * @param {number} totalBudget - tokens available to the whole result.
 * @param {readonly object[]} policies - per-block policies (length must match).
 * @returns {number[]} a budget per block, aligned by index.
 */
export function allocateTextBudgets(blocks, totalBudget, policies) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  if (policies.length !== blocks.length) {
    throw new Error('token-slimmer: allocateTextBudgets needs one policy per block');
  }
  const weights = blocks.map((block) => estimateTokens(block.text));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0 || totalBudget <= 0) return blocks.map(() => 0);
  return weights.map((weight) => Math.max(0, Math.floor((totalBudget * weight) / total)));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Canonical string form of a call's arguments.
 *
 * Object keys are sorted so that two calls differing only in property order
 * collapse to one identity; this is what makes both the repeat escape hatch and
 * any counting keyed on it stable. Arguments arrive as the loop's parsed JSON
 * (or its raw-string fallback for malformed argument JSON), so the JSON value
 * domain is the whole input domain.
 *
 * @param {unknown} value - parsed or raw tool arguments.
 * @returns {string} the canonical form.
 */
export function canonicalArgs(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(sortJson(value));
  } catch {
    return String(value);
  }
}

/** Deep key-sort of a parsed-JSON value. */
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
    return sorted;
  }
  return value;
}

/**
 * Short, stable digest of a string, used as an identity tag.
 * @param {string} text - text to digest.
 * @returns {string} 12 hex characters.
 */
export function shortDigest(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}
