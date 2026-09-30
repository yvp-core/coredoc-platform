import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree, resetWorktree, removeWorktree } from './worktree.js';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('worktree', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'evals-wt-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('pins create and reset to the requested commit even after the branch moves', async () => {
    const pinned = git(repo, 'rev-parse', 'HEAD');
    const wtPath = join(repo, '.worktrees', 'eval-x-withMcp');
    expect(await createWorktree({ repoPath: repo, worktreePath: wtPath, revision: pinned })).toBe(
      pinned,
    );
    expect(existsSync(wtPath)).toBe(true);
    expect(readFileSync(join(wtPath, 'a.txt'), 'utf8')).toBe('hello\n');

    writeFileSync(join(repo, 'a.txt'), 'branch moved\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-m', 'move branch');
    expect(git(repo, 'rev-parse', 'main')).not.toBe(pinned);

    writeFileSync(join(wtPath, 'a.txt'), 'dirty\n');
    expect(await resetWorktree({ repoPath: repo, worktreePath: wtPath, revision: pinned })).toBe(
      pinned,
    );
    expect(git(wtPath, 'rev-parse', 'HEAD')).toBe(pinned);
    expect(() => git(wtPath, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(git(wtPath, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(wtPath, 'a.txt'), 'utf8')).toBe('hello\n');
    await removeWorktree({ repoPath: repo, worktreePath: wtPath });
  });

  it('reset wipes uncommitted changes back to the pinned revision', async () => {
    const revision = git(repo, 'rev-parse', 'HEAD');
    const wtPath = join(repo, '.worktrees', 'eval-x-withoutMcp');
    await createWorktree({ repoPath: repo, worktreePath: wtPath, revision });
    writeFileSync(join(wtPath, 'a.txt'), 'CHANGED\n');
    writeFileSync(join(wtPath, 'b.txt'), 'untracked\n');
    await resetWorktree({ repoPath: repo, worktreePath: wtPath, revision });
    expect(readFileSync(join(wtPath, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(wtPath, 'b.txt'))).toBe(false);
    await removeWorktree({ repoPath: repo, worktreePath: wtPath });
  });

  it('createWorktree is idempotent if path already exists', async () => {
    const revision = git(repo, 'rev-parse', 'HEAD');
    const wtPath = join(repo, '.worktrees', 'eval-x-twice');
    await createWorktree({ repoPath: repo, worktreePath: wtPath, revision });
    await createWorktree({ repoPath: repo, worktreePath: wtPath, revision });
    expect(existsSync(wtPath)).toBe(true);
    await removeWorktree({ repoPath: repo, worktreePath: wtPath });
  });

  it('rejects an existing plain directory before mutating the repository that contains it', async () => {
    const revision = git(repo, 'rev-parse', 'HEAD');
    const branch = git(repo, 'symbolic-ref', '--short', 'HEAD');
    const wtPath = join(repo, '.worktrees', 'eval-plain-directory');
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(repo, 'a.txt'), 'dirty user change\n');

    let error: unknown;
    try {
      await createWorktree({ repoPath: repo, worktreePath: wtPath, revision });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not a registered worktree/i);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('dirty user change\n');
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe(branch);
  });

  it('rejects a symlink path before mutating its target repository', async () => {
    const revision = git(repo, 'rev-parse', 'HEAD');
    const wtPath = join(repo, '.worktrees', 'eval-symlink');
    mkdirSync(join(repo, '.worktrees'), { recursive: true });
    symlinkSync(repo, wtPath, 'dir');
    writeFileSync(join(repo, 'a.txt'), 'dirty through symlink target\n');

    await expect(createWorktree({ repoPath: repo, worktreePath: wtPath, revision })).rejects.toThrow(
      /symbolic link/i,
    );
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('dirty through symlink target\n');
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('surfaces cleanup of an unknown path without deleting it', async () => {
    const unknown = join(repo, '.worktrees', 'eval-unknown');
    mkdirSync(unknown, { recursive: true });
    writeFileSync(join(unknown, 'keep.txt'), 'keep\n');

    await expect(removeWorktree({ repoPath: repo, worktreePath: unknown })).rejects.toThrow(
      /not a registered worktree/i,
    );
    expect(readFileSync(join(unknown, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});
