import type { GitInfo } from '@coredoc/core';

export interface CiGitContext {
  branch?: string;
  prNumber?: number;
  commitSha?: string;
}

/**
 * GitHub Actions PR jobs check out a detached-HEAD merge ref, so the local
 * `git rev-parse --abbrev-ref HEAD` yields "HEAD" and the branch is lost.
 * Recover identity from the CI environment. GitLab merge-request numbers are
 * deliberately not sent to consumers of the GitHub-specific prNumber field.
 */
export function ciGitContextFromEnv(env: NodeJS.ProcessEnv): CiGitContext {
  if (env.GITLAB_CI === 'true')
    return {
      branch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_BRANCH || env.CI_COMMIT_REF_NAME || undefined,
      commitSha: env.CI_COMMIT_SHA || undefined,
    };
  const pr = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1];
  return {
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || undefined,
    prNumber: pr ? Number(pr) : undefined,
    commitSha: env.GITHUB_SHA || undefined,
  };
}

/**
 * Overlay Actions context onto the locally captured GitInfo: a detached-HEAD
 * branch is replaced, a real local branch wins, and when git was unavailable
 * entirely a minimal GitInfo is synthesized from the env (isDirty false — a CI
 * checkout is clean by construction).
 */
export function applyCiGitContext(git: GitInfo | undefined, ctx: CiGitContext): GitInfo | undefined {
  if (git) {
    const detached = !git.branch || git.branch === 'HEAD';
    return detached && ctx.branch ? { ...git, branch: ctx.branch } : git;
  }
  if (!ctx.commitSha) return undefined;
  return {
    commitHash: ctx.commitSha,
    commitShortHash: ctx.commitSha.slice(0, 7),
    branch: ctx.branch ?? 'HEAD',
    isDirty: false,
  };
}
