import { describe, expect, it } from 'vitest';
import type { AgentRunResult, Target } from '../harness/types.js';
import { routeApiSurfaceCase, type RouteApiSurfaceParams } from './route-api-surface.js';

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

const params: RouteApiSurfaceParams = {
  path: '/items',
  component: 'ItemsPage',
  expectedEndpoints: [
    { method: 'GET', path: '/api/items/{id}' },
    { method: 'PATCH', path: '/api/items/{id}' },
  ],
};

describe('routeApiSurfaceCase.verify', () => {
  it('treats GET and PATCH on the same normalized path as different endpoints', async () => {
    const result = await routeApiSurfaceCase.verify(
      target,
      params,
      runWith('The page calls GET `/api/items/{id}`.'),
    );

    expect(result.details.truth_paths).toEqual([
      'GET /api/items/{id}',
      'PATCH /api/items/{id}',
    ]);
    expect(result.details.matched_paths).toEqual(['GET /api/items/:param']);
    expect(result.details.path_recall).toBe(0.5);
    expect(result.score).toBe(35);
  });

  it('matches both methods only when both endpoint identities are cited', async () => {
    const result = await routeApiSurfaceCase.verify(
      target,
      params,
      runWith('Calls: GET `/api/items/{id}` and PATCH `/api/items/{id}`.'),
    );

    expect(result.details.matched_paths).toEqual([
      'GET /api/items/:param',
      'PATCH /api/items/:param',
    ]);
    expect(result.details.path_recall).toBe(1);
    expect(result.score).toBe(70);
  });

  it('does not match the correct path under the wrong method', async () => {
    const result = await routeApiSurfaceCase.verify(
      target,
      { ...params, expectedEndpoints: [{ method: 'GET', path: '/api/items/{id}' }] },
      runWith('The page calls POST `/api/items/{id}`.'),
    );

    expect(result.details.matched_paths).toEqual([]);
    expect(result.score).toBe(0);
  });

  it('deduplicates only an identical method plus normalized path', async () => {
    const result = await routeApiSurfaceCase.verify(
      target,
      {
        ...params,
        expectedEndpoints: [
          { method: 'GET', path: '/api/items/{id}' },
          { method: 'get', path: '/api/items/{itemId}?include=owner' },
        ],
      },
      runWith('The page calls GET `/api/items/:param`.'),
    );

    expect(result.details.truth_paths).toHaveLength(1);
    expect(result.details.path_recall).toBe(1);
  });

  it('normalizes optional leading slashes and absolute URL pathnames without weakening method identity', async () => {
    const noLeadingSlash: RouteApiSurfaceParams = {
      ...params,
      expectedEndpoints: [{ method: 'GET', path: 'api/projects/{id}' }],
    };

    const relative = await routeApiSurfaceCase.verify(
      target,
      noLeadingSlash,
      runWith('The page calls GET `/api/projects/{projectId}`.'),
    );
    const absolute = await routeApiSurfaceCase.verify(
      target,
      noLeadingSlash,
      runWith('The page calls GET `https://example.test/api/projects/{id}?include=owner`.'),
    );
    const wrongMethod = await routeApiSurfaceCase.verify(
      target,
      noLeadingSlash,
      runWith('The page calls PATCH `https://example.test/api/projects/{id}`.'),
    );

    expect(relative.details.matched_paths).toEqual(['GET /api/projects/:param']);
    expect(absolute.details.matched_paths).toEqual(['GET /api/projects/:param']);
    expect(wrongMethod.details.matched_paths).toEqual([]);
  });
});
