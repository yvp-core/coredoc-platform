import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mapper } from '@coredoc/core';
import type { ParsedRepo } from '@coredoc/core/types';
import { buildGraphFile, type VerifiedGraphBuildComponent } from '@coredoc/db/file-builder';
import { openGraphFile } from '@coredoc/db/graph-file';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePinnedCandidate } from './resolver-kernel.js';

const SOURCE_REPO = 'aaaaaaaaaaaa';
const TARGET_REPO = 'bbbbbbbbbbbb';
const CALL_ID = `${SOURCE_REPO}:external_call:src/client.ts:fetchUser:4`;
const ENTRYPOINT_ID = `${TARGET_REPO}:entrypoint:http:get-user`;
const EMPTY_MAPPER: Mapper = {
  $schemaVersion: 1,
  project: 'resolver-integration',
  services: [],
  sdkMappings: [],
  pathRewriteRules: [],
  unresolvableServices: [],
};

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
    parserVersion: 'resolver-integration',
    parserId: 'resolver-integration',
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
        sourceCode: 'const shouldNeverReachCloud = true;',
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

describe('pinned resolver Ladybug integration', () => {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-pinned-resolver-'));
  const artifactPath = join(root, 'workspace.lbug');
  let buildEdgeCount = 0;

  beforeAll(async () => {
    const result = await buildGraphFile({
      outputPath: artifactPath,
      workDir: join(root, 'work'),
      components: components(),
      beforeFinalize: async (repository, signal) => {
        const metrics = await resolvePinnedCandidate(
          repository,
          [
            { repoKey: TARGET_REPO, repoName: 'users', httpPrefix: null },
            { repoKey: SOURCE_REPO, repoName: 'web', httpPrefix: null },
          ],
          EMPTY_MAPPER,
          signal,
        );
        expect(metrics).toEqual({ resolved: 1, total: 1, rate: 1, legacyEdges: 0 });
      },
    });
    buildEdgeCount = result.edgeCount;
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds, resolves, finalizes, and reopens the resolved graph', async () => {
    const handle = await openGraphFile({
      path: artifactPath,
      budgets: {
        maxDbSizeBytes: 16 * 1024 ** 3,
        bufferPoolBytes: 256 * 1024 ** 2,
        queryTimeoutMs: 5_000,
      },
    });
    try {
      expect(buildEdgeCount).toBe(7);
      expect(await handle.repository.getResolvesEdge?.(CALL_ID)).toMatchObject({ targetId: ENTRYPOINT_ID });
      expect((await handle.repository.getExternalCalls([SOURCE_REPO]))[0]?.resolvedTargetId).toBe(ENTRYPOINT_ID);
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Call-edge hop, end to end through the file-builder resolver facade.
//
// The facade forwards an explicit method pick-list to the pinned resolver. A
// method missing from that list is silently absent at run time, which is exactly
// the shape of the cloud/CLI recall regression this hop was added to close — so
// the guard has to run against a real built artifact, not a hand-made fake.
// ---------------------------------------------------------------------------

const MONO_REPO = 'cccccccccccc';
const API_REPO = 'dddddddddddd';
const CONSUMER_FN = `${MONO_REPO}:function:src/screens/booking.ts:useBooking`;
const SDK_FN = `${MONO_REPO}:function:packages/sdk/src/client.ts:list`;
const CONSUMER_CALL = `${MONO_REPO}:external_call:src/screens/booking.ts:useBooking:12`;
const SDK_CALL = `${MONO_REPO}:external_call:packages/sdk/src/client.ts:list:20`;
const LIST_ENTRYPOINT = `${API_REPO}:entrypoint:http:list-users`;

function file(repoId: string, path: string) {
  const id = `${repoId}:file:${path}`;
  return {
    id,
    versionedId: `${id}@v1`,
    path,
    extension: '.ts',
    language: 'typescript',
    contentHash: 'v1',
    loc: 30,
  };
}

/**
 * Monorepo consumer: `useBooking` calls the in-workspace SDK method `list`, whose
 * own egress names the route. The consumer's OWN egress carries no path and no
 * moniker, so only the caller's CALLS edge to `list` can resolve it.
 */
function monorepoConsumer(): ParsedRepo {
  const screenFile = file(MONO_REPO, 'src/screens/booking.ts');
  const sdkFile = file(MONO_REPO, 'packages/sdk/src/client.ts');
  const screenLocation = { filePath: screenFile.path, startLine: 1, endLine: 20 };
  const sdkLocation = { filePath: sdkFile.path, startLine: 1, endLine: 30 };
  return {
    id: MONO_REPO,
    name: 'app',
    path: '/private/app',
    type: 'frontend',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: 'resolver-integration',
    parserId: 'resolver-integration',
    packages: [],
    files: [screenFile, sdkFile],
    functions: [
      {
        id: CONSUMER_FN,
        versionedId: `${CONSUMER_FN}@v1`,
        name: 'useBooking',
        kind: 'function',
        fileId: screenFile.id,
        isAsync: false,
        isGenerator: false,
        isExported: true,
        parameters: [],
        location: screenLocation,
      },
      {
        id: SDK_FN,
        versionedId: `${SDK_FN}@v1`,
        name: 'list',
        kind: 'method',
        fileId: sdkFile.id,
        isAsync: true,
        isGenerator: false,
        isExported: true,
        parameters: [],
        location: sdkLocation,
        moniker: { packageName: '@acme/sdk', descriptor: 'UsersClient#list().' },
      },
    ],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [
      {
        id: `${MONO_REPO}:call:useBooking->list`,
        callerId: CONSUMER_FN,
        calleeId: SDK_FN,
        calleeExpression: 'apiClient.list',
        isMethodCall: true,
        location: { ...screenLocation, startLine: 12, endLine: 12 },
      },
    ],
    imports: [],
    externalCalls: [
      {
        id: CONSUMER_CALL,
        versionedId: `${CONSUMER_CALL}@v1`,
        callerId: CONSUMER_FN,
        serviceName: 'apiClient',
        sdkName: 'local:apiClient',
        method: 'list',
        // No path and no moniker: the direct protocol hop and the symbol hop
        // both decline, leaving the call-edge hop as the only route.
        targetDescriptor: { protocol: 'http', targetService: 'users' },
        location: { ...screenLocation, startLine: 12, endLine: 12 },
      },
      {
        id: SDK_CALL,
        versionedId: `${SDK_CALL}@v1`,
        callerId: SDK_FN,
        serviceName: 'users',
        method: 'list',
        targetDescriptor: {
          protocol: 'http',
          targetService: 'users',
          http: { method: 'GET', pathTemplate: '/users' },
        },
        location: { ...sdkLocation, startLine: 20, endLine: 20 },
      },
    ],
    stats: {
      totalFiles: 2,
      parsedFiles: 2,
      skippedFiles: 0,
      totalFunctions: 2,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: 1,
      totalImports: 0,
      totalExternalCalls: 2,
      parseTimeMs: 1,
    },
  };
}

function usersApi(): ParsedRepo {
  const apiFile = file(API_REPO, 'src/users.ts');
  const handlerId = `${API_REPO}:function:src/users.ts:listUsers`;
  const location = { filePath: apiFile.path, startLine: 1, endLine: 12 };
  return {
    id: API_REPO,
    name: 'users',
    path: '/private/users',
    type: 'backend',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: 'resolver-integration',
    parserId: 'resolver-integration',
    packages: [],
    files: [apiFile],
    functions: [
      {
        id: handlerId,
        versionedId: `${handlerId}@v1`,
        name: 'listUsers',
        kind: 'function',
        fileId: apiFile.id,
        isAsync: false,
        isGenerator: false,
        isExported: true,
        parameters: [],
        location,
      },
    ],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [
      {
        id: LIST_ENTRYPOINT,
        versionedId: `${LIST_ENTRYPOINT}@v1`,
        type: 'http',
        handlerId,
        location,
        details: { type: 'http', method: 'GET', path: '/users', fullPath: '/users' },
      },
    ],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: {
      totalFiles: 1,
      parsedFiles: 1,
      skippedFiles: 0,
      totalFunctions: 1,
      totalClasses: 0,
      totalEntrypoints: 1,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 1,
    },
  };
}

async function* callEdgeComponents(): AsyncGenerator<VerifiedGraphBuildComponent> {
  yield { parsedRepo: monorepoConsumer() };
  yield { parsedRepo: usersApi() };
}

describe('pinned resolver call-edge hop integration', () => {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-pinned-resolver-call-edge-'));
  const artifactPath = join(root, 'workspace.lbug');

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the SDK-mediated call through the stored CALLS edge', async () => {
    let metrics: Awaited<ReturnType<typeof resolvePinnedCandidate>> | undefined;
    await buildGraphFile({
      outputPath: artifactPath,
      workDir: join(root, 'work'),
      components: callEdgeComponents(),
      beforeFinalize: async (repository, signal) => {
        metrics = await resolvePinnedCandidate(
          repository,
          [
            { repoKey: MONO_REPO, repoName: 'app', httpPrefix: null },
            { repoKey: API_REPO, repoName: 'users', httpPrefix: null },
          ],
          EMPTY_MAPPER,
          signal,
        );
      },
    });

    // 2 of 2: the SDK method's own egress by the direct protocol hop, the
    // consumer's ambiguous egress only by the call-edge hop.
    expect(metrics).toEqual({ resolved: 2, total: 2, rate: 1, legacyEdges: 0 });

    const handle = await openGraphFile({
      path: artifactPath,
      budgets: {
        maxDbSizeBytes: 16 * 1024 ** 3,
        bufferPoolBytes: 256 * 1024 ** 2,
        queryTimeoutMs: 5_000,
      },
    });
    try {
      expect(await handle.repository.getResolvesEdge?.(CONSUMER_CALL)).toMatchObject({
        targetId: LIST_ENTRYPOINT,
        via: 'call-edge+http',
      });
    } finally {
      await handle.close();
    }
  }, 120_000);
});
