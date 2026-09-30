import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceUsageAnalytics } from '../../../../shared/ipc-types.js';
import { KpiCard } from '../KpiCard';
import { UsageBody } from './UsageView';
import { USAGE_FIXTURE, USAGE_FIXTURE_NOW } from './usage-fixture';

// The desktop renderer suite runs in the vitest 'node' environment (no jsdom), so the
// cards are proven through static markup and their pure helpers; hover readouts, the
// chart/table toggle, show-all and column sorting are visual QA (LIM-6, AC-11).
function render(isTeam = true): string {
  return renderToStaticMarkup(createElement(UsageBody, { usage: USAGE_FIXTURE, isTeam, now: USAGE_FIXTURE_NOW }));
}

describe('Usage view', () => {
  const markup = render();

  it('names the one UTC-day-aligned window every card shares (BR-16)', () => {
    expect(markup).toContain('Aug 3 – Sep 1 · UTC');
  });

  it('renders the delta against a non-zero previous window and "no prior data" against a zero one (BR-2)', () => {
    expect(markup).toContain('▲ 27% vs prev 30d');
    expect(markup).toContain('no prior data');
    // The value row wraps so a narrow tile pushes the delta onto its own line
    // instead of clipping it at the card edge.
    expect(markup).toContain('flex flex-wrap items-baseline');
  });

  it('renders the unpriced marker for a window the price map could not cover, never $0.00 (BR-1, LIM-1)', () => {
    expect(markup).toContain('Unpriced');
    expect(markup).not.toContain('$0.00');
    expect(markup).toContain('3 sessions unpriced · 2 without usage');
  });

  it('right-aligns both pill slots in their own column so the error pill edge is a straight column', () => {
    // Two FIXED-width tracks with `justify-items-end`: each row is its own grid
    // container, so `auto` tracks resolved per row and the error column drifted;
    // fixed tracks give one straight edge, and an absent empty pill leaves its
    // slot empty instead of letting the error pill drift right.
    expect(markup).toContain('grid-cols-[76px_84px]');
    expect(markup).not.toContain('minmax(62px,auto)');
    expect(markup).toContain('justify-items-end');
    expect(markup).not.toContain('min-w-[62px]');
  });

  it('renders each tool with its pills, and no "empty" pill for a tool with no classified calls (AC-3)', () => {
    expect(markup).toContain('explain');
    expect(markup).toContain('6.1% err');
    expect(markup).toContain('22.0% empty');
    expect(markup).toContain('find_callers');
    // find_callers is the only 0.0% err row, and it must carry no empty pill at all.
    expect(markup).toContain('0.0% err');
    expect(markup.match(/empty<\/span>/g) ?? []).toHaveLength(2);
    expect(markup).toContain('3 of 3 tools');
  });

  it('meters adoption on the server-observed developer ratio (BR-3)', () => {
    expect(markup).toContain('Developers using Coredoc');
    expect(markup).toContain('Server-observed MCP calls');
    // 4 of 6 active developers called Coredoc in the fixture window.
    expect(markup).toContain('67%');
    expect(markup).toContain('4 of 6 use Coredoc');
    expect(markup).not.toContain('Sessions using Coredoc');
    expect(markup).not.toContain('Median Coredoc calls / session');
  });

  it('orders members by Coredoc calls descending regardless of the order they arrived in', () => {
    const order = ['Alice Nowak', 'Bob Smith', 'Carol Diaz'].map((name) => markup.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it('hides per-member spend and renders relative activity labels', () => {
    // Per-person spend is hidden for now (SHOW_SPEND in MembersTable).
    expect(markup).not.toContain('$42.75');
    expect(markup).toContain('today');
    expect(markup).toContain('7d ago');
    expect(markup).toContain('3 members active in the last 30d · click a column to sort');
  });

  it('leaves the session-feedback card to its own read — the usage aggregate no longer renders it', () => {
    // The card owns a second, independently paged records read, so it hangs off
    // UsageView beside this body (feedback-card.test.ts covers it).
    expect(markup).not.toContain('Session feedback');
    expect(markup).not.toContain('submit_session_feedback');
  });

  it('rounds the tool latency instead of printing the raw average float', () => {
    expect(markup).toContain('180 ms');
    expect(markup).not.toMatch(/\d\.\d{3,} ms/);
  });

  it('agrees count and noun in the members subtitle', () => {
    expect(markup).not.toContain('1 members');
  });

  it('gives every member header the same uppercase label recipe and an explicit sort state', () => {
    // Form controls do not inherit `text-transform`, so the sort buttons must carry it.
    expect(markup).toContain(
      '<button type="button" class="cursor-pointer rounded-sm px-1 py-0.5 text-[10.5px] uppercase tracking-[0.04em]',
    );
    // Sortable-but-unsorted columns announce themselves as sortable.
    expect(markup).toContain('aria-sort="none"');
    expect(markup).toContain('aria-sort="descending"');
  });

  it('titles the members card for a self-scoped member view (UC-2)', () => {
    expect(render(false)).toContain('Your usage');
  });

  it('uses only design tokens for the SVG it owns (BR-13, AC-10)', () => {
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

// A window in which nobody was active at all: no session owner, no MCP caller.
const NO_ACTIVITY: WorkspaceUsageAnalytics = {
  ...USAGE_FIXTURE,
  kpis: { ...USAGE_FIXTURE.kpis, developers: { current: 0, usingCoredoc: 0 } },
  adoption: {
    developersUsingCoredoc: 0,
    developersActive: 0,
    totalCoredocCalls: 0,
    coredocSuccessRate: null,
    avgCallLatencyMs: null,
    medianTokensPerSession: 101_500,
  },
  feedback: {
    feedbackCount: 0,
    topIssues: [],
    topSessionIssues: [],
    topMissingTools: [],
    ratingTrend: [],
    reviews: { unreviewed: 0, confirmed: 0, amended: 0, avgSelfAssessmentGap: null, gapCount: 0 },
  },
};

describe('Usage view with no observed Coredoc activity (BR-11)', () => {
  const markup = renderToStaticMarkup(
    createElement(UsageBody, { usage: NO_ACTIVITY, isTeam: true, now: USAGE_FIXTURE_NOW }),
  );

  it('shows the adoption meter as a dash rather than a fabricated 0%', () => {
    // The meter headline is the dash (the `width: 0%` style stays).
    expect(markup).not.toContain('>0%<');
    expect(markup).toContain('>—<');
  });

  it('no longer carries the retired host-telemetry caveat or the cost-per-session card', () => {
    expect(markup).not.toContain('Host session telemetry');
    expect(markup).not.toContain('host telemetry has no Coredoc usage');
    expect(markup).not.toContain('Cost per session');
    expect(markup).not.toContain('Without Coredoc');
  });

  it('still states the server-observed ratio, which is a measured 0 of 0', () => {
    expect(markup).toContain('0 of 0 use Coredoc');
  });
});

describe('KpiCard sparkline band', () => {
  const spark = [
    { date: '2026-08-30', value: 1 },
    { date: '2026-08-31', value: 4 },
    { date: '2026-09-01', value: 2 },
  ];

  it('renders the spark as the last child in normal flow, never an overlay over the caption', () => {
    const markup = renderToStaticMarkup(
      createElement(KpiCard, { label: 'Assistant spend', value: '$12.40', hint: '3 sessions unpriced', spark }),
    );

    // Last child: the band closes the tile, so the hint above it can never be painted over.
    expect(markup.endsWith('</svg></div>')).toBe(true);
    expect(markup).toContain('mt-auto');
    expect(markup).not.toContain('absolute');
    // The reserved-padding hack the overlay needed is gone with it.
    expect(markup).not.toContain('pb-9');
  });

  it('keeps the tile layout unchanged when there is no spark to draw', () => {
    const markup = renderToStaticMarkup(
      createElement(KpiCard, { label: 'Active developers', value: '4', hint: '2 using Coredoc' }),
    );

    expect(markup).not.toContain('<svg');
    expect(markup).not.toContain('absolute');
  });
});
