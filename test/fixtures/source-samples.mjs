/**
 * Deterministic synthetic fixtures.
 *
 * The regression suite used to read real harness sources from an absolute path
 * under the author's home directory, which made the suite unrunnable anywhere
 * else and coupled a kernel test to a specific installation. These fixtures
 * exist so the default suite is portable: same shapes, same size classes, no
 * machine-specific dependency.
 *
 * They are deliberately *not* substitutes for real measurement. Compressing
 * synthetic code says nothing about compressing your repository — the scripts
 * under `test/` that read real transcripts are the measurement tools, and they
 * stay out of the default suite for exactly that reason.
 *
 * @module test/fixtures/source-samples
 */

/** A small deterministic PRNG so every fixture is byte-identical across runs. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Source-shaped text: imports, declarations, comments, nested blocks.
 *
 * @param {number} lines - approximate line count.
 * @returns {string} the fixture.
 */
export function syntheticSource(lines) {
  const random = makeRandom(0x5eed);
  const out = ['import { Service } from "@scope/core";', 'import path from "node:path";', ''];
  let index = 0;
  while (out.length < lines) {
    const roll = random();
    if (roll < 0.12) {
      out.push(`// ${index}: ${'comment about the next declaration '.repeat(1 + Math.floor(random() * 3)).trim()}`);
    } else if (roll < 0.3) {
      out.push(`export function handler${index}(input, options = {}) {`);
      out.push('  if (input === undefined) throw new TypeError("input is required");');
      out.push(`  const resolved = path.resolve(options.root ?? process.cwd(), input);`);
      out.push(`  return { resolved, index: ${index}, retries: options.retries ?? 3 };`);
      out.push('}');
      out.push('');
    } else if (roll < 0.45) {
      out.push(`const CONSTANT_${index} = ${Math.floor(random() * 100000)};`);
    } else if (roll < 0.75) {
      out.push(`  if (value === ${index}) {`);
      out.push(`    return apply(value, ${index}, { flag: ${random() < 0.5} });`);
      out.push('  }');
    } else {
      out.push(`  logger.debug("step ${index}", { attempt: ${Math.floor(random() * 10)}, ok: true });`);
    }
    index++;
  }
  return out.slice(0, lines).join('\n');
}

/**
 * Log-shaped text with a small number of errors buried in the middle.
 *
 * @param {number} lines - approximate line count.
 * @param {object} [options] - placement controls.
 * @param {number} [options.errorCount] - how many error lines to insert.
 * @returns {string} the fixture.
 */
export function syntheticLog(lines, options = {}) {
  const errorCount = options.errorCount ?? Math.max(1, Math.floor(lines / 400));
  const random = makeRandom(0xc0ffee);
  const out = [];
  const stride = Math.max(1, Math.floor(lines / (errorCount + 1)));
  for (let index = 0; index < lines; index++) {
    const stamp = `2026-05-01T${String(10 + (index % 12)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`;
    if (index > 0 && index % stride === 0 && out.filter((row) => row.includes(' ERROR ')).length < errorCount) {
      out.push(`${stamp} ERROR shard=${index % 64} connection refused by upstream at attempt ${index}`);
    } else if (random() < 0.02) {
      out.push(`${stamp} WARN shard=${index % 64} retry scheduled`);
    } else {
      out.push(`${stamp} INFO shard=${index % 64} processed batch ${index} in ${Math.floor(random() * 500)}ms`);
    }
  }
  return out.join('\n');
}

/**
 * JSON array of records, the shape a tool returns from an API call.
 *
 * @param {number} items - record count.
 * @returns {string} the fixture.
 */
export function syntheticJson(items) {
  const random = makeRandom(0xbeef);
  const records = [];
  for (let index = 0; index < items; index++) {
    records.push({
      id: index,
      name: `record-${index}`,
      status: index % 97 === 0 ? 'failed' : 'ok',
      durationMs: Math.floor(random() * 1000),
      tags: ['alpha', 'beta'].slice(0, 1 + (index % 2)),
    });
  }
  return JSON.stringify(records, null, 2);
}

/**
 * Unified diff with several hunks.
 *
 * @param {number} hunks - hunk count.
 * @returns {string} the fixture.
 */
export function syntheticDiff(hunks) {
  const out = ['diff --git a/src/app.ts b/src/app.ts', 'index 1a2b3c4..5d6e7f8 100644', '--- a/src/app.ts', '+++ b/src/app.ts'];
  for (let index = 0; index < hunks; index++) {
    const start = index * 40;
    out.push(`@@ -${start},7 +${start},8 @@ function section${index}()`);
    for (let row = 0; row < 6; row++) out.push(` context line ${index}:${row} ${'c'.repeat(24)}`);
    out.push(`+added line for hunk ${index} ${'a'.repeat(24)}`);
  }
  return out.join('\n');
}

/**
 * Render text the way the `read` tool renders it, so fixtures can exercise the
 * read-specific path without a filesystem.
 *
 * @param {string} displayPath - path to show in the envelope.
 * @param {string} text - body text.
 * @returns {string} the rendered result.
 */
export function asReadResult(displayPath, text) {
  const lines = text.split('\n');
  const numbered = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
  return [
    `<path>${displayPath}</path>`,
    '<type>file</type>',
    '<content>',
    numbered,
    '',
    `(End of file - total ${lines.length} lines)`,
    '</content>',
  ].join('\n');
}
