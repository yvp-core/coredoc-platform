import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEEDBACK_RECORDS_FILTER,
  FeedbackSort,
  SortOrder,
  type FeedbackRecord,
  type FeedbackRecordsFilter,
  type FeedbackRecordsPage,
  type FeedbackRoadmap,
} from '../../../../shared/ipc-types.js';
import { FeedbackCardBody, type FeedbackCardBodyProps } from './FeedbackCard';
import { AREA_OPTIONS, nextFilter, summaryStrip } from './feedback-presentation';
import { USAGE_FIXTURE } from './usage-fixture';

// Static markup only: the desktop renderer suite runs in the vitest 'node'
// environment (LIM-6), so the card is proven as a pure function of its props —
// the container's two reads and the Select popovers are visual QA.
const ROADMAP: FeedbackRoadmap = USAGE_FIXTURE.feedback;

const MEMBERS = [
  { userId: 'user_alice', label: 'Alice Nowak' },
  { userId: 'user_bob', label: 'Bob Smith' },
];

const RECORD: FeedbackRecord = {
  id: 'fb-1',
  createdAt: '2026-09-08T14:03:22.000Z',
  userId: 'user_alice',
  userEmail: 'alice@example.test',
  sessionId: 'sess-1',
  runId: 'run-1',
  repoKey: 'demo-api',
  overallRating: 4,
  userRating: 2,
  reviewStatus: 'amended',
  summary: 'explain returned the wrong file for a renamed symbol',
  userNotes: 'It cost me twenty minutes.',
  perToolIssues: [
    {
      tool: 'explain',
      issueType: 'misleading_description',
      severity: 4,
      description: 'Pointed at the pre-rename path',
      exampleQuery: null,
    },
  ],
  sessionIssues: [
    {
      area: 'skill-instructions',
      issueType: 'confusing',
      severity: 3,
      description: 'The implement skill re-read the spec twice',
      skill: 'coredoc-implement',
      stageId: 'tdd',
      exampleRedacted: null,
    },
  ],
  missingCapabilities: [{ need: 'Code-owners lookup', useCase: 'Route the review' }],
  misleadingMetadata: [],
};

/** Unattributed, unreviewed, no summary and no nested facts: every degrade at once. */
const BARE_RECORD: FeedbackRecord = {
  ...RECORD,
  id: 'fb-2',
  createdAt: '2026-09-07T09:00:00.000Z',
  userId: null,
  userEmail: null,
  overallRating: null,
  userRating: null,
  reviewStatus: 'unreviewed',
  summary: null,
  userNotes: null,
  perToolIssues: [],
  sessionIssues: [],
  missingCapabilities: [],
  misleadingMetadata: [],
};

const PAGE: FeedbackRecordsPage = {
  items: [RECORD, BARE_RECORD],
  page: 1,
  limit: 25,
  total: 312,
  window: { days: 30, since: '2026-08-10T00:00:00.000Z', until: '2026-09-09T00:00:00.000Z' },
};

const noop = () => undefined;

function render(overrides: Partial<FeedbackCardBodyProps> = {}): string {
  const props: FeedbackCardBodyProps = {
    feedback: ROADMAP,
    filter: DEFAULT_FEEDBACK_RECORDS_FILTER,
    onFilterChange: noop,
    members: MEMBERS,
    isTeam: true,
    page: PAGE,
    error: null,
    onRetry: noop,
    expandedId: null,
    onToggleExpanded: noop,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(FeedbackCardBody, props));
}

describe('Session feedback card', () => {
  const markup = render();

  it('titles the card for the records it now leads with', () => {
    expect(markup).toContain('Session feedback');
    expect(markup).toContain('submit_session_feedback');
    expect(markup).toContain('agent draft reviewed by the user');
    expect(markup).not.toContain('Feedback roadmap');
  });

  it('states volume, the latest rating pair, review coverage and the gap in one strip', () => {
    expect(markup).toContain('27 records · agent 4.2 / user 3.4 · reviewed 5 of 27 (19%) · gap +0.8');
  });

  it('renders one row per record with date, member, rating pair, review chip and counts', () => {
    expect(markup).toContain('2026-09-08 14:03');
    // userId resolves through the members list rather than showing the raw email.
    expect(markup).toContain('Alice Nowak');
    expect(markup).not.toContain('alice@example.test');
    expect(markup).toContain('agent 4 → user 2');
    expect(markup).toContain('amended');
    expect(markup).toContain('explain returned the wrong file for a renamed symbol');
    expect(markup).toContain('1 tool');
    expect(markup).toContain('1 session');
    expect(markup).toContain('1 asks');
    // A zero count carries no information and gets no chip.
    expect(markup).not.toContain('0 tool');
    expect(markup).not.toContain('metadata');
  });

  it('degrades an unattributed, unrated, summary-less record instead of inventing zeros', () => {
    expect(markup).toContain('Unattributed');
    expect(markup).toContain('agent — → user —');
    expect(markup).toContain('No summary');
    expect(markup).toContain('unreviewed');
  });

  it('keeps rows collapsed and keyboard-operable until one is expanded', () => {
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-expanded="true"');
    expect(markup).not.toContain('Pointed at the pre-rename path');
    expect(markup).not.toContain('It cost me twenty minutes.');
  });

  it('expands one row in place with every nested fact and the user notes', () => {
    const expanded = render({ expandedId: 'fb-1' });
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('explain · misleading description · severity 4');
    expect(expanded).toContain('Pointed at the pre-rename path');
    expect(expanded).toContain('Skill instructions · confusing · severity 3 · coredoc-implement · tdd');
    expect(expanded).toContain('Code-owners lookup');
    expect(expanded).toContain('Route the review');
    expect(expanded).toContain('It cost me twenty minutes.');
    // The other row stays collapsed — expansion is per row, not a mode.
    expect(expanded.match(/aria-expanded="true"/g) ?? []).toHaveLength(1);
  });

  it('states the page range and disables exactly the out-of-bounds pager button', () => {
    const disabled = (html: string) => (html.match(/disabled=""/g) ?? []).length;

    expect(markup).toContain('1–25 of 312');
    expect(markup).toContain('Prev');
    expect(markup).toContain('Next');
    // First page: Prev only.
    expect(disabled(markup)).toBe(1);

    const middle = render({ page: { ...PAGE, page: 7 } });
    expect(middle).toContain('151–175 of 312');
    expect(disabled(middle)).toBe(0);

    // Last page: the range stops at the total and Next is the only dead control.
    const last = render({ page: { ...PAGE, page: 13 } });
    expect(last).toContain('301–312 of 312');
    expect(disabled(last)).toBe(1);
  });

  it('offers the member picker to an admin and the self-scope checkbox to a member', () => {
    expect(markup).toContain('aria-label="Member"');
    expect(markup).toContain('Alice Nowak');
    const asMember = render({ isTeam: false, members: [] });
    expect(asMember).not.toContain('aria-label="Member"');
    expect(asMember).toContain('Only mine');
  });

  it('carries the filter row: area, sort and the member scope only', () => {
    for (const label of ['Area', 'Sort']) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    // Review status / Tool / Rating were dropped: they narrowed a list most
    // workspaces can read in full, and the server no longer takes them.
    for (const label of ['Review status', 'Tool', 'Rating']) {
      expect(markup).not.toContain(`aria-label="${label}"`);
    }
  });

  it('names the MCP area for what it actually matches', () => {
    const option = AREA_OPTIONS.find((entry) => entry.value === 'mcp-transport');
    expect(option?.label).toBe('MCP tools & transport');
    expect(option?.title).toBe('tool issues and transport, including records that only report tool issues');
  });

  it('collapses the old aggregate columns under one disclosure without deleting them', () => {
    expect(markup).toContain('<summary');
    expect(markup).toContain('Aggregates');
    expect(markup).toContain('Top issues');
    expect(markup).toContain('Session issues');
    expect(markup).toContain('Most-requested capabilities');
    expect(markup).toContain('Session rating');
    expect(markup).toContain('Average session rating by month');
    expect(markup).toContain('5 of 27 reviewed by a user');
  });

  it('names the active filters on an empty page instead of claiming no feedback exists', () => {
    const filtered = render({
      page: { ...PAGE, items: [], total: 0 },
      filter: { ...DEFAULT_FEEDBACK_RECORDS_FILTER, area: 'task-context', mine: true },
    });
    expect(filtered).toContain('No records match this filter: Task context · only mine.');
    expect(filtered).not.toContain('No feedback submitted in this window yet.');
  });

  it('offers a retry on a failed records read while keeping the filters usable', () => {
    const failed = render({ page: null, error: 'boom' });
    expect(failed).toContain('Feedback records are currently unavailable.');
    expect(failed).toContain('Retry');
    expect(failed).toContain('aria-label="Area"');
    // The raw error never reaches the surface.
    expect(failed).not.toContain('boom');
  });

  it('states the card-level absence once when nothing was submitted at all', () => {
    const empty = render({
      feedback: { ...ROADMAP, feedbackCount: 0 },
      page: { ...PAGE, items: [], total: 0 },
    });
    expect(empty).toContain('No feedback submitted in this window yet.');
    expect(empty).not.toContain('aria-label="Area"');
    expect(empty).not.toContain('Aggregates');
  });

  it('uses only design tokens for the SVG it owns (BR-13, AC-10)', () => {
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('summary strip degrades an absent rating (BR-11)', () => {
  it('dashes each side the aggregate has no mean for', () => {
    const strip = summaryStrip({
      ...ROADMAP,
      ratingTrend: [{ month: 'Aug', avgRating: null, count: 0, avgUserRating: null, userCount: 0 }],
      reviews: { unreviewed: 27, confirmed: 0, amended: 0, avgSelfAssessmentGap: null, gapCount: 0 },
    });
    expect(strip).toBe('27 records · agent — / user — · reviewed 0 of 27 (0%) · gap —');
  });
});

describe('filter changes reset paging', () => {
  const onPageFive: FeedbackRecordsFilter = { ...DEFAULT_FEEDBACK_RECORDS_FILTER, page: 5 };

  it('drops back to page 1 whenever a filter knob moves', () => {
    expect(nextFilter(onPageFive, { area: 'capture' })).toMatchObject({ area: 'capture', page: 1 });
    expect(nextFilter(onPageFive, { sort: FeedbackSort.UserRating, order: SortOrder.Asc })).toMatchObject({ page: 1 });
  });

  it('honours an explicit page from the pagination footer', () => {
    expect(nextFilter(onPageFive, { page: 6 }).page).toBe(6);
  });
});
