/**
 * Deterministic, complete-file read/write for the intent overlay.
 *
 * Reads never create the file: an absent overlay is a distinct `not_configured`
 * state, not an error and not an empty overlay. Writes validate first and are
 * atomic, so a rejected or interrupted write leaves the previous valid file
 * intact.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  type IntentValidationError,
  IntentValidationCode,
  type IntentValidationOptions,
  formatIntentValidationErrors,
  validateIntentFile,
} from './schema.js';
import type { IntentFileV2 } from './types.js';

export enum IntentOverlayStatus {
  Ready = 'ready',
  NotConfigured = 'not_configured',
  Invalid = 'invalid',
}

export type ReadIntentFileResult =
  | { status: IntentOverlayStatus.Ready; path: string; file: IntentFileV2 }
  | { status: IntentOverlayStatus.NotConfigured; path: string }
  | { status: IntentOverlayStatus.Invalid; path: string; errors: IntentValidationError[]; message: string };

/** Thrown instead of writing an invalid model — the file on disk stays valid. */
export class IntentValidationFailedError extends Error {
  constructor(
    readonly filePath: string,
    readonly errors: IntentValidationError[],
  ) {
    super(`intent.json at ${filePath} was rejected:\n${formatIntentValidationErrors(errors)}`);
    this.name = 'IntentValidationFailedError';
  }
}

/**
 * Canonical bytes for a model.
 *
 * Object keys are sorted so two equal models always produce identical bytes
 * regardless of construction order; ARRAY order is preserved because arrays here
 * are ordered data (flow steps, authored source lists) rather than sets.
 */
export function serializeIntentFile(file: IntentFileV2): string {
  return `${JSON.stringify(canonicalize(file), null, 2)}\n`;
}

/** Canonical JSON text for any intent value (used to compare items byte-for-byte). */
export function canonicalIntentJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/**
 * Hard read cap. The overlay is untrusted input (checked into a repo anyone may
 * open), and reading it into memory before validation is the one unbounded step
 * in this module. An overlay at the SCHEMA maximum — 500 items and 2000
 * relations of bounded text — serialises to well under a megabyte, so anything
 * past this is not an intent file.
 */
export const MAX_INTENT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Request-body ceiling for the cloud onboarding import (spec §8.1).
 *
 * The import body is `{ idempotencyKey, localRevision, overlay }` wrapped
 * around an overlay this module already capped at {@link MAX_INTENT_FILE_BYTES},
 * so the ceiling is that cap plus one megabyte of envelope headroom.
 *
 * It lives HERE, in the package both ends already depend on, because it must be
 * one number in two places: the server's per-route body guard (which answers 413
 * from `Content-Length` before the parser buffers anything) and the CLI's
 * pre-send check (which refuses naming this bound rather than letting a legal
 * maximal overlay come back as an opaque 413). Two copies would drift, and the
 * drift is invisible until an import at the boundary fails.
 */
export const MAX_INTENT_IMPORT_BODY_BYTES = MAX_INTENT_FILE_BYTES + 1024 * 1024;

export interface ReadIntentFileOptions extends IntentValidationOptions {
  /**
   * When set, the overlay's REAL path must stay inside this directory's real
   * path. Guards a symlink at `.coredoc/intent.json` pointing at a file outside
   * the checkout. Optional: without it no containment check runs.
   */
  containmentRoot?: string;
}

/** Read the complete overlay. Never creates or repairs the file. */
export function readIntentFile(filePath: string, options: ReadIntentFileOptions = {}): ReadIntentFileResult {
  if (!fs.existsSync(filePath)) {
    return { status: IntentOverlayStatus.NotConfigured, path: filePath };
  }

  let raw: string;
  try {
    // Every filesystem step lives inside this try: a directory, a device node, a
    // permission failure, or a race between stat and read must all surface as
    // `invalid`, and none of them may echo file content.
    const realPath = fs.realpathSync(filePath);

    if (options.containmentRoot !== undefined) {
      const realRoot = fs.realpathSync(options.containmentRoot);
      if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
        return malformed(filePath, 'path escapes repository');
      }
    }

    const stats = fs.statSync(realPath);
    if (!stats.isFile()) return malformed(filePath, 'not a regular file');
    if (stats.size > MAX_INTENT_FILE_BYTES) {
      return malformed(filePath, `larger than the ${MAX_INTENT_FILE_BYTES} byte intent overlay limit`);
    }

    raw = fs.readFileSync(realPath, 'utf-8');
  } catch (error) {
    return malformed(filePath, `unreadable (${errnoOf(error)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Node embeds the offending BYTES of the file in this message; only the
    // position is safe to pass on.
    return malformed(filePath, `not parseable as JSON${describeJsonErrorPosition(error)}`);
  }

  const result = validateIntentFile(parsed, options);
  if (!result.ok) return invalid(filePath, result.errors);
  return { status: IntentOverlayStatus.Ready, path: filePath, file: result.file };
}

function malformed(filePath: string, message: string): ReadIntentFileResult {
  const errors: IntentValidationError[] = [{ code: IntentValidationCode.Malformed, path: [], message }];
  return invalid(filePath, errors);
}

/** `EACCES`, `EISDIR`, … — an errno name carries no file content. */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/**
 * The only part of a `JSON.parse` failure that is safe to repeat: Node quotes
 * the offending BYTES of the input in `error.message`, so every surface that
 * reports a parse failure over untrusted intent JSON (the reader here, the CLI's
 * proposals input) renders the position and nothing else.
 */
export function describeJsonErrorPosition(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const position = /position (\d+)/.exec(message)?.[1];
  return position === undefined ? '' : ` at position ${position}`;
}

function invalid(filePath: string, errors: IntentValidationError[]): ReadIntentFileResult {
  return {
    status: IntentOverlayStatus.Invalid,
    path: filePath,
    errors,
    message: `intent.json at ${filePath} is invalid:\n${formatIntentValidationErrors(errors)}`,
  };
}

/** Validate, then write atomically (tmp + fsync + rename). Throws `IntentValidationFailedError` on rejection. */
export function writeIntentFile(filePath: string, file: IntentFileV2, options: IntentValidationOptions = {}): void {
  const result = validateIntentFile(file, options);
  if (!result.ok) throw new IntentValidationFailedError(filePath, result.errors);

  const content = serializeIntentFile(result.file);
  // Writer/reader symmetry: a write that succeeds must produce a file the reader
  // accepts, so the read-side size cap is enforced before anything touches disk.
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_INTENT_FILE_BYTES) {
    throw new IntentValidationFailedError(filePath, [
      {
        code: IntentValidationCode.Malformed,
        path: [],
        message: `serialized intent.json is ${bytes} bytes, above the ${MAX_INTENT_FILE_BYTES}-byte cap the reader enforces`,
      },
    ]);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // The pid alone does not make the temp name unique: two `writeIntentFile`
  // calls in ONE process would share it and interleave into each other's file.
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(handle, content, 'utf-8');
      // Flush the DATA blocks before the rename publishes the name. Without this
      // a power loss can leave the rename durable while the blocks are not,
      // which is a TRUNCATED intent.json the reader then rejects as `invalid`.
      // The parent directory is deliberately NOT fsync'd: losing the rename
      // itself leaves the previous, valid file in place — a lost write, not a
      // corrupt one — and a directory fsync is not portable (opening a directory
      // fails outright on Windows). Recovering a lost write is `git checkout`;
      // the file is git-tracked precisely so that is always available.
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // `.coredoc` is git-tracked: a half-written temp file left behind would show
    // up as an untracked file in the maintainer's diff.
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}
