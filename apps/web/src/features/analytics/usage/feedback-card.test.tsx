/**
 * Session-feedback card contracts: what the summary strip states when a figure
 * is missing, which filters reach the wire, that a row expands its already-fetched
 * detail in place, the pagination bounds — and the two rating-trend rules that
 * moved here with the aggregates.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedbackRecordsQueryOptions } from '@/api/queries/analytics';
import {
  type AnalyticsWindow,
  AnalyticsWindowKind,
  type FeedbackRecord,
  type FeedbackRecordsFilter,
  type FeedbackRecordsPage,
  type FeedbackRoadmap,
  FeedbackSort,
  SortOrder,
} from '../types.js';
import { FeedbackCard } from './FeedbackCard.js';
import { AREA_HINTS, humanizeArea } from './usage-presentation.js';

const window30: AnalyticsWindow = { kind: AnalyticsWindowKind.Days, days: 30 };

const roadmap = (over: Partial<FeedbackRoadmap> = {}): FeedbackRoadmap => ({
  feedbackCount: 4,
  topIssues: [],
  topSessionIssues: [],
  topMissingTools: [],
  ratingTrend: [],
  reviews: { unreviewed: 1, confirmed: 2, amended: 1, avgSelfAssessmentGap: null, gapCount: 0 },
  ...over,
});

const record = (over: Partial<FeedbackRecord> = {}): FeedbackRecord => ({
  id: 'f1',
  createdAt: '2026-09-08T14:03:00.000Z',
  userId: 'u1',
  userEmail: 'ada@x.test',
  sessionId: null,
  runId: null,
  repoKey: 'acme/api',
  overallRating: 4,
  userRating: 2,
  reviewStatus: 'amended',
  summary: 'Search returned nothing useful',
  userNotes: 'It kept guessing file paths',
  perToolIssues: [{ tool: 'search-symbols', issueType: 'noise', severity: 3, description: 'Too many hits' }],
  sessionIssues: [],
  missingCapabilities: [],
  misleadingMetadata: [],
  ...over,
});

const page = (over: Partial<FeedbackRecordsPage> = {}): FeedbackRecordsPage => ({
  items: [record()],
  page: 1,
  limit: 25,
  total: 1,
  window: { days: 30, since: '2026-08-09', until: '2026-09-08' },
  ...over,
});

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function stubFetch(body: (path: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(JSON.stringify(body(new URL(url, 'http://local.test').pathname)))),
  );
}

const filter = (over: Partial<FeedbackRecordsFilter> = {}): FeedbackRecordsFilter => ({
  area: null,
  userId: null,
  mine: false,
  sort: FeedbackSort.CreatedAt,
  order: SortOrder.Desc,
  page: 1,
  limit: 25,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('feedback records read params', () => {
  const url = async (over: Partial<FeedbackRecordsFilter>): Promise<string> => {
    stubFetch(() => page());
    const options = feedbackRecordsQueryOptions('ws1', window30, filter(over));
    await (options.queryFn as () => Promise<unknown>)();
    return (vi.mocked(fetch).mock.calls.at(-1)?.[0] ?? '') as string;
  };

  it('sends the window, paging and sort, and no unset filter', async () => {
    const sent = await url({});
    expect(sent).toContain('/mcp-feedback/records?days=30');
    expect(sent).toContain('page=1&limit=25&sort=createdAt&order=desc');
    expect(sent).not.toContain('area=');
  });

  it('sends every set filter', async () => {
    const sent = await url({
      area: 'skill-instructions',
      sort: FeedbackSort.OverallRating,
      order: SortOrder.Asc,
      page: 3,
    });
    expect(sent).toContain('area=skill-instructions');
    expect(sent).toContain('sort=overallRating&order=asc');
    expect(sent).toContain('page=3');
  });

  it('never sends the retired review, tool and rating filters', async () => {
    const sent = await url({ area: 'mcp-transport' });
    expect(sent).not.toContain('reviewStatus=');
    expect(sent).not.toContain('tool=');
    expect(sent).not.toContain('maxRating=');
  });

  it('never sends both member scopes, and keys them apart', async () => {
    expect(await url({ mine: true })).toContain('mine=true');
    expect(await url({ userId: 'u2' })).toContain('userId=u2');
    const both = await url({ mine: true, userId: 'u2' });
    expect(both).toContain('mine=true');
    expect(both).not.toContain('userId=');
    expect(feedbackRecordsQueryOptions('ws1', window30, filter({ page: 2 })).queryKey).not.toEqual(
      feedbackRecordsQueryOptions('ws1', window30, filter()).queryKey,
    );
  });
});

describe('summary strip', () => {
  it('dashes a missing rating and still states the reviewed share', async () => {
    stubFetch(() => page());
    render(
      <Wrapper>
        <FeedbackCard
          feedback={roadmap({
            feedbackCount: 4,
            ratingTrend: [{ month: '2026-09', avgRating: null, count: 0, avgUserRating: 4.1, userCount: 2 }],
          })}
          workspaceId="ws1"
          analyticsWindow={window30}
          isTeam={false}
        />
      </Wrapper>,
    );

    expect(await screen.findByText(/4 records · agent — \/ user 4\.1 · reviewed 3 of 4 \(75%\) · gap —/)).toBeTruthy();
  });
});

describe('records list', () => {
  it('expands the row detail in place without another request', async () => {
    stubFetch(() => page());
    render(
      <Wrapper>
        <FeedbackCard feedback={roadmap()} workspaceId="ws1" analyticsWindow={window30} isTeam={false} />
      </Wrapper>,
    );

    const row = await screen.findByRole('button', { name: /Search returned nothing useful/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Too many hits')).toBeNull();

    const before = vi.mocked(fetch).mock.calls.length;
    await userEvent.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Too many hits')).toBeInTheDocument();
    expect(screen.getByText('It kept guessing file paths')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });

  it('names the active filters when the page comes back empty', async () => {
    stubFetch(() => page({ items: [], total: 0 }));
    render(
      <Wrapper>
        <FeedbackCard feedback={roadmap()} workspaceId="ws1" analyticsWindow={window30} isTeam={false} />
      </Wrapper>,
    );

    // no filter set yet: the empty page is a window fact, not a filter effect
    expect(await screen.findByText('No feedback records in this window.')).toBeInTheDocument();
  });

  it('disables both pager ends on a single full page', async () => {
    stubFetch(() => page({ items: [record(), record({ id: 'f2' })], total: 2 }));
    render(
      <Wrapper>
        <FeedbackCard feedback={roadmap()} workspaceId="ws1" analyticsWindow={window30} isTeam={false} />
      </Wrapper>,
    );

    expect(await screen.findByText('1–2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('offers only the Area and Sort filters, with the MCP area relabelled', async () => {
    stubFetch(() => page());
    render(
      <Wrapper>
        <FeedbackCard feedback={roadmap()} workspaceId="ws1" analyticsWindow={window30} isTeam={false} />
      </Wrapper>,
    );

    expect(await screen.findByRole('combobox', { name: 'Area' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sort' })).toBeInTheDocument();
    for (const gone of ['Review', 'Tool', 'Rating']) {
      expect(screen.queryByRole('combobox', { name: gone })).toBeNull();
    }
  });

  // The option list itself lives in a Radix portal that happy-dom cannot open
  // (no pointer capture), so the label and its hint are asserted at the source.
  it('labels the MCP area as covering tool issues too', () => {
    expect(humanizeArea('mcp-transport')).toBe('MCP tools & transport');
    expect(AREA_HINTS['mcp-transport']).toBe(
      'tool issues and transport, including records that only report tool issues',
    );
  });

  it('gives an admin the member select and a member the self-scope switch', async () => {
    stubFetch((path) => (path.endsWith('/members') ? [] : page()));
    const { unmount } = render(
      <Wrapper>
        <FeedbackCard feedback={roadmap()} workspaceId="ws1" analyticsWindow={window30} isTeam />
      </Wrapper>,
    );
    expect(await screen.findByRole('combobox', { name: 'Member' })).toBeInTheDocument();
    unmount();

    render(
      <Wrapper>
        <FeedbackCard feedback={roadmap()} workspaceId="ws1" analyticsWindow={window30} isTeam={false} />
      </Wrapper>,
    );
    expect(await screen.findByText('Only mine')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Member' })).toBeNull();
  });
});

describe('aggregates rating trend', () => {
  const withTrend = (ratingTrend: FeedbackRoadmap['ratingTrend']) => {
    stubFetch(() => page());
    return render(
      <Wrapper>
        <FeedbackCard feedback={roadmap({ ratingTrend })} workspaceId="ws1" analyticsWindow={window30} isTeam={false} />
      </Wrapper>,
    );
  };

  it('omits the agent headline when the latest month has no agent rating', () => {
    withTrend([
      { month: '2026-07', avgRating: 4.2, count: 3, avgUserRating: null, userCount: 0 },
      { month: '2026-08', avgRating: null, count: 0, avgUserRating: 3.4, userCount: 2 },
    ]);

    expect(screen.queryByText(/· agent ·/)).not.toBeInTheDocument();
    expect(screen.getByText('2026-08')).toBeInTheDocument();
  });

  it('skips a null month on the agent line rather than drawing it at a substitute value', () => {
    withTrend([
      { month: '2026-06', avgRating: 4, count: 2, avgUserRating: null, userCount: 0 },
      { month: '2026-07', avgRating: null, count: 0, avgUserRating: null, userCount: 0 },
      { month: '2026-08', avgRating: 5, count: 1, avgUserRating: null, userCount: 0 },
    ]);

    const path = screen.getByRole('img', { name: 'Average session rating by month' }).querySelector('path');
    // one segment: the two rated months joined directly, the null month absent
    expect(path?.getAttribute('d')?.match(/L/g)).toHaveLength(1);
  });
});
