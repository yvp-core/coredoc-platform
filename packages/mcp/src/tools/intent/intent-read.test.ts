import { describe, expect, it } from 'vitest';
import type { ScopeContext } from '../../types.js';
import { handleIntentRead, INTENT_READ_LOCAL_REFUSAL } from './intent-read.js';

const scope: ScopeContext = {
  currentPath: '/tmp/repo',
  configDir: '/tmp',
  resolvedRepos: ['repo'],
  repoHashes: [],
  project: 'demo',
  projectId: 'demo',
  crossRepoEnabled: false,
};

describe('intent_read (local)', () => {
  it('refuses explicitly and names the read that works locally', async () => {
    const response = await handleIntentRead({ action: 'tree' }, scope, 'summary');
    expect(response.isError).toBe(true);
    expect(response.data).toBe(INTENT_READ_LOCAL_REFUSAL);
    expect(response.data).toContain('get_intent_context');
  });
});
