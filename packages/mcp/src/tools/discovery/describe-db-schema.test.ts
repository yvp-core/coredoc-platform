/**
 * Tests for the describe_db_schema tool handler + formatDbSchema rendering.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleDescribeDbSchema } from './describe-db-schema.js';
import type { ScopeContext, DbSchemaEntity } from '../../types.js';
import { resolveDetailLevel } from '../../detail-level.js';

// Mock only the db boundary; use the REAL response formatter so the rendered
// output is exercised end-to-end (the handler is passed an explicit repository,
// so getRepository is never actually invoked).
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

import { getRepository } from '@coredoc/db';
import { createMockRepository, createMockEntityInfo } from '../../__tests__/fixtures/mock-repository.js';

const userFields = [
  {
    name: 'id',
    columnName: 'id',
    type: { text: 'string' },
    dbType: 'uuid',
    isPrimaryKey: true,
    isNullable: false,
    isUnique: true,
    isGenerated: true,
  },
  {
    name: 'email',
    columnName: 'email_address',
    type: { text: 'string' },
    isPrimaryKey: false,
    isNullable: true,
    isUnique: true,
    isGenerated: false,
  },
];
const userRelations = [
  { name: 'posts', type: 'one-to-many' as const, targetEntityName: 'Post', joinColumn: 'user_id' },
];

const userEntity = createMockEntityInfo({
  id: 'abc123:entity:src/user.ts:User',
  name: 'User',
  tableName: 'users',
  ormType: 'typeorm',
  filePath: 'src/user.ts',
  startLine: 5,
  fields: userFields,
  relations: userRelations,
});

describe('describe_db_schema Tool Handler', () => {
  let mockScope: ScopeContext;
  const detailConfig = resolveDetailLevel('full');

  beforeEach(() => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-repo'],
      repoHashes: ['abc123def456'],
      crossRepoEnabled: false,
    };
    vi.clearAllMocks();
  });

  describe('whole-schema dump (no entityName)', () => {
    it('lists every entity with full columns/relations when detailLevel=full', async () => {
      const postEntity = createMockEntityInfo({
        id: 'abc123:entity:src/post.ts:Post',
        name: 'Post',
        tableName: 'posts',
        fields: [],
        relations: [],
      });
      const mockRepo = createMockRepository({
        listEntities: vi.fn().mockResolvedValue([userEntity, postEntity]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      // Explicit detailLevel:full in args opts into full per-column detail.
      const result = await handleDescribeDbSchema(
        { detailLevel: 'full' },
        mockScope,
        'summary',
        'full',
        detailConfig,
        mockRepo,
      );

      expect(mockRepo.listEntities).toHaveBeenCalledWith(mockScope.repoHashes);
      expect(mockRepo.findEntity).not.toHaveBeenCalled();
      const text = result.data as string;
      expect(text).toContain('DB Schema — 2 table(s)');
      expect(text).toContain('`User` — table `users`');
      expect(text).toContain('`email` → `email_address`: string [unique, nullable]');
      expect(text).toContain('`posts` → Post (one-to-many, join: user_id)');
    });

    it('defaults the whole-schema dump to a compact overview', async () => {
      const mockRepo = createMockRepository({
        listEntities: vi.fn().mockResolvedValue([userEntity]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeDbSchema({}, mockScope, 'summary', 'full', detailConfig, mockRepo);

      const text = result.data as string;
      // Compact one-liner, not the full per-column detail.
      expect(text).toContain('`User` (table `users`): id, email');
      expect(text).not.toContain('**Columns');
      expect(text).toContain('Compact view');
    });

    it('requires an explicit single-repo scope (errors when scope spans many)', async () => {
      const mockRepo = createMockRepository({
        listEntities: vi.fn().mockResolvedValue([userEntity]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const multiRepoScope = { ...mockScope, repoHashes: ['hashA', 'hashB'], resolvedRepos: ['a', 'b'] };
      const result = await handleDescribeDbSchema({}, multiRepoScope, 'summary', 'full', detailConfig, mockRepo);

      expect(result.isError).toBe(true);
      expect(result.data).toContain('Pass `scope`');
      expect(mockRepo.listEntities).not.toHaveBeenCalled();
    });

    it('returns structured rows in raw format', async () => {
      const mockRepo = createMockRepository({
        listEntities: vi.fn().mockResolvedValue([userEntity]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeDbSchema({}, mockScope, 'raw', 'full', detailConfig, mockRepo);

      const rows = result.data as DbSchemaEntity[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tableName).toBe('users');
      expect(rows[0]!.fields).toEqual(userFields);
      expect(rows[0]!.relations).toEqual(userRelations);
    });
  });

  describe('single-entity deep-dive (entityName)', () => {
    it('resolves one entity via findEntity', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(userEntity),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeDbSchema(
        { entityName: 'User' },
        mockScope,
        'summary',
        'full',
        detailConfig,
        mockRepo,
      );

      expect(mockRepo.findEntity).toHaveBeenCalledWith('User', mockScope.repoHashes);
      expect(mockRepo.listEntities).not.toHaveBeenCalled();
      const text = result.data as string;
      expect(text).toContain('## DB Schema');
      expect(text).toContain('`id`: uuid [PK, unique, generated]');
    });

    it('flags not-found with isError', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeDbSchema(
        { entityName: 'Ghost' },
        mockScope,
        'summary',
        'full',
        detailConfig,
        mockRepo,
      );

      expect(result.isError).toBe(true);
      expect(result.data).toContain("Entity 'Ghost' not found");
    });
  });

  describe('detailLevel', () => {
    it("collapses each table to a one-line column list when detailLevel='basic'", async () => {
      const mockRepo = createMockRepository({
        listEntities: vi.fn().mockResolvedValue([userEntity]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeDbSchema(
        {},
        mockScope,
        'summary',
        'basic',
        resolveDetailLevel('basic'),
        mockRepo,
      );

      const text = result.data as string;
      // Compact one-liner: table + column names, no per-column flag detail.
      expect(text).toContain('`User` (table `users`): id, email');
      expect(text).not.toContain('**Columns');
    });
  });

  describe('enum value inlining', () => {
    const enumEntity = createMockEntityInfo({
      name: 'Webhook',
      tableName: 'webhooks',
      fields: [
        {
          name: 'status',
          columnName: 'status',
          type: { text: 'WebhookStatus' },
          isPrimaryKey: false,
          isNullable: false,
          isUnique: false,
          isGenerated: false,
        },
      ],
      relations: [],
    });

    it('inlines the value-set for a same-repo enum-typed column', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(enumEntity),
        findEnum: vi.fn((name: string) =>
          Promise.resolve(
            name === 'WebhookStatus'
              ? {
                  id: 'e',
                  name: 'WebhookStatus',
                  filePath: 'f',
                  startLine: 1,
                  endLine: 2,
                  isExported: true,
                  members: [
                    { name: 'Active', value: 'active' },
                    { name: 'Paused', value: 'paused' },
                  ],
                }
              : null,
          ),
        ),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeDbSchema(
        { entityName: 'Webhook' },
        mockScope,
        'summary',
        'full',
        detailConfig,
        mockRepo,
      );

      expect(mockRepo.findEnum).toHaveBeenCalledWith('WebhookStatus', mockScope.repoHashes);
      expect(result.data).toContain('`status`: WebhookStatus {active, paused}');
    });

    it('leaves an unresolved (cross-package) enum column unchanged — fail-soft', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            name: 'Shift',
            tableName: 'shifts',
            fields: [
              {
                name: 'status',
                columnName: 'status',
                type: { text: 'ShiftStatusEnum' },
                isPrimaryKey: false,
                isNullable: false,
                isUnique: false,
                isGenerated: false,
              },
            ],
            relations: [],
          }),
        ),
        findEnum: vi.fn().mockResolvedValue(null), // imported from another repo → not found
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeDbSchema(
        { entityName: 'Shift' },
        mockScope,
        'summary',
        'full',
        detailConfig,
        mockRepo,
      );

      expect(result.data).toContain('`status`: ShiftStatusEnum');
      expect(result.data).not.toContain('ShiftStatusEnum {');
    });
  });
});
