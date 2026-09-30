import { describe, it, expect } from 'vitest';
import { ciGitContextFromEnv, applyCiGitContext } from './git-context.js';
import type { GitInfo } from '@coredoc/core';

const detached: GitInfo = {
  commitHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  commitShortHash: 'deadbee',
  branch: 'HEAD',
  isDirty: false,
};

describe('ciGitContextFromEnv', () => {
  it('recovers GitLab detached checkout identity without presenting a merge request as a GitHub PR', () => {
    expect(
      ciGitContextFromEnv({ GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'production', CI_COMMIT_SHA: 'cafebabe' }),
    ).toEqual({ branch: 'production', commitSha: 'cafebabe' });
    expect(
      ciGitContextFromEnv({
        GITLAB_CI: 'true',
        CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feature',
        CI_MERGE_REQUEST_IID: '12',
        CI_COMMIT_SHA: 'feedface',
      }),
    ).toEqual({ branch: 'feature', commitSha: 'feedface' });
  });
  it('prefers GITHUB_HEAD_REF and parses the PR number on pull_request events', () => {
    const ctx = ciGitContextFromEnv({
      GITHUB_HEAD_REF: 'feat/thing',
      GITHUB_REF_NAME: '42/merge',
      GITHUB_REF: 'refs/pull/42/merge',
      GITHUB_SHA: 'cafebabe',
    } as NodeJS.ProcessEnv);
    expect(ctx).toEqual({ branch: 'feat/thing', prNumber: 42, commitSha: 'cafebabe' });
  });

  it('uses GITHUB_REF_NAME with no PR number on push events', () => {
    const ctx = ciGitContextFromEnv({
      GITHUB_REF_NAME: 'main',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: 'cafebabe',
    } as NodeJS.ProcessEnv);
    expect(ctx).toEqual({ branch: 'main', prNumber: undefined, commitSha: 'cafebabe' });
  });

  it('returns empties outside GitHub Actions', () => {
    expect(ciGitContextFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      branch: undefined,
      prNumber: undefined,
      commitSha: undefined,
    });
  });
});

describe('applyCiGitContext', () => {
  it('replaces a detached-HEAD branch with the Actions branch', () => {
    const out = applyCiGitContext(detached, { branch: 'feat/thing', prNumber: 42, commitSha: 'cafebabe' });
    expect(out?.branch).toBe('feat/thing');
    expect(out?.commitHash).toBe(detached.commitHash); // local checkout SHA kept
  });

  it('keeps a real local branch over the env value', () => {
    const out = applyCiGitContext({ ...detached, branch: 'local-branch' }, { branch: 'feat/thing' });
    expect(out?.branch).toBe('local-branch');
  });

  it('synthesizes GitInfo from env when git was unavailable', () => {
    const out = applyCiGitContext(undefined, { branch: 'feat/thing', commitSha: 'cafebabe12345' });
    expect(out).toEqual({
      commitHash: 'cafebabe12345',
      commitShortHash: 'cafebab',
      branch: 'feat/thing',
      isDirty: false,
    });
  });

  it('returns undefined when there is neither git nor env', () => {
    expect(applyCiGitContext(undefined, {})).toBeUndefined();
  });
});
