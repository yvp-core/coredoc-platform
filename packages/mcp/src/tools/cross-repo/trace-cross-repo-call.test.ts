/**
 * Tests for the trace_cross_repo_call tool handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleTraceCrossRepoCall, type CrossRepoCallResult } from './trace-cross-repo-call.js';
import type { ScopeContext } from '../../types.js';
import { resolveDetailLevel, DETAIL_ESCALATION_HINT } from '../../detail-level.js';

// Mock database abstraction layer
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../response-formatter.js')>()),
  // Mirrors the real createMetadata signature — `detailLevel` rides the metadata
  // and drives the basic-detail escalation footer, so dropping it here would
  // make the mock lie about the rendered response.
  createMetadata: vi.fn((scope, format, detailLevel) => ({
    scope,
    staleness: {
      warning: 'Data reflects parsed stable branch, not local changes',
      parsedAt: '2024-01-15T10:30:00.000Z',
    },
    format,
    detailLevel,
  })),
}));

// Import after mocks
import { getRepository } from '@coredoc/db';
import {
  createMockRepository,
  createMockEntrypointInfo,
  createMockExternalCallInfo,
} from '../../__tests__/fixtures/mock-repository.js';

describe('trace_cross_repo_call Tool Handler', () => {
  let mockScope: ScopeContext;
  const defaultDetailConfig = resolveDetailLevel('full');

  beforeEach(() => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['api-service'],
      repoHashes: ['abc123def456'],
      crossRepoEnabled: true,
      project: 'test-group',
    };

    vi.clearAllMocks();
  });

  // ===========================================================================
  // Validation Tests
  // ===========================================================================

  describe('Parameter Validation', () => {
    it('should require either targetService or callPattern', async () => {
      const mockRepo = createMockRepository();
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall({}, mockScope, 'summary', 'full', defaultDetailConfig, mockRepo);
      expect(result.data).toContain('Must specify either "targetService", "callPattern", or "destination"');
      expect(result.isError).toBe(true);
    });

    it('should accept targetService parameter', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { targetService: 'user-service' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('No cross-repo calls found');
    });

    // getExternalCalls filters on COALESCE(targetService, serviceName), and
    // list_service_dependencies keys its rows the same way — so the answer must
    // name the target that was matched, not the client/SDK label beside it.
    it('names the effective target service, not the client label that shadows it', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createMockExternalCallInfo({
            callerName: 'listHolidays',
            serviceName: 'acme-backend',
            targetService: 'client-admin-api',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/holidays',
            messagingSystem: undefined,
            messagingDestination: undefined,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { targetService: 'client-admin-api' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toMatchObject({ target: { repo: 'client-admin-api' } });
      expect((result.data as { summary: string }).summary).toContain('client-admin-api');
      expect((result.data as { summary: string }).summary).not.toContain('acme-backend');
    });

    // A Swift/Kotlin client carries no service name at all; the cross-repo link
    // is the only thing that knows which repo it reaches. Naming '' answers
    // "who calls orders?" with an empty target.
    it('names the repo the call resolved to when the call carries no service name', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createMockExternalCallInfo({
            callerName: 'loadOrders',
            serviceName: '',
            targetService: undefined,
            resolvedTargetId: 'bbb222:entrypoint:02-orders',
            resolvedTargetRepoName: 'orders',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/orders',
            messagingSystem: undefined,
            messagingDestination: undefined,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { targetService: 'orders' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toMatchObject({ target: { repo: 'orders' } });
      expect((result.data as { summary: string }).summary).toContain('orders');
    });

    it('should accept callPattern parameter', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/api/users' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('No cross-repo calls found');
    });

    it('rejects system without destination and destination mixed with request/response modes', async () => {
      const mockRepo = createMockRepository();
      const systemOnly = await handleTraceCrossRepoCall(
        { system: 'kafka' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(systemOnly.data).toContain('only valid with');
      expect(systemOnly.isError).toBe(true);

      const mixed = await handleTraceCrossRepoCall(
        { destination: 'orders', callPattern: 'POST /orders' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(mixed.data).toContain('cannot be combined');
      expect(mixed.isError).toBe(true);
    });

    // A raw caller JSON.parses `data`, so prose is a syntax error there — but a bare
    // `{}` is just as useless, and `isError` alone will not reach them (the hosts use
    // it for ordinary misses, not protocol failures). The reason has to be IN the
    // payload. A bad argument must not travel as an exception either: the local host
    // would render it as `Tool execution failed: …` while the cloud wrapper rethrows.
    it('carries the reason in the raw payload when a guard fires', async () => {
      const mockRepo = createMockRepository();
      const cases: [Record<string, unknown>, string][] = [
        [{}, 'Must specify either'],
        [{ system: 'kafka' }, 'only valid with'],
        [{ destination: 'orders', callPattern: 'POST /orders' }, 'cannot be combined'],
      ];
      for (const [args, expected] of cases) {
        const rejected = await handleTraceCrossRepoCall(args, mockScope, 'raw', 'full', defaultDetailConfig, mockRepo);
        const data = rejected.data as { error?: string };
        expect(typeof data).toBe('object');
        expect(data.error).toContain(expected);
        expect(rejected.isError).toBe(true);
      }
    });

    it('should accept both targetService and callPattern', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const _result = await handleTraceCrossRepoCall(
        { targetService: 'user-service', callPattern: '/api/users' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.listEntrypoints).toHaveBeenCalled();
    });
  });

  describe('Messaging destination mode', () => {
    it('returns explicit ambiguity when the same destination exists in multiple systems', async () => {
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:1',
            callerName: 'publishKafka',
            filePath: 'a.ts',
            startLine: 1,
            system: 'kafka',
            destination: 'orders',
          },
          {
            id: 'b:external_call:1',
            callerName: 'publishNats',
            filePath: 'b.ts',
            startLine: 2,
            system: 'nats',
            destination: 'orders',
          },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'producer-a', parserVersion: '1.1.0' },
          { hash: 'b', name: 'producer-b', parserVersion: '1.1.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'orders' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(result.data).toMatchObject({
        mode: 'destination',
        status: 'ambiguous',
        availableSystems: ['kafka', 'nats'],
      });
    });

    // A generic/unresolved token (`TOPIC`, `this.topic`, a shared constant) shows up
    // on many sites with DIFFERENT destinations. It must not merge them: asking for
    // `orders` may never return the `billing` producer.
    it('does not merge destinations that merely share a non-discriminating token', async () => {
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:1',
            callerName: 'publishOrders',
            filePath: 'a.ts',
            startLine: 1,
            system: 'kafka',
            destination: 'orders',
            destinationRef: 'TOPIC',
          },
          {
            id: 'b:external_call:1',
            callerName: 'publishBilling',
            filePath: 'b.ts',
            startLine: 2,
            system: 'kafka',
            destination: 'billing',
            destinationRef: 'TOPIC',
          },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'orders-svc', parserVersion: '1.1.0' },
          { hash: 'b', name: 'billing-svc', parserVersion: '1.1.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'orders' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      const data = result.data as { producers: { caller: string }[] };
      expect(data.producers.map((p) => p.caller)).toEqual(['publishOrders']);
    });

    // Chained refs must not compose either: x->y, y->z must not pull z into a query for x.
    // Staged rollout: repo A re-parsed, repo B not yet. B's consumer row records no
    // system, so its broker is unknowable — it is EXCLUDED rather than attributed to
    // whatever happens to publish the same destination. The answer is A's producer
    // plus `staleRepos` naming B, not a guessed pair.
    it('excludes sites from a stale snapshot instead of attributing them to a system', async () => {
      const staleConsumer = createMockEntrypointInfo({
        id: 'b:entrypoint:uc',
        type: 'queue',
        handlerName: 'consumeUserCreated',
        destination: 'user.created',
      });
      (staleConsumer as Record<string, unknown>).system = undefined;
      (staleConsumer as Record<string, unknown>).destinationValue = undefined;

      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:1',
            callerName: 'publishUserCreated',
            filePath: 'a.ts',
            startLine: 1,
            system: 'kafka',
            destination: 'user.created',
          },
        ]),
        listEntrypoints: vi.fn((params: { type?: string }) =>
          Promise.resolve(params.type === 'queue' ? [staleConsumer] : []),
        ),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'new-producer', parserVersion: '1.1.0' },
          { hash: 'b', name: 'old-consumer', parserVersion: '1.0.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'user.created' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(result.data).toMatchObject({
        status: 'matched',
        system: 'kafka',
        producers: [{ caller: 'publishUserCreated' }],
        consumers: [],
        staleRepos: ['old-consumer'],
      });
    });

    it('names the stale repos in summary output so an empty side is explained', async () => {
      const staleConsumer = createMockEntrypointInfo({
        id: 'b:entrypoint:uc',
        type: 'queue',
        handlerName: 'consumeUserCreated',
        destination: 'user.created',
      });
      (staleConsumer as Record<string, unknown>).system = undefined;
      (staleConsumer as Record<string, unknown>).destinationValue = undefined;

      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:1',
            callerName: 'publishUserCreated',
            filePath: 'a.ts',
            startLine: 1,
            system: 'kafka',
            destination: 'user.created',
          },
        ]),
        listEntrypoints: vi.fn((params: { type?: string }) =>
          Promise.resolve(params.type === 'queue' ? [staleConsumer] : []),
        ),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'new-producer', parserVersion: '1.1.0' },
          { hash: 'b', name: 'old-consumer', parserVersion: '1.0.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'user.created' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(result.data).toContain('old-consumer');
      expect(result.data).toContain('coredoc parse');
    });

    // A site whose repo is CURRENT but whose row records no system stays in its own
    // `unknown` bucket — it is never merged into a concrete transport. (Exclusion is
    // keyed on the snapshot's parserVersion, not on a missing field.)
    it('keeps a systemless bucket distinct from concrete systems', async () => {
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          { id: 'a:external_call:1', callerName: 'pLegacy', filePath: 'a.ts', startLine: 1, destination: 'orders' },
          {
            id: 'b:external_call:1',
            callerName: 'pKafka',
            filePath: 'b.ts',
            startLine: 2,
            system: 'kafka',
            destination: 'orders',
          },
          {
            id: 'c:external_call:1',
            callerName: 'pNats',
            filePath: 'c.ts',
            startLine: 3,
            system: 'nats',
            destination: 'orders',
          },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'a-svc', parserVersion: '1.1.0' },
          { hash: 'b', name: 'b-svc', parserVersion: '1.1.0' },
          { hash: 'c', name: 'c-svc', parserVersion: '1.1.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'orders' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      // Sorted on the DISPLAY label, so `unknown` is not dragged to the front by ''.
      expect(result.data).toMatchObject({
        status: 'ambiguous',
        availableSystems: ['kafka', 'nats', 'unknown'],
      });
    });

    it('does not compose alias hops transitively', async () => {
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:1',
            callerName: 'publishA',
            filePath: 'a.ts',
            startLine: 1,
            system: 'kafka',
            destination: 'alpha',
            destinationRef: 'beta',
          },
          {
            id: 'b:external_call:1',
            callerName: 'publishB',
            filePath: 'b.ts',
            startLine: 2,
            system: 'kafka',
            destination: 'beta',
            destinationRef: 'gamma',
          },
          {
            id: 'c:external_call:1',
            callerName: 'publishC',
            filePath: 'c.ts',
            startLine: 3,
            system: 'kafka',
            destination: 'gamma',
            destinationRef: 'delta',
          },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'a-svc', parserVersion: '1.1.0' },
          { hash: 'b', name: 'b-svc', parserVersion: '1.1.0' },
          { hash: 'c', name: 'c-svc', parserVersion: '1.1.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'alpha' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      const data = result.data as { producers: { caller: string }[] };
      expect(data.producers.map((p) => p.caller)).toEqual(['publishA']);
    });

    // The repository infers the system from a legacy Kafka-shaped row's own
    // serviceName, so a staged fleet still joins without borrowing the consumer's
    // system as evidence.
    it('joins a legacy producer after the repository infers its persisted system', async () => {
      const queueEntrypoint = createMockEntrypointInfo({
        id: 'c:entrypoint:orders',
        type: 'queue',
        system: 'kafka',
        destination: 'user.created',
        handlerName: 'consumeUserCreated',
      });
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:legacy',
            callerName: 'publishLegacy',
            filePath: 'a.ts',
            startLine: 1,
            system: 'kafka',
            destination: 'user.created',
          },
        ]),
        listEntrypoints: vi.fn((params: { type?: string }) =>
          Promise.resolve(params.type === 'queue' ? [queueEntrypoint] : []),
        ),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'legacy-producer', parserVersion: '1.1.0' },
          { hash: 'c', name: 'new-consumer', parserVersion: '1.1.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'user.created' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(result.data).toMatchObject({
        status: 'matched',
        system: 'kafka',
        producers: [{ caller: 'publishLegacy' }],
        consumers: [{ handler: 'consumeUserCreated' }],
      });
    });

    // The producer side is stale this time. Same rule, mirrored: it is dropped rather
    // than borrowing the consumer's broker, so no `kafka` producer is invented.
    it('does not invent a broker for a stale producer row', async () => {
      const queueEntrypoint = createMockEntrypointInfo({
        id: 'c:entrypoint:orders',
        type: 'queue',
        system: 'kafka',
        destination: 'user.created',
        handlerName: 'consumeUserCreated',
      });
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:legacy',
            callerName: 'publishLegacy',
            filePath: 'a.ts',
            startLine: 1,
            destination: 'user.created',
          },
        ]),
        listEntrypoints: vi.fn((params: { type?: string }) =>
          Promise.resolve(params.type === 'queue' ? [queueEntrypoint] : []),
        ),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'legacy-producer', parserVersion: '1.0.0' },
          { hash: 'c', name: 'new-consumer', parserVersion: '1.1.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'user.created' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(result.data).toMatchObject({
        status: 'matched',
        system: 'kafka',
        producers: [],
        staleRepos: ['legacy-producer'],
        consumers: [{ handler: 'consumeUserCreated', system: 'kafka' }],
      });
    });

    it('does not carry aliases learned in one messaging system into another', async () => {
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:1',
            callerName: 'publishKafka',
            filePath: 'a.ts',
            startLine: 1,
            system: 'kafka',
            destination: 'orders.v1',
            destinationRef: 'Topics.ORDERS',
          },
          {
            id: 'b:external_call:1',
            callerName: 'publishNats',
            filePath: 'b.ts',
            startLine: 2,
            system: 'nats',
            destination: 'billing',
            destinationRef: 'orders.v1',
          },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: 'a', name: 'producer-a', parserVersion: '1.1.0' },
          { hash: 'b', name: 'producer-b', parserVersion: '1.1.0' },
        ]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'Topics.ORDERS' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(result.data).toMatchObject({
        status: 'matched',
        system: 'kafka',
        producers: [{ caller: 'publishKafka' }],
      });
    });

    it('filters by normalized system and preserves case-sensitive destination matching', async () => {
      const queueEntrypoint = createMockEntrypointInfo({
        id: 'c:entrypoint:orders',
        type: 'queue',
        system: 'gcp-pubsub',
        destination: 'Topics.ORDERS',
        handlerName: 'consumeOrders',
      });
      const listEntrypoints = vi.fn((params: { type?: string }) =>
        Promise.resolve(params.type === 'queue' ? [queueEntrypoint] : []),
      );
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'p:external_call:orders',
            callerName: 'publishOrders',
            filePath: 'producer.ts',
            startLine: 3,
            system: 'gcp-pubsub',
            destination: 'Orders',
            destinationRef: 'Topics.ORDERS',
          },
        ]),
        listEntrypoints,
        getRepositoryNames: vi.fn().mockResolvedValue([{ hash: 'c', name: 'consumer', parserVersion: '1.1.0' }]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'Orders', system: ' GCP-PUBSUB ' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(result.data).toMatchObject({
        status: 'matched',
        system: 'gcp-pubsub',
        producers: [{ caller: 'publishOrders', destination: 'Orders' }],
        consumers: [{ handler: 'consumeOrders', destination: 'Topics.ORDERS' }],
      });

      const wrongCase = await handleTraceCrossRepoCall(
        { destination: 'orders', system: 'gcp-pubsub' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(wrongCase.data).toMatchObject({ status: 'not-found' });
    });

    it('surfaces legacy systemless rows under the reserved unknown system', async () => {
      const mockRepo = createMockRepository({
        getExternalCallsWithMessaging: vi.fn().mockResolvedValue([
          {
            id: 'a:external_call:legacy',
            callerName: 'publishLegacy',
            filePath: 'a.ts',
            startLine: 1,
            destination: 'legacy-events',
          },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getRepositoryNames: vi.fn().mockResolvedValue([{ hash: 'a', name: 'legacy-producer', parserVersion: '1.1.0' }]),
      });

      const result = await handleTraceCrossRepoCall(
        { destination: 'legacy-events', system: 'unknown' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      expect(result.data).toMatchObject({
        status: 'matched',
        system: 'unknown',
        producers: [{ caller: 'publishLegacy', system: 'unknown' }],
      });
    });
  });

  // ===========================================================================
  // Basic Functionality Tests
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should find cross-repo call by pattern matching entrypoint', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:GET:/api/users/:id',
            type: 'http',
            method: 'GET',
            path: '/api/users/:id',
            fullPath: 'GET /api/users/:id',
            handlerId: 'xyz789:function:src/controllers/user.controller.ts:getUser',
            handlerName: 'getUser',
            filePath: 'src/controllers/user.controller.ts',
            startLine: 42,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/api/users' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toBeDefined();
      const data = result.data as CrossRepoCallResult;
      expect(data.target.entrypoint).toBeDefined();
      expect(data.target.entrypoint.handlerName).toBe('getUser');
    });

    it('should find cross-repo call by pattern with method', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:POST:/api/data',
            type: 'http',
            method: 'POST',
            path: '/api/data',
            fullPath: 'POST /api/data',
            handlerId: 'xyz789:function:src/controllers/data.ts:createData',
            handlerName: 'createData',
            filePath: 'src/routes/data.ts',
            startLine: 15,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'POST /api/data' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.target.entrypoint).toBeDefined();
      expect(data.target.entrypoint.method).toBe('POST');
      expect(data.target.entrypoint.path).toBe('/api/data');
      expect(data.target.entrypoint.handlerName).toBe('createData');
    });

    it('should match callPattern via external_calls when scope is the origin (no local entrypoint)', async () => {
      // Regression test for the 2026-05-12 eval: scope was the UI repo
      // (no HTTP entrypoints), pattern matched an outbound external_call,
      // but the previous "entrypoint-first" logic returned "No cross-repo
      // calls found" and the agent had to fall back to Grep.
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'ec1',
            callerId: 'ui:fn:templates.service.ts:analyzeApplyTemplate',
            callerName: 'analyzeApplyTemplate',
            callerFilePath: 'src/components/Shifts/api/services/templates.service.ts',
            serviceName: 'server-api',
            method: 'request',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate:
              '/shifts/companies/{companyUuid}/planning_spaces/{planningSpaceUuid}/templates/apply-from-source/analyze-conflicts',
            filePath: 'src/components/Shifts/api/services/templates.service.ts',
            startLine: 62,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        {
          callPattern:
            'POST /shifts/companies/{companyUuid}/planning_spaces/{planningSpaceUuid}/templates/apply-from-source/analyze-conflicts',
        },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      // Caller side resolved from external_call even though no entrypoint
      // matches in this scope.
      expect(data.caller.function.name).toBe('analyzeApplyTemplate');
      expect(data.target.repo).toBe('server-api');
      expect(data.summary).toContain('analyze-conflicts');
    });

    it('should match callPattern with placeholder-name drift between agent and graph', async () => {
      // Agent calls with `{companyUuid}` (camelCase) but the parser indexed
      // `{company_uuid}` (snake_case). Without placeholder normalization,
      // substring matching fails. With it, the call lines up.
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'ec2',
            callerId: 'ui:fn:foo.ts:getThing',
            callerName: 'getThing',
            callerFilePath: 'src/foo.ts',
            serviceName: 'svc-x',
            method: 'request',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/things/{thing_id}',
            filePath: 'src/foo.ts',
            startLine: 1,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /things/{thingId}' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      const data = result.data as CrossRepoCallResult;
      expect(data.caller.function.name).toBe('getThing');
      expect(data.target.repo).toBe('svc-x');
    });

    it('names the resolved repo in the summary when the call carries no service name', async () => {
      // Swift/Kotlin shape: empty serviceName, no targetService, and the target
      // entrypoint is out of scope so no repo can be derived from it. Without the
      // resolved repo name the summary reads "outbound call to ``".
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'ec-swift',
            callerId: 'ui:fn:OrdersClient.swift:loadOrders',
            callerName: 'loadOrders',
            callerFilePath: 'src/OrdersClient.swift',
            serviceName: '',
            resolvedTargetId: 'bbb222:entrypoint:02-orders',
            resolvedTargetRepoName: 'orders-service',
            method: 'request',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/orders',
            filePath: 'src/OrdersClient.swift',
            startLine: 1,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /orders' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.target.repo).toBe('orders-service');
      expect(data.summary).toContain('`orders-service`');
      expect(data.summary).not.toContain('``');
    });

    it('does not pick a degenerate `/` path over the correct longer path', async () => {
      // Regression for the 2026-05-13 eval: the parser emits some external_calls
      // with `pathTemplate: "/"` (e.g. when the URL arg is a bare baseUrl
      // constant). The previous bidirectional substring matcher made "/" match
      // every agent query because every path starts with "/". The matcher
      // grabbed those degenerate calls first (no resolvedTargetId) and the
      // tool reported "downstream entrypoint unresolved" even when a correct
      // long-path call with resolvedTargetId existed in the same scope.
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([
          // Degenerate call — appears first, no resolution
          {
            id: 'ec-junk',
            callerId: 'usePatternsApi',
            callerName: 'usePatternsApi',
            callerFilePath: 'src/x.ts',
            serviceName: 'server-api',
            method: 'request',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate: '/',
            filePath: 'src/x.ts',
            startLine: 1,
          },
          // Correct call — should win
          {
            id: 'ec-good',
            callerId: 'analyzeApplyTemplate',
            callerName: 'analyzeApplyTemplate',
            callerFilePath: 'src/templates.service.ts',
            serviceName: 'server-api',
            method: 'request',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate: '/shifts/companies/{companyUuid}/templates/apply-from-source/analyze-conflicts',
            resolvedTargetId:
              'gw:entrypoint:x:POST:/v3/public/api-gateway/shifts/companies/{companyUuid}/templates/apply-from-source/analyze-conflicts',
            filePath: 'src/templates.service.ts',
            startLine: 62,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'POST /shifts/companies/{companyUuid}/templates/apply-from-source/analyze-conflicts' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      const data = result.data as CrossRepoCallResult;
      // Must match the resolved, full-length call — not the "/" decoy
      expect(data.caller.function.name).toBe('analyzeApplyTemplate');
    });

    it('uses resolvedTargetId to fetch the downstream entrypoint cross-scope', async () => {
      // Regression for the 2026-05-12 eval: the resolver had already linked
      // the outbound call to a gateway entrypoint in another repo, but the
      // tool was re-searching by path within the CURRENT scope, missed the
      // gateway, and reported 'target entrypoint not found'.
      const listEntrypoints = vi.fn();
      // First call: id-filtered lookup for the resolvedTargetId across all
      // repos (empty scope). Returns the gateway entrypoint.
      listEntrypoints.mockImplementationOnce(async (params: Record<string, unknown>) => {
        expect(params.id).toBe('gw-hash:entrypoint:src/x.ts:POST:/v3/public/api-gateway/foo');
        return [
          createMockEntrypointInfo({
            id: 'gw-hash:entrypoint:src/x.ts:POST:/v3/public/api-gateway/foo',
            type: 'http',
            method: 'POST',
            path: '/foo',
            fullPath: '/v3/public/api-gateway/foo',
            handlerName: 'fooHandler',
            filePath: 'src/x.ts',
            startLine: 1,
          }),
        ];
      });

      const mockRepo = createMockRepository({
        listEntrypoints,
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'ec1',
            callerId: 'ui:fn',
            callerName: 'callFoo',
            callerFilePath: 'src/ui.ts',
            serviceName: 'server-api', // virtual; not a real repo name
            method: 'request',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate: '/foo',
            resolvedTargetId: 'gw-hash:entrypoint:src/x.ts:POST:/v3/public/api-gateway/foo',
            filePath: 'src/ui.ts',
            startLine: 1,
          },
        ]),
        // getRepoOverview maps a repo hash to its real name. Called for both the
        // target entrypoint's hash ('gw-hash') and the caller's hash ('ui').
        getRepoOverview: vi.fn().mockImplementation(async (hashes: string[]) => {
          const names: Record<string, string> = { 'gw-hash': 'packages', ui: 'ui-app' };
          return hashes.map((h) => ({
            name: names[h] ?? h,
            type: 'backend',
            parsedAt: '',
            fileCount: 0,
            functionCount: 0,
            classCount: 0,
            entityCount: 0,
            entrypointTypes: ['http'],
          }));
        }),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'POST /foo' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      const data = result.data as CrossRepoCallResult;
      // Downstream entrypoint reached via resolvedTargetId
      expect(data.target.entrypoint).toBeDefined();
      expect(data.target.entrypoint.handlerName).toBe('fooHandler');
      // And the target repo is the REAL repo, not the virtual serviceName
      expect(data.target.repo).toBe('packages');
      // Caller repo is derived from the caller's OWN node-id hash ('ui'), not
      // scope.resolvedRepos[0] — regression for the api-server-reported-as-web-app bug.
      expect(data.caller.repo).toBe('ui-app');
    });
  });

  // ===========================================================================
  // Entrypoint Resolution Tests
  // ===========================================================================

  describe('Entrypoint Resolution', () => {
    it('should resolve HTTP entrypoint with method and path', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:POST:/api/data',
            type: 'http',
            method: 'POST',
            path: '/api/data',
            fullPath: 'POST /api/data',
            handlerId: 'xyz789:function:src/controllers/data.ts:createData',
            handlerName: 'createData',
            filePath: 'src/routes/data.ts',
            startLine: 15,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'POST /api/data' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.target.entrypoint).toBeDefined();
      expect(data.target.entrypoint.method).toBe('POST');
      expect(data.target.entrypoint.path).toBe('/api/data');
      expect(data.target.entrypoint.handlerName).toBe('createData');
    });

    it('should resolve entrypoint with path only (no method)', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:POST:/webhooks/stripe',
            type: 'http',
            method: 'POST',
            path: '/webhooks/stripe',
            fullPath: 'POST /webhooks/stripe',
            handlerId: 'xyz789:function:src/webhooks.ts:handleStripe',
            handlerName: 'handleStripe',
            filePath: 'src/webhooks.ts',
            startLine: 8,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/webhooks/stripe' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.target.entrypoint).toBeDefined();
      expect(data.target.entrypoint.handlerName).toBe('handleStripe');
    });

    it('should handle entrypoint not found', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/unknown/endpoint' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('No cross-repo calls found');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle no cross-repo calls found', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { targetService: 'nonexistent-service' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('No cross-repo calls found');
    });

    // Was `toEqual({})`. The intent — raw mode returns a machine shape, never prose —
    // still holds and is asserted below; the bare `{}` did not. It carried no reason,
    // which is the same defect the argument guards were fixed for ("a bad argument must
    // not travel as an exception… the reason has to be IN the payload"), and it silently
    // dropped the workspace-boundary note computed on this very path.
    it('returns a machine shape carrying the reason in raw mode when no calls found', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { targetService: 'nonexistent-service' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('object');
      expect(result.data).toMatchObject({ found: false, target: { pattern: 'nonexistent-service' } });
    });

    it('should use first entrypoint if multiple matches', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:GET:/api/users',
            type: 'http',
            method: 'GET',
            path: '/api/users',
            fullPath: 'GET /api/users',
            handlerId: 'xyz789:function:src/controllers/user.ts:getUsers',
            handlerName: 'getUsers',
            filePath: 'src/controllers/user.ts',
            startLine: 10,
          }),
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:POST:/api/users',
            type: 'http',
            method: 'POST',
            path: '/api/users',
            fullPath: 'POST /api/users',
            handlerId: 'xyz789:function:src/controllers/user.ts:createUser',
            handlerName: 'createUser',
            filePath: 'src/controllers/user.ts',
            startLine: 30,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/api/users' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      // Should use first match
      expect(data.target.entrypoint.handlerName).toBe('getUsers');
    });
  });

  // ===========================================================================
  // Output Format Tests
  // ===========================================================================

  describe('Output Formats', () => {
    it('should format output as text when format is summary', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:GET:/api/data',
            type: 'http',
            method: 'GET',
            path: '/api/data',
            fullPath: 'GET /api/data',
            handlerId: 'xyz789:function:src/data.controller.ts:getData',
            handlerName: 'getData',
            filePath: 'src/data.controller.ts',
            startLine: 20,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/api/data' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Cross-Repo Call Trace');
      expect(result.data).toContain('getData');
      expect(result.metadata.format).toBe('summary');
      // full detail → nothing to escalate to
      expect(result.data).not.toContain(DETAIL_ESCALATION_HINT);
    });

    it('ends a basic summary trace with the full-detail re-call hint', async () => {
      // trace_cross_repo_call is basic-by-default, so its default rendering must
      // name the re-call that restores summaries/refs.
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:GET:/api/data',
            type: 'http',
            method: 'GET',
            path: '/api/data',
            fullPath: 'GET /api/data',
            handlerId: 'xyz789:function:src/data.controller.ts:getData',
            handlerName: 'getData',
            filePath: 'src/data.controller.ts',
            startLine: 20,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/api/data' },
        mockScope,
        'summary',
        'basic',
        resolveDetailLevel('basic'),
        mockRepo,
      );

      expect((result.data as string).trimEnd().endsWith(DETAIL_ESCALATION_HINT)).toBe(true);
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:GET:/api/test',
            type: 'http',
            method: 'GET',
            path: '/api/test',
            fullPath: 'GET /api/test',
            handlerId: 'xyz789:function:src/test.ts:handler',
            handlerName: 'handler',
            filePath: 'src/test.ts',
            startLine: 10,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/api/test' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('object');
      const data = result.data as CrossRepoCallResult;
      expect(data.caller).toBeDefined();
      expect(data.target).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Summary Generation Tests
  // ===========================================================================

  describe('Summary Generation', () => {
    it('should generate summary with handler info', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:GET:/data',
            type: 'http',
            method: 'GET',
            path: '/data',
            fullPath: 'GET /data',
            handlerId: 'xyz789:function:src/handler.ts:handleGet',
            handlerName: 'handleGet',
            filePath: 'src/handler.ts',
            startLine: 5,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/data' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.summary).toContain('handleGet');
      expect(data.summary).toContain('src/handler.ts');
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { targetService: 'test' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.scope).toEqual(mockScope);
    });

    it('should include staleness info in metadata', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { targetService: 'test' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.staleness).toBeDefined();
      expect(result.metadata.staleness.warning).toBe('Data reflects parsed stable branch, not local changes');
      expect(result.metadata.staleness.parsedAt).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should include format in metadata', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const summaryResult = await handleTraceCrossRepoCall(
        { targetService: 'test' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(summaryResult.metadata.format).toBe('summary');

      const rawResult = await handleTraceCrossRepoCall(
        { targetService: 'test' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(rawResult.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Cross-Repo Scope Tests
  // ===========================================================================

  describe('Cross-Repo Scope', () => {
    it('should work with cross-repo enabled scope', async () => {
      const crossRepoScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['service-a', 'service-b'],
        repoHashes: ['abc123', 'def456'],
        crossRepoEnabled: true,
        project: 'test-group',
      };

      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'def456:entrypoint:http:GET:/api/data',
            type: 'http',
            method: 'GET',
            path: '/api/data',
            fullPath: 'GET /api/data',
            handlerId: 'def456:function:src/handler.ts:getData',
            handlerName: 'getData',
            filePath: 'src/handler.ts',
            startLine: 10,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/api/data' },
        crossRepoScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
      expect(result.metadata.scope.project).toBe('test-group');
    });
  });

  // ===========================================================================
  // Multi-hop Chain Provenance Tests
  // ===========================================================================

  describe('Multi-hop chain provenance', () => {
    it('renders the stored chain when a matched call resolves via a multi-hop edge', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'h-web:external_call:src/api.ts:fetchUser:1',
            callerId: 'fn-1',
            callerName: 'fetchUser',
            callerFilePath: 'src/api.ts',
            serviceName: 'usersApi',
            method: 'getById',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/users/{id}',
            resolvedTargetId: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
            filePath: 'src/api.ts',
            startLine: 5,
          },
        ]),
        getResolvesEdge: vi.fn().mockResolvedValue({
          id: 'resolve:h-web:external_call:src/api.ts:fetchUser:1:h-users:entrypoint:src/users.ts:GET:/users/:id',
          sourceId: 'h-web:external_call:src/api.ts:fetchUser:1',
          targetId: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
          confidence: 1,
          via: 'http',
          sourceRepoName: 'web',
          targetRepoName: 'users-svc',
          confidenceLevel: 'exact',
          chain: [
            {
              kind: 'symbol',
              sourceId: 'h-web:external_call:src/api.ts:fetchUser:1',
              targetId: 'h-sdk:function:src/client.ts:getById',
              via: 'moniker',
              confidence: 1,
            },
            {
              kind: 'protocol',
              sourceId: 'h-sdk:function:src/client.ts:getById',
              targetId: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
              via: 'http',
              confidence: 1,
            },
          ],
        }),
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
            type: 'http',
            method: 'GET',
            path: '/users/:id',
            fullPath: '/users/:id',
            handlerName: 'getUser',
            filePath: 'src/users.ts',
          }),
        ]),
        getRepoOverview: vi.fn().mockResolvedValue([{ name: 'users-svc' }]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /users/{id}' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.getResolvesEdge).toHaveBeenCalledWith('h-web:external_call:src/api.ts:fetchUser:1');
      const data = result.data as { chain?: Array<{ via: string; kind: string }> };
      expect(data.chain).toHaveLength(2);
      expect(data.chain![0]).toMatchObject({ kind: 'symbol', via: 'moniker' });
      expect(data.chain![1]).toMatchObject({ kind: 'protocol', via: 'http' });
    });

    it('renders the chain hops in the text summary', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'h-web:external_call:src/api.ts:fetchUser:1',
            callerId: 'fn-1',
            callerName: 'fetchUser',
            callerFilePath: 'src/api.ts',
            serviceName: 'usersApi',
            method: 'getById',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/users/{id}',
            resolvedTargetId: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
            filePath: 'src/api.ts',
            startLine: 5,
          },
        ]),
        getResolvesEdge: vi.fn().mockResolvedValue({
          id: 'resolve:x',
          sourceId: 'h-web:external_call:src/api.ts:fetchUser:1',
          targetId: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
          confidence: 1,
          via: 'http',
          chain: [
            { kind: 'symbol', sourceId: 'a', targetId: 'b', via: 'moniker', confidence: 1 },
            { kind: 'protocol', sourceId: 'b', targetId: 'c', via: 'http', confidence: 1 },
          ],
        }),
        listEntrypoints: vi
          .fn()
          .mockResolvedValue([
            createMockEntrypointInfo({ id: 'h-users:entrypoint:src/users.ts:GET:/users/:id', handlerName: 'getUser' }),
          ]),
        getRepoOverview: vi.fn().mockResolvedValue([{ name: 'users-svc' }]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /users/{id}' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Resolution Chain');
      expect(result.data).toContain('moniker');
    });

    it('falls back to single-hop when getResolvesEdge is absent', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'h-web:external_call:src/api.ts:fetchUser:1',
            callerId: 'fn-1',
            callerName: 'fetchUser',
            callerFilePath: 'src/api.ts',
            serviceName: 'usersApi',
            method: 'getById',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/users/{id}',
            resolvedTargetId: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
            filePath: 'src/api.ts',
            startLine: 5,
          },
        ]),
        listEntrypoints: vi
          .fn()
          .mockResolvedValue([
            createMockEntrypointInfo({ id: 'h-users:entrypoint:src/users.ts:GET:/users/:id', handlerName: 'getUser' }),
          ]),
        getRepoOverview: vi.fn().mockResolvedValue([{ name: 'users-svc' }]),
      });
      // Simulate a backend without the optional method.
      (mockRepo as { getResolvesEdge?: unknown }).getResolvesEdge = undefined;
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /users/{id}' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );
      const data = result.data as { chain?: unknown; target: { entrypoint?: unknown } };
      expect(data.chain).toBeUndefined();
      expect(data.target.entrypoint).toBeDefined();
    });
  });

  // Shapes copied from a pilot workspace graph, where 7/7 eval calls returned either
  // "No cross-repo calls found" or a self-referential hop with a null caller
  // while the RESOLVES_TO edge was present the whole time.
  describe('resolved bridge whose caller is outside the requested scope', () => {
    const ADMIN = 'a67becf9cdc1';
    const API = 'bb82e4cc3513';
    const CALCULATIONS = '9ff436afb359';

    // Real row: the client builds `…/superbooking_groups${paramStr}`, so the
    // query-string builder is stored as a placeholder glued to the last segment.
    const adminCall = createMockExternalCallInfo({
      id: `${ADMIN}:external-call:${ADMIN}:function:src/utils/api/company.ts:getSuperbookingGroupsData:GET:687`,
      callerId: `${ADMIN}:function:src/utils/api/company.ts:getSuperbookingGroupsData`,
      callerName: 'getSuperbookingGroupsData',
      callerFilePath: 'src/utils/api/company.ts',
      serviceName: 'acme-backend',
      targetService: 'client-admin-api',
      method: 'GET',
      protocol: 'http',
      httpMethod: 'GET',
      pathTemplate: '/companies/{companyUUID}/superbooking_groups{paramStr}',
      resolvedTargetId: `${API}:entrypoint:http:2b2ab6d5`,
      messagingSystem: undefined,
      messagingDestination: undefined,
      filePath: 'src/utils/api/company.ts',
      startLine: 687,
    });

    const apiEntrypoint = createMockEntrypointInfo({
      id: `${API}:entrypoint:http:2b2ab6d5`,
      handlerId: `${API}:function:app/handlers/controllers/reports-controller.js:getSuperBookingGroups`,
      handlerName: 'getSuperBookingGroups',
      method: 'GET',
      path: '/companies/{companyUuid}/superbooking_groups',
      fullPath: '/v2/public/client_admin_api/companies/{companyUuid}/superbooking_groups',
      filePath: 'app/initializers/create-koa-router.js',
      startLine: 136,
    });

    /** Scoped to a repo that is NEITHER side of the bridge, as the eval was. */
    const scopedElsewhere: ScopeContext = {
      currentPath: '/repos/acme-calculations',
      resolvedRepos: ['acme-calculations'],
      repoHashes: [CALCULATIONS],
      crossRepoEnabled: true,
      project: 'acme',
      origin: 'local',
    };

    function bridgeRepository(overrides?: Parameters<typeof createMockRepository>[0]) {
      return createMockRepository({
        // Empty for the in-scope hashes, populated for the whole-graph scan.
        getExternalCalls: vi
          .fn()
          .mockImplementation(async (repoHashes: string[]) => (repoHashes.length === 0 ? [adminCall] : [])),
        listEntrypoints: vi
          .fn()
          .mockImplementation(async (params: { id?: string }) => (params.id ? [apiEntrypoint] : [])),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: ADMIN, name: 'acme-admin' },
          { hash: API, name: 'acme-client-admin-api' },
        ]),
        getRepoOverview: vi.fn().mockImplementation(async (hashes: string[]) => {
          const names: Record<string, string> = { [ADMIN]: 'acme-admin', [API]: 'acme-client-admin-api' };
          const name = names[hashes[0] ?? ''];
          return name ? [{ name }] : [];
        }),
        ...overrides,
      });
    }

    it('returns the caller-side repo and the resolved target for an HTTP path pattern', async () => {
      const mockRepo = bridgeRepository();

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /companies/{companyUuid}/superbooking_groups' },
        scopedElsewhere,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.caller.repo).toBe('acme-admin');
      expect(data.caller.function.name).toBe('getSuperbookingGroupsData');
      expect(data.target.repo).toBe('acme-client-admin-api');
      expect(data.target.entrypoint?.handlerName).toBe('getSuperBookingGroups');
      // The answer came from outside the asked-for scope; say so.
      expect(data.scopeNote).toContain('acme-calculations');
      expect(data.scopeNote).toContain('acme-admin');
    });

    // `getSuperBookingGroups` is the HANDLER name — it appears on the entrypoint,
    // never on the caller's external_call row, whose `method` is just `GET`.
    it('resolves a handler-name token by walking RESOLVES_TO backwards', async () => {
      const handlerFunction = {
        id: `${API}:function:app/handlers/controllers/reports-controller.js:getSuperBookingGroups`,
        name: 'getSuperBookingGroups',
        type: 'function',
        filePath: 'app/handlers/controllers/reports-controller.js',
        startLine: 249,
      };
      const mockRepo = bridgeRepository({
        findCode: vi.fn().mockResolvedValue([handlerFunction]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([apiEntrypoint]),
      });

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'getSuperBookingGroups' },
        scopedElsewhere,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.caller.repo).toBe('acme-admin');
      expect(data.caller.function.name).toBe('getSuperbookingGroupsData');
      expect(data.target.repo).toBe('acme-client-admin-api');
      expect(data.target.entrypoint?.id).toBe(`${API}:entrypoint:http:2b2ab6d5`);
    });

    it('names the other bridges the same handler token matched', async () => {
      const otherCall = createMockExternalCallInfo({
        id: `${CALCULATIONS}:external-call:src/sdk.ts:getSuperBookingGroups:GET:63`,
        callerId: `${CALCULATIONS}:function:src/sdk.ts:getSuperBookingGroups`,
        callerName: 'getSuperBookingGroups',
        callerFilePath: 'src/sdk.ts',
        serviceName: 'calculations',
        method: 'getSuperBookingGroups',
        protocol: 'http',
        httpMethod: 'GET',
        pathTemplate: '/companies/{companyUuid}/superbooking_groups',
        resolvedTargetId: `${API}:entrypoint:http:2b2ab6d5`,
        messagingSystem: undefined,
        messagingDestination: undefined,
        filePath: 'src/sdk.ts',
        startLine: 63,
      });
      const mockRepo = bridgeRepository({
        getExternalCalls: vi
          .fn()
          .mockImplementation(async (repoHashes: string[]) =>
            repoHashes.length === 0 ? [adminCall, otherCall] : [otherCall],
          ),
        getRepositoryNames: vi.fn().mockResolvedValue([
          { hash: ADMIN, name: 'acme-admin' },
          { hash: API, name: 'acme-client-admin-api' },
          { hash: CALCULATIONS, name: 'acme-calculations' },
        ]),
        getRepoOverview: vi.fn().mockImplementation(async (hashes: string[]) => {
          const names: Record<string, string> = {
            [ADMIN]: 'acme-admin',
            [API]: 'acme-client-admin-api',
            [CALCULATIONS]: 'acme-calculations',
          };
          const name = names[hashes[0] ?? ''];
          return name ? [{ name }] : [];
        }),
      });

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /companies/{companyUuid}/superbooking_groups' },
        scopedElsewhere,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      // The in-scope caller answers the scoped question and wins…
      expect(data.caller.repo).toBe('acme-calculations');
      // …but the out-of-scope bridge is named, with both repos.
      expect(data.alternatives).toEqual([
        expect.objectContaining({
          caller: 'getSuperbookingGroupsData',
          callerRepo: 'acme-admin',
          targetRepo: 'acme-client-admin-api',
        }),
      ]);
    });

    // A cloud workspace scope enumerates the connected repos and the store can
    // hold rows outside them: the boundary holds, and the emptiness is labelled
    // as a boundary rather than as "nothing calls this".
    it('never widens past a workspace-resolved scope', async () => {
      const mockRepo = bridgeRepository();

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /companies/{companyUuid}/superbooking_groups' },
        { ...scopedElsewhere, origin: 'workspace' },
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.caller?.repo).not.toBe('acme-admin');
      const externalCallScans = (mockRepo.getExternalCalls as Mock).mock.calls;
      expect(externalCallScans.every(([hashes]: [string[]]) => hashes.length > 0)).toBe(true);
    });

    // A `scope` argument narrows a workspace scope to one repo; the bridge's other
    // side is still a connected repo and must be reachable.
    it('widens a narrowed workspace scope to the connected repos only', async () => {
      const connected = [CALCULATIONS, ADMIN, API];
      const mockRepo = bridgeRepository({
        getExternalCalls: vi
          .fn()
          .mockImplementation(async (repoHashes: string[]) => (repoHashes.includes(ADMIN) ? [adminCall] : [])),
      });

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /companies/{companyUuid}/superbooking_groups' },
        { ...scopedElsewhere, origin: 'workspace', workspaceRepoHashes: connected },
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.caller.repo).toBe('acme-admin');
      expect(data.target.repo).toBe('acme-client-admin-api');
      const externalCallScans = (mockRepo.getExternalCalls as Mock).mock.calls;
      expect(externalCallScans.every(([hashes]: [string[]]) => hashes.every((h) => connected.includes(h)))).toBe(true);
    });

    it('matches a pathTemplate whose query-string builder is glued to the last segment', async () => {
      const mockRepo = bridgeRepository();

      const result = await handleTraceCrossRepoCall(
        // No method prefix, and the placeholder is spelled differently than the
        // stored `{companyUUID}` — both normal agent drift.
        { callPattern: '/companies/{company_uuid}/superbooking_groups' },
        scopedElsewhere,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.caller.function.name).toBe('getSuperbookingGroupsData');
    });

    // The linker collapses `{x}` / `${x}` / `:x` to one token; this tool must too,
    // or an Express-spelled pattern misses the bridge the linker built.
    it('matches an Express-style `:param` pattern against a `{param}` pathTemplate', async () => {
      const mockRepo = bridgeRepository();

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /companies/:companyUuid/superbooking_groups' },
        scopedElsewhere,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.caller.function.name).toBe('getSuperbookingGroupsData');
    });
  });

  // Each of these covers a REFUSAL-or-hedge branch that shipped untested: the tool
  // answering honestly about what it could not determine. They are the difference
  // between "this endpoint is unused" and "I could not see the caller".
  describe('honesty branches', () => {
    it('labels a workspace-scope no-match as a boundary, not "nothing calls this"', async () => {
      const mockRepo = createMockRepository({
        // The endpoint is nowhere, and no external call resolves to it, so the
        // only fact left is the shape of the scope that was searched.
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /orders' },
        { ...mockScope, origin: 'workspace' } as ScopeContext,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.scopeNote).toMatch(/workspace boundary/i);
      expect(data.scopeNote).toMatch(/not[\s\S]*evidence that nothing calls this endpoint/i);
      // The raw shape must still carry a reason — a bare `{}` tells the caller nothing.
      expect(data).toMatchObject({ found: false });
    });

    it('carries the boundary note in the summary format too', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /orders' },
        { ...mockScope, origin: 'workspace' } as ScopeContext,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('No cross-repo calls found');
      expect(result.data).toMatch(/workspace boundary/i);
    });

    it('does not claim a boundary when the scope was not workspace-resolved', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /orders' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).not.toMatch(/workspace boundary/i);
    });

    it('discloses that a same-pattern target was a pick, not a trace', async () => {
      // Three services expose an endpoint on this path and NOTHING resolves to any
      // of them, so the only ordering is in-scope-first — i.e. DB order among the
      // rest. Naming one without a hedge is the failure this note exists to stop.
      const twins = ['orders-api', 'billing-api', 'legacy-api'].map((repo, i) =>
        createMockEntrypointInfo({
          id: `hash${i}:entrypoint:http:GET:/v1/report`,
          handlerId: `hash${i}:function:src/${repo}.ts:getReport`,
          handlerName: 'getReport',
          filePath: `${repo}/src/report.ts`,
          path: '/v1/report',
          fullPath: '/v1/report',
        }),
      );
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue(twins),
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /v1/report' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as CrossRepoCallResult;
      expect(data.scopeNote).toMatch(/is a PICK, not a trace/);
      // The rejected candidates must be NAMED — a bare "this is ambiguous" leaves
      // the agent with nothing to disambiguate with.
      expect(data.scopeNote).toContain('billing-api/src/report.ts');
      expect(data.scopeNote).toContain('legacy-api/src/report.ts');
    });

    it('does not hedge when exactly one entrypoint matches', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi
          .fn()
          .mockResolvedValue([createMockEntrypointInfo({ path: '/v1/only', fullPath: '/v1/only' })]),
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /v1/only' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect((result.data as CrossRepoCallResult).scopeNote ?? '').not.toMatch(/PICK/);
    });
  });

  // The handler-token lookup fetches by SUBSTRING and then filters to the exact
  // name. Capping the fetch at the exact-match budget capped the wrong population:
  // for a short token the budget is spent on substring neighbours and the real
  // handler never appears in the page at all.
  describe('handler-token search', () => {
    it('finds the exactly-named handler behind a crowd of substring neighbours', async () => {
      const neighbours = Array.from({ length: 40 }, (_, i) => ({
        id: `h:function:src/n${i}.ts:createOrder${i}`,
        name: `createOrder${i}`,
        type: 'function',
        filePath: `src/n${i}.ts`,
        startLine: 1,
      }));
      const exactHandler = {
        id: 'h:function:src/real.ts:create',
        name: 'create',
        type: 'function',
        filePath: 'src/real.ts',
        startLine: 1,
      };
      const target = createMockEntrypointInfo({ handlerName: 'create', path: '/create' });

      const mockRepo = createMockRepository({
        // Substring neighbours come back FIRST — the ordering that used to evict
        // the real handler before the exact filter could see it.
        findCode: vi.fn().mockResolvedValue([...neighbours, exactHandler]),
        getReachingEntrypoints: vi.fn(async (id: string) => (id === exactHandler.id ? [target] : [])),
        listEntrypoints: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleTraceCrossRepoCall(
        { callPattern: 'create' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      // The exact match must have been the one whose entrypoints were resolved,
      // and no substring neighbour may have been followed.
      const reached = (mockRepo.getReachingEntrypoints as Mock).mock.calls.map(([id]: [string]) => id);
      expect(reached).toContain(exactHandler.id);
      expect(reached.some((id: string) => id.includes('createOrder'))).toBe(false);
    });
  });
});
