import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, realpathSync } from 'node:fs';

const runGit = promisify(execFile);

export interface CreateOpts {
  repoPath: string;
  worktreePath: string;
  revision: string;
}

export interface ResetOpts {
  repoPath: string;
  worktreePath: string;
  revision: string;
}

export interface RemoveOpts {
  repoPath: string;
  worktreePath: string;
}

interface RegisteredWorktree {
  path: string;
  detached: boolean;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseWorktreeList(output: string): RegisteredWorktree[] {
  const records: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const token of output.split('\0')) {
    if (token.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: token.slice('worktree '.length), detached: false };
    } else if (token === 'detached' && current) {
      current.detached = true;
    }
  }
  if (current) records.push(current);
  return records;
}

async function assertRegisteredDetachedWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  let stat;
  try {
    stat = lstatSync(worktreePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path ${worktreePath} is not a registered worktree of ${repoPath}.`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link worktree path: ${worktreePath}.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path ${worktreePath} is not a registered worktree directory of ${repoPath}.`);
  }

  const canonicalPath = realpathSync(worktreePath);
  const output = (await runGit('git', [
    '-C',
    repoPath,
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ])).stdout;
  const registered = parseWorktreeList(output).find((record) => {
    try {
      return realpathSync(record.path) === canonicalPath;
    } catch {
      return false;
    }
  });
  if (!registered) {
    throw new Error(`Path ${worktreePath} is not a registered worktree of ${repoPath}.`);
  }
  if (!registered.detached) {
    throw new Error(`Refusing to mutate attached worktree at ${worktreePath}.`);
  }
}

export async function createWorktree({
  repoPath,
  worktreePath,
  revision,
}: CreateOpts): Promise<string> {
  if (pathEntryExists(worktreePath)) {
    return resetWorktree({ repoPath, worktreePath, revision });
  }
  const expected = (await runGit('git', ['-C', repoPath, 'rev-parse', `${revision}^{commit}`]))
    .stdout.trim();
  await runGit('git', ['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, expected]);
  return assertWorktreeState(worktreePath, expected);
}

export async function resetWorktree({ repoPath, worktreePath, revision }: ResetOpts): Promise<string> {
  await assertRegisteredDetachedWorktree(repoPath, worktreePath);
  const expected = (await runGit('git', ['-C', repoPath, 'rev-parse', `${revision}^{commit}`]))
    .stdout.trim();
  await runGit('git', ['-C', worktreePath, 'checkout', '--detach', '--force', expected]);
  await runGit('git', ['-C', worktreePath, 'reset', '--hard', expected]);
  await runGit('git', ['-C', worktreePath, 'clean', '-fd', '-e', 'node_modules']);
  return assertWorktreeState(worktreePath, expected);
}

export async function assertWorktreeState(worktreePath: string, revision: string): Promise<string> {
  const expected = (await runGit('git', ['-C', worktreePath, 'rev-parse', `${revision}^{commit}`]))
    .stdout.trim();
  const actual = (await runGit('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
  if (actual !== expected) {
    throw new Error(`Worktree revision mismatch at ${worktreePath}: expected ${expected}, got ${actual}.`);
  }
  try {
    const branch = (await runGit('git', ['-C', worktreePath, 'symbolic-ref', '--short', '-q', 'HEAD']))
      .stdout.trim();
    throw new Error(`Worktree at ${worktreePath} is attached to branch ${branch || '<unknown>'}.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Worktree at ')) throw error;
  }
  const dirty = (await runGit('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain',
    '--untracked-files=all',
  ])).stdout.trim();
  if (dirty) {
    throw new Error(`Worktree at ${worktreePath} is not clean:\n${dirty}`);
  }
  return actual;
}

export async function removeWorktree({ repoPath, worktreePath }: RemoveOpts): Promise<void> {
  await assertRegisteredDetachedWorktree(repoPath, worktreePath);
  await runGit('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
}
