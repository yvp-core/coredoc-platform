/**
 * Tests for the get_service_dependencies tool handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { resetCoverageCaveatCache } from '../../coverage.js';
import { handleListServiceDependencies } from './list-service-dependencies.js';
import type { ScopeContext, ServiceDependencyResult } from '../../types.js';
import type { ExternalCallInfo } from '@coredoc/db';

// Mock database abstraction layer
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatServiceDependencies: vi.fn((dependencies, repoName, metadata) => {
    if (metadata.format === 'raw') {
      return { data: dependencies, metadata };
    }
    const summary = `## Service Dependencies for \`${repoName}\` (${dependencies.length})`;
    return { data: summary, metadata };
  }),
  createMetadata: vi.fn((scope, format) => ({
    scope,
    staleness: {
      warning: 'Data reflects parsed stable branch, not local changes',
      parsedAt: '2024-01-15T10:30:00.000Z',
    },
    format,
  })),
}));

// Import after mocks
import { getRepository } from '@coredoc/db';
import { createMockRepository, createMockCoverageCounts } from '../../__tests__/fixtures/mock-repository.js';

function createExternalCall(overrides: Partial<ExternalCallInfo> = {}): ExternalCallInfo {
  return {
    id: 'ext:1',
    callerId: 'fn:1',
    callerName: 'someMethod',
    callerFilePath: 'src/service.ts',
    serviceName: 'unknown',
    method: 'call',
    protocol: 'http',
    filePath: 'src/service.ts',
    startLine: 10,
    ...overrides,
  };
}

describe('get_service_dependencies Tool Handler', () => {
  let mockScope: ScopeContext;

  beforeEach(() => {
    // The caveat path memoizes counts module-wide — isolate each test's mock.
    resetCoverageCaveatCache();
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
  // Basic Functionality Tests
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should find external service dependencies from external_call nodes', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'user-service',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/api/users',
            method: 'getUsers',
          }),
          createExternalCall({
            serviceName: 'user-service',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate: '/api/users',
            method: 'createUser',
          }),
          createExternalCall({
            serviceName: 'payment-service',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate: '/api/charge',
            method: 'charge',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps.length).toBe(2);
      const serviceNames = deps.map((d) => d.service);
      expect(serviceNames).toContain('user-service');
      expect(serviceNames).toContain('payment-service');
    });

    it('should include call counts', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi
          .fn()
          .mockResolvedValue([
            createExternalCall({ serviceName: 'data-service', method: 'get' }),
            createExternalCall({ serviceName: 'data-service', method: 'put' }),
          ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      const dataDep = deps.find((d) => d.service === 'data-service');
      expect(dataDep).toBeDefined();
      expect(dataDep!.callCount).toBe(2);
    });

    it('names the repo a nameless call resolved to, and still drops the unresolved one', async () => {
      // Swift/Kotlin shape: the profile cannot name the callee service, so the
      // cross-repo link is the only source of a target name. The unresolved
      // sibling has neither, and must not become an `unknown` bucket.
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            id: 'ext:resolved',
            serviceName: '',
            resolvedTargetId: 'bbb222:entrypoint:02-orders',
            resolvedTargetRepoName: 'orders-service',
            method: 'loadOrders',
          }),
          createExternalCall({ id: 'ext:unresolved', serviceName: '', method: 'loadSomething' }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps.map((d) => d.service)).toEqual(['orders-service']);
      expect(deps[0]!.callCount).toBe(1);
      expect(deps[0]!.resolvedCount).toBe(1);
    });

    // A multi-target monorepo (or the intra-repo linker extension) resolves a call back into the
    // repo it was made from. That is an in-repo edge — listing the repo among the services it
    // depends on invents a dependency — while the cross-repo twin beside it must still be listed.
    it('drops a call that resolved back into the calling repo, and keeps the cross-repo one', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            id: 'abc123def456:external_call:self',
            serviceName: '',
            resolvedTargetId: 'abc123def456:entrypoint:01-own',
            resolvedTargetRepoName: 'api-service',
            method: 'loadOwnBackend',
          }),
          createExternalCall({
            id: 'abc123def456:external_call:cross',
            serviceName: '',
            resolvedTargetId: 'bbb222:entrypoint:02-orders',
            resolvedTargetRepoName: 'orders-service',
            method: 'loadOrders',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect((result.data as ServiceDependencyResult[]).map((d) => d.service)).toEqual(['orders-service']);
    });

    // A targetService that IS the calling repo is the same non-dependency, whatever wrote it.
    it('drops a call whose targetService names the calling repo', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi
          .fn()
          .mockResolvedValue([
            createExternalCall({ id: 'abc123def456:external_call:1', targetService: 'api-service' }),
          ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect(result.data as ServiceDependencyResult[]).toEqual([]);
    });

    // G-5: an empty-string targetService is a missing value, not a service named "".
    it('falls through an empty-string targetService to the resolved repo name', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            id: 'abc123def456:external_call:1',
            targetService: '   ',
            serviceName: '',
            resolvedTargetRepoName: 'orders-service',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect((result.data as ServiceDependencyResult[]).map((d) => d.service)).toEqual(['orders-service']);
    });

    it('keys on targetService, so one client label does not collapse the fan-out', async () => {
      // Shape taken from a real profile: every egress carries the same authored
      // `serviceName` label while `targetService` names the service actually called.
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({ serviceName: 'acme-backend', targetService: 'client-admin-api', method: 'GET' }),
          createExternalCall({ serviceName: 'acme-backend', targetService: 'client-admin-api', method: 'POST' }),
          createExternalCall({ serviceName: 'acme-backend', targetService: 'api-gateway', method: 'GET' }),
          // Legacy row: no targetService, so serviceName remains the key.
          createExternalCall({ serviceName: 'Sentry', method: 'captureException' }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps.map((d) => d.service).sort()).toEqual(['Sentry', 'api-gateway', 'client-admin-api']);
      expect(deps.find((d) => d.service === 'client-admin-api')!.callCount).toBe(2);
      expect(deps.map((d) => d.service)).not.toContain('acme-backend');
    });

    it('should detect messaging patterns', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'event-bus',
            protocol: 'messaging',
            messagingSystem: 'kafka',
            messagingDestination: 'user-events',
            method: 'produce',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps[0]!.service).toBe('event-bus');
      expect(deps[0]!.callTypes).toContain('messaging');
      expect(deps[0]!.patterns).toContain('messaging:kafka:user-events');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle no dependencies found', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('No external service dependencies detected');
    });

    it('should return empty array in raw mode when no dependencies', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect(result.data).toEqual([]);
    });

    it('should sort dependencies by call count', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi
          .fn()
          .mockResolvedValue([
            createExternalCall({ serviceName: 'high', method: 'a' }),
            createExternalCall({ serviceName: 'high', method: 'b' }),
            createExternalCall({ serviceName: 'high', method: 'c' }),
            createExternalCall({ serviceName: 'medium', method: 'a' }),
            createExternalCall({ serviceName: 'medium', method: 'b' }),
            createExternalCall({ serviceName: 'low', method: 'a' }),
          ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps.length).toBe(3);
      expect(deps[0]!.callCount).toBeGreaterThanOrEqual(deps[1]!.callCount);
      expect(deps[1]!.callCount).toBeGreaterThanOrEqual(deps[2]!.callCount);
    });

    it('should build human-readable patterns for HTTP calls', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'api',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate: '/api/orders',
            method: 'createOrder',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps[0]!.patterns).toContain('POST /api/orders');
    });

    it('should build human-readable patterns for gRPC calls', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'billing',
            protocol: 'grpc',
            grpcService: 'BillingService',
            grpcMethod: 'Charge',
            method: 'charge',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps[0]!.patterns).toContain('grpc:BillingService.Charge');
    });
  });

  // ===========================================================================
  // Output Format Tests
  // ===========================================================================

  describe('Output Formats', () => {
    it('should format output as text when format is summary', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([createExternalCall({ serviceName: 'backend', method: 'call' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Service Dependencies for `api-service`');
      expect(result.data).toContain('(1)');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi
          .fn()
          .mockResolvedValue([createExternalCall({ serviceName: 'backend', protocol: 'http', method: 'fetch' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect(Array.isArray(result.data)).toBe(true);
      const deps = result.data as ServiceDependencyResult[];
      expect(deps).toHaveLength(1);
      expect(deps[0]!.service).toBe('backend');
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect(result.metadata.scope).toEqual(mockScope);
    });

    it('should include staleness info in metadata', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect(result.metadata.staleness).toBeDefined();
      expect(result.metadata.staleness.warning).toBe('Data reflects parsed stable branch, not local changes');
      expect(result.metadata.staleness.parsedAt).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should include format in metadata', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const summaryResult = await handleListServiceDependencies(
        {},
        mockScope,
        'summary',
        undefined,
        undefined,
        mockRepo,
      );

      expect(summaryResult.metadata.format).toBe('summary');

      const rawResult = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect(rawResult.metadata.format).toBe('raw');
    });

    it('should use first repo name from scope', async () => {
      const multiRepoScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['service-a', 'service-b'],
        repoHashes: ['abc123', 'def456'],
        crossRepoEnabled: true,
        project: 'test-group',
      };

      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([createExternalCall({ serviceName: 'ext', method: 'call' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies(
        {},
        multiRepoScope,
        'summary',
        undefined,
        undefined,
        await getRepository(),
      );

      expect(result.data).toContain('service-a');
    });

    it('should handle unknown repo name gracefully', async () => {
      const unknownRepoScope: ScopeContext = {
        currentPath: '/test/unknown',
        resolvedRepos: [],
        repoHashes: [],
        crossRepoEnabled: false,
      };

      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies(
        {},
        unknownRepoScope,
        'summary',
        undefined,
        undefined,
        await getRepository(),
      );

      expect(result.data).toBeDefined();
    });
  });

  // ===========================================================================
  // Resolved-Edge Aggregation Tests
  // ===========================================================================

  describe('Resolved-edge aggregation', () => {
    it('reports resolvedCount per service from resolvedTargetId', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'user-service',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/api/users',
            method: 'getUsers',
            resolvedTargetId: 'h-users:entrypoint:src/users.ts:GET:/api/users',
          }),
          createExternalCall({
            serviceName: 'user-service',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate: '/api/users',
            method: 'createUser',
            // unresolved — no resolvedTargetId
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);
      const deps = result.data as ServiceDependencyResult[];
      const userSvc = deps.find((d) => d.service === 'user-service')!;
      expect(userSvc.callCount).toBe(2);
      expect(userSvc.resolvedCount).toBe(1);
    });

    it('renders grpc and graphql patterns (transformer fix delivers the fields)', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'billing',
            protocol: 'grpc',
            grpcService: 'BillingService',
            grpcMethod: 'Charge',
            method: 'charge',
          }),
          createExternalCall({
            serviceName: 'graph-api',
            protocol: 'graphql',
            graphqlOperationType: 'mutation',
            graphqlOperationName: 'createOrder',
            method: 'createOrder',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);
      const deps = result.data as ServiceDependencyResult[];
      const billing = deps.find((d) => d.service === 'billing')!;
      const graph = deps.find((d) => d.service === 'graph-api')!;
      expect(billing.patterns).toContain('grpc:BillingService.Charge');
      expect(graph.patterns).toContain('graphql:mutation createOrder');
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
        getExternalCalls: vi.fn().mockResolvedValue([createExternalCall({ serviceName: 'ext', method: 'call' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies(
        {},
        crossRepoScope,
        'raw',
        undefined,
        undefined,
        await getRepository(),
      );

      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
      expect(result.metadata.scope.project).toBe('test-group');
      expect(result.metadata.scope.repoHashes).toEqual(['abc123', 'def456']);
    });

    it('should work with single repo scope', async () => {
      const singleRepoScope: ScopeContext = {
        currentPath: '/test/single',
        resolvedRepos: ['single-service'],
        repoHashes: ['xyz789'],
        crossRepoEnabled: false,
      };

      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([createExternalCall({ serviceName: 'dep', method: 'call' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies(
        {},
        singleRepoScope,
        'raw',
        undefined,
        undefined,
        await getRepository(),
      );

      expect(result.metadata.scope.crossRepoEnabled).toBe(false);
      expect(result.metadata.scope.repoHashes).toEqual(['xyz789']);
    });
  });

  // ===========================================================================
  // Vantage Repo Tests
  // ===========================================================================

  describe('Vantage repo', () => {
    // "What does THIS repo call" is inherently single-origin. Under a
    // project-wide scope the vantage (where the agent is standing) decides
    // which repo "this" is — not resolvedRepos[0] (just the first in config).
    const projectScope: ScopeContext = {
      currentPath: '/test/workspace',
      resolvedRepos: ['api-server', 'web-app'],
      repoHashes: ['hash-core', 'hash-shifts'],
      crossRepoEnabled: true,
      project: 'acme',
      currentRepo: 'web-app',
      currentRepoHash: 'hash-shifts',
    };

    it('labels the report with the vantage repo, not the first repo in scope', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([createExternalCall({ serviceName: 'ext', method: 'call' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, projectScope, 'summary', undefined, undefined, mockRepo);

      expect(result.data).toContain('web-app');
      expect(result.data).not.toContain('api-server');
    });

    it('narrows the external-call query to the vantage repo only', async () => {
      const getExternalCalls = vi.fn().mockResolvedValue([createExternalCall({ serviceName: 'ext', method: 'call' })]);
      const mockRepo = createMockRepository({ getExternalCalls });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleListServiceDependencies({}, projectScope, 'raw', undefined, undefined, mockRepo);

      // Queried with ONLY the vantage repo's hash, not the whole project scope.
      expect(getExternalCalls).toHaveBeenCalledWith(['hash-shifts']);
    });

    it('falls back to the full scope when no vantage is set (unchanged behavior)', async () => {
      const noVantageScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['api-server', 'web-app'],
        repoHashes: ['hash-core', 'hash-shifts'],
        crossRepoEnabled: true,
        project: 'acme',
      };
      const getExternalCalls = vi.fn().mockResolvedValue([createExternalCall({ serviceName: 'ext', method: 'call' })]);
      const mockRepo = createMockRepository({ getExternalCalls });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, noVantageScope, 'summary', undefined, undefined, mockRepo);

      expect(getExternalCalls).toHaveBeenCalledWith(['hash-core', 'hash-shifts']);
      expect(result.data).toContain('api-server');
    });
  });

  // ===========================================================================
  // Protocol Detection Tests
  // ===========================================================================

  describe('Protocol Detection', () => {
    it('should detect HTTP protocol', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'api',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/users',
            method: 'getUsers',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps[0]!.callTypes).toContain('http');
    });

    it('should detect messaging protocol', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'events',
            protocol: 'messaging',
            method: 'produce',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps[0]!.callTypes).toContain('messaging');
    });

    it('should handle multiple protocols for same service', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          createExternalCall({
            serviceName: 'hybrid',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate: '/api/data',
            method: 'postData',
          }),
          createExternalCall({
            serviceName: 'hybrid',
            protocol: 'messaging',
            method: 'produce',
          }),
          createExternalCall({
            serviceName: 'hybrid',
            protocol: 'grpc',
            grpcService: 'HybridService',
            grpcMethod: 'Sync',
            method: 'sync',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      const hybridDep = deps.find((d) => d.service === 'hybrid');
      expect(hybridDep).toBeDefined();
      expect(hybridDep!.callTypes).toContain('http');
      expect(hybridDep!.callTypes).toContain('messaging');
      expect(hybridDep!.callTypes).toContain('grpc');
      expect(hybridDep!.callCount).toBe(3);
    });
  });

  describe('noise reduction', () => {
    it('merges whitespace-variant service names into one dependency', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi
          .fn()
          .mockResolvedValue([
            createExternalCall({ serviceName: 'core', protocol: 'http', httpMethod: 'GET', pathTemplate: '/a' }),
            createExternalCall({ serviceName: 'core ', protocol: 'http', httpMethod: 'GET', pathTemplate: '/b' }),
            createExternalCall({ serviceName: 'core  ', protocol: 'http', httpMethod: 'GET', pathTemplate: '/c' }),
          ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps.length).toBe(1);
      expect(deps[0]!.service).toBe('core');
      expect(deps[0]!.callCount).toBe(3);
    });

    it('drops calls with an empty/whitespace-only service name', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi
          .fn()
          .mockResolvedValue([
            createExternalCall({ serviceName: '   ', method: 'then' }),
            createExternalCall({ serviceName: 'real-svc', protocol: 'http', httpMethod: 'GET', pathTemplate: '/x' }),
          ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const deps = result.data as ServiceDependencyResult[];
      expect(deps.map((d) => d.service)).toEqual(['real-svc']);
    });

    it('filters promise/iteration built-ins out of the fallback patterns', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([
          // protocol that hits the method fallback branch, with a noise method name
          createExternalCall({ serviceName: 'core', protocol: 'unknown', method: 'then' }),
          createExternalCall({ serviceName: 'core', protocol: 'unknown', method: 'sendPublishedShifts' }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const core = (result.data as ServiceDependencyResult[]).find((d) => d.service === 'core');
      expect(core).toBeDefined();
      expect(core!.patterns).toContain('sendPublishedShifts');
      expect(core!.patterns).not.toContain('then');
    });
  });

  // ===========================================================================
  // Low-Coverage Caveat Tests
  // ===========================================================================

  describe('Low-Coverage Caveats', () => {
    // 0 external calls extracted → resolution density 0% < the 20% threshold
    // (the realistic shape behind an empty dependency list)
    const noEgressCounts = [createMockCoverageCounts({ externalCallCount: 0, resolvedExternalCallCount: 0 })];
    const expectedCaveat =
      "Note: this repo's external-call extraction density is low (0%) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.";

    it('appends the caveat to the empty message when resolution density is low', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
        getCoverageCounts: vi.fn().mockResolvedValue(noEgressCounts),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.data).toContain('No external service dependencies detected');
      expect(result.data).toContain(expectedCaveat);
      expect(mockRepo.getCoverageCounts).toHaveBeenCalledWith(mockScope.repoHashes);
    });

    it('adds no caveat when resolution density is healthy', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
        // Factory defaults are healthy (10/20 = 50%) — e.g. all rows had blank
        // service names but egress extraction itself is trustworthy.
        getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts()]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.data).toContain('No external service dependencies detected');
      expect(result.data).not.toContain('Note:');
    });

    it('leaves non-empty results untouched and never queries coverage (lazy)', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi
          .fn()
          .mockResolvedValue([
            createExternalCall({ serviceName: 'billing', protocol: 'http', httpMethod: 'GET', pathTemplate: '/x' }),
          ]),
        getCoverageCounts: vi.fn().mockResolvedValue(noEgressCounts),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.data).not.toContain('Note:');
      expect(mockRepo.getCoverageCounts).not.toHaveBeenCalled();
    });

    it('computes the density for the vantage repo when one is set (same origin as the query)', async () => {
      const projectScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['api-server', 'web-app'],
        repoHashes: ['hash-core', 'hash-shifts'],
        crossRepoEnabled: true,
        project: 'acme',
        currentRepo: 'web-app',
        currentRepoHash: 'hash-shifts',
      };
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
        getCoverageCounts: vi.fn().mockResolvedValue(noEgressCounts),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleListServiceDependencies({}, projectScope, 'summary', undefined, undefined, mockRepo);

      expect(mockRepo.getCoverageCounts).toHaveBeenCalledWith(['hash-shifts']);
    });

    it('keeps raw empty output a plain empty array (caveat is summary-only)', async () => {
      const mockRepo = createMockRepository({
        getExternalCalls: vi.fn().mockResolvedValue([]),
        getCoverageCounts: vi.fn().mockResolvedValue(noEgressCounts),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleListServiceDependencies({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect(result.data).toEqual([]);
    });
  });
});
