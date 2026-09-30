import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service.js';
import { RenormalizeService } from './renormalize.service.js';
import { CODE_CHANGE_NORM_VERSION } from './github-normalizer.js';
import { GITHUB_CANONICAL_PROJECTION_VERSION } from './github-canonical-projection.service.js';

// --- fixtures -----------------------------------------------------------------

function prPayload(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    updated_at: '2026-01-02T09:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    state: 'open',
    title: `PR ${number}`,
    head: { ref: `PROD-${number}-x` },
    base: { ref: 'main' },
    ...extra,
  };
}

function rawRow(id: bigint, over: Record<string, unknown> = {}) {
  return {
    id,
    connectorId: 'conn-1',
    resourceType: 'pull_request',
    truncated: false,
    normVersion: 1,
    canonicalProjectionVersion: null,
    payload: { pr: prPayload(5), reviews: [], files: [], commits: [], repo: 'o/r' },
    ...over,
  };
}

function mockPrisma(rows: unknown[], workspaceRepos: unknown[] = []) {
  const prisma = {
    workspaceRepo: { findMany: vi.fn().mockResolvedValue(workspaceRepos) },
    deliveryRawPayload: {
      findMany: vi.fn().mockResolvedValue(rows),
      update: vi.fn().mockResolvedValue({}),
    },
    codeChange: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'cc-1' }),
    },
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

function canonicalProjectionStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    projectRawPayload: vi.fn().mockResolvedValue({ associations: 0, shipEvidence: 0, reworkSignals: 0 }),
    ...over,
  };
}

function codeChangePersistenceStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    persist: vi.fn().mockResolvedValue({ id: 'cc-1', applied: 'created' }),
    ...over,
  };
}

function renormalizer(
  prisma: ReturnType<typeof mockPrisma>,
  projection = canonicalProjectionStub(),
  codeChanges = codeChangePersistenceStub(),
): RenormalizeService {
  return new RenormalizeService(prisma, codeChanges as never, projection as never);
}

describe('RenormalizeService.renormalizeWorkspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('upgrades a stale row through shared persistence and stamps the current normVersion + processedAt', async () => {
    const rows = [rawRow(1n)];
    const prisma = mockPrisma(rows, [{ id: 'wr-1', gitUrl: 'https://github.com/o/r.git' }]);
    const projection = canonicalProjectionStub();
    const codeChanges = codeChangePersistenceStub();
    const service = renormalizer(prisma, projection, codeChanges);

    const res = await service.renormalizeWorkspace('ws-1');

    expect(res).toEqual({ scanned: 1, renormalized: 1, skipped: 0 });
    expect(codeChanges.persist).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      connectorId: 'conn-1',
      repoExternalId: 'o/r',
      externalId: '5',
      sourceUpdatedAt: '2026-01-02T09:00:00Z',
      workspaceRepoId: 'wr-1',
      norm: expect.objectContaining({
        attrs: expect.objectContaining({ issueKeySources: { 'PROD-5': 'branch' } }),
      }),
      refreshEqual: true,
    });

    const update = prisma.deliveryRawPayload.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 1n });
    expect(update.data.normVersion).toBe(CODE_CHANGE_NORM_VERSION);
    expect(update.data.processedAt).toBeInstanceOf(Date);
    expect(projection.projectRawPayload).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      rawPayloadId: 1n,
      codeChangeId: 'cc-1',
    });
  });

  it('excludes truncated rows via the query (they lack sub-resources)', async () => {
    const prisma = mockPrisma([]);
    const service = renormalizer(prisma);

    await service.renormalizeWorkspace('ws-1');

    const where = prisma.deliveryRawPayload.findMany.mock.calls[0][0].where;
    expect(where.truncated).toBe(false);
    expect(where.resourceType).toBe('pull_request');
    expect(where.OR).toEqual([
      { normVersion: null },
      { normVersion: { lt: CODE_CHANGE_NORM_VERSION } },
      { canonicalProjectionVersion: null },
      { canonicalProjectionVersion: { lt: GITHUB_CANONICAL_PROJECTION_VERSION } },
    ]);
    // no connectorId filter unless requested
    expect(where.connectorId).toBeUndefined();
  });

  it('falls back to pr.base.repo.full_name when envelope.repo is absent (legacy rows)', async () => {
    const rows = [
      rawRow(2n, {
        payload: {
          pr: prPayload(6, { base: { ref: 'main', repo: { full_name: 'o/legacy' } } }),
          reviews: [],
          files: [],
          commits: [],
          // no top-level repo key
        },
      }),
    ];
    const prisma = mockPrisma(rows);
    const codeChanges = codeChangePersistenceStub();
    const service = renormalizer(prisma, canonicalProjectionStub(), codeChanges);

    const res = await service.renormalizeWorkspace('ws-1');

    expect(res.renormalized).toBe(1);
    expect(codeChanges.persist.mock.calls[0][0].repoExternalId).toBe('o/legacy');
  });

  it('skips a garbage row (no repo, no pr), stamps processedAt only, and logs', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rows = [rawRow(3n, { payload: { junk: true } })];
    const prisma = mockPrisma(rows);
    const codeChanges = codeChangePersistenceStub();
    const service = renormalizer(prisma, canonicalProjectionStub(), codeChanges);

    const res = await service.renormalizeWorkspace('ws-1');

    expect(res).toEqual({ scanned: 1, renormalized: 0, skipped: 1 });
    expect(codeChanges.persist).not.toHaveBeenCalled();
    const update = prisma.deliveryRawPayload.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 3n });
    expect(update.data.processedAt).toBeInstanceOf(Date);
    expect(update.data.normVersion).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('scopes the query to a connectorId when provided', async () => {
    const prisma = mockPrisma([]);
    const service = renormalizer(prisma);

    await service.renormalizeWorkspace('ws-1', { connectorId: 'conn-x' });

    expect(prisma.deliveryRawPayload.findMany.mock.calls[0][0].where.connectorId).toBe('conn-x');
  });

  it('replays a norm-current row whose canonical projection version is null through duplicate persistence', async () => {
    const row = rawRow(7n, {
      normVersion: CODE_CHANGE_NORM_VERSION,
      canonicalProjectionVersion: null,
    });
    const prisma = mockPrisma([row]);
    const codeChanges = codeChangePersistenceStub({
      persist: vi.fn().mockResolvedValue({ id: 'cc-current', applied: 'duplicate' }),
    });
    const projection = canonicalProjectionStub();

    await renormalizer(prisma, projection, codeChanges).renormalizeWorkspace('ws-1');

    expect(codeChanges.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        connectorId: 'conn-1',
        repoExternalId: 'o/r',
        externalId: '5',
        sourceUpdatedAt: '2026-01-02T09:00:00Z',
      }),
    );
    expect(codeChanges.persist.mock.calls[0][0].refreshEqual).toBe(false);
    expect(projection.projectRawPayload).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      rawPayloadId: 7n,
      codeChangeId: 'cc-current',
    });
  });

  it('does not let an older stale-normalizer raw row regress a fresher current CodeChange', async () => {
    const row = rawRow(8n, {
      normVersion: 1,
      canonicalProjectionVersion: null,
      payload: {
        pr: prPayload(5, { updated_at: '2026-01-02T09:00:00Z', title: 'older title' }),
        reviews: [],
        files: [],
        commits: [],
        commitsIncomplete: false,
        repo: 'o/r',
      },
    });
    const prisma = mockPrisma([row]);
    const codeChanges = codeChangePersistenceStub({
      persist: vi.fn().mockResolvedValue({ id: 'cc-current', applied: 'stale' }),
    });
    const projection = canonicalProjectionStub();

    await renormalizer(prisma, projection, codeChanges).renormalizeWorkspace('ws-1');

    expect(codeChanges.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUpdatedAt: '2026-01-02T09:00:00Z',
        norm: expect.objectContaining({ title: 'older title' }),
        refreshEqual: true,
      }),
    );
    expect(prisma.deliveryRawPayload.update).toHaveBeenCalledWith({
      where: { id: 8n },
      data: { normVersion: CODE_CHANGE_NORM_VERSION, processedAt: expect.any(Date) },
    });
    expect(projection.projectRawPayload).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      rawPayloadId: 8n,
      codeChangeId: 'cc-current',
    });
  });

  it('leaves a norm-current row projection-stale when projection fails, so the same row is retried', async () => {
    const row = rawRow(9n, {
      normVersion: CODE_CHANGE_NORM_VERSION,
      canonicalProjectionVersion: null,
    });
    const prisma = mockPrisma([row]);
    const codeChanges = codeChangePersistenceStub({
      persist: vi.fn().mockResolvedValue({ id: 'cc-current', applied: 'duplicate' }),
    });
    const projection = canonicalProjectionStub({
      projectRawPayload: vi.fn().mockRejectedValue(new Error('projection failed')),
    });

    await expect(renormalizer(prisma, projection, codeChanges).renormalizeWorkspace('ws-1')).rejects.toThrow(
      'projection failed',
    );

    expect(prisma.deliveryRawPayload.update).not.toHaveBeenCalled();
    expect(codeChanges.persist).toHaveBeenCalledOnce();
    expect(projection.projectRawPayload).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      rawPayloadId: 9n,
      codeChangeId: 'cc-current',
    });
  });

  it('is a no-op on the second pass after the projector has advanced the raw-row version', async () => {
    const row = rawRow(10n, {
      normVersion: CODE_CHANGE_NORM_VERSION,
      canonicalProjectionVersion: null,
    });
    const prisma = mockPrisma([]);
    prisma.deliveryRawPayload.findMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    const codeChanges = codeChangePersistenceStub({
      persist: vi.fn().mockResolvedValue({ id: 'cc-current', applied: 'duplicate' }),
    });
    const projection = canonicalProjectionStub();
    const service = renormalizer(prisma, projection, codeChanges);

    await service.renormalizeWorkspace('ws-1');
    await service.renormalizeWorkspace('ws-1');

    expect(codeChanges.persist).toHaveBeenCalledOnce();
    expect(projection.projectRawPayload).toHaveBeenCalledOnce();
  });
});

// ── legacy workflow trailer backfill ──────────────────────────────────────────
//
// The backfill is a RE-DERIVATION, not a new capture: the legacy `Coredoc-Run-Id`
// trailer already sits in a commit message inside a raw payload on disk, and the entire
// mechanism is `CODE_CHANGE_NORM_VERSION` moving by one — this service already selects
// every payload below the current version and replays the pure normalizer over it. So
// there is nothing to add to the service; what was missing was the evidence that the
// replay actually surfaces a run id and moves nothing else.

/** A commit as the connector retains it, carrying whatever trailer the run stamped. */
function commit(sha: string, message: string) {
  return { sha, commit: { message, committer: { date: '2026-01-02T08:00:00Z' } } };
}

const RUN_A = 'cdr-20260728-a1b2c3';
const RUN_B = 'cdr-20260728-0f9e8d';

/** A retained pre-change payload: normVersion 1, one commit, trailer optional. */
function historicalRow(id: bigint, number: number, commitMessage: string) {
  return rawRow(id, {
    normVersion: 1,
    payload: {
      pr: prPayload(number),
      reviews: [],
      files: [],
      commits: [commit(`sha${number}`, commitMessage)],
      repo: 'o/r',
    },
  });
}

describe('RenormalizeService.renormalizeWorkspace — the run-id backfill', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('replays a retained payload: the trailer’s run id lands on the change and the version stamps forward', async () => {
    const prisma = mockPrisma([historicalRow(10n, 11, `fix: the thing\n\nCoredoc-Run-Id: ${RUN_A}\n`)]);
    const codeChanges = codeChangePersistenceStub();
    const service = renormalizer(prisma, canonicalProjectionStub(), codeChanges);

    const res = await service.renormalizeWorkspace('ws-1');

    expect(res).toEqual({ scanned: 1, renormalized: 1, skipped: 0 });
    const attrs = codeChanges.persist.mock.calls[0][0].norm.attrs as Record<string, unknown>;
    expect(attrs.runIds).toEqual([RUN_A]);
    // Stamped forward, so the next pass scans only what still needs it.
    const stamp = prisma.deliveryRawPayload.update.mock.calls[0][0];
    expect(stamp.data.normVersion).toBe(CODE_CHANGE_NORM_VERSION);
    expect(stamp.data.processedAt).toBeInstanceOf(Date);
  });

  it('replays a retained payload: no other normalized column moves', async () => {
    // The same payload twice — once carrying the trailer, once not. Every derived column
    // is compared between the two upserts, so "nothing else moved" is a measurement over
    // the whole normalized row rather than a promise about the columns someone thought of.
    const withTrailer = mockPrisma([historicalRow(10n, 11, `fix: the thing\n\nCoredoc-Run-Id: ${RUN_A}\n`)]);
    const without = mockPrisma([historicalRow(10n, 11, 'fix: the thing\n')]);
    const withTrailerChanges = codeChangePersistenceStub();
    const withoutChanges = codeChangePersistenceStub();
    await renormalizer(withTrailer, canonicalProjectionStub(), withTrailerChanges).renormalizeWorkspace('ws-1');
    await renormalizer(without, canonicalProjectionStub(), withoutChanges).renormalizeWorkspace('ws-1');

    const a = withTrailerChanges.persist.mock.calls[0][0].norm as Record<string, unknown>;
    const b = withoutChanges.persist.mock.calls[0][0].norm as Record<string, unknown>;
    const { attrs: attrsA, ...columnsA } = a;
    const { attrs: attrsB, ...columnsB } = b;
    // Non-vacuity, fails closed: the comparison is over a non-empty column set, and the
    // one field that IS expected to move is present on the trailer-carrying side.
    expect(Object.keys(columnsA).length).toBeGreaterThan(0);
    expect((attrsA as Record<string, unknown>).runIds).toEqual([RUN_A]);

    expect(columnsA).toEqual(columnsB);
    const { runIds: _a, ...restA } = attrsA as Record<string, unknown>;
    const { runIds: _b, ...restB } = attrsB as Record<string, unknown>;
    expect(restA).toEqual(restB);
  });

  it('replays a retained payload: the trailer’s run id lands on the change and the version stamps forward__absent_vs_ambiguous', async () => {
    // Hypothesis: absent-vs-ambiguous. A repository with no compatible run must
    // remain distinguishable from one whose run produced no retained ids. The key
    // must be ABSENT, never `[]` and never a default.
    //
    // Both rows are replayed in ONE pass, so the absence and the presence are read off
    // the same output: a scan that captured nothing at all would fail the presence half.
    const prisma = mockPrisma([
      historicalRow(10n, 11, `fix: the thing\n\nCoredoc-Run-Id: ${RUN_B}\n`),
      historicalRow(11n, 12, 'chore: no compatible workflow run here\n'),
    ]);
    const codeChanges = codeChangePersistenceStub();
    const service = renormalizer(prisma, canonicalProjectionStub(), codeChanges);

    await service.renormalizeWorkspace('ws-1');

    const adopted = codeChanges.persist.mock.calls[0][0].norm.attrs as Record<string, unknown>;
    const untouched = codeChanges.persist.mock.calls[1][0].norm.attrs as Record<string, unknown>;
    expect(adopted.runIds).toEqual([RUN_B]);
    expect('runIds' in untouched).toBe(false);
    expect('runIdsPartial' in untouched).toBe(false);
    // Both were still upgraded — the absence is a measured absence, not an unprocessed row.
    expect(prisma.deliveryRawPayload.update.mock.calls[1][0].data.normVersion).toBe(CODE_CHANGE_NORM_VERSION);
  });
});
