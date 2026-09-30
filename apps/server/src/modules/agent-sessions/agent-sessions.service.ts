import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { SelfScope } from '../../auth/self-scope.js';
import { isCaptureHealthCode } from '../capture/capture-contract.js';
import type { CaptureHealthCode, CaptureProvisioningState } from '../capture/capture-contract.js';
import { aggregateLogRecords } from './otlp-parser.js';
import type { CoredocToolStat, SessionDelta, SessionLogRecords } from './otlp-parser.js';
import { GHOST_SESSION_EXCLUSION } from '../../libs/usage/ghost-session-exclusion.js';
import { PRICE_MAP_BASIS, PRICE_MAP_VERSION, estimateSessionCostUsd } from '../../libs/usage/session-pricing.js';
import {
  type WorkflowCompleteness,
  type WorkflowRunCompletenessBreakdown,
  foldWorkflowRunCompleteness,
  stalenessCutoff,
  workflowCompleteness,
} from '../../libs/usage/workflow-completeness.js';

/**
 * Attempts a single session's log batch gets at the watermark compare-and-swap
 * before giving up. Contention is between concurrent exporter POSTs for ONE
 * session, so the realistic worst case is a handful of writers, not a herd.
 */
const LOG_BATCH_ATTEMPTS = 3;
const CLAUDE_PROVIDER = 'claude-code';
const FINE_EVENT_POLICY_DAYS = 90 as const;
const CAPTURE_RETENTION_CHECKPOINT_ID = 'capture_fine_events';
/**
 * Caps `staleUnfinishedRuns` only — the OUT-OF-WINDOW unfinished runs this read adds beside the
 * windowed ones. Those carry no lower time bound (see the run query), so a workspace leaking
 * them would otherwise grow the payload without limit. It does not bound the payload: the
 * windowed rows stay uncapped, exactly as they always were. `workflowRunCompleteness` is
 * counted in the database over every unfinished run and stays exact under the cap, and
 * `omittedUnfinishedRuns` reports what the cap trimmed.
 */
const MAX_UNFINISHED_RUN_ROWS = 200;

/** Prisma's unique-constraint violation, i.e. someone else inserted the row first. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
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

/** One per-user rollup row in the by-user breakdown. */
export interface UserSessionsSummary {
  userId: string | null;
  userEmail: string | null;
  sessions: number;
  tokens: number;
  costUsd: number;
  coredocCalls: number;
  topTool: string | null;
  lastActiveAt: string | null;
}

export type ActivityProvider = 'claude-code' | 'codex';

export interface ActivityCaptureHealth {
  actorId: string;
  // Human display name for `actorId`, resolved via the workspace member table
  // (actorId is the server-derived coredoc principal user_id — the same key
  // space `selfScopeWhere`/`actorWhere` filter on). Null when no member row
  // matches (e.g. the actor left the workspace) — the renderer falls back to
  // the raw id.
  actorName: string | null;
  host: ActivityProvider;
  targetKey: string;
  repositoryKey: string | null;
  configurationState: CaptureProvisioningState;
  errorState: CaptureHealthCode | null;
  pendingCount: number;
  configuredAt: string | null;
  disabledAt: string | null;
  reportedAt: string;
  nativeCoverage: 'observed' | 'unavailable';
  capabilityCoverage: 'available' | 'unavailable';
  lastSeenAt: string | null;
  nativeLastSeenAt: string | null;
  workflowLastSeenAt: string | null;
  attributionPendingCount: number;
  attributionRejectedCount: number;
  attributionLastClaimAt: string | null;
}

/**
 * Cost-marker semantics for a session (S2): distinguishes "no usage telemetry
 * at all" from "usage observed but the model has no price entry" so the
 * renderer never shows a bare "Unavailable" for a session it can otherwise
 * account for. `estimated` covers every case `estimateSessionCostUsd` prices,
 * including a null aggregate above a long-context base tier folding into
 * `unpriced_model` — the reason differs (unknown model vs. unpriceable
 * aggregate) but the marker is the same because neither can render a number.
 */
export type ActivityCostCoverage = 'estimated' | 'unpriced_model' | 'unavailable';

export interface ActivitySession {
  provider: ActivityProvider;
  sessionId: string;
  userId: string | null;
  userEmail: string | null;
  model: string | null;
  appVersion: string | null;
  usageCoverage: 'observed' | 'unavailable';
  costCoverage: ActivityCostCoverage;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensCacheRead: number | null;
  tokensCacheCreation: number | null;
  tokensReasoning: number | null;
  estimatedCostUsd: number | null;
  activeTimeSec: number | null;
  startedAt: string;
}

/**
 * One row of the per-user activity rollup (S6): sessions/tokens/cost/MCP
 * calls for a distinct session user in the window, computed server-side over
 * the full window query — never derived from a capped/limited session list
 * (A5).
 */
export interface ActivityUserRollup {
  userId: string | null;
  userEmail: string | null;
  sessions: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  /** Sum over sessions with `costCoverage: 'estimated'`; null when none. */
  estimatedCostUsd: number | null;
  /** Sessions with observed usage but no price ('unpriced_model'). */
  unpricedSessions: number;
  mcpCalls: number;
}

export interface ActivityMcpTool {
  tool: string;
  calls: number;
  errors: number;
  avgDurationMs: number | null;
}

export interface ActivityCapability {
  host: ActivityProvider;
  kind: 'skill' | 'agent';
  capabilityId: string;
  uses: number;
  outcomes: Record<'success' | 'failed' | 'blocked' | 'abandoned' | 'unknown', number>;
  lastUsedAt: string;
}

export interface ActivityWorkflowRun {
  runId: string;
  actorId: string;
  workflowId: string | null;
  intent: string | null;
  risk: string | null;
  scale: string | null;
  repositoryKey: string | null;
  taskId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Null unless both ends are observed, so an unfinished run contributes no duration. */
  durationMs: number | null;
  outcome: string | null;
  /**
   * Read-side completeness: `incomplete` is a run whose `workflow.run.finished` never arrived
   * within the staleness window; `in_progress` is a younger unfinished run that may still finish.
   */
  status: WorkflowCompleteness;
  workItems: ActivityWorkflowWorkItem[];
}

export interface ActivityWorkflowWorkItem {
  provider: string;
  externalId: string;
  externalKey: string | null;
  linked: boolean;
}

export interface ActivityFineEventCoverage {
  requestedDays: number;
  policyDays: 90;
  status: 'complete' | 'partial';
  purgedThroughReceivedAt: string | null;
}

export interface WorkspaceActivityResponse {
  priceMap: { version: string; basis: string };
  fineEventCoverage: ActivityFineEventCoverage;
  captureHealth: ActivityCaptureHealth[];
  sessions: ActivitySession[];
  byUser: ActivityUserRollup[];
  mcpTools: ActivityMcpTool[];
  capabilities: ActivityCapability[];
  /**
   * Runs touching the requested window, exactly as every other list in this read is
   * window-bounded. Each row carries its own `status`, so an unfinished run that started inside
   * the window is visible here; older unfinished runs live in `staleUnfinishedRuns` instead of
   * silently widening this array's window.
   */
  workflowRuns: ActivityWorkflowRun[];
  /**
   * Unfinished runs from BEFORE the window, newest first and capped — the runs an incomplete
   * count would otherwise point at with nothing to show. Disjoint from `workflowRuns` by runId.
   */
  staleUnfinishedRuns: ActivityWorkflowRun[];
  /**
   * Outcome breakdown with the unfinished runs counted apart from it. `byOutcome` is
   * window-bounded like `workflowRuns`; `incomplete` and `inProgress` are not — they are counted
   * in the database across every unfinished run, because an unfinished run older than the
   * requested window is exactly the run the reader needs to know about.
   */
  workflowRunCompleteness: WorkflowRunCompletenessBreakdown;
  /**
   * Unfinished runs neither array lists, because the `staleUnfinishedRuns` cap trimmed them.
   * Zero means the two arrays show every unfinished run; the counters above are exact either way.
   */
  omittedUnfinishedRuns: number;
}

// Returns null (not 0) for an empty set so callers can render "no data" instead of a
// misleading $0/0-token median — e.g. an empty coredoc segment in the ROI dashboard.
function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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

const CAPABILITY_KINDS = new Set(['skill', 'agent']);
const CAPABILITY_OUTCOMES = ['success', 'failed', 'blocked', 'abandoned', 'unknown'] as const;
const CAPABILITY_OUTCOME_SET = new Set<string>(CAPABILITY_OUTCOMES);
const CAPABILITY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;

function activityProvider(value: string): value is ActivityProvider {
  return value === 'claude-code' || value === 'codex';
}

function actorHostKey(actorId: string, host: string): string {
  return JSON.stringify([actorId, host]);
}

function actorHostRepositoryKey(actorId: string, host: string, repositoryKey: string | null): string {
  return JSON.stringify([actorId, host, repositoryKey]);
}

function setNewest(map: Map<string, Date>, key: string, value: Date | null): void {
  if (!value) return;
  const current = map.get(key);
  if (!current || value > current) map.set(key, value);
}

function nanosToIso(value: bigint | null): string | null {
  if (value === null || value <= 0n) return null;
  const millis = value / 1_000_000n;
  if (millis <= 0n || millis > 8_640_000_000_000_000n) return null;
  const date = new Date(Number(millis));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

  /** Legacy Claude-only ROI rollup; provider-aware usage lives in `getWorkspaceActivity`. */
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

  /**
   * Legacy Claude-only per-user rollup for the window: agent_sessions grouped by
   * (userId, userEmail) with the same ghost-session filter as the summary.
   * `topTool` is the highest-count key across the per-session `coredocTools`
   * JSON maps (null when the user made no coredoc calls); sessions with a
   * null userId land in a null-user bucket the UI renders as "unattributed".
   * Sorted by costUsd desc.
   */
  async getWorkspaceSessionsByUser(
    workspaceId: string,
    days = 30,
    scope?: SelfScope,
  ): Promise<{ users: UserSessionsSummary[] }> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const inWindow: Prisma.AgentSessionWhereInput = {
      workspaceId,
      provider: CLAUDE_PROVIDER,
      startedAt: { gte: since },
      OR: GHOST_SESSION_EXCLUSION,
      // Self-scope a member to their own sessions (by server-derived user_id).
      // A member gets at most their own row.
      ...selfScopeWhere(scope),
    };

    const groups = await this.prisma.agentSession.groupBy({
      by: ['userId', 'userEmail'],
      where: inWindow,
      _count: { _all: true },
      _sum: { tokensInput: true, tokensOutput: true, costUsd: true, coredocToolCalls: true },
      _max: { startedAt: true },
    });

    // topTool needs the per-session coredocTools JSON maps — merged in TS
    // (small row counts; only sessions that actually made coredoc calls).
    const toolRows = await this.prisma.agentSession.findMany({
      where: { ...inWindow, coredocToolCalls: { gt: 0 } },
      select: { userId: true, userEmail: true, coredocTools: true },
    });
    const userKey = (userId: string | null, userEmail: string | null) => JSON.stringify([userId, userEmail]);
    const toolsByUser = new Map<string, Record<string, number>>();
    for (const row of toolRows) {
      const key = userKey(row.userId, row.userEmail);
      const merged = toolsByUser.get(key) ?? {};
      for (const [tool, n] of Object.entries((row.coredocTools ?? {}) as Record<string, number>)) {
        merged[tool] = (merged[tool] ?? 0) + n;
      }
      toolsByUser.set(key, merged);
    }
    const topToolOf = (key: string): string | null => {
      let top: string | null = null;
      let topCount = 0;
      for (const [tool, n] of Object.entries(toolsByUser.get(key) ?? {})) {
        if (n > topCount) {
          top = tool;
          topCount = n;
        }
      }
      return top;
    };

    const users = groups
      .map((g) => ({
        userId: g.userId,
        userEmail: g.userEmail,
        sessions: g._count._all,
        tokens: Number(g._sum.tokensInput ?? 0) + Number(g._sum.tokensOutput ?? 0),
        costUsd: g._sum.costUsd ?? 0,
        coredocCalls: g._sum.coredocToolCalls ?? 0,
        topTool: topToolOf(userKey(g.userId, g.userEmail)),
        lastActiveAt: g._max.startedAt?.toISOString() ?? null,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);

    return { users };
  }

  async getWorkspaceActivity(workspaceId: string, days = 30, scope?: SelfScope): Promise<WorkspaceActivityResponse> {
    const now = new Date();
    const since = new Date(now);
    since.setDate(since.getDate() - days);
    const actorWhere = scope ? { actorId: scope.userId } : {};
    // Shared by the run reads below: an unfinished run older than this is `incomplete`. `lt`,
    // not `lte` — see `stalenessCutoff`, whose test pins it against `workflowCompleteness`.
    const cutoff = stalenessCutoff(now);
    const unfinishedWhere = { workspaceId, ...actorWhere, finishedAt: null };
    const runRowSelect = {
      runId: true,
      actorId: true,
      workflowId: true,
      intent: true,
      risk: true,
      scale: true,
      repositoryKey: true,
      taskId: true,
      startedAt: true,
      finishedAt: true,
      outcome: true,
      createdAt: true,
      workItems: {
        orderBy: [{ provider: 'asc' }, { externalId: 'asc' }],
        select: { provider: true, externalId: true, externalKey: true },
      },
    } satisfies Prisma.WorkflowRunSelect;

    const [
      sessionRows,
      eventRows,
      [windowedRunRows, staleRunRowCandidates, incompleteCount, unfinishedTotal],
      provisioningRows,
      nativeCoverageRows,
      captureHealthRows,
      workflowHealthRows,
      acceptedWatermarkRows,
      retentionCheckpoint,
      memberRows,
      mcpCallRows,
    ] = await Promise.all([
      this.prisma.agentSession.findMany({
        where: { workspaceId, startedAt: { gte: since }, ...selfScopeWhere(scope) },
        select: {
          provider: true,
          sessionId: true,
          userId: true,
          userEmail: true,
          model: true,
          appVersion: true,
          tokensInput: true,
          tokensOutput: true,
          tokensCacheRead: true,
          tokensCacheCreation: true,
          tokensReasoning: true,
          activeTimeSec: true,
          coredocToolStats: true,
          startedAt: true,
        },
      }),
      this.prisma.captureEvent.findMany({
        where: { workspaceId, receivedAt: { gte: since }, ...actorWhere },
        select: { host: true, type: true, occurredAt: true, receivedAt: true, data: true },
      }),
      // The four run reads are ONE snapshot: the arrays and the counts disagree about which
      // runs are unfinished if a run finishes between them, which is how a listed row used to
      // be double-counted or reported as trimmed.
      this.prisma.$transaction(
        [
          this.prisma.workflowRun.findMany({
            where: {
              workspaceId,
              ...actorWhere,
              OR: [{ startedAt: { gte: since } }, { finishedAt: { gte: since } }, { createdAt: { gte: since } }],
            },
            select: runRowSelect,
          }),
          // An incomplete run is older than the staleness window by definition, so any window
          // shorter than that would filter every one of them out before it could be listed.
          // Unfinished runs therefore carry no lower time bound — an unreconciled run does not
          // stop being one because the reader asked for 7 days — but the rows are capped.
          this.prisma.workflowRun.findMany({
            where: unfinishedWhere,
            // runId breaks createdAt ties so the cap keeps the same rows on every call.
            orderBy: [{ createdAt: 'desc' }, { runId: 'desc' }],
            take: MAX_UNFINISHED_RUN_ROWS,
            select: runRowSelect,
          }),
          // Counted in the database rather than by projecting every unfinished run into memory:
          // the projection was unbounded, so a workspace leaking runs paid for all of them on
          // every activity read. A run row can predate its own `workflow.run.started` (a stage
          // event created it), so the clock falls back to `createdAt` exactly as the TS rule does.
          this.prisma.workflowRun.count({
            where: {
              ...unfinishedWhere,
              OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }],
            },
          }),
          this.prisma.workflowRun.count({ where: unfinishedWhere }),
        ],
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
      this.prisma.captureProvisioning.findMany({
        where: { workspaceId, ...actorWhere },
        select: {
          actorId: true,
          host: true,
          targetKey: true,
          repositoryKey: true,
          state: true,
          configuredAt: true,
          disabledAt: true,
          reportedAt: true,
          pendingCount: true,
          errorCode: true,
          attributionPendingCount: true,
          attributionRejectedCount: true,
          attributionLastClaimAt: true,
        },
        orderBy: [{ actorId: 'asc' }, { host: 'asc' }, { targetKey: 'asc' }],
      }),
      this.prisma.agentSession.groupBy({
        by: ['userId', 'provider'],
        where: {
          workspaceId,
          ...selfScopeWhere(scope),
          OR: [
            { tokensInput: { gt: 0 } },
            { tokensOutput: { gt: 0 } },
            { tokensCacheRead: { gt: 0 } },
            { tokensCacheCreation: { gt: 0 } },
            { tokensReasoning: { gt: 0 } },
          ],
        },
        _max: { lastEventNanos: true },
      }),
      this.prisma.captureEvent.groupBy({
        by: ['actorId', 'host', 'repositoryKey'],
        where: { workspaceId, ...actorWhere },
        _max: { receivedAt: true },
      }),
      this.prisma.captureEvent.groupBy({
        by: ['actorId', 'host', 'repositoryKey'],
        where: {
          workspaceId,
          ...actorWhere,
          type: { not: 'capability.used' },
        },
        _max: { receivedAt: true },
      }),
      this.prisma.captureAcceptedWatermark.findMany({
        where: { workspaceId, ...actorWhere },
        select: {
          actorId: true,
          host: true,
          scopeKey: true,
          repositoryKey: true,
          lastAcceptedAt: true,
          workflowLastAcceptedAt: true,
        },
      }),
      this.prisma.captureRetentionCheckpoint.findUnique({
        where: { id: CAPTURE_RETENTION_CHECKPOINT_ID },
        select: { purgedThroughReceivedAt: true },
      }),
      // S10: actorId is the server-derived coredoc principal user_id (the same
      // key space `selfScopeWhere` matches on), so the member table is a
      // direct join — no separate actor-identity graph involved.
      this.prisma.workspaceMember.findMany({
        where: { workspaceId, ...(scope ? { userId: scope.userId } : {}) },
        select: { userId: true, email: true, displayName: true },
      }),
      // S6: MCP call counts per user for the window, aggregated independently
      // of the session rows so it stays correct even if a future cap is added
      // to the sessions query.
      this.prisma.mcpQueryMetric.groupBy({
        by: ['userId'],
        where: {
          workspaceId,
          queriedAt: { gte: since },
          ...(scope ? { userId: scope.userId } : {}),
        },
        _count: { _all: true },
      }),
    ]);

    const sessions: ActivitySession[] = sessionRows
      .filter((row): row is (typeof sessionRows)[number] & { provider: ActivityProvider } =>
        activityProvider(row.provider),
      )
      .map((row) => {
        const usageObserved =
          row.tokensInput > 0 ||
          row.tokensOutput > 0 ||
          row.tokensCacheRead > 0 ||
          row.tokensCacheCreation > 0 ||
          row.tokensReasoning > 0;
        const usage = usageObserved
          ? {
              input: Number(row.tokensInput),
              output: Number(row.tokensOutput),
              cacheRead: Number(row.tokensCacheRead),
              cacheCreation: Number(row.tokensCacheCreation),
              reasoning: Number(row.tokensReasoning),
            }
          : null;
        const estimatedCostUsd = usage ? estimateSessionCostUsd(row.provider, row.model ?? '', usage) : null;
        // S2: usage observed but no price → 'unpriced_model' (covers both an
        // absent price-map entry and a priced model whose aggregate exceeds
        // its long-context base tier — estimateSessionCostUsd returns null
        // for both, and neither can render a number, so they share the marker).
        const costCoverage: ActivityCostCoverage = !usageObserved
          ? 'unavailable'
          : estimatedCostUsd !== null
            ? 'estimated'
            : 'unpriced_model';
        return {
          provider: row.provider,
          sessionId: row.sessionId,
          userId: row.userId,
          userEmail: row.userEmail,
          model: row.model,
          appVersion: row.appVersion,
          usageCoverage: usageObserved ? 'observed' : 'unavailable',
          costCoverage,
          tokensInput: usage?.input ?? null,
          tokensOutput: usage?.output ?? null,
          tokensCacheRead: usage?.cacheRead ?? null,
          tokensCacheCreation: usage?.cacheCreation ?? null,
          // Claude's supported native shapes do not expose reasoning tokens;
          // its durable zero is a schema default, not an observed fact.
          tokensReasoning: row.provider === 'codex' ? (usage?.reasoning ?? null) : null,
          estimatedCostUsd,
          activeTimeSec: row.activeTimeSec > 0 ? row.activeTimeSec : null,
          startedAt: row.startedAt.toISOString(),
        } satisfies ActivitySession;
      })
      .sort(
        (left, right) => left.provider.localeCompare(right.provider) || left.sessionId.localeCompare(right.sessionId),
      );

    // S6/A5: derived from `sessions` above, which the `agentSession.findMany`
    // that built it fetches with no `take`/limit — so this rollup already
    // covers the FULL window population, not whatever the response happens to
    // cap for display. mcpCalls comes from an independent groupBy query
    // (mcpQueryMetric has no per-session join, only a workspace+user+time one).
    const userRollups = new Map<string, ActivityUserRollup>();
    for (const s of sessions) {
      // Group by userId when one exists (an email change must not split a user in
      // two — mcpQueryMetric only carries userId, and two rows sharing one userId
      // would each receive that user's FULL mcp count); sessions without a userId
      // group by email so unattributed ingest stays visible without merging.
      const key = s.userId !== null ? `id:${s.userId}` : `email:${s.userEmail ?? ''}`;
      const row = userRollups.get(key) ?? {
        userId: s.userId,
        userEmail: s.userEmail,
        sessions: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        estimatedCostUsd: null,
        unpricedSessions: 0,
        mcpCalls: 0,
      };
      row.sessions += 1;
      row.tokensInput += s.tokensInput ?? 0;
      row.tokensOutput += s.tokensOutput ?? 0;
      row.tokensCacheRead += s.tokensCacheRead ?? 0;
      row.tokensCacheCreation += s.tokensCacheCreation ?? 0;
      if (s.costCoverage === 'estimated' && s.estimatedCostUsd !== null) {
        row.estimatedCostUsd = (row.estimatedCostUsd ?? 0) + s.estimatedCostUsd;
      }
      if (s.costCoverage === 'unpriced_model') row.unpricedSessions += 1;
      userRollups.set(key, row);
    }
    const mcpCallsByUserId = new Map<string | null, number>();
    for (const row of mcpCallRows) mcpCallsByUserId.set(row.userId, row._count._all);
    // Attribute mcp calls only to userId-keyed rows: metric rows with a null
    // userId are unattributable to a specific email-keyed group, and assigning
    // them to every null-userId row would double-count.
    for (const row of userRollups.values()) {
      row.mcpCalls = row.userId !== null ? (mcpCallsByUserId.get(row.userId) ?? 0) : 0;
    }
    // A member can query MCP in the window without opening a single agent session
    // (an editor with the MCP server attached and no capture hook). Building rows from
    // sessions alone would drop that member — and their calls — out of "By member"
    // entirely, so union the mcp user ids in. Session facts are genuinely 0 for such a
    // row, while cost stays null: nothing was priced, and 0.00 would read as measured.
    const memberEmailByUserId = new Map<string, string | null>();
    for (const m of memberRows) memberEmailByUserId.set(m.userId, m.email ?? null);
    for (const [userId, calls] of mcpCallsByUserId) {
      if (userId === null || calls === 0) continue;
      const key = `id:${userId}`;
      if (userRollups.has(key)) continue;
      userRollups.set(key, {
        userId,
        userEmail: memberEmailByUserId.get(userId) ?? null,
        sessions: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        estimatedCostUsd: null,
        unpricedSessions: 0,
        mcpCalls: calls,
      });
    }
    const byUser: ActivityUserRollup[] = [...userRollups.values()].sort(
      (left, right) =>
        (right.estimatedCostUsd ?? -1) - (left.estimatedCostUsd ?? -1) ||
        (left.userEmail ?? '').localeCompare(right.userEmail ?? ''),
    );

    // S10: actorId is the coredoc principal user_id, so this is a direct
    // lookup — displayName wins, email is the fallback, and an actorId with
    // no member row (e.g. a departed member) stays null for the renderer's
    // raw-id fallback.
    const memberNameByUserId = new Map<string, string | null>();
    for (const m of memberRows) memberNameByUserId.set(m.userId, m.displayName ?? m.email ?? null);

    const mcp = new Map<string, { calls: number; errors: number; totalDurationMs: number }>();
    for (const row of sessionRows) {
      if (!row.coredocToolStats || typeof row.coredocToolStats !== 'object' || Array.isArray(row.coredocToolStats)) {
        continue;
      }
      for (const [tool, raw] of Object.entries(row.coredocToolStats as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const stat = raw as Record<string, unknown>;
        if (
          !nonNegativeInteger(stat.calls) ||
          !nonNegativeInteger(stat.errors) ||
          stat.errors > stat.calls ||
          typeof stat.totalDurationMs !== 'number' ||
          !Number.isFinite(stat.totalDurationMs) ||
          stat.totalDurationMs < 0
        ) {
          continue;
        }
        const current = mcp.get(tool) ?? { calls: 0, errors: 0, totalDurationMs: 0 };
        current.calls += stat.calls;
        current.errors += stat.errors;
        current.totalDurationMs += stat.totalDurationMs;
        mcp.set(tool, current);
      }
    }
    const mcpTools: ActivityMcpTool[] = [...mcp.entries()]
      .map(([tool, stat]) => ({
        tool,
        calls: stat.calls,
        errors: stat.errors,
        avgDurationMs: stat.calls > 0 ? stat.totalDurationMs / stat.calls : null,
      }))
      .sort((left, right) => left.tool.localeCompare(right.tool));

    const capabilityMap = new Map<string, ActivityCapability>();
    for (const row of eventRows) {
      if (row.type !== 'capability.used' || row.host !== 'claude-code') continue;
      if (!row.data || typeof row.data !== 'object' || Array.isArray(row.data)) continue;
      const data = row.data as Record<string, unknown>;
      if (
        typeof data.kind !== 'string' ||
        !CAPABILITY_KINDS.has(data.kind) ||
        typeof data.capabilityId !== 'string' ||
        !CAPABILITY_ID_RE.test(data.capabilityId) ||
        typeof data.outcome !== 'string' ||
        !CAPABILITY_OUTCOME_SET.has(data.outcome)
      ) {
        continue;
      }
      const key = JSON.stringify([row.host, data.kind, data.capabilityId]);
      const current = capabilityMap.get(key) ?? {
        host: row.host,
        kind: data.kind as 'skill' | 'agent',
        capabilityId: data.capabilityId,
        uses: 0,
        outcomes: { success: 0, failed: 0, blocked: 0, abandoned: 0, unknown: 0 },
        lastUsedAt: row.occurredAt.toISOString(),
      };
      current.uses += 1;
      current.outcomes[data.outcome as keyof typeof current.outcomes] += 1;
      if (row.occurredAt.toISOString() > current.lastUsedAt) current.lastUsedAt = row.occurredAt.toISOString();
      capabilityMap.set(key, current);
    }
    const capabilities = [...capabilityMap.values()].sort(
      (left, right) =>
        left.host.localeCompare(right.host) ||
        left.kind.localeCompare(right.kind) ||
        left.capabilityId.localeCompare(right.capabilityId),
    );

    // The capped unfinished read has no lower bound, so it re-reports every unfinished run the
    // windowed read already returned. Those belong to `workflowRuns`; what is left is the
    // out-of-window remainder, which keeps `workflowRuns` window-bounded like the rest of the read.
    const windowedRunIds = new Set(windowedRunRows.map((row) => row.runId));
    const staleRunRows = staleRunRowCandidates.filter((row) => !windowedRunIds.has(row.runId));
    const runRows = [...windowedRunRows, ...staleRunRows];

    const linkedWorkItems = new Set<string>();
    const identities = new Map<string, { provider: string; externalId: string }>();
    for (const run of runRows) {
      for (const item of run.workItems) {
        identities.set(`${item.provider}\u0000${item.externalId}`, {
          provider: item.provider,
          externalId: item.externalId,
        });
      }
    }
    const identityRows = [...identities.values()];
    for (let offset = 0; offset < identityRows.length; offset += 200) {
      const refs = await this.prisma.taskExternalRef.findMany({
        where: { workspaceId, OR: identityRows.slice(offset, offset + 200) },
        select: { provider: true, externalId: true },
      });
      for (const ref of refs) linkedWorkItems.add(`${ref.provider}\u0000${ref.externalId}`);
    }

    // `byOutcome` is folded over the windowed FINISHED rows, so it stays a window metric; the
    // two unfinished counters come from the database counts, so they stay exact over every
    // unfinished run however few this read lists.
    const workflowRunCompleteness: WorkflowRunCompletenessBreakdown = {
      byOutcome: foldWorkflowRunCompleteness(
        windowedRunRows
          .filter((row) => row.finishedAt !== null)
          .map((row) => ({
            startedAt: row.startedAt ?? row.createdAt,
            finishedAt: row.finishedAt,
            outcome: row.outcome,
          })),
        now,
      ).byOutcome,
      incomplete: incompleteCount,
      // Both counts come from the same snapshot, so this cannot go negative; clamped anyway
      // rather than letting a future non-transactional read publish a negative counter.
      inProgress: Math.max(0, unfinishedTotal - incompleteCount),
    };
    // What the cap dropped: every unfinished run, less the ones the two arrays actually list.
    const listedUnfinishedRuns = windowedRunRows.filter((row) => row.finishedAt === null).length + staleRunRows.length;
    const omittedUnfinishedRuns = Math.max(0, unfinishedTotal - listedUnfinishedRuns);

    const projectRun = (row: (typeof runRows)[number]): ActivityWorkflowRun => {
      const durationMs =
        row.startedAt && row.finishedAt && row.finishedAt >= row.startedAt
          ? row.finishedAt.getTime() - row.startedAt.getTime()
          : null;
      return {
        runId: row.runId,
        actorId: row.actorId,
        workflowId: row.workflowId,
        intent: row.intent,
        risk: row.risk,
        scale: row.scale,
        repositoryKey: row.repositoryKey,
        taskId: row.taskId,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        durationMs,
        outcome: row.outcome,
        status: workflowCompleteness(row.startedAt ?? row.createdAt, row.finishedAt, now),
        workItems: row.workItems.map((item) => ({
          ...item,
          linked: linkedWorkItems.has(`${item.provider}\u0000${item.externalId}`),
        })),
      };
    };
    const byRunId = (left: ActivityWorkflowRun, right: ActivityWorkflowRun) => left.runId.localeCompare(right.runId);
    const workflowRuns: ActivityWorkflowRun[] = windowedRunRows.map(projectRun).sort(byRunId);
    const staleUnfinishedRuns: ActivityWorkflowRun[] = staleRunRows.map(projectRun).sort(byRunId);

    const nativeByActorHost = new Map<string, { observed: true; lastSeenAt: string | null }>();
    for (const row of nativeCoverageRows) {
      if (row.userId === null || !activityProvider(row.provider)) continue;
      nativeByActorHost.set(actorHostKey(row.userId, row.provider), {
        observed: true,
        lastSeenAt: nanosToIso(row._max.lastEventNanos),
      });
    }

    const captureByActorHost = new Map<string, Date>();
    const captureByRepository = new Map<string, Date>();
    for (const row of captureHealthRows) {
      setNewest(captureByActorHost, actorHostKey(row.actorId, row.host), row._max.receivedAt);
      setNewest(
        captureByRepository,
        actorHostRepositoryKey(row.actorId, row.host, row.repositoryKey),
        row._max.receivedAt,
      );
    }
    const workflowByActorHost = new Map<string, Date>();
    const workflowByRepository = new Map<string, Date>();
    for (const row of workflowHealthRows) {
      setNewest(workflowByActorHost, actorHostKey(row.actorId, row.host), row._max.receivedAt);
      setNewest(
        workflowByRepository,
        actorHostRepositoryKey(row.actorId, row.host, row.repositoryKey),
        row._max.receivedAt,
      );
    }
    for (const row of acceptedWatermarkRows) {
      if (row.repositoryKey !== null && row.scopeKey === `repo:${row.repositoryKey}`) {
        const key = actorHostRepositoryKey(row.actorId, row.host, row.repositoryKey);
        setNewest(captureByRepository, key, row.lastAcceptedAt);
        setNewest(workflowByRepository, key, row.workflowLastAcceptedAt);
      } else if (row.host === 'codex' && row.repositoryKey === null && row.scopeKey === 'profile') {
        const key = actorHostKey(row.actorId, row.host);
        setNewest(captureByActorHost, key, row.lastAcceptedAt);
        setNewest(workflowByActorHost, key, row.workflowLastAcceptedAt);
      }
    }

    const captureHealth: ActivityCaptureHealth[] = provisioningRows
      .filter((row) => {
        if (!activityProvider(row.host) || (row.state !== 'configured' && row.state !== 'disabled')) return false;
        if (row.errorCode !== null && !isCaptureHealthCode(row.errorCode)) return false;
        if (!nonNegativeInteger(row.pendingCount) || row.pendingCount > 1_000_000) return false;
        if (row.state === 'disabled' && (row.pendingCount !== 0 || row.errorCode !== null)) return false;
        return row.repositoryKey !== null;
      })
      .map((row) => {
        const host = row.host as ActivityProvider;
        const state = row.state as CaptureProvisioningState;
        const hostKey = actorHostKey(row.actorId, host);
        const repositoryKey = actorHostRepositoryKey(row.actorId, host, row.repositoryKey);
        const captureDate = captureByRepository.get(repositoryKey) ?? null;
        const workflowDate = workflowByRepository.get(repositoryKey) ?? null;
        const native = nativeByActorHost.get(hostKey);
        return {
          actorId: row.actorId,
          actorName: memberNameByUserId.get(row.actorId) ?? null,
          host,
          targetKey: row.targetKey,
          repositoryKey: row.repositoryKey,
          configurationState: state,
          errorState: row.errorCode as CaptureHealthCode | null,
          pendingCount: row.pendingCount,
          configuredAt: row.configuredAt?.toISOString() ?? null,
          disabledAt: row.disabledAt?.toISOString() ?? null,
          reportedAt: row.reportedAt.toISOString(),
          nativeCoverage: native ? 'observed' : 'unavailable',
          capabilityCoverage: host === 'claude-code' ? 'available' : 'unavailable',
          lastSeenAt: captureDate?.toISOString() ?? null,
          nativeLastSeenAt: native?.lastSeenAt ?? null,
          workflowLastSeenAt: workflowDate?.toISOString() ?? null,
          attributionPendingCount: row.attributionPendingCount ?? 0,
          attributionRejectedCount: row.attributionRejectedCount ?? 0,
          attributionLastClaimAt: row.attributionLastClaimAt?.toISOString() ?? null,
        } satisfies ActivityCaptureHealth;
      })
      .sort(
        (left, right) =>
          left.actorId.localeCompare(right.actorId) ||
          left.host.localeCompare(right.host) ||
          left.targetKey.localeCompare(right.targetKey),
      );

    const purgedThroughReceivedAt = retentionCheckpoint?.purgedThroughReceivedAt ?? null;
    const fineEventCoverage: ActivityFineEventCoverage = {
      requestedDays: days,
      policyDays: FINE_EVENT_POLICY_DAYS,
      status:
        days <= FINE_EVENT_POLICY_DAYS &&
        (purgedThroughReceivedAt === null || purgedThroughReceivedAt.getTime() <= since.getTime())
          ? 'complete'
          : 'partial',
      purgedThroughReceivedAt: purgedThroughReceivedAt?.toISOString() ?? null,
    };

    return {
      priceMap: { version: PRICE_MAP_VERSION, basis: PRICE_MAP_BASIS },
      fineEventCoverage,
      captureHealth,
      sessions,
      byUser,
      mcpTools,
      capabilities,
      workflowRuns,
      staleUnfinishedRuns,
      workflowRunCompleteness,
      omittedUnfinishedRuns,
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
