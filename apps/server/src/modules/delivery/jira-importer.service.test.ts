import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import type { ActorRegistryService } from './actor-registry.service.js';
import type { CanonicalDeliveryService } from './canonical-delivery.service.js';
import { JiraAuthError, JiraRateLimitError } from './jira-client.js';
import { JIRA_NORM_VERSION, JiraImporterService } from './jira-importer.service.js';
import { packRawPayload, unpackRawPayload } from './raw-payload-codec.js';
import type { StatusMapService } from './status-map.service.js';

// Every provider payload in this file is synthetic. No Jira workspace or genuine
// redacted issue/changelog fixture was available when the C3 contract was accepted.

const encMocks = {
  decrypt: vi.fn((value: string) => value),
  isEncryptionAvailable: vi.fn(() => true),
};
vi.mock('../../database/encryption.js', () => ({
  decrypt: (value: string) => encMocks.decrypt(value),
  isEncryptionAvailable: () => encMocks.isEncryptionAvailable(),
}));

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const CREDS = JSON.stringify({ email: 'bot@acme.com', apiToken: 'synthetic-token' });
const baseConnector = {
  id: CONNECTOR_ID,
  workspaceId: WORKSPACE_ID,
  provider: 'jira',
  baseUrl: 'https://acme.atlassian.net',
  credentialsEncrypted: CREDS,
  config: {},
  cursors: {},
};

type SyntheticIssue = Record<string, unknown>;
type SearchResult = { items: SyntheticIssue[]; nextPageToken: string | null };
type ChangelogResult = {
  items: unknown[];
  total: number | null;
  nextStartAt: number | null;
  incomplete: boolean;
};

function issue(
  id: string,
  key: string,
  updated: string,
  over: { fields?: Record<string, unknown>; changelog?: Record<string, unknown> } = {},
): SyntheticIssue {
  return {
    id,
    key,
    fields: {
      summary: `Synthetic issue ${key}`,
      status: { name: 'Done' },
      issuetype: { name: 'Story' },
      created: '2026-01-01T00:00:00.000Z',
      updated,
      resolutiondate: null,
      assignee: null,
      reporter: null,
      labels: [],
      priority: { name: 'High' },
      project: { key: 'PROD' },
      ...(over.fields ?? {}),
    },
    changelog: over.changelog ?? { total: 0, histories: [] },
  };
}

function search(items: SyntheticIssue[], nextPageToken: string | null = null): SearchResult {
  return { items, nextPageToken };
}

function changelog(items: unknown[], over: Partial<Omit<ChangelogResult, 'items'>> = {}): ChangelogResult {
  return {
    items,
    total: items.length,
    nextStartAt: null,
    incomplete: false,
    ...over,
  };
}

function mockClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    listStatuses: vi.fn().mockResolvedValue([
      { name: 'To Do', statusCategory: { key: 'new' } },
      { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      { name: 'Done', statusCategory: { key: 'done' } },
    ]),
    listProjectStatuses: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue(search([])),
    listChangelog: vi.fn().mockResolvedValue(changelog([])),
    ...over,
  };
}

function mockRegistry() {
  return {
    seedWorkspace: vi.fn().mockResolvedValue({ actors: 0, identities: 0 }),
    resolveJiraActor: vi.fn(async (_workspaceId: string, hints: { accountId: string }) => `actor-${hints.accountId}`),
  } as unknown as ActorRegistryService & {
    seedWorkspace: ReturnType<typeof vi.fn>;
    resolveJiraActor: ReturnType<typeof vi.fn>;
  };
}

function mockStatusMap() {
  return {
    bootstrapFromStatuses: vi.fn().mockResolvedValue({ created: 3 }),
  } as unknown as StatusMapService & {
    bootstrapFromStatuses: ReturnType<typeof vi.fn>;
  };
}

function mockCanonical(statuses: Array<'accepted' | 'updated' | 'duplicate' | 'stale'> = ['accepted']) {
  let call = 0;
  return {
    resolveConnectorTask: vi.fn(async () => {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call += 1;
      return {
        status,
        taskId: 'cdt_33333333-3333-4333-8333-333333333333',
        externalRef: { id: '41', provider: 'jira', externalId: '10001' },
        authority: {
          kind: 'external_ref',
          externalRefId: '41',
          provider: 'jira',
          externalId: '10001',
          connected: true,
        },
      };
    }),
  } as unknown as CanonicalDeliveryService & {
    resolveConnectorTask: ReturnType<typeof vi.fn>;
  };
}

function mockProjection() {
  return {
    projectIssue: vi.fn().mockResolvedValue({
      stateFacts: 0,
      lifecycleChanged: false,
      shipEvidence: 0,
      reworkSignals: 0,
    }),
  };
}

function mockPrisma(connector: Record<string, unknown> = baseConnector) {
  const prisma = {
    deliveryConnector: {
      findUnique: vi.fn().mockResolvedValue(connector),
      update: vi.fn().mockResolvedValue({}),
    },
    deliveryRawPayload: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    taskExternalRef: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

function canonicalConflict(code: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message: 'synthetic canonical conflict',
  });
}

function makeService(
  prisma: ReturnType<typeof mockPrisma>,
  client: ReturnType<typeof mockClient>,
  canonical = mockCanonical(),
  projection = mockProjection(),
  registry = mockRegistry(),
  statusMap = mockStatusMap(),
) {
  // The cast lets this RED suite name the accepted C3 constructor seam before the
  // production constructor has been extended. Runtime assertions stay the proof.
  const Constructor = JiraImporterService as unknown as new (
    prismaService: PrismaService,
    actorRegistry: ActorRegistryService,
    statusMapService: StatusMapService,
    canonicalDelivery: CanonicalDeliveryService,
    jiraProjection: ReturnType<typeof mockProjection>,
    clientFactory: () => ReturnType<typeof mockClient>,
  ) => JiraImporterService;
  return new Constructor(prisma, registry, statusMap, canonical, projection, () => client);
}

function parseJqlUtc(literal: string): number {
  const match = literal.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
  if (!match) throw new Error(`unparseable JQL literal: ${literal}`);
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
}

beforeEach(() => {
  encMocks.decrypt.mockClear().mockImplementation((value: string) => value);
  encMocks.isEncryptionAvailable.mockClear().mockReturnValue(true);
  vi.restoreAllMocks();
});

describe('JiraImporterService C3 canonical cutover', () => {
  it('first import resolves one canonical identity, projects state/history, stores raw v1, and makes zero legacy writes', async () => {
    const synthetic = issue('10001', 'PROD-1', '2026-08-01T12:00:00.000Z', {
      fields: {
        status: { name: 'In Progress' },
        assignee: { accountId: 'acc-assignee', displayName: 'Synthetic Assignee' },
      },
      changelog: {
        total: 1,
        histories: [
          {
            id: 'history-1',
            created: '2026-08-01T11:00:00.000Z',
            author: { accountId: 'acc-author', displayName: 'Synthetic Author' },
            items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
          },
        ],
      },
    });
    const client = mockClient({ searchIssues: vi.fn().mockResolvedValue(search([synthetic])) });
    const prisma = mockPrisma();
    const canonical = mockCanonical(['accepted']);
    const projection = mockProjection();
    const registry = mockRegistry();
    const result = await makeService(prisma, client, canonical, projection, registry).syncConnector(CONNECTOR_ID);

    expect(result).toEqual({ issues: 1, issuesIncomplete: false, changelogsIncomplete: false });
    expect(canonical.resolveConnectorTask).toHaveBeenCalledWith(CONNECTOR_ID, {
      repositoryKey: null,
      externalId: '10001',
      externalKey: 'PROD-1',
      externalUrl: 'https://acme.atlassian.net/browse/PROD-1',
      externalState: 'In Progress',
      sourceCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
      sourceUpdatedAt: new Date('2026-08-01T12:00:00.000Z'),
      observedAt: expect.any(Date),
    });
    expect(projection.projectIssue).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      connectorId: CONNECTOR_ID,
      taskId: 'cdt_33333333-3333-4333-8333-333333333333',
      externalRefId: 41n,
      currentState: 'In Progress',
      title: 'Synthetic issue PROD-1',
      sourceUpdatedAt: new Date('2026-08-01T12:00:00.000Z'),
      observedAt: expect.any(Date),
      transitions: [
        {
          sourceRef: 'history-1',
          fromState: 'To Do',
          toState: 'In Progress',
          occurredAt: new Date('2026-08-01T11:00:00.000Z'),
          actorId: 'actor-acc-author',
        },
      ],
    });
    expect(prisma.deliveryRawPayload.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        connectorId: CONNECTOR_ID,
        resourceType: 'issue',
        externalId: '10001',
        truncated: false,
        normVersion: JIRA_NORM_VERSION,
      }),
    });
    expect(JIRA_NORM_VERSION).toBe(1);
  });

  it('keeps stable issue identity while a newer observation changes key, URL, and status', async () => {
    const before = issue('10001', 'OLD-1', '2026-08-01T12:00:00.000Z', {
      fields: { status: { name: 'In Progress' } },
    });
    const after = issue('10001', 'NEW-9', '2026-08-02T12:00:00.000Z', {
      fields: { status: { name: 'Done' } },
    });
    const client = mockClient({ searchIssues: vi.fn().mockResolvedValue(search([before, after])) });
    const prisma = mockPrisma();
    const canonical = mockCanonical(['accepted', 'updated']);
    const projection = mockProjection();

    await expect(makeService(prisma, client, canonical, projection).syncConnector(CONNECTOR_ID)).resolves.toEqual({
      issues: 2,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });

    const observations = canonical.resolveConnectorTask.mock.calls.map((call) => call[1]);
    expect(observations).toEqual([
      expect.objectContaining({
        externalId: '10001',
        externalKey: 'OLD-1',
        externalUrl: 'https://acme.atlassian.net/browse/OLD-1',
        externalState: 'In Progress',
      }),
      expect.objectContaining({
        externalId: '10001',
        externalKey: 'NEW-9',
        externalUrl: 'https://acme.atlassian.net/browse/NEW-9',
        externalState: 'Done',
      }),
    ]);
    expect(projection.projectIssue).toHaveBeenCalledTimes(2);
  });

  it('replays an exact duplicate through the idempotent projector but does not count or restorage it; stale is a total no-op', async () => {
    const duplicate = issue('10001', 'PROD-1', '2026-08-02T12:00:00.000Z');
    const stale = issue('10001', 'PROD-OLD', '2026-07-01T12:00:00.000Z');
    const client = mockClient({ searchIssues: vi.fn().mockResolvedValue(search([duplicate, stale])) });
    const prisma = mockPrisma({
      ...baseConnector,
      cursors: { issues: '2026-08-02T12:00:00.000Z' },
    });
    prisma.deliveryRawPayload.findFirst.mockResolvedValue({
      payload: packRawPayload({ issue: duplicate, extraChangelog: [] }, { issue: duplicate }).payload,
    });
    const canonical = mockCanonical(['duplicate', 'stale']);
    const projection = mockProjection();

    await expect(makeService(prisma, client, canonical, projection).syncConnector(CONNECTOR_ID)).resolves.toEqual({
      issues: 0,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });

    expect(canonical.resolveConnectorTask).toHaveBeenCalledTimes(2);
    expect(projection.projectIssue).toHaveBeenCalledTimes(1);
    expect(projection.projectIssue).toHaveBeenCalledWith(expect.objectContaining({ currentState: 'Done' }));
    expect(prisma.deliveryRawPayload.create).not.toHaveBeenCalled();
    const persisted = prisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors;
    expect(persisted.issues).toBe('2026-08-02T12:00:00.000Z');
  });

  it.each([
    'accepted',
    'updated',
  ] as const)('repairs the exact raw snapshot on a duplicate retry after an %s resolver result committed first', async (firstStatus) => {
    const extraHistory = {
      id: 'history-retry',
      created: '2026-08-02T11:00:00.000Z',
      items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }],
    };
    const synthetic = issue('10001', 'PROD-1', '2026-08-02T12:00:00.000Z', {
      changelog: { total: 1, histories: [] },
    });
    const client = mockClient({
      searchIssues: vi.fn().mockResolvedValue(search([synthetic])),
      listChangelog: vi.fn().mockResolvedValue(changelog([extraHistory])),
    });
    const prisma = mockPrisma();
    const retained: Array<{ payload: unknown }> = [];
    prisma.deliveryRawPayload.findFirst.mockImplementation(async () => retained.at(-1) ?? null);
    prisma.deliveryRawPayload.create.mockImplementationOnce(async () => {
      throw new Error('synthetic raw snapshot write failure');
    });
    prisma.deliveryRawPayload.create.mockImplementation(async ({ data }) => {
      retained.push({ payload: data.payload });
      return {};
    });
    const canonical = mockCanonical([firstStatus, 'duplicate', 'duplicate']);
    const projection = mockProjection();
    const service = makeService(prisma, client, canonical, projection);

    await expect(service.syncConnector(CONNECTOR_ID)).rejects.toThrow('synthetic raw snapshot write failure');
    expect(projection.projectIssue).not.toHaveBeenCalled();
    expect(prisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors).toEqual({});

    await expect(service.syncConnector(CONNECTOR_ID)).resolves.toEqual({
      issues: 0,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });
    expect(unpackRawPayload(prisma.deliveryRawPayload.create.mock.calls[1][0].data.payload)).toEqual({
      issue: synthetic,
      extraChangelog: [extraHistory],
    });
    expect(prisma.deliveryRawPayload.create.mock.invocationCallOrder[1]).toBeLessThan(
      projection.projectIssue.mock.invocationCallOrder[0],
    );
    expect(projection.projectIssue.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.deliveryConnector.update.mock.invocationCallOrder[1],
    );
    expect(prisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors).toEqual({
      issues: '2026-08-02T12:00:00.000Z',
    });

    await expect(service.syncConnector(CONNECTOR_ID)).resolves.toEqual({
      issues: 0,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });
    expect(retained).toHaveLength(1);
    expect(prisma.deliveryRawPayload.create).toHaveBeenCalledTimes(2);
    expect(prisma.deliveryRawPayload.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.deliveryRawPayload.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: WORKSPACE_ID,
        connectorId: CONNECTOR_ID,
        resourceType: 'issue',
        externalId: '10001',
      },
      orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
      select: { payload: true },
    });
    expect(projection.projectIssue).toHaveBeenCalledTimes(2);
  });

  it('never regresses an overlap cursor even when provider rows arrive out of order', async () => {
    const newer = issue('10002', 'PROD-2', '2026-08-03T12:00:00.000Z');
    const older = issue('10001', 'PROD-1', '2026-07-01T12:00:00.000Z');
    const client = mockClient({ searchIssues: vi.fn().mockResolvedValue(search([newer, older])) });
    const prisma = mockPrisma({
      ...baseConnector,
      cursors: { issues: '2026-08-02T12:00:00.000Z' },
    });
    const canonical = mockCanonical(['updated', 'stale']);

    await makeService(prisma, client, canonical).syncConnector(CONNECTOR_ID);

    expect(prisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors.issues).toBe('2026-08-03T12:00:00.000Z');
  });

  it.each([
    'resolver',
    'projection',
  ] as const)('isolates an allow-listed canonical %s conflict and continues later issues without checkpointing the conflict', async (conflictAt) => {
    const conflictedExternalId = '9'.repeat(300);
    const conflicted = issue(conflictedExternalId, 'PROD-9', '2026-08-09T12:00:00.000Z');
    const successful = issue('10001', 'PROD-1', '2026-08-08T12:00:00.000Z');
    const client = mockClient({ searchIssues: vi.fn().mockResolvedValue(search([conflicted, successful])) });
    const prisma = mockPrisma();
    const canonical = mockCanonical(['accepted', 'accepted']);
    const projection = mockProjection();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    if (conflictAt === 'resolver') {
      canonical.resolveConnectorTask.mockRejectedValueOnce(canonicalConflict('TASK_EXTERNAL_REF_CONFLICT'));
    } else {
      projection.projectIssue.mockRejectedValueOnce(canonicalConflict('TASK_STATE_FACT_CONFLICT'));
    }

    await expect(makeService(prisma, client, canonical, projection).syncConnector(CONNECTOR_ID)).resolves.toEqual({
      issues: 1,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });

    expect(canonical.resolveConnectorTask).toHaveBeenCalledTimes(2);
    expect(projection.projectIssue).toHaveBeenCalledTimes(conflictAt === 'resolver' ? 1 : 2);
    expect(prisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors).toEqual({
      issues: '2026-08-08T12:00:00.000Z',
    });
    const code = conflictAt === 'resolver' ? 'TASK_EXTERNAL_REF_CONFLICT' : 'TASK_STATE_FACT_CONFLICT';
    expect(warn).toHaveBeenCalledWith(
      `jira import: skipped issue externalId=${JSON.stringify(conflictedExternalId.slice(0, 256))} conflict=${code}`,
    );
  });

  it('aborts the chunk for a ConflictException whose response code is not allow-listed', async () => {
    const client = mockClient({
      searchIssues: vi
        .fn()
        .mockResolvedValue(
          search([
            issue('10001', 'PROD-1', '2026-08-01T12:00:00.000Z'),
            issue('10002', 'PROD-2', '2026-08-02T12:00:00.000Z'),
          ]),
        ),
    });
    const prisma = mockPrisma();
    const canonical = mockCanonical(['accepted', 'accepted']);
    const unknownConflict = canonicalConflict('UNEXPECTED_CONFLICT');
    canonical.resolveConnectorTask.mockRejectedValueOnce(unknownConflict);

    await expect(makeService(prisma, client, canonical).syncConnector(CONNECTOR_ID)).rejects.toBe(unknownConflict);

    expect(canonical.resolveConnectorTask).toHaveBeenCalledTimes(1);
    expect(prisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors).toEqual({});
  });
});

describe('JiraImporterService C3 bounded reset/full-refetch continuation', () => {
  it('persists an opaque search continuation with its frozen query cursor, then exhausts and advances once', async () => {
    // The backfill floor is a function of `now`, so freeze time: the continuation must
    // carry the FIRST page's floor even though the window slides between pages.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'));
    let continuation: Record<string, unknown> | undefined;
    try {
      const firstIssue = issue('10001', 'PROD-1', '2026-08-01T12:00:00.000Z');
      const firstClient = mockClient({
        searchIssues: vi.fn().mockResolvedValue(search([firstIssue], 'opaque-page-2')),
      });
      const firstPrisma = mockPrisma({ ...baseConnector, cursors: {} });

      await expect(makeService(firstPrisma, firstClient).syncConnector(CONNECTOR_ID)).resolves.toEqual({
        issues: 1,
        issuesIncomplete: true,
        changelogsIncomplete: false,
      });
      expect(firstClient.searchIssues).toHaveBeenCalledWith(
        'updated >= "2026/07/04 11:00" ORDER BY updated ASC',
        expect.any(Array),
        { nextPageToken: null },
      );
      continuation = firstPrisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors;
      expect(continuation).toEqual({
        issuesContinuation: {
          queryCursor: '2026-07-05T00:00:00.000Z',
          nextPageToken: 'opaque-page-2',
          maxUpdatedAt: '2026-08-01T12:00:00.000Z',
        },
      });

      // A day passes mid-backfill; the frozen queryCursor must survive it unchanged.
      vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'));
      const secondIssue = issue('10002', 'PROD-2', '2026-08-02T12:00:00.000Z');
      const secondClient = mockClient({ searchIssues: vi.fn().mockResolvedValue(search([secondIssue])) });
      const secondPrisma = mockPrisma({ ...baseConnector, cursors: continuation });

      await expect(makeService(secondPrisma, secondClient).syncConnector(CONNECTOR_ID)).resolves.toEqual({
        issues: 1,
        issuesIncomplete: false,
        changelogsIncomplete: false,
      });
      expect(secondClient.searchIssues).toHaveBeenCalledWith(
        'updated >= "2026/07/04 11:00" ORDER BY updated ASC',
        expect.any(Array),
        { nextPageToken: 'opaque-page-2' },
      );
      expect(secondPrisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors).toEqual({
        issues: '2026-08-02T12:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not checkpoint the returned next token until every item in that chunk finishes projection', async () => {
    const connector = {
      ...baseConnector,
      cursors: {
        issuesContinuation: {
          queryCursor: null,
          nextPageToken: 'opaque-current',
          maxUpdatedAt: '2026-08-01T00:00:00.000Z',
        },
      },
    };
    const client = mockClient({
      searchIssues: vi
        .fn()
        .mockResolvedValue(
          search(
            [
              issue('10002', 'PROD-2', '2026-08-02T00:00:00.000Z'),
              issue('10003', 'PROD-3', '2026-08-03T00:00:00.000Z'),
            ],
            'opaque-returned-too-early',
          ),
        ),
    });
    const prisma = mockPrisma(connector);
    const projection = mockProjection();
    projection.projectIssue.mockResolvedValueOnce({
      stateFacts: 0,
      lifecycleChanged: false,
      shipEvidence: 0,
      reworkSignals: 0,
    });
    projection.projectIssue.mockRejectedValueOnce(new Error('synthetic projector failure'));

    await expect(
      makeService(prisma, client, mockCanonical(['accepted', 'accepted']), projection).syncConnector(CONNECTOR_ID),
    ).rejects.toThrow('synthetic projector failure');

    const persisted = prisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors;
    expect(persisted.issuesContinuation.nextPageToken).toBe('opaque-current');
    expect(persisted.issuesContinuation.nextPageToken).not.toBe('opaque-returned-too-early');
  });

  it('reports bounded changelog incompleteness and marks the stored raw envelope truncated', async () => {
    const synthetic = issue('10001', 'PROD-1', '2026-08-01T12:00:00.000Z', {
      changelog: { total: 250, histories: [] },
    });
    const client = mockClient({
      searchIssues: vi.fn().mockResolvedValue(search([synthetic])),
      listChangelog: vi.fn().mockResolvedValue(
        changelog(
          [
            {
              id: 'history-1',
              created: '2026-08-01T11:00:00.000Z',
              items: [{ field: 'status', fromString: 'To Do', toString: 'Done' }],
            },
          ],
          { total: 250, nextStartAt: 100, incomplete: true },
        ),
      ),
    });
    const prisma = mockPrisma();

    await expect(makeService(prisma, client).syncConnector(CONNECTOR_ID)).resolves.toEqual({
      issues: 1,
      issuesIncomplete: false,
      changelogsIncomplete: true,
    });
    expect(client.listChangelog).toHaveBeenCalledWith('10001');
    expect(prisma.deliveryRawPayload.create.mock.calls[0][0].data.truncated).toBe(true);
  });
});

describe('JiraImporterService backfill ingest window', () => {
  it('floors a first sync at the default 30-day window instead of fetching all history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'));
    try {
      const client = mockClient();
      const prisma = mockPrisma({ ...baseConnector, config: { projects: ['PROD'] }, cursors: {} });

      await makeService(prisma, client).syncConnector(CONNECTOR_ID);

      const [jql] = client.searchIssues.mock.calls[0];
      const match = jql.match(/updated >= "([^"]+)"/);
      expect(match).not.toBeNull();
      expect(parseJqlUtc(match[1])).toBe(new Date('2026-07-05T00:00:00.000Z').getTime() - 13 * 3_600_000);
      expect(jql).toContain('project in (PROD)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('floors a first sync at an absolute config.since, whenever that sync runs', async () => {
    vi.useFakeTimers();
    try {
      const since = '2026-08-01T00:00:00.000Z';
      // Two syncs a month apart resolve the SAME floor — that is the point of `since`.
      for (const now of ['2026-08-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z']) {
        vi.setSystemTime(new Date(now));
        const client = mockClient();
        const prisma = mockPrisma({ ...baseConnector, config: { projects: [], since }, cursors: {} });

        await makeService(prisma, client).syncConnector(CONNECTOR_ID);

        const [jql] = client.searchIssues.mock.calls[0];
        const match = jql.match(/updated >= "([^"]+)"/);
        expect(match).not.toBeNull();
        expect(parseJqlUtc(match[1])).toBe(new Date(since).getTime() - 13 * 3_600_000);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors config.lookbackDays on the backfill floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'));
    try {
      const client = mockClient();
      const prisma = mockPrisma({ ...baseConnector, config: { projects: [], lookbackDays: 7 }, cursors: {} });

      await makeService(prisma, client).syncConnector(CONNECTOR_ID);

      const [jql] = client.searchIssues.mock.calls[0];
      const match = jql.match(/updated >= "([^"]+)"/);
      expect(match).not.toBeNull();
      expect(parseJqlUtc(match[1])).toBe(new Date('2026-07-28T00:00:00.000Z').getTime() - 13 * 3_600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the window inert when a stored cursor predates it — never max(cursor, window)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'));
    try {
      const client = mockClient();
      const cursor = '2026-01-15T12:00:00.000Z'; // far older than the 30-day window
      const prisma = mockPrisma({ ...baseConnector, config: { projects: [] }, cursors: { issues: cursor } });

      await makeService(prisma, client).syncConnector(CONNECTOR_ID);

      const [jql] = client.searchIssues.mock.calls[0];
      const match = jql.match(/updated >= "([^"]+)"/);
      expect(parseJqlUtc(match[1])).toBe(new Date(cursor).getTime() - 13 * 3_600_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('JiraImporterService C3 preserved fetch, bootstrap, actor, and guard behavior', () => {
  it('uses the 13-hour overlap and sanitized project fields while passing no continuation', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = mockClient();
    const cursor = '2026-01-15T12:00:00.000Z';
    const prisma = mockPrisma({
      ...baseConnector,
      cursors: { issues: cursor },
      config: {
        projects: ['PROD', 'ABC123', 'BAD-KEY', 'A', 'toolong'],
        specFields: ['customfield_10010', 'bad', 'customfield_20'],
      },
    });

    await makeService(prisma, client).syncConnector(CONNECTOR_ID);

    const [jql, fields, options] = client.searchIssues.mock.calls[0];
    const match = jql.match(/updated >= "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(parseJqlUtc(match[1])).toBe(new Date(cursor).getTime() - 13 * 3_600_000);
    expect(jql).toContain('project in (PROD, ABC123)');
    expect(jql).not.toContain('BAD-KEY');
    expect(jql).toMatch(/ORDER BY updated ASC$/);
    expect(fields).not.toContain('customfield_10010');
    expect(fields).not.toContain('customfield_20');
    expect(options).toEqual({ nextPageToken: null });
    expect(warn).toHaveBeenCalled();
  });

  it('merges global and flattened project statuses in one bootstrap call', async () => {
    const global = [{ name: 'To Do', statusCategory: { key: 'new' } }];
    const project = [
      {
        id: 'story',
        statuses: [
          { id: '10', name: 'Backlog', statusCategory: { key: 'new' } },
          { id: '11', name: 'Ready', statusCategory: { key: 'done' } },
        ],
      },
    ];
    const client = mockClient({
      listStatuses: vi.fn().mockResolvedValue(global),
      listProjectStatuses: vi.fn().mockResolvedValue(project),
    });
    const prisma = mockPrisma({ ...baseConnector, config: { projects: ['TEAM'] } });
    const statusMap = mockStatusMap();

    await makeService(prisma, client, mockCanonical(), mockProjection(), mockRegistry(), statusMap).syncConnector(
      CONNECTOR_ID,
    );

    expect(statusMap.bootstrapFromStatuses).toHaveBeenCalledTimes(1);
    expect(statusMap.bootstrapFromStatuses).toHaveBeenCalledWith(WORKSPACE_ID, CONNECTOR_ID, [
      ...global,
      ...project[0].statuses,
    ]);
  });

  it('resolves repeated Jira actors once per run and passes transition actor provenance to projection', async () => {
    const account = { accountId: 'acc-shared', displayName: 'Synthetic Person' };
    const make = (id: string, key: string, date: string) =>
      issue(id, key, date, {
        fields: { assignee: account },
        changelog: {
          total: 1,
          histories: [
            {
              id: `history-${id}`,
              created: date,
              author: account,
              items: [{ field: 'status', fromString: 'To Do', toString: 'Done' }],
            },
          ],
        },
      });
    const client = mockClient({
      searchIssues: vi
        .fn()
        .mockResolvedValue(
          search([
            make('10001', 'PROD-1', '2026-08-01T00:00:00.000Z'),
            make('10002', 'PROD-2', '2026-08-02T00:00:00.000Z'),
          ]),
        ),
    });
    const prisma = mockPrisma();
    const registry = mockRegistry();
    const projection = mockProjection();

    await makeService(prisma, client, mockCanonical(['accepted', 'accepted']), projection, registry).syncConnector(
      CONNECTOR_ID,
    );

    expect(registry.resolveJiraActor).toHaveBeenCalledTimes(1);
    expect(projection.projectIssue.mock.calls.map((call) => call[0].transitions[0].actorId)).toEqual([
      'actor-acc-shared',
      'actor-acc-shared',
    ]);
  });

  it('keeps raw payloads bounded while retaining the issue envelope', async () => {
    const synthetic = issue('10001', 'PROD-1', '2026-08-01T00:00:00.000Z', {
      changelog: { total: 120, histories: [] },
    });
    const huge = [
      {
        id: 'history-huge',
        created: '2026-08-01T00:00:00.000Z',
        items: [{ field: 'summary', toString: 'x'.repeat(300_000) }],
      },
    ];
    const client = mockClient({
      searchIssues: vi.fn().mockResolvedValue(search([synthetic])),
      listChangelog: vi.fn().mockResolvedValue(changelog(huge, { total: 120 })),
    });
    const prisma = mockPrisma();

    await makeService(prisma, client).syncConnector(CONNECTOR_ID);

    const raw = prisma.deliveryRawPayload.create.mock.calls[0][0];
    expect(raw.data.truncated).toBe(true);
    expect(Object.keys(unpackRawPayload(raw.data.payload))).toEqual(['issue']);
  });

  it('maps permanent auth errors but preserves transient rate-limit errors and the prior cursor', async () => {
    const authClient = mockClient({ listStatuses: vi.fn().mockRejectedValue(new JiraAuthError('synthetic 401')) });
    const authPrisma = mockPrisma({
      ...baseConnector,
      cursors: { issues: '2026-08-01T00:00:00.000Z' },
    });
    await expect(makeService(authPrisma, authClient).syncConnector(CONNECTOR_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(authPrisma.deliveryConnector.update.mock.calls.at(-1)?.[0].data.cursors).toEqual({
      issues: '2026-08-01T00:00:00.000Z',
    });

    const rateClient = mockClient({
      listStatuses: vi.fn().mockRejectedValue(new JiraRateLimitError('synthetic 429')),
    });
    await expect(makeService(mockPrisma(), rateClient).syncConnector(CONNECTOR_ID)).rejects.toBeInstanceOf(
      JiraRateLimitError,
    );
  });

  it.each([
    ['missing Jira base URL', { ...baseConnector, baseUrl: null }, BadRequestException],
    ['non-HTTPS Jira base URL', { ...baseConnector, baseUrl: 'http://acme.atlassian.net' }, BadRequestException],
    [
      'Jira base URL with credentials',
      { ...baseConnector, baseUrl: 'https://user:secret@acme.atlassian.net' },
      BadRequestException,
    ],
    [
      'Jira base URL with query',
      { ...baseConnector, baseUrl: 'https://acme.atlassian.net?secret=1' },
      BadRequestException,
    ],
    [
      'Jira base URL with fragment',
      { ...baseConnector, baseUrl: 'https://acme.atlassian.net#secret' },
      BadRequestException,
    ],
    [
      'overlong Jira base URL',
      { ...baseConnector, baseUrl: `https://acme.atlassian.net/${'x'.repeat(500)}` },
      BadRequestException,
    ],
    ['non-JSON credentials', { ...baseConnector, credentialsEncrypted: 'not-json' }, BadRequestException],
    [
      'missing credential field',
      { ...baseConnector, credentialsEncrypted: JSON.stringify({ email: 'x@y.com' }) },
      BadRequestException,
    ],
    ['wrong provider', { ...baseConnector, provider: 'github' }, BadRequestException],
  ])('%s is rejected before provider fetch', async (_label, connector, expected) => {
    const client = mockClient();
    await expect(makeService(mockPrisma(connector), client).syncConnector(CONNECTOR_ID)).rejects.toBeInstanceOf(
      expected,
    );
    expect(client.searchIssues).not.toHaveBeenCalled();
  });

  it('normalizes the stored Jira base URL before constructing the provider client', async () => {
    const client = mockClient();
    const factory = vi.fn(() => client);
    const prisma = mockPrisma({ ...baseConnector, baseUrl: 'https://acme.atlassian.net///' });
    const Constructor = JiraImporterService as unknown as new (
      prismaService: PrismaService,
      actorRegistry: ActorRegistryService,
      statusMapService: StatusMapService,
      canonicalDelivery: CanonicalDeliveryService,
      jiraProjection: ReturnType<typeof mockProjection>,
      clientFactory: typeof factory,
    ) => JiraImporterService;

    await new Constructor(
      prisma,
      mockRegistry(),
      mockStatusMap(),
      mockCanonical(),
      mockProjection(),
      factory,
    ).syncConnector(CONNECTOR_ID);

    expect(factory).toHaveBeenCalledWith({
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      apiToken: 'synthetic-token',
    });
  });

  it('rejects an invalid stored Jira base URL before invoking the client factory', async () => {
    const client = mockClient();
    const factory = vi.fn(() => client);
    const prisma = mockPrisma({ ...baseConnector, baseUrl: 'https://user:secret@acme.atlassian.net' });
    const Constructor = JiraImporterService as unknown as new (
      prismaService: PrismaService,
      actorRegistry: ActorRegistryService,
      statusMapService: StatusMapService,
      canonicalDelivery: CanonicalDeliveryService,
      jiraProjection: ReturnType<typeof mockProjection>,
      clientFactory: typeof factory,
    ) => JiraImporterService;

    await expect(
      new Constructor(
        prisma,
        mockRegistry(),
        mockStatusMap(),
        mockCanonical(),
        mockProjection(),
        factory,
      ).syncConnector(CONNECTOR_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(factory).not.toHaveBeenCalled();
    expect(client.listStatuses).not.toHaveBeenCalled();
    expect(client.searchIssues).not.toHaveBeenCalled();
  });

  it('a deleted connector is a permanent not-found', async () => {
    const prisma = mockPrisma();
    prisma.deliveryConnector.findUnique.mockResolvedValue(null);
    await expect(makeService(prisma, mockClient()).syncConnector(CONNECTOR_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('JiraImporterService sourceCreatedAt backfill', () => {
  it('fills refs the incremental window never re-observes from one keyed search', async () => {
    const client = mockClient({
      searchIssues: vi
        .fn()
        .mockResolvedValueOnce(search([]))
        .mockResolvedValueOnce(search([issue('10001', 'PROD-1', '2026-08-01T12:00:00.000Z')])),
    });
    const prisma = mockPrisma();
    prisma.taskExternalRef.findMany.mockResolvedValue([
      { id: 41n, externalKey: 'PROD-1' },
      { id: 42n, externalKey: 'not a key' },
    ]);

    await makeService(prisma, client).syncConnector(CONNECTOR_ID);

    expect(client.searchIssues.mock.calls[1][0]).toBe('key in (PROD-1)');
    expect(prisma.taskExternalRef.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.taskExternalRef.updateMany).toHaveBeenCalledWith({
      where: { id: 41n, sourceCreatedAt: null },
      data: { sourceCreatedAt: new Date('2026-01-01T00:00:00.000Z') },
    });
  });

  it('walks refs by keyset, so a ref Jira never answers for cannot starve the rest', async () => {
    const client = mockClient({
      searchIssues: vi
        .fn()
        .mockResolvedValueOnce(search([]))
        .mockResolvedValue(search([issue('10001', 'PROD-1', '2026-08-01T12:00:00.000Z')])),
    });
    const prisma = mockPrisma();
    prisma.taskExternalRef.findMany
      .mockResolvedValueOnce([
        { id: 41n, externalKey: 'PROD-1' },
        // Deleted upstream: never returned by `key in (...)`, so it must not be re-read.
        { id: 42n, externalKey: 'PROD-2' },
      ])
      .mockResolvedValue([]);

    await makeService(prisma, client).syncConnector(CONNECTOR_ID);

    const backfillCalls = prisma.taskExternalRef.findMany.mock.calls;
    expect(backfillCalls[0][0].where.id).toBeUndefined();
    expect(backfillCalls[0][0].orderBy).toEqual({ id: 'asc' });
    expect(backfillCalls[1][0].where.id).toEqual({ gt: 42n });
  });
});
