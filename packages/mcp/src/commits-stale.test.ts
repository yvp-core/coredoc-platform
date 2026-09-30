/**
 * Tests for the commits-stale helper.
 *
 * No real git is ever invoked: `computeCommitsStale` takes an injectable
 * GitRunner so the `git rev-list --count` call is faked. The summary extractor
 * is pure and needs no DB.
 */

import { describe, it, expect, vi } from 'vitest';
import type { OperationSummary } from '@coredoc/db';
import { computeCommitsStale, commitHashFromSummary, type GitRunner } from './commits-stale.js';

describe('computeCommitsStale', () => {
  it('returns the commit count reported by git rev-list', async () => {
    const runner: GitRunner = vi.fn().mockResolvedValue('3');
    await expect(computeCommitsStale('/repo', 'abc123', runner)).resolves.toBe(3);
  });

  it('runs `git rev-list --count <parsedCommit>..HEAD` in the repo dir', async () => {
    const runner = vi.fn<Parameters<GitRunner>, ReturnType<GitRunner>>().mockResolvedValue('5');
    await computeCommitsStale('/some/repo', 'deadbeef', runner);
    expect(runner).toHaveBeenCalledWith('/some/repo', ['rev-list', '--count', 'deadbeef..HEAD']);
  });

  it('returns 0 when HEAD equals the parsed commit', async () => {
    const runner: GitRunner = vi.fn().mockResolvedValue('0');
    await expect(computeCommitsStale('/repo', 'abc123', runner)).resolves.toBe(0);
  });

  it('trims whitespace/newline around the count', async () => {
    const runner: GitRunner = vi.fn().mockResolvedValue('  42\n');
    await expect(computeCommitsStale('/repo', 'abc123', runner)).resolves.toBe(42);
  });

  it('returns null when no parsed commit is known', async () => {
    const runner: GitRunner = vi.fn();
    await expect(computeCommitsStale('/repo', undefined, runner)).resolves.toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns null when no repo dir is known', async () => {
    const runner: GitRunner = vi.fn();
    await expect(computeCommitsStale(undefined, 'abc123', runner)).resolves.toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns null when git fails (runner yields undefined)', async () => {
    const runner: GitRunner = vi.fn().mockResolvedValue(undefined);
    await expect(computeCommitsStale('/repo', 'abc123', runner)).resolves.toBeNull();
  });

  it('returns null when the runner rejects (non-fatal)', async () => {
    const runner: GitRunner = vi.fn().mockRejectedValue(new Error('git exploded'));
    await expect(computeCommitsStale('/repo', 'abc123', runner)).resolves.toBeNull();
  });

  it('returns null when git output is not a plain integer', async () => {
    const runner: GitRunner = vi.fn().mockResolvedValue('fatal: bad revision');
    await expect(computeCommitsStale('/repo', 'abc123', runner)).resolves.toBeNull();
  });
});

describe('commitHashFromSummary', () => {
  const summaryWith = (metadata: Record<string, unknown> | undefined): OperationSummary => ({
    projectId: 'p',
    repoName: 'r',
    lastParsed:
      metadata === undefined
        ? undefined
        : {
            id: 'op1',
            projectId: 'p',
            repoName: 'r',
            operation: 'parse',
            status: 'completed',
            startedAt: 0,
            metadata,
          },
  });

  it('reads lastParsed.metadata.gitCommitHash', () => {
    expect(commitHashFromSummary(summaryWith({ gitCommitHash: 'abc123' }))).toBe('abc123');
  });

  it('returns undefined when there is no parse operation', () => {
    expect(commitHashFromSummary(summaryWith(undefined))).toBeUndefined();
  });

  it('returns undefined when the hash is absent from metadata', () => {
    expect(commitHashFromSummary(summaryWith({ gitBranch: 'main' }))).toBeUndefined();
  });

  it('returns undefined when the hash is not a non-empty string', () => {
    expect(commitHashFromSummary(summaryWith({ gitCommitHash: '' }))).toBeUndefined();
    expect(commitHashFromSummary(summaryWith({ gitCommitHash: 42 }))).toBeUndefined();
  });

  it('returns undefined for an undefined summary', () => {
    expect(commitHashFromSummary(undefined)).toBeUndefined();
  });
});
