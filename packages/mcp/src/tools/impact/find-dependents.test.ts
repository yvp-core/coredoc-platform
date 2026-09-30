/**
 * Tests for the get_dependents tool handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { TypeUseKind } from '@coredoc/db/types';
import { handleFindDependents } from './find-dependents.js';
import type { ScopeContext, CodeElementInfo } from '../../types.js';
import { resolveDetailLevel } from '../../detail-level.js';

// Mock database abstraction layer
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatCodeElementList: vi.fn((elements, title, metadata) => {
    if (metadata.format === 'raw') {
      return { data: elements, metadata };
    }
    const summary = `## ${title} (${elements.length})`;
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
import {
  createMockRepository,
  createMockClassInfo,
  createMockInterfaceInfo,
} from '../../__tests__/fixtures/mock-repository.js';

describe('get_dependents Tool Handler', () => {
  let mockScope: ScopeContext;
  const defaultDetailConfig = resolveDetailLevel('full');

  beforeEach(() => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-repo'],
      repoHashes: ['abc123def456'],
      crossRepoEnabled: false,
    };

    vi.clearAllMocks();
  });

  // ===========================================================================
  // Basic Functionality Tests - Class Extensions
  // ===========================================================================

  describe('Class Extensions', () => {
    it('should find classes that extend a base class', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(
          createMockClassInfo({
            id: 'abc123:class:src/base.ts:BaseService',
            name: 'BaseService',
            filePath: 'src/base.ts',
            startLine: 5,
            endLine: 20,
          }),
        ),
        getClassExtensions: vi.fn().mockResolvedValue([
          createMockClassInfo({
            id: 'abc123:class:src/user-service.ts:UserService',
            name: 'UserService',
            filePath: 'src/user-service.ts',
            startLine: 10,
            endLine: 50,
          }),
          createMockClassInfo({
            id: 'abc123:class:src/product-service.ts:ProductService',
            name: 'ProductService',
            filePath: 'src/product-service.ts',
            startLine: 8,
            endLine: 40,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'BaseService', type: 'class' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const dependents = result.data as CodeElementInfo[];
      expect(dependents).toHaveLength(2);
      expect(dependents[0]!.name).toBe('UserService');
      expect(dependents[0]!.type).toBe('class');
      expect(dependents[1]!.name).toBe('ProductService');
      expect(mockRepo.findClass).toHaveBeenCalledWith('BaseService', mockScope.repoHashes);
      expect(mockRepo.getClassExtensions).toHaveBeenCalled();
    });

    it('should handle class with no extensions', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(
          createMockClassInfo({
            id: 'abc123:class:src/util.ts:UtilClass',
            name: 'UtilClass',
            filePath: 'src/util.ts',
            startLine: 5,
            endLine: 15,
          }),
        ),
        getClassExtensions: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'UtilClass', type: 'class' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });

    it('should skip extensions when includeExtensions is false', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(
          createMockClassInfo({
            id: 'abc123:class:src/base.ts:BaseService',
            name: 'BaseService',
            filePath: 'src/base.ts',
            startLine: 5,
            endLine: 20,
          }),
        ),
        getClassExtensions: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleFindDependents(
        { name: 'BaseService', type: 'class', includeExtensions: false },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      // Should not call getClassExtensions when includeExtensions is false
      expect(mockRepo.getClassExtensions).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Interface Implementations
  // ===========================================================================

  describe('Interface Implementations', () => {
    it('should find classes that implement an interface', async () => {
      const mockRepo = createMockRepository({
        findInterface: vi.fn().mockResolvedValue(
          createMockInterfaceInfo({
            id: 'abc123:interface:src/interfaces.ts:Repository',
            name: 'Repository',
            filePath: 'src/interfaces.ts',
            startLine: 3,
            endLine: 10,
          }),
        ),
        getInterfaceImplementations: vi.fn().mockResolvedValue([
          createMockClassInfo({
            id: 'abc123:class:src/user-repo.ts:UserRepository',
            name: 'UserRepository',
            filePath: 'src/user-repo.ts',
            startLine: 15,
            endLine: 60,
          }),
          createMockClassInfo({
            id: 'abc123:class:src/product-repo.ts:ProductRepository',
            name: 'ProductRepository',
            filePath: 'src/product-repo.ts',
            startLine: 12,
            endLine: 55,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'Repository', type: 'interface' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const dependents = result.data as CodeElementInfo[];
      expect(dependents).toHaveLength(2);
      expect(dependents[0]!.name).toBe('UserRepository');
      expect(dependents[0]!.type).toBe('class');
      expect(dependents[1]!.name).toBe('ProductRepository');
    });

    it('should handle interface with no implementations', async () => {
      const mockRepo = createMockRepository({
        findInterface: vi.fn().mockResolvedValue(
          createMockInterfaceInfo({
            id: 'abc123:interface:src/interfaces.ts:EmptyInterface',
            name: 'EmptyInterface',
            filePath: 'src/interfaces.ts',
            startLine: 20,
            endLine: 25,
          }),
        ),
        getInterfaceImplementations: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'EmptyInterface', type: 'interface' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle type not found', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'NonExistentClass', type: 'class' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('not found');
    });

    it('should return empty array for type not found in raw mode', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'NonExistentClass', type: 'class' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });

    it('should handle endLine as undefined', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(
          createMockClassInfo({
            id: 'abc123:class:src/base.ts:BaseClass',
            name: 'BaseClass',
            filePath: 'src/base.ts',
            startLine: 10,
            endLine: undefined,
          }),
        ),
        getClassExtensions: vi.fn().mockResolvedValue([
          createMockClassInfo({
            id: 'abc123:class:src/child.ts:ChildClass',
            name: 'ChildClass',
            filePath: 'src/child.ts',
            startLine: 20,
            endLine: undefined,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'BaseClass', type: 'class' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const dependents = result.data as CodeElementInfo[];
      expect(dependents[0]!.endLine).toBeUndefined();
    });
  });

  // ===========================================================================
  // Output Format Tests
  // ===========================================================================

  describe('Output Formats', () => {
    it('should format output as summary by default', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(
          createMockClassInfo({
            id: 'abc123:class:src/base.ts:BaseClass',
            name: 'BaseClass',
            filePath: 'src/base.ts',
            startLine: 5,
            endLine: 20,
          }),
        ),
        getClassExtensions: vi.fn().mockResolvedValue([
          createMockClassInfo({
            id: 'abc123:class:src/child.ts:ChildClass',
            name: 'ChildClass',
            filePath: 'src/child.ts',
            startLine: 10,
            endLine: 30,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'BaseClass', type: 'class' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Dependents of BaseClass');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(
          createMockClassInfo({
            id: 'abc123:class:src/base.ts:BaseClass',
            name: 'BaseClass',
            filePath: 'src/base.ts',
            startLine: 5,
            endLine: 20,
          }),
        ),
        getClassExtensions: vi.fn().mockResolvedValue([
          createMockClassInfo({
            id: 'abc123:class:src/child.ts:ChildClass',
            name: 'ChildClass',
            filePath: 'src/child.ts',
            startLine: 10,
            endLine: 30,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'BaseClass', type: 'class' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(Array.isArray(result.data)).toBe(true);
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Cross-Repo Tests
  // ===========================================================================

  describe('Cross-Repo Scope', () => {
    it('should handle multiple repo hashes in scope', async () => {
      const multiRepoScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['repo1', 'repo2'],
        repoHashes: ['abc123def456', 'xyz789ghi012'],
        crossRepoEnabled: true,
        project: 'test-group',
      };

      const mockRepo = createMockRepository({
        findInterface: vi.fn().mockResolvedValue(
          createMockInterfaceInfo({
            id: 'abc123:interface:src/shared.ts:SharedInterface',
            name: 'SharedInterface',
            filePath: 'src/shared.ts',
            startLine: 5,
            endLine: 15,
          }),
        ),
        getInterfaceImplementations: vi.fn().mockResolvedValue([
          createMockClassInfo({
            id: 'abc123:class:src/impl1.ts:Implementation1',
            name: 'Implementation1',
            filePath: 'src/impl1.ts',
            startLine: 10,
            endLine: 30,
          }),
          createMockClassInfo({
            id: 'xyz789:class:src/impl2.ts:Implementation2',
            name: 'Implementation2',
            filePath: 'src/impl2.ts',
            startLine: 15,
            endLine: 40,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'SharedInterface', type: 'interface' },
        multiRepoScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const dependents = result.data as CodeElementInfo[];
      expect(dependents).toHaveLength(2);
      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
    });

    it('represents cross-repo package importers honestly as files', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: 'provider123:enum:src/enums.ts:BookingTypes',
            name: 'BookingTypes',
            type: 'enum',
            filePath: 'src/enums.ts',
            startLine: 1,
          },
        ]),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'consumer456:file:src/use-booking.ts',
            name: 'src/use-booking.ts',
            type: 'file',
            filePath: 'src/use-booking.ts',
            startLine: 0,
            usage: 'import',
            via: 'BookingKind',
            ambiguous: false,
          },
        ]),
      });

      const result = await handleFindDependents(
        { name: 'BookingTypes', type: 'enum' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([
        expect.objectContaining({
          id: 'consumer456:file:src/use-booking.ts',
          name: 'src/use-booking.ts',
          type: 'file',
          summary: 'imports BookingTypes (as BookingKind)',
        }),
      ]);
    });

    it('labels a value-position enum consumer distinctly from a type-position one', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: 'abc123:enum:src/status.ts:Status',
            name: 'Status',
            type: 'enum',
            filePath: 'src/status.ts',
            startLine: 1,
          },
        ]),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'abc123:function:src/render.ts:render',
            name: 'render',
            type: 'function',
            filePath: 'src/render.ts',
            startLine: 10,
            usage: 'parameter',
            via: 'status',
            ambiguous: false,
          },
          {
            id: 'abc123:function:src/guard.ts:isLocked',
            name: 'isLocked',
            type: 'function',
            filePath: 'src/guard.ts',
            startLine: 4,
            usage: 'member-access',
            useKind: TypeUseKind.Value,
            member: 'Locked',
            ambiguous: false,
          },
        ]),
      });

      const result = await handleFindDependents(
        { name: 'Status', type: 'enum' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const dependents = result.data as CodeElementInfo[];
      expect(dependents.map((d) => d.summary)).toEqual([
        'used as parameter (status)',
        'used as member-access — branches on Status.Locked (value)',
      ]);
    });

    it('carries unverified identity as a structured flag that survives basic detail, leaving name clean', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: 'abc123:enum:src/status.ts:Status',
            name: 'Status',
            type: 'enum',
            filePath: 'src/status.ts',
            startLine: 1,
          },
        ]),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'abc123:function:src/guard.ts:isLocked',
            name: 'isLocked',
            type: 'function',
            filePath: 'src/guard.ts',
            startLine: 4,
            usage: 'parameter',
            via: 'status',
            ambiguous: true,
          },
        ]),
      });

      const result = await handleFindDependents(
        { name: 'Status', type: 'enum' },
        mockScope,
        'raw',
        'basic',
        resolveDetailLevel('basic'),
        mockRepo,
      );

      const dependents = result.data as CodeElementInfo[];
      // The trust signal is a structured flag, NOT baked into the machine-readable
      // identity: `name` and `id` stay usable for a follow-up `explain`, and the flag
      // survives the basic filter.
      expect(dependents[0]!.name).toBe('isLocked');
      expect(dependents[0]!.id).toBe('abc123:function:src/guard.ts:isLocked');
      expect(dependents[0]!.ambiguous).toBe(true);
    });

    // find_dependents is basic-by-default and its ONE relationship datum travels
    // in `summary`. Stripping it made the DEFAULT response a list of dependents
    // that never says how anything depends — including the enum member a
    // value-position consumer branches on, which is the point of the feature.
    it('keeps the relationship datum at the default (basic) detail level', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: 'abc123:enum:src/status.ts:Status',
            name: 'Status',
            type: 'enum',
            filePath: 'src/status.ts',
            startLine: 1,
          },
        ]),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'abc123:function:src/guard.ts:isLocked',
            name: 'isLocked',
            type: 'function',
            filePath: 'src/guard.ts',
            startLine: 4,
            usage: 'member-access',
            useKind: TypeUseKind.Value,
            member: 'Locked',
            ambiguous: false,
          },
          {
            id: 'abc123:function:src/render.ts:render',
            name: 'render',
            type: 'function',
            filePath: 'src/render.ts',
            startLine: 10,
            usage: 'parameter',
            via: 'status',
            ambiguous: false,
          },
        ]),
      });

      const result = await handleFindDependents(
        { name: 'Status', type: 'enum' },
        mockScope,
        'raw',
        'basic',
        resolveDetailLevel('basic'),
        mockRepo,
      );

      const dependents = result.data as CodeElementInfo[];
      expect(dependents.map((d) => d.summary)).toEqual([
        'used as member-access — branches on Status.Locked (value)',
        'used as parameter (status)',
      ]);
    });

    it('lists the constructing function and the importing file as dependents of a class', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue({ id: 'abc123:class:src/service.ts:UserService', name: 'UserService' }),
        getClassExtensions: vi.fn().mockResolvedValue([]),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'abc123:function:src/a.ts:build',
            name: 'build',
            type: 'function',
            filePath: 'src/a.ts',
            startLine: 4,
            usage: 'construction',
            useKind: TypeUseKind.Value,
            ambiguous: false,
          },
          {
            id: 'abc123:file:src/b.ts',
            name: 'src/b.ts',
            type: 'file',
            filePath: 'src/b.ts',
            startLine: 0,
            usage: 'import',
            ambiguous: false,
          },
        ]),
      });

      const result = await handleFindDependents(
        { name: 'UserService', type: 'class' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const dependents = result.data as CodeElementInfo[];
      expect(dependents.map((d) => ({ type: d.type, summary: d.summary }))).toEqual([
        { type: 'function', summary: 'constructs UserService' },
        { type: 'file', summary: 'imports UserService' },
      ]);
    });

    it('renders a usage row without useKind exactly as before', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: 'abc123:enum:src/status.ts:Status',
            name: 'Status',
            type: 'enum',
            filePath: 'src/status.ts',
            startLine: 1,
          },
        ]),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'abc123:function:src/render.ts:render',
            name: 'render',
            type: 'function',
            filePath: 'src/render.ts',
            startLine: 10,
            usage: 'parameter',
            via: 'status',
            ambiguous: false,
          },
        ]),
      });

      const result = await handleFindDependents(
        { name: 'Status', type: 'enum' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect((result.data as CodeElementInfo[])[0].summary).toBe('used as parameter (status)');
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'Test', type: 'class' },
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
        findClass: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { name: 'Test', type: 'class' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.staleness).toBeDefined();
      expect(result.metadata.staleness.warning).toBe('Data reflects parsed stable branch, not local changes');
    });

    it('should include format in metadata', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const summaryResult = await handleFindDependents(
        { name: 'Test', type: 'class' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(summaryResult.metadata.format).toBe('summary');

      const rawResult = await handleFindDependents(
        { name: 'Test', type: 'class' },
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
  // Argument addressing — `explain` names its subject `target`, so agents reach
  // for `target` here too. It used to produce "undefined 'undefined' not found
  // in scope" on names that were in the graph all along.
  // ===========================================================================

  describe('target alias and missing arguments', () => {
    it('accepts `target` as an alias for `name`', async () => {
      const mockRepo = createMockRepository({
        findClass: vi
          .fn()
          .mockResolvedValue(createMockClassInfo({ id: 'abc:class:src/base.ts:BaseService', name: 'BaseService' })),
        getClassExtensions: vi.fn().mockResolvedValue([]),
        getTypeUsages: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { target: 'BaseService', type: 'class' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.findClass).toHaveBeenCalledWith('BaseService', mockScope.repoHashes);
      expect(result.data).toContain('Dependents of BaseService');
    });

    it('infers the type when it was omitted and the name resolves to one supported kind', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: 'abc:interface:src/p.ts:Bookingable',
            name: 'Bookingable',
            type: 'interface',
            filePath: 'src/p.ts',
            startLine: 1,
          },
        ]),
        findInterface: vi
          .fn()
          .mockResolvedValue(
            createMockInterfaceInfo({ id: 'abc:interface:src/p.ts:Bookingable', name: 'Bookingable' }),
          ),
        getInterfaceImplementations: vi.fn().mockResolvedValue([]),
        getTypeUsages: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { target: 'Bookingable' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Dependents of Bookingable');
    });

    it('redirects to find_callers when the name is a function, not a type', async () => {
      // Measured on supabase: `UsersV2` / `useBackupsQuery` are exported-const
      // React components and hooks — functions in the graph, so find_dependents
      // has nothing to resolve. Name the right tool instead of "not found".
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: 'abc:function:src/u.tsx:UsersV2',
            name: 'UsersV2',
            type: 'function',
            filePath: 'src/u.tsx',
            startLine: 92,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents(
        { target: 'UsersV2' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('find_callers');
      expect(result.data).toContain('UsersV2');
    });

    it('errors explicitly when no name/target was passed at all', async () => {
      const mockRepo = createMockRepository({});
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindDependents({}, mockScope, 'summary', 'full', defaultDetailConfig, mockRepo);

      expect(result.data).toContain('`name`');
      expect(result.data).not.toContain('undefined');
    });
  });
});
