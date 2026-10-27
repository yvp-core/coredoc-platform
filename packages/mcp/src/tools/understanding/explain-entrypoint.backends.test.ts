/**
 * Exact route preference against real `listEntrypoints` implementations.
 *
 * The handler test feeds rows in both orders; this one lets each in-process
 * backend produce its own order and filter. Neo4j has no in-process arm (see
 * `packages/db/src/contract/repository-contract.test.ts`), which is why the
 * handler ranks rows itself instead of trusting backend order.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeType, SqliteDriver, SqliteRepository, type GraphNode, type IGraphRepository } from '@coredoc/db';
import { LadybugDriver, LadybugRepository } from '@coredoc/db/ladybug';
import { handleExplainEntrypoint } from './explain-entrypoint.js';
import { resolveDetailLevel } from '../../detail-level.js';
import type { EntrypointExplanationResult, ScopeContext } from '../../types.js';

const REPO = 'abc123def456';

const backends: Record<string, (dir: string) => Promise<{ repository: IGraphRepository; close: () => Promise<void> }>> =
  {
    sqlite: async (dir) => {
      const driver = new SqliteDriver(`file:${join(dir, 'graph.db')}`);
      await driver.initialize();
      return { repository: new SqliteRepository(driver), close: () => driver.close() };
    },
    ladybug: async (dir) => {
      const driver = new LadybugDriver(join(dir, 'graph.db'), { readOnly: false });
      await driver.initialize();
      return { repository: new LadybugRepository(driver), close: () => driver.close() };
    },
  };

function route(method: string, path: string): GraphNode {
  return {
    id: `${REPO}:entrypoint:${method}:${path}`,
    type: NodeType.Entrypoint,
    name: `${method} ${path}`,
    repoId: REPO,
    filePath: 'src/routes.ts',
    startLine: 1,
    properties: { entrypointType: 'http', method, path, fullPath: path },
  };
}

const scope: ScopeContext = {
  currentPath: '/test/repo',
  resolvedRepos: ['test-repo'],
  repoHashes: [REPO],
  crossRepoEnabled: false,
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe.each(Object.keys(backends))('explain_entrypoint route preference on %s', (backend) => {
  async function explain(nodes: GraphNode[], target: string): Promise<EntrypointExplanationResult> {
    const dir = mkdtempSync(join(tmpdir(), `explain-entrypoint-${backend}-`));
    const { repository, close } = await backends[backend]!(dir);
    cleanup = async () => {
      await close();
      rmSync(dir, { recursive: true, force: true });
    };
    await repository.pushNodes(nodes);
    const result = await handleExplainEntrypoint(
      { path: target },
      scope,
      'raw',
      'full',
      resolveDetailLevel('full'),
      repository,
    );
    return result.data as EntrypointExplanationResult;
  }

  it('returns the exact route even when a longer one sorts first', async () => {
    // `/admin/...` sorts before `/api/...` in every backend's path order.
    const data = await explain(
      [
        route('POST', '/admin/api/admin/widgets'),
        route('POST', '/api/admin/widgets/:id'),
        route('POST', '/api/admin/widgets'),
      ],
      'POST /api/admin/widgets',
    );
    expect(data.entrypoint.id).toBe(`${REPO}:entrypoint:POST:/api/admin/widgets`);
    expect(data.closestOf).toBeUndefined();
  });

  it('says closest of N when only substring matches exist', async () => {
    const data = await explain(
      [route('POST', '/admin/api/admin/widgets'), route('POST', '/api/admin/widgets/:id')],
      'POST /api/admin/widgets',
    );
    expect(data.entrypoint.id).toBe(`${REPO}:entrypoint:POST:/api/admin/widgets/:id`);
    expect(data.closestOf).toEqual({
      total: 2,
      others: [
        {
          id: `${REPO}:entrypoint:POST:/admin/api/admin/widgets`,
          method: 'POST',
          path: '/admin/api/admin/widgets',
        },
      ],
    });
  });
});
