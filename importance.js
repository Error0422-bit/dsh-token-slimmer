/**
 * Importance scoring for bounded content.
 *
 * The naive bounding policy keeps the head and the tail of a payload. That is a
 * positional guess: it assumes the beginning and end matter more than the
 * middle, which holds for prose and fails for logs, diffs and traces, where the
 * one line that matters is usually in the middle.
 *
 * This module replaces the guess with two layers, in the order they must be
 * applied:
 *
 *  1. **Additive retention** — lines that carry outcome information are kept no
 *     matter what the budget says: errors, failures, anomalies, structural
 *     markers. These are not scored and never compete for space. The same
 *     guarantee shape Headroom's SmartCrusher documents, and it is the reason a
 *     bounded log is still usable.
 *
 *  2. **Scored fill** — remaining budget goes to the highest-scoring lines,
 *     emitted in original order so structure survives.
 *
 * Scoring is a deterministic function of the text. No model, no statistics
 * requiring a second pass over a corpus, no state between calls.
 *
 * @module dsh-token-slimmer/importance
 */

import { estimateTokens } from './slim.js';

/** Patterns that make a line additive: it says what happened, so it survives. */
const ERROR_PATTERNS = [
  /\b(?:error|err)\b/i,
  /\b(?:fatal|critical|panic|emergency)\b/i,
  /\b(?:exception|traceback|stack\s*trace)\b/i,
  /\b(?:fail(?:ed|ure|ing)?|failing)\b/i,
  /\b(?:denied|forbidden|unauthori[sz]ed|not\s+permitted)\b/i,
  /\b(?:timeout|timed\s+out|deadline\s+exceeded)\b/i,
  /\b(?:refused|unreachable|unavailable|abort(?:ed)?)\b/i,
  /\b(?:deprecated|breaking\s+change|incompatible)\b/i,
  /^\s*(?:ERR|ERR!|ERROR|FATAL|WARN|WARNING)\b/,
  /\b(?:assert(?:ion)?\s+failed|expected\b.*\bbut\b)/i,
  /Traceback \(most recent call last\)/,
];

/** Structural markers that anchor meaning for the reader. */
const STRUCTURAL_PATTERNS = [
  /^diff --git /,
  /^(?:\+\+\+|---) [ab]\//,
  /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,
  /^[+-]{3,}\s/,
  /^={3,}\s*$/,
  /^-{3,}\s*$/,
  /^\s*[>#]{1,3}\s+\S/,
  /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
  /^\s*(?:at\s+\S+\(|File\s+"[^"]+",\s+line\s+\d+)/,
  /^\s*"(?:[^"]+)"\s*:/,
  /^\s*(?:class|def|function|interface|type|export|import|package|namespace)\s/,
  /^\s*(?:public|private|protected|static|async|const|let|var|func)\s/,
];

/** ISO-ish timestamps and common log prefixes. */
const TIMESTAMP_PATTERN = /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/**
 * Line patterns keyed by the boost names `policy.js` emits. A type policy that
 * names a key with no pattern here is simply ignored, so the two modules can
 * evolve separately without a hard coupling.
 */
const TYPE_LINE_PATTERNS = {
  hunk: /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,
  sign: /^[+-](?![+-])/,
  fileHeader: /^(?:diff --git |\+\+\+ |--- )/,
  match: /^[^\s:][^\n]*:\d+:/,
  path: /^[^\s:][^\n]*:\d+:/,
  key: /^\s*"[^"]+"\s*:/,
  errorValue: /"[^"]*(?:error|message|detail|reason|status)[^"]*"\s*:/i,
  timestamp: TIMESTAMP_PATTERN,
  header: /^\s*\|?\s*[A-Za-z_ ]+\s*\|/,
  declaration: /^\s*(?:class|def|function|interface|type|export|public|private|protected|static|func|fn|impl|struct|enum)\s/,
  signature: /^\s*(?:async\s+)?(?:function|def|fn)\s+\w+\s*[(:]/,
  comment: /^\s*(?:\/\/|#|\/\*|\*|--|;)/,
};

/** Volatile substrings masked before uniqueness comparison. */
function mask(str) {
  return str
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '\u0000')
    .replace(/\b[0-9a-f]{12,}\b/gi, '\u0000')
    .replace(/\d+/g, '\u0000');
}

/** Tokenize into comparable words, dropping masked placeholders. */
function words(str) {
  return str.toLowerCase().split(/[^\p{L}\p{N}\u0000]+/u).filter((word) => word.length > 0);
}

/** How many lines on either side of a protected line are kept with it. */
const PROTECTION_NEIGHBORS = 2;

/**
 * The protected index set for one block: additive lines plus their neighbourhood.
 *
 * A protected line is rarely readable alone — a stack trace needs the frame
 * above it, a log error needs the request line below it — so the neighbourhood
 * is taken unconditionally, and a Set collapses the overlap where two protected
 * lines sit close together. Blocks are handled separately, so a neighbourhood
 * never spans two of them.
 *
 * @param {Set<number>} additive - indices flagged as protected.
 * @param {number} lineCount - how many lines the block has.
 * @returns {Set<number>} every index that must survive.
 */
export function protectedIndicesOf(additive, lineCount) {
  const set = new Set();
  for (const index of additive) {
    for (let offset = -PROTECTION_NEIGHBORS; offset <= PROTECTION_NEIGHBORS; offset++) {
      const neighbour = index + offset;
      if (neighbour >= 0 && neighbour < lineCount) set.add(neighbour);
    }
  }
  return set;
}

/**
 * Plan one result's budget across every one of its text blocks at once.
 *
 * Planning each block separately was the defect this replaces: a policy and a
 * ceiling were resolved per block, so the same content cost more the more finely
 * it was split, and marker overhead scaled with the block count because nothing
 * looked at the total. Here there is one pool and one ceiling.
 *
 * Order, and it is the whole point:
 *
 *  1. **Protected content everywhere**, before anything competes. The lines that
 *     carry outcome information are not rationed against ordinary content, in
 *     any block, and their neighbourhoods come with them.
 *  2. **A per-block opening and closing guarantee**, so each block still reads
 *     as a fragment of something rather than a random sample.
 *  3. **One shared pool** of everything else, taken highest score first. A block
 *     with more signal wins more of the budget; a block with none gets its
 *     guarantee and nothing more.
 *
 * @param {{ blockIndex: number, lines: string[], isRead?: boolean, boost?: object }[]} parts
 *   one entry per text block, in result order.
 * @param {number} totalBudget - the whole result's allowance, in tokens.
 * @param {{ headBudgetRatio: number }} options - resolved kernel options.
 * @returns {{ keeps: Map<number, Set<number>>, budgetExceeded: boolean,
 *   protectedTokens: number, spent: number }} the selection per block.
 */
export function planResultBudget(parts, totalBudget, options) {
  const scored = parts.map((part) => {
    const { scores, additive } = scoreLines(part.lines, {
      isRead: part.isRead === true,
      boost: part.boost,
    });
    return {
      blockIndex: part.blockIndex,
      lines: part.lines,
      scores,
      costs: part.lines.map((line) => estimateTokens(line) + 1),
      protected: protectedIndicesOf(additive, part.lines.length),
    };
  });

  const keeps = new Map(scored.map((part) => [part.blockIndex, new Set()]));
  let protectedTokens = 0;
  for (const part of scored) {
    const keep = keeps.get(part.blockIndex);
    for (const index of part.protected) {
      keep.add(index);
      protectedTokens += part.costs[index];
    }
  }
  let spent = protectedTokens;
  const budgetExceeded = spent > totalBudget;

  // Opening and closing guarantees come out of whatever protection left behind.
  const remaining = Math.max(0, totalBudget - spent);
  if (remaining > 0 && scored.length > 0) {
    const guaranteeBudget = Math.floor(remaining * options.headBudgetRatio * 0.6);
    const perBlock = Math.floor(guaranteeBudget / scored.length);
    for (const part of scored) {
      const keep = keeps.get(part.blockIndex);
      let headUsed = 0;
      for (let index = 0; index < part.lines.length && headUsed < perBlock / 2; index++) {
        if (keep.has(index)) continue;
        if (spent + part.costs[index] > totalBudget) break;
        keep.add(index);
        spent += part.costs[index];
        headUsed += part.costs[index];
      }
      let tailUsed = 0;
      for (let index = part.lines.length - 1; index >= 0 && tailUsed < perBlock / 2; index--) {
        if (keep.has(index)) continue;
        if (spent + part.costs[index] > totalBudget) break;
        keep.add(index);
        spent += part.costs[index];
        tailUsed += part.costs[index];
      }
    }
  }

  // Everything else is one pool, ranked purely by how much it carries.
  const pool = [];
  for (const part of scored) {
    const keep = keeps.get(part.blockIndex);
    for (let index = 0; index < part.lines.length; index++) {
      if (keep.has(index)) continue;
      if (part.lines[index].trim().length === 0) continue;
      pool.push({
        blockIndex: part.blockIndex,
        index,
        score: part.scores[index],
        cost: part.costs[index],
      });
    }
  }
  pool.sort((left, right) => right.score - left.score || left.blockIndex - right.blockIndex || left.index - right.index);
  for (const candidate of pool) {
    if (spent + candidate.cost > totalBudget) continue;
    keeps.get(candidate.blockIndex).add(candidate.index);
    spent += candidate.cost;
  }

  return { keeps, budgetExceeded, protectedTokens, spent };
}

/** Fewest samples a column needs before its 2σ bound means anything. */
const MIN_ANOMALY_COLUMN = 8;
/**
 * Largest share of a column the 2σ rule may brand before the column is not an
 * outlier test at all.
 *
 * Two standard deviations flag ~4.6% of a normal column, so one eighth is nearly
 * three times that and still leaves a genuine outlier set intact. A column that
 * flags a large share of its own values is either several fields sharing one key
 * or a genuinely multimodal field; in both cases the flagged lines are normal
 * traffic, and additives are kept unconditionally, so blessing them spends the
 * whole budget on nothing.
 */
const ANOMALY_MAX_FLAGGED_SHARE = 1 / 8;
/** `label=value` / `label: value`, the value numeric with an optional unit. */
const LABELLED_MEASUREMENT = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*([-+]?\d+(?:\.\d+)?)[A-Za-z%]{0,4}$/;
/** A bare numeric token, optionally unit-suffixed (`42ms`, `512mb`, `-3.5`). */
const BARE_MEASUREMENT = /^([-+]?\d+(?:\.\d+)?)[A-Za-z%]{0,4}$/;

/**
 * Numeric measurements of one line, each with the field it belongs to.
 *
 * The key is the label when the token has one, so a column is one field rather
 * than one position. Digits inside an identifier are not measurements at all:
 * `requestId=req-1f4` and `req-a` differ in digit count, and counting those
 * digits shifted every later column by one, merging unrelated fields into a
 * bimodal column — measured on a 900-line service log, that branded 22% of the
 * routine lines as outliers, which made them all additive and disposed of the
 * budget (7,452 tokens rendered for a 200-token request, identical at 2,000).
 * An ISO timestamp is excluded by the same rule.
 *
 * @param {string} line - one line of the block.
 * @returns {{ key: string, text: string }[]} measurements with column keys.
 */
function measurementsOf(line) {
  const measurements = [];
  let bare = 0;
  for (const raw of line.split(/\s+/)) {
    if (raw.length === 0) continue;
    const token = raw.replace(/^[^\w=:+-]+/, '').replace(/[^\w%.+-]+$/, '');
    if (token.length === 0) continue;
    const labelled = LABELLED_MEASUREMENT.exec(token);
    if (labelled !== null) {
      measurements.push({ key: labelled[1].toLowerCase(), text: labelled[2] });
      continue;
    }
    const plain = BARE_MEASUREMENT.exec(token);
    if (plain !== null) measurements.push({ key: `#${bare++}`, text: plain[1] });
  }
  return measurements;
}

/**
 * Find numeric fields whose value is a strong outlier relative to the rest.
 *
 * @param {string[]} lines - candidate lines.
 * @returns {Set<number>} indices of lines holding an anomalous value.
 */
function numericAnomalies(lines) {
  const columns = new Map();
  const parsed = [];
  /** Lines holding a value the platform cannot represent — itself an anomaly. */
  const unrepresentable = new Set();
  for (let index = 0; index < lines.length; index++) {
    const measurements = measurementsOf(lines[index]);
    if (measurements.length === 0) continue;
    parsed.push({ index, measurements });
    for (const measurement of measurements) {
      const value = Number(measurement.text);
      // A 400-digit literal becomes Infinity, which would poison the column's
      // mean and standard deviation and suppress every real anomaly in it.
      // Keeping it out of the statistics and flagging the line directly is both
      // safer and more accurate: a number too large to parse is worth showing.
      if (!Number.isFinite(value)) {
        unrepresentable.add(index);
        continue;
      }
      const bucket = columns.get(measurement.key) ?? [];
      bucket.push(value);
      columns.set(measurement.key, bucket);
    }
  }
  const bounds = new Map();
  for (const [key, values] of columns) {
    if (values.length < MIN_ANOMALY_COLUMN) continue;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const deviation = Math.sqrt(variance);
    if (deviation === 0) continue;
    bounds.set(key, { mean, deviation });
  }
  const hitsByColumn = new Map();
  for (const entry of parsed) {
    for (const measurement of entry.measurements) {
      const bound = bounds.get(measurement.key);
      if (bound === undefined) continue;
      const value = Number(measurement.text);
      if (!Number.isFinite(value)) continue;
      if (Math.abs(value - bound.mean) > 2 * bound.deviation) {
        const hits = hitsByColumn.get(measurement.key) ?? new Set();
        hits.add(entry.index);
        hitsByColumn.set(measurement.key, hits);
      }
    }
  }
  const flagged = new Set(unrepresentable);
  for (const [key, hits] of hitsByColumn) {
    // See ANOMALY_MAX_FLAGGED_SHARE: a column branding this much of itself is
    // describing its own spread, not finding an outlier in it.
    if (hits.size > columns.get(key).length * ANOMALY_MAX_FLAGGED_SHARE) continue;
    for (const index of hits) flagged.add(index);
  }
  return flagged;
}

/**
 * Score every line for how much information it carries.
 *
 * Higher is more worth keeping. The scale is arbitrary but ordered: additive
 * content already skipped this path, so these scores only arbitrate the
 * remaining budget.
 *
 * @param {string[]} lines - candidate lines.
 * @param {{ isRead?: boolean, boost?: Record<string, number> }} context - whether
 *   the payload is a `read` result, and any type-specific line weights from
 *   `policy.js` (an unrecognised key is ignored).
 * @returns {{ scores: number[], additive: Set<number>, duplicates: Set<number> }} the scoring result.
 */
export function scoreLines(lines, context) {
  const scores = new Array(lines.length).fill(0);
  const additive = new Set();
  const duplicates = new Set();
  const seen = new Map();
  const anomalies = numericAnomalies(lines);
  const boost = context.boost ?? {};
  const boosted = Object.keys(boost).length === 0 ? [] : Object.entries(boost)
    .filter(([name]) => name in TYPE_LINE_PATTERNS)
    .map(([name, weight]) => [TYPE_LINE_PATTERNS[name], weight]);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Type-specific weights land first so a diff hunk header or a search match
    // outranks the generic structural bonus below.
    for (const [pattern, weight] of boosted) {
      if (pattern.test(line)) scores[index] += weight;
    }

    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(line)) {
        additive.add(index);
        scores[index] += 10000;
        break;
      }
    }

    for (const pattern of STRUCTURAL_PATTERNS) {
      if (pattern.test(line)) {
        scores[index] += 600;
        break;
      }
    }

    if (anomalies.has(index)) {
      additive.add(index);
      scores[index] += 5000;
    }

    // Uniqueness: a line whose word set has not been seen carries new content.
    const signature = mask(trimmed);
    const tokenSet = words(signature);
    let novel = 0;
    for (const token of new Set(tokenSet)) {
      if (!seen.has(token)) novel++;
      seen.set(token, (seen.get(token) ?? 0) + 1);
    }
    if (tokenSet.length > 0) {
      const novelty = novel / new Set(tokenSet).size;
      scores[index] += Math.round(novelty * 400);
      if (novelty === 0) {
        duplicates.add(index);
        scores[index] -= 200;
      }
    }

    // Information density: a long line usually carries more than a short one,
    // but the term saturates so one enormous line cannot monopolise the budget.
    scores[index] += Math.min(200, Math.round(Math.log2(trimmed.length + 1) * 20));

    // Indentation depth marks structure in source and nested output.
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && context.isRead) scores[index] += 150;
  }

  return { scores, additive, duplicates };
}

/**
 * Choose which line indices to keep within a budget.
 *
 * Order matters, and it is the whole point of this function:
 *
 *  1. **Additive lines are taken first and unconditionally.** They carry
 *     outcome information — an error, an anomaly, a structural marker. Dropping
 *     them to hit a number is how a bounded log becomes a misleading one, and
 *     the budget is a soft target precisely so this layer can override it.
 *  2. **The opening and closing guarantees** take from whatever budget remains.
 *  3. **Scored fill** spends the rest, highest score first.
 *
 * When protection alone exceeds the budget the result reports `budgetExceeded`
 * with the reason, and steps 2 and 3 contribute nothing — the alternative,
 * silently discarding protected lines, produces a payload that looks bounded
 * and is missing exactly the part that mattered.
 *
 * @param {string[]} lines - candidate lines.
 * @param {number} budget - token budget for the kept set (soft).
 * @param {{ isRead?: boolean, boost?: Record<string, number> }} context - scoring context.
 * @param {{ headBudgetRatio: number }} options - resolved kernel options.
 * @returns {{ keep: number[], tokens: number, additiveKept: number,
 *   protectedTokens: number, protectedLines: number, budgetExceeded: boolean,
 *   overflowReason: string | null }} the selection.
 */
export function selectByImportance(lines, budget, context, options) {
  const { scores, additive } = scoreLines(lines, context);
  const costs = lines.map((line) => estimateTokens(line) + 1);
  const keep = new Set();
  let spent = 0;

  // A protected line is rarely readable alone: a stack trace needs the frame
  // above it, a log error needs the request line below it. The neighbourhood is
  // taken unconditionally with the line itself, and a Set collapses the overlap
  // where two protected lines sit close together.
  const protectedSet = protectedIndicesOf(additive, lines.length);
  for (const index of protectedSet) {
    keep.add(index);
    spent += costs[index];
  }
  const protectedTokens = spent;
  const protectedLines = protectedSet.size;
  const budgetExceeded = spent > budget;

  // A bounded opening and closing still matters, but only with room left over.
  // These lines join the protected set: they carry structure and the outcome,
  // and a later render-measure-withdraw pass must not take them back.
  const headBudget = Math.max(0, Math.floor(budget * options.headBudgetRatio * 0.45));
  for (let index = 0; index < lines.length && spent < headBudget; index++) {
    if (keep.has(index)) continue;
    if (spent + costs[index] > budget) break;
    keep.add(index);
    protectedSet.add(index);
    spent += costs[index];
  }

  const tailBudget = Math.max(0, Math.floor(budget * options.headBudgetRatio * 0.25));
  let tailSpent = 0;
  for (let index = lines.length - 1; index >= 0 && tailSpent < tailBudget; index--) {
    if (keep.has(index)) continue;
    if (spent + costs[index] > budget) break;
    keep.add(index);
    protectedSet.add(index);
    spent += costs[index];
    tailSpent += costs[index];
  }

  // Then the highest scores, skipping whatever is already in.
  const ranked = [];
  for (let index = 0; index < lines.length; index++) {
    if (keep.has(index) || lines[index].trim().length === 0) continue;
    ranked.push(index);
  }
  ranked.sort((left, right) => scores[right] - scores[left] || left - right);
  for (const index of ranked) {
    if (spent + costs[index] > budget) continue;
    keep.add(index);
    spent += costs[index];
  }

  return {
    keep: [...keep].sort((left, right) => left - right),
    tokens: spent,
    additiveKept: additive.size,
    protectedIndices: [...protectedSet].sort((left, right) => left - right),
    protectedTokens,
    protectedLines,
    budgetExceeded,
    overflowReason: budgetExceeded
      ? `protected-content: ${protectedLines} protected lines need ${protectedTokens} tokens; the budget is ${budget}`
      : null,
    // Handed back so a caller can re-render and withdraw the least valuable
    // non-protected choices when the rendered total overruns the budget. Only
    // marker and envelope costs are invisible before rendering, and they are
    // exactly what made a plan that "fit" come out over.
    scores,
    costs,
  };
}
