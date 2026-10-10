/**
 * Delivery view contract checks: the member scope that reaches the wire, which
 * scope control each role gets, the partial-ship chip, and the rework pareto's
 * source labels.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalTaskSummariesQueryOptions, deliverySummaryQueryOptions } from '@/api/queries/analytics';
import {
  type AnalyticsWindow,
  AnalyticsWindowKind,
  type CanonicalDeliverySummary,
  type CanonicalTaskSummary,
} from '../types.js';
import { reworkSignalLabel, windowLabel } from './delivery-presentation.js';
import { DeliveryView } from './DeliveryView.js';
import { ReworkCard } from './ReworkCard.js';
import { TaskList } from './TaskList.js';

const window30: AnalyticsWindow = { kind: AnalyticsWindowKind.Days, days: 30 };

const members = [
  {
    workspaceId: 'ws1',
    userId: 'u1',
    email: 'ada@x.test',
    displayName: 'Ada',
    role: 'admin',
    pending: false,
    joinedAt: '',
  },
  {
    workspaceId: 'ws1',
    userId: 'pending:inv1',
    email: 'invited@x.test',
    displayName: null,
    role: 'member',
    pending: true,
    joinedAt: '',
  },
];

const summary: CanonicalDeliverySummary = {
  window: { days: 30, since: '2026-08-09', until: '2026-09-08', lifecycle: 'all', userId: null },
  tasks: { matching: 3, shipped: 1, partiallyShipped: 2, withRework: 1, active: 1 },
  leadTimeMs: { value: null, sampleSize: 0 },
  reviewStageMs: { value: null, sampleSize: 0 },
  costPerShippedTaskUsd: { value: null, sampleSize: 0, unpricedTasks: 0 },
  stages: [],
  unclaimedMs: { value: null, sampleSize: 0 },
  reviewWaitMs: { value: null, sampleSize: 0 },
  editVerifyRoundsPerRun: { value: null, sampleSize: 0 },
  rework: {
    bySource: [
      { kind: 'tracker_reopened', signals: 2, tasks: 1 },
      { kind: 'review_changes_requested', signals: 0, tasks: 0 },
      { kind: 'review_commented', signals: 3, tasks: 2 },
    ],
  },
};

const partialTask: CanonicalTaskSummary = {
  id: 'task-1',
  title: 'Partial task',
  repositoryKey: 'acme/api',
  lifecycle: 'active',
  authority: { kind: 'coredoc' },
  createdBy: 'u1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  everShipped: true,
  lastShippedAt: '2026-09-02T00:00:00.000Z',
  shipState: 'partial',
  counts: {
    externalRefs: 0,
    workflowRuns: 1,
    codeChanges: 3,
    shipEvidence: 1,
    reworkSignals: 0,
    artifacts: 0,
    mergedCodeChanges: 2,
    openCodeChanges: 1,
  },
};

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Captures the URL of every request the stubbed fetch sees. */
function stubFetch(body: (path: string) => unknown): string[] {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(body(new URL(url, 'http://local.test').pathname)));
    }),
  );
  return seen;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('delivery read params', () => {
  beforeEach(() => {
    stubFetch(() => summary);
  });

  const summaryUrl = async (mine: boolean, userId: string | null): Promise<string> => {
    const options = deliverySummaryQueryOptions('ws1', window30, 'all', mine, userId);
    await (options.queryFn as () => Promise<unknown>)();
    return (vi.mocked(fetch).mock.calls.at(-1)?.[0] ?? '') as string;
  };

  it('sends neither mine nor userId for a workspace-wide read', async () => {
    const url = await summaryUrl(false, null);
    expect(url).toContain('days=30&lifecycle=all');
    expect(url).not.toContain('mine=');
    expect(url).not.toContain('userId=');
  });

  it('sends mine=true for a self-scoped read', async () => {
    const url = await summaryUrl(true, null);
    expect(url).toContain('mine=true');
    expect(url).not.toContain('userId=');
  });

  it('sends userId for a member-scoped read, never both', async () => {
    const url = await summaryUrl(false, 'u1');
    expect(url).toContain('userId=u1');
    expect(url).not.toContain('mine=');
    // mine wins the mutual exclusion locally so the server never sees both
    expect(await summaryUrl(true, 'u1')).not.toContain('userId=');
  });

  it('carries the member scope on the task list too, and in its key', async () => {
    const options = canonicalTaskSummariesQueryOptions('ws1', window30, 'all', false, 'u1');
    expect(options.queryKey).toContain('u1');
    await (options.queryFn as (ctx: { pageParam: string | null }) => Promise<unknown>)({ pageParam: null });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toContain('userId=u1');
    expect(deliverySummaryQueryOptions('ws1', window30, 'all', true, null).queryKey).not.toEqual(
      deliverySummaryQueryOptions('ws1', window30, 'all', false, null).queryKey,
    );
  });
});

describe('member scope control', () => {
  it('gives an admin the member select, seeded with the real members only', async () => {
    stubFetch((path) => (path.endsWith('/members') ? members : summary));
    render(
      <Wrapper>
        {/* biome-ignore lint/a11y/useValidAriaRole: `role` is this component's workspace-role prop, not an ARIA role */}
        <DeliveryView workspaceId="ws1" role="admin" analyticsWindow={window30} onWindowChange={() => undefined} />
      </Wrapper>,
    );

    expect(await screen.findByRole('combobox', { name: 'Member' })).toBeInTheDocument();
    expect(screen.queryByText('Only my tasks')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Member' })).toHaveDisplayValue('All members');
  });

  it('keeps the self-scope switch for a member', async () => {
    stubFetch(() => summary);
    render(
      <Wrapper>
        {/* biome-ignore lint/a11y/useValidAriaRole: `role` is this component's workspace-role prop, not an ARIA role */}
        <DeliveryView workspaceId="ws1" role="member" analyticsWindow={window30} onWindowChange={() => undefined} />
      </Wrapper>,
    );

    expect(await screen.findByText('Only my tasks')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Member' })).toBeNull();
  });
});

describe('ship state and rework sources', () => {
  it('names the merged/open split on a partially shipped task', async () => {
    stubFetch(() => ({ tasks: [partialTask], nextCursor: null }));
    render(
      <Wrapper>
        <TaskList
          workspaceId="ws1"
          analyticsWindow={window30}
          lifecycle="all"
          mine={false}
          userId={null}
          scope={null}
          query=""
          onQueryChange={() => undefined}
          selectedTaskId={null}
          onSelect={() => undefined}
          onSelectionDropped={() => undefined}
        />
      </Wrapper>,
    );

    expect(await screen.findByText('Partially shipped · 2 of 3 PRs')).toBeInTheDocument();
  });

  it('renders every rework source, zeros included', () => {
    render(
      <Wrapper>
        <ReworkCard summary={summary} />
      </Wrapper>,
    );

    expect(screen.getByText('Tracker reopened')).toBeInTheDocument();
    expect(screen.getByText('Review: changes requested')).toBeInTheDocument();
    expect(screen.getByText('Review: comments then commits')).toBeInTheDocument();
    // the zero-signal source keeps its row rather than disappearing
    expect(screen.getByLabelText('Rework signals by source').textContent).toContain('0');
  });
});

describe('delivery presentation labels', () => {
  it('names a custom window by its explicit range', () => {
    expect(windowLabel({ kind: AnalyticsWindowKind.Custom, since: '2026-01-01', until: '2026-01-31' })).toBe(
      'between 2026-01-01 and 2026-01-31',
    );
    expect(windowLabel(window30)).toBe('in the last 30 days');
  });

  it('marks a legacy stage re-entry signal as the iteration fact it is', () => {
    expect(reworkSignalLabel('stage_reentry')).toBe('Stage re-entry (legacy)');
    expect(reworkSignalLabel('review_commented')).toBe('Review: comments then commits');
  });
});
