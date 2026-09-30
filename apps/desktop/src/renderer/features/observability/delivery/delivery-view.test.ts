import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsWindowKind, CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED } from '../../../../shared/ipc-types.js';
import type {
  AnalyticsWindow,
  CanonicalArtifactItem,
  CanonicalArtifactRevisionsResponse,
  CanonicalCodeChangeItem,
  CanonicalDeliverySummary,
  CanonicalExternalRefItem,
  CanonicalTaskDetail,
  CanonicalTaskSummary,
} from '../../../../shared/ipc-types.js';

// Static markup only: the desktop suite runs in the vitest 'node' environment, so
// selection, hover and filter typing are visual QA (LIM-6). window.electronAPI is
// fully mocked and every rendered query is pre-seeded, so no IPC is reached.
const WORKSPACE = 'ws-1';
const DAYS = 30;
const WINDOW = { kind: AnalyticsWindowKind.Days, days: DAYS } as const;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();

const EMPTY_SUMMARY: CanonicalDeliverySummary = {
  window: { days: DAYS, since: at(-720), until: at(0), lifecycle: 'all', userId: null },
  tasks: { matching: 0, shipped: 0, partiallyShipped: 0, withRework: 0, active: 0 },
  leadTimeMs: { value: null, sampleSize: 0 },
  reviewStageMs: { value: null, sampleSize: 0 },
  costPerShippedTaskUsd: { value: null, sampleSize: 0, unpricedTasks: 0 },
  stages: [],
  unclaimedMs: { value: null, sampleSize: 0 },
  reviewWaitMs: { value: null, sampleSize: 0 },
  editVerifyRoundsPerRun: { value: null, sampleSize: 0 },
  rework: {
    bySource: [
      { kind: 'tracker_reopened', signals: 0, tasks: 0 },
      { kind: 'review_changes_requested', signals: 0, tasks: 0 },
      { kind: 'review_commented', signals: 0, tasks: 0 },
    ],
  },
};

const TASK: CanonicalTaskSummary = {
  id: 'task-1',
  title: 'Ship the thing',
  repositoryKey: 'repo',
  lifecycle: 'completed',
  authority: {
    kind: 'external_ref',
    externalRefId: 'ref-1',
    provider: 'jira',
    externalId: 'PROJ-7',
    externalKey: 'PROJ-7',
    connected: true,
    sourceCreatedAt: null,
  },
  createdBy: 'user',
  createdAt: at(0),
  updatedAt: at(120),
  everShipped: true,
  lastShippedAt: at(100),
  shipState: 'shipped',
  counts: {
    externalRefs: 1,
    workflowRuns: 1,
    codeChanges: 0,
    mergedCodeChanges: 0,
    openCodeChanges: 0,
    shipEvidence: 1,
    reworkSignals: 1,
    artifacts: 0,
  },
};

const DETAIL: CanonicalTaskDetail = {
  ...TASK,
  fineEventRetention: { policyDays: 90, purgedThroughReceivedAt: null },
  estimatedCost: { totalUsd: 3.25, sessions: 2, unpricedSessions: 0, sessionsWithoutUsage: 0 },
};

const REVISIONS: CanonicalArtifactRevisionsResponse = {
  artifact: { id: 'artifact-1', taskId: 'task-1', repositoryKey: 'repo', kind: 'spec' },
  revisions: [
    {
      id: 'rev-1',
      sha256: 'a'.repeat(64),
      byteCount: 1024,
      checkpoint: 'run-finish',
      runId: 'cdr-1',
      createdAt: at(10),
      // Hostile checkpoint body: raw script, remote image and a link, all of which
      // the safe renderer must strip or neutralise.
      markdown:
        '# Checkpoint body\n\n<script>globalThis.__artifactPwned = true</script>\n\n[Safe link](https://example.test/path)\n\n![remote diagram](https://images.example.test/diagram.png)',
    },
  ],
};

// One real member plus the invite placeholder the filter must skip.
const MEMBERS = [
  {
    userId: 'user_42',
    email: 'ada@example.test',
    displayName: 'Ada Lovelace',
    role: 'member',
    pending: false,
    joinedAt: at(0),
  },
  {
    userId: 'pending:new@example.test',
    email: 'new@example.test',
    displayName: null,
    role: 'member',
    pending: true,
    joinedAt: at(0),
  },
];

describe('DeliveryView', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {
      electronAPI: {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  async function renderView(role?: string, window: AnalyticsWindow = WINDOW) {
    // Deferred import so the window mock exists before the query-option factories
    // (whose queryFn closures read window.electronAPI) are evaluated.
    const { DeliveryView } = await import('./DeliveryView');
    const { canonicalTaskSummariesQueryOptions, deliverySummaryQueryOptions, workspaceMembersQueryOptions } =
      await import('../observability-api');

    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
    client.setQueryData(deliverySummaryQueryOptions(WORKSPACE, window, 'all', false).queryKey, EMPTY_SUMMARY);
    client.setQueryData(canonicalTaskSummariesQueryOptions(WORKSPACE, window, 'all', false).queryKey, {
      pages: [{ tasks: [], nextCursor: null }],
      pageParams: [null],
    });
    client.setQueryData(workspaceMembersQueryOptions(WORKSPACE).queryKey, MEMBERS);

    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DeliveryView, { workspaceId: WORKSPACE, window, role }),
      ),
    );
  }

  it('offers the member filter to an admin or owner instead of the self-scope toggle', async () => {
    for (const role of ['admin', 'owner']) {
      const html = await renderView(role);

      expect(html).toContain('aria-label="Member"');
      expect(html).not.toContain('Only my tasks');
    }
  }, 30_000);

  it('keeps a member on the self-scope toggle and never offers the member filter', async () => {
    for (const role of ['member', undefined]) {
      const html = await renderView(role);

      expect(html).toContain('Only my tasks');
      expect(html).not.toContain('aria-label="Member"');
    }
  }, 30_000);

  it('names the population and dashes every null median with its sample caption (AC-9)', async () => {
    const html = await renderView();

    expect(html).toContain('Tasks updated in the last 30 days · All tasks · UTC');
    expect(html).toContain('Median lead time');
    expect(html).toContain('—');
    expect(html).toContain('0 of 0');
    // A missing sample must never read as a zero magnitude.
    expect(html).not.toContain('$0.00');
  }, 30_000);

  it('names the active filter in the empty task population (AC-9)', async () => {
    const html = await renderView();

    expect(html).toContain('No tasks matched &quot;All tasks&quot; in the last 30 days.');
    expect(html).toContain('Pick a task on the left to see its full trace.');
  }, 30_000);

  it('names a custom range the same way in the caption and the empty task population', async () => {
    const html = await renderView(undefined, {
      kind: AnalyticsWindowKind.Custom,
      since: '2026-08-01',
      until: '2026-08-14',
    });

    expect(html).toContain('Tasks updated in 2026-08-01 – 2026-08-14 · All tasks · UTC');
    // Not "in the last 14 days": a custom range is named by its dates on both surfaces.
    expect(html).toContain('No tasks matched &quot;All tasks&quot; in 2026-08-01 – 2026-08-14.');
  }, 30_000);

  it('keeps the lifecycle filter and the population caption when the summary read fails', async () => {
    const { DeliveryView } = await import('./DeliveryView');
    const { deliverySummaryQueryOptions } = await import('../observability-api');

    // `retryOnMount: false` keeps the failed query settled: without it the observer
    // optimistically reports "pending" for the mount refetch that static render never runs.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, retry: false, retryOnMount: false } },
    });
    // prefetchQuery records the rejection in the cache, so the first render is the error state.
    await client.prefetchQuery({
      ...deliverySummaryQueryOptions(WORKSPACE, WINDOW, 'all', false),
      queryFn: () => Promise.reject(new Error('upstream unavailable')),
    });

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DeliveryView, { workspaceId: WORKSPACE, window: WINDOW }),
      ),
    );

    expect(html).toContain('Delivery analytics are currently unavailable.');
    // The user can still switch the population instead of facing a dead view.
    expect(html).toContain('aria-label="Lifecycle"');
    expect(html).toContain('With rework');
    expect(html).toContain('Tasks updated in the last 30 days · All tasks · UTC');
  }, 30_000);

  it('shows the authorization note only when the server answers with the sentinel (AC-5, BR-15)', async () => {
    const { DeliveryView } = await import('./DeliveryView');
    const { deliverySummaryQueryOptions } = await import('../observability-api');

    // retryOnMount off: an errored query with no data would otherwise refetch on
    // mount and render as pending instead of the error branch under test.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    const options = deliverySummaryQueryOptions(WORKSPACE, WINDOW, 'all', false);
    await client.prefetchQuery({
      ...options,
      queryFn: async () => {
        throw new Error(CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED);
      },
    });
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DeliveryView, { workspaceId: WORKSPACE, window: WINDOW }),
      ),
    );

    expect(html).toContain('Delivery analytics are not available to this account.');
    expect(html).not.toContain('Tasks updated in the last');
  }, 30_000);
});

describe('TaskTrace', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {
      electronAPI: {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('renders the trace header and captions a truncated collection page (BR-12, AC-8)', async () => {
    const { TaskTrace } = await import('./TaskTrace');
    const { canonicalTaskDetailQueryOptions } = await import('../observability-api');
    const queries = await import('./trace-queries');

    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
    client.setQueryData(canonicalTaskDetailQueryOptions(WORKSPACE, TASK.id).queryKey, DETAIL);
    client.setQueryData(queries.traceExternalRefsQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: [],
      nextCursor: null,
    });
    // The runs page is truncated: BR-12 captions it instead of implying completeness.
    client.setQueryData(queries.traceRunsQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: [],
      nextCursor: 'cursor-2',
    });
    client.setQueryData(queries.traceCodeChangesQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: [],
      nextCursor: null,
    });
    client.setQueryData(queries.traceShipEvidenceQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: [
        {
          id: 'ship-1',
          source: 'github_pr_merged',
          sourceKey: 'org/repo#42',
          occurredAt: at(100),
          receivedAt: at(100),
          actorId: null,
          provider: 'github',
          repoExternalId: 'org/repo',
          externalId: 'pr-42',
        },
      ],
      nextCursor: null,
    });
    client.setQueryData(queries.traceReworkSignalsQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: [],
      nextCursor: null,
    });
    client.setQueryData(queries.traceArtifactsQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: [],
      nextCursor: null,
    });

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskTrace, { workspaceId: WORKSPACE, taskId: TASK.id }),
      ),
    );

    expect(html).toContain('Ship the thing');
    expect(html).toContain('PROJ-7 · jira');
    expect(html).toContain('$3.25 across 2 sessions · joined via workflow runs');
    // The trace cannot know how many facts the next page holds, so it says what it knows.
    expect(html).toContain('First page shown · older facts not loaded (runs)');
    expect(html).toContain('Time by stage · this task');
    expect(html).toContain('Journey · merged fact stream');
  }, 30_000);

  const ARTIFACT: CanonicalArtifactItem = {
    id: 'artifact-1',
    kind: 'spec',
    repositoryKey: 'repo',
    createdBy: 'user',
    createdAt: at(10),
    updatedAt: at(20),
    revisionCount: 2,
  };

  it('shows an artifact as a collapsed toggle chip with its revision count and no checkpoint content', async () => {
    const { TaskTrace } = await import('./TaskTrace');
    const { canonicalTaskDetailQueryOptions } = await import('../observability-api');
    const queries = await import('./trace-queries');

    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
    client.setQueryData(canonicalTaskDetailQueryOptions(WORKSPACE, TASK.id).queryKey, DETAIL);
    for (const options of [
      queries.traceExternalRefsQueryOptions(WORKSPACE, TASK.id),
      queries.traceRunsQueryOptions(WORKSPACE, TASK.id),
      queries.traceCodeChangesQueryOptions(WORKSPACE, TASK.id),
      queries.traceShipEvidenceQueryOptions(WORKSPACE, TASK.id),
      queries.traceReworkSignalsQueryOptions(WORKSPACE, TASK.id),
    ]) {
      client.setQueryData(options.queryKey, { items: [], nextCursor: null });
    }
    client.setQueryData(queries.traceArtifactsQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: [ARTIFACT],
      nextCursor: null,
    });
    // Seeded but unrendered: the revisions read is disabled until the chip is expanded.
    client.setQueryData(queries.traceArtifactRevisionsQueryOptions(WORKSPACE, ARTIFACT.id).queryKey, REVISIONS);

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskTrace, { workspaceId: WORKSPACE, taskId: TASK.id }),
      ),
    );

    expect(html).toContain('spec · 2 revisions');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Checkpoint content · spec');
    expect(html).not.toContain('Checkpoint body');
  }, 30_000);

  it('renders expanded revisions through the sanitising Markdown renderer (no script, image or link)', async () => {
    const { ArtifactRevisionList } = await import('./ArtifactRevisions');

    const html = renderToStaticMarkup(createElement(ArtifactRevisionList, { detail: REVISIONS }));

    expect(html).toContain('Checkpoint body');
    expect(html).toContain('run cdr-1');
    expect(html).toContain('1,024 bytes');
    expect(html).toContain('2026-08-01 10:00 UTC');
    // Untrusted checkpoint Markdown: no raw HTML, no remote image, no link element.
    expect(html).not.toContain('__artifactPwned');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(html).toContain('remote diagram');
    expect(html).toContain('Safe link');
  }, 30_000);
  const EXTERNAL_REF: CanonicalExternalRefItem = {
    id: 'ref-1',
    provider: 'jira',
    externalId: 'PROJ-7',
    externalKey: 'PROJ-7',
    externalUrl: 'https://jira.example.test/browse/PROJ-7',
    externalState: 'Done',
    connectorId: 'conn-1',
    sourceUpdatedAt: at(90),
    lastObservedAt: at(90),
    isAuthority: true,
    stateFactCount: 0,
  };

  const CODE_CHANGE: CanonicalCodeChangeItem = {
    id: 'pr-1',
    provider: 'github',
    repoExternalId: 'org/repo',
    externalId: 'pr-42',
    number: 42,
    title: 'Ship the thing',
    state: 'merged',
    isDraft: false,
    sourceBranch: 'feat/thing',
    targetBranch: 'main',
    createdAtSource: at(10),
    readyForReviewAt: null,
    firstReviewAt: null,
    approvedAt: null,
    mergedAt: at(100),
    updatedAt: at(100),
    externalUrl: 'https://github.example.test/org/repo/pull/42',
    reviewCount: 1,
    commentCount: 0,
    associationSource: 'external_ref',
    associationSourceValue: 'PROJ-7',
  };

  /** Seeds detail plus all six collection pages; every collection defaults to an empty page. */
  async function renderTrace(pages: {
    externalRefs?: CanonicalExternalRefItem[];
    codeChanges?: CanonicalCodeChangeItem[];
    detail?: typeof DETAIL;
  }) {
    const { TaskTrace } = await import('./TaskTrace');
    const { canonicalTaskDetailQueryOptions } = await import('../observability-api');
    const queries = await import('./trace-queries');

    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
    client.setQueryData(canonicalTaskDetailQueryOptions(WORKSPACE, TASK.id).queryKey, pages.detail ?? DETAIL);
    client.setQueryData(queries.traceExternalRefsQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: pages.externalRefs ?? [],
      nextCursor: null,
    });
    client.setQueryData(queries.traceCodeChangesQueryOptions(WORKSPACE, TASK.id).queryKey, {
      items: pages.codeChanges ?? [],
      nextCursor: null,
    });
    for (const options of [
      queries.traceRunsQueryOptions(WORKSPACE, TASK.id),
      queries.traceShipEvidenceQueryOptions(WORKSPACE, TASK.id),
      queries.traceReworkSignalsQueryOptions(WORKSPACE, TASK.id),
      queries.traceArtifactsQueryOptions(WORKSPACE, TASK.id),
    ]) {
      client.setQueryData(options.queryKey, { items: [], nextCursor: null });
    }

    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskTrace, { workspaceId: WORKSPACE, taskId: TASK.id }),
      ),
    );
  }

  it('makes the authority and PR chips clickable when the contract carries a URL', async () => {
    const html = await renderTrace({
      externalRefs: [{ ...EXTERNAL_REF, externalId: '10044' }],
      codeChanges: [CODE_CHANGE],
      detail: {
        ...DETAIL,
        authority: {
          kind: 'external_ref',
          externalRefId: 'ref-1',
          provider: 'jira',
          externalId: '10044',
          externalKey: 'PROJ-7',
          connected: true,
          sourceCreatedAt: null,
        },
      },
    });

    expect(html).toMatch(/<button[^>]*title="Lifecycle authority[^"]*"[^>]*class="[^"]*underline/);
    expect(html).toMatch(/<button[^>]*title="Open in GitHub"/);
    // The human key carried by the authority (SCRUM-13 style), never the tracker's numeric id.
    expect(html).toContain('PROJ-7 · jira');
    expect(html).not.toContain('10044');
    expect(html).toContain('PR #42 · merged');
  }, 30_000);

  it('keeps the same chips inert when no external URL is recorded', async () => {
    const html = await renderTrace({
      externalRefs: [{ ...EXTERNAL_REF, externalUrl: null }],
      codeChanges: [{ ...CODE_CHANGE, externalUrl: null }],
    });

    expect(html).not.toContain('Open in');
    expect(html).toContain('PROJ-7 · jira');
    expect(html).toContain('PR #42 · merged');
  }, 30_000);

  it('names the one failed trace collection and still renders the rest (AC-8)', async () => {
    const { TaskTrace } = await import('./TaskTrace');
    const { canonicalTaskDetailQueryOptions } = await import('../observability-api');
    const queries = await import('./trace-queries');

    // `retryOnMount: false` keeps the rejected query settled through a static render.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, retry: false, retryOnMount: false } },
    });
    client.setQueryData(canonicalTaskDetailQueryOptions(WORKSPACE, TASK.id).queryKey, DETAIL);
    await client.prefetchQuery({
      ...queries.traceRunsQueryOptions(WORKSPACE, TASK.id),
      queryFn: () => Promise.reject(new Error('boom')),
    });
    for (const options of [
      queries.traceExternalRefsQueryOptions(WORKSPACE, TASK.id),
      queries.traceCodeChangesQueryOptions(WORKSPACE, TASK.id),
      queries.traceShipEvidenceQueryOptions(WORKSPACE, TASK.id),
      queries.traceReworkSignalsQueryOptions(WORKSPACE, TASK.id),
      queries.traceArtifactsQueryOptions(WORKSPACE, TASK.id),
    ]) {
      client.setQueryData(options.queryKey, { items: [], nextCursor: null });
    }

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskTrace, { workspaceId: WORKSPACE, taskId: TASK.id }),
      ),
    );

    expect(html).toContain('runs: unavailable');
    expect(html).toContain('Time by stage · this task');
  }, 30_000);
});
