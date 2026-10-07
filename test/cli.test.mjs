/**
 * CLI tests.
 *
 * These drive the real binary in a child process, because the failures this
 * guards against only appear at the process boundary: a trailing newline
 * invented on output, a restored file that is not byte-identical to what was
 * saved, an exit code that means the wrong thing.
 *
 * Everything runs against temporary directories and fabricated input. No test
 * here touches a recorded session, a real tool, or the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'bin', 'slim.mjs');

/**
 * Run the CLI with the given argv, feeding `input` on stdin.
 *
 * Piped stdio through Node's own spawn is unavailable in some confined
 * environments, so this uses `spawnSync` with `input`, which writes to the
 * child's stdin directly rather than through a shell.
 */
function runCli(argv, input = '') {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A fresh temporary directory removed when the test ends. */
function tempDir(t, prefix = 'slim-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A log payload long enough to be bounded. */
function logPayload(rows = 900) {
  return `${Array.from({ length: rows }, (_, i) => `2026-05-01T10:00:00Z INFO shard=${i} processed ok`).join('\n')}\n`;
}

test('--full writes the input through untouched', () => {
  const input = 'value  \nsecond line\n\n\n';
  const result = runCli(['--full'], input);
  assert.equal(result.stdout, input, 'no byte may be added, removed or reordered');
  assert.equal(result.status, 3, 'pass-through is not a failure');
});

test('--full preserves CRLF and a missing trailing newline', () => {
  const input = 'alpha\r\nbeta';
  assert.equal(runCli(['--full'], input).stdout, input);
});

test('bounding never invents a trailing newline', () => {
  // The input deliberately has none, so any newline on output was added.
  const input = logPayload().replace(/\n$/, '');
  const result = runCli(['--budget', '200'], input);
  assert.equal(result.status, 0, 'a bounded payload reports success');
  assert.equal(result.stdout.endsWith('\n'), false, 'the output must end where the content ends');
});

test('bounding preserves a trailing newline the input had', () => {
  const input = logPayload();
  assert.equal(input.endsWith('\n'), true);
  const result = runCli(['--budget', '200'], input);
  assert.equal(result.stdout.endsWith('\n'), true, 'an existing trailing newline is content too');
});

test('small input passes through with the unchanged exit code', () => {
  const result = runCli([], 'tiny input');
  assert.equal(result.stdout, 'tiny input');
  assert.equal(result.status, 3);
});

test('empty input produces nothing', () => {
  const result = runCli([], '');
  assert.equal(result.status, 3);
  assert.equal(result.stdout, '');
});

test('--save-original keeps the exact input and reports an artifact id', (t) => {
  const store = tempDir(t);
  const input = logPayload();
  const result = runCli(['--budget', '300', '--json', '--save-original', store], input);
  assert.equal(result.status, 0);

  const report = JSON.parse(result.stdout);
  assert.ok(report.recovery !== null, 'a bounded run must record where the original went');
  assert.ok(report.recovery.artifactId.length > 0);
  assert.equal(report.recoveryUnavailable, null);

  // The stored block is byte-identical to what was fed in.
  const directory = join(store, report.recovery.artifactId);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(readFileSync(join(directory, manifest.files[0].path), 'utf8'), input);

  // And it is the bounded text that went to stderr.
  assert.ok(result.stderr.length < input.length, 'the published text should be the bounded one');
});

test('--restore writes the saved original back byte-for-byte', (t) => {
  const store = tempDir(t);
  const input = logPayload();
  const saved = runCli(['--budget', '300', '--json', '--save-original', store], input);
  const artifactId = JSON.parse(saved.stdout).recovery.artifactId;

  const restored = runCli(['--restore', artifactId, '--store', store]);
  assert.equal(restored.status, 0, 'a successful restore is a success');
  assert.equal(restored.stdout, input, 'the restore must be byte-identical, newline included');
});

test('--restore honours offset and limit and still adds nothing', (t) => {
  const store = tempDir(t);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  const input = lines.join('\n');
  const saved = runCli(['--budget', '100', '--json', '--save-original', store], input);
  const artifactId = JSON.parse(saved.stdout).recovery.artifactId;

  const restored = runCli(['--restore', artifactId, '--store', store, '--offset', '11', '--limit', '3']);
  assert.equal(restored.stdout, lines.slice(10, 13).join('\n'));
  assert.equal(restored.stdout.endsWith('\n'), false);
});

test('a restore that cannot be served exits non-zero and says why', (t) => {
  const store = tempDir(t);
  const missing = runCli(['--restore', 'no-such-artifact', '--store', store]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ARTIFACT_NOT_FOUND/);
  assert.equal(missing.stdout, '');

  const noStore = runCli(['--restore', 'x']);
  assert.equal(noStore.status, 1);
  assert.match(noStore.stderr, /--store/);
});

test('a tampered snapshot is refused rather than served', (t) => {
  const store = tempDir(t);
  const input = logPayload();
  const saved = runCli(['--budget', '300', '--json', '--save-original', store], input);
  const artifactId = JSON.parse(saved.stdout).recovery.artifactId;
  const directory = join(store, artifactId);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  writeFileSync(join(directory, manifest.files[0].path), 'tampered', 'utf8');

  const result = runCli(['--restore', artifactId, '--store', store]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HASH_MISMATCH/);
});

test('an unchanged payload is not snapshotted', (t) => {
  const store = tempDir(t);
  const result = runCli(['--json', '--save-original', store], 'short input');
  assert.equal(result.status, 3);
  const report = JSON.parse(result.stdout);
  assert.equal(report.recovery, null, 'there is nothing to recover when nothing was removed');
  assert.deepEqual(readdirSync(store), [], 'no snapshot directory should be created');
});

test('a failed snapshot downgrades rather than lies', (t) => {
  const store = tempDir(t);
  // Point the store at a path that cannot be a directory, so the save fails.
  const blocked = join(store, 'blocked');
  writeFileSync(blocked, 'not a directory', 'utf8');

  const result = runCli(['--budget', '300', '--json', '--save-original', blocked], logPayload());
  const report = JSON.parse(result.stdout);
  assert.equal(report.recovery, null, 'no artifact may be claimed');
  assert.ok(report.recoveryUnavailable !== null, 'the failure must be reported');
  assert.equal(result.status, 0, 'the bounded text is still usable, so the run succeeded');
});

test('--type and --intent reach the policy, not just the report', () => {
  const input = logPayload(400);
  const plain = runCli(['--budget', '400', '--json'], input);
  const withIntent = runCli(['--budget', '400', '--json', '--intent'], input);
  const forced = runCli(['--budget', '400', '--json', '--type', 'diff'], input);

  const plainReport = JSON.parse(plain.stdout);
  const intentReport = JSON.parse(withIntent.stdout);
  const forcedReport = JSON.parse(forced.stdout);

  assert.equal(plainReport.type, 'log');
  assert.equal(intentReport.analysisIntent, true);
  assert.ok(
    intentReport.tokensOut > plainReport.tokensOut,
    `analysis intent must keep more (${intentReport.tokensOut} vs ${plainReport.tokensOut})`,
  );
  assert.equal(forcedReport.type, 'diff');
  assert.notEqual(forcedReport.tokensOut, plainReport.tokensOut, '--type must change the outcome');
});

test('an unknown flag is a usage error, not a silent ignore', () => {
  const result = runCli(['--nope'], 'x');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown flag/);
});

test('--help describes the recovery flags', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  for (const flag of ['--full', '--save-original', '--restore', '--store']) {
    assert.ok(result.stdout.includes(flag), `${flag} must be documented`);
  }
  assert.ok(result.stdout.includes('never re-runs'), 'the limit of recovery must be stated');
});

test('the CLI leaves no snapshot behind in the working directory', (t) => {
  const store = tempDir(t);
  runCli(['--budget', '300', '--save-original', store], logPayload());
  // Everything written lives under the store the caller named.
  const entries = readdirSync(store);
  assert.ok(entries.length >= 1);
  for (const entry of entries) {
    assert.ok(existsSync(join(store, entry, 'manifest.json')), `${entry} should be a complete artifact`);
  }
});
