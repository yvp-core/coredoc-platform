import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service.js';
import { GithubAuthError, GithubRateLimitError } from '../../libs/github/github-client.js';
import { unpackRawPayload } from './raw-payload-codec.js';

// Encryption is mocked so tests never need SERVER_ENCRYPTION_KEY. Per-test overrides
// flip isEncryptionAvailable / decrypt behavior.
const encMocks = {
  decrypt: vi.fn((s: string) => `token-${s}`),
  isEncryptionAvailable: vi.fn(() => true),
};
vi.mock('../../database/encryption.js', () => ({
  decrypt: (s: string) => encMocks.decrypt(s),
  isEncryptionAvailable: () => encMocks.isEncryptionAvailable(),
}));

import { codeChangeFieldsFromNorm, GithubImporterService, parseGithubRepo } from './github-importer.service.js';
import { lookbackIso } from './ingest-window.js';
import { CODE_CHANGE_NORM_VERSION, normalizePullRequest } from './github-normalizer.js';

// --- fixtures -----------------------------------------------------------------

function pr(number: number, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    updated_at: updatedAt,
    created_at: '2026-01-01T00:00:00Z',
    state: 'open',
    title: `PR ${number}`,
    head: { ref: `feat/${number}` },
    base: { ref: 'main' },
    user: { login: 'dev' },
    ...extra,
  };
}

function mockClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    listPullsUpdatedSince: vi.fn().mockResolvedValue([]),
    getPull: vi.fn().mockResolvedValue({}),
    listReviews: vi.fn().mockResolvedValue([]),
    listFiles: vi.fn().mockResolvedValue([]),
    listCommits: vi.fn().mockResolvedValue({ items: [], incomplete: false }),
    ...over,
  };
}

function canonicalProjectionStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    projectRawPayload: vi.fn().mockResolvedValue({ associations: 0, shipEvidence: 0 }),
    ...over,
  };
}

function codeChangePersistenceStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    persist: vi.fn().mockResolvedValue({ id: 'cc-1', applied: 'created' }),
    ...over,
  };
}

function mockPrisma(connector: Record<string, unknown>, workspaceRepos: unknown[] = []) {
  const fetchedAt = new Date('2026-01-03T00:00:00.000Z');
  const prisma = {
    deliveryConnector: {
      findUnique: vi.fn().mockResolvedValue(connector),
      update: vi.fn().mockResolvedValue({}),
    },
    workspaceRepo: { findMany: vi.fn().mockResolvedValue(workspaceRepos) },
    deliveryRawPayload: {
      create: vi.fn().mockResolvedValue({ id: 41n, fetchedAt }),
    },
    codeChange: {
      upsert: vi.fn().mockResolvedValue({ id: 'cc-1' }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

function importer(
  prisma: ReturnType<typeof mockPrisma>,
  client: ReturnType<typeof mockClient>,
  opts?: {
    codeChanges?: ReturnType<typeof codeChangePersistenceStub>;
    projection?: ReturnType<typeof canonicalProjectionStub>;
  },
) {
  const codeChanges = (opts?.codeChanges ?? codeChangePersistenceStub()) as never;
  const projection = (opts?.projection ?? canonicalProjectionStub()) as never;
  const clientFactory = () => client as never;
  return new GithubImporterService(prisma, codeChanges, projection, clientFactory);
}

const baseConnector = {
  id: 'conn-1',
  workspaceId: 'ws-1',
  provider: 'github',
  baseUrl: null,
  credentialsEncrypted: 'enc-pat',
  config: { repos: ['o/r'] },
  cursors: {},
};

describe('parseGithubRepo', () => {
  it('parses https, ssh, and .git URLs; returns null otherwise', () => {
    expect(parseGithubRepo('https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubRepo('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubRepo('https://gitlab.com/o/r')).toBeNull();
    expect(parseGithubRepo('not a url')).toBeNull();
  });
});
describe('GithubImporterService.syncConnector', () => {
  beforeEach(() => {
    encMocks.decrypt.mockClear().mockImplementation((s: string) => `token-${s}`);
    encMocks.isEncryptionAvailable.mockClear().mockReturnValue(true);
    vi.restoreAllMocks();
  });

  it('rejects an unsafe stored GitHub base URL before credentials or a client factory can use it', async () => {
    const prisma = mockPrisma({ ...baseConnector, baseUrl: 'http://github.acme.invalid/api/v3' });
    const factory = vi.fn();
    const service = new GithubImporterService(
      prisma,
      codeChangePersistenceStub() as never,
      canonicalProjectionStub() as never,
      factory,
    );

    await expect(service.syncConnector('conn-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(factory).not.toHaveBeenCalled();
    expect(encMocks.decrypt).not.toHaveBeenCalled();
  });

  it('case 1: happy path — 2 PRs, raw rows, upserts, cursor + lastSyncAt persisted', async () => {
    // client returns NEWEST-first; service reverses to ASC
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(2, '2026-01-02T00:00:00Z'), pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({ ...baseConnector });
    const codeChanges = codeChangePersistenceStub();
    const service = importer(prisma, client, { codeChanges });

    const result = await service.syncConnector('conn-1');

    expect(result).toEqual({
      repos: 1,
      prs: 2,
      unlinkedRepos: [{ repo: 'o/r', prs: 2 }],
    });
    expect(prisma.deliveryRawPayload.create).toHaveBeenCalledTimes(2);
    expect(codeChanges.persist).toHaveBeenCalledTimes(2);

    const firstPersist = codeChanges.persist.mock.calls[0][0];
    expect(firstPersist).toMatchObject({
      workspaceId: 'ws-1',
      connectorId: 'conn-1',
      repoExternalId: 'o/r',
      externalId: '1',
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
      workspaceRepoId: null,
      norm: expect.objectContaining({ externalId: '1' }),
    });
    expect(firstPersist.refreshEqual).toBeUndefined();

    const update = prisma.deliveryConnector.update.mock.calls.at(-1)?.[0];
    expect(update.where).toEqual({ id: 'conn-1' });
    expect(update.data.cursors).toEqual({ 'pr:o/r': '2026-01-02T00:00:00Z' });
    expect(update.data.lastSyncAt).toBeInstanceOf(Date);
  });

  it('maps lastCommitAt (max committer date) through toDate onto create + update payloads', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
      listCommits: vi.fn().mockResolvedValue({
        items: [
          { sha: 'a', commit: { committer: { date: '2026-01-01T10:00:00Z' } } },
          { sha: 'b', commit: { committer: { date: '2026-01-01T12:00:00Z' } } },
        ],
        incomplete: false,
      }),
    });
    const prisma = mockPrisma({ ...baseConnector });
    const codeChanges = codeChangePersistenceStub();
    const service = importer(prisma, client, { codeChanges });

    await service.syncConnector('conn-1');

    expect(codeChanges.persist.mock.calls[0][0].norm.lastCommitAt).toBe('2026-01-01T12:00:00Z');
  });

  it('sets lastCommitAt null on the upsert when no commits carry dates', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({ ...baseConnector });
    const codeChanges = codeChangePersistenceStub();
    const service = importer(prisma, client, { codeChanges });

    await service.syncConnector('conn-1');

    expect(codeChanges.persist.mock.calls[0][0].norm.lastCommitAt).toBeUndefined();
  });

  it('case 2: cursor passed to client; PRs upserted oldest-first', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(2, '2026-01-02T00:00:00Z'), pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({ ...baseConnector, cursors: { 'pr:o/r': '2026-01-01T00:00:00Z' } });
    const codeChanges = codeChangePersistenceStub();
    const service = importer(prisma, client, { codeChanges });

    await service.syncConnector('conn-1');

    expect(client.listPullsUpdatedSince).toHaveBeenCalledWith('o', 'r', '2026-01-01T00:00:00Z');
    const order = codeChanges.persist.mock.calls.map((call) => call[0].externalId);
    expect(order).toEqual(['1', '2']);
  });

  it('case 3: derives repo list from WorkspaceRepos, github only, stamps workspaceRepoId', async () => {
    // Freeze time so the cursor-less backfill window (default 30d) is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00Z'));
    try {
      const client = mockClient({
        listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(5, '2026-01-05T00:00:00Z')]),
      });
      const prisma = mockPrisma({ ...baseConnector, config: { repos: [] } }, [
        { id: 'wr-gh', gitUrl: 'https://github.com/o/r.git' },
        { id: 'wr-gl', gitUrl: 'https://gitlab.com/o/other.git' },
      ]);
      const codeChanges = codeChangePersistenceStub();
      const service = importer(prisma, client, { codeChanges });

      const result = await service.syncConnector('conn-1');

      expect(result).toEqual({
        repos: 1,
        prs: 1,
        // the derived WorkspaceRepo carries no intentRepoKey → unlinked for BR-1
        unlinkedRepos: [{ repo: 'o/r', prs: 1 }],
      });
      expect(client.listPullsUpdatedSince).toHaveBeenCalledOnce();
      // No cursor → since is the 30-day backfill window floor (not null).
      expect(client.listPullsUpdatedSince).toHaveBeenCalledWith('o', 'r', lookbackIso(30));
      expect(codeChanges.persist.mock.calls[0][0].workspaceRepoId).toBe('wr-gh');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores commit-list completeness in the full raw envelope and stamps the current normVersion', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({ ...baseConnector });
    const service = importer(prisma, client);

    await service.syncConnector('conn-1');

    const raw = prisma.deliveryRawPayload.create.mock.calls[0][0];
    expect(raw.data.truncated).toBe(false);
    expect(Object.keys(raw.data.payload)).toEqual(['z']); // gzip-at-rest
    const env = unpackRawPayload(raw.data.payload);
    expect(Object.keys(env)).toEqual(['pr', 'prDetail', 'reviews', 'files', 'commits', 'commitsIncomplete', 'repo']);
    expect(env.repo).toBe('o/r');
    expect(env.commitsIncomplete).toBe(false);
    expect(raw.data.normVersion).toBe(CODE_CHANGE_NORM_VERSION);
  });

  it('persists a partial commit-list marker instead of treating a bounded page as complete evidence', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
      listCommits: vi.fn().mockResolvedValue({
        items: [{ sha: 'a', commit: { message: `fix\n\nCoredoc-Run-Id: cdr-20260817-a1b2c3` } }],
        incomplete: true,
      }),
    });
    const prisma = mockPrisma({ ...baseConnector });
    const projection = canonicalProjectionStub();
    const codeChanges = codeChangePersistenceStub();

    await importer(prisma, client, { codeChanges, projection }).syncConnector('conn-1');

    const raw = prisma.deliveryRawPayload.create.mock.calls[0][0];
    const envelope = unpackRawPayload(raw.data.payload);
    expect(envelope.commits).toHaveLength(1);
    expect(envelope.commitsIncomplete).toBe(true);
    // The projector owns the fail-closed policy. Live import still gives it the raw
    // identity so it can observe the explicit marker and atomically stamp a safe no-op.
    expect(projection.projectRawPayload).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      rawPayloadId: 41n,
      codeChangeId: 'cc-1',
    });
  });

  it('persists raw first, then CodeChange, then canonical projection, and advances the cursor only after all succeed', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({ ...baseConnector });
    const projection = canonicalProjectionStub();
    const codeChanges = codeChangePersistenceStub();

    await importer(prisma, client, { codeChanges, projection }).syncConnector('conn-1');

    expect(projection.projectRawPayload).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      rawPayloadId: 41n,
      codeChangeId: 'cc-1',
    });
    const rawOrder = prisma.deliveryRawPayload.create.mock.invocationCallOrder[0];
    const codeChangeOrder = codeChanges.persist.mock.invocationCallOrder[0];
    const projectionOrder = projection.projectRawPayload.mock.invocationCallOrder[0];
    const cursorOrder = prisma.deliveryConnector.update.mock.invocationCallOrder[0];
    expect(rawOrder).toBeLessThan(codeChangeOrder);
    expect(codeChangeOrder).toBeLessThan(projectionOrder);
    expect(projectionOrder).toBeLessThan(cursorOrder);
  });

  it('does not advance the repo cursor when canonical projection fails after the raw and CodeChange writes', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-02T00:00:00Z')]),
    });
    const prisma = mockPrisma({
      ...baseConnector,
      cursors: { 'pr:o/r': '2026-01-01T00:00:00Z' },
    });
    const projection = canonicalProjectionStub({
      projectRawPayload: vi.fn().mockRejectedValue(new Error('projection failed')),
    });
    const codeChanges = codeChangePersistenceStub();

    const result = await importer(prisma, client, { codeChanges, projection }).syncConnector('conn-1');

    expect(prisma.deliveryRawPayload.create).toHaveBeenCalledOnce();
    expect(codeChanges.persist).toHaveBeenCalledOnce();
    expect(result.prs).toBe(0);
    expect(result.repos).toBe(0);
    expect(prisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors).toEqual({
      'pr:o/r': '2026-01-01T00:00:00Z',
    });
  });

  it('case 4: oversized payload stored as {pr} with truncated: true', async () => {
    const big = 'x'.repeat(300_000);
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
      listFiles: vi.fn().mockResolvedValue([{ filename: big }]),
    });
    const prisma = mockPrisma({ ...baseConnector });
    const projection = canonicalProjectionStub();
    const service = importer(prisma, client, { projection });

    await service.syncConnector('conn-1');

    const raw = prisma.deliveryRawPayload.create.mock.calls[0][0];
    expect(raw.data.truncated).toBe(true);
    expect(unpackRawPayload(raw.data.payload)).toMatchObject({
      pr: expect.objectContaining({ number: 1 }),
      repo: 'o/r',
      commitsIncomplete: true,
    });
    // A live truncated row is still projected. The projector sees raw.truncated and
    // converges to zero associations before owning the projection-version stamp.
    expect(projection.projectRawPayload).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      rawPayloadId: 41n,
      codeChangeId: 'cc-1',
    });
  });

  it('case 5: per-repo isolation — one repo throws plain Error, other still syncs', async () => {
    const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = mockClient({
      listPullsUpdatedSince: vi
        .fn()
        .mockImplementation((_o: string, repo: string) =>
          repo === 'r1' ? Promise.reject(new Error('boom')) : Promise.resolve([pr(9, '2026-01-09T00:00:00Z')]),
        ),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/r1', 'o/r2'] } });
    const codeChanges = codeChangePersistenceStub();
    const service = importer(prisma, client, { codeChanges });

    const result = await service.syncConnector('conn-1');

    expect(result).toEqual({
      repos: 1,
      prs: 1,
      unlinkedRepos: [{ repo: 'o/r2', prs: 1 }],
    });
    expect(codeChanges.persist).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    // cursor persisted for the successful repo
    const lastUpdate = prisma.deliveryConnector.update.mock.calls.at(-1)?.[0];
    expect(lastUpdate.data.cursors).toMatchObject({ 'pr:o/r2': '2026-01-09T00:00:00Z' });
  });

  it('case 6: GithubAuthError re-thrown as permanent BadRequestException; prior repo cursors persisted', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi
        .fn()
        .mockImplementation((_o: string, repo: string) =>
          repo === 'r1'
            ? Promise.resolve([pr(3, '2026-01-03T00:00:00Z')])
            : Promise.reject(new GithubAuthError('GitHub auth failed (401) for /repos/o/r2/pulls')),
        ),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/r1', 'o/r2'] } });
    const service = importer(prisma, client);

    // Auth failures are permanent — surface as BadRequestException so the worker
    // fails the job immediately rather than burning transient backoff attempts.
    await expect(service.syncConnector('conn-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.syncConnector('conn-1')).rejects.toThrow(/auth/);
    const persistedCursors = prisma.deliveryConnector.update.mock.calls.map((c) => c[0].data.cursors);
    expect(persistedCursors.some((c) => c['pr:o/r1'] === '2026-01-03T00:00:00Z')).toBe(true);
  });

  it('case 6b: GithubRateLimitError rethrown; prior repo cursors already persisted', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi
        .fn()
        .mockImplementation((_o: string, repo: string) =>
          repo === 'r1'
            ? Promise.resolve([pr(3, '2026-01-03T00:00:00Z')])
            : Promise.reject(new GithubRateLimitError('429')),
        ),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/r1', 'o/r2'] } });
    const service = importer(prisma, client);

    await expect(service.syncConnector('conn-1')).rejects.toBeInstanceOf(GithubRateLimitError);
    const persistedCursors = prisma.deliveryConnector.update.mock.calls.map((c) => c[0].data.cursors);
    expect(persistedCursors.some((c) => c['pr:o/r1'] === '2026-01-03T00:00:00Z')).toBe(true);
  });

  it('boundary skip: boundary PR already current -> no raw row, no upsert, cursor unchanged', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({
      ...baseConnector,
      cursors: { 'pr:o/r': '2026-01-01T00:00:00Z' },
    });
    prisma.codeChange.findUnique = vi.fn().mockResolvedValue({ attrs: { sourceUpdatedAt: '2026-01-01T00:00:00Z' } });
    const codeChanges = codeChangePersistenceStub();
    const service = importer(prisma, client, { codeChanges });

    const result = await service.syncConnector('conn-1');

    expect(result).toEqual({
      repos: 1,
      prs: 0,
      unlinkedRepos: [],
    });
    expect(prisma.deliveryRawPayload.create).not.toHaveBeenCalled();
    expect(codeChanges.persist).not.toHaveBeenCalled();
    // no sub-resource fetches for a skipped boundary PR
    expect(client.getPull).not.toHaveBeenCalled();
    expect(client.listReviews).not.toHaveBeenCalled();
    expect(client.listFiles).not.toHaveBeenCalled();
    expect(client.listCommits).not.toHaveBeenCalled();
    // cursor unchanged
    const lastUpdate = prisma.deliveryConnector.update.mock.calls.at(-1)?.[0];
    expect(lastUpdate.data.cursors).toEqual({ 'pr:o/r': '2026-01-01T00:00:00Z' });
  });

  it('same-second sibling processed: boundary updated_at but no stored row -> processed normally', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(7, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({
      ...baseConnector,
      cursors: { 'pr:o/r': '2026-01-01T00:00:00Z' },
    });
    // findUnique returns null -> never processed -> flows through normally
    const codeChanges = codeChangePersistenceStub();
    const service = importer(prisma, client, { codeChanges });

    const result = await service.syncConnector('conn-1');

    expect(result).toEqual({
      repos: 1,
      prs: 1,
      unlinkedRepos: [{ repo: 'o/r', prs: 1 }],
    });
    expect(prisma.deliveryRawPayload.create).toHaveBeenCalledOnce();
    expect(codeChanges.persist).toHaveBeenCalledOnce();
    expect(codeChanges.persist.mock.calls[0][0]).toMatchObject({
      externalId: '7',
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('case 7: null credentials -> BadRequestException', async () => {
    const prisma = mockPrisma({ ...baseConnector, credentialsEncrypted: null });
    const service = importer(prisma, mockClient());
    await expect(service.syncConnector('conn-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deleted/unknown connector -> NotFoundException (permanent, no retry)', async () => {
    const prisma = mockPrisma({ ...baseConnector });
    // Connector was deleted between enqueue and run — findUnique returns null.
    prisma.deliveryConnector.findUnique = vi.fn().mockResolvedValue(null);
    const service = importer(prisma, mockClient());
    await expect(service.syncConnector('conn-gone')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cursor-guard: corrupt cursor -> re-bounded to the backfill window (not null) + warning logged', async () => {
    // A corrupt cursor is now re-bounded to the window floor rather than triggering an
    // unbounded full refetch (a strict improvement) — since = null ?? windowStart.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00Z'));
    try {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const client = mockClient({ listPullsUpdatedSince: vi.fn().mockResolvedValue([]) });
      const prisma = mockPrisma({ ...baseConnector, cursors: { 'pr:o/r': 'garbage' } });
      const service = importer(prisma, client);

      await service.syncConnector('conn-1');

      expect(client.listPullsUpdatedSince).toHaveBeenCalledWith('o', 'r', lookbackIso(30));
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('window: no cursor → since = windowStart (default 30-day backfill floor)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00Z'));
    try {
      const client = mockClient({ listPullsUpdatedSince: vi.fn().mockResolvedValue([]) });
      const prisma = mockPrisma({ ...baseConnector, cursors: {} });
      const service = importer(prisma, client);

      await service.syncConnector('conn-1');

      expect(client.listPullsUpdatedSince).toHaveBeenCalledWith('o', 'r', lookbackIso(30));
    } finally {
      vi.useRealTimers();
    }
  });

  it('window: config.lookbackDays honored on backfill (14-day floor)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00Z'));
    try {
      const client = mockClient({ listPullsUpdatedSince: vi.fn().mockResolvedValue([]) });
      const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/r'], lookbackDays: 14 }, cursors: {} });
      const service = importer(prisma, client);

      await service.syncConnector('conn-1');

      expect(client.listPullsUpdatedSince).toHaveBeenCalledWith('o', 'r', lookbackIso(14));
    } finally {
      vi.useRealTimers();
    }
  });

  it('window: an absolute config.since floors the backfill and does not slide', async () => {
    vi.useFakeTimers();
    try {
      const since = '2026-08-01T00:00:00.000Z';
      // A month apart, both syncs resolve the SAME floor — that is the point of `since`.
      for (const now of ['2026-08-04T00:00:00Z', '2026-09-04T00:00:00Z']) {
        vi.setSystemTime(new Date(now));
        const client = mockClient({ listPullsUpdatedSince: vi.fn().mockResolvedValue([]) });
        const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/r'], since }, cursors: {} });

        await importer(prisma, client).syncConnector('conn-1');

        expect(client.listPullsUpdatedSince).toHaveBeenCalledWith('o', 'r', since);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('window: a stored cursor wins outright — window is inert, since = cursor (never max())', async () => {
    // The cursor is OLDER than the 30-day window: cursor ?? windowStart must yield the
    // cursor, never max(cursor, windowStart) which would skip PRs in a quiet gap.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00Z'));
    try {
      const client = mockClient({ listPullsUpdatedSince: vi.fn().mockResolvedValue([]) });
      const prisma = mockPrisma({ ...baseConnector, cursors: { 'pr:o/r': '2026-01-01T00:00:00Z' } });
      const service = importer(prisma, client);

      await service.syncConnector('conn-1');

      // cursor (Jan) is far older than windowStart (Jun); it still wins.
      expect(client.listPullsUpdatedSince).toHaveBeenCalledWith('o', 'r', '2026-01-01T00:00:00Z');
      expect(client.listPullsUpdatedSince).not.toHaveBeenCalledWith('o', 'r', lookbackIso(30));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GithubImporterService.syncConnector unlinked repositories (BR-1)', () => {
  beforeEach(() => {
    encMocks.decrypt.mockClear().mockImplementation((s: string) => `token-${s}`);
    encMocks.isEncryptionAvailable.mockClear().mockReturnValue(true);
    vi.restoreAllMocks();
  });

  const linkedRepo = { id: 'wr-linked', gitUrl: 'https://github.com/o/linked.git', intentRepoKey: 'linked' };

  it('AC-1: names a target ingested without an intent-linked workspace repo, with its PR count', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi
        .fn()
        .mockImplementation((_o: string, repo: string) =>
          repo === 'linked'
            ? Promise.resolve([pr(1, '2026-01-01T00:00:00Z')])
            : Promise.resolve([pr(3, '2026-01-03T00:00:00Z'), pr(2, '2026-01-02T00:00:00Z')]),
        ),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/linked', 'o/loose'] } }, [linkedRepo]);

    const result = await importer(prisma, client).syncConnector('conn-1');

    expect(result.prs).toBe(3);
    expect(result.unlinkedRepos).toEqual([{ repo: 'o/loose', prs: 2 }]);
  });

  it('AC-1b: a workspace repo without an intentRepoKey counts as unlinked', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/loose'] } }, [
      { id: 'wr-loose', gitUrl: 'https://github.com/o/loose.git', intentRepoKey: null },
    ]);

    const result = await importer(prisma, client).syncConnector('conn-1');

    expect(result.unlinkedRepos).toEqual([{ repo: 'o/loose', prs: 1 }]);
  });

  it('AC-2: linked targets only -> present and empty', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/linked'] } }, [linkedRepo]);

    const result = await importer(prisma, client).syncConnector('conn-1');

    expect(result.prs).toBe(1);
    expect(result.unlinkedRepos).toEqual([]);
  });

  it('AC-3: a second sync reports only its own ingestion (LIM-1, no carry-over)', async () => {
    const client = mockClient({
      // first sync ingests one PR, second sync finds nothing new
      listPullsUpdatedSince: vi
        .fn()
        .mockResolvedValueOnce([pr(1, '2026-01-01T00:00:00Z')])
        .mockResolvedValue([]),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/loose'] } });
    const service = importer(prisma, client);

    expect((await service.syncConnector('conn-1')).unlinkedRepos).toEqual([{ repo: 'o/loose', prs: 1 }]);

    const second = await service.syncConnector('conn-1');

    expect(second.prs).toBe(0);
    expect(second.unlinkedRepos).toEqual([]);
  });

  it('AC-4: first-wins duplicate key keeps linkage tied to the stamped row, not any row sharing the key', async () => {
    const client = mockClient({
      listPullsUpdatedSince: vi.fn().mockResolvedValue([pr(1, '2026-01-01T00:00:00Z')]),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { repos: ['o/dup'] } }, [
      { id: 'wr-first', gitUrl: 'https://github.com/o/dup.git', intentRepoKey: null },
      { id: 'wr-second', gitUrl: 'https://github.com/o/dup.git', intentRepoKey: 'dup' },
    ]);

    const result = await importer(prisma, client).syncConnector('conn-1');

    expect(result.unlinkedRepos).toEqual([{ repo: 'o/dup', prs: 1 }]);
  });
});

describe('codeChangeFieldsFromNorm', () => {
  it('maps a NormalizedCodeChange to the exact Prisma fields object (behaviour-preserving)', () => {
    const norm = normalizePullRequest(
      {
        number: 5,
        title: 'Fix PROD-42',
        state: 'closed',
        draft: false,
        created_at: '2026-01-01T00:00:00Z',
        merged_at: '2026-01-02T00:00:00Z',
        head: { ref: 'PROD-42-fix' },
        base: { ref: 'main' },
      },
      [],
      [{ filename: 'src/a.ts' }],
      [],
      // Diff-stat counts come from the single-PR GET (prDetail), not the list object.
      { commits: 3, additions: 10, deletions: 2, changed_files: 1 },
    )!;

    const fields = codeChangeFieldsFromNorm(norm, '2026-01-02T09:00:00Z', 'wr-1');

    expect(fields.workspaceRepoId).toBe('wr-1');
    expect(fields.number).toBe(5);
    expect(fields.title).toBe('Fix PROD-42');
    expect(fields.sourceBranch).toBe('PROD-42-fix');
    expect(fields.targetBranch).toBe('main');
    expect(fields.state).toBe('merged');
    expect(fields.isDraft).toBe(false);
    expect(fields.mergedAt).toEqual(new Date('2026-01-02T00:00:00Z'));
    expect(fields.changedPaths).toEqual(['src/a.ts']);
    expect(fields.commitsCount).toBe(3);
    // attrs carries the normalized attrs plus the sourceUpdatedAt stamp.
    const attrs = fields.attrs as Record<string, unknown>;
    expect(attrs.issueKeys).toEqual(['PROD-42']);
    expect(attrs.issueKeySources).toEqual({ 'PROD-42': 'branch' });
    expect(attrs.sourceUpdatedAt).toBe('2026-01-02T09:00:00Z');
  });

  it('coerces missing numeric fields + workspaceRepoId to null', () => {
    const norm = normalizePullRequest({ number: 6 }, [], [], [])!;
    const fields = codeChangeFieldsFromNorm(norm, undefined, null);
    expect(fields.workspaceRepoId).toBeNull();
    expect(fields.additions).toBeNull();
    expect(fields.lastCommitAt).toBeNull();
    expect((fields.attrs as Record<string, unknown>).sourceUpdatedAt).toBeUndefined();
  });
});
