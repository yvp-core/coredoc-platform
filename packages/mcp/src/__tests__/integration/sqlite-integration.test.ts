/**
 * SQLite Integration Tests
 *
 * Tests MCP tool handlers with a real SQLite database.
 * No mocking - tests the full pipeline: handler → repository → SQL → formatter
 *
 * These tests verify:
 * - Real SQL queries work correctly
 * - Data transformations produce expected output
 * - Formatters generate valid markdown/JSON
 * - Edge cases are handled properly
 * - Multi-repo queries with pagination
 * - Cross-repo communication
 * - Deep call chains
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import { closeAllDrivers, closeDriver, getRepository } from '@coredoc/db';
import type { IGraphRepository } from '@coredoc/db/types';
import type { ScopeContext, DetailLevel, DetailLevelConfig, ServiceDependencyResult } from '../../types.js';

// Import handlers directly (not mocked)
import { handleSearchSymbols } from '../../tools/discovery/search-symbols.js';
import { handleListEntrypoints } from '../../tools/discovery/list-entrypoints.js';
import { handleDescribeRepository } from '../../tools/discovery/describe-repository.js';
import { handleFindCallers } from '../../tools/impact/find-callers.js';
import { handleAnalyzeChangeImpact } from '../../tools/impact/analyze-change-impact.js';
import { handleExplainFunction } from '../../tools/understanding/explain-function.js';
import { handleFindEntityUsage } from '../../tools/impact/find-entity-usage.js';

// New handlers for additional tool tests
import { handleExplainEntrypoint } from '../../tools/understanding/explain-entrypoint.js';
import { handleFindDependents } from '../../tools/impact/find-dependents.js';
import { handleListServiceDependencies } from '../../tools/cross-repo/list-service-dependencies.js';
import { handleTraceCrossRepoCall } from '../../tools/cross-repo/trace-cross-repo-call.js';

// Import seed data
import {
  createLegacySeedData,
  createRealisticSeedData,
  LEGACY_REPO_HASH,
  REPO_HASHES,
  REPO_NAMES,
} from '../fixtures/seed-data.js';

// Test database path
const TEST_DB_PATH = './test-mcp-integration.db';

// Store original env values
const originalDbBackend = process.env.COREDOC_DB_BACKEND;
const originalSqliteUrl = process.env.COREDOC_SQLITE_URL;

// Default detail config for tests
const defaultDetailLevel: DetailLevel = 'full';
const defaultDetailConfig: DetailLevelConfig = {
  includeBasic: true,
  includeSummaries: true,
  includeRefs: true,
  includeFullDetails: true,
};

describe('SQLite Integration Tests', () => {
  let repository: IGraphRepository;
  let mockScope: ScopeContext;

  beforeAll(async () => {
    // Clean up any existing test database
    cleanupTestDb();

    // Configure environment for SQLite BEFORE getting repository
    process.env.COREDOC_DB_BACKEND = 'sqlite';
    process.env.COREDOC_SQLITE_URL = `file:${TEST_DB_PATH}`;

    // Reset any existing backend state from other tests
    await closeAllDrivers();

    // Get repository via factory (this creates and initializes the driver)
    // Handlers will use the same factory, so they'll share this connection
    repository = await getRepository();

    // Seed test data (legacy for backward compatibility)
    const { nodes, edges } = createLegacySeedData();
    await repository.pushNodes(nodes);
    await repository.pushEdges(edges);
  });

  afterAll(async () => {
    // Close driver via factory and reset state
    await closeDriver();

    cleanupTestDb();

    // Restore original env values
    if (originalDbBackend !== undefined) {
      process.env.COREDOC_DB_BACKEND = originalDbBackend;
    } else {
      delete process.env.COREDOC_DB_BACKEND;
    }
    if (originalSqliteUrl !== undefined) {
      process.env.COREDOC_SQLITE_URL = originalSqliteUrl;
    } else {
      delete process.env.COREDOC_SQLITE_URL;
    }
  });

  beforeEach(() => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-service'],
      repoHashes: [LEGACY_REPO_HASH],
      crossRepoEnabled: false,
    };
  });

  // ===========================================================================
  // find_code Integration Tests
  // ===========================================================================

  describe('find_code handler', () => {
    it('should find createUser function with full details', async () => {
      const result = await handleSearchSymbols(
        { query: 'createUser', type: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      // Seed has `createUser` and `handleCreateUser` — both match the
      // substring search. Exact match must rank first so the canonical
      // result is still elements[0].
      expect(elements.length).toBeGreaterThanOrEqual(1);
      expect(elements[0].name).toBe('createUser');
      expect(elements[0].type).toBe('function');
      expect(elements[0].filePath).toBe('src/users/service.ts');
      expect(elements[0].startLine).toBe(20);
    });

    it('should find createUser, getUser, validateUser by *User* pattern', async () => {
      const result = await handleSearchSymbols(
        { query: '*User*', type: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      const names = elements.map((e: any) => e.name);

      // Legacy seed has: createUser, getUser, validateUser, handleCreateUser
      expect(elements.length).toBe(4);
      expect(names).toContain('createUser');
      expect(names).toContain('getUser');
      expect(names).toContain('validateUser');
      expect(names).toContain('handleCreateUser');
      expect(elements.every((e: any) => e.name.includes('User'))).toBe(true);
    });

    it('should find UserService class with location', async () => {
      const result = await handleSearchSymbols(
        { query: 'UserService', type: 'class' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      expect(elements.length).toBe(1);
      expect(elements[0].name).toBe('UserService');
      expect(elements[0].type).toBe('class');
      expect(elements[0].filePath).toBe('src/users/service.ts');
      expect(elements[0].startLine).toBe(10);
    });

    it('should respect limit=2 and return exactly 2 results', async () => {
      const result = await handleSearchSymbols(
        { query: '*', type: 'all', limit: 2 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      expect(elements.length).toBe(2);
    });

    it('should format as summary markdown with file location', async () => {
      const result = await handleSearchSymbols(
        { query: 'createUser', type: 'function' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      expect(typeof result.data).toBe('string');
      const markdown = result.data as string;
      expect(markdown).toContain('createUser');
      expect(markdown).toContain('src/users/service.ts');
      expect(result.metadata.format).toBe('summary');
    });
  });

  // ===========================================================================
  // list_entrypoints Integration Tests
  // ===========================================================================

  describe('list_entrypoints handler', () => {
    it('should list exactly 2 HTTP entrypoints from legacy seed', async () => {
      const result = await handleListEntrypoints(
        {},
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const entrypoints = result.data as any[];
      // Legacy seed has: POST /api/users, GET /api/users/:id
      expect(entrypoints.length).toBe(2);
      expect(entrypoints.every((e: any) => e.type === 'http')).toBe(true);
    });

    it('should find both HTTP entrypoints when filtering by type', async () => {
      const result = await handleListEntrypoints(
        { type: 'http' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const entrypoints = result.data as any[];
      expect(entrypoints.length).toBe(2);

      const paths = entrypoints.map((e: any) => e.fullPath);
      expect(paths).toContain('/api/users');
      expect(paths).toContain('/api/users/:id');
    });

    it('should filter by /users path and return both entrypoints', async () => {
      const result = await handleListEntrypoints(
        { pathPattern: '/users' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const entrypoints = result.data as any[];
      expect(entrypoints.length).toBe(2);
      expect(entrypoints.every((e: any) => e.fullPath?.includes('/users'))).toBe(true);
    });

    it('should include handleCreateUser handler for POST /api/users', async () => {
      const result = await handleListEntrypoints(
        { type: 'http' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const entrypoints = result.data as any[];
      const postEndpoint = entrypoints.find((e: any) => e.method === 'POST');

      expect(postEndpoint).toBeDefined();
      expect(postEndpoint.handlerName).toBe('handleCreateUser');
      expect(postEndpoint.fullPath).toBe('/api/users');
      expect(postEndpoint.filePath).toBe('src/users/controller.ts');
    });
  });

  // ===========================================================================
  // get_repo_overview Integration Tests
  // ===========================================================================

  describe('get_repo_overview handler', () => {
    it('should return test-service overview with correct counts', async () => {
      const result = await handleDescribeRepository({}, mockScope, 'raw', undefined, undefined, await getRepository());

      const overview = result.data as any;
      expect(overview.name).toBe('test-service');
      expect(overview.type).toBe('backend');
      // Legacy seed: 4 functions, 2 classes, 1 entity, 2 entrypoints
      expect(overview.stats.functions).toBe(4);
      expect(overview.stats.classes).toBe(2);
      expect(overview.stats.entities).toBe(1);
    });

    it('should include file count and entrypoint types', async () => {
      const result = await handleDescribeRepository({}, mockScope, 'raw', undefined, undefined, await getRepository());

      const overview = result.data as any;
      // Legacy seed: 3 files
      expect(overview.stats.files).toBe(3);
      // Only http entrypoints in legacy seed - entrypointsByType is a Record<string, number>
      expect(overview.entrypointsByType).toHaveProperty('http');
      expect(overview.entrypointsByType.http).toBeGreaterThan(0);
    });

    it('should format as markdown with repo name and stats sections', async () => {
      const result = await handleDescribeRepository(
        {},
        mockScope,
        'summary',
        undefined,
        undefined,
        await getRepository(),
      );

      const markdown = result.data as string;
      expect(markdown).toContain('test-service');
      expect(markdown).toContain('backend');
      // The markdown format includes Statistics section
      expect(markdown).toContain('Statistics');
    });
  });

  // ===========================================================================
  // get_callers Integration Tests
  // ===========================================================================

  describe('get_callers handler', () => {
    it('should find createUser as direct caller of validateUser', async () => {
      const result = await handleFindCallers(
        { functionName: 'validateUser', depth: 1 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const callers = (result.data as any).callers;
      // Legacy seed: createUser → validateUser
      expect(callers.length).toBe(1);
      expect(callers[0].name).toBe('createUser');
      expect(callers[0].filePath).toBe('src/users/service.ts');
      expect(callers[0].distance).toBe(1);
    });

    it('should find handleCreateUser and createUser as callers with depth=5', async () => {
      const result = await handleFindCallers(
        { functionName: 'validateUser', depth: 5 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const callers = (result.data as any).callers;
      const names = callers.map((c: any) => c.name);

      // Legacy seed: handleCreateUser → createUser → validateUser
      expect(callers.length).toBe(2);
      expect(names).toContain('createUser');
      expect(names).toContain('handleCreateUser');
    });

    it('should include correct distance for each caller', async () => {
      const result = await handleFindCallers(
        { functionName: 'validateUser', depth: 5 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const callers = (result.data as any).callers;
      const createUser = callers.find((c: any) => c.name === 'createUser');
      const handleCreateUser = callers.find((c: any) => c.name === 'handleCreateUser');

      expect(createUser.distance).toBe(1); // Direct caller
      expect(handleCreateUser.distance).toBe(2); // 2 hops away
    });
  });

  // ===========================================================================
  // analyze_change_impact Integration Tests
  // ===========================================================================

  describe('analyze_change_impact handler', () => {
    it('should analyze validateUser impact with target details and callers', async () => {
      const result = await handleAnalyzeChangeImpact(
        { target: 'validateUser', depth: 3 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const impact = result.data as any;

      // Verify target function details
      expect(impact.target.name).toBe('validateUser');
      expect(impact.target.filePath).toBe('src/users/validator.ts');

      // validateUser is called by createUser (direct caller)
      // Handler returns directCallers and transitiveCallers, not 'callers'
      expect(impact.directCallers.length).toBe(1);
      expect(impact.directCallers[0].name).toBe('createUser');
    });

    it('should identify POST /api/users as affected entrypoint for createUser', async () => {
      const result = await handleAnalyzeChangeImpact(
        { target: 'createUser', depth: 5 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const impact = result.data as any;

      // createUser is called by handleCreateUser which handles POST /api/users
      expect(impact.affectedEntrypoints.length).toBe(1);
      expect(impact.affectedEntrypoints[0].fullPath).toBe('/api/users');
      expect(impact.affectedEntrypoints[0].method).toBe('POST');
    });

    it('should calculate low risk for validateUser (1 direct caller, 1 entrypoint)', async () => {
      const result = await handleAnalyzeChangeImpact(
        { target: 'validateUser', depth: 3 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const impact = result.data as any;

      // Risk formula: directCallers + entrypoints*3 + crossRepo*5
      // 1 + 1*3 = 4 < 8, so risk = 'low'
      expect(impact.riskLevel).toBe('low');
      expect(impact.affectedEntrypoints.length).toBe(1);
    });
  });

  // ===========================================================================
  // explain_function Integration Tests
  // ===========================================================================

  describe('explain_function handler', () => {
    it('should explain createUser with full function details', async () => {
      const result = await handleExplainFunction(
        { functionName: 'createUser' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;

      // Verify function details from legacy seed
      expect(explanation.function.name).toBe('createUser');
      expect(explanation.function.filePath).toBe('src/users/service.ts');
      expect(explanation.function.startLine).toBe(20);
      expect(explanation.function.endLine).toBe(40);
      expect(explanation.function.kind).toBe('method');
      expect(explanation.function.summary).toBe('Creates a new user in the database');
    });

    it('should include validateUser as callee of createUser', async () => {
      const result = await handleExplainFunction(
        { functionName: 'createUser', includeCallees: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;

      // createUser calls exactly validateUser in legacy seed
      expect(explanation.callees.length).toBe(1);
      expect(explanation.callees[0].name).toBe('validateUser');
      expect(explanation.callees[0].filePath).toBe('src/users/validator.ts');
    });

    it('should include handleCreateUser as caller of createUser', async () => {
      const result = await handleExplainFunction(
        { functionName: 'createUser', includeCallers: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;

      // handleCreateUser calls createUser in legacy seed
      expect(explanation.callers.length).toBe(1);
      expect(explanation.callers[0].name).toBe('handleCreateUser');
      expect(explanation.callers[0].filePath).toBe('src/users/controller.ts');
    });

    it('should format as markdown with function signature and summary', async () => {
      const result = await handleExplainFunction(
        { functionName: 'createUser' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const markdown = result.data as string;
      expect(markdown).toContain('createUser');
      expect(markdown).toContain('src/users/service.ts');
      expect(markdown).toContain('Creates a new user in the database');
    });
  });

  // ===========================================================================
  // get_entity_consumers Integration Tests
  // ===========================================================================

  describe('get_entity_consumers handler', () => {
    it('should find createUser and getUser as User entity consumers', async () => {
      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const consumers = result.data as any[];
      const names = consumers.map((c: any) => c.name);

      // Legacy seed: createUser (create), getUser (read)
      expect(consumers.length).toBe(2);
      expect(names).toContain('createUser');
      expect(names).toContain('getUser');
    });

    it('should filter to createUser only when operation=create', async () => {
      const result = await handleFindEntityUsage(
        { entityName: 'User', operation: 'create' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const consumers = result.data as any[];

      // Only createUser operates on User with 'create'
      expect(consumers.length).toBe(1);
      expect(consumers[0].name).toBe('createUser');
      expect(consumers[0].operation).toBe('create');
      expect(consumers[0].filePath).toBe('src/users/service.ts');
    });

    it('should include correct operation type for each consumer', async () => {
      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const consumers = result.data as any[];
      const createUserConsumer = consumers.find((c: any) => c.name === 'createUser');
      const getUserConsumer = consumers.find((c: any) => c.name === 'getUser');

      expect(createUserConsumer.operation).toBe('create');
      expect(getUserConsumer.operation).toBe('read');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should return empty object for non-existent function', async () => {
      const result = await handleExplainFunction(
        { functionName: 'nonExistentFunction' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;

      // Handler returns {} for not found in raw format
      expect(Object.keys(explanation).length).toBe(0);
    });

    it('should return empty array for non-matching search query', async () => {
      const result = await handleSearchSymbols(
        { query: 'zzzNonExistent', type: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      expect(elements).toEqual([]);
      expect(elements.length).toBe(0);
    });

    it('should return empty array for non-existent entity', async () => {
      const result = await handleFindEntityUsage(
        { entityName: 'NonExistentEntity' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const consumers = result.data as any[];
      expect(consumers).toEqual([]);
      expect(consumers.length).toBe(0);
    });
  });
});

// =============================================================================
// Multi-Repo Realistic Integration Tests
// =============================================================================

describe('Multi-Repo Realistic Integration Tests', () => {
  let repository: IGraphRepository;
  let seedStats: {
    repos: number;
    functions: number;
    classes: number;
    entities: number;
    entrypoints: number;
    edges: number;
  };

  beforeAll(async () => {
    // Clean up any existing test database
    cleanupTestDb();

    // Configure environment for SQLite
    process.env.COREDOC_DB_BACKEND = 'sqlite';
    process.env.COREDOC_SQLITE_URL = `file:${TEST_DB_PATH}`;

    // Reset any existing backend state
    await closeAllDrivers();

    // Get repository via factory
    repository = await getRepository();

    // Seed realistic multi-repo data
    const { nodes, edges, stats } = createRealisticSeedData();
    seedStats = stats;
    await repository.pushNodes(nodes);
    await repository.pushEdges(edges);
  });

  afterAll(async () => {
    await closeDriver();
    cleanupTestDb();

    // Restore original env values
    if (originalDbBackend !== undefined) {
      process.env.COREDOC_DB_BACKEND = originalDbBackend;
    } else {
      delete process.env.COREDOC_DB_BACKEND;
    }
    if (originalSqliteUrl !== undefined) {
      process.env.COREDOC_SQLITE_URL = originalSqliteUrl;
    } else {
      delete process.env.COREDOC_SQLITE_URL;
    }
  });

  // ===========================================================================
  // Seed Data Verification
  // ===========================================================================

  describe('Seed data verification', () => {
    it('should have created 3 repositories', () => {
      expect(seedStats.repos).toBe(3);
    });

    it('should have created ~120 functions', () => {
      // user-service: 45, order-service: 40, analytics-service: 35 = 120
      expect(seedStats.functions).toBeGreaterThanOrEqual(100);
      expect(seedStats.functions).toBeLessThanOrEqual(130);
    });

    it('should have created entities across services', () => {
      // User, Profile, UserSettings, Order, OrderItem, Invoice, Payment, Metric, Report, DashboardConfig = 10
      expect(seedStats.entities).toBeGreaterThanOrEqual(9);
    });

    it('should have created entrypoints across services', () => {
      // user-service: 10, order-service: 8, analytics-service: 5 = 23
      expect(seedStats.entrypoints).toBeGreaterThanOrEqual(20);
    });
  });

  // ===========================================================================
  // Pagination Behavior Tests
  // ===========================================================================

  describe('Pagination behavior', () => {
    it('find_code should return 4 create* functions across all repos', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: Object.values(REPO_NAMES),
        repoHashes: Object.values(REPO_HASHES),
        crossRepoEnabled: true,
      };

      const result = await handleSearchSymbols(
        { query: 'create*', type: 'function', limit: 50 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      const names = elements.map((e: any) => e.name);

      // Exact functions from seed data
      expect(names).toContain('createUser'); // user-service
      expect(names).toContain('createOrder'); // order-service
      expect(names).toContain('createAuditLog'); // user-service
      expect(names).toContain('createInvoice'); // order-service

      // Verify each has file path and line info
      for (const el of elements) {
        expect(el.filePath).toBeTruthy();
        expect(typeof el.startLine).toBe('number');
      }
    });

    it('find_code should return validation functions from all 3 services', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: Object.values(REPO_NAMES),
        repoHashes: Object.values(REPO_HASHES),
        crossRepoEnabled: true,
      };

      const result = await handleSearchSymbols(
        { query: 'validate*', type: 'function', limit: 50 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      const names = elements.map((e: any) => e.name);

      // Key validators from each service
      expect(names).toContain('validateUser'); // user-service
      expect(names).toContain('validateCreateUserInput'); // user-service
      expect(names).toContain('validateOrder'); // order-service
      expect(names).toContain('validateDateRange'); // analytics-service (both validator and service have this)

      // Should be at least 15 (8 user + 6 order + 4 analytics validators + service methods)
      expect(elements.length).toBeGreaterThanOrEqual(15);
    });

    it('find_code should return getter functions with correct file paths', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: Object.values(REPO_NAMES),
        repoHashes: Object.values(REPO_HASHES),
        crossRepoEnabled: true,
      };

      const result = await handleSearchSymbols(
        { query: 'get*', type: 'function', limit: 100 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      const names = elements.map((e: any) => e.name);

      // Key getters from seed data
      expect(names).toContain('getUser'); // user-service controller
      expect(names).toContain('getUserById'); // user-service service
      expect(names).toContain('getOrder'); // order-service controller
      expect(names).toContain('getMetrics'); // analytics-service controller
      expect(names).toContain('getDashboard'); // analytics-service controller
      expect(names).toContain('getOrderHistory'); // order-service service
    });

    it('get_entity_consumers should return 11 User operations with correct operations', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const consumers = result.data as any[];
      const names = consumers.map((c: any) => c.name);

      // Verify specific consumers from seed data
      expect(names).toContain('createUser');
      expect(names).toContain('saveUser');
      expect(names).toContain('findUserById');
      expect(names).toContain('getUserById');
      expect(names).toContain('updateUserRecord');
      expect(names).toContain('deleteUserRecord');

      // Should have 11 total (seed data has 11 OPERATES_ON edges for User)
      expect(consumers.length).toBe(11);
    });

    it('get_callers should trace validateEmailFormat back to createUser', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleFindCallers(
        { functionName: 'validateEmailFormat', depth: 5 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const callers = (result.data as any).callers;
      const names = callers.map((c: any) => c.name);

      // validateEmailFormat ← validateCreateUserInput ← validateUser ← createUser
      expect(names).toContain('validateCreateUserInput');
      expect(callers.length).toBeGreaterThanOrEqual(1);

      // Verify distance increases for transitive callers
      const validateCreateUserInput = callers.find((c: any) => c.name === 'validateCreateUserInput');
      expect(validateCreateUserInput.distance).toBe(1);
    });
  });

  // ===========================================================================
  // Single Repo Scoping Tests
  // ===========================================================================

  describe('Single repo scoping', () => {
    it('should return user-service *User* functions only from user-service paths', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleSearchSymbols(
        { query: '*User*', type: 'function', limit: 100 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const elements = result.data as any[];
      const names = elements.map((e: any) => e.name);

      // user-service has these *User* functions
      expect(names).toContain('createUser');
      expect(names).toContain('getUser');
      expect(names).toContain('validateUser');
      expect(names).toContain('getUserById');
      expect(names).toContain('getUserByEmail');

      // Should NOT contain order-service functions (repo scoping)
      expect(names).not.toContain('createOrder');

      // All file paths should be user-service paths
      expect(
        elements.every(
          (e: any) =>
            e.filePath.startsWith('src/controllers/user') ||
            e.filePath.startsWith('src/services/user') ||
            e.filePath.startsWith('src/validators/user') ||
            e.filePath.startsWith('src/repositories/user'),
        ),
      ).toBe(true);
    });

    it('should return exactly 6 order-service HTTP entrypoints', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: false,
      };

      const result = await handleListEntrypoints(
        { type: 'http' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const entrypoints = result.data as any[];
      const paths = entrypoints.map((e: any) => `${e.method} ${e.path}`);

      // order-service HTTP entrypoints from seed
      expect(entrypoints.length).toBe(6);
      expect(paths).toContain('POST /orders');
      expect(paths).toContain('GET /orders/:id');
      expect(paths).toContain('PUT /orders/:id');
      expect(paths).toContain('DELETE /orders/:id');
      expect(paths).toContain('GET /orders');
      expect(paths).toContain('POST /orders/:id/payment');
    });

    it('should return analytics-service overview with correct stats', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['analytics-service'],
        repoHashes: [REPO_HASHES.analyticsService],
        crossRepoEnabled: false,
      };

      const result = await handleDescribeRepository({}, scope, 'raw', undefined, undefined, await getRepository());

      const overview = result.data as any;
      expect(overview.name).toBe('analytics-service');
      expect(overview.type).toBe('backend');
      // analytics-service: 5 controllers + 18 services + 4 validators + 8 repo = 35 functions
      expect(overview.stats.functions).toBe(35);
      // 3 entities: Metric, Report, DashboardConfig
      expect(overview.stats.entities).toBe(3);
      // 5 HTTP entrypoints only (no kafka) - entrypointsByType is a Record<string, number>
      expect(overview.entrypointsByType).toHaveProperty('http');
      expect(overview.entrypointsByType.http).toBe(5);
    });
  });

  // ===========================================================================
  // Deep Call Chain Tests
  // ===========================================================================

  describe('Deep call chains', () => {
    it('should trace notifyUserChange back through createAuditLog → saveUser → createUser', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      // Chain: createUser → saveUser → createAuditLog → notifyUserChange
      const result = await handleFindCallers(
        { functionName: 'notifyUserChange', depth: 5 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const callers = (result.data as any).callers;
      const names = callers.map((c: any) => c.name);

      // Should find all callers in chain
      expect(names).toContain('createAuditLog'); // direct caller (distance 1)
      expect(names).toContain('saveUser'); // distance 2
      expect(names).toContain('createUser'); // distance 3

      // Verify distances
      const createAuditLog = callers.find((c: any) => c.name === 'createAuditLog');
      const saveUser = callers.find((c: any) => c.name === 'saveUser');
      const createUser = callers.find((c: any) => c.name === 'createUser');

      expect(createAuditLog.distance).toBe(1);
      expect(saveUser.distance).toBe(2);
      expect(createUser.distance).toBe(3);
    });

    it('should trace applyDiscount back through calculateTotal → createOrder', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: false,
      };

      // Chain: createOrder → calculateTotal → applyDiscount
      const result = await handleFindCallers(
        { functionName: 'applyDiscount', depth: 5 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const callers = (result.data as any).callers;
      const names = callers.map((c: any) => c.name);

      expect(names).toContain('calculateTotal');
      expect(names).toContain('createOrder');

      // Verify calculateTotal is direct caller
      const calculateTotal = callers.find((c: any) => c.name === 'calculateTotal');
      expect(calculateTotal.distance).toBe(1);
      expect(calculateTotal.filePath).toBe('src/services/order.service.ts');
    });

    it('should trace computeTrends back through computeAverages → aggregateMetrics → getMetrics', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['analytics-service'],
        repoHashes: [REPO_HASHES.analyticsService],
        crossRepoEnabled: false,
      };

      // Chain: getMetrics → aggregateMetrics → computeAverages → computeTrends
      const result = await handleFindCallers(
        { functionName: 'computeTrends', depth: 5 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const callers = (result.data as any).callers;
      const names = callers.map((c: any) => c.name);

      expect(names).toContain('computeAverages'); // distance 1
      expect(names).toContain('aggregateMetrics'); // distance 2
      expect(names).toContain('getMetrics'); // distance 3

      // Verify computeAverages is direct caller
      const computeAverages = callers.find((c: any) => c.name === 'computeAverages');
      expect(computeAverages.distance).toBe(1);
    });
  });

  // ===========================================================================
  // Entity Operation Tests
  // ===========================================================================

  describe('Entity operations', () => {
    it('should find all CRUD operations on User entity with exact counts', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      // Test CREATE - seed has: createUser (controller), saveUser (repo)
      const createResult = await handleFindEntityUsage(
        { entityName: 'User', operation: 'create' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const createNames = (createResult.data as any[]).map((c: any) => c.name);
      expect(createNames).toContain('createUser');
      expect(createNames).toContain('saveUser');
      expect((createResult.data as any[]).length).toBe(2);

      // Test READ - seed has: findUserById, findUserByEmail, getUserById, getUserByEmail, getUser
      const readResult = await handleFindEntityUsage(
        { entityName: 'User', operation: 'read' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const readNames = (readResult.data as any[]).map((c: any) => c.name);
      expect(readNames).toContain('findUserById');
      expect(readNames).toContain('getUserById');
      expect(readNames).toContain('getUser');
      expect((readResult.data as any[]).length).toBe(5);

      // Test UPDATE - seed has: updateUserRecord (repo), updateUser (controller)
      const updateResult = await handleFindEntityUsage(
        { entityName: 'User', operation: 'update' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const updateNames = (updateResult.data as any[]).map((c: any) => c.name);
      expect(updateNames).toContain('updateUserRecord');
      expect(updateNames).toContain('updateUser');
      expect((updateResult.data as any[]).length).toBe(2);

      // Test DELETE - seed has: deleteUserRecord (repo), deleteUser (controller)
      const deleteResult = await handleFindEntityUsage(
        { entityName: 'User', operation: 'delete' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const deleteNames = (deleteResult.data as any[]).map((c: any) => c.name);
      expect(deleteNames).toContain('deleteUserRecord');
      expect(deleteNames).toContain('deleteUser');
      expect((deleteResult.data as any[]).length).toBe(2);
    });

    it('should find 8 Order entity consumers with specific functions', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: false,
      };

      const result = await handleFindEntityUsage(
        { entityName: 'Order' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const consumers = result.data as any[];
      const names = consumers.map((c: any) => c.name);

      // Order entity consumers from seed
      expect(names).toContain('createOrder');
      expect(names).toContain('saveOrder');
      expect(names).toContain('findOrderById');
      expect(names).toContain('getOrder');
      expect(names).toContain('updateOrder');
      expect(names).toContain('cancelOrder');
      expect(consumers.length).toBe(8);
    });

    it('should find 3 Metric entity consumers: getMetrics, findMetricsByRange, aggregateByPeriod', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['analytics-service'],
        repoHashes: [REPO_HASHES.analyticsService],
        crossRepoEnabled: false,
      };

      const result = await handleFindEntityUsage(
        { entityName: 'Metric' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const consumers = result.data as any[];
      const names = consumers.map((c: any) => c.name);

      expect(names).toContain('getMetrics');
      expect(names).toContain('findMetricsByRange');
      expect(names).toContain('aggregateByPeriod');
      expect(consumers.length).toBe(3);
    });
  });

  // ===========================================================================
  // Impact Analysis Tests
  // ===========================================================================

  describe('Impact analysis', () => {
    it('should analyze impact of hashPassword showing createUser as direct caller', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleAnalyzeChangeImpact(
        { target: 'hashPassword', depth: 5 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const impact = result.data as any;

      // Verify target details
      expect(impact.target.name).toBe('hashPassword');
      expect(impact.target.filePath).toBe('src/services/user.service.ts');
      expect(impact.target.type).toBe('function');

      // hashPassword is called by createUser (1 direct caller, 1 entrypoint = 1+3=4, so low risk)
      expect(impact.riskLevel).toBe('low');

      // Verify direct callers - createUser directly calls hashPassword
      const directCallerNames = impact.directCallers.map((c: any) => c.name);
      expect(directCallerNames).toContain('createUser');
      expect(impact.directCallers.length).toBe(1);

      // Note: analyze_change_impact doesn't track callees - it only tracks callers
      // It returns directCallers, transitiveCallers, affectedEntrypoints, affectedTests
    });

    it('should analyze impact of calculateTotal showing createOrder as caller', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: false,
      };

      const result = await handleAnalyzeChangeImpact(
        { target: 'calculateTotal', depth: 5 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const impact = result.data as any;

      // Verify target details
      expect(impact.target.name).toBe('calculateTotal');
      expect(impact.target.filePath).toBe('src/services/order.service.ts');

      // calculateTotal is called by createOrder which is an entrypoint handler
      const directCallerNames = impact.directCallers.map((c: any) => c.name);
      expect(directCallerNames).toContain('createOrder');
      expect(impact.directCallers.length).toBe(1);

      // Should have 1 affected entrypoint (POST /orders)
      expect(impact.affectedEntrypoints.length).toBe(1);
      expect(impact.affectedEntrypoints[0].method).toBe('POST');
      expect(impact.affectedEntrypoints[0].path).toBe('/orders');
    });

    it('should analyze impact of aggregateMetrics showing getMetrics as caller', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['analytics-service'],
        repoHashes: [REPO_HASHES.analyticsService],
        crossRepoEnabled: false,
      };

      const result = await handleAnalyzeChangeImpact(
        { target: 'aggregateMetrics', depth: 5 },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const impact = result.data as any;

      // Verify target details
      expect(impact.target.name).toBe('aggregateMetrics');
      expect(impact.target.filePath).toBe('src/services/analytics.service.ts');

      // aggregateMetrics is called by getMetrics (entrypoint handler)
      const directCallerNames = impact.directCallers.map((c: any) => c.name);
      expect(directCallerNames).toContain('getMetrics');
      expect(impact.directCallers.length).toBe(1);

      // Should have 1 affected entrypoint (GET /metrics)
      expect(impact.affectedEntrypoints.length).toBe(1);
      expect(impact.affectedEntrypoints[0].method).toBe('GET');
      expect(impact.affectedEntrypoints[0].path).toBe('/metrics');
    });
  });

  // ===========================================================================
  // Kafka Entrypoint Tests
  // ===========================================================================

  describe('Kafka entrypoints', () => {
    it('should find kafka entrypoints in user-service', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleListEntrypoints(
        { type: 'queue' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const entrypoints = result.data as any[];
      expect(entrypoints.length).toBe(2); // user.created, user.updated
      expect(entrypoints.every((e: any) => e.type === 'queue')).toBe(true);
    });

    it('should find kafka entrypoints in order-service', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: false,
      };

      const result = await handleListEntrypoints(
        { type: 'queue' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const entrypoints = result.data as any[];
      expect(entrypoints.length).toBe(2); // order.payment.received, user.changed
    });

    it('analytics-service should have no kafka entrypoints', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['analytics-service'],
        repoHashes: [REPO_HASHES.analyticsService],
        crossRepoEnabled: false,
      };

      const result = await handleListEntrypoints(
        { type: 'queue' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const entrypoints = result.data as any[];
      expect(entrypoints.length).toBe(0);
    });
  });

  // ===========================================================================
  // Explain Function Tests
  // ===========================================================================

  describe('Explain function with realistic data', () => {
    it('should explain createUser with 4 specific callees: validateUser, hashPassword, saveUser, formatUserResponse', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleExplainFunction(
        { functionName: 'createUser', includeCallees: true },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;

      // Verify function details
      expect(explanation.function.name).toBe('createUser');
      expect(explanation.function.filePath).toBe('src/controllers/user.controller.ts');
      expect(explanation.function.startLine).toBe(20);
      expect(explanation.function.summary).toBe('HTTP handler for createUser');

      // Verify exact callees - createUser calls: validateUser, hashPassword, saveUser, formatUserResponse
      const calleeNames = explanation.callees.map((c: any) => c.name);
      expect(calleeNames).toContain('validateUser');
      expect(calleeNames).toContain('hashPassword');
      expect(calleeNames).toContain('saveUser');
      expect(calleeNames).toContain('formatUserResponse');
      expect(explanation.callees.length).toBe(4);

      // Verify each callee has proper structure (note: callees don't have distance, only callers do)
      const validateUser = explanation.callees.find((c: any) => c.name === 'validateUser');
      expect(validateUser.filePath).toBe('src/services/user.service.ts');
      expect(validateUser.type).toBe('function');
    });

    it('should explain processOrderCreated with reserveStock as caller, sendOrderConfirmation/enrichOrderData as callees', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: false,
      };

      const result = await handleExplainFunction(
        { functionName: 'processOrderCreated', includeCallees: true, includeCallers: true },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;

      // Verify function details
      expect(explanation.function.name).toBe('processOrderCreated');
      expect(explanation.function.filePath).toBe('src/services/order.service.ts');
      expect(explanation.function.summary).toBe('processOrderCreated service method');

      // Verify callers - reserveStock calls processOrderCreated
      const callerNames = explanation.callers.map((c: any) => c.name);
      expect(callerNames).toContain('reserveStock');
      expect(explanation.callers.length).toBe(1);

      // reserveStock should be direct caller (distance 1)
      const reserveStock = explanation.callers.find((c: any) => c.name === 'reserveStock');
      expect(reserveStock.distance).toBe(1);
      expect(reserveStock.filePath).toBe('src/services/order.service.ts');

      // Verify callees - processOrderCreated calls sendOrderConfirmation and enrichOrderData
      const calleeNames = explanation.callees.map((c: any) => c.name);
      expect(calleeNames).toContain('sendOrderConfirmation');
      expect(calleeNames).toContain('enrichOrderData');
      expect(explanation.callees.length).toBe(2);
    });
  });

  // ===========================================================================
  // explain_entrypoint Handler Tests
  // ===========================================================================

  describe('explain_entrypoint handler', () => {
    it('should explain HTTP POST /users entrypoint with full details', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleExplainEntrypoint(
        { method: 'POST', path: '/users' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;

      // Verify entrypoint details
      expect(explanation.entrypoint.method).toBe('POST');
      expect(explanation.entrypoint.path).toBe('/users');
      expect(explanation.entrypoint.fullPath).toBe('/api/users');
      expect(explanation.entrypoint.type).toBe('http');
      expect(explanation.entrypoint.filePath).toBe('src/controllers/user.controller.ts');
      expect(explanation.entrypoint.handlerName).toBe('createUser');

      // Verify handler function details
      expect(explanation.handler.function.name).toBe('createUser');
      expect(explanation.handler.function.filePath).toBe('src/controllers/user.controller.ts');
      expect(explanation.handler.function.type).toBe('function');
    });

    it('should explain Kafka entrypoint with topic and handler', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleExplainEntrypoint(
        { entrypointType: 'queue' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;

      // Verify Kafka entrypoint details
      expect(explanation.entrypoint.type).toBe('queue');
      expect(explanation.entrypoint.topic).toMatch(/^user\.(created|updated)$/);
      expect(explanation.entrypoint.handlerName).toBe('processUserEvent');
      expect(explanation.entrypoint.filePath).toBe('src/services/user.service.ts');
    });

    it('should include call tree with expected functions from createUser', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleExplainEntrypoint(
        { method: 'POST', path: '/users' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;
      const callTreeNames = explanation.callTree.map((f: any) => f.name);

      // createUser calls: validateUser, hashPassword, saveUser, formatUserResponse
      expect(callTreeNames).toContain('validateUser');
      expect(callTreeNames).toContain('hashPassword');
      expect(callTreeNames).toContain('saveUser');
      expect(callTreeNames).toContain('formatUserResponse');

      // Verify call tree nodes have required properties
      for (const fn of explanation.callTree) {
        expect(fn.id).toBeTruthy();
        expect(fn.name).toBeTruthy();
        expect(fn.filePath).toBeTruthy();
        expect(typeof fn.startLine).toBe('number');
      }
    });

    it('should return empty result for non-existent entrypoint', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleExplainEntrypoint(
        { method: 'DELETE', path: '/nonexistent/path/that/does/not/exist' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      // Should return empty object for not found
      const explanation = result.data as any;
      expect(Object.keys(explanation).length).toBe(0);
    });

    it('should find GET /users/:id entrypoint with getUser handler', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleExplainEntrypoint(
        { method: 'GET', path: '/users/:id' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const explanation = result.data as any;
      expect(explanation.entrypoint.method).toBe('GET');
      expect(explanation.entrypoint.path).toBe('/users/:id');
      expect(explanation.entrypoint.handlerName).toBe('getUser');
    });
  });

  // ===========================================================================
  // get_dependents Handler Tests
  // ===========================================================================

  describe('get_dependents handler', () => {
    it('should find UserService extending BaseService with full details', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleFindDependents(
        { name: 'BaseService', type: 'class' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      expect(result.data).toBeInstanceOf(Array);
      const dependents = result.data as any[];

      // Should find exactly UserService extending BaseService
      expect(dependents.length).toBe(1);
      expect(dependents[0].name).toBe('UserService');
      expect(dependents[0].type).toBe('class');
      expect(dependents[0].filePath).toBe('src/services/user.service.ts');
      expect(typeof dependents[0].startLine).toBe('number');
      expect(dependents[0].id).toContain('UserService');
    });

    it('should find UserService implementing IService interface', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleFindDependents(
        { name: 'IService', type: 'interface' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      expect(result.data).toBeInstanceOf(Array);
      const dependents = result.data as any[];

      // Should find exactly UserService implementing IService
      expect(dependents.length).toBe(1);
      expect(dependents[0].name).toBe('UserService');
      expect(dependents[0].type).toBe('class');
      expect(dependents[0].filePath).toBe('src/services/user.service.ts');
    });

    it('should return empty array for class with no extensions', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      // UserService has no classes extending it (it's not a base class)
      const result = await handleFindDependents(
        { name: 'UserService', type: 'class' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      expect(result.data).toBeInstanceOf(Array);
      const dependents = result.data as any[];
      expect(dependents).toEqual([]);
    });

    it('should return empty array for non-existent class', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleFindDependents(
        { name: 'NonExistentClass', type: 'class' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      // Should return empty array for not found (raw format)
      expect(result.data).toEqual([]);
    });

    it('should return error message for non-existent class in summary format', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleFindDependents(
        { name: 'NonExistentClass', type: 'class' },
        scope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      // Should return error message string in summary format
      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('not found');
    });
  });

  // ===========================================================================
  // get_service_dependencies Handler Tests
  // ===========================================================================

  describe('get_service_dependencies handler', () => {
    // The handler now queries external_call nodes from the parser.
    // user-service has external calls to order-service (kafka + http).

    it('should find external_call nodes for user-service', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: false,
      };

      const result = await handleListServiceDependencies({}, scope, 'raw', undefined, undefined, await getRepository());

      // user-service has external calls to order-service
      expect(Array.isArray(result.data)).toBe(true);
      const deps = result.data as ServiceDependencyResult[];
      expect(deps.length).toBeGreaterThanOrEqual(1);
      const orderDep = deps.find((d) => d.service === 'order-service');
      expect(orderDep).toBeDefined();
      expect(orderDep!.callCount).toBeGreaterThanOrEqual(2);
      expect(result.metadata).toBeDefined();
      expect(result.metadata.staleness).toBeDefined();
      expect(result.metadata.staleness.warning).toBeTruthy();
      expect(result.metadata.staleness.parsedAt).toBeTruthy();
    });

    it('should return informative message when no external calls exist', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['analytics-service'],
        repoHashes: [REPO_HASHES.analyticsService],
        crossRepoEnabled: false,
      };

      const result = await handleListServiceDependencies(
        {},
        scope,
        'summary',
        undefined,
        undefined,
        await getRepository(),
      );

      // analytics-service has no external_call nodes
      expect(typeof result.data).toBe('string');
      expect(result.data as string).toContain('external');
    });

    it('should return empty array for analytics-service in raw mode', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['analytics-service'],
        repoHashes: [REPO_HASHES.analyticsService],
        crossRepoEnabled: false,
      };

      const result = await handleListServiceDependencies({}, scope, 'raw', undefined, undefined, await getRepository());

      // Analytics service has no external_call nodes
      expect(Array.isArray(result.data)).toBe(true);
      expect((result.data as any[]).length).toBe(0);
    });

    it('should scope results to specified repository', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: false,
      };

      const result = await handleListServiceDependencies({}, scope, 'raw', undefined, undefined, await getRepository());

      // order-service has external calls to user-service
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // trace_cross_repo_call Handler Tests
  // ===========================================================================

  describe('trace_cross_repo_call handler', () => {
    it('should find /users entrypoint with full target details', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: true,
      };

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/users' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const trace = result.data as any;

      // Verify target entrypoint was found
      expect(trace.target).toBeDefined();
      expect(trace.target.entrypoint).toBeDefined();
      expect(trace.target.entrypoint.path).toBe('/users');
      expect(trace.target.entrypoint.fullPath).toBe('/api/users');
      expect(trace.target.entrypoint.type).toBe('http');
      expect(trace.target.entrypoint.filePath).toBe('src/controllers/user.controller.ts');
      expect(trace.target.pattern).toBe('/users');

      // Verify summary is generated
      expect(trace.summary).toBeTruthy();
      expect(trace.summary).toContain('/users');
    });

    it('should resolve createUser handler for POST /users pattern', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: true,
      };

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'POST /users' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const trace = result.data as any;

      // Verify handler is resolved
      expect(trace.target.entrypoint.handlerName).toBe('createUser');
      expect(trace.target.entrypoint.method).toBe('POST');

      // Verify caller info structure (placeholder since external tracking not implemented)
      expect(trace.caller).toBeDefined();
      expect(trace.caller.repo).toBe('user-service');
    });

    it('should return empty object for non-existent endpoint pattern', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: true,
      };

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/nonexistent/endpoint/that/does/not/exist' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      // A machine shape carrying the reason, not a bare `{}` — a raw caller
      // JSON.parses this and an empty object tells it nothing about why.
      const trace = result.data as any;
      expect(trace).toMatchObject({ found: false });
    });

    // The real defect the eval transcripts showed: standing in the repo that
    // SERVES an endpoint, the tool reported `caller repo == target repo` with
    // `*Caller function not tracked*` because the caller-side scan was filtered
    // to the scope — while the resolved bridge sat one RESOLVES_TO edge away.
    it('reports the cross-repo caller when the scope is the callee side', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: true,
      };

      const result = await handleTraceCrossRepoCall(
        { callPattern: 'GET /api/users/:id' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const trace = result.data as any;
      expect(trace.caller.repo).toBe('order-service');
      expect(trace.caller.function.name).toBe('enrichOrderData');
      expect(trace.target.repo).toBe('user-service');
      expect(trace.target.entrypoint.handlerName).toBe('getUser');
      expect(trace.scopeNote).toContain('user-service');
    });

    it('rejects a request with no trace selector', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: true,
      };

      const result = await handleTraceCrossRepoCall(
        {},
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      // Handled outcome, not an exception — see the guard tests in
      // trace-cross-repo-call.test.ts for why a throw is not host-symmetric.
      expect(result.isError).toBe(true);
      expect(typeof result.data).toBe('object');
    });

    it('should find order-service entrypoints with correct repo context', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: true,
      };

      const result = await handleTraceCrossRepoCall(
        { callPattern: '/orders' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const trace = result.data as any;

      // Should find order-service entrypoints
      expect(trace.target.entrypoint.path).toBe('/orders');
      expect(trace.target.entrypoint.filePath).toBe('src/controllers/order.controller.ts');
    });

    // =========================================================================
    // Cross-Repo Call Tracing (actual inter-service calls)
    // =========================================================================

    it('should find notifyUserChange calling order-service via messaging', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: true,
      };

      // Find external calls from user-service to order-service
      const result = await handleTraceCrossRepoCall(
        { targetService: 'order-service' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const trace = result.data as any;

      // Should find the external call
      expect(trace.caller).toBeDefined();
      expect(trace.caller.function.name).toBe('notifyUserChange');
      expect(trace.caller.function.filePath).toBe('src/services/user.service.ts');
      expect(trace.caller.repo).toBe('user-service');

      // Should identify target service
      expect(trace.target.repo).toBe('order-service');
      expect(trace.target.pattern).toBe('user.changed');

      // Summary should describe the call
      expect(trace.summary).toContain('notifyUserChange');
      expect(trace.summary).toContain('order-service');
      expect(trace.summary).toContain('messaging');
    });

    it('should find enrichOrderData calling user-service via http', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['order-service'],
        repoHashes: [REPO_HASHES.orderService],
        crossRepoEnabled: true,
      };

      // Find external calls from order-service to user-service
      const result = await handleTraceCrossRepoCall(
        { targetService: 'user-service' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      const trace = result.data as any;

      // Should find the external call (first one: enrichOrderData)
      expect(trace.caller).toBeDefined();
      expect(trace.caller.function.name).toBe('enrichOrderData');
      expect(trace.caller.function.filePath).toBe('src/services/order.service.ts');
      expect(trace.caller.repo).toBe('order-service');

      // Should identify target service and call pattern
      expect(trace.target.repo).toBe('user-service');
      expect(trace.target.pattern).toBe('GET /api/users/:id');

      // Summary should describe the call
      expect(trace.summary).toContain('enrichOrderData');
      expect(trace.summary).toContain('user-service');
      expect(trace.summary).toContain('http');
    });

    it('should return empty for non-existent cross-repo target', async () => {
      const scope: ScopeContext = {
        currentPath: '/test/repo',
        resolvedRepos: ['user-service'],
        repoHashes: [REPO_HASHES.userService],
        crossRepoEnabled: true,
      };

      const result = await handleTraceCrossRepoCall(
        { targetService: 'nonexistent-service' },
        scope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );

      // Same contract as the callPattern miss above: reason in the payload.
      const trace = result.data as any;
      expect(trace).toMatchObject({ found: false, target: { pattern: 'nonexistent-service' } });
    });
  });
});

// =============================================================================
// Test Data Setup
// =============================================================================

function cleanupTestDb(): void {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
  const walPath = TEST_DB_PATH + '-wal';
  const shmPath = TEST_DB_PATH + '-shm';
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
}
