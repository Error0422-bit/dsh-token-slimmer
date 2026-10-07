/**
 * Default test entry point.
 *
 * Runs the kernel suite, then every `*.test.mjs` in this directory in filename
 * order. Discovery is deliberately narrow: the scripts that replay recorded
 * transcripts or measure budgets need real session logs or spend money, so they
 * are excluded by name rather than by being placed in a subdirectory someone
 * will later "fix" by moving them.
 *
 * Usage: npm test   (or node test/all.mjs)
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Suites excluded from the default run, and why. */
const EXCLUDED = new Map([
  ['all.mjs', 'this entry point'],
  ['replay.mjs', 'reads recorded sessions from the local DSH data directory'],
  ['audit.mjs', 'reads recorded sessions from the local DSH data directory'],
  ['inspect.mjs', 'human-inspection tool, prints rather than asserts'],
  ['strategy.mjs', 'reads recorded sessions from the local DSH data directory'],
  ['reasoning.mjs', 'reads recorded sessions from the local DSH data directory'],
  ['reasoning-cost.mjs', 'reads recorded sessions from the local DSH data directory'],
  ['reasoning-net.mjs', 'reads recorded sessions from the local DSH data directory'],
  ['budget-swap.mjs', 'reads recorded sessions from the local DSH data directory'],
  ['cost-replay.mjs', 'reads recorded sessions from the local DSH data directory'],
  ['perf.mjs', 'timing baseline, sensitive to machine load'],
]);

/** Run one script and return its exit code. */
function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(here, script), ...args], {
    stdio: 'inherit',
    cwd: join(here, '..'),
  });
  if (result.error !== undefined) {
    process.stderr.write(`all: could not run ${script}: ${String(result.error)}\n`);
    return 1;
  }
  return result.status ?? 1;
}

const failures = [];

console.log('\n### kernel suite (test/run.mjs)\n');
if (run('run.mjs') !== 0) failures.push('run.mjs');

const unitTests = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const name of unitTests) {
  console.log(`\n### ${name}\n`);
  if (run(name, ['--test']) !== 0) failures.push(name);
}

const discoveredButUnrunnable = readdirSync(here).filter(
  (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && name !== 'run.mjs' && !EXCLUDED.has(name),
);
if (discoveredButUnrunnable.length > 0) {
  console.log(
    `\n  note: ${discoveredButUnrunnable.length} script(s) not in the default run and not listed as excluded: ` +
      `${discoveredButUnrunnable.join(', ')}\n`,
  );
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(', ')}\n`);
  process.exit(1);
}
console.log(`\nAll suites passed (${1 + unitTests.length} runners).\n`);
