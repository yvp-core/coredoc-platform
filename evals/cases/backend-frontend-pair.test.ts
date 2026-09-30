import { describe, expect, it } from 'vitest';
import type { AgentRunResult, Target } from '../harness/types.js';
import {
  backendFrontendPairCase,
  type BackendFrontendPairParams,
} from './backend-frontend-pair.js';

const target = { name: 'demo-workspace' } as Target;

function runWith(responseText: string): AgentRunResult {
  return {
    responseText,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    latencyMs: 0,
    toolCalls: [],
    transcriptPath: '',
    error: null,
  };
}

describe('backendFrontendPairCase.verify', () => {
  it('matches repo-qualified truth against repo-local citations and covers all frontend roles', async () => {
    const params: BackendFrontendPairParams = {
      endpoint: { method: 'GET', path: '/api/users' },
      expectedFiles: [
        'demo/frontend/src/hooks/useUsers.ts',
        'demo/frontend/src/pages/UsersPage.tsx',
        'demo/frontend/src/components/UsersTable.tsx',
      ],
    };

    const result = await backendFrontendPairCase.verify(
      target,
      params,
      runWith(
        'Hook: `frontend/src/hooks/useUsers.ts`. Page: `frontend/src/pages/UsersPage.tsx`. Component: `frontend/src/components/UsersTable.tsx`.',
      ),
    );

    expect(result.details.file_recall).toBe(1);
    expect(result.details.file_precision).toBe(1);
    expect(result.details.frontend_roles).toEqual(['hook', 'page', 'component']);
    expect(result.score).toBe(100);
  });

  it('does not reward an exact backend-only chain as a frontend pair', async () => {
    const params: BackendFrontendPairParams = {
      endpoint: { method: 'POST', path: '/api/users' },
      expectedFiles: [
        'server/src/users/users.controller.ts',
        'server/src/users/users.service.ts',
      ],
    };

    const result = await backendFrontendPairCase.verify(
      target,
      params,
      runWith(
        'Backend files: `server/src/users/users.controller.ts` and `server/src/users/users.service.ts`.',
      ),
    );

    expect(result.details.file_recall).toBe(1);
    expect(result.details.frontend_role_coverage).toBe(0);
    expect(result.score).toBe(0);
  });
});
