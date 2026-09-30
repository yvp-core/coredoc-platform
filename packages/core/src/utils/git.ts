/**
 * Git utilities for capturing repository version info at parse time.
 *
 * Uses execFile (not exec) to prevent shell injection.
 * Returns undefined gracefully if not a git repo or git is unavailable.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitInfo } from '../types/output.js';

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT = 5_000;

/**
 * Run a git command in the given directory.
 * Returns trimmed stdout, or undefined on any failure.
 */
async function git(repoPath: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      timeout: EXEC_TIMEOUT,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Runs a git subcommand in `repoPath`, returning trimmed stdout or `undefined`
 * on any failure. Injectable so tests never shell out to a real git.
 */
export type GitRunner = (repoPath: string, args: string[]) => Promise<string | undefined>;

/**
 * Number of commits HEAD is ahead of `baseCommit` (0 when identical), or `null`
 * when it cannot be determined — a non-git dir, an unknown or unreachable
 * commit, a shallow clone, or git being unavailable.
 *
 * Never throws: callers use this to decorate a staleness read, and a failed
 * count must not break the read. `null` and `0` are deliberately distinct — see
 * ADR-20260724-explicit-degrade-no-silent-zeros.
 */
export async function countCommitsAhead(
  repoPath: string | undefined,
  baseCommit: string | undefined,
  runner: GitRunner = git,
): Promise<number | null> {
  if (!repoPath || !baseCommit) return null;

  let out: string | undefined;
  try {
    out = await runner(repoPath, ['rev-list', '--count', `${baseCommit}..HEAD`]);
  } catch {
    // An injected runner that rejects is still non-fatal.
    return null;
  }
  if (out === undefined) return null;

  const trimmed = out.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

/**
 * Capture full git info for a repository at parse time.
 * Returns undefined if the directory is not a git repo or git is unavailable.
 */
export async function captureGitInfo(repoPath: string): Promise<GitInfo | undefined> {
  // Batch: commitHash, commitShortHash, commitDate in a single call
  const logOutput = await git(repoPath, ['log', '-1', '--format=%H%n%h%n%aI']);
  if (!logOutput) return undefined;

  const [commitHash, commitShortHash, commitDate] = logOutput.split('\n');
  if (!commitHash || !commitShortHash) return undefined;

  // Branch name
  const branch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return undefined;

  // Dirty check -- if git status fails, bail out entirely rather than
  // recording a false-clean snapshot
  const porcelain = await git(repoPath, ['status', '--porcelain']);
  if (porcelain === undefined) return undefined;
  const isDirty = porcelain.length > 0;

  // Origin remote URL (the "git link"). `--get-url` only expands the configured
  // URL -- no network round-trip -- and echoes the remote NAME back ('origin')
  // when no URL is configured, which we treat as absent.
  const remote = await git(repoPath, ['ls-remote', '--get-url', 'origin']);
  const remoteUrl = remote && remote !== 'origin' ? remote : undefined;

  return {
    commitHash,
    commitShortHash,
    branch,
    isDirty,
    commitDate: commitDate || undefined,
    remoteUrl,
  };
}
