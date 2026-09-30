import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { CODE_CHANGE_NORM_VERSION } from './github-normalizer.js';
import {
  GITHUB_CANONICAL_PROJECTION_VERSION,
  GithubCanonicalProjectionService,
} from './github-canonical-projection.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTOR_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_REPO_ID = '33333333-3333-4333-8333-333333333333';
const CODE_CHANGE_ID = '44444444-4444-4444-8444-444444444444';
const REPLACEMENT_CODE_CHANGE_ID = '55555555-5555-4555-8555-555555555555';
const TASK_A = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_B = 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_C = 'cdt_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUN_A = 'cdr-20260817-a1b2c3';
const RUN_B = 'cdr-20260817-b2c3d4';
const FETCHED_AT = new Date('2026-08-17T12:00:00.000Z');
const MERGED_AT = new Date('2026-08-17T11:45:00.000Z');

interface RawRow {
  id: bigint;
  workspaceId: string;
  connectorId: string;
  resourceType: string;
  externalId: string;
  payload: Record<string, unknown>;
  truncated: boolean;
  fetchedAt: Date;
  normVersion: number | null;
  canonicalProjectionVersion: number | null;
}

interface CodeChangeRow {
  id: string;
  workspaceId: string;
  workspaceRepoId: string | null;
  provider: string;
  repoExternalId: string;
  externalId: string;
  mergedAt: Date | null;
  attrs: Record<string, unknown>;
}

interface WorkspaceRepoRow {
  id: string;
  workspaceId: string;
  captureRepositoryKey: string | null;
}

interface ExternalRefRow {
  id: bigint;
  workspaceId: string;
  deliveryTaskId: string;
  provider: string;
  externalId: string;
  externalKey: string | null;
}

interface WorkflowRunRow {
  id: string;
  workspaceId: string;
  runId: string;
  deliveryTaskId: string | null;
  repositoryKey: string | null;
  workItems: Array<{ provider: string; externalId: string }>;
}

interface AssociationRow {
  workspaceId: string;
  deliveryTaskId: string;
  codeChangeId: string;
  associationSource: string;
  associationSourceValue: string;
}

interface ShipEvidenceRow {
  id: bigint;
  workspaceId: string;
  deliveryTaskId: string;
  source: string;
  sourceKey: string;
  occurredAt: Date;
  receivedAt: Date;
  actorId: string | null;
  provider: string | null;
  repoExternalId: string | null;
  externalId: string | null;
}

interface ReworkSignalRow {
  id: bigint;
  workspaceId: string;
  deliveryTaskId: string;
  kind: string;
  sourceKey: string;
  sourceRef: string;
  occurredAt: Date;
  observedAt: Date;
}

interface TaskRow {
  workspaceId: string;
  id: string;
  title: string | null;
}

interface ProjectionSeed {
  raws?: RawRow[];
  codeChanges?: CodeChangeRow[];
  workspaceRepos?: WorkspaceRepoRow[];
  refs?: ExternalRefRow[];
  runs?: WorkflowRunRow[];
  associations?: AssociationRow[];
  shipEvidence?: ShipEvidenceRow[];
  reworkSignals?: ReworkSignalRow[];
  tasks?: TaskRow[];
  associationRaceOnce?: boolean;
  failShipCreate?: boolean;
}

function prPayload(
  input: {
    number?: number;
    repo?: string;
    issueKeys?: string[];
    runIds?: string[];
    mergedAt?: string | null;
    commitsIncomplete?: boolean;
    title?: string;
    reviews?: unknown[];
  } = {},
): Record<string, unknown> {
  const number = input.number ?? 7;
  const repo = input.repo ?? 'github/acme';
  return {
    repo,
    commitsIncomplete: input.commitsIncomplete,
    pr: {
      number,
      state: input.mergedAt ? 'closed' : 'open',
      merged_at: input.mergedAt ?? null,
      updated_at: '2026-08-17T12:00:00.000Z',
      created_at: '2026-08-16T08:00:00.000Z',
      title: input.title ?? `Synthetic PR ${number}`,
      body: '',
      head: { ref: input.issueKeys?.join('-and-') ?? 'feature/no-ticket' },
      base: { ref: 'main', repo: { full_name: repo } },
    },
    prDetail: {},
    reviews: input.reviews ?? [],
    files: [],
    commits: [
      // A review only produces a rework signal when a commit followed it INSIDE that review's
      // own window (before the next review by anyone), hence 09:10 rather than 10:00.
      ...(input.reviews === undefined
        ? []
        : [{ sha: 'after-review', commit: { committer: { date: '2026-08-17T09:10:00.000Z' } } }]),
      ...(input.runIds ?? []).map((runId, index) => ({
        sha: `synthetic-${index}`,
        commit: {
          message: `Synthetic commit ${index}\n\nCoredoc-Run-Id: ${runId}`,
          committer: { date: '2026-08-17T10:00:00.000Z' },
        },
      })),
    ],
  };
}

function rawRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    id: 10n,
    workspaceId: WORKSPACE_ID,
    connectorId: CONNECTOR_ID,
    resourceType: 'pull_request',
    externalId: '7',
    payload: prPayload({ commitsIncomplete: false }),
    truncated: false,
    fetchedAt: FETCHED_AT,
    normVersion: CODE_CHANGE_NORM_VERSION,
    canonicalProjectionVersion: null,
    ...overrides,
  };
}

function codeChangeRow(overrides: Partial<CodeChangeRow> = {}): CodeChangeRow {
  return {
    id: CODE_CHANGE_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRepoId: WORKSPACE_REPO_ID,
    provider: 'github',
    repoExternalId: 'github/acme',
    externalId: '7',
    mergedAt: null,
    // Deliberately not an evidence input. The projector must replay the retained raw
    // envelope so live import and later canonical replay use one resolver.
    attrs: { issueKeys: ['STALE-999'], runIds: ['cdr-20260817-ffffff'] },
    ...overrides,
  };
}

function workspaceRepo(overrides: Partial<WorkspaceRepoRow> = {}): WorkspaceRepoRow {
  return {
    id: WORKSPACE_REPO_ID,
    workspaceId: WORKSPACE_ID,
    captureRepositoryKey: 'capture/acme',
    ...overrides,
  };
}

function externalRef(externalKey: string, deliveryTaskId: string, id: bigint): ExternalRefRow {
  return { id, workspaceId: WORKSPACE_ID, deliveryTaskId, provider: 'jira', externalId: externalKey, externalKey };
}

function workItemRef(provider: string, externalId: string, deliveryTaskId: string, id: bigint): ExternalRefRow {
  return { id, workspaceId: WORKSPACE_ID, deliveryTaskId, provider, externalId, externalKey: null };
}

function workflowRun(
  runId: string,
  deliveryTaskId: string | null,
  repositoryKey = 'capture/acme',
  workItems: Array<{ provider: string; externalId: string }> = [],
): WorkflowRunRow {
  return {
    id: `00000000-0000-4000-8000-${String(runId.length).padStart(12, '0')}`,
    workspaceId: WORKSPACE_ID,
    runId,
    deliveryTaskId,
    repositoryKey,
    workItems,
  };
}

function deepField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = deepField(entry, key);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (key in record) return record[key];
  for (const entry of Object.values(record)) {
    const nested = deepField(entry, key);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function selectedStrings(value: unknown, key: string): string[] | null {
  const selected = deepField(value, key);
  if (typeof selected === 'string') return [selected];
  if (selected !== null && typeof selected === 'object') {
    const values = (selected as { in?: unknown }).in;
    if (Array.isArray(values) && values.every((entry) => typeof entry === 'string')) {
      return values as string[];
    }
  }
  return null;
}

function selectedIdentityPairs(value: unknown): Array<{ provider: string; externalId: string }> {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => selectedIdentityPairs(entry));
  const record = value as Record<string, unknown>;
  const own =
    typeof record.provider === 'string' && typeof record.externalId === 'string'
      ? [{ provider: record.provider, externalId: record.externalId }]
      : [];
  return [...own, ...Object.values(record).flatMap((entry) => selectedIdentityPairs(entry))];
}

function p2002(): Error & { code: string } {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

function projectionPrisma(seed: ProjectionSeed = {}) {
  const raws = [...(seed.raws ?? [rawRow()])];
  const codeChanges = [...(seed.codeChanges ?? [codeChangeRow()])];
  const workspaceRepos = [...(seed.workspaceRepos ?? [workspaceRepo()])];
  const refs = [...(seed.refs ?? [])];
  const runs = [...(seed.runs ?? [])];
  const associations = [...(seed.associations ?? [])];
  const shipEvidence = [...(seed.shipEvidence ?? [])];
  const reworkSignals = [...(seed.reworkSignals ?? [])];
  const tasks = [...(seed.tasks ?? [])];
  const operations: string[] = [];
  let associationRacePending = seed.associationRaceOnce === true;
  let transactionCalls = 0;

  const findAssociation = (args: unknown) => {
    const workspaceId = deepField(args, 'workspaceId');
    const deliveryTaskId = deepField(args, 'deliveryTaskId');
    const codeChangeId = deepField(args, 'codeChangeId');
    return (
      associations.find(
        (row) =>
          (workspaceId === undefined || row.workspaceId === workspaceId) &&
          (deliveryTaskId === undefined || row.deliveryTaskId === deliveryTaskId) &&
          (codeChangeId === undefined || row.codeChangeId === codeChangeId),
      ) ?? null
    );
  };
  const findEvidence = (args: unknown) => {
    const workspaceId = deepField(args, 'workspaceId');
    const source = deepField(args, 'source');
    const sourceKey = deepField(args, 'sourceKey');
    return (
      shipEvidence.find(
        (row) =>
          (workspaceId === undefined || row.workspaceId === workspaceId) &&
          (source === undefined || row.source === source) &&
          (sourceKey === undefined || row.sourceKey === sourceKey),
      ) ?? null
    );
  };

  const establishedReworkSignal = (data: { workspaceId: string; kind: string; sourceKey: string }) =>
    reworkSignals.find(
      (row) => row.workspaceId === data.workspaceId && row.kind === data.kind && row.sourceKey === data.sourceKey,
    ) ?? null;

  const tx = {
    deliveryRawPayload: {
      findFirst: vi.fn(async (args: unknown) => {
        const id = deepField(args, 'id');
        const workspaceId = deepField(args, 'workspaceId');
        return (
          raws.find(
            (row) =>
              (id === undefined || row.id === id) && (workspaceId === undefined || row.workspaceId === workspaceId),
          ) ?? null
        );
      }),
      update: vi.fn(async (args: { where: { id: bigint }; data: Record<string, unknown> }) => {
        operations.push('raw-stamp');
        const row = raws.find((candidate) => candidate.id === args.where.id);
        if (!row) throw new Error('raw row missing');
        if (typeof args.data.canonicalProjectionVersion === 'number') {
          row.canonicalProjectionVersion = args.data.canonicalProjectionVersion;
        }
        return { ...row };
      }),
    },
    codeChange: {
      findFirst: vi.fn(async (args: unknown) => {
        const id = deepField(args, 'id');
        const workspaceId = deepField(args, 'workspaceId');
        return (
          codeChanges.find(
            (row) =>
              (id === undefined || row.id === id) && (workspaceId === undefined || row.workspaceId === workspaceId),
          ) ?? null
        );
      }),
    },
    workspaceRepo: {
      findFirst: vi.fn(async (args: unknown) => {
        const id = deepField(args, 'id');
        const workspaceId = deepField(args, 'workspaceId');
        return (
          workspaceRepos.find(
            (row) =>
              (id === undefined || row.id === id) && (workspaceId === undefined || row.workspaceId === workspaceId),
          ) ?? null
        );
      }),
    },
    taskExternalRef: {
      findMany: vi.fn(async (args: unknown) => {
        const workspaceId = deepField(args, 'workspaceId');
        const keys = selectedStrings(args, 'externalKey');
        const identities = selectedIdentityPairs(deepField(args, 'OR'));
        return refs.filter(
          (row) =>
            (workspaceId === undefined || row.workspaceId === workspaceId) &&
            (keys !== null
              ? row.externalKey !== null && keys.includes(row.externalKey)
              : identities.length === 0 ||
                identities.some(
                  (identity) => identity.provider === row.provider && identity.externalId === row.externalId,
                )),
        );
      }),
    },
    workflowRun: {
      findMany: vi.fn(async (args: unknown) => {
        const workspaceId = deepField(args, 'workspaceId');
        const runIds = selectedStrings(args, 'runId');
        return runs.filter(
          (row) =>
            (workspaceId === undefined || row.workspaceId === workspaceId) &&
            (runIds === null || runIds.includes(row.runId)),
        );
      }),
    },
    deliveryTaskCodeChange: {
      findUnique: vi.fn(async (args: unknown) => findAssociation(args)),
      findMany: vi.fn(async (args: unknown) => {
        const workspaceId = deepField(args, 'workspaceId');
        const codeChangeId = deepField(args, 'codeChangeId');
        return associations.filter(
          (row) =>
            (workspaceId === undefined || row.workspaceId === workspaceId) &&
            (codeChangeId === undefined || row.codeChangeId === codeChangeId),
        );
      }),
      create: vi.fn(async (args: { data: AssociationRow }) => {
        operations.push('association');
        const established = findAssociation(args);
        if (established) throw p2002();
        associations.push({ ...args.data });
        if (associationRacePending) {
          associationRacePending = false;
          throw p2002();
        }
        return { ...args.data };
      }),
      update: vi.fn(async (args: { data: Partial<AssociationRow> } & Record<string, unknown>) => {
        operations.push('association-upgrade');
        const established = findAssociation(args);
        if (!established) throw new Error('association missing');
        Object.assign(established, args.data);
        return { ...established };
      }),
    },
    deliveryTask: {
      // Honors the `title: null` where-guard the fallback stamp relies on: a task
      // whose title is already set must not match, so the write is a no-op for it.
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: { title: string } }) => {
        operations.push('task-title-stamp');
        const matched = tasks.filter(
          (row) =>
            (args.where.workspaceId === undefined || row.workspaceId === args.where.workspaceId) &&
            (args.where.id === undefined || row.id === args.where.id) &&
            (!('title' in args.where) || row.title === args.where.title),
        );
        for (const row of matched) row.title = args.data.title;
        return { count: matched.length };
      }),
    },
    deliveryShipEvidence: {
      findUnique: vi.fn(async (args: unknown) => findEvidence(args)),
      create: vi.fn(async (args: { data: Omit<ShipEvidenceRow, 'id'> }) => {
        operations.push('ship-evidence');
        if (seed.failShipCreate) throw new Error('synthetic ship write failure');
        if (findEvidence(args)) throw p2002();
        const row = { id: BigInt(shipEvidence.length + 1), ...args.data };
        shipEvidence.push(row);
        return { ...row };
      }),
    },
    deliveryReworkSignal: {
      findMany: vi.fn(async (args: { where: { workspaceId: string; sourceKey: { in: string[] } } }) => {
        const keys = new Set(args.where.sourceKey.in);
        return reworkSignals
          .filter((row) => row.workspaceId === args.where.workspaceId && keys.has(row.sourceKey))
          .map((row) => ({ ...row }));
      }),
      createMany: vi.fn(async (args: { data: Omit<ReworkSignalRow, 'id'>[] }) => {
        operations.push('rework-signal');
        let count = 0;
        for (const data of args.data) {
          // skipDuplicates: an established row is a no-op, never a P2002.
          if (establishedReworkSignal(data)) continue;
          reworkSignals.push({ id: BigInt(reworkSignals.length + 1), ...data });
          count += 1;
        }
        return { count };
      }),
      update: vi.fn(async (args: { where: { id: bigint }; data: { sourceRef: string } }) => {
        operations.push('rework-signal-ref');
        const row = reworkSignals.find((candidate) => candidate.id === args.where.id);
        if (!row) throw new Error('rework signal not found');
        Object.assign(row, args.data);
        return { ...row };
      }),
    },
  };

  const prisma = {
    ...tx,
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
      transactionCalls += 1;
      return operation(tx);
    }),
  };
  return {
    prisma: prisma as unknown as PrismaService & typeof prisma,
    raws,
    codeChanges,
    associations,
    shipEvidence,
    reworkSignals,
    tasks,
    operations,
    transactionCalls: () => transactionCalls,
  };
}

function projector(seed: ProjectionSeed = {}) {
  const store = projectionPrisma(seed);
  // The intent actors have their own pure unit suite (intent-plan-transitions.test.ts)
  // and a Postgres one; this file is about the association/evidence projection.
  const intent = { applyToCodeChange: vi.fn(async () => undefined) };
  return {
    ...store,
    intent,
    service: new GithubCanonicalProjectionService(store.prisma, intent as never),
  };
}

function project(service: GithubCanonicalProjectionService, rawPayloadId = 10n, codeChangeId = CODE_CHANGE_ID) {
  return service.projectRawPayload({ workspaceId: WORKSPACE_ID, rawPayloadId, codeChangeId });
}

describe('GithubCanonicalProjectionService', () => {
  it('keeps normalized-wire and canonical-projection versions independent', () => {
    expect(CODE_CHANGE_NORM_VERSION).toBe(10);
    expect(GITHUB_CANONICAL_PROJECTION_VERSION).toBe(3);
  });

  it('stamps the PR title as a fallback onto an associated task without one', async () => {
    const { service, tasks } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['PROD-42'], commitsIncomplete: false }) })],
      refs: [externalRef('PROD-42', TASK_A, 3n)],
      tasks: [{ workspaceId: WORKSPACE_ID, id: TASK_A, title: null }],
    });

    await project(service);
    expect(tasks[0].title).toBe('Synthetic PR 7');
  });

  it('truncates on code points, so an astral character on the boundary never leaves a lone surrogate', async () => {
    // The normalizer caps titles at 512 UTF-16 units, which lands mid-emoji here: a naive
    // slice would hand Postgres invalid UTF-8, aborting the projection transaction and
    // turning this one PR into a watermark-gated replay loop.
    const { service, tasks } = projector({
      raws: [
        rawRow({
          payload: prPayload({ issueKeys: ['PROD-42'], commitsIncomplete: false, title: `${'x'.repeat(511)}😀 tail` }),
        }),
      ],
      refs: [externalRef('PROD-42', TASK_A, 3n)],
      tasks: [{ workspaceId: WORKSPACE_ID, id: TASK_A, title: null }],
    });

    await project(service);
    const stamped = tasks[0].title!;
    expect([...stamped].length).toBeLessThanOrEqual(512);
    // No unpaired surrogate anywhere — the string round-trips through UTF-8 unchanged.
    expect(/[\uD800-\uDFFF]/.test(stamped.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false);
    expect(Buffer.from(stamped, 'utf8').toString('utf8')).toBe(stamped);
  });

  it('does not stamp a whitespace-only PR title', async () => {
    const { service, tasks, prisma } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['PROD-42'], commitsIncomplete: false, title: '   \n\t ' }) })],
      refs: [externalRef('PROD-42', TASK_A, 3n)],
      tasks: [{ workspaceId: WORKSPACE_ID, id: TASK_A, title: null }],
    });

    await project(service);
    // A blank title must lose the `title: null` race to a later real one, not win it.
    expect(tasks[0].title).toBeNull();
    expect(prisma.deliveryTask.updateMany).not.toHaveBeenCalled();
  });

  it('never overwrites an established title: the guard is the title-null WHERE clause itself', async () => {
    const { service, tasks, prisma } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['PROD-42'], commitsIncomplete: false }) })],
      refs: [externalRef('PROD-42', TASK_A, 3n)],
      tasks: [{ workspaceId: WORKSPACE_ID, id: TASK_A, title: 'Jira authority title' }],
    });

    await project(service);
    expect(tasks[0].title).toBe('Jira authority title');
    const stamp = prisma.deliveryTask.updateMany.mock.calls[0][0];
    expect(stamp.where).toMatchObject({ title: null });
  });

  it('re-projection onto an already-associated task still backfills a missing title', async () => {
    const { service, tasks } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['PROD-42'], commitsIncomplete: false }) })],
      refs: [externalRef('PROD-42', TASK_A, 3n)],
      associations: [
        {
          workspaceId: WORKSPACE_ID,
          deliveryTaskId: TASK_A,
          codeChangeId: CODE_CHANGE_ID,
          associationSource: 'issue_key',
          associationSourceValue: 'PROD-42',
        },
      ],
      tasks: [{ workspaceId: WORKSPACE_ID, id: TASK_A, title: null }],
    });

    await project(service);
    expect(tasks[0].title).toBe('Synthetic PR 7');
  });

  it('associates only an exact-one issue key', async () => {
    const { service, associations } = projector({
      raws: [
        rawRow({
          payload: prPayload({
            issueKeys: ['MISSING-1', 'AMB-2', 'PROD-42'],
            commitsIncomplete: false,
          }),
        }),
      ],
      refs: [externalRef('AMB-2', TASK_B, 1n), externalRef('AMB-2', TASK_C, 2n), externalRef('PROD-42', TASK_A, 3n)],
    });

    await expect(project(service)).resolves.toEqual({ associations: 1, shipEvidence: 0, reworkSignals: 0 });
    expect(associations).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        deliveryTaskId: TASK_A,
        codeChangeId: CODE_CHANGE_ID,
        associationSource: 'issue_key',
        associationSourceValue: 'PROD-42',
      },
    ]);
  });

  it('leaves zero and multiple ref candidates unresolved even when duplicate refs name one task', async () => {
    const { service, associations } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['NONE-1', 'DUP-2'], commitsIncomplete: false }) })],
      refs: [externalRef('DUP-2', TASK_A, 1n), externalRef('DUP-2', TASK_A, 2n)],
    });

    await expect(project(service)).resolves.toEqual({ associations: 0, shipEvidence: 0, reworkSignals: 0 });
    expect(associations).toEqual([]);
  });

  it('resolves run evidence through an exact run FK and WorkspaceRepo capture provenance', async () => {
    const noTask = 'cdr-20260817-c3d4e5';
    const wrongRepo = 'cdr-20260817-d4e5f6';
    const { service, associations } = projector({
      raws: [
        rawRow({
          payload: prPayload({ runIds: [RUN_A, noTask, wrongRepo], commitsIncomplete: false }),
        }),
      ],
      runs: [
        workflowRun(RUN_A, TASK_A),
        workflowRun(noTask, null),
        workflowRun(wrongRepo, TASK_B, 'capture/another-repo'),
      ],
    });

    await expect(project(service)).resolves.toEqual({ associations: 1, shipEvidence: 0, reworkSignals: 0 });
    expect(associations).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        deliveryTaskId: TASK_A,
        codeChangeId: CODE_CHANGE_ID,
        associationSource: 'run_id',
        associationSourceValue: RUN_A,
      },
    ]);
  });

  it('fans one exact run relation out to every canonically matched work item', async () => {
    const { service, associations } = projector({
      raws: [rawRow({ payload: prPayload({ runIds: [RUN_B], commitsIncomplete: false }) })],
      refs: [workItemRef('jira', '10042', TASK_A, 1n), workItemRef('linear.issue', 'lin-42', TASK_B, 2n)],
      runs: [
        workflowRun(RUN_B, null, 'capture/acme', [
          { provider: 'jira', externalId: '10042' },
          { provider: 'linear.issue', externalId: 'lin-42' },
        ]),
      ],
    });

    await expect(project(service)).resolves.toEqual({ associations: 2, shipEvidence: 0, reworkSignals: 0 });
    expect(associations).toEqual([
      expect.objectContaining({ deliveryTaskId: TASK_A, associationSource: 'run_id', associationSourceValue: RUN_B }),
      expect.objectContaining({ deliveryTaskId: TASK_B, associationSource: 'run_id', associationSourceValue: RUN_B }),
    ]);
  });

  it.each([
    ['raw storage is truncated', { truncated: true }, false],
    ['commit pagination is explicitly incomplete', {}, true],
    ['commit completeness is absent', {}, undefined],
  ])('does not create run links when %s', async (_label, rawOverrides, commitsIncomplete) => {
    const { service, associations } = projector({
      raws: [
        rawRow({
          ...rawOverrides,
          payload: prPayload({ runIds: [RUN_A], commitsIncomplete }),
        }),
      ],
      runs: [workflowRun(RUN_A, TASK_A)],
    });

    await project(service);
    expect(associations).toEqual([]);
  });

  it('does not create run links from a normalized run set marked partial', async () => {
    const runIds = Array.from({ length: 51 }, (_, index) => `cdr-20260817-${index.toString(16).padStart(6, '0')}`);
    const { service, associations } = projector({
      raws: [rawRow({ payload: prPayload({ runIds, commitsIncomplete: false }) })],
      runs: [workflowRun(runIds[0], TASK_A)],
    });

    await project(service);
    expect(associations).toEqual([]);
  });

  it('does not create issue-key links from a truncated raw envelope', async () => {
    const { service, associations } = projector({
      raws: [
        rawRow({
          truncated: true,
          payload: prPayload({ issueKeys: ['PROD-42'], commitsIncomplete: false }),
        }),
      ],
      refs: [externalRef('PROD-42', TASK_A, 1n)],
    });

    await project(service);
    expect(associations).toEqual([]);
  });

  it('uses durable typed associations for merge evidence without inventing links from incomplete raw evidence', async () => {
    const { service, associations, shipEvidence } = projector({
      raws: [
        rawRow({
          payload: prPayload({ runIds: [RUN_A], mergedAt: MERGED_AT.toISOString(), commitsIncomplete: true }),
        }),
      ],
      codeChanges: [codeChangeRow({ mergedAt: MERGED_AT })],
      runs: [workflowRun(RUN_A, TASK_B)],
      associations: [
        {
          workspaceId: WORKSPACE_ID,
          deliveryTaskId: TASK_A,
          codeChangeId: CODE_CHANGE_ID,
          associationSource: 'external_ref',
          associationSourceValue: 'manual:existing',
        },
      ],
    });

    await expect(project(service)).resolves.toEqual({ associations: 0, shipEvidence: 1, reworkSignals: 0 });
    expect(associations).toHaveLength(1);
    expect(shipEvidence).toEqual([expect.objectContaining({ deliveryTaskId: TASK_A })]);
  });

  it('persists one rework signal per linked task per review, and replays idempotently', async () => {
    const reviews = [
      {
        id: 501,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-08-17T09:00:00.000Z',
        user: { login: 'reviewer', type: 'User' },
        html_url: 'https://github.com/acme/pull/7#pullrequestreview-501',
      },
      // Approvals are not rework, and neither is a bot.
      { id: 502, state: 'APPROVED', submitted_at: '2026-08-17T09:30:00.000Z', user: { login: 'reviewer' } },
      { id: 503, state: 'COMMENTED', submitted_at: '2026-08-17T09:40:00.000Z', user: { login: 'ci', type: 'Bot' } },
    ];
    const { service, reworkSignals } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['PROD-1', 'PROD-2'], reviews }) })],
      refs: [externalRef('PROD-1', TASK_A, 1n), externalRef('PROD-2', TASK_B, 2n)],
    });

    await expect(project(service)).resolves.toEqual({ associations: 2, shipEvidence: 0, reworkSignals: 2 });
    expect(reworkSignals).toEqual([
      expect.objectContaining({
        deliveryTaskId: TASK_A,
        kind: 'review_changes_requested',
        sourceRef: 'https://github.com/acme/pull/7#pullrequestreview-501',
        occurredAt: new Date('2026-08-17T09:00:00.000Z'),
        observedAt: FETCHED_AT,
      }),
      expect.objectContaining({ deliveryTaskId: TASK_B, kind: 'review_changes_requested' }),
    ]);
    // The task id is part of the key, so the two rows never collide.
    expect(new Set(reworkSignals.map((row) => row.sourceKey)).size).toBe(2);

    // Re-ingesting the same payload writes nothing new.
    await expect(project(service)).resolves.toEqual({ associations: 0, shipEvidence: 0, reworkSignals: 0 });
    expect(reworkSignals).toHaveLength(2);
  });

  const REVIEW = {
    id: 501,
    state: 'CHANGES_REQUESTED',
    submitted_at: '2026-08-17T09:00:00.000Z',
    user: { login: 'reviewer', type: 'User' },
    html_url: 'https://github.com/acme/pull/7#pullrequestreview-501',
  };

  it('fails a replay that contradicts the established occurredAt', async () => {
    const { service, reworkSignals } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['PROD-1'], reviews: [REVIEW] }) })],
      refs: [externalRef('PROD-1', TASK_A, 1n)],
    });
    await project(service);
    expect(reworkSignals).toHaveLength(1);

    // The same key now claims a different instant — an established fact cannot be rewritten.
    reworkSignals[0].occurredAt = new Date('2026-08-17T08:00:00.000Z');
    await expect(project(service)).rejects.toMatchObject({ status: 409 });
  });

  it('refreshes a drifted sourceRef instead of treating it as a contradiction', async () => {
    const { service, reworkSignals } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['PROD-1'], reviews: [REVIEW] }) })],
      refs: [externalRef('PROD-1', TASK_A, 1n)],
    });
    await project(service);
    // The repository was renamed after the first projection, so GitHub now reports a different
    // html_url for the same review.
    reworkSignals[0].sourceRef = 'https://github.com/acme/old-name/pull/7#pullrequestreview-501';

    await expect(project(service)).resolves.toEqual({ associations: 0, shipEvidence: 0, reworkSignals: 0 });
    expect(reworkSignals).toHaveLength(1);
    expect(reworkSignals[0].sourceRef).toBe(REVIEW.html_url);
  });

  it('uses run_id over issue_key and lexical source value ties, upgrading but never regressing provenance', async () => {
    const rawIssueAndRuns = rawRow({
      id: 10n,
      payload: prPayload({
        issueKeys: ['PROD-9', 'PROD-2'],
        runIds: [RUN_B, RUN_A],
        commitsIncomplete: false,
      }),
    });
    const rawIssueOnly = rawRow({
      id: 11n,
      payload: prPayload({ issueKeys: ['PROD-2'], commitsIncomplete: false }),
    });
    const { service, associations } = projector({
      raws: [rawIssueAndRuns, rawIssueOnly],
      refs: [externalRef('PROD-9', TASK_A, 1n), externalRef('PROD-2', TASK_A, 2n)],
      runs: [workflowRun(RUN_B, TASK_A), workflowRun(RUN_A, TASK_A)],
      associations: [
        {
          workspaceId: WORKSPACE_ID,
          deliveryTaskId: TASK_A,
          codeChangeId: CODE_CHANGE_ID,
          associationSource: 'issue_key',
          associationSourceValue: 'PROD-9',
        },
      ],
    });

    await project(service, 10n);
    expect(associations[0]).toMatchObject({
      associationSource: 'run_id',
      associationSourceValue: RUN_A,
    });

    await project(service, 11n);
    expect(associations[0]).toMatchObject({
      associationSource: 'run_id',
      associationSourceValue: RUN_A,
    });
  });

  it('associates one PR with multiple exact tasks and emits merge evidence per typed association', async () => {
    const { service, associations, shipEvidence } = projector({
      raws: [
        rawRow({
          payload: prPayload({
            issueKeys: ['PROD-42'],
            runIds: [RUN_B],
            mergedAt: MERGED_AT.toISOString(),
            commitsIncomplete: false,
          }),
        }),
      ],
      codeChanges: [codeChangeRow({ mergedAt: MERGED_AT })],
      refs: [externalRef('PROD-42', TASK_A, 1n)],
      runs: [workflowRun(RUN_B, TASK_B)],
    });

    await expect(project(service)).resolves.toEqual({ associations: 2, shipEvidence: 2, reworkSignals: 0 });
    expect(associations.map((row) => row.deliveryTaskId).sort()).toEqual([TASK_A, TASK_B]);
    expect(shipEvidence).toHaveLength(2);
    for (const evidence of shipEvidence) {
      expect(evidence).toMatchObject({
        workspaceId: WORKSPACE_ID,
        source: 'github_pr_merged',
        occurredAt: MERGED_AT,
        receivedAt: FETCHED_AT,
        actorId: null,
        provider: 'github',
        repoExternalId: 'github/acme',
        externalId: '7',
      });
      expect(evidence.sourceKey).toMatch(/^github-pr:[0-9a-f]{64}$/);
    }
    expect(new Set(shipEvidence.map((row) => row.sourceKey)).size).toBe(2);
  });

  it('keeps equal PR numbers collision-free across repositories', async () => {
    const repoBId = '66666666-6666-4666-8666-666666666666';
    const codeChangeBId = '77777777-7777-4777-8777-777777777777';
    const { service, shipEvidence } = projector({
      raws: [
        rawRow({
          id: 10n,
          payload: prPayload({ repo: 'github/a', issueKeys: ['AKEY-7'], mergedAt: MERGED_AT.toISOString() }),
        }),
        rawRow({
          id: 11n,
          externalId: '7',
          payload: prPayload({ repo: 'github/b', issueKeys: ['BKEY-7'], mergedAt: MERGED_AT.toISOString() }),
        }),
      ],
      codeChanges: [
        codeChangeRow({ repoExternalId: 'github/a', mergedAt: MERGED_AT }),
        codeChangeRow({
          id: codeChangeBId,
          workspaceRepoId: repoBId,
          repoExternalId: 'github/b',
          externalId: '7',
          mergedAt: MERGED_AT,
        }),
      ],
      workspaceRepos: [workspaceRepo(), workspaceRepo({ id: repoBId, captureRepositoryKey: 'capture/b' })],
      refs: [externalRef('AKEY-7', TASK_A, 1n), externalRef('BKEY-7', TASK_B, 2n)],
    });

    await project(service, 10n, CODE_CHANGE_ID);
    await project(service, 11n, codeChangeBId);

    expect(shipEvidence.map((row) => row.repoExternalId).sort()).toEqual(['github/a', 'github/b']);
    expect(new Set(shipEvidence.map((row) => row.sourceKey)).size).toBe(2);
  });

  it('is idempotent and retries one concurrent first association write', async () => {
    const { service, associations, raws, transactionCalls } = projector({
      raws: [rawRow({ payload: prPayload({ issueKeys: ['PROD-42'] }) })],
      refs: [externalRef('PROD-42', TASK_A, 1n)],
      associationRaceOnce: true,
    });

    await expect(project(service)).resolves.toEqual({ associations: 0, shipEvidence: 0, reworkSignals: 0 });
    expect(transactionCalls()).toBe(2);
    expect(associations).toHaveLength(1);
    expect(raws[0].canonicalProjectionVersion).toBe(GITHUB_CANONICAL_PROJECTION_VERSION);

    await expect(project(service)).resolves.toEqual({ associations: 0, shipEvidence: 0, reworkSignals: 0 });
    expect(associations).toHaveLength(1);
  });

  it('stamps only the projection version and only after association and merge projection succeed', async () => {
    const success = projector({
      raws: [
        rawRow({
          payload: prPayload({ issueKeys: ['PROD-42'], mergedAt: MERGED_AT.toISOString() }),
        }),
      ],
      codeChanges: [codeChangeRow({ mergedAt: MERGED_AT })],
      refs: [externalRef('PROD-42', TASK_A, 1n)],
    });

    await project(success.service);
    const stamp = success.prisma.deliveryRawPayload.update.mock.calls[0][0];
    expect(stamp.data).toEqual({ canonicalProjectionVersion: GITHUB_CANONICAL_PROJECTION_VERSION });
    expect(stamp.data.normVersion).toBeUndefined();
    expect(success.operations).toEqual(['association', 'task-title-stamp', 'ship-evidence', 'raw-stamp']);

    const failed = projector({
      raws: [
        rawRow({
          payload: prPayload({ issueKeys: ['PROD-42'], mergedAt: MERGED_AT.toISOString() }),
        }),
      ],
      codeChanges: [codeChangeRow({ mergedAt: MERGED_AT })],
      refs: [externalRef('PROD-42', TASK_A, 1n)],
      failShipCreate: true,
    });
    await expect(project(failed.service)).rejects.toThrow('synthetic ship write failure');
    expect(failed.prisma.deliveryRawPayload.update).not.toHaveBeenCalled();
    expect(failed.raws[0].canonicalProjectionVersion).toBeNull();
  });

  it('dedupes merge evidence after the CodeChange surrogate is replaced', async () => {
    const firstRaw = rawRow({
      id: 10n,
      payload: prPayload({ issueKeys: ['PROD-42'], mergedAt: MERGED_AT.toISOString() }),
    });
    const replacementRaw = rawRow({
      id: 11n,
      payload: prPayload({ issueKeys: ['PROD-42'], mergedAt: MERGED_AT.toISOString() }),
    });
    const store = projector({
      raws: [firstRaw, replacementRaw],
      codeChanges: [codeChangeRow({ mergedAt: MERGED_AT })],
      refs: [externalRef('PROD-42', TASK_A, 1n)],
    });

    await expect(project(store.service, 10n)).resolves.toEqual({ associations: 1, shipEvidence: 1, reworkSignals: 0 });
    const originalKey = store.shipEvidence[0].sourceKey;

    store.associations.length = 0;
    store.codeChanges.splice(0, 1, codeChangeRow({ id: REPLACEMENT_CODE_CHANGE_ID, mergedAt: MERGED_AT }));
    await expect(project(store.service, 11n, REPLACEMENT_CODE_CHANGE_ID)).resolves.toEqual({
      associations: 1,
      shipEvidence: 0,
      reworkSignals: 0,
    });

    expect(store.shipEvidence).toHaveLength(1);
    expect(store.shipEvidence[0].sourceKey).toBe(originalKey);
    expect(store.associations).toEqual([
      expect.objectContaining({ codeChangeId: REPLACEMENT_CODE_CHANGE_ID, deliveryTaskId: TASK_A }),
    ]);
  });
});
