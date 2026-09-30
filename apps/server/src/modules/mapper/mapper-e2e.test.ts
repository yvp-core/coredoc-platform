/**
 * End-to-end resolver integration test.
 *
 * Proves the unified linker's central promise:
 *   - With NO MapperArtifact uploaded (EMPTY_MAPPER), the linker resolves
 *     HTTP-by-descriptor calls to matching entrypoints. Greenfield projects get
 *     cross-repo RESOLVES_TO edges with zero mapper config.
 *   - Uploading a mapper override with `unresolvableServices` demonstrably
 *     changes resolution output vs. no override.
 *
 * Uses fully-mocked IGraphRepository + MapperService + WorkspaceDbPool —
 * no real DB, no real R2, no network. Deterministic.
 */

import { describe, it, expect, vi } from 'vitest';
import { ResolverService } from './resolver.service.js';
import { EMPTY_MAPPER, type MapperService } from './mapper.service.js';
import type { WorkspaceDbPoolService } from '../../database/workspace-db-pool.service.js';
import type { ControlPlaneService } from '../../database/control-plane.service.js';
import type { IGraphRepository, GraphEdge, ExternalCallInfo } from '@coredoc/db';
import type { Mapper } from '@coredoc/core';
import type { PushLeaseService } from '../lease/push-lease.service.js';

const REPOS = [
  { name: 'web', hash: 'h-web', type: 'frontend', parsedAt: '' },
  { name: 'users-svc', hash: 'h-users', type: 'backend', parsedAt: '' },
];

// Node IDs carry the repo hash prefix — fromTurso uses it to derive repoName
// from a single batched listEntrypoints/getExternalCalls call instead of
// per-repo queries.
const EP_USERS_ID = 'h-users:entrypoint:src/users.ts:GET:/users/:id';
const CALL_WEB_ID = 'h-web:external_call:src/api.ts:fetchUser:1';

const ENTRYPOINTS_USERS = [
  {
    id: EP_USERS_ID,
    type: 'http',
    method: 'GET',
    path: '/users/:id',
    fullPath: '/users/:id',
    handlerId: 'fn-handler',
    filePath: 'src/users.ts',
    startLine: 10,
  },
];

const CALLS_FROM_WEB = [
  {
    id: CALL_WEB_ID,
    callerId: 'fn-fetcher',
    callerName: 'fetchUser',
    callerFilePath: 'src/api.ts',
    serviceName: 'users-svc', // matches repo name exactly → descriptor resolver hits
    method: 'getById',
    protocol: 'http' as const,
    httpMethod: 'GET',
    pathTemplate: '/users/:id',
    filePath: 'src/api.ts',
    startLine: 5,
  },
];

const CALLS_FROM_WEB_NONCONVENTIONAL_NAME = [
  {
    // `serviceName: 'usersApi'` is the client-class name the parser sees.
    // `targetService: 'users-svc'` is the canonical repo hint the parser emits
    // (the `targetService` field was added precisely for this case so the linker
    // can restrict matching to the right repo even when `serviceName` is a class
    // name, not a repo name). The linker uses `targetDescriptor.targetService`
    // as `targetRepo` and finds the single GET /users/:id entrypoint.
    id: CALL_WEB_ID,
    callerId: 'fn-fetcher',
    callerName: 'fetchUser',
    callerFilePath: 'src/api.ts',
    serviceName: 'usersApi',
    targetService: 'users-svc', // canonical repo name → linker restricts to users-svc
    method: 'getById',
    protocol: 'http' as const,
    httpMethod: 'GET',
    pathTemplate: '/users/:id',
    filePath: 'src/api.ts',
    startLine: 5,
  },
];

// A dynamic-dispatch SDK egress as Turso stores it (the sample-integrations-api
// `performApiRequest('listCompanyBookings', …)` shape): `method` is the wrapper verb,
// the real SDK method is on `dispatchMethod`, NO http descriptor (protocol 'internal')
// and NO moniker — so the direct hop and symbol hop both miss and only the sdkMapping
// fallback (keyed on dispatchMethod) can resolve it. Proves from-turso reconstructs
// `dispatchMethod` and the server linker keys on it, exactly like the CLI path.
const CALLS_FROM_WEB_DYNAMIC_DISPATCH = [
  {
    id: CALL_WEB_ID,
    callerId: 'fn-fetcher',
    callerName: 'listBookings',
    callerFilePath: 'app/repositories/bookings-repository.js',
    serviceName: 'sample-management-api',
    sdkName: '@sample/management-api-client',
    method: 'PERFORMAPIREQUEST',
    dispatchMethod: 'listCompanyBookings',
    protocol: 'internal' as const,
    filePath: 'app/repositories/bookings-repository.js',
    startLine: 57,
  },
];

// Same edge WITHOUT dispatchMethod — only the wrapper verb survives, so the fallback
// keys on 'PERFORMAPIREQUEST' (matches no row) and the call stays unresolved.
const CALLS_FROM_WEB_DISPATCH_NO_METHOD = [{ ...CALLS_FROM_WEB_DYNAMIC_DISPATCH[0]!, dispatchMethod: undefined }];

const DISPATCH_MAPPER: Mapper = {
  $schemaVersion: 1,
  project: 'demo',
  services: [{ name: 'users-svc', repo: 'users-svc', aliases: [] }],
  sdkMappings: [
    {
      sdkPackage: '@sample/management-api-client',
      sdkClass: 'ApiClient',
      sdkMethod: 'listCompanyBookings',
      targetService: 'users-svc',
      http: { method: 'GET', pathTemplate: '/users/:id' },
    },
  ],
  pathRewriteRules: [],
  unresolvableServices: [],
};

function captureEdges(repo: IGraphRepository): GraphEdge[] {
  const calls = (repo.pushEdges as ReturnType<typeof vi.fn>).mock.calls;
  return calls.length > 0 ? (calls[calls.length - 1]![0] as GraphEdge[]) : [];
}

function createMockRepo(opts: { entrypointsForUsers?: typeof ENTRYPOINTS_USERS; callsFromWeb?: ExternalCallInfo[] }) {
  return {
    listAllRepositories: vi.fn().mockResolvedValue(REPOS),
    // Batched: fromTurso calls listEntrypoints/getExternalCalls ONCE with all hashes.
    listEntrypoints: vi.fn().mockImplementation(async (_p: unknown, hashes: string[]) => {
      return hashes.includes('h-users') ? (opts.entrypointsForUsers ?? ENTRYPOINTS_USERS) : [];
    }),
    getExternalCalls: vi.fn().mockImplementation(async (hashes: string[]) => {
      return hashes.includes('h-web') ? (opts.callsFromWeb ?? CALLS_FROM_WEB) : [];
    }),
    getPackages: vi.fn().mockResolvedValue([]),
    getMonikeredFunctions: vi.fn().mockResolvedValue([]),
    getPackageLinkerFacts: vi.fn().mockResolvedValue({ files: [], declarations: [] }),
    pushEdges: vi.fn().mockResolvedValue(0),
    deleteEdgesByType: vi.fn().mockResolvedValue(undefined),
    updateResolvedTargetIds: vi.fn().mockResolvedValue(undefined),
    clearResolvedTargetIds: vi.fn().mockResolvedValue(undefined),
    getAppliedGraphSnapshot: vi.fn(async (repoId: string) => ({
      parsedVersion: `parsed-${repoId}`,
      summaryVersion: null,
      embeddingsVersion: null,
      commitSha: null,
    })),
  } as unknown as IGraphRepository;
}

function createMockPushLeases(): PushLeaseService {
  return {
    acquireGraphWrite: vi.fn(async (_workspaceId: string, ownerToken: string) => ({ ownerToken, generation: 1n })),
    startRenewal: vi.fn(() => setInterval(() => undefined, 2 ** 30)),
    renewGraphWrite: vi.fn(async () => true),
    releaseGraphWrite: vi.fn(async () => undefined),
  } as unknown as PushLeaseService;
}

function makeResolverService(
  repo: IGraphRepository,
  mapperLoad: () => Promise<{
    mapper: Mapper;
    sha256: string | null;
    descriptor?: { r2Key: string; sha256: string; sizeBytes: string } | null;
  }>,
) {
  const mapperService = {
    loadOrDefault: vi.fn(async () => {
      const loaded = await mapperLoad();
      return { ...loaded, descriptor: loaded.descriptor ?? null };
    }),
  } as unknown as MapperService;
  const workspaceDbPool = {
    acquire: vi.fn().mockResolvedValue(repo),
    release: vi.fn(),
  } as unknown as WorkspaceDbPoolService;
  const controlPlane = {
    getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws1', slug: 'ws-slug', graphBackend: 'turso' }),
    listRepos: vi
      .fn()
      .mockResolvedValue(
        REPOS.map((repo) => ({ id: `row-${repo.hash}`, repoKey: repo.hash, repoName: repo.name, httpPrefix: null })),
      ),
  } as unknown as ControlPlaneService;
  return new ResolverService(mapperService, workspaceDbPool, controlPlane, createMockPushLeases());
}

describe('Mapper E2E (greenfield → uploaded-mapper upgrade)', () => {
  it('greenfield: empty mapper + matching-name call → descriptor resolver hits', async () => {
    const repo = createMockRepo({});
    const svc = makeResolverService(repo, async () => ({ mapper: EMPTY_MAPPER, sha256: null }));

    const result = await svc.resolveWorkspace('ws1');

    expect(result.total).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.mapperSha).toBeNull();

    const edges = captureEdges(repo);
    expect(edges).toHaveLength(1);
    // Unified linker produces `resolve:<sourceCallId>:<targetEntrypointId>` — no legacy: / mapper: prefix
    expect(edges[0]?.id).toBe(`resolve:${CALL_WEB_ID}:${EP_USERS_ID}`);
    expect(edges[0]?.sourceId).toBe(CALL_WEB_ID);
    expect(edges[0]?.targetId).toBe(EP_USERS_ID);

    // Idempotent wipe: stale RESOLVES_TO edges are deleted before writing
    expect(repo.deleteEdgesByType).toHaveBeenCalledWith('RESOLVES_TO', expect.arrayContaining(['h-web', 'h-users']));
  });

  it('non-conventional service name → still resolves via descriptor (single candidate)', async () => {
    // `serviceName: 'usersApi'` does not match repo name 'users-svc', but the
    // linker's descriptor matcher finds the single GET /users/:id entrypoint and
    // resolves it. The unified linker produces one edge in either case.
    const repo = createMockRepo({ callsFromWeb: CALLS_FROM_WEB_NONCONVENTIONAL_NAME });
    const svc = makeResolverService(repo, async () => ({ mapper: EMPTY_MAPPER, sha256: null }));

    const result = await svc.resolveWorkspace('ws1');

    expect(result.resolved).toBe(1);
    expect(result.total).toBe(1);

    const edges = captureEdges(repo);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.id).toBe(`resolve:${CALL_WEB_ID}:${EP_USERS_ID}`);
    expect(edges[0]?.sourceId).toBe(CALL_WEB_ID);
    expect(edges[0]?.targetId).toBe(EP_USERS_ID);
  });

  it('dynamic-dispatch SDK call resolves via dispatchMethod + sdkMapping fallback (server parity with CLI)', async () => {
    // The sample-integrations-api `performApiRequest('listCompanyBookings', …)` shape: from-turso
    // reconstructs `dispatchMethod` off the Turso row and the server's linkWorkspace keys
    // the sdkMapping fallback on it — exactly the P1 primitive, on the cloud path.
    const repo = createMockRepo({ callsFromWeb: CALLS_FROM_WEB_DYNAMIC_DISPATCH });
    const svc = makeResolverService(repo, async () => ({ mapper: DISPATCH_MAPPER, sha256: 'sha-dispatch' }));

    const result = await svc.resolveWorkspace('ws1');

    expect(result.total).toBe(1);
    expect(result.resolved).toBe(1);

    const edges = captureEdges(repo);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.id).toBe(`resolve:${CALL_WEB_ID}:${EP_USERS_ID}`);
    expect(edges[0]?.sourceId).toBe(CALL_WEB_ID);
    expect(edges[0]?.targetId).toBe(EP_USERS_ID);
  });

  it('dynamic-dispatch call WITHOUT dispatchMethod stays unresolved (proves the field is what resolves it)', async () => {
    // Same edge, dispatchMethod absent → the fallback keys on the wrapper verb
    // 'PERFORMAPIREQUEST', which matches no sdkMapping row → zero edges.
    const repo = createMockRepo({ callsFromWeb: CALLS_FROM_WEB_DISPATCH_NO_METHOD });
    const svc = makeResolverService(repo, async () => ({ mapper: DISPATCH_MAPPER, sha256: 'sha-dispatch' }));

    const result = await svc.resolveWorkspace('ws1');

    expect(result.resolved).toBe(0);
    expect(captureEdges(repo)).toHaveLength(0);
  });

  it('uploaded mapper with unresolvableServices override → call excluded, zero edges vs. no-override baseline', async () => {
    // Scenario: the mapper declares 'usersApi' as unresolvable.
    // The linker skips the call entirely — excluded from edges AND from the
    // rate denominator. This proves the override actually changes linker output
    // vs. an empty mapper (which resolves the same call to 1 edge above).
    const repo = createMockRepo({ callsFromWeb: CALLS_FROM_WEB_NONCONVENTIONAL_NAME });
    const mapper: Mapper = {
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      // 'users-svc' matches targetDescriptor.targetService (the canonical repo hint) —
      // the linker normalises to lowercase before comparing, so the match is exact.
      unresolvableServices: ['users-svc'],
    };
    const svc = makeResolverService(repo, async () => ({ mapper, sha256: 'sha-uploaded' }));

    const result = await svc.resolveWorkspace('ws1');

    // Override excludes the call: resolved = 0 (and total = 0 because
    // unresolvable calls are dropped from the denominator).
    expect(result.resolved).toBe(0);
    expect(result.mapperSha).toBe('sha-uploaded');

    // No RESOLVES_TO edge is written (pushEdges not called, or called with []).
    const edges = captureEdges(repo);
    expect(edges).toHaveLength(0);

    // deleteEdgesByType is still called — idempotent stale-wipe always runs.
    expect(repo.deleteEdgesByType).toHaveBeenCalledWith('RESOLVES_TO', expect.arrayContaining(['h-web', 'h-users']));
  });

  it('stale edge cleanup happens on every run (delete-then-insert atomicity contract)', async () => {
    const repo = createMockRepo({});
    const svc = makeResolverService(repo, async () => ({ mapper: EMPTY_MAPPER, sha256: null }));
    await svc.resolveWorkspace('ws1');
    expect(repo.deleteEdgesByType).toHaveBeenCalledTimes(1);
    expect(repo.pushEdges).toHaveBeenCalledTimes(1);
    // Delete must precede push — checked by argument order in mock.calls timeline.
    const deleteOrder = (repo.deleteEdgesByType as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const pushOrder = (repo.pushEdges as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(deleteOrder).toBeLessThan(pushOrder);
  });

  it('zero-repos workspace returns empty metrics without touching Turso', async () => {
    const repo = createMockRepo({});
    const _svc = makeResolverService(repo, async () => ({ mapper: EMPTY_MAPPER, sha256: null }));
    // Override listRepos to be empty by re-creating with a stub ControlPlane.
    const mapperService = { loadOrDefault: vi.fn() } as unknown as MapperService;
    const wsDb = { getRepository: vi.fn().mockResolvedValue(repo) } as unknown as WorkspaceDbPoolService;
    const cp = {
      getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws1', slug: 's', graphBackend: 'turso' }),
      listRepos: vi.fn().mockResolvedValue([]),
    } as unknown as ControlPlaneService;
    const empty = new ResolverService(mapperService, wsDb, cp, createMockPushLeases());

    const result = await empty.resolveWorkspace('ws1');
    expect(result.resolved).toBe(0);
    expect(result.total).toBe(0);
    expect(repo.deleteEdgesByType).not.toHaveBeenCalled();
    expect(repo.pushEdges).not.toHaveBeenCalled();
  });
});
