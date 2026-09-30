import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { SelfScope } from '../../auth/self-scope.js';
import type {
  SubmitFeedbackInput,
  RoadmapView,
  RankedIssue,
  RankedNeed,
  FeedbackToolIssue,
  MissingCapability,
  IssueType,
  RatingTrendPoint,
  IssueCostCorrelation,
  RankedSessionIssue,
  ReviewSummary,
  SessionIssue,
  MisleadingMetadata,
  ReviewStatus,
  FeedbackRecordsQuery,
  FeedbackRecordsPage,
} from './feedback.types.js';
import { FeedbackSort } from './feedback.types.js';

/** The desktop projector rejects a roadmap list longer than 100, so this must stay below it. */
const ROADMAP_TOP_N = 50;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The historical rolling window base for the feedback reads: `now - days`. */
function rollingSince(days: number): Date {
  const since = new Date();
  since.setDate(since.getDate() - days);
  return since;
}

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async submitFeedback(input: SubmitFeedbackInput): Promise<{ id: string }> {
    if (input.sessionId) {
      const existing = await this.prisma.mcpFeedback.count({
        where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      });
      if (existing >= 3) {
        throw new Error(
          'Feedback limit reached for this session (max 3 submissions) — existing feedback is already recorded.',
        );
      }
    } else {
      // Sessionless submissions bypass the per-session cap — bound them per day
      // so a single caller cannot flood the roadmap ranking.
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const where = input.userId
        ? { workspaceId: input.workspaceId, userId: input.userId, sessionId: null, createdAt: { gte: dayStart } }
        : { workspaceId: input.workspaceId, sessionId: null, createdAt: { gte: dayStart } };
      const limit = input.userId ? 10 : 50;
      const existing = await this.prisma.mcpFeedback.count({ where });
      if (existing >= limit) {
        throw new Error(
          'Daily feedback limit reached for submissions without a sessionId — pass the Claude Code sessionId to continue submitting.',
        );
      }
    }
    const row = await this.prisma.mcpFeedback.create({
      data: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        userId: input.userId ?? null,
        userEmail: input.userEmail ?? null,
        repoKey: input.repoKey ?? null,
        overallRating: input.overallRating ?? null,
        perToolIssues: input.perToolIssues as unknown as Prisma.InputJsonValue,
        missingCapabilities: input.missingCapabilities as unknown as Prisma.InputJsonValue,
        misleadingMetadata: input.misleadingMetadata as unknown as Prisma.InputJsonValue,
        sessionIssues: input.sessionIssues as unknown as Prisma.InputJsonValue,
        summary: input.summary ?? null,
        userRating: input.userRating ?? null,
        userNotes: input.userNotes ?? null,
        reviewStatus: input.reviewStatus,
      },
    });
    return { id: row.id };
  }

  /**
   * `since` overrides the rolling `now - days` window so a composing read
   * (analytics/usage) can pin every sub-read to one UTC-day-aligned window;
   * absent, the standalone route keeps its historical rolling behaviour.
   */
  async getRoadmap(
    workspaceId: string,
    days = 30,
    scope?: SelfScope,
    since?: Date,
    until?: Date,
  ): Promise<RoadmapView> {
    const windowStart = since ?? rollingSince(days);
    const rows = await this.prisma.mcpFeedback.findMany({
      where: {
        workspaceId,
        createdAt: { gte: windowStart, ...(until ? { lt: until } : {}) },
        ...(scope ? { userId: scope.userId } : {}),
      },
      select: {
        perToolIssues: true,
        sessionIssues: true,
        missingCapabilities: true,
        overallRating: true,
        userRating: true,
        reviewStatus: true,
        createdAt: true,
      },
    });

    const issueMap = new Map<string, RankedIssue>();
    const sessionIssueMap = new Map<string, RankedSessionIssue>();
    const needMap = new Map<string, RankedNeed>();
    for (const r of rows) {
      for (const i of (r.perToolIssues as unknown as FeedbackToolIssue[]) ?? []) {
        const key = `${i.tool}::${i.issueType}`;
        const cur = issueMap.get(key) ?? { tool: i.tool, issueType: i.issueType, count: 0, severityScore: 0 };
        cur.count += 1;
        cur.severityScore += Number(i.severity) || 0;
        issueMap.set(key, cur);
      }
      for (const i of (r.sessionIssues as unknown as SessionIssue[]) ?? []) {
        const key = `${i.area}::${i.issueType}`;
        const cur = sessionIssueMap.get(key) ?? { area: i.area, issueType: i.issueType, count: 0, severityScore: 0 };
        cur.count += 1;
        cur.severityScore += Number(i.severity) || 0;
        sessionIssueMap.set(key, cur);
      }
      for (const c of (r.missingCapabilities as unknown as MissingCapability[]) ?? []) {
        const cur = needMap.get(c.need) ?? { need: c.need, count: 0 };
        cur.count += 1;
        needMap.set(c.need, cur);
      }
    }
    // severityScore (sum of severities) IS the frequency×severity product the spec
    // ranks by — count is the tiebreaker, so 3 blockers outrank 10 nitpicks.
    const topIssues = [...issueMap.values()]
      .sort((a, b) => b.severityScore - a.severityScore || b.count - a.count)
      .slice(0, ROADMAP_TOP_N);
    const topSessionIssues = [...sessionIssueMap.values()]
      .sort((a, b) => b.severityScore - a.severityScore || b.count - a.count)
      .slice(0, ROADMAP_TOP_N);
    const topMissingTools = [...needMap.values()].sort((a, b) => b.count - a.count).slice(0, ROADMAP_TOP_N);

    const trendMap = new Map<string, { sum: number; count: number; userSum: number; userCount: number }>();
    const reviews: ReviewSummary = { unreviewed: 0, confirmed: 0, amended: 0, avgSelfAssessmentGap: null, gapCount: 0 };
    let gapSum = 0;
    for (const r of rows) {
      if (r.reviewStatus === 'confirmed' || r.reviewStatus === 'amended') reviews[r.reviewStatus] += 1;
      else reviews.unreviewed += 1;
      // `confirmed` = the user accepted the agent's draft as-is, so the gap is
      // zero by definition; such a record carries no userRating (the submit
      // tool rejects one), and skipping it would bias the mean toward the
      // records where the user disagreed.
      if (r.reviewStatus === 'confirmed') {
        reviews.gapCount += 1;
      } else if (r.overallRating != null && r.userRating != null) {
        gapSum += r.overallRating - r.userRating;
        reviews.gapCount += 1;
      }
      if (r.overallRating == null && r.userRating == null) continue;
      const month = r.createdAt.toISOString().slice(0, 7);
      const cur = trendMap.get(month) ?? { sum: 0, count: 0, userSum: 0, userCount: 0 };
      if (r.overallRating != null) {
        cur.sum += r.overallRating;
        cur.count += 1;
      }
      if (r.userRating != null) {
        cur.userSum += r.userRating;
        cur.userCount += 1;
      }
      trendMap.set(month, cur);
    }
    if (reviews.gapCount > 0) reviews.avgSelfAssessmentGap = gapSum / reviews.gapCount;
    // A month with only user ratings still needs a point, but its agent average
    // is null rather than a copy of the user average — consumers skip the agent
    // point for that month instead of plotting the user's number twice.
    const ratingTrend: RatingTrendPoint[] = [...trendMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, { sum, count, userSum, userCount }]) => ({
        month,
        avgRating: count > 0 ? sum / count : null,
        count,
        avgUserRating: userCount > 0 ? userSum / userCount : null,
        userCount,
      }));

    return { feedbackCount: rows.length, topIssues, topSessionIssues, topMissingTools, ratingTrend, reviews };
  }

  /**
   * The paged record list behind the feedback card. OFFSET paging (not a cursor): the window
   * bounds the volume, and sorting by a nullable rating has no stable cursor key anyway.
   */
  async listRecords(workspaceId: string, query: FeedbackRecordsQuery, scope?: SelfScope): Promise<FeedbackRecordsPage> {
    const where: Prisma.McpFeedbackWhereInput = {
      workspaceId,
      createdAt: { gte: query.since, lt: query.untilExclusive },
      // Self-scope wins over the requested member filter: a `member` only ever sees their own.
      ...(scope ? { userId: scope.userId } : query.userId ? { userId: query.userId } : {}),
      ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
      // `mcp-transport` is the MCP area: it also covers records written before session
      // feedback existed, which can only report tool issues and carry no session issue at all.
      ...(query.area === 'mcp-transport'
        ? {
            OR: [
              { sessionIssues: { array_contains: [{ area: 'mcp-transport' }] } },
              { NOT: { perToolIssues: { equals: [] } } },
            ],
          }
        : query.area
          ? { sessionIssues: { array_contains: [{ area: query.area }] } }
          : {}),
      ...(query.tool ? { perToolIssues: { array_contains: [{ tool: query.tool }] } } : {}),
      // `lte` on a nullable column already excludes unrated records in Postgres.
      ...(query.maxRating != null ? { overallRating: { lte: query.maxRating } } : {}),
    };
    // Nulls last in both directions so unrated records never head a rating sort; `id` breaks
    // ties left by equal timestamps so paging cannot repeat or skip a row.
    const orderBy: Prisma.McpFeedbackOrderByWithRelationInput[] =
      query.sort === FeedbackSort.CreatedAt
        ? [{ createdAt: query.order }, { id: 'desc' }]
        : [
            { [query.sort]: { sort: query.order, nulls: 'last' } } as Prisma.McpFeedbackOrderByWithRelationInput,
            { createdAt: 'desc' },
            { id: 'desc' },
          ];

    const [rows, total] = await Promise.all([
      this.prisma.mcpFeedback.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.mcpFeedback.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        userId: r.userId,
        userEmail: r.userEmail,
        sessionId: r.sessionId,
        runId: r.runId,
        repoKey: r.repoKey,
        overallRating: r.overallRating,
        userRating: r.userRating,
        reviewStatus: r.reviewStatus as ReviewStatus,
        summary: r.summary,
        userNotes: r.userNotes,
        perToolIssues: (r.perToolIssues as unknown as FeedbackToolIssue[]) ?? [],
        sessionIssues: (r.sessionIssues as unknown as SessionIssue[]) ?? [],
        missingCapabilities: (r.missingCapabilities as unknown as MissingCapability[]) ?? [],
        misleadingMetadata: (r.misleadingMetadata as unknown as MisleadingMetadata[]) ?? [],
      })),
      page: query.page,
      limit: query.limit,
      total,
      window: {
        days: query.days,
        since: query.since.toISOString(),
        until: query.untilExclusive.toISOString(),
      },
    };
  }

  async getSessionCorrelation(workspaceId: string, days = 30, scope?: SelfScope): Promise<IssueCostCorrelation[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const [feedback, sessions] = await Promise.all([
      this.prisma.mcpFeedback.findMany({
        where: {
          workspaceId,
          createdAt: { gte: since },
          sessionId: { not: null },
          ...(scope ? { userId: scope.userId } : {}),
        },
        select: { sessionId: true, perToolIssues: true },
      }),
      this.prisma.agentSession.findMany({
        where: {
          workspaceId,
          startedAt: { gte: since },
          ...(scope ? { userId: scope.userId } : {}),
          OR: [
            { lastEventNanos: { gt: 0 } },
            { activeTimeSec: { gt: 0 } },
            { tokensInput: { gt: 0 } },
            { tokensOutput: { gt: 0 } },
            { commitCount: { gt: 0 } },
          ],
        },
        select: { sessionId: true, tokensInput: true, tokensOutput: true, activeTimeSec: true },
      }),
    ]);
    const bySession = new Map(
      sessions.map((s) => [
        s.sessionId,
        { tokens: Number(s.tokensInput) + Number(s.tokensOutput), activeTimeSec: s.activeTimeSec },
      ]),
    );
    const allTokens = sessions.map((s) => Number(s.tokensInput) + Number(s.tokensOutput));
    const allActive = sessions.map((s) => s.activeTimeSec);

    const flagged = new Map<string, { tool: string; issueType: IssueType; sessionIds: Set<string> }>();
    for (const f of feedback) {
      for (const i of (f.perToolIssues as unknown as FeedbackToolIssue[]) ?? []) {
        const key = `${i.tool}::${i.issueType}`;
        const cur = flagged.get(key) ?? { tool: i.tool, issueType: i.issueType, sessionIds: new Set<string>() };
        if (f.sessionId) cur.sessionIds.add(f.sessionId);
        flagged.set(key, cur);
      }
    }
    return [...flagged.values()]
      .map(({ tool, issueType, sessionIds }) => {
        const stats = [...sessionIds].map((id) => bySession.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
        return {
          tool,
          issueType,
          flaggedSessionCount: stats.length,
          medianFlaggedTokens: median(stats.map((s) => s.tokens)),
          medianAllTokens: median(allTokens),
          medianFlaggedActiveTimeSec: median(stats.map((s) => s.activeTimeSec)),
          medianAllActiveTimeSec: median(allActive),
        };
      })
      .filter((c) => c.flaggedSessionCount > 0)
      .sort((a, b) => b.flaggedSessionCount - a.flaggedSessionCount);
  }
}
