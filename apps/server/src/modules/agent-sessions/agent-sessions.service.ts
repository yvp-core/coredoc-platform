import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { SelfScope } from '../../auth/self-scope.js';
import { aggregateLogRecords } from './otlp-parser.js';
import type { CoredocToolStat, SessionDelta, SessionLogRecords } from './otlp-parser.js';
import { GHOST_SESSION_EXCLUSION } from '../../libs/usage/ghost-session-exclusion.js';
import { isUniqueViolation, median } from '../../libs/coerce.js';

/**
 * Attempts a single session's log batch gets at the watermark compare-and-swap
 * before giving up. Contention is between concurrent exporter POSTs for ONE
 * session, so the realistic worst case is a handful of writers, not a herd.
 */
const LOG_BATCH_ATTEMPTS = 3;
const CLAUDE_PROVIDER = 'claude-code';

/**
 * Copy a stored JSON usage map onto a null-prototype object.
 *
 * Every key in these maps originates in an attacker-controllable OTLP attribute
 * (`tool_name`, skill name). On a plain object `map['__proto__']` reads through
 * to Object.prototype and writes hit its setter, so a merge that spreads stored
 * JSON into `{}` is one hostile key away from corrupting the process. A null
 * prototype makes every such key an ordinary data property.
 */
function intoNullProto<T>(stored: unknown): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [key, value] of Object.entries(stored as Record<string, T>)) out[key] = value;
  return out;
}

export interface SessionContextInput {
  repoKey?: string;
  branch?: string;
  issueKey?: string;
  prNumber?: number;
  headShaStart?: string;
  headShaEnd?: string;
}

export interface SegmentSummary {
  sessionCount: number;
  medianTokens: number | null;
  medianActiveTimeSec: number | null;
  medianCostUsd: number | null;
}

/**
 * Coredoc adoption + call quality across the window. Deliberately descriptive
 * (reach, who's using it, how the calls perform) — not a causal savings claim.
 */
export interface AdoptionSummary {
  sessionsUsingCoredoc: number;
  adoptionRate: number | null; // sessionsUsingCoredoc / sessionCount, null if no sessions
  usersUsingCoredoc: number;
  totalCoredocCalls: number;
  coredocErrorRate: number | null; // errors / calls, null if no calls
  avgCallLatencyMs: number | null; // totalDurationMs / calls, null if no calls
}

export interface SessionSummary {
  sessionCount: number;
  distinctUserCount: number;
  medianTokens: number | null;
  medianActiveTimeSec: number | null;
  medianCoredocToolCalls: number | null;
  coredocHeavy: SegmentSummary;
  coredocLight: SegmentSummary;
  adoption: AdoptionSummary;
}

/**
 * The self-scope WHERE fragment for agent_sessions: an exact match on user_id
 * (the server-derived coredoc principal id, stamped for both JWT and
 * service-token ingest), or `{}` for a workspace-wide caller. Null-userId
 * sessions can't match a member's id → they vanish from a member's view, which
 * is intentional (they can't be attributed).
 */
function selfScopeWhere(scope: SelfScope | undefined): Prisma.AgentSessionWhereInput {
  return scope ? { userId: scope.userId } : {};
}

@Injectable()
export class AgentSessionsService {
  private readonly logger = new Logger(AgentSessionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async applyMetricDeltas(workspaceId: string, deltas: SessionDelta[]): Promise<void> {
    let failed = 0;
    for (const d of deltas) {
      try {
        const existing = await this.prisma.agentSession.findUnique({
          where: {
            workspaceId_provider_sessionId: {
              workspaceId,
              provider: d.provider,
              sessionId: d.sessionId,
            },
          },
        });
        await this.prisma.agentSession.upsert({
          where: {
            workspaceId_provider_sessionId: {
              workspaceId,
              provider: d.provider,
              sessionId: d.sessionId,
            },
          },
          create: {
            workspaceId,
            provider: d.provider,
            sessionId: d.sessionId,
            userId: d.userId ?? null,
            userEmail: d.userEmail ?? null,
            model: d.model ?? null,
            appVersion: d.appVersion ?? null,
            activeTimeSec: d.activeTimeSec,
            commitCount: d.commitCount,
            prCount: d.prCount,
            locAdded: d.locAdded,
            locRemoved: d.locRemoved,
            tokensInput: d.tokensInput,
            tokensOutput: d.tokensOutput,
            tokensCacheRead: d.tokensCacheRead,
            tokensCacheCreation: d.tokensCacheCreation,
            tokensReasoning: d.tokensReasoning,
            costUsd: d.costUsd,
          },
          update: {
            userEmail: d.userEmail ?? undefined,
            model: d.model ?? undefined,
            appVersion: d.appVersion ?? undefined,
            activeTimeSec: Math.max(existing?.activeTimeSec ?? 0, d.activeTimeSec),
            commitCount: Math.max(existing?.commitCount ?? 0, d.commitCount),
            prCount: Math.max(existing?.prCount ?? 0, d.prCount),
            locAdded: Math.max(existing?.locAdded ?? 0, d.locAdded),
            locRemoved: Math.max(existing?.locRemoved ?? 0, d.locRemoved),
            // Token/cost columns have ONE owner at a time. The logs channel owns
            // them from its first counted batch (watermark > 0): its api_request
            // increments cover the same usage these cumulative sums do, so writing
            // both would double-count. Until then the metrics channel seeds them —
            // max-merge like the fields above, since CC session metrics are
            // cumulative/monotonic — which keeps metrics-only deployments correct.
            // applySessionLogBatch performs the matching one-time takeover.
            ...((existing?.lastEventNanos ?? 0n) > 0n
              ? {}
              : {
                  tokensInput: Math.max(Number(existing?.tokensInput ?? 0), d.tokensInput),
                  tokensOutput: Math.max(Number(existing?.tokensOutput ?? 0), d.tokensOutput),
                  tokensCacheRead: Math.max(Number(existing?.tokensCacheRead ?? 0), d.tokensCacheRead),
                  tokensCacheCreation: Math.max(Number(existing?.tokensCacheCreation ?? 0), d.tokensCacheCreation),
                  tokensReasoning: Math.max(Number(existing?.tokensReasoning ?? 0), d.tokensReasoning),
                  costUsd: Math.max(existing?.costUsd ?? 0, d.costUsd),
                }),
          },
        });
      } catch (err) {
        failed += 1;
        this.logger.error(`applyMetricDeltas failed for ${d.sessionId}: ${err}`);
      }
    }
    // Fail loud: a swallowed failure here answers the OTLP exporter with a success
    // envelope, so it drops its buffer and the data is lost permanently.
    if (failed > 0) throw new Error(`applyMetricDeltas: ${failed}/${deltas.length} session deltas failed to persist`);
  }

  async applyLogDeltas(workspaceId: string, batches: SessionLogRecords[]): Promise<void> {
    let failed = 0;
    for (const b of batches) {
      try {
        await this.applySessionLogBatch(workspaceId, b);
      } catch (err) {
        failed += 1;
        this.logger.error(`applyLogDeltas failed for ${b.sessionId}: ${err}`);
      }
    }
    if (failed > 0) throw new Error(`applyLogDeltas: ${failed}/${batches.length} session batches failed to persist`);
  }

  /**
   * Apply one session's log batch under a compare-and-swap on `lastEventNanos`.
   *
   * The replay filter reads the watermark and the write increments from it, so a
   * plain read-then-upsert is a lost update: two concurrent POSTs for one session
   * both read the same watermark, both judge the same records new, and both
   * increment — silently doubling tokens and cost, while the JSON maps (written
   * whole, not incremented) lose whichever write lands first.
   *
   * The conditional `updateMany` closes it: the row only moves if the watermark is
   * still the one the delta was computed against. A loser re-reads and re-aggregates
   * against the WINNER's watermark, which filters out exactly the records the winner
   * already counted — so the retry converges instead of re-adding them.
   */
  private async applySessionLogBatch(workspaceId: string, b: SessionLogRecords): Promise<void> {
    for (let attempt = 1; attempt <= LOG_BATCH_ATTEMPTS; attempt++) {
      const existing = await this.prisma.agentSession.findUnique({
        where: {
          workspaceId_provider_sessionId: {
            workspaceId,
            provider: b.provider,
            sessionId: b.sessionId,
          },
        },
      });
      // Per-record replay filter: only records strictly newer than the stored
      // watermark are aggregated, so an overlapping/retried export window can
      // never double-count the old records it re-sends.
      const d = aggregateLogRecords(b, existing?.lastEventNanos ?? -1n);
      if (existing && d.countedEvents === 0 && d.maxEventNanos <= existing.lastEventNanos) return;

      // Null-prototype and rebuilt key-by-key rather than spread into `{}`: the
      // tool key comes from the payload's `tool_name`, so `__proto__` on a plain
      // object either walks the prototype chain on read or hits the setter on
      // write. The parser mints these maps the same way (otlp-parser emptyDelta);
      // the STORED half arrives as parsed JSON and needs the same treatment.
      const mergedTools = intoNullProto<number>(existing?.coredocTools);
      for (const [tool, n] of Object.entries(d.coredocTools)) mergedTools[tool] = (mergedTools[tool] ?? 0) + n;

      const mergedStats = intoNullProto<CoredocToolStat>(existing?.coredocToolStats);
      for (const [tool, s] of Object.entries(d.coredocToolStats)) {
        const cur = mergedStats[tool] ?? { calls: 0, errors: 0, totalDurationMs: 0 };
        mergedStats[tool] = {
          calls: cur.calls + s.calls,
          errors: cur.errors + s.errors,
          totalDurationMs: cur.totalDurationMs + s.totalDurationMs,
        };
      }

      const mergedSkills = intoNullProto<number>(existing?.skillsUsed);
      for (const [skill, n] of Object.entries(d.skillsUsed)) {
        mergedSkills[skill] = (mergedSkills[skill] ?? 0) + n;
      }

      // Monotonic watermark — an out-of-order commit must never regress it and
      // re-open the replay window.
      const nextWatermark =
        existing && existing.lastEventNanos > d.maxEventNanos ? existing.lastEventNanos : d.maxEventNanos;

      if (!existing) {
        try {
          await this.prisma.agentSession.create({
            data: {
              workspaceId,
              provider: d.provider,
              sessionId: d.sessionId,
              userId: d.userId ?? null,
              userEmail: d.userEmail ?? null,
              model: d.model ?? null,
              appVersion: d.appVersion ?? null,
              tokensInput: d.tokensInput,
              tokensOutput: d.tokensOutput,
              tokensCacheRead: d.tokensCacheRead,
              tokensCacheCreation: d.tokensCacheCreation,
              tokensReasoning: d.tokensReasoning,
              costUsd: d.costUsd,
              coredocToolCalls: d.coredocToolCalls,
              coredocTools: mergedTools,
              coredocToolStats: mergedStats as unknown as Prisma.InputJsonValue,
              skillsUsed: mergedSkills,
              lastEventNanos: d.maxEventNanos,
            },
          });
          return;
        } catch (err) {
          // A concurrent batch created the row between our read and this insert.
          // Fall through to re-read it and take the update path against its
          // watermark; anything else is a real failure.
          if (!isUniqueViolation(err) || attempt === LOG_BATCH_ATTEMPTS) throw err;
          continue;
        }
      }

      const { count } = await this.prisma.agentSession.updateMany({
        // The compare-and-swap, keyed on `revision` and NOT on the watermark.
        // `lastEventNanos` looks like the natural swap key and is not one: a direct
        // workflow event carries no source time, so `nextWatermark` below is the
        // value already stored and the key would not move. Two writers would both
        // match it, and the second would overwrite the first's whole `skillsUsed`
        // map — losing exactly the routing/usage keys the workflow event wrote.
        // `revision` moves on every write, so it swaps in every case.
        where: {
          workspaceId,
          provider: d.provider,
          sessionId: d.sessionId,
          revision: existing.revision,
        },
        data: {
          revision: { increment: 1 },
          userId: d.userId ?? undefined,
          userEmail: d.userEmail ?? undefined,
          model: d.model ?? undefined,
          // Takeover of the token/cost columns from the metrics channel. Before the
          // first counted log batch (watermark still 0) the row may hold the metrics
          // channel's cumulative seed for the SAME usage this batch's increments
          // cover — incrementing on top would double-count. Reconcile the two
          // cumulative estimates with max once; afterwards the watermark is > 0,
          // applyMetricDeltas stops writing these columns, and plain increments are
          // correct. Records with unknown source time (0n) don't advance the
          // watermark, so a session fed only such records stays in max-reconcile —
          // preferring replay-safety over additivity, matching how the replay
          // filter already always re-counts them.
          ...(existing.lastEventNanos > 0n
            ? {
                tokensInput: { increment: d.tokensInput },
                tokensOutput: { increment: d.tokensOutput },
                tokensCacheRead: { increment: d.tokensCacheRead },
                tokensCacheCreation: { increment: d.tokensCacheCreation },
                tokensReasoning: { increment: d.tokensReasoning },
                costUsd: { increment: d.costUsd },
              }
            : {
                tokensInput: Math.max(Number(existing.tokensInput ?? 0), d.tokensInput),
                tokensOutput: Math.max(Number(existing.tokensOutput ?? 0), d.tokensOutput),
                tokensCacheRead: Math.max(Number(existing.tokensCacheRead ?? 0), d.tokensCacheRead),
                tokensCacheCreation: Math.max(Number(existing.tokensCacheCreation ?? 0), d.tokensCacheCreation),
                tokensReasoning: Math.max(Number(existing.tokensReasoning ?? 0), d.tokensReasoning),
                costUsd: Math.max(existing.costUsd ?? 0, d.costUsd),
              }),
          coredocToolCalls: { increment: d.coredocToolCalls },
          coredocTools: mergedTools,
          coredocToolStats: mergedStats as unknown as Prisma.InputJsonValue,
          skillsUsed: mergedSkills,
          lastEventNanos: nextWatermark,
        },
      });
      if (count === 1) return;
    }
    // Losing the swap every attempt means sustained contention on one session,
    // not a lost update — the caller's throw makes the exporter retry the window
    // rather than let it be silently dropped.
    throw new Error(
      `applySessionLogBatch: ${b.sessionId} lost the revision swap ${LOG_BATCH_ATTEMPTS} times under concurrent ingest`,
    );
  }

  /** Legacy Claude-only ROI rollup; provider-aware usage lives in the analytics usage read. */
  async getWorkspaceSessionSummary(workspaceId: string, days = 30, scope?: SelfScope): Promise<SessionSummary> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const rows = await this.prisma.agentSession.findMany({
      where: {
        workspaceId,
        provider: CLAUDE_PROVIDER,
        startedAt: { gte: since },
        OR: GHOST_SESSION_EXCLUSION,
        // Self-scope a member to their own sessions (by server-derived user_id).
        ...selfScopeWhere(scope),
      },
      select: {
        tokensInput: true,
        tokensOutput: true,
        activeTimeSec: true,
        coredocToolCalls: true,
        costUsd: true,
        userEmail: true,
        coredocToolStats: true,
      },
    });
    type Row = (typeof rows)[number];
    const segment = (rs: Row[]): SegmentSummary => ({
      sessionCount: rs.length,
      medianTokens: median(rs.map((r) => Number(r.tokensInput) + Number(r.tokensOutput))),
      medianActiveTimeSec: median(rs.map((r) => r.activeTimeSec)),
      medianCostUsd: median(rs.map((r) => r.costUsd)),
    });
    const heavy = rows.filter((r) => r.coredocToolCalls > 0);
    const light = rows.filter((r) => r.coredocToolCalls === 0);

    // Adoption: reach (who leans on coredoc) + call quality (calls/errors/latency)
    // aggregated across every tool in every session's coredocToolStats.
    let totalCalls = 0;
    let totalErrors = 0;
    let totalDurationMs = 0;
    for (const r of rows) {
      const stats = (r.coredocToolStats ?? {}) as unknown as Record<string, CoredocToolStat>;
      for (const s of Object.values(stats)) {
        totalCalls += s.calls;
        totalErrors += s.errors;
        totalDurationMs += s.totalDurationMs;
      }
    }
    const adoption: AdoptionSummary = {
      sessionsUsingCoredoc: heavy.length,
      adoptionRate: rows.length ? heavy.length / rows.length : null,
      usersUsingCoredoc: new Set(heavy.map((r) => r.userEmail).filter((e): e is string => !!e)).size,
      totalCoredocCalls: totalCalls,
      coredocErrorRate: totalCalls ? totalErrors / totalCalls : null,
      avgCallLatencyMs: totalCalls ? totalDurationMs / totalCalls : null,
    };

    return {
      sessionCount: rows.length,
      distinctUserCount: new Set(rows.map((r) => r.userEmail).filter((e): e is string => !!e)).size,
      medianTokens: median(rows.map((r) => Number(r.tokensInput) + Number(r.tokensOutput))),
      medianActiveTimeSec: median(rows.map((r) => r.activeTimeSec)),
      medianCoredocToolCalls: median(rows.map((r) => r.coredocToolCalls)),
      coredocHeavy: segment(heavy),
      coredocLight: segment(light),
      adoption,
    };
  }

  async applySessionContext(workspaceId: string, sessionId: string, ctx: SessionContextInput): Promise<void> {
    const data = {
      repoKey: ctx.repoKey,
      branch: ctx.branch,
      issueKey: ctx.issueKey,
      prNumber: ctx.prNumber,
      headShaStart: ctx.headShaStart,
      headShaEnd: ctx.headShaEnd,
    };
    await this.prisma.agentSession.upsert({
      where: {
        workspaceId_provider_sessionId: { workspaceId, provider: CLAUDE_PROVIDER, sessionId },
      },
      create: { workspaceId, provider: CLAUDE_PROVIDER, sessionId, ...data },
      update: data,
    });
  }
}
