/**
 * Policy layer: what kind of content this is, what the user is asking for, and
 * what that means for how hard to compress.
 *
 * The kernel's scoring layer is content-agnostic — it rewards structural lines,
 * errors, anomalies and novelty the same way whatever it is looking at. That is
 * a reasonable default and a poor fit for specific shapes: in a diff the `@@`
 * hunk header matters more than any error line, in a search result the `path:`
 * prefix is the whole point, and when the user has just asked you to debug
 * something, every line of the thing they asked about is potentially evidence.
 *
 * So this module does not swap algorithms — it adjusts weights and budget. That
 * keeps one code path to test and one behaviour to reason about, while still
 * letting a diff be treated as a diff.
 *
 * Everything here is a pure function of its input. No model, no state.
 *
 * @module dsh-token-slimmer/policy
 */

/** Content shapes the scorer knows how to weight differently. */
export const CONTENT_TYPES = Object.freeze([
  'diff',
  'json',
  'log',
  'search',
  'table',
  'code',
  'text',
]);

/**
 * Detect the shape of a payload from its own bytes.
 *
 * Ordered most-specific first: a diff also looks like text, a search result also
 * looks like a log, so the discriminators come before the fallbacks.
 *
 * @param {string} text - the payload.
 * @returns {string} one of {@link CONTENT_TYPES}.
 */
export function detectContentType(text) {
  if (typeof text !== 'string' || text.length === 0) return 'text';
  const head = text.slice(0, 4000);

  // A diff is unmistakable: hunk headers do not occur in other output.
  if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(head) || /^diff --git /m.test(head)) return 'diff';

  const lines = text.split('\n');
  const sampled = lines.slice(0, 200).filter((line) => line.trim().length > 0);
  const stamped = sampled.filter(
    (line) =>
      /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(line) ||
      /^\s*\[?(?:INFO|DEBUG|WARN|WARNING|ERROR|TRACE|FATAL)\]?\b/.test(line) ||
      /^\s*\d{2}:\d{2}:\d{2}\b/.test(line),
  ).length;

  // Logs are checked before search results on purpose. A timestamp contains
  // `HH:MM:SS`, and a `path:line:content` pattern matches `10:00:0` just as
  // happily as it matches a real match line, so the looser rule must not run
  // first. The log test is the more specific of the two.
  if (sampled.length >= 5 && stamped / sampled.length >= 0.5) return 'log';

  // ripgrep/grep match lines: path, line number, content — and not a timestamp.
  if (
    /^(?!\s*\d{4}-\d{2}-\d{2})[^\n]*:\d+:[^\n]/.test(lines[0] ?? '') &&
    lines.slice(0, 5).filter((line) => /^(?!\s*\d{4}-\d{2}-\d{2})[^\n]*:\d+:/.test(line)).length >= 2
  ) {
    return 'search';
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Truncated or malformed JSON is still JSON-shaped if the first characters agree.
      if (/^[[{]\s*"/.test(trimmed) || /^[[{]\s*[\]}]/.test(trimmed)) return 'json';
    }
  }

  // Tables: repeated column separators across consecutive lines.
  const piped = sampled.filter((line) => (line.match(/\|/g) ?? []).length >= 2).length;
  const tabbed = sampled.filter((line) => (line.match(/\t/g) ?? []).length >= 2).length;
  if (sampled.length >= 4 && (piped / sampled.length >= 0.6 || tabbed / sampled.length >= 0.6)) return 'table';

  if (sampled.length >= 3) {
    const codeish = sampled.filter(
      (line) =>
        /^\s*(?:import|export|from|package|namespace|using|#include)\b/.test(line) ||
        /^\s*(?:public|private|protected|internal|static|final|async|def|class|interface|struct|enum|func|fn|impl|trait)\b/.test(line) ||
        /^\s*(?:function|const|let|var|type)\s+\w/.test(line) ||
        /^\s*(?:if|for|while|switch|try|catch|return|yield|await)\b/.test(line) ||
        /[{};]\s*$/.test(line),
    ).length;
    if (codeish / sampled.length >= 0.35) return 'code';
  }

  return 'text';
}

/** Expressions that signal the user wants the material examined rather than merely fetched. */
const ANALYSIS_INTENT = [
  /分析|审查|检查|排查|诊断|研究|解释|说明|为什么|怎么回事|修复|调试|定位|找出问题/,
  /\b(?:analyz|analys|review|inspect|examin|investigat|diagnos|explain|why|debug|trace|root\s*cause|fix|breakdown)\w*/i,
  /\b(?:what(?:'s| is) (?:wrong|happening|going on)|figure out|work out|find (?:the )?(?:bug|issue|problem|cause))\b/i,
];

/**
 * Whether a user message asks for analysis rather than a lookup.
 *
 * The distinction matters because analysis means every part of the payload is
 * potential evidence: the one line that explains the bug is by definition not
 * the line you would have guessed. A lookup, by contrast, has a known target.
 *
 * @param {string} text - the user message text.
 * @returns {boolean} whether analysis intent is present.
 */
export function hasAnalysisIntent(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return ANALYSIS_INTENT.some((pattern) => pattern.test(text));
}

/**
 * The edit-preparation protection this module deliberately does not offer.
 *
 * An earlier revision exported an `isEditPreparation(toolName, touchedPaths)`
 * predicate for "the file just read is about to be edited, so hand it over
 * whole". Nothing ever called it, and nothing could: a read result is bounded
 * at `tools/post-execute`, which runs before the next tool call exists. By the
 * time an `edit` is visible, the read it depends on has already entered the
 * context — and rewriting it then would invalidate the cached prefix, which is
 * the one cost this whole design exists to avoid.
 *
 * The protection is therefore structural rather than conditional: `read` gets a
 * wider ceiling than passive output (`readMaxResultTokens`), analysis intent
 * doubles the budget, and the repeat escape hatch returns the full text to any
 * call that asks for it a second time. A model that needs the whole file to
 * edit it issues the same read again and gets it.
 *
 * Do not reintroduce a predicate with this shape; it cannot be wired.
 */

/**
 * Which text transforms one input is allowed to receive.
 *
 * Fidelity is the default, and that ordering is the point. The first release
 * stripped trailing whitespace, dropped carriage returns and folded repeated
 * lines from *everything*, which silently rewrote string literals: a Python
 * triple-quoted block lost the two spaces that were its content, and a Markdown
 * hard break collapsed into an ordinary newline. Those are not cosmetic — the
 * model reads the text and may write it back, and a literal that changed
 * underneath it produces a wrong edit that looks right.
 *
 * So the reductions are opt-in per content shape rather than opt-out:
 *
 *  - `read` output is always byte-faithful, whatever it holds.
 *  - Every structured or prose shape (code, JSON, diff, table, unknown) is
 *    byte-faithful too.
 *  - Only `log` output — machine-emitted, whitespace-insensitive by nature —
 *    may receive the lossy log reductions, and only while the caller has them
 *    enabled.
 *
 * The lower-level helpers take the same conservative default, so a caller that
 * reaches them directly cannot bypass this by skipping the plugin entry point.
 *
 * @param {object} input - the decision inputs.
 * @param {string} input.toolName - producing tool, if known.
 * @param {string} input.contentType - from {@link detectContentType}.
 * @param {object} input.options - resolved kernel options.
 * @returns {{ stripCarriageReturns: boolean, stripTrailingWhitespace: boolean,
 *   foldRepeatedLines: boolean, foldBlankRuns: boolean }} the allowed transforms.
 */
export function resolveTransforms({ toolName, contentType, options }) {
  const faithful = {
    stripCarriageReturns: false,
    stripTrailingWhitespace: false,
    foldRepeatedLines: false,
    foldBlankRuns: false,
  };
  if (toolName === 'read') return faithful;
  if (contentType !== 'log') return faithful;
  const source = options ?? {};
  return {
    stripCarriageReturns: source.stripCarriageReturns === true,
    stripTrailingWhitespace: source.stripTrailingWhitespace === true,
    foldRepeatedLines: source.foldRepeatedLines === true,
    // Blank-run collapsing is what makes a log readable, so it stays on for
    // logs even when the caller disabled the other reductions.
    foldBlankRuns: true,
  };
}

/** Per-type scoring adjustments and budget multipliers. */
const TYPE_POLICY = Object.freeze({
  diff: { budgetMultiplier: 1.3, boost: { hunk: 3000, sign: 400, fileHeader: 2500 } },
  search: { budgetMultiplier: 1.0, boost: { match: 200, path: 400 } },
  json: { budgetMultiplier: 0.9, boost: { key: 300, errorValue: 2000 } },
  log: { budgetMultiplier: 0.8, boost: { error: 4000, timestamp: 100 } },
  table: { budgetMultiplier: 0.9, boost: { header: 500 } },
  code: { budgetMultiplier: 1.2, boost: { declaration: 600, signature: 500, comment: 150 } },
  text: { budgetMultiplier: 1.0, boost: {} },
});

/**
 * Resolve the effective policy for one payload.
 *
 * Analysis intent *raises* the budget — it never turns bounding off, because an
 * unbounded payload still costs every later step in the session, and the escape
 * hatch already covers a model that needs the whole thing back.
 *
 * @param {object} input - the decision inputs.
 * @param {string} input.contentType - from {@link detectContentType}.
 * @param {boolean} input.analysisIntent - from {@link hasAnalysisIntent}.
 * @param {number} input.baseBudget - the configured token budget.
 * @returns {{ budget: number, type: string, boost: object, analysisIntent: boolean, reason: string }} the resolved policy.
 */
export function resolvePolicy({ contentType, analysisIntent, baseBudget, toolName, options }) {
  const policy = TYPE_POLICY[contentType] ?? TYPE_POLICY.text;
  let budget = Math.floor(baseBudget * policy.budgetMultiplier);
  const reasons = [`type=${contentType}`];
  if (policy.budgetMultiplier !== 1) reasons.push(`×${policy.budgetMultiplier} for ${contentType}`);
  if (analysisIntent) {
    // Doubling is deliberate: enough to keep a whole failing region, not enough
    // to make bounding pointless.
    budget *= 2;
    reasons.push('×2 for analysis intent');
  }
  const transforms = resolveTransforms({ toolName, contentType, options });
  if (transforms.foldRepeatedLines || transforms.stripTrailingWhitespace) reasons.push('log transforms on');
  return {
    budget,
    type: contentType,
    boost: policy.boost,
    analysisIntent,
    transforms,
    reason: reasons.join(', '),
  };
}
