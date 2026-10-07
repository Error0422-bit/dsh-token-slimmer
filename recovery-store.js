/**
 * Original-text storage for lossy results.
 *
 * The escape hatch this replaces was "call the same tool again and you will get
 * the full output". That is not recovery: it re-runs the tool, so a result
 * derived from a clock, a counter, a live service or a mutable file comes back
 * different — or does not come back at all. A bounded result that cannot be
 * restored to the exact text the plugin received is data loss with extra steps.
 *
 * So before a lossy candidate is published, the text it was derived from is
 * written here, and the model is told where to read it. Recovery is a file
 * read, not a tool execution.
 *
 * Layout, one directory per result:
 *
 *     <rootDir>/<artifactId>/manifest.json
 *     <rootDir>/<artifactId>/block-0.txt
 *     <rootDir>/<artifactId>/block-1.txt
 *
 * `artifactId` is a UUID, so results from different sessions cannot collide
 * even though the directories are flat; `sessionId` is recorded in the manifest
 * for attribution and cleanup rather than used as a path component, which keeps
 * `read()` resolvable without knowing which session produced a result.
 *
 * @module dsh-token-slimmer/recovery-store
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Manifest filename inside each artifact directory. */
export const MANIFEST_NAME = 'manifest.json';

/** Default ceiling on everything this store keeps, in bytes: 256 MiB. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** A recovery failure a caller is expected to handle. */
export class RecoveryError extends Error {
  /**
   * @param {string} message - human-readable cause.
   * @param {string} code - stable machine-routable class.
   */
  constructor(message, code) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

/** Hex SHA-256 of a string's UTF-8 bytes. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Restrict one identifier to a safe single path segment. */
function safeSegment(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return cleaned.length === 0 ? 'unknown' : cleaned;
}

/** Read and parse one artifact manifest, or null when it is absent or broken. */
function readManifest(directory) {
  const path = join(directory, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    // A truncated manifest is indistinguishable from an absent one to a caller
    // that only wants to know whether recovery is possible.
    return null;
  }
}

/** Total bytes recorded by every manifest under `root`. */
function usedBytes(root) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(root, entry.name));
    if (manifest === null) continue;
    for (const file of manifest.files) {
      if (Number.isFinite(file.bytes)) total += file.bytes;
    }
    total += Buffer.byteLength(JSON.stringify(manifest), 'utf8');
  }
  return total;
}

/**
 * Create a recovery store rooted at one directory.
 *
 * @param {object} config - store configuration.
 * @param {string} config.rootDir - directory to own. Created on demand.
 * @param {number} [config.maxBytes] - ceiling for the whole store.
 * @returns {{ save: Function, read: Function, ownsPath: Function,
 *   usedBytes: Function, list: Function, rootDir: string }} the store.
 */
export function createRecoveryStore({ rootDir, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new RecoveryError('recovery store needs a rootDir', 'INVALID_ROOT');
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RecoveryError('recovery store needs a positive maxBytes', 'INVALID_QUOTA');
  }
  const root = resolve(rootDir);

  /**
   * Persist the exact text blocks a lossy result was derived from.
   *
   * Text blocks are written as separate UTF-8 files; non-text blocks are
   * recorded structurally so a caller can tell what surrounded the text, but
   * their content is not duplicated — the store's job is text recovery.
   *
   * @param {object} input - what to save.
   * @param {string} input.sessionId - owning session, for attribution.
   * @param {string} input.callId - the tool call this came from.
   * @param {readonly object[]} input.blocks - the tool result's content blocks.
   * @returns {{ artifactId: string, totalBytes: number,
   *   files: { blockIndex: number, path: string, sha256: string, bytes: number,
   *   lines: number }[] }} the saved artifact.
   * @throws {RecoveryError} with code `QUOTA_EXCEEDED` or `WRITE_FAILED`.
   */
  function save({ sessionId, callId, blocks }) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new RecoveryError('nothing to save', 'EMPTY_INPUT');
    }
    const textBlocks = [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        textBlocks.push({ blockIndex: index, text: block.text });
      }
    }
    if (textBlocks.length === 0) {
      throw new RecoveryError('no text blocks to save', 'EMPTY_INPUT');
    }

    const payloadBytes = textBlocks.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0);
    const current = usedBytes(root);
    // The ceiling is checked before anything is written, so a refused save
    // leaves no partial artifact behind for a later read to trip over.
    if (current + payloadBytes > maxBytes) {
      throw new RecoveryError(
        `recovery quota exhausted: ${current} bytes used, ${payloadBytes} more requested, ${maxBytes} allowed`,
        'QUOTA_EXCEEDED',
      );
    }

    const artifactId = randomUUID();
    const directory = join(root, artifactId);
    const files = [];
    try {
      mkdirSync(directory, { recursive: true });
      for (const entry of textBlocks) {
        const name = `block-${entry.blockIndex}.txt`;
        const absolute = join(directory, name);
        writeFileSync(absolute, entry.text, 'utf8');
        files.push({
          blockIndex: entry.blockIndex,
          // Relative for the manifest, which must stay valid if the store is
          // moved, and absolute for the marker text, which a model has to be
          // able to hand straight to `read`. Returning only the relative name
          // was a real defect: the published marker pointed at "block-0.txt",
          // which resolves against the agent's working directory, not the store.
          path: name,
          absolutePath: absolute,
          sha256: sha256(entry.text),
          bytes: Buffer.byteLength(entry.text, 'utf8'),
          lines: entry.text.split('\n').length,
        });
      }
      const manifest = {
        artifactId,
        sessionId: String(sessionId ?? 'unknown'),
        callId: String(callId ?? 'unknown'),
        createdAt: new Date().toISOString(),
        totalBytes: payloadBytes,
        files,
      };
      writeFileSync(join(directory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } catch (error) {
      throw new RecoveryError(`could not persist the original: ${String(error)}`, 'WRITE_FAILED');
    }
    return { artifactId, totalBytes: payloadBytes, files };
  }

  /**
   * Read a range of one saved block back, verifying it is unchanged.
   *
   * @param {object} request - what to read.
   * @param {string} request.artifactId - from {@link save}.
   * @param {number} [request.blockIndex] - which block, defaulting to the first saved.
   * @param {number} [request.offset] - 1-based first line, as the `read` tool means it.
   * @param {number} [request.limit] - maximum lines; omitted means to the end.
   * @returns {{ text: string, offset: number, totalLines: number, path: string }} the range.
   * @throws {RecoveryError} with code `ARTIFACT_NOT_FOUND`, `BLOCK_NOT_FOUND`,
   *   `HASH_MISMATCH`, or `FILE_MISSING`.
   */
  function read({ artifactId, blockIndex, offset = 1, limit }) {
    const directory = join(root, safeSegment(artifactId));
    const manifest = readManifest(directory);
    if (manifest === null) {
      throw new RecoveryError(`no saved original for artifact ${artifactId}`, 'ARTIFACT_NOT_FOUND');
    }
    const wanted = blockIndex ?? manifest.files[0]?.blockIndex;
    const entry = manifest.files.find((file) => file.blockIndex === wanted);
    if (entry === undefined) {
      throw new RecoveryError(`artifact ${artifactId} has no block ${String(wanted)}`, 'BLOCK_NOT_FOUND');
    }
    const path = join(directory, entry.path);
    if (!existsSync(path)) {
      throw new RecoveryError(`block file for ${artifactId} is missing: ${entry.path}`, 'FILE_MISSING');
    }
    const text = readFileSync(path, 'utf8');
    // Integrity matters more than speed here: recovery is rare, and silently
    // handing back a truncated or edited file would be worse than failing.
    const actual = sha256(text);
    if (actual !== entry.sha256) {
      throw new RecoveryError(
        `saved original for ${artifactId} block ${wanted} changed on disk (expected ${entry.sha256.slice(0, 12)}, found ${actual.slice(0, 12)})`,
        'HASH_MISMATCH',
      );
    }
    const start = Math.max(1, Number.isFinite(offset) ? Math.floor(offset) : 1);
    const lines = text.split('\n');
    const end = Number.isFinite(limit) ? Math.min(lines.length, start - 1 + Math.floor(limit)) : lines.length;
    return {
      text: lines.slice(start - 1, end).join('\n'),
      offset: start,
      totalLines: lines.length,
      path,
    };
  }

  /**
   * Whether a path is a file this store wrote, and still holds what it wrote.
   *
   * The plugin uses this to keep `read` from compressing a recovery read. The
   * bypass is a promise that what the model receives is the original, so
   * membership in the manifest is not enough: a file still sitting at the
   * recorded path may have been rewritten since — by a shell command the model
   * itself ran, or by anything else on the machine — and publishing those bytes
   * as "the saved original" would be a lie the model cannot detect.
   *
   * The manifest already carries a hash per file, so the check is exact rather
   * than heuristic. It happens here, on the path, rather than after the read:
   * by the time the result exists it has been rendered into an envelope, and
   * nothing in it hashes to the file any more.
   *
   * @param {string} candidate - an absolute or relative path.
   * @returns {{ owned: boolean, verified: boolean, reason?: string }} ownership
   *   and whether the content still matches the recorded hash. `owned` with
   *   `verified: false` means the path is ours but must not be trusted.
   */
  function inspect(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return { owned: false, verified: false };
    }
    const resolved = resolve(candidate);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return { owned: false, verified: false };
    }
    const relative = resolved.slice(root.length + 1);
    const parts = relative.split(sep);
    if (parts.length !== 2) return { owned: false, verified: false };
    const [directoryName, fileName] = parts;
    const manifest = readManifest(join(root, directoryName));
    if (manifest === null) return { owned: false, verified: false };
    if (fileName === MANIFEST_NAME) return { owned: true, verified: true };

    const entry = manifest.files.find((file) => file.path === fileName);
    if (entry === undefined) return { owned: false, verified: false };
    if (!existsSync(resolved)) {
      return { owned: true, verified: false, reason: 'FILE_MISSING' };
    }
    try {
      const actual = sha256(readFileSync(resolved, 'utf8'));
      if (actual !== entry.sha256) {
        return {
          owned: true,
          verified: false,
          reason: `HASH_MISMATCH: expected ${entry.sha256.slice(0, 12)}, found ${actual.slice(0, 12)}`,
        };
      }
      return { owned: true, verified: true };
    } catch (error) {
      return { owned: true, verified: false, reason: `UNREADABLE: ${String(error)}` };
    }
  }

  /**
   * Whether a path is a file this store wrote.
   *
   * Kept for callers that only need the path question; a caller deciding whether
   * to trust the content must use {@link inspect}, which also checks the hash.
   *
   * @param {string} candidate - an absolute or relative path.
   * @returns {boolean} whether the store owns it.
   */
  function ownsPath(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    const resolved = resolve(candidate);
    if (resolved !== root && !resolved.startsWith(root + sep)) return false;
    const relative = resolved.slice(root.length + 1);
    const parts = relative.split(sep);
    if (parts.length !== 2) return false;
    const [directoryName, fileName] = parts;
    const manifest = readManifest(join(root, directoryName));
    if (manifest === null) return false;
    if (fileName === MANIFEST_NAME) return true;
    return manifest.files.some((file) => file.path === fileName);
  }

  /**
   * Every artifact this store holds, newest first.
   * @returns {{ artifactId: string, sessionId: string, callId: string,
   *   createdAt: string, totalBytes: number, files: number }[]} the inventory.
   */
  function list() {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = readManifest(join(root, entry.name));
      if (manifest === null) continue;
      found.push({
        artifactId: manifest.artifactId ?? entry.name,
        sessionId: manifest.sessionId ?? 'unknown',
        callId: manifest.callId ?? 'unknown',
        createdAt: manifest.createdAt ?? '',
        totalBytes: manifest.totalBytes ?? 0,
        files: manifest.files.length,
      });
    }
    return found.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  }

  return { save, read, ownsPath, inspect, list, usedBytes: () => usedBytes(root), rootDir: root };
}

/**
 * The default store location for one session, under the DSH data directory.
 *
 * Results are not deleted automatically, so this directory grows until the
 * caller removes it; that is deliberate, because a recovery target that
 * disappears after an arbitrary interval is not a recovery target.
 *
 * @param {string} sessionId - owning session.
 * @param {string} [home] - DSH home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns {string} the directory to root a store at.
 */
export function defaultStoreDir(sessionId, home) {
  const base =
    home ??
    process.env.DSH_HOME ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
  return join(base, 'token-slimmer-results', safeSegment(sessionId));
}

/** Size of one file on disk, or 0 when it is gone. */
export function fileBytes(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
