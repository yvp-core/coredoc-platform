import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { graphRepoHashOf } from './repo-intent-identity.js';
import { ReposService } from './repos.service.js';

describe('ReposService.getRepoState', () => {
  it('reports published metadata while retaining the upload timestamp', async () => {
    const controlPlane = {
      listRepos: vi.fn(async () => [
        {
          repoKey: 'repo:demo',
          repoName: 'demo',
          lastParseHash: 'parse_applied',
          lastPushedAt: new Date('2026-08-13T10:00:00.000Z'),
          lastPushedByUserId: 'user_1',
          nodeCount: 10,
          edgeCount: 20,
          lastSummaryVersion: 'sum_applied',
          lastEmbedVersion: 'emb_applied',
        },
      ]),
    };
    const resultStorage = {
      getManifest: vi.fn(async () => ({
        currentSummary: 'sum_uploaded_but_not_published',
        summaryUploadedAt: '2026-08-13T10:01:00.000Z',
      })),
    };
    // `getRepoState` is a control-plane read: every repo write, identity
    // binding included, now goes through the control plane's locked
    // transaction, so this service holds no Prisma client of its own.
    const service = new ReposService(controlPlane as never, resultStorage as never);

    await expect(service.getRepoState('ws_1', 'demo')).resolves.toMatchObject({
      lastParseHash: 'parse_applied',
      currentSummaryVersion: 'sum_applied',
      currentEmbeddingsVersion: 'emb_applied',
      summaryUploadedAt: '2026-08-13T10:01:00.000Z',
    });
  });
});

/* ------------------------------------------------ atomic connect / update --- */
//
// The defect these cover: the durable-identity write used to run OUTSIDE the
// locked transaction that creates or updates the row. A failure between the two
// left a repo connected but permanently unbound — and the obvious retry answers
// "already connected", so the caller had no remedy. Both writes now share one
// transaction, which is what the "nothing committed" assertions prove.

interface FakeRepoRow {
  workspaceId: string;
  repoKey: string;
  repoName: string;
  httpPrefix: string | null;
  intentRepoKey: string | null;
  normalizedGitRemote: string | null;
}

/**
 * A control plane whose `withRepositoryLock` behaves like a transaction: the
 * callback mutates a COPY, and the copy is only published when it resolves.
 */
function fakeControlPlane(rows: FakeRepoRow[] = [], failIdentityWrite?: () => never) {
  const committed = rows.map((row) => ({ ...row }));
  const state = { committed, transactions: 0 };

  const transactionClient = (staged: FakeRepoRow[]) => ({
    workspaceRepo: {
      async create({ data }: { data: FakeRepoRow }) {
        if (staged.some((row) => row.workspaceId === data.workspaceId && row.repoKey === data.repoKey)) {
          throw new Error('Unique constraint failed on the fields: (`workspaceId`,`repoKey`)');
        }
        const row = { intentRepoKey: null, normalizedGitRemote: null, httpPrefix: null, ...data };
        staged.push(row);
        return row;
      },
      async findUnique({ where }: { where: { workspaceId_repoKey: { workspaceId: string; repoKey: string } } }) {
        const { workspaceId, repoKey } = where.workspaceId_repoKey;
        return staged.find((row) => row.workspaceId === workspaceId && row.repoKey === repoKey) ?? null;
      },
      async update({
        where,
        data,
      }: {
        where: { workspaceId_repoKey: { workspaceId: string; repoKey: string } };
        data: Partial<FakeRepoRow>;
      }) {
        const { workspaceId, repoKey } = where.workspaceId_repoKey;
        const row = staged.find((candidate) => candidate.workspaceId === workspaceId && candidate.repoKey === repoKey);
        if (!row) throw new Error('Record to update not found.');
        Object.assign(row, data);
        return row;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { workspaceId: string; repoKey: string; OR?: Array<{ intentRepoKey: string | null }> };
        data: Partial<FakeRepoRow>;
      }) {
        failIdentityWrite?.();
        const row = staged.find(
          (candidate) => candidate.workspaceId === where.workspaceId && candidate.repoKey === where.repoKey,
        );
        if (!row) return { count: 0 };
        if (where.OR && !where.OR.some((clause) => clause.intentRepoKey === row.intentRepoKey)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  });

  const controlPlane = {
    async withRepositoryLock<T>(_workspaceId: string, work: (tx: ReturnType<typeof transactionClient>) => Promise<T>) {
      state.transactions += 1;
      const staged = state.committed.map((row) => ({ ...row }));
      const result = await work(transactionClient(staged));
      // Only reached when the callback resolved: a throw discards `staged`,
      // exactly as a rolled-back transaction discards its writes.
      state.committed = staged;
      return result;
    },
    async createRepoIn(
      tx: ReturnType<typeof transactionClient>,
      workspaceId: string,
      repo: { repoKey: string; repoName: string; httpPrefix?: string | null },
    ) {
      return tx.workspaceRepo.create({
        data: {
          workspaceId,
          repoKey: repo.repoKey,
          repoName: repo.repoName,
          httpPrefix: repo.httpPrefix ?? null,
          intentRepoKey: null,
          normalizedGitRemote: null,
        },
      });
    },
    async updateRepoIn(
      tx: ReturnType<typeof transactionClient>,
      workspaceId: string,
      repoKey: string,
      updates: { httpPrefix?: string | null },
    ) {
      return tx.workspaceRepo.update({ where: { workspaceId_repoKey: { workspaceId, repoKey } }, data: updates });
    },
  };
  return { controlPlane, state };
}

const REPO_NAME = 'orders-api';
const REPO_HASH = graphRepoHashOf(REPO_NAME);

describe('ReposService.connectRepo', () => {
  it('creates the row and binds the durable identity in ONE locked transaction', async () => {
    const { controlPlane, state } = fakeControlPlane();
    const service = new ReposService(controlPlane as never, {} as never);

    const connected = await service.connectRepo('ws_1', {
      repoKey: REPO_HASH,
      repoName: REPO_NAME,
      gitUrl: 'git@github.com:acme/orders-api.git',
    } as never);

    expect(state.transactions).toBe(1);
    expect(connected).toMatchObject({ intentRepoKey: REPO_NAME, normalizedGitRemote: 'github.com/acme/orders-api' });
    expect(state.committed).toHaveLength(1);
    expect(state.committed[0]).toMatchObject({ intentRepoKey: REPO_NAME });
  });

  it('leaves NO half-created repo behind when the identity write is refused', async () => {
    const { controlPlane, state } = fakeControlPlane([], () => {
      throw new Error('new row violates check constraint "workspace_repos_normalized_git_remote_check"');
    });
    const service = new ReposService(controlPlane as never, {} as never);

    await expect(
      service.connectRepo('ws_1', { repoKey: REPO_HASH, repoName: REPO_NAME, gitUrl: 'https://x/y' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The whole point: the retry must be able to say "connect", not be told
    // the repo is already connected but unbound.
    expect(state.committed).toEqual([]);
  });

  it('refuses an unprovable durable key before it opens a transaction at all', async () => {
    const { controlPlane, state } = fakeControlPlane();
    const service = new ReposService(controlPlane as never, {} as never);

    await expect(
      service.connectRepo('ws_1', { repoKey: REPO_HASH, repoName: REPO_NAME, intentRepoKey: 'not-the-key' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(state.transactions).toBe(0);
    expect(state.committed).toEqual([]);
  });

  it('still reports an already-connected repo as a conflict', async () => {
    const { controlPlane } = fakeControlPlane([
      {
        workspaceId: 'ws_1',
        repoKey: REPO_HASH,
        repoName: REPO_NAME,
        httpPrefix: null,
        intentRepoKey: REPO_NAME,
        normalizedGitRemote: null,
      },
    ]);
    const service = new ReposService(controlPlane as never, {} as never);

    await expect(
      service.connectRepo('ws_1', { repoKey: REPO_HASH, repoName: REPO_NAME } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ReposService.updateRepo', () => {
  const connected = (overrides: Partial<FakeRepoRow> = {}): FakeRepoRow => ({
    workspaceId: 'ws_1',
    repoKey: REPO_HASH,
    repoName: REPO_NAME,
    httpPrefix: null,
    intentRepoKey: null,
    normalizedGitRemote: null,
    ...overrides,
  });

  it('fills a legacy NULL intent key in place — the documented retry remedy', async () => {
    const { controlPlane, state } = fakeControlPlane([connected()]);
    const service = new ReposService(controlPlane as never, {} as never);

    await service.updateRepo('ws_1', REPO_HASH, { intentRepoKey: REPO_NAME, httpPrefix: '/v1' } as never);

    expect(state.transactions).toBe(1);
    expect(state.committed[0]).toMatchObject({ intentRepoKey: REPO_NAME, httpPrefix: '/v1' });
  });

  it('refuses a conflicting rebind and rolls the mutable fields back with it', async () => {
    // Bound by something that bypassed the proof (a migration, a console): the
    // backstop must refuse, and the PATCH's other fields must not land either.
    const { controlPlane, state } = fakeControlPlane([connected({ intentRepoKey: 'bound-elsewhere' })]);
    const service = new ReposService(controlPlane as never, {} as never);

    await expect(service.updateRepo('ws_1', REPO_HASH, { httpPrefix: '/v1' } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(state.committed[0]).toMatchObject({ intentRepoKey: 'bound-elsewhere', httpPrefix: null });
  });

  it('reports an unknown repo as not found', async () => {
    const { controlPlane } = fakeControlPlane();
    const service = new ReposService(controlPlane as never, {} as never);

    await expect(service.updateRepo('ws_1', REPO_HASH, { httpPrefix: '/v1' } as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
