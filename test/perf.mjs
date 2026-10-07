/**
 * Performance baseline for the bounding path.
 *
 * Bounding only runs on results that exceed their budget, so what matters is
 * the cost at realistic sizes rather than at the extreme. This prints a table
 * so a regression is visible as a number instead of a feeling.
 *
 * Usage: node test/perf.mjs
 */

import { resolveOptions, slimGenericText, slimReadText } from '../slim.js';

const options = resolveOptions({ readMaxResultTokens: 5000, maxResultTokens: 2000 });

/** Build a synthetic read envelope of roughly the requested size. */
function envelope(kilobytes, lineFactory) {
  const target = Math.round((kilobytes * 1024) / 60);
  const lines = [];
  for (let index = 0; index < target; index++) lines.push(`${index + 1}: ${lineFactory(index)}`);
  return {
    text: `<path>C:/tmp/f.ts</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n\n(End of file - total ${target} lines)\n</content>`,
    lineCount: target,
  };
}

/** Median of `runs` timings, in milliseconds. */
function timeIt(runs, body) {
  const samples = [];
  for (let index = 0; index < runs; index++) {
    const started = process.hrtime.bigint();
    body();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

const code = (index) => `const value${index} = compute(${index}, "${'x'.repeat(30)}");`;
const log = (index) => `2026-05-01T10:00:00Z INFO shard=${index} processed ${'p'.repeat(20)}`;
const errors = (index) => (index % 7 === 0 ? `ERROR shard=${index} connection refused` : code(index));

console.log('\n=== Bounding cost by input size ===\n');
console.log(`  ${'size'.padEnd(8)}${'lines'.padStart(8)}${'code'.padStart(10)}${'log'.padStart(10)}${'mixed'.padStart(10)}`);
for (const kilobytes of [10, 50, 100, 250, 500, 1000]) {
  const cells = [];
  let lineCount = 0;
  for (const factory of [code, log, errors]) {
    const built = envelope(kilobytes, factory);
    lineCount = built.lineCount;
    cells.push(`${timeIt(5, () => slimReadText(built.text, options)).toFixed(1)}ms`.padStart(10));
  }
  console.log(`  ${`${kilobytes}KB`.padEnd(8)}${String(lineCount).padStart(8)}${cells.join('')}`);
}

console.log('\n=== Passive (non-read) output ===\n');
console.log(`  ${'size'.padEnd(8)}${'generic'.padStart(10)}`);
for (const kilobytes of [50, 250, 1000]) {
  const built = envelope(kilobytes, log);
  console.log(
    `  ${`${kilobytes}KB`.padEnd(8)}${`${timeIt(5, () => slimGenericText(built.text, options)).toFixed(1)}ms`.padStart(10)}`,
  );
}

console.log('\n  Bounding is skipped entirely when a result fits its budget, so these');
console.log('  figures apply only to results that are actually over budget.\n');
