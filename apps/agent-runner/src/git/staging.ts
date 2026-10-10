/**
 * Gitlinks, submodule files and filter-attributed (LFS) paths are never staged; workflow files are
 * withheld because the bot's token has no Workflows permission.
 */
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Git } from './git.js';

export const MAX_NEW_FILE_BYTES = 1024 * 1024;

const CREDENTIAL_NAMES = [
  /^\.env$/,
  /^\.env\..+/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.netrc$/,
  /^credentials.*\.json$/,
];

const GITLINK_MODE = '160000';

export interface StageResult {
  staged: boolean;
  /** Every path left out of the commit, workflow files included. */
  withheld: string[];
  workflowPaths: string[];
}

export function isWorkflowPath(path: string): boolean {
  return path.startsWith('.github/workflows/');
}

function looksLikeCredential(path: string): boolean {
  const name = basename(path);
  return CREDENTIAL_NAMES.some((pattern) => pattern.test(name));
}

function nulFields(output: string): string[] {
  return output.split('\0').filter((field, index, all) => field !== '' || index < all.length - 1);
}

/** Paths whose `filter` attribute is set (LFS and other clean/smudge filters). */
async function filtered(git: Git, dir: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const { stdout } = await git.run(['check-attr', '-z', '--stdin', 'filter'], {
    cwd: dir,
    input: `${paths.join('\0')}\0`,
  });
  const fields = nulFields(stdout);
  const result = new Set<string>();
  // Records are `<path> NUL filter NUL <value> NUL`.
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index]!;
    const value = fields[index + 2]!;
    if (value !== 'unspecified' && value !== 'unset') result.add(path);
  }
  return result;
}

export async function stageChanges(git: Git, dir: string): Promise<StageResult> {
  const withheld: string[] = [];
  const workflowPaths: string[] = [];
  const candidates: string[] = [];
  const consider = (path: string) => {
    if (isWorkflowPath(path)) {
      workflowPaths.push(path);
      withheld.push(path);
    } else {
      candidates.push(path);
    }
  };

  const tracked = nulFields((await git.run(['diff', '--raw', '-z', '--no-renames'], { cwd: dir })).stdout);
  for (let index = 0; index + 1 < tracked.length; index += 2) {
    const [srcMode, dstMode] = tracked[index]!.replace(/^:/, '').split(' ');
    const path = tracked[index + 1]!;
    if (srcMode === GITLINK_MODE || dstMode === GITLINK_MODE || path === '.gitmodules') withheld.push(path);
    else consider(path);
  }

  // New files that are not ignored. A nested repository is listed as `dir/`; adding it would stage a gitlink.
  const untracked = nulFields(
    (await git.run(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: dir })).stdout,
  ).filter(Boolean);
  for (const path of untracked) {
    if (path.endsWith('/') || path === '.gitmodules' || looksLikeCredential(path)) {
      withheld.push(path.replace(/\/$/, ''));
      continue;
    }
    const stat = await lstat(join(dir, path)).catch(() => null);
    if (!stat?.isFile() || stat.size >= MAX_NEW_FILE_BYTES) {
      withheld.push(path);
      continue;
    }
    consider(path);
  }

  const attributed = await filtered(git, dir, candidates);
  const toStage = candidates.filter((path) => {
    if (!attributed.has(path)) return true;
    withheld.push(path);
    return false;
  });
  if (toStage.length > 0) {
    await git.run(['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      cwd: dir,
      input: `${toStage.join('\0')}\0`,
      env: { GIT_LITERAL_PATHSPECS: '1' },
    });
  }
  const { code } = await git.run(['diff', '--cached', '--quiet'], { cwd: dir, allowFailure: true });
  return { staged: code === 1, withheld: [...new Set(withheld)].sort(), workflowPaths: workflowPaths.sort() };
}
