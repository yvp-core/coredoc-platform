/**
 * Tests for the Workspace Scope Resolver — vantage resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  UnknownWorkspaceScopeError,
  resolveWorkspaceVantage,
  resolveWorkspaceScope,
} from './workspace-scope-resolver.js';
import type { WorkspaceRepo } from '../database/control-plane.service.js';

// Only repoName / repoKey matter for vantage resolution; cast partial fixtures.
function repo(repoName: string, repoKey: string): WorkspaceRepo {
  return { repoName, repoKey } as unknown as WorkspaceRepo;
}

describe('resolveWorkspaceVantage', () => {
  const repos = [repo('api-server', 'hashcore'), repo('web-app', 'hashshifts'), repo('billing-service', 'hashcalc')];

  it('resolves by repo name to { currentRepo, currentRepoHash }', () => {
    expect(resolveWorkspaceVantage(repos, 'web-app')).toEqual({
      currentRepo: 'web-app',
      currentRepoHash: 'hashshifts',
    });
  });

  it('resolves by repoKey (the node-id hash) as well', () => {
    expect(resolveWorkspaceVantage(repos, 'hashcalc')).toEqual({
      currentRepo: 'billing-service',
      currentRepoHash: 'hashcalc',
    });
  });

  it('accepts the qualified project/repo form and matches the repo segment', () => {
    // Tool schemas advertise the qualified "project/repo" form; the cloud
    // workspace is flat, so resolve on the repo segment (parity with local).
    expect(resolveWorkspaceVantage(repos, 'acme/web-app')).toEqual({
      currentRepo: 'web-app',
      currentRepoHash: 'hashshifts',
    });
  });

  it('returns undefined when the signal names a repo outside the workspace', () => {
    expect(resolveWorkspaceVantage(repos, 'not-in-workspace')).toBeUndefined();
  });

  it('returns undefined for an empty or whitespace signal', () => {
    expect(resolveWorkspaceVantage(repos, '')).toBeUndefined();
    expect(resolveWorkspaceVantage(repos, '   ')).toBeUndefined();
  });
});

describe('resolveWorkspaceScope qualified target', () => {
  const repos = [repo('api-server', 'hashcore'), repo('web-app', 'hashshifts')];

  it('narrows on the qualified project/repo form by matching the repo segment', () => {
    const scope = resolveWorkspaceScope(repos, 'acme/web-app');
    // resolvedRepos = human-readable names; repoHashes = the node-id keys.
    // index-aligned. Consumers (describe_repository's name-keyed merge,
    // response-formatter, explain hints) rely on resolvedRepos being names.
    expect(scope.resolvedRepos).toEqual(['web-app']);
    expect(scope.repoHashes).toEqual(['hashshifts']);
  });

  it('full scope (no target): resolvedRepos are names, repoHashes are keys, index-aligned', () => {
    const scope = resolveWorkspaceScope(repos);
    expect(scope.resolvedRepos).toEqual(['api-server', 'web-app']);
    expect(scope.repoHashes).toEqual(['hashcore', 'hashshifts']);
  });

  it('throws on a target repo that matches no workspace repo, listing the valid names', () => {
    // A mistyped scope must never silently widen back to all repos — that
    // answers the wrong question with workspace-wide data (same hard-error
    // contract as the local resolver's unknown-scope path).
    let thrown: unknown;
    try {
      resolveWorkspaceScope(repos, 'not-in-workspace');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnknownWorkspaceScopeError);
    expect(thrown).toMatchObject({
      code: 'UNKNOWN_WORKSPACE_SCOPE',
      message: 'Unknown scope "not-in-workspace". Available repos (pass one of these as scope): api-server, web-app',
    });
  });

  it('marks the scope as workspace-resolved (origin) so tools never widen past it', () => {
    expect(resolveWorkspaceScope(repos).origin).toBe('workspace');
    expect(resolveWorkspaceScope(repos, 'web-app').origin).toBe('workspace');
  });

  it('keeps every connected repo as the cross-repo boundary when narrowed to one', () => {
    const scope = resolveWorkspaceScope(repos, 'web-app');
    expect(scope.repoHashes).toEqual(['hashshifts']);
    expect(scope.workspaceRepoHashes).toEqual(['hashcore', 'hashshifts']);
  });
});
