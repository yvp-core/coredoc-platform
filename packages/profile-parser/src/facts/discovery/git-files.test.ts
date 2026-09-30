import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitListFiles } from './git-files.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let dir: string;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });

describe('gitListFiles', () => {
  it('honors .gitignore for a work-tree root', () => {
    dir = mkdtempSync(join(tmpdir(), 'git-files-'));
    execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' });
    writeFileSync(join(dir, '.gitignore'), 'built.js\n');
    writeFileSync(join(dir, 'kept.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'built.js'), 'module.exports = 1;');
    git('add', 'kept.ts');
    expect(gitListFiles(dir)?.sort()).toEqual(['.gitignore', 'kept.ts']);
  });

  it.each(['absolute', 'relative', 'symlink'])('never executes %s checkout Git from PATH', (kind) => {
    dir = mkdtempSync(join(tmpdir(), 'git-files-'));
    const repo = join(dir, 'repo');
    const bin = join(repo, 'bin');
    const alias = join(dir, 'alias');
    mkdirSync(bin, { recursive: true });
    mkdirSync(alias);
    execFileSync('git', ['init', '--quiet', repo], { stdio: 'ignore' });
    writeFileSync(join(repo, 'kept.ts'), 'export const x = 1');
    const marker = join(dir, 'host-marker');
    const executable = join(bin, 'git');
    writeFileSync(executable, `#!/bin/sh\nprintf touched > '${marker}'\nexit 128\n`, { mode: 0o755 });
    symlinkSync(executable, join(alias, 'git'));
    const entry = kind === 'symlink' ? alias : kind === 'relative' ? relative(process.cwd(), bin) : bin;
    vi.stubEnv('PATH', entry + delimiter + process.env.PATH);
    expect(gitListFiles(repo)).toContain('kept.ts');
    expect(existsSync(marker)).toBe(false);
  });

  it('returns null for a non-git directory so the caller may walk it', () => {
    dir = mkdtempSync(join(tmpdir(), 'git-files-'));
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;');
    expect(gitListFiles(dir)).toBeNull();
  });

  it('does not mistake corrupt repository metadata for a non-git directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'git-files-'));
    execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' });
    writeFileSync(join(dir, '.git', 'HEAD'), 'broken-head');
    expect(() => gitListFiles(dir)).toThrow(/git rev-parse failed/);
  });

  it('reports unavailable Git instead of walking without ignore rules', () => {
    dir = mkdtempSync(join(tmpdir(), 'git-files-'));
    vi.stubEnv('PATH', dir);
    expect(() => gitListFiles(dir)).toThrow(/git rev-parse failed/);
  });

  it.each(['ETIMEDOUT', 'EACCES'])('propagates a %s probe failure with its cause', (code) => {
    dir = mkdtempSync(join(tmpdir(), 'git-files-'));
    const failure = Object.assign(new Error('probe failed'), { code });
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => gitListFiles(dir)).toThrow(expect.objectContaining({ cause: failure }));
  });

  // A walk cannot read .gitignore, so degrading to it here would silently pull ignored build
  // output into the graph. `rev-parse` still succeeds on a corrupt index, so this is exactly the
  // "git has an opinion but we lost it" case that must not be reported as "git has no opinion".
  it('throws instead of degrading to an ignore-blind walk when ls-files fails', () => {
    dir = mkdtempSync(join(tmpdir(), 'git-files-'));
    execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' });
    writeFileSync(join(dir, '.gitignore'), 'built.js\n');
    writeFileSync(join(dir, 'built.js'), 'module.exports = 1;');
    writeFileSync(join(dir, '.git', 'index'), 'not-a-git-index');
    expect(() => gitListFiles(dir)).toThrow(/\.gitignore cannot be honored/);
  });
});
