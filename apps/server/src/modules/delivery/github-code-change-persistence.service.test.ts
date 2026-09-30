import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { normalizePullRequest } from './github-normalizer.js';
import { GithubCodeChangePersistenceService } from './github-code-change-persistence.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTOR_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_REPO_ID = '33333333-3333-4333-8333-333333333333';
const CODE_CHANGE_ID = '44444444-4444-4444-8444-444444444444';

interface StoredChange {
  id: string;
  title: string | null;
  attrs: Record<string, unknown>;
}

function prismaError(code: 'P2002' | 'P2034'): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function normalized(title: string, prDetail?: Record<string, unknown>, reviews: unknown[] = []) {
  return normalizePullRequest(
    {
      number: 7,
      title,
      state: 'open',
      created_at: '2026-08-17T08:00:00.000Z',
      head: { ref: 'PROD-7-change' },
      base: { ref: 'main' },
    },
    reviews,
    [],
    [],
    prDetail,
  )!;
}

function input(sourceUpdatedAt: string, title: string, refreshEqual?: boolean) {
  return {
    workspaceId: WORKSPACE_ID,
    connectorId: CONNECTOR_ID,
    repoExternalId: 'synthetic/acme',
    externalId: '7',
    sourceUpdatedAt,
    workspaceRepoId: WORKSPACE_REPO_ID,
    norm: normalized(title),
    ...(refreshEqual === undefined ? {} : { refreshEqual }),
  };
}

function persistencePrisma(options?: {
  established?: StoredChange | null;
  concurrentAfterFirst?: StoredChange;
  createRace?: boolean;
  failTransactions?: Array<'P2002' | 'P2034'>;
}) {
  let row = options?.established ? structuredClone(options.established) : null;
  let transactionCalls = 0;
  let createRace = options?.createRace === true;
  const transactionOptions: unknown[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const creates: Array<Record<string, unknown>> = [];

  const tx = {
    codeChange: {
      findUnique: vi.fn(async () => (row ? structuredClone(row) : null)),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        creates.push(args.data);
        if (createRace) {
          createRace = false;
          row = {
            id: CODE_CHANGE_ID,
            title: args.data.title as string | null,
            attrs: structuredClone(args.data.attrs as Record<string, unknown>),
          };
          throw prismaError('P2002');
        }
        row = {
          id: CODE_CHANGE_ID,
          title: args.data.title as string | null,
          attrs: structuredClone(args.data.attrs as Record<string, unknown>),
        };
        return { id: row.id };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (!row) throw new Error('missing code change');
        updates.push(args.data);
        row = {
          ...row,
          title: args.data.title as string | null,
          attrs: structuredClone(args.data.attrs as Record<string, unknown>),
        };
        return { id: row.id };
      }),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>, txOptions?: unknown) => {
      transactionOptions.push(txOptions);
      const call = transactionCalls++;
      const forced = options?.failTransactions?.[call];
      if (forced) throw prismaError(forced);
      const result = await operation(tx);
      if (call === 0 && options?.concurrentAfterFirst) {
        // The first SERIALIZABLE transaction loses at commit. Its writes roll back;
        // the concurrently committed, fresher row is what the bounded retry must read.
        row = structuredClone(options.concurrentAfterFirst);
        throw prismaError('P2034');
      }
      return result;
    }),
  };

  return {
    prisma: prisma as unknown as PrismaService & typeof prisma,
    row: () => row,
    transactionCalls: () => transactionCalls,
    transactionOptions,
    updates,
    creates,
  };
}

function established(sourceUpdatedAt: string, title = 'established'): StoredChange {
  return {
    id: CODE_CHANGE_ID,
    title,
    attrs: { sourceUpdatedAt },
  };
}

describe('GithubCodeChangePersistenceService', () => {
  it('creates inside a SERIALIZABLE transaction and reports the applied disposition', async () => {
    const store = persistencePrisma();
    const service = new GithubCodeChangePersistenceService(store.prisma);

    await expect(service.persist(input('2026-08-17T10:00:00.000Z', 'created'))).resolves.toEqual({
      id: CODE_CHANGE_ID,
      applied: 'created',
    });

    expect(store.transactionOptions).toEqual([{ isolationLevel: 'Serializable' }]);
    expect(store.row()).toMatchObject({
      id: CODE_CHANGE_ID,
      title: 'created',
      attrs: expect.objectContaining({ sourceUpdatedAt: '2026-08-17T10:00:00.000Z' }),
    });
  });

  it('persists detail-only fields as values (zeros included) and list-shaped absence as NULL', async () => {
    const detailStore = persistencePrisma();
    const detailService = new GithubCodeChangePersistenceService(detailStore.prisma);
    await detailService.persist({
      ...input('2026-08-17T10:00:00.000Z', 'detailed'),
      norm: normalized('detailed', { html_url: 'https://github.com/acme/repo/pull/7', comments: 0 }, [
        { state: 'APPROVED' },
        { state: 'COMMENTED' },
        { state: 'CHANGES_REQUESTED' },
      ]),
    });
    expect(detailStore.creates[0]).toMatchObject({
      externalUrl: 'https://github.com/acme/repo/pull/7',
      commentCount: 0,
      reviewCount: 3,
    });

    const listStore = persistencePrisma();
    const listService = new GithubCodeChangePersistenceService(listStore.prisma);
    await listService.persist(input('2026-08-17T10:00:00.000Z', 'list-shaped'));
    expect(listStore.creates[0]).toMatchObject({
      externalUrl: null,
      commentCount: null,
      reviewCount: null,
    });
  });

  it('keeps established detail-only values when a fresher LIST-shaped observation wins', async () => {
    const store = persistencePrisma();
    const service = new GithubCodeChangePersistenceService(store.prisma);

    // A detail-shaped pass establishes the trio.
    await service.persist({
      ...input('2026-08-17T10:00:00.000Z', 'detailed'),
      norm: normalized('detailed', { html_url: 'https://github.com/acme/repo/pull/7', comments: 4 }, [
        { state: 'APPROVED' },
      ]),
    });
    expect(store.creates[0]).toMatchObject({
      externalUrl: 'https://github.com/acme/repo/pull/7',
      commentCount: 4,
      reviewCount: 1,
    });

    // A later, FRESHER pass without the detail body (getPull degraded to {}) wins on
    // freshness and rewrites the row — but it saw nothing about these three fields, so it
    // must not null them. Omission, not `null`, is what preserves them.
    await service.persist({
      ...input('2026-08-17T11:00:00.000Z', 'list-shaped refresh'),
      norm: normalized('list-shaped refresh'),
    });
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).not.toHaveProperty('externalUrl');
    expect(store.updates[0]).not.toHaveProperty('reviewCount');
    expect(store.updates[0]).not.toHaveProperty('commentCount');
    // The rest of the payload is still written in full.
    expect(store.updates[0]).toMatchObject({ title: 'list-shaped refresh', reviewRounds: 0 });
  });

  it('lets a fresher detail-shaped observation overwrite the trio, genuine zeros included', async () => {
    const store = persistencePrisma();
    const service = new GithubCodeChangePersistenceService(store.prisma);

    await service.persist({
      ...input('2026-08-17T10:00:00.000Z', 'detailed'),
      norm: normalized('detailed', { html_url: 'https://github.com/acme/repo/pull/7', comments: 4 }, [
        { state: 'APPROVED' },
      ]),
    });

    // Comments deleted and the review dismissed upstream: a detail-shaped 0 is an
    // OBSERVATION and must land, which is why the patch decision reads detailShaped
    // rather than "all three are empty".
    await service.persist({
      ...input('2026-08-17T11:00:00.000Z', 'detailed again'),
      norm: normalized('detailed again', { html_url: 'https://github.com/acme/repo/pull/7-renamed', comments: 0 }, []),
    });
    expect(store.updates[0]).toMatchObject({
      externalUrl: 'https://github.com/acme/repo/pull/7-renamed',
      commentCount: 0,
      reviewCount: 0,
    });
  });

  it('treats equal freshness as a duplicate by default, but refreshEqual upgrades a stale normalizer row', async () => {
    const duplicateStore = persistencePrisma({
      established: established('2026-08-17T10:00:00.000Z'),
    });
    const duplicate = new GithubCodeChangePersistenceService(duplicateStore.prisma);

    await expect(duplicate.persist(input('2026-08-17T10:00:00.000Z', 'must not replace'))).resolves.toEqual({
      id: CODE_CHANGE_ID,
      applied: 'duplicate',
    });
    expect(duplicateStore.updates).toEqual([]);

    const refreshStore = persistencePrisma({
      established: established('2026-08-17T10:00:00.000Z'),
    });
    const refresh = new GithubCodeChangePersistenceService(refreshStore.prisma);
    await expect(refresh.persist(input('2026-08-17T10:00:00.000Z', 'renormalized', true))).resolves.toEqual({
      id: CODE_CHANGE_ID,
      applied: 'updated',
    });
    expect(refreshStore.row()?.title).toBe('renormalized');
  });

  it('updates a strictly newer observation and refuses a strictly older observation', async () => {
    const newerStore = persistencePrisma({
      established: established('2026-08-17T09:00:00.000Z'),
    });
    const newer = new GithubCodeChangePersistenceService(newerStore.prisma);
    await expect(newer.persist(input('2026-08-17T10:00:00.000Z', 'newer'))).resolves.toMatchObject({
      applied: 'updated',
    });
    expect(newerStore.row()?.title).toBe('newer');

    const olderStore = persistencePrisma({
      established: established('2026-08-17T11:00:00.000Z', 'keep me'),
    });
    const older = new GithubCodeChangePersistenceService(olderStore.prisma);
    await expect(older.persist(input('2026-08-17T10:00:00.000Z', 'older'))).resolves.toEqual({
      id: CODE_CHANGE_ID,
      applied: 'stale',
    });
    expect(olderStore.row()?.title).toBe('keep me');
    expect(olderStore.updates).toEqual([]);
  });

  it('retries P2034 once and re-evaluates freshness so an interleaved older write becomes a no-op', async () => {
    const store = persistencePrisma({
      established: established('2026-08-17T09:00:00.000Z'),
      concurrentAfterFirst: established('2026-08-17T11:00:00.000Z', 'concurrent winner'),
    });
    const service = new GithubCodeChangePersistenceService(store.prisma);

    await expect(service.persist(input('2026-08-17T10:00:00.000Z', 'losing interleave'))).resolves.toEqual({
      id: CODE_CHANGE_ID,
      applied: 'stale',
    });

    expect(store.transactionCalls()).toBe(2);
    expect(store.transactionOptions).toEqual([{ isolationLevel: 'Serializable' }, { isolationLevel: 'Serializable' }]);
    expect(store.row()?.title).toBe('concurrent winner');
  });

  it('retries a concurrent first-write P2002 once and returns the established duplicate', async () => {
    const store = persistencePrisma({ createRace: true });
    const service = new GithubCodeChangePersistenceService(store.prisma);

    await expect(service.persist(input('2026-08-17T10:00:00.000Z', 'winner'))).resolves.toEqual({
      id: CODE_CHANGE_ID,
      applied: 'duplicate',
    });
    expect(store.transactionCalls()).toBe(2);
    expect(store.creates).toHaveLength(1);
  });

  it.each(['P2034', 'P2002'] as const)('bounds %s handling to one retry', async (code) => {
    const store = persistencePrisma({ failTransactions: [code, code, code] });
    const service = new GithubCodeChangePersistenceService(store.prisma);

    await expect(service.persist(input('2026-08-17T10:00:00.000Z', 'never written'))).rejects.toMatchObject({ code });
    expect(store.transactionCalls()).toBe(2);
  });
});
