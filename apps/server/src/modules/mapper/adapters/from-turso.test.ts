import { describe, it, expect, vi } from 'vitest';
import { parsedReposFromRepository, parsedReposFromTurso } from './from-turso.js';
import type { IGraphRepository } from '@coredoc/db';
import { HopVia, linkWorkspace, type Mapper } from '@coredoc/core';

function createMockRepo() {
  return {
    listAllRepositories: vi.fn(),
    listEntrypoints: vi.fn(),
    getExternalCalls: vi.fn(),
    getMonikeredFunctions: vi.fn().mockResolvedValue([]),
    getInternalCallEdges: vi.fn().mockResolvedValue([]),
    getPackages: vi.fn().mockResolvedValue([]),
    getPackageLinkerFacts: vi.fn().mockResolvedValue({ files: [], declarations: [] }),
  } as unknown as IGraphRepository & {
    listAllRepositories: ReturnType<typeof vi.fn>;
    listEntrypoints: ReturnType<typeof vi.fn>;
    getExternalCalls: ReturnType<typeof vi.fn>;
    getMonikeredFunctions: ReturnType<typeof vi.fn>;
    getInternalCallEdges: ReturnType<typeof vi.fn>;
    getPackages: ReturnType<typeof vi.fn>;
    getPackageLinkerFacts: ReturnType<typeof vi.fn>;
  };
}

describe('parsedReposFromTurso', () => {
  it('returns empty array when projectRepoNames is empty (no query made)', async () => {
    const repo = createMockRepo();
    const result = await parsedReposFromTurso(repo, []);
    expect(result).toEqual([]);
    expect(repo.listAllRepositories).not.toHaveBeenCalled();
  });

  it('groups entrypoints and external calls per repo with compatible shapes', async () => {
    const repo = createMockRepo();
    repo.listAllRepositories.mockResolvedValue([
      { name: 'web', hash: 'h-web', type: 'frontend', parsedAt: '2026-05-22T00:00:00Z' },
      { name: 'users-svc', hash: 'h-users', type: 'backend', parsedAt: '2026-05-22T00:00:00Z' },
    ]);
    repo.listEntrypoints.mockResolvedValue([
      {
        id: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
        type: 'http',
        method: 'GET',
        path: '/users/:id',
        fullPath: '/users/:id',
        handlerId: 'fn-handler',
        filePath: 'src/users.ts',
        startLine: 10,
        endLine: 15,
      },
    ]);
    repo.getExternalCalls.mockResolvedValue([
      {
        id: 'h-web:external_call:src/api.ts:fetchUser:1',
        callerId: 'fn-1',
        callerName: 'fetchUser',
        callerFilePath: 'src/api.ts',
        serviceName: 'users-svc',
        method: 'getById',
        protocol: 'http' as const,
        httpMethod: 'GET',
        pathTemplate: '/users/:id',
        filePath: 'src/api.ts',
        startLine: 5,
      },
    ]);

    const prefixes = new Map<string, string | null | undefined>([
      ['web', '/api'],
      ['users-svc', null],
    ]);
    const repos = await parsedReposFromTurso(repo, ['web', 'users-svc'], prefixes);

    expect(repos).toHaveLength(2);

    const usersSvc = repos.find((r) => r.name === 'users-svc');
    expect(usersSvc).toBeDefined();
    expect(usersSvc!.entrypoints).toHaveLength(1);
    expect(usersSvc!.entrypoints[0]).toMatchObject({
      id: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
      type: 'http',
      handlerId: 'fn-handler',
      location: { filePath: 'src/users.ts', startLine: 10, endLine: 15 },
    });
    // details discriminated union is reconstructed
    expect(usersSvc!.entrypoints[0]!.details).toMatchObject({
      type: 'http',
      method: 'GET',
      path: '/users/:id',
      fullPath: '/users/:id',
    });

    const web = repos.find((r) => r.name === 'web');
    expect(web).toBeDefined();
    expect(web!.httpPrefix).toBe('/api');
    expect(web!.externalCalls).toHaveLength(1);
    expect(web!.externalCalls[0]).toMatchObject({
      id: 'h-web:external_call:src/api.ts:fetchUser:1',
      callerId: 'fn-1',
      serviceName: 'users-svc',
      location: { filePath: 'src/api.ts', startLine: 5, endLine: 5 },
    });
    // targetDescriptor is rebuilt from flat fields
    expect(web!.externalCalls[0]!.targetDescriptor).toMatchObject({
      protocol: 'http',
      http: { method: 'GET', pathTemplate: '/users/:id' },
    });
  });

  it('orders pinned identities and graph rows by locale-independent UTF-16 code units', async () => {
    const repo = createMockRepo();
    const pinnedRepos = [
      { repoKey: 'repo-é', repoName: 'service-é', httpPrefix: null },
      { repoKey: 'repo-a', repoName: 'service-a', httpPrefix: null },
      { repoKey: 'repo-_', repoName: 'service-_', httpPrefix: null },
      { repoKey: 'repo-A', repoName: 'service-A', httpPrefix: null },
      { repoKey: 'repo-😀', repoName: 'service-😀', httpPrefix: null },
      { repoKey: 'repo--', repoName: 'service--', httpPrefix: null },
    ];
    const entrypointIds = [
      'repo-A:entrypoint:é',
      'repo-A:entrypoint:a',
      'repo-A:entrypoint:_',
      'repo-A:entrypoint:A',
      'repo-A:entrypoint:😀',
      'repo-A:entrypoint:-',
    ];
    repo.listAllRepositories.mockResolvedValue(
      pinnedRepos.map(({ repoKey, repoName }) => ({ name: repoName, hash: repoKey, type: 'backend', parsedAt: '' })),
    );
    repo.listEntrypoints.mockResolvedValue(
      entrypointIds.map((id) => ({
        id,
        type: 'cron',
        handlerId: `${id}:handler`,
        filePath: 'src/jobs.ts',
        startLine: 1,
      })),
    );
    repo.getExternalCalls.mockResolvedValue([]);

    const parsed = await parsedReposFromRepository(repo, pinnedRepos);

    expect(parsed.map((item) => item.id)).toEqual(['repo--', 'repo-A', 'repo-_', 'repo-a', 'repo-é', 'repo-😀']);
    expect(parsed.find((item) => item.id === 'repo-A')?.entrypoints.map((entrypoint) => entrypoint.id)).toEqual([
      'repo-A:entrypoint:-',
      'repo-A:entrypoint:A',
      'repo-A:entrypoint:_',
      'repo-A:entrypoint:a',
      'repo-A:entrypoint:é',
      'repo-A:entrypoint:😀',
    ]);
    expect(repo.listAllRepositories).toHaveBeenCalledWith([
      'service--',
      'service-A',
      'service-_',
      'service-a',
      'service-é',
      'service-😀',
    ]);
  });

  it('threads httpPrefix from the supplied Map into each repo bucket', async () => {
    const repo = createMockRepo();
    repo.listAllRepositories.mockResolvedValue([{ name: 'gateway-svc', hash: 'h-gw', type: 'backend', parsedAt: '' }]);
    repo.listEntrypoints.mockResolvedValue([]);
    repo.getExternalCalls.mockResolvedValue([]);

    const prefixes = new Map<string, string | null | undefined>([['gateway-svc', '/v1/public/api-gateway']]);
    const repos = await parsedReposFromTurso(repo, ['gateway-svc'], prefixes);
    expect(repos[0]?.httpPrefix).toBe('/v1/public/api-gateway');
  });

  // Queue entrypoints still persist `topic`/`topicValue` alongside the messaging
  // address, so the rebuild must read them when the messaging fields are absent.
  it('rebuilds queue entrypoints from their topic and resolved topic value', async () => {
    const repo = createMockRepo();
    repo.listAllRepositories.mockResolvedValue([
      { name: 'events', hash: 'h-events', type: 'backend', parsedAt: '2026-05-22T00:00:00Z' },
    ]);
    repo.listEntrypoints.mockResolvedValue([
      {
        id: 'h-events:entrypoint:queue:user-created',
        type: 'queue',
        topic: 'Topics.USER_CREATED',
        topicValue: 'user.created',
        handlerId: 'h-events:function:consume',
        filePath: 'src/events.ts',
        startLine: 10,
      },
    ]);
    repo.getExternalCalls.mockResolvedValue([]);

    const [parsed] = await parsedReposFromTurso(repo, ['events']);

    expect(parsed?.entrypoints[0]?.details).toMatchObject({
      type: 'queue',
      topic: 'Topics.USER_CREATED',
      topicValue: 'user.created',
    });
  });

  it('rebuilds canonical messaging descriptors and system-aware entrypoints', async () => {
    const repo = createMockRepo();
    repo.listAllRepositories.mockResolvedValue([
      { name: 'events', hash: 'h-events', type: 'backend', parsedAt: '2026-05-22T00:00:00Z' },
    ]);
    repo.listEntrypoints.mockResolvedValue([
      {
        id: 'h-events:entrypoint:queue:user-created',
        type: 'queue',
        system: 'gcp-pubsub',
        destination: 'Topics.USER_CREATED',
        destinationValue: 'user.created',
        handlerId: 'h-events:function:consume',
        filePath: 'src/events.ts',
        startLine: 10,
      },
    ]);
    repo.getExternalCalls.mockResolvedValue([
      {
        id: 'h-events:external_call:publish',
        callerId: 'h-events:function:publish',
        callerName: 'publish',
        callerFilePath: 'src/events.ts',
        serviceName: 'gcp-pubsub',
        method: 'publish',
        protocol: 'messaging',
        messagingSystem: 'gcp-pubsub',
        messagingDestination: 'user.created',
        messagingDestinationRef: 'Topics.USER_CREATED',
        filePath: 'src/events.ts',
        startLine: 20,
      },
    ]);

    const [parsed] = await parsedReposFromTurso(repo, ['events']);

    expect(parsed?.entrypoints[0]?.details).toMatchObject({
      type: 'queue',
      system: 'gcp-pubsub',
      topic: 'Topics.USER_CREATED',
      topicValue: 'user.created',
    });
    expect(parsed?.externalCalls[0]?.targetDescriptor?.messaging).toEqual({
      system: 'gcp-pubsub',
      destination: 'Topics.USER_CREATED',
      destinationValue: 'user.created',
    });
  });

  it('populates ParsedRepoLike.functions with monikered functions for the SDK-source repo', async () => {
    const mockRepo = createMockRepo();
    mockRepo.listAllRepositories.mockResolvedValue([
      { name: 'sdk-repo', hash: 'h-sdk', type: 'backend', parsedAt: '' },
      { name: 'consumer-repo', hash: 'h-cons', type: 'backend', parsedAt: '' },
    ]);
    mockRepo.listEntrypoints.mockResolvedValue([]);
    mockRepo.getExternalCalls.mockResolvedValue([]);
    // Monikered function belongs to sdk-repo (prefix 'h-sdk')
    mockRepo.getMonikeredFunctions.mockResolvedValue([
      {
        id: 'h-sdk:function:src/client.ts:getUser',
        name: 'getUser',
        kind: 'method' as const,
        filePath: 'src/client.ts',
        startLine: 10,
        endLine: 20,
        isAsync: false,
        moniker: { packageName: '@example/sdk-client', descriptor: 'Client#getUser().' },
      },
    ]);

    const repos = await parsedReposFromTurso(mockRepo, ['sdk-repo', 'consumer-repo']);

    const sdkRepo = repos.find((r) => r.name === 'sdk-repo');
    const consumerRepo = repos.find((r) => r.name === 'consumer-repo');

    // SDK-source repo has its monikered function populated
    expect(sdkRepo?.functions).toHaveLength(1);
    expect(sdkRepo?.functions?.[0]).toMatchObject({
      id: 'h-sdk:function:src/client.ts:getUser',
      name: 'getUser',
      moniker: { packageName: '@example/sdk-client', descriptor: 'Client#getUser().' },
    });

    // Consumer repo has no SDK functions
    expect(consumerRepo?.functions ?? []).toHaveLength(0);

    // getMonikeredFunctions was called once with both hashes
    expect(mockRepo.getMonikeredFunctions).toHaveBeenCalledOnce();
    expect(mockRepo.getMonikeredFunctions).toHaveBeenCalledWith(['h-cons', 'h-sdk']);
  });

  it('reconstructs package imports and merges exported functions with monikered functions', async () => {
    const mockRepo = createMockRepo();
    mockRepo.listAllRepositories.mockResolvedValue([
      { name: 'consumer', hash: 'h-cons', type: 'backend', parsedAt: '' },
      { name: 'acme-packages', hash: 'h-pkg', type: 'backend', parsedAt: '' },
    ]);
    mockRepo.listEntrypoints.mockResolvedValue([]);
    mockRepo.getExternalCalls.mockResolvedValue([]);
    mockRepo.getPackages.mockResolvedValue([
      { id: 'h-cons:package:consumer', name: '@acme/consumer', path: '.', repoId: 'h-cons' },
      {
        id: 'h-pkg:package:acme-api-client',
        name: '@acme/acme-api-client',
        path: 'packages/acme-api-client',
        repoId: 'h-pkg',
      },
    ]);
    mockRepo.getPackageLinkerFacts.mockResolvedValue({
      files: [
        {
          id: 'h-cons:file:src/use-booking.ts',
          path: 'src/use-booking.ts',
          packageId: 'h-cons:package:consumer',
          imports: [
            {
              id: 'h-cons:import:booking-types',
              moduleSpecifier: '@acme/acme-api-client',
              isTypeOnly: true,
              importKind: 'named',
              importedNames: [{ name: 'BookingTypes' }],
            },
          ],
        },
        {
          id: 'h-pkg:file:packages/acme-api-client/src/enums.ts',
          path: 'packages/acme-api-client/src/enums.ts',
          packageId: 'h-pkg:package:acme-api-client',
          imports: [],
        },
      ],
      declarations: [
        {
          id: 'h-pkg:enum:packages/acme-api-client/src/enums.ts:BookingTypes',
          name: 'BookingTypes',
          fileId: 'h-pkg:file:packages/acme-api-client/src/enums.ts',
          kind: 'enum',
          isExported: true,
        },
        {
          id: 'h-pkg:function:packages/acme-api-client/src/enums.ts:makeBooking',
          name: 'makeBooking',
          fileId: 'h-pkg:file:packages/acme-api-client/src/enums.ts',
          kind: 'function',
          isExported: true,
        },
      ],
    });
    mockRepo.getMonikeredFunctions.mockResolvedValue([
      {
        id: 'h-pkg:function:packages/acme-api-client/src/enums.ts:makeBooking',
        name: 'makeBooking',
        kind: 'function',
        fileId: 'h-pkg:file:packages/acme-api-client/src/enums.ts',
        filePath: 'packages/acme-api-client/src/enums.ts',
        startLine: 1,
        endLine: 2,
        isAsync: false,
        isExported: true,
        moniker: { packageName: '@acme/acme-api-client', descriptor: 'makeBooking().' },
      },
    ]);

    const repos = await parsedReposFromTurso(mockRepo, ['consumer', 'acme-packages']);
    const provider = repos.find((repo) => repo.name === 'acme-packages');
    const result = linkWorkspace(repos);

    expect(provider?.enums?.map((node) => node.name)).toEqual(['BookingTypes']);
    expect(provider?.functions).toHaveLength(1);
    expect(provider?.functions?.[0]?.moniker).toEqual({
      packageName: '@acme/acme-api-client',
      descriptor: 'makeBooking().',
    });
    expect(result.packageImportEdges).toEqual([
      expect.objectContaining({
        sourceId: 'h-cons:file:src/use-booking.ts',
        targetId: 'h-pkg:enum:packages/acme-api-client/src/enums.ts:BookingTypes',
      }),
    ]);
  });

  it('leaves functions empty and skips the package reads when a single repo has no monikered functions', async () => {
    const mockRepo = {
      listAllRepositories: vi.fn().mockResolvedValue([{ name: 'svc', hash: 'h-svc', type: 'backend', parsedAt: '' }]),
      listEntrypoints: vi.fn().mockResolvedValue([]),
      getExternalCalls: vi.fn().mockResolvedValue([]),
      getMonikeredFunctions: vi.fn().mockResolvedValue([]),
      getPackages: vi.fn().mockResolvedValue([]),
      getPackageLinkerFacts: vi.fn().mockResolvedValue({ files: [], declarations: [] }),
    } as unknown as IGraphRepository;

    const repos = await parsedReposFromTurso(mockRepo, ['svc']);
    expect(repos).toHaveLength(1);
    expect(repos[0]?.functions ?? []).toHaveLength(0);
    expect(mockRepo.getMonikeredFunctions).toHaveBeenCalledWith(['h-svc']);
    // Package-import links are cross-repo by definition: one repo reads neither projection.
    expect(mockRepo.getPackages).not.toHaveBeenCalled();
    expect(mockRepo.getPackageLinkerFacts).not.toHaveBeenCalled();
  });
});

/**
 * Cloud parity for the call-edge disambiguation hop.
 *
 * The sdk-mapping ambiguity guard (a `(sdkPackage, sdkMethod)` key that maps to
 * two distinct routes registers no fallback tier) and the compensating call-edge
 * hop shipped together. The CLI push path supplies `calls` to `linkWorkspace`;
 * if this adapter does not, the guard is live on cloud while its compensation is
 * dead — a net recall regression against the CLI on the same graph.
 */
describe('call-edge hop evidence', () => {
  const APP = 'h-app';
  const USERS = 'h-users';
  const CONSUMER_FN = `${APP}:function:src/screens/booking.ts:useBooking`;
  const SDK_FN = `${APP}:function:packages/sdk/src/client.ts:list`;
  const CONSUMER_CALL = `${APP}:external_call:src/screens/booking.ts:useBooking:12`;
  const SDK_CALL = `${APP}:external_call:packages/sdk/src/client.ts:list:20`;
  const ENTRYPOINT = `${USERS}:entrypoint:src/users.ts:GET:/users`;

  /** Two rows share (@acme/sdk, list) with DIFFERENT routes → the package and
   * method-only fallback tiers refuse the key, so only the call-edge hop can
   * resolve the consumer's ambiguous call. */
  const AMBIGUOUS_MAPPER: Mapper = {
    $schemaVersion: 1,
    project: 'call-edge-parity',
    services: [
      { name: 'app', repo: 'app', aliases: [] },
      { name: 'users', repo: 'users', aliases: [] },
    ],
    sdkMappings: [
      {
        sdkPackage: '@acme/sdk',
        sdkClass: 'UsersClient',
        sdkMethod: 'list',
        targetService: 'users',
        http: { method: 'GET', pathTemplate: '/users', pathParams: [] },
      },
      {
        sdkPackage: '@acme/sdk',
        sdkClass: 'OrdersClient',
        sdkMethod: 'list',
        targetService: 'orders',
        http: { method: 'GET', pathTemplate: '/orders', pathParams: [] },
      },
    ],
    pathRewriteRules: [],
    unresolvableServices: [],
  };

  function seed(repo: ReturnType<typeof createMockRepo>): void {
    repo.listAllRepositories.mockResolvedValue([
      { name: 'app', hash: APP, type: 'frontend', parsedAt: '' },
      { name: 'users', hash: USERS, type: 'backend', parsedAt: '' },
    ]);
    repo.listEntrypoints.mockResolvedValue([
      {
        id: ENTRYPOINT,
        type: 'http',
        method: 'GET',
        path: '/users',
        fullPath: '/users',
        handlerId: `${USERS}:function:src/users.ts:list`,
        filePath: 'src/users.ts',
        startLine: 10,
        endLine: 15,
      },
    ]);
    repo.getExternalCalls.mockResolvedValue([
      // The SDK method's own egress — this is what gives the SDK method node an
      // `egress`, i.e. makes it a call-edge hop candidate.
      {
        id: SDK_CALL,
        callerId: SDK_FN,
        serviceName: 'users',
        method: 'list',
        protocol: 'http' as const,
        httpMethod: 'GET',
        pathTemplate: '/users',
        targetService: 'users',
        filePath: 'packages/sdk/src/client.ts',
        startLine: 20,
      },
      // The consumer's call: a locally-named client, no moniker, no path — the
      // direct protocol hop and the symbol hop both decline.
      {
        id: CONSUMER_CALL,
        callerId: CONSUMER_FN,
        serviceName: 'apiClient',
        sdkName: 'local:apiClient',
        method: 'list',
        protocol: 'http' as const,
        filePath: 'src/screens/booking.ts',
        startLine: 12,
      },
    ]);
    repo.getMonikeredFunctions.mockResolvedValue([
      {
        id: SDK_FN,
        name: 'list',
        kind: 'method' as const,
        filePath: 'packages/sdk/src/client.ts',
        startLine: 18,
        endLine: 24,
        isAsync: true,
        moniker: { packageName: '@acme/sdk', descriptor: 'UsersClient#list().' },
      },
    ]);
  }

  it('resolves an ambiguous sdk call through the stored CALLS edge', async () => {
    const repo = createMockRepo();
    seed(repo);
    repo.getInternalCallEdges.mockResolvedValue([{ callerId: CONSUMER_FN, calleeId: SDK_FN }]);

    const repos = await parsedReposFromTurso(repo, ['app', 'users']);

    // The callee set is bounded by the monikered-function projection, never a
    // whole-workspace CALLS scan.
    expect(repo.getInternalCallEdges).toHaveBeenCalledWith([APP, USERS], [SDK_FN]);
    expect(repos.find((r) => r.name === 'app')?.calls).toEqual([
      expect.objectContaining({ callerId: CONSUMER_FN, calleeId: SDK_FN }),
    ]);

    const result = linkWorkspace(repos, AMBIGUOUS_MAPPER);
    const consumerEdge = result.edges.find((edge) => edge.sourceId === CONSUMER_CALL);
    expect(consumerEdge?.targetId).toBe(ENTRYPOINT);
    expect(consumerEdge?.properties.via).toBe(`${HopVia.CallEdge}+${HopVia.Http}`);
  });

  it('leaves the ambiguous sdk call unresolved when the backend has no CALLS projection', async () => {
    const repo = createMockRepo();
    seed(repo);
    // Backend without the optional projection — old snapshots degrade to the
    // pre-hop behaviour instead of failing.
    (repo as { getInternalCallEdges?: unknown }).getInternalCallEdges = undefined;

    const repos = await parsedReposFromTurso(repo, ['app', 'users']);
    expect(repos.find((r) => r.name === 'app')?.calls ?? []).toHaveLength(0);

    const result = linkWorkspace(repos, AMBIGUOUS_MAPPER);
    expect(result.edges.find((edge) => edge.sourceId === CONSUMER_CALL)).toBeUndefined();
    // The SDK method's own egress still resolves — only the consumer hop is lost.
    expect(result.edges.map((edge) => edge.sourceId)).toEqual([SDK_CALL]);
  });
});
