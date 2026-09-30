import { describe, it, expect } from 'vitest';
import {
  countDevelopers,
  foldAdoption,
  foldMembers,
  foldSpendKpi,
  mergeToolRows,
  priceSessions,
  spendSeries,
  splitWindows,
  sumPoints,
  usageWindowBounds,
  usageWindowBoundsFrom,
  utcDayKeys,
  type UsageSessionRow,
} from './usage-analytics.fold.js';

function session(over: Partial<UsageSessionRow> = {}): UsageSessionRow {
  return {
    provider: 'claude-code',
    sessionId: 's1',
    userId: 'u1',
    userEmail: 'u1@acme.test',
    model: 'claude-sonnet-4-6',
    tokensInput: 1_000_000,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensReasoning: 0,
    startedAt: new Date('2026-08-01T10:00:00.000Z'),
    ...over,
  };
}

describe('usage window bounds (BR-16)', () => {
  it('spans `days` whole UTC days ending today, with the previous window immediately before', () => {
    const now = new Date('2026-08-03T14:31:07.000Z');
    const { since, until, previousSince } = usageWindowBounds(3, now);

    expect(since.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(until.toISOString()).toBe('2026-08-03T14:31:07.000Z');
    expect(previousSince.toISOString()).toBe('2026-07-29T00:00:00.000Z');
    expect(utcDayKeys(since, 3)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('keeps explicit calendar bounds and puts the comparison window immediately before them', () => {
    const { since, until, previousSince } = usageWindowBoundsFrom(
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-04T00:00:00.000Z'),
    );

    expect(since.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(until.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    expect(previousSince.toISOString()).toBe('2026-07-29T00:00:00.000Z');
    expect(utcDayKeys(since, 3)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });
});

describe('window split (AC-1)', () => {
  const points = [
    { date: '2026-07-29', value: 4 },
    { date: '2026-07-30', value: 1 },
    { date: '2026-07-31', value: 2 },
    { date: '2026-08-01', value: 5 },
    { date: '2026-08-02', value: 0 },
    { date: '2026-08-03', value: 7 },
  ];

  it('splits a 2 x days series into previous and current halves whose sums are the KPI counters', () => {
    const { previous, current } = splitWindows(points, 3);

    expect(previous.map((p) => p.date)).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
    expect(current.map((p) => p.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    // Both halves are seeded: a read that ignored the previous window would
    // report previous 0 here.
    expect(sumPoints(previous)).toBe(7);
    expect(sumPoints(current)).toBe(12);
  });
});

describe('tool merge (AC-3, BR-3)', () => {
  it('joins by toolName and leaves emptyRate null for a tool with no classified calls', () => {
    const rows = mergeToolRows(
      [
        { toolName: 'search_symbols', count: 20, errorRate: 0.05, avgMs: 120 },
        { toolName: 'explain', count: 9, errorRate: 0, avgMs: 300 },
      ],
      [{ toolName: 'search_symbols', total: 12, empty: 3, emptyRate: 0.25 }],
    );

    expect(rows.map((r) => r.toolName)).toEqual(['search_symbols', 'explain']);
    expect(rows[0]).toMatchObject({ calls: 20, errorRate: 0.05, avgMs: 120, emptyRate: 0.25, classifiedCalls: 12 });
    // No classified row → unknown yield, never "0% empty".
    expect(rows[1].emptyRate).toBeNull();
    expect(rows[1].classifiedCalls).toBe(0);
  });

  it('carries no rest: rows — the breakdown reads exclude them upstream', () => {
    const rows = mergeToolRows([{ toolName: 'explain', count: 3, errorRate: 0, avgMs: 10 }], []);
    expect(rows.some((r) => r.toolName.startsWith('rest:'))).toBe(false);
  });
});

describe('session pricing and spend (AC-2, BR-1, BR-17)', () => {
  const rows: UsageSessionRow[] = [
    // priced claude session: 1M input @ $3/M = $3.00
    session({ sessionId: 'claude-priced' }),
    // priced codex session with tool stats: 100k input @ $0.20/M = $0.02
    session({
      sessionId: 'codex-priced',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      userId: 'u2',
      userEmail: 'u2@acme.test',
      tokensInput: 100_000,
    }),
    // invented model → usage observed, no price
    session({ sessionId: 'unpriced', model: 'claude-imaginary-9', userId: 'u3', userEmail: 'u3@acme.test' }),
    // no token counter at all → usage-less, must not read as $0
    session({ sessionId: 'no-usage', tokensInput: 0, userId: 'u4', userEmail: 'u4@acme.test' }),
    // a day whose only session is unpriced
    session({
      sessionId: 'unpriced-day',
      model: 'claude-imaginary-9',
      startedAt: new Date('2026-08-02T09:00:00.000Z'),
    }),
  ];
  const priced = priceSessions(rows);

  it('prices both hosts and marks unpriced / usage-less sessions separately', () => {
    const byId = new Map(priced.map((p) => [p.sessionId, p]));
    expect(byId.get('claude-priced')?.estimatedCostUsd).toBeCloseTo(3, 10);
    expect(byId.get('codex-priced')?.estimatedCostUsd).toBeCloseTo(0.02, 10);
    expect(byId.get('unpriced')?.estimatedCostUsd).toBeNull();
    expect(byId.get('unpriced')?.usageObserved).toBe(true);
    expect(byId.get('no-usage')?.usageObserved).toBe(false);
  });

  it('the spend KPI sums priced sessions only and counts the rest explicitly', () => {
    const spend = foldSpendKpi(priced, []);
    expect(spend.currentUsd).toBeCloseTo(3.02, 10);
    expect(spend.unpricedSessions).toBe(2);
    expect(spend.sessionsWithoutUsage).toBe(1);
    // No previous-window session at all → null, not 0.
    expect(spend.previousUsd).toBeNull();
  });

  it('an all-unpriced workspace reports null spend, never $0', () => {
    const onlyUnpriced = priceSessions([session({ model: 'claude-imaginary-9' })]);
    expect(foldSpendKpi(onlyUnpriced, []).currentUsd).toBeNull();
  });

  it('a day with only unpriced sessions is null; a day with no session is a real 0', () => {
    const series = spendSeries(priced, utcDayKeys(new Date('2026-08-01T00:00:00.000Z'), 3));

    expect(series[0]).toEqual({
      date: '2026-08-01',
      value: expect.closeTo(3.02, 10),
      unpricedSessions: 1,
      sessionsWithoutUsage: 1,
    });
    expect(series[1]).toEqual({ date: '2026-08-02', value: null, unpricedSessions: 1, sessionsWithoutUsage: 0 });
    expect(series[2]).toEqual({ date: '2026-08-03', value: 0, unpricedSessions: 0, sessionsWithoutUsage: 0 });
  });

  it('a day whose only session reported no usage data is a gap, distinct from an unpriced-model gap', () => {
    const rowsWithoutUsage: UsageSessionRow[] = [
      session({ sessionId: 'no-usage-only-day', tokensInput: 0, startedAt: new Date('2026-08-02T09:00:00.000Z') }),
    ];
    const series = spendSeries(priceSessions(rowsWithoutUsage), utcDayKeys(new Date('2026-08-01T00:00:00.000Z'), 3));

    expect(series[0]).toEqual({ date: '2026-08-01', value: 0, unpricedSessions: 0, sessionsWithoutUsage: 0 });
    expect(series[1]).toEqual({ date: '2026-08-02', value: null, unpricedSessions: 0, sessionsWithoutUsage: 1 });
    expect(series[2]).toEqual({ date: '2026-08-03', value: 0, unpricedSessions: 0, sessionsWithoutUsage: 0 });
  });

  it('sources every Coredoc figure from the server-observed MCP rows, not from host session stats', () => {
    const adoption = foldAdoption(
      priced,
      [
        { userId: 'u1', toolName: 'search_symbols', count: 3 },
        { userId: 'u1', toolName: 'explain', count: 1 },
        // An MCP-only caller: no session of theirs is in the window at all.
        { userId: 'u9', toolName: 'explain', count: 2 },
        // Unattributed calls still count toward the total, never toward a developer.
        { userId: null, toolName: 'explain', count: 4 },
      ],
      [
        { toolName: 'search_symbols', count: 6, errorRate: 0.5, avgMs: 100 },
        { toolName: 'explain', count: 4, errorRate: 0, avgMs: 300 },
      ],
    );

    expect(adoption.developersUsingCoredoc).toBe(2);
    // session users u1..u4 unioned with the MCP-only u9.
    expect(adoption.developersActive).toBe(5);
    expect(adoption.totalCoredocCalls).toBe(10);
    // call-weighted: 3 errors of 10 calls.
    expect(adoption.coredocSuccessRate).toBeCloseTo(0.7, 10);
    // call-weighted: (6*100 + 4*300) / 10.
    expect(adoption.avgCallLatencyMs).toBeCloseTo(180, 10);
    expect(adoption.medianTokensPerSession).toBe(1_000_000);
  });

  it('degrades the Coredoc rates to null when the server observed no call in the window', () => {
    const adoption = foldAdoption(priced, [], []);

    expect(adoption.totalCoredocCalls).toBe(0);
    expect(adoption.developersUsingCoredoc).toBe(0);
    expect(adoption.coredocSuccessRate).toBeNull();
    expect(adoption.avgCallLatencyMs).toBeNull();
    // Session-sourced facts are unaffected by the absence of MCP rows.
    expect(adoption.developersActive).toBe(4);
    expect(adoption.medianTokensPerSession).toBe(1_000_000);
  });

  it('counts distinct developers across sessions and MCP-only callers', () => {
    expect(countDevelopers(priced, [])).toBe(4);
    expect(countDevelopers(priced, [{ userId: 'u1', toolName: 'explain', count: 1 }])).toBe(4);
    expect(countDevelopers(priced, [{ userId: 'u9', toolName: 'explain', count: 1 }])).toBe(5);
    // A zero-count group is not evidence that anybody called anything.
    expect(countDevelopers(priced, [{ userId: 'u9', toolName: 'explain', count: 0 }])).toBe(4);
  });
});

describe('members rollup', () => {
  it('groups by userId when present and by email otherwise, and attributes mcp calls to userId rows only', () => {
    const priced = priceSessions([
      session({ sessionId: 'a1', userId: 'u1', userEmail: 'old@acme.test' }),
      // same user after an email change — must not split into two rows
      session({
        sessionId: 'a2',
        userId: 'u1',
        userEmail: 'new@acme.test',
        startedAt: new Date('2026-08-02T08:00:00.000Z'),
      }),
      session({ sessionId: 'b1', userId: null, userEmail: 'ghostmail@acme.test', model: 'claude-imaginary-9' }),
    ]);

    const members = foldMembers(
      priced,
      [
        { userId: 'u1', toolName: 'search_symbols', count: 2 },
        { userId: 'u1', toolName: 'explain', count: 5 },
        { userId: null, toolName: 'explain', count: 99 },
      ],
      [{ userId: 'u1', email: 'new@acme.test', displayName: 'Uno' }],
    );

    expect(members).toHaveLength(2);
    const [first, second] = members;
    expect(first).toMatchObject({
      userId: 'u1',
      displayName: 'Uno',
      sessions: 2,
      tokens: 2_000_000,
      coredocCalls: 7,
      topTool: 'explain',
      unpricedSessions: 0,
      lastActiveAt: '2026-08-02T08:00:00.000Z',
    });
    expect(first.estimatedCostUsd).toBeCloseTo(6, 10);
    // A session without a userId cannot claim the unattributed mcp rows.
    expect(second).toMatchObject({ userId: null, coredocCalls: 0, topTool: null, unpricedSessions: 1 });
    expect(second.estimatedCostUsd).toBeNull();
  });

  it('includes a user with mcp calls but no session, with the null-cost sentinel', () => {
    const members = foldMembers(
      priceSessions([session({ sessionId: 'a1', userId: 'u1', userEmail: 'u1@acme.test' })]),
      [
        { userId: 'u1', toolName: 'explain', count: 1 },
        // u2 queried MCP in the window without opening a session.
        { userId: 'u2', toolName: 'search_symbols', count: 3 },
        { userId: 'u2', toolName: 'explain', count: 6 },
        // Unattributable rows must not mint a row of their own.
        { userId: null, toolName: 'explain', count: 42 },
      ],
      [
        { userId: 'u1', email: 'u1@acme.test', displayName: 'Uno' },
        { userId: 'u2', email: 'u2@acme.test', displayName: 'Dos' },
      ],
    );

    expect(members.map((m) => m.userId)).toEqual(['u2', 'u1']);
    expect(members[0]).toEqual({
      userId: 'u2',
      userEmail: 'u2@acme.test',
      displayName: 'Dos',
      sessions: 0,
      tokens: 0,
      // Nothing was priced for this user — 0.00 would read as measured spend.
      estimatedCostUsd: null,
      unpricedSessions: 0,
      coredocCalls: 9,
      topTool: 'explain',
      lastActiveAt: null,
    });
    expect(members[1].sessions).toBe(1);
  });
});
