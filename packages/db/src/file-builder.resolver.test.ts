import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EdgeType } from './types.js';
import { LadybugDriver } from './ladybug/driver.js';
import { LadybugRepository } from './ladybug/repository.js';
import {
  GRAPH_BUILD_QUERY_TIMEOUT_MS,
  buildGraphFile,
  type GraphBuildResolverRepository,
  type VerifiedGraphBuildComponent,
} from './file-builder.js';

const SOURCE_REPO = 'aaaaaaaaaaaa';
const TARGET_REPO = 'bbbbbbbbbbbb';
const CALL_ID = `${SOURCE_REPO}:external_call:src/client.ts:fetchUser:4`;
const ENTRYPOINT_ID = `${TARGET_REPO}:entrypoint:http:get-user`;

function parsedRepo(repoId: string, name: string, role: 'source' | 'target'): ParsedRepo {
  const fileId = `${repoId}:file:src/app.ts`;
  const functionId = `${repoId}:function:src/app.ts:${role}`;
  const location = { filePath: 'src/app.ts', startLine: 1, endLine: 8 };
  return {
    id: repoId,
    name,
    path: `/private/${name}`,
    type: 'backend',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: 'resolver-builder-test',
    parserId: 'resolver-builder-test',
    packages: [],
    files: [
      {
        id: fileId,
        versionedId: `${fileId}@v1`,
        path: 'src/app.ts',
        extension: '.ts',
        language: 'typescript',
        contentHash: 'v1',
        loc: 8,
      },
    ],
    functions: [
      {
        id: functionId,
        versionedId: `${functionId}@v1`,
        name: role,
        kind: 'function',
        fileId,
        isAsync: false,
        isGenerator: false,
        isExported: true,
        parameters: [],
        location,
        sourceCode: 'const sourceCanary = true;',
      },
    ],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints:
      role === 'target'
        ? [
            {
              id: ENTRYPOINT_ID,
              versionedId: `${ENTRYPOINT_ID}@v1`,
              type: 'http',
              handlerId: functionId,
              location,
              details: { type: 'http', method: 'GET', path: '/users/:id', fullPath: '/users/:id' },
            },
          ]
        : [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls:
      role === 'source'
        ? [
            {
              id: CALL_ID,
              versionedId: `${CALL_ID}@v1`,
              callerId: functionId,
              serviceName: 'users',
              method: 'fetchUser',
              targetDescriptor: {
                protocol: 'http',
                targetService: 'users',
                http: { method: 'GET', pathTemplate: '/users/:id' },
              },
              location: { ...location, startLine: 4 },
            },
          ]
        : [],
    stats: {
      totalFiles: 1,
      parsedFiles: 1,
      skippedFiles: 0,
      totalFunctions: 1,
      totalClasses: 0,
      totalEntrypoints: role === 'target' ? 1 : 0,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: role === 'source' ? 1 : 0,
      parseTimeMs: 1,
    },
  };
}

async function* components(): AsyncGenerator<VerifiedGraphBuildComponent> {
  yield { parsedRepo: parsedRepo(SOURCE_REPO, 'web', 'source') };
  yield { parsedRepo: parsedRepo(TARGET_REPO, 'users', 'target') };
}

describe('buildGraphFile resolver seam', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('passes only a frozen resolver facade and returns the exact post-hook edge count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-builder-resolver-'));
    roots.push(root);
    const outputPath = join(root, 'resolved.lbug');
    let baseEdgeCount = 0;
    const beforeFinalize = vi.fn(async (repository: GraphBuildResolverRepository) => {
      expect(Object.isFrozen(repository)).toBe(true);
      expect(Object.keys(repository).sort()).toEqual([
        'clearResolvedTargetIds',
        'deleteEdgesByType',
        'getExternalCalls',
        'getInternalCallEdges',
        'getMonikeredFunctions',
        'getPackageLinkerFacts',
        'getPackages',
        'listAllRepositories',
        'listEntrypoints',
        'pushEdges',
        'updateResolvedTargetIds',
      ]);
      baseEdgeCount = (await repository.getExternalCalls([SOURCE_REPO])).length;
      await repository.pushEdges([
        {
          id: `resolve:${CALL_ID}:${ENTRYPOINT_ID}`,
          sourceId: CALL_ID,
          targetId: ENTRYPOINT_ID,
          type: EdgeType.ResolvesTo,
          confidence: 1,
          createdBy: 'ai',
          properties: {},
        },
      ]);
      await repository.updateResolvedTargetIds(new Map([[CALL_ID, ENTRYPOINT_ID]]));
    });

    const result = await buildGraphFile({
      outputPath,
      workDir: join(root, 'work'),
      components: components(),
      beforeFinalize,
    });

    expect(beforeFinalize).toHaveBeenCalledOnce();
    expect(baseEdgeCount).toBe(1);
    const driver = new LadybugDriver(outputPath, { readOnly: true, initializeSchema: false, ftsMode: 'load' });
    await driver.initialize();
    const repository = new LadybugRepository(driver);
    try {
      let directEdgeCount = 0;
      for (const type of Object.values(EdgeType)) {
        const rows = await driver.withReadTransaction((transaction) =>
          transaction.run<{ count: number | bigint }>(
            `MATCH (:GraphNode)-[:${type}]->(:GraphNode) RETURN count(*) AS count`,
          ),
        );
        directEdgeCount += Number(rows[0]?.count ?? 0);
      }
      expect(result.edgeCount).toBe(directEdgeCount);
      expect(await repository.getResolvesEdge?.(CALL_ID)).toMatchObject({ targetId: ENTRYPOINT_ID });
      expect((await repository.getExternalCalls([SOURCE_REPO]))[0]?.resolvedTargetId).toBe(ENTRYPOINT_ID);
    } finally {
      await driver.close();
    }
  }, 120_000);

  it('removes every temporary artifact when the hook fails or aborts', async () => {
    for (const failure of ['throw', 'abort'] as const) {
      const root = mkdtempSync(join(tmpdir(), `coredoc-builder-hook-${failure}-`));
      roots.push(root);
      const outputPath = join(root, `${failure}.lbug`);
      const abort = new AbortController();

      await expect(
        buildGraphFile({
          outputPath,
          workDir: join(root, 'work'),
          components: components(),
          signal: abort.signal,
          beforeFinalize: async () => {
            if (failure === 'abort') {
              abort.abort(new Error('resolver hook aborted'));
              return;
            }
            throw new Error('resolver hook failed');
          },
        }),
      ).rejects.toThrow(new RegExp(`resolver hook ${failure === 'throw' ? 'failed' : 'aborted'}`, 'i'));

      expect(existsSync(outputPath)).toBe(false);
      expect(readdirSync(root).filter((entry) => entry.startsWith(`.${basename(outputPath)}.build-`))).toEqual([]);
      expect(readdirSync(join(root, 'work'))).toEqual([]);
    }
  }, 120_000);

  it('uses an explicit bounded native query timeout', () => {
    expect(GRAPH_BUILD_QUERY_TIMEOUT_MS).toBe(30_000);
  });
});
