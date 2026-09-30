import { describe, it, expect, vi } from 'vitest';
import { FeedbackService } from './feedback.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { SubmitFeedbackInput, FeedbackRecordsQuery } from './feedback.types.js';
import { FeedbackSort, SortOrder } from './feedback.types.js';

function baseInput(over: Partial<SubmitFeedbackInput> = {}): SubmitFeedbackInput {
  return {
    workspaceId: 'ws-1',
    perToolIssues: [],
    missingCapabilities: [],
    misleadingMetadata: [],
    sessionIssues: [],
    reviewStatus: 'unreviewed',
    ...over,
  };
}

function mockPrisma(rows: any[] = []) {
  return {
    mcpFeedback: {
      create: vi.fn().mockResolvedValue({ id: 'fb-1' }),
      findMany: vi.fn().mockResolvedValue(rows),
      count: vi.fn().mockResolvedValue(0),
    },
    agentSession: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService & {
    mcpFeedback: { create: any; findMany: any; count: any };
    agentSession: { findMany: any };
  };
}

describe('FeedbackService', () => {
  it('submitFeedback persists the payload and returns the id', async () => {
    const prisma = mockPrisma();
    const svc = new FeedbackService(prisma as any);
    const res = await svc.submitFeedback(
      baseInput({
        perToolIssues: [{ tool: 'search_symbols', issueType: 'noise', severity: 3, description: 'too many hits' }],
      }),
    );
    expect(res.id).toBe('fb-1');
    const data = (prisma as any).mcpFeedback.create.mock.calls[0][0].data;
    expect(data.workspaceId).toBe('ws-1');
    expect(data.perToolIssues).toEqual([
      { tool: 'search_symbols', issueType: 'noise', severity: 3, description: 'too many hits' },
    ]);
  });

  it('submitFeedback persists session issues, summary, and the user review', async () => {
    const prisma = mockPrisma();
    const svc = new FeedbackService(prisma as any);
    const sessionIssue = {
      area: 'task-context' as const,
      issueType: 'missing_context' as const,
      severity: 4,
      description: 'no acceptance criteria',
    };
    await svc.submitFeedback(
      baseInput({
        sessionIssues: [sessionIssue],
        summary: 'ok',
        overallRating: 4,
        userRating: 2,
        userNotes: 'missed the linux path',
        reviewStatus: 'amended',
      }),
    );
    const data = (prisma as any).mcpFeedback.create.mock.calls[0][0].data;
    expect(data.sessionIssues).toEqual([sessionIssue]);
    expect(data.summary).toBe('ok');
    expect(data.overallRating).toBe(4);
    expect(data.userRating).toBe(2);
    expect(data.userNotes).toBe('missed the linux path');
    expect(data.reviewStatus).toBe('amended');
  });

  it('submitFeedback defaults the optional session fields to null', async () => {
    const prisma = mockPrisma();
    await new FeedbackService(prisma as any).submitFeedback(baseInput());
    const data = (prisma as any).mcpFeedback.create.mock.calls[0][0].data;
    expect(data.sessionIssues).toEqual([]);
    expect(data.summary).toBeNull();
    expect(data.userRating).toBeNull();
    expect(data.userNotes).toBeNull();
    expect(data.reviewStatus).toBe('unreviewed');
  });

  it('getRoadmap ranks session issues by area and type on severity-weighted score', async () => {
    const prisma = mockPrisma([
      {
        perToolIssues: [],
        missingCapabilities: [],
        sessionIssues: [
          { area: 'skill-instructions', issueType: 'confusing', severity: 5, description: 'a' },
          { area: 'task-context', issueType: 'missing_context', severity: 2, description: 'b' },
        ],
      },
      {
        perToolIssues: [],
        missingCapabilities: [],
        sessionIssues: [{ area: 'skill-instructions', issueType: 'confusing', severity: 4, description: 'c' }],
      },
    ]);
    const rm = await new FeedbackService(prisma as any).getRoadmap('ws-1', 30);
    expect(rm.topSessionIssues).toEqual([
      { area: 'skill-instructions', issueType: 'confusing', count: 2, severityScore: 9 },
      { area: 'task-context', issueType: 'missing_context', count: 1, severityScore: 2 },
    ]);
    expect(rm.topIssues).toEqual([]);
  });

  // Rows from before the session-scope columns existed carry no sessionIssues
  // or reviewStatus at all in a mocked read; the roadmap must treat them as
  // unreviewed with no session issues, which is what they are.
  it('getRoadmap counts review statuses and the agent-vs-user rating gap', async () => {
    const prisma = mockPrisma([
      { perToolIssues: [], missingCapabilities: [], overallRating: 5, createdAt: new Date('2026-09-01') },
      {
        perToolIssues: [],
        missingCapabilities: [],
        overallRating: 5,
        userRating: 3,
        reviewStatus: 'amended',
        createdAt: new Date('2026-09-02'),
      },
      {
        perToolIssues: [],
        missingCapabilities: [],
        overallRating: 4,
        userRating: 4,
        reviewStatus: 'confirmed',
        createdAt: new Date('2026-09-03'),
      },
      {
        perToolIssues: [],
        missingCapabilities: [],
        overallRating: null,
        userRating: 1,
        reviewStatus: 'amended',
        createdAt: new Date('2026-10-01'),
      },
    ]);
    const rm = await new FeedbackService(prisma as any).getRoadmap('ws-1', 90);
    expect(rm.reviews).toEqual({ unreviewed: 1, confirmed: 1, amended: 2, avgSelfAssessmentGap: 1, gapCount: 2 });
    expect(rm.ratingTrend).toEqual([
      { month: '2026-09', avgRating: 14 / 3, count: 3, avgUserRating: 3.5, userCount: 2 },
      { month: '2026-10', avgRating: null, count: 0, avgUserRating: 1, userCount: 1 },
    ]);
  });

  // A `confirmed` record carries no userRating by contract (the tool rejects
  // one), yet the user stood behind the agent's number — a zero gap, not a
  // missing one. Excluding it would bias the mean toward the disagreements.
  it('getRoadmap counts a confirmed record as a zero self-assessment gap', async () => {
    const prisma = mockPrisma([
      {
        perToolIssues: [],
        missingCapabilities: [],
        overallRating: 5,
        reviewStatus: 'confirmed',
        createdAt: new Date('2026-09-01'),
      },
      {
        perToolIssues: [],
        missingCapabilities: [],
        overallRating: 5,
        userRating: 3,
        reviewStatus: 'amended',
        createdAt: new Date('2026-09-02'),
      },
    ]);
    const rm = await new FeedbackService(prisma as any).getRoadmap('ws-1', 30);
    expect(rm.reviews).toEqual({ unreviewed: 0, confirmed: 1, amended: 1, avgSelfAssessmentGap: 1, gapCount: 2 });
  });

  it('getRoadmap ranks issues by frequency and sums severity, and tallies missing tools', async () => {
    const prisma = mockPrisma([
      {
        perToolIssues: [
          { tool: 'trace_execution_path', issueType: 'incomplete', severity: 4, description: 'a' },
          { tool: 'search_symbols', issueType: 'noise', severity: 2, description: 'b' },
        ],
        missingCapabilities: [{ need: 'find_tests_for_symbol' }],
      },
      {
        perToolIssues: [{ tool: 'trace_execution_path', issueType: 'incomplete', severity: 5, description: 'c' }],
        missingCapabilities: [{ need: 'find_tests_for_symbol' }, { need: 'diff_impact' }],
      },
    ]);
    const svc = new FeedbackService(prisma as any);
    const rm = await svc.getRoadmap('ws-1', 30);
    expect(rm.feedbackCount).toBe(2);
    expect(rm.topIssues[0]).toEqual({
      tool: 'trace_execution_path',
      issueType: 'incomplete',
      count: 2,
      severityScore: 9,
    });
    expect(rm.topMissingTools[0]).toEqual({ need: 'find_tests_for_symbol', count: 2 });
  });

  it('getRoadmap caps the ranked lists below the desktop projector limit', async () => {
    // 51 distinct needs, descending counts: need-00 appears 51 times, need-50 once.
    const missingCapabilities = Array.from({ length: 51 }, (_, i) =>
      Array.from({ length: 51 - i }, () => ({ need: `need-${String(i).padStart(2, '0')}` })),
    ).flat();
    const prisma = mockPrisma([{ perToolIssues: [], missingCapabilities, overallRating: null, createdAt: new Date() }]);
    const rm = await new FeedbackService(prisma).getRoadmap('ws-1', 30);
    expect(rm.topMissingTools.length).toBe(50);
    expect(rm.topMissingTools[0]).toEqual({ need: 'need-00', count: 51 });
    expect(rm.topMissingTools[49]).toEqual({ need: 'need-49', count: 2 });
  });

  it('submitFeedback rejects a 4th submission for the same session', async () => {
    const prisma = mockPrisma();
    (prisma.mcpFeedback.count as any).mockResolvedValue(3);
    const service = new FeedbackService(prisma as any);
    await expect(service.submitFeedback(baseInput({ sessionId: 'sess-1' }))).rejects.toThrow(/Feedback limit reached/);
    expect(prisma.mcpFeedback.create).not.toHaveBeenCalled();
  });

  it('submitFeedback caps sessionless submissions per user per day', async () => {
    const prisma = mockPrisma();
    (prisma.mcpFeedback.count as any).mockResolvedValue(10);
    const service = new FeedbackService(prisma as any);
    await expect(service.submitFeedback(baseInput({ userId: 'u1' }))).rejects.toThrow(/Daily feedback limit/);
    expect(prisma.mcpFeedback.create).not.toHaveBeenCalled();
    const where = (prisma.mcpFeedback.count as any).mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.sessionId).toBeNull();
  });

  it('getRoadmap ranks by severity-weighted score, not raw count', async () => {
    const prisma = mockPrisma([
      {
        // 3 blocker reports (severity 5) → severityScore 15
        perToolIssues: [
          { tool: 'trace_execution_path', issueType: 'wrong', severity: 5, description: 'a' },
          { tool: 'trace_execution_path', issueType: 'wrong', severity: 5, description: 'b' },
          { tool: 'trace_execution_path', issueType: 'wrong', severity: 5, description: 'c' },
        ],
        missingCapabilities: [],
      },
      {
        // 4 nitpick reports (severity 1) → severityScore 4, higher count
        perToolIssues: [
          { tool: 'search_symbols', issueType: 'noise', severity: 1, description: 'd' },
          { tool: 'search_symbols', issueType: 'noise', severity: 1, description: 'e' },
          { tool: 'search_symbols', issueType: 'noise', severity: 1, description: 'f' },
          { tool: 'search_symbols', issueType: 'noise', severity: 1, description: 'g' },
        ],
        missingCapabilities: [],
      },
    ]);
    const svc = new FeedbackService(prisma as any);
    const rm = await svc.getRoadmap('ws-1', 30);
    expect(rm.topIssues[0].tool).toBe('trace_execution_path'); // 15 > 4 despite lower count
    expect(rm.topIssues[1].tool).toBe('search_symbols');
  });

  it('getRoadmap returns a monthly average-rating trend', async () => {
    const prisma = mockPrisma();
    (prisma.mcpFeedback.findMany as any).mockResolvedValue([
      { perToolIssues: [], missingCapabilities: [], overallRating: 4, createdAt: new Date('2026-06-10') },
      { perToolIssues: [], missingCapabilities: [], overallRating: 2, createdAt: new Date('2026-06-20') },
      { perToolIssues: [], missingCapabilities: [], overallRating: null, createdAt: new Date('2026-07-01') },
    ]);
    const service = new FeedbackService(prisma as any);
    const view = await service.getRoadmap('ws-1', 60);
    expect(view.ratingTrend).toEqual([{ month: '2026-06', avgRating: 3, count: 2, avgUserRating: null, userCount: 0 }]);
  });

  it('getSessionCorrelation compares flagged sessions against all sessions', async () => {
    const prisma = mockPrisma();
    (prisma.mcpFeedback.findMany as any).mockResolvedValue([
      {
        sessionId: 's1',
        perToolIssues: [{ tool: 'trace_execution_path', issueType: 'incomplete', severity: 4, description: 'x' }],
      },
    ]);
    (prisma.agentSession.findMany as any).mockResolvedValue([
      { sessionId: 's1', tokensInput: 900, tokensOutput: 100, activeTimeSec: 60 },
      { sessionId: 's2', tokensInput: 400, tokensOutput: 100, activeTimeSec: 30 },
    ]);
    const service = new FeedbackService(prisma as any);
    const [c] = await service.getSessionCorrelation('ws-1', 30);
    expect(c.tool).toBe('trace_execution_path');
    expect(c.flaggedSessionCount).toBe(1);
    expect(c.medianFlaggedTokens).toBe(1000);
    expect(c.medianAllTokens).toBe(750);
    expect(c.medianFlaggedActiveTimeSec).toBe(60);
    expect(c.medianAllActiveTimeSec).toBe(45);
  });

  it('getSessionCorrelation excludes hook-created skeleton rows with no telemetry signal', async () => {
    const prisma = mockPrisma();
    const service = new FeedbackService(prisma as any);
    await service.getSessionCorrelation('ws-1', 30);
    const call = (prisma.agentSession.findMany as any).mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { lastEventNanos: { gt: 0 } },
      { activeTimeSec: { gt: 0 } },
      { tokensInput: { gt: 0 } },
      { tokensOutput: { gt: 0 } },
      { commitCount: { gt: 0 } },
    ]);
  });

  it('member roadmap reads filter feedback by the server-derived user id', async () => {
    const prisma = mockPrisma();
    const service = new FeedbackService(prisma as any);
    await service.getRoadmap('ws-1', 30, { userId: 'member-a' });
    expect((prisma.mcpFeedback.findMany as any).mock.calls[0][0].where.userId).toBe('member-a');
  });

  it('getRoadmap uses an explicit `since` verbatim and the rolling default when absent', async () => {
    // The analytics/usage composer pins every sub-read to one UTC-day-aligned
    // window (BR-16); the standalone route keeps the rolling now-days default.
    const prisma = mockPrisma();
    const service = new FeedbackService(prisma as any);
    const pinned = new Date('2026-08-01T00:00:00.000Z');

    await service.getRoadmap('ws-1', 30, undefined, pinned);
    expect((prisma.mcpFeedback.findMany as any).mock.calls[0][0].where.createdAt.gte).toBe(pinned);

    await service.getRoadmap('ws-1', 30);
    const rolling = (prisma.mcpFeedback.findMany as any).mock.calls[1][0].where.createdAt.gte as Date;
    expect(Math.abs(rolling.getTime() - (Date.now() - 30 * 86_400_000))).toBeLessThan(5_000);
  });

  it('member correlation filters both feedback and the all-session comparison cohort', async () => {
    const prisma = mockPrisma();
    const service = new FeedbackService(prisma as any);
    await service.getSessionCorrelation('ws-1', 30, { userId: 'member-a' });
    expect((prisma.mcpFeedback.findMany as any).mock.calls[0][0].where.userId).toBe('member-a');
    expect((prisma.agentSession.findMany as any).mock.calls[0][0].where.userId).toBe('member-a');
  });

  describe('listRecords', () => {
    const baseQuery = (over: Partial<FeedbackRecordsQuery> = {}): FeedbackRecordsQuery => ({
      days: 30,
      since: new Date('2026-08-09T00:00:00.000Z'),
      untilExclusive: new Date('2026-09-08T00:00:00.000Z'),
      page: 1,
      limit: 25,
      sort: FeedbackSort.CreatedAt,
      order: SortOrder.Desc,
      reviewStatus: null,
      area: null,
      tool: null,
      maxRating: null,
      userId: null,
      ...over,
    });
    const findManyArg = (prisma: any) => prisma.mcpFeedback.findMany.mock.calls[0][0];

    it('maps a row and echoes the resolved window and paging', async () => {
      const prisma = mockPrisma([
        {
          id: 'fb-1',
          createdAt: new Date('2026-09-01T10:00:00.000Z'),
          userId: 'u1',
          userEmail: 'a@example.test',
          sessionId: 's1',
          runId: null,
          repoKey: 'repo',
          overallRating: 4,
          userRating: 2,
          reviewStatus: 'amended',
          summary: 'ok',
          userNotes: 'notes',
          perToolIssues: [{ tool: 'search_symbols', issueType: 'noise', severity: 3, description: 'd' }],
          sessionIssues: null,
          missingCapabilities: [],
          misleadingMetadata: [],
        },
      ]);
      (prisma as any).mcpFeedback.count.mockResolvedValue(312);
      const page = await new FeedbackService(prisma as any).listRecords('ws-1', baseQuery());

      expect(page.total).toBe(312);
      expect(page.page).toBe(1);
      expect(page.limit).toBe(25);
      expect(page.window).toEqual({
        days: 30,
        since: '2026-08-09T00:00:00.000Z',
        until: '2026-09-08T00:00:00.000Z',
      });
      expect(page.items[0].createdAt).toBe('2026-09-01T10:00:00.000Z');
      expect(page.items[0].perToolIssues[0].tool).toBe('search_symbols');
      // A null JSON column degrades to an empty list, never to null.
      expect(page.items[0].sessionIssues).toEqual([]);
    });

    it('bounds the window and offsets by page', async () => {
      const prisma = mockPrisma();
      await new FeedbackService(prisma as any).listRecords('ws-1', baseQuery({ page: 3, limit: 10 }));
      const arg = findManyArg(prisma);
      expect(arg.where.createdAt).toEqual({
        gte: new Date('2026-08-09T00:00:00.000Z'),
        lt: new Date('2026-09-08T00:00:00.000Z'),
      });
      expect(arg.skip).toBe(20);
      expect(arg.take).toBe(10);
      // One findMany + one count over the same where.
      expect((prisma as any).mcpFeedback.count.mock.calls[0][0].where).toEqual(arg.where);
    });

    it('AND-s the JSON, status and rating filters', async () => {
      const prisma = mockPrisma();
      await new FeedbackService(prisma as any).listRecords(
        'ws-1',
        baseQuery({ reviewStatus: 'unreviewed', area: 'task-context', tool: 'explain', maxRating: 2 }),
      );
      expect(findManyArg(prisma).where).toMatchObject({
        workspaceId: 'ws-1',
        reviewStatus: 'unreviewed',
        sessionIssues: { array_contains: [{ area: 'task-context' }] },
        perToolIssues: { array_contains: [{ tool: 'explain' }] },
        overallRating: { lte: 2 },
      });
    });

    it('widens area=mcp-transport to records that only report tool issues', async () => {
      const prisma = mockPrisma();
      await new FeedbackService(prisma as any).listRecords('ws-1', baseQuery({ area: 'mcp-transport' }));
      const where = findManyArg(prisma).where;
      expect(where.OR).toEqual([
        { sessionIssues: { array_contains: [{ area: 'mcp-transport' }] } },
        { NOT: { perToolIssues: { equals: [] } } },
      ]);
      // The widened area still narrows the same query as the other filters, not replaces them.
      expect(where.sessionIssues).toBeUndefined();
      expect(where.workspaceId).toBe('ws-1');
      expect(where.createdAt).toEqual({
        gte: new Date('2026-08-09T00:00:00.000Z'),
        lt: new Date('2026-09-08T00:00:00.000Z'),
      });
    });

    it('keeps every other area on the session-issue match alone', async () => {
      const prisma = mockPrisma();
      await new FeedbackService(prisma as any).listRecords('ws-1', baseQuery({ area: 'capture' }));
      const where = findManyArg(prisma).where;
      expect(where.sessionIssues).toEqual({ array_contains: [{ area: 'capture' }] });
      expect(where.OR).toBeUndefined();
    });

    it('sorts ratings nulls-last in both directions with a stable tie-break', async () => {
      const prisma = mockPrisma();
      const svc = new FeedbackService(prisma as any);
      await svc.listRecords('ws-1', baseQuery({ sort: FeedbackSort.OverallRating, order: SortOrder.Asc }));
      expect(prisma.mcpFeedback.findMany.mock.calls[0][0].orderBy).toEqual([
        { overallRating: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);

      await svc.listRecords('ws-1', baseQuery({ sort: FeedbackSort.UserRating, order: SortOrder.Desc }));
      expect(prisma.mcpFeedback.findMany.mock.calls[1][0].orderBy[0]).toEqual({
        userRating: { sort: 'desc', nulls: 'last' },
      });

      await svc.listRecords('ws-1', baseQuery({ order: SortOrder.Asc }));
      expect(prisma.mcpFeedback.findMany.mock.calls[2][0].orderBy).toEqual([{ createdAt: 'asc' }, { id: 'desc' }]);
    });

    it('self-scope overrides a requested member filter', async () => {
      const prisma = mockPrisma();
      await new FeedbackService(prisma as any).listRecords('ws-1', baseQuery({ userId: 'member-b' }), {
        userId: 'member-a',
      });
      expect(findManyArg(prisma).where.userId).toBe('member-a');
    });

    it('filters by the requested member when unscoped', async () => {
      const prisma = mockPrisma();
      await new FeedbackService(prisma as any).listRecords('ws-1', baseQuery({ userId: 'member-b' }));
      expect(findManyArg(prisma).where.userId).toBe('member-b');
    });
  });
});
