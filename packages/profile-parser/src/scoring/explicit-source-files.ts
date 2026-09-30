import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sumGrepCounts } from './grep-lines.js';

const GREP_BATCH_SIZE = 200;
const NO_NOISE = /$^/;

/** Convert the provider-owned repo-relative source set to existing absolute files. */
export function absoluteSourceFiles(repoRoot: string, sourceFiles: readonly string[]): string[] {
  return sourceFiles.map((file) => join(repoRoot, file)).filter(existsSync);
}

function isNoMatch(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && (error as { status?: number }).status === 1;
}

function grepFailure(label: string, error: unknown): Error {
  const result = error as { status?: number; stderr?: Buffer | string; code?: string };
  const detail = result.stderr?.toString().trim();
  return new Error(
    `${label}: grep failed (status=${result.status ?? result.code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
    { cause: error },
  );
}

/** Count matching lines over an exact file set, chunked to avoid E2BIG on large repos. */
export function grepCountInFiles(files: readonly string[], ere: string, label: string): number {
  let total = 0;
  for (let start = 0; start < files.length; start += GREP_BATCH_SIZE) {
    const batch = files.slice(start, start + GREP_BATCH_SIZE);
    try {
      const out = execFileSync('grep', ['-EcH', ere, ...batch], {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      total += sumGrepCounts(out, [...batch], NO_NOISE);
    } catch (error: unknown) {
      if (!isNoMatch(error)) throw grepFailure(label, error);
    }
  }
  return total;
}

/** Return the exact input files that contain at least one matching line. */
export function grepMatchingFiles(files: readonly string[], ere: string, label: string): string[] {
  const matches: string[] = [];
  for (let start = 0; start < files.length; start += GREP_BATCH_SIZE) {
    const batch = files.slice(start, start + GREP_BATCH_SIZE);
    try {
      const out = execFileSync('grep', ['-lE', ere, ...batch], {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      matches.push(...out.split('\n').filter(Boolean));
    } catch (error: unknown) {
      if (!isNoMatch(error)) throw grepFailure(label, error);
    }
  }
  return matches;
}
