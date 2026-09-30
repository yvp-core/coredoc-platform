import type { LinkResult, Mapper } from '@coredoc/core';
import type { IGraphRepository } from '@coredoc/db';
import { describe, expect, it, vi } from 'vitest';
import {
  computePinnedResolution,
  persistPinnedResolution,
  resolvePinnedCandidate,
  type PinnedResolverRepo,
} from './resolver-kernel.js';

const PINNED_REPOS: readonly PinnedResolverRepo[] = [
  { repoKey: 'h-users', repoName: 'users', httpPrefix: null },
  { repoKey: 'h-web', repoName: 'web', httpPrefix: '/api' },
];

const EMPTY_MAPPER: Mapper = {
  $schemaVersion: 1,
  project: 'test',
  services: [],
  sdkMappings: [],
  pathRewriteRules: [],
  unresolvableServices: [],
};

function makeRepository(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listAllRepositories: vi.fn(async () => [
      { name: 'web', hash: 'h-web', type: 'frontend', parsedAt: '' },
      { name: 'users', hash: 'h-users', type: 'backend', parsedAt: '' },
    ]),
    listEntrypoints: vi.fn(async () => [
      {
        id: 'h-users:entrypoint:http:z',
        type: 'http',
        method: 'GET',
        path: '/users/:id',
        fullPath: '/users/:id',
        handlerId: 'h-users:function:z',
        filePath: 'src/z.ts',
        startLine: 2,
      },
      {
        id: 'h-users:entrypoint:http:a',
        type: 'http',
        method: 'GET',
        path: '/health',
        fullPath: '/health',
        handlerId: 'h-users:function:a',
        filePath: 'src/a.ts',
        startLine: 1,
      },
    ]),
    getExternalCalls: vi.fn(async () => [
      {
        id: 'h-web:external_call:z',
        callerId: 'h-web:function:z',
        callerName: 'z',
        callerFilePath: 'src/z.ts',
        serviceName: 'users',
        method: 'get',
        protocol: 'http',
        httpMethod: 'GET',
        pathTemplate: '/users/:id',
        filePath: 'src/z.ts',
        startLine: 2,
      },
      {
        id: 'h-web:external_call:a',
        callerId: 'h-web:function:a',
        callerName: 'a',
        callerFilePath: 'src/a.ts',
        serviceName: 'users',
        method: 'health',
        protocol: 'http',
        httpMethod: 'GET',
        pathTemplate: '/health',
        filePath: 'src/a.ts',
        startLine: 1,
      },
    ]),
    getMonikeredFunctions: vi.fn(async () => []),
    getPackages: vi.fn(async () => []),
    getPackageLinkerFacts: vi.fn(async () => ({ files: [], declarations: [] })),
    deleteEdgesByType: vi.fn(async () => undefined),
    pushEdges: vi.fn(async (edges: unknown[]) => edges.length),
    updateResolvedTargetIds: vi.fn(async () => undefined),
    clearResolvedTargetIds: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as IGraphRepository;
}

describe('pinned resolver kernel', () => {
  it('verifies exact pinned identities and returns stable-sorted repos and edges', async () => {
    const repository = makeRepository();
    const first = await computePinnedResolution(repository, [...PINNED_REPOS].reverse(), EMPTY_MAPPER);
    const second = await computePinnedResolution(repository, PINNED_REPOS, EMPTY_MAPPER);

    expect(first.repos.map((repo) => repo.id)).toEqual(['h-users', 'h-web']);
    expect(first.repos[0]?.entrypoints.map((entrypoint) => entrypoint.id)).toEqual([
      'h-users:entrypoint:http:a',
      'h-users:entrypoint:http:z',
    ]);
    expect(first.repos[1]?.externalCalls.map((call) => call.id)).toEqual([
      'h-web:external_call:a',
      'h-web:external_call:z',
    ]);
    expect(first.result.edges.map((edge) => edge.id)).toEqual([...first.result.edges.map((edge) => edge.id)].sort());
    expect(first.result.edges).toEqual(second.result.edges);
    expect(repository.listAllRepositories).toHaveBeenCalledWith(['users', 'web']);
    expect(repository.listEntrypoints).toHaveBeenCalledWith({}, ['h-users', 'h-web']);
  });

  it('orders resolution output by locale-independent UTF-16 code units', async () => {
    const suffixes = ['é', 'a', '_', 'A', '😀', '-'];
    const repository = makeRepository({
      listEntrypoints: vi.fn(async () =>
        suffixes.map((suffix) => ({
          id: `h-users:entrypoint:http:${suffix}`,
          type: 'http',
          method: 'GET',
          path: `/matched/${encodeURIComponent(suffix)}`,
          fullPath: `/matched/${encodeURIComponent(suffix)}`,
          handlerId: `h-users:function:${suffix}`,
          filePath: 'src/users.ts',
          startLine: 1,
        })),
      ),
      getExternalCalls: vi.fn(async () => [
        ...suffixes.map((suffix) => ({
          id: `h-web:external_call:matched:${suffix}`,
          callerId: `h-web:function:matched:${suffix}`,
          callerName: `matched-${suffix}`,
          callerFilePath: 'src/client.ts',
          serviceName: 'users',
          method: 'get',
          protocol: 'http',
          httpMethod: 'GET',
          pathTemplate: `/matched/${encodeURIComponent(suffix)}`,
          filePath: 'src/client.ts',
          startLine: 1,
        })),
        ...suffixes.map((suffix) => ({
          id: `h-web:external_call:unmatched:${suffix}`,
          callerId: `h-web:function:unmatched:${suffix}`,
          callerName: `unmatched-${suffix}`,
          callerFilePath: 'src/client.ts',
          serviceName: 'users',
          method: 'get',
          protocol: 'http',
          httpMethod: 'GET',
          pathTemplate: `/unmatched/${encodeURIComponent(suffix)}`,
          filePath: 'src/client.ts',
          startLine: 1,
        })),
      ]),
    });

    const result = await computePinnedResolution(repository, PINNED_REPOS, EMPTY_MAPPER);
    const orderedSuffixes = ['-', 'A', '_', 'a', 'é', '😀'];

    expect(result.result.edges.map((edge) => edge.sourceId)).toEqual(
      orderedSuffixes.map((suffix) => `h-web:external_call:matched:${suffix}`),
    );
    expect(result.result.unresolved.map((item) => item.sourceId)).toEqual(
      orderedSuffixes.map((suffix) => `h-web:external_call:unmatched:${suffix}`),
    );
  });

  it('rejects a missing or mismatched pinned identity before graph detail reads', async () => {
    const repository = makeRepository({
      listAllRepositories: vi.fn(async () => [
        { name: 'users', hash: 'wrong-hash', type: 'backend', parsedAt: '' },
        { name: 'web', hash: 'h-web', type: 'frontend', parsedAt: '' },
      ]),
    });

    await expect(computePinnedResolution(repository, PINNED_REPOS, EMPTY_MAPPER)).rejects.toThrow(
      /pinned repository identity mismatch.*h-users.*users/i,
    );
    expect(repository.listEntrypoints).not.toHaveBeenCalled();
    expect(repository.getExternalCalls).not.toHaveBeenCalled();
  });

  it('checks aborts between every read and persistence operation', async () => {
    const readAbort = new AbortController();
    const readRepository = makeRepository({
      listAllRepositories: vi.fn(async () => {
        readAbort.abort(new Error('stop after identities'));
        return [
          { name: 'users', hash: 'h-users', type: 'backend', parsedAt: '' },
          { name: 'web', hash: 'h-web', type: 'frontend', parsedAt: '' },
        ];
      }),
    });
    await expect(computePinnedResolution(readRepository, PINNED_REPOS, EMPTY_MAPPER, readAbort.signal)).rejects.toThrow(
      'stop after identities',
    );
    expect(readRepository.listEntrypoints).not.toHaveBeenCalled();

    const writeAbort = new AbortController();
    const writeRepository = makeRepository({
      deleteEdgesByType: vi.fn(async () => {
        writeAbort.abort(new Error('stop after stale-edge delete'));
      }),
    });
    const result: LinkResult = {
      edges: [
        {
          id: 'resolve:h-web:external_call:a:h-users:entrypoint:http:a',
          sourceId: 'h-web:external_call:a',
          targetId: 'h-users:entrypoint:http:a',
          confidence: 1,
          properties: {},
        },
      ],
      unresolved: [],
      metrics: { total: 1, resolved: 1, unresolvableExcluded: 0, rate: 1 },
    };
    const repos = [
      { id: 'h-users', name: 'users', externalCalls: [] },
      { id: 'h-web', name: 'web', externalCalls: [{ id: 'h-web:external_call:a' }] },
    ];
    await expect(persistPinnedResolution(writeRepository, repos, result, writeAbort.signal)).rejects.toThrow(
      'stop after stale-edge delete',
    );
    expect(writeRepository.pushEdges).not.toHaveBeenCalled();
    expect(writeRepository.updateResolvedTargetIds).not.toHaveBeenCalled();
  });

  it('composes computation and persistence without external services', async () => {
    const repository = makeRepository();
    const metrics = await resolvePinnedCandidate(repository, PINNED_REPOS, EMPTY_MAPPER);
    expect(metrics).toEqual({ resolved: 2, total: 2, rate: 1, legacyEdges: 0 });
    expect(repository.deleteEdgesByType).toHaveBeenCalledWith('RESOLVES_TO', ['h-users', 'h-web']);
    expect(repository.pushEdges).toHaveBeenCalledOnce();
  });

  it('computes and persists package-import edges through the pinned repository path', async () => {
    const repository = makeRepository({
      listEntrypoints: vi.fn(async () => []),
      getExternalCalls: vi.fn(async () => []),
      getPackages: vi.fn(async () => [
        { id: 'h-web:package:web', name: '@acme/web', path: '.', repoId: 'h-web' },
        {
          id: 'h-users:package:api-client',
          name: '@acme/acme-api-client',
          path: 'packages/api-client',
          repoId: 'h-users',
        },
      ]),
      getPackageLinkerFacts: vi.fn(async () => ({
        files: [
          {
            id: 'h-web:file:src/use-booking.ts',
            path: 'src/use-booking.ts',
            packageId: 'h-web:package:web',
            imports: [
              {
                id: 'h-web:import:booking-types',
                moduleSpecifier: '@acme/acme-api-client',
                isTypeOnly: true,
                importKind: 'named',
                importedNames: [{ name: 'BookingTypes' }],
              },
            ],
          },
          {
            id: 'h-users:file:packages/api-client/src/enums.ts',
            path: 'packages/api-client/src/enums.ts',
            packageId: 'h-users:package:api-client',
            imports: [],
          },
        ],
        declarations: [
          {
            id: 'h-users:enum:packages/api-client/src/enums.ts:BookingTypes',
            name: 'BookingTypes',
            fileId: 'h-users:file:packages/api-client/src/enums.ts',
            kind: 'enum',
            isExported: true,
          },
        ],
      })),
    });

    const computation = await computePinnedResolution(repository, PINNED_REPOS, EMPTY_MAPPER);
    expect(computation.result.edges).toEqual([]);
    expect(computation.result.metrics).toEqual({ total: 0, resolved: 0, unresolvableExcluded: 0, rate: 0 });
    expect(computation.result.packageImportEdges).toEqual([
      expect.objectContaining({
        sourceId: 'h-web:file:src/use-booking.ts',
        targetId: 'h-users:enum:packages/api-client/src/enums.ts:BookingTypes',
      }),
    ]);

    await persistPinnedResolution(repository, computation.repos, computation.result);
    const persisted = (repository.pushEdges as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Array<{
      sourceId: string;
      targetId: string;
      properties: Record<string, unknown>;
    }>;
    expect(persisted).toEqual([
      expect.objectContaining({
        sourceId: 'h-web:file:src/use-booking.ts',
        targetId: 'h-users:enum:packages/api-client/src/enums.ts:BookingTypes',
        properties: expect.objectContaining({ relation: 'package-import' }),
      }),
    ]);
    expect(repository.updateResolvedTargetIds).not.toHaveBeenCalled();
  });
});
