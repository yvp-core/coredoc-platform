import * as crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { ProjectIntentMode } from '../types/config.js';
import { IntentLocalWriteBlockedError, assertLocalIntentWritable, repoHashesForProject } from './target.js';

function sha256_12(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

describe('repoHashesForProject', () => {
  it('hashes every configured repo by key (or name), independent of any resolved path', () => {
    const hashes = repoHashesForProject({
      repos: [{ name: 'api' }, { name: 'web', key: 'web-service' }],
    });
    expect(hashes).toEqual({
      api: sha256_12('api'),
      web: sha256_12('web-service'),
    });
  });

  it('includes repos that would fail to resolve a local filesystem path', () => {
    // No `resolvedRepoPaths` input at all — the function takes only
    // `{ repos }`, so a repo with an unresolved checkout still gets a hash.
    const hashes = repoHashesForProject({ repos: [{ name: 'unresolved-repo' }] });
    expect(hashes['unresolved-repo']).toBe(sha256_12('unresolved-repo'));
  });

  it('matches StableIdGenerator.getRepoHash() for the same key (the canonical algorithm)', async () => {
    const { StableIdGenerator } = await import('../id-generator.js');
    const hashes = repoHashesForProject({ repos: [{ name: 'sample-repo' }] });
    expect(hashes['sample-repo']).toBe(new StableIdGenerator('/any/root', 'sample-repo').getRepoHash());
  });
});

describe('assertLocalIntentWritable', () => {
  const cutOver = {
    projects: [
      { id: 'solo', intent: { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_1234' } },
      { id: 'still-local' },
    ],
  };

  it('passes a project with no cutover marker', () => {
    expect(() => assertLocalIntentWritable(cutOver, 'still-local')).not.toThrow();
  });

  it("passes an unknown project — resolving it is the command's own refusal to make", () => {
    expect(() => assertLocalIntentWritable(cutOver, 'no-such-project')).not.toThrow();
  });

  it('refuses a cut-over project and NAMES the owning workspace', () => {
    let thrown: unknown;
    try {
      assertLocalIntentWritable(cutOver, 'solo');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IntentLocalWriteBlockedError);
    const blocked = thrown as IntentLocalWriteBlockedError;
    expect(blocked.workspaceId).toBe('ws_1234');
    expect(blocked.projectId).toBe('solo');
    // The archive's message named no workspace, which left the maintainer with
    // a refusal and nowhere to go.
    expect(blocked.message).toContain('ws_1234');
    expect(blocked.message).toContain('solo');
  });

  it('says reads are a frozen snapshot and points at the workspace MCP', () => {
    expect(() => assertLocalIntentWritable(cutOver, 'solo')).toThrow(/frozen, non-authoritative snapshot/);
    expect(() => assertLocalIntentWritable(cutOver, 'solo')).toThrow(/workspace MCP/);
  });
});
