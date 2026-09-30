import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureGitInfo, countCommitsAhead, type GitRunner } from './git.js';

// `git ls-remote --get-url origin` only expands the configured URL (no network),
// so these stay deterministic and offline.
describe('captureGitInfo — remoteUrl (git link)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function initRepoWithCommit(): void {
    dir = mkdtempSync(join(tmpdir(), 'git-info-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('commit', '-q', '--allow-empty', '-m', 'init');
  }

  it('captures the origin remote URL when one is configured', async () => {
    initRepoWithCommit();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: dir });

    const info = await captureGitInfo(dir);
    expect(info?.remoteUrl).toBe('https://github.com/acme/api.git');
  });

  it('leaves remoteUrl undefined (but still returns the snapshot) when no origin is configured', async () => {
    initRepoWithCommit();

    const info = await captureGitInfo(dir);
    expect(info).toBeDefined();
    expect(info?.commitHash).toBeTruthy();
    expect(info?.remoteUrl).toBeUndefined();
  });
});

const runner = (out: string | undefined): GitRunner => vi.fn(async () => out);

describe('countCommitsAhead', () => {
  it('parses the commit count', async () => {
    expect(await countCommitsAhead('/repo', 'abc', runner('3'))).toBe(3);
  });

  it('keeps a real zero distinct from unknown', async () => {
    // HEAD === base: measured, and genuinely zero.
    expect(await countCommitsAhead('/repo', 'abc', runner('0'))).toBe(0);
  });

  it('asks git for the commits base..HEAD is missing', async () => {
    const spy = vi.fn(async () => '1');
    await countCommitsAhead('/repo', 'abc123', spy);
    expect(spy).toHaveBeenCalledWith('/repo', ['rev-list', '--count', 'abc123..HEAD']);
  });

  it('is null when git produced nothing — not a git dir, or git missing', async () => {
    expect(await countCommitsAhead('/repo', 'abc', runner(undefined))).toBeNull();
  });

  it('is null on non-numeric output rather than coercing', async () => {
    expect(await countCommitsAhead('/repo', 'abc', runner('fatal: bad revision'))).toBeNull();
  });

  it('is null when the runner rejects — a staleness read must not throw', async () => {
    const rejecting: GitRunner = async () => {
      throw new Error('spawn ENOENT');
    };
    expect(await countCommitsAhead('/repo', 'abc', rejecting)).toBeNull();
  });

  it('is null when either input is missing', async () => {
    expect(await countCommitsAhead(undefined, 'abc', runner('3'))).toBeNull();
    expect(await countCommitsAhead('/repo', undefined, runner('3'))).toBeNull();
  });
});
