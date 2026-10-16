import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { estimateSessionCostUsd } from '../../libs/usage/session-pricing.js';
import { parseCustomWindow } from '../../libs/analytics-window.js';
import { MAX_ANALYTICS_DAYS } from '../analytics/usage-analytics.contract.js';
import { validateCaptureRepositoryKey } from '../capture/capture-contract.js';
import { type ArtifactRevisionBody, validateCanonicalArtifactId } from './canonical-artifact.contract.js';
import {
  CanonicalTaskIdSchema,
  type CoredocShipEvidenceInput,
  type DeliveryTaskEnsureInput,
  TaskExternalRefUrlSchema,
  type TaskExternalRefAttachInput,
  type TaskExternalRefDetachInput,
} from './canonical-delivery.contract.js';
import {
  COUNTED_REWORK_KINDS,
  type CanonicalArtifactSummary,
  type CanonicalCodeChange,
  type CanonicalDeliverySummary,
  type CanonicalExternalRefStateFact,
  type CanonicalReworkSignal,
  type CanonicalShipEvidence,
  type CanonicalStageOccurrence,
  type CanonicalTaskDetail,
  type CanonicalTaskEstimatedCost,
  type CanonicalTaskExternalRef,
  type CanonicalTaskSummary,
  type CanonicalWorkflowRun,
  type CursorPage,
  type DeliveryCursorKeyKind,
  type DeliveryLifecycleFilter,
  type DeliveryWindowScope,
  decodeDeliveryCursor,
  deliveryCursorScope,
  deliveryShipState,
  encodeDeliveryCursor,
  InvalidDeliveryCursorError,
  parseDeliveryPageLimit,
  parseLifecycleFilter,
  validateCanonicalExternalRefId,
  validateCanonicalRunId,
} from './canonical-delivery-read.contract.js';
import {
  type DeliverySummaryCodeChangeRow,
  type DeliverySummaryReworkSignalRow,
  type DeliverySummaryRunRow,
  type DeliverySummaryTaskCostRow,
  type DeliverySummaryTaskRow,
  foldDeliverySummary,
} from './delivery-summary.fold.js';
import { isUniqueViolation } from '../../libs/coerce.js';

const TASK_SELECT = {
  id: true,
  repositoryKey: true,
  lifecycle: true,
  authority: true,
} as const;

const EXTERNAL_REF_SELECT = {
  provider: true,
  externalId: true,
  externalKey: true,
  externalUrl: true,
  externalState: true,
} as const;

const EXTERNAL_REF_IDENTITY_SELECT = {
  id: true,
  deliveryTaskId: true,
  ...EXTERNAL_REF_SELECT,
  connectorId: true,
  sourceCreatedAt: true,
  sourceUpdatedAt: true,
  lastObservedAt: true,
} as const;

const TASK_AUTHORITY_SELECT = {
  id: true,
  repositoryKey: true,
  lifecycle: true,
  authority: true,
  authorityRefId: true,
} as const;

const CANONICAL_AUTHORITY_REF_SELECT = {
  id: true,
  deliveryTaskId: true,
  provider: true,
  externalId: true,
  externalKey: true,
  connectorId: true,
  sourceCreatedAt: true,
} as const;

/**
 * Filtered relation count (BR-9): mutable by construction, since Prisma's generated count args
 * reject the readonly array an `as const` select would produce.
 */
const COUNTED_REWORK_SIGNAL_COUNT = { where: { kind: { in: [...COUNTED_REWORK_KINDS] } } };

const CANONICAL_TASK_SUMMARY_SELECT = {
  id: true,
  repositoryKey: true,
  lifecycle: true,
  authority: true,
  authorityRefId: true,
  authorityRef: { select: CANONICAL_AUTHORITY_REF_SELECT },
  title: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  shipEvidence: {
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] as Prisma.DeliveryShipEvidenceOrderByWithRelationInput[],
    take: 1,
    select: { occurredAt: true },
  },
  _count: {
    select: {
      externalRefs: true,
      workflowRuns: true,
      codeChanges: true,
      shipEvidence: true,
      // Filtered to the kinds the summary counts (BR-9): an unfiltered count would report a
      // stage re-entry as rework on the task row while the KPI beside it does not.
      reworkSignals: COUNTED_REWORK_SIGNAL_COUNT,
      artifacts: true,
    },
  },
} as const;

const CANONICAL_TASK_CONTEXT_SELECT = {
  id: true,
  authority: true,
  authorityRefId: true,
  authorityRef: { select: CANONICAL_AUTHORITY_REF_SELECT },
} as const;

const CAPTURE_RETENTION_CHECKPOINT_ID = 'capture_fine_events';

const ARTIFACT_IDENTITY_SELECT = {
  id: true,
  deliveryTaskId: true,
  repositoryKey: true,
  kind: true,
} as const;

const REVISION_METADATA_SELECT = {
  id: true,
  sha256: true,
  byteCount: true,
  checkpoint: true,
  runId: true,
  createdAt: true,
} as const;

const LEGACY_WORKFLOW_RUN_SELECT = {
  runId: true,
  actorId: true,
  workflowId: true,
  intent: true,
  risk: true,
  scale: true,
  repositoryKey: true,
  declaredStages: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  outcome: true,
  stageOccurrences: {
    orderBy: [{ stageId: 'asc' }, { attempt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      stageId: true,
      attempt: true,
      startedAt: true,
      finishedAt: true,
      outcome: true,
    },
  },
} satisfies Prisma.WorkflowRunSelect;

const UNIQUE_RACE_RETRY_LIMIT = 1;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_DELIVERY_WINDOW_DAYS = 30;
const CONNECTOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ConnectorTaskObservation {
  repositoryKey: string | null;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  externalState: string | null;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date;
  observedAt: Date;
}

interface AuthorityTaskRow {
  id: string;
  authority: string;
  authorityRefId: bigint | null;
}

interface AuthorityRefRow {
  id: bigint;
  deliveryTaskId: string;
  provider: string;
  externalId: string;
  externalKey: string | null;
  connectorId: string | null;
  sourceCreatedAt: Date | null;
}

// Prisma Date values lose PostgreSQL microseconds; these raw keys keep issued cursors exact and independent of a boundary row.
interface WorkflowRunPageKey {
  runId: string;
  cursorCreatedAt: string;
}

interface TaskRunCountRow {
  taskId: string;
  runCount: bigint;
}

interface WorkflowRunSessionRow {
  agentSessionId: string;
}

interface TaskWorkflowRunLinkRow {
  taskId: string;
  runId: string;
}

/** Distinct (task, workflow-run) association pairs keyed by the run's primary-key UUID. */
interface TaskWorkflowRunPairRow {
  taskId: string;
  runId: string;
}

/** Task ids carrying occurrence evidence of rework (BR-6/BR-9). */
interface ReworkTaskIdRow {
  taskId: string;
}

interface ArtifactPageKey {
  id: string;
  cursorCreatedAt: string;
}

type CanonicalTaskSummaryRow = Prisma.DeliveryTaskGetPayload<{ select: typeof CANONICAL_TASK_SUMMARY_SELECT }>;
type CanonicalTaskContextRow = Prisma.DeliveryTaskGetPayload<{ select: typeof CANONICAL_TASK_CONTEXT_SELECT }>;

function taskIdentityConflict(message: string): never {
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_IDENTITY_CONFLICT',
    message,
  });
}

function taskExternalRefConflict(message: string): never {
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_EXTERNAL_REF_CONFLICT',
    message,
  });
}

function taskAuthorityConflict(message: string): never {
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_AUTHORITY_CONFLICT',
    message,
  });
}

function taskAuthorityMigrationRequired(): never {
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_AUTHORITY_MIGRATION_REQUIRED',
    message: 'Canonical task authority requires exact administrator repair',
  });
}

function artifactIdentityConflict(message: string): never {
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'ARTIFACT_IDENTITY_CONFLICT',
    message,
  });
}

function shipEvidenceConflict(message: string): never {
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'SHIP_EVIDENCE_CONFLICT',
    message,
  });
}

function invalidDeliveryCursor(): never {
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'INVALID_DELIVERY_CURSOR',
    message: 'Invalid canonical delivery cursor',
  });
}

function deliveryPageLimit(rawLimit: unknown): number {
  try {
    return parseDeliveryPageLimit(rawLimit);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid canonical delivery limit');
  }
}

function deliveryCursor<const Kinds extends readonly DeliveryCursorKeyKind[]>(
  rawCursor: unknown,
  scope: string,
  kinds: Kinds,
) {
  try {
    return decodeDeliveryCursor(rawCursor, scope, kinds);
  } catch (error) {
    if (error instanceof InvalidDeliveryCursorError) invalidDeliveryCursor();
    throw error;
  }
}

function canonicalAuthority(task: CanonicalTaskContextRow | CanonicalTaskSummaryRow) {
  if (task.authorityRefId === null) {
    if (task.authority !== 'coredoc') taskAuthorityMigrationRequired();
    return { kind: 'coredoc' as const };
  }
  const ref = task.authorityRef;
  if (!ref || ref.id !== task.authorityRefId || ref.deliveryTaskId !== task.id) {
    taskAuthorityConflict('Exact lifecycle authority is not attached to this task');
  }
  return authorityFromRef(ref);
}

function canonicalTaskSummary(
  task: CanonicalTaskSummaryRow,
  workflowRunCount = task._count.workflowRuns,
  codeChangeStates: TaskCodeChangeStateCounts = EMPTY_CODE_CHANGE_STATES,
): CanonicalTaskSummary {
  const lastShippedAt = task.shipEvidence[0]?.occurredAt ?? null;
  const everShipped = task._count.shipEvidence > 0;
  return {
    id: task.id,
    repositoryKey: task.repositoryKey,
    lifecycle: task.lifecycle as CanonicalTaskSummary['lifecycle'],
    authority: canonicalAuthority(task),
    title: task.title,
    createdBy: task.createdBy,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    everShipped,
    lastShippedAt: lastShippedAt?.toISOString() ?? null,
    shipState: deliveryShipState(everShipped, codeChangeStates.open),
    counts: {
      externalRefs: task._count.externalRefs,
      workflowRuns: workflowRunCount,
      codeChanges: task._count.codeChanges,
      mergedCodeChanges: codeChangeStates.merged,
      openCodeChanges: codeChangeStates.open,
      shipEvidence: task._count.shipEvidence,
      reworkSignals: task._count.reworkSignals,
      artifacts: task._count.artifacts,
    },
  };
}

/** Linked code changes of one task, split by the two states the ship state depends on. */
interface TaskCodeChangeStateCounts {
  merged: number;
  open: number;
}

const EMPTY_CODE_CHANGE_STATES: TaskCodeChangeStateCounts = { merged: 0, open: 0 };

function boundedPageRows<Row>(rows: Row[], limit: number): { page: Row[]; truncated: boolean } {
  return { page: rows.slice(0, limit), truncated: rows.length > limit };
}

function nullableIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/**
 * `days` on the delivery reads: absent means "no window" so the pre-existing unfiltered
 * task-summaries call keeps its exact behavior; anything else follows the metrics controller's
 * parse (non-numeric or below one falls back to the default) clamped to the analytics ceiling.
 */
function deliveryWindowDays(rawDays: unknown): number | null {
  if (rawDays === undefined || rawDays === null || rawDays === '') return null;
  const parsed = Number.parseInt(String(rawDays), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DELIVERY_WINDOW_DAYS;
  // The summary reads the whole population unbounded, so this ceiling is what keeps it bounded.
  return Math.min(parsed, MAX_ANALYTICS_DAYS);
}

interface DeliveryWindow {
  days: number;
  since: Date;
  /** Exclusive end: `now` for a rolling `days` window, UTC midnight after `until` for a range. */
  until: Date;
  /** The same window as cursor identity, so a page cannot be replayed under another range. */
  scope: DeliveryWindowScope;
}

/**
 * The one window resolver for both delivery reads. An explicit `since`/`until` range wins over
 * `days` (and 400s when malformed — `parseCustomWindow`); with neither there is no window at
 * all, which only `listTaskSummaries` accepts, preserving its pre-filter behavior.
 * UTC-day aligned like `MetricsService.getTimeseries` so both surfaces name the same window.
 */
function deliveryWindow(rawDays: unknown, rawSince: unknown, rawUntil: unknown): DeliveryWindow | null {
  const custom = parseCustomWindow(rawSince, rawUntil);
  if (custom !== null) {
    return {
      days: custom.days,
      since: custom.since,
      until: custom.untilExclusive,
      scope: {
        since: custom.since.toISOString().slice(0, 10),
        until: new Date(custom.untilExclusive.getTime() - DAY_MS).toISOString().slice(0, 10),
      },
    };
  }
  const days = deliveryWindowDays(rawDays);
  if (days === null) return null;
  return { days, ...rollingWindowBounds(days), scope: { days } };
}

function rollingWindowBounds(days: number): { since: Date; until: Date } {
  const now = new Date();
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { since: new Date(todayUtcMs - (days - 1) * DAY_MS), until: now };
}

/**
 * BR-6: updated-in-window intersected with the lifecycle filter, applied identically by both reads.
 *
 * `rework` is signal evidence only (BR-9): a stage re-entry is an iteration fact, not rework.
 * `runTaskIds` is the run association behind the `runs` filter. `userTaskIds` (null when the
 * caller asked for no member) is that same association restricted to one member's agent
 * sessions. The caller resolves those ids once per read so the KPI and the paged list agree
 * (AC-7).
 */
function deliveryPopulationWhere(
  window: DeliveryWindow | null,
  lifecycle: DeliveryLifecycleFilter,
  runTaskIds: string[] = [],
  userTaskIds: string[] | null = null,
) {
  // Nested under `AND` rather than emitted as bare top-level `OR`/`id` keys: the caller spreads
  // this object beside the pagination cursor, which owns `OR`, and an object-spread collision
  // would drop the predicate from page two onward — silently widening the page.
  const and: Prisma.DeliveryTaskWhereInput[] = [];
  // ponytail: id IN list is unbounded by window size; move to an EXISTS subquery if a
  // workspace exceeds ~10k tasks/window.
  if (userTaskIds !== null) and.push({ id: { in: userTaskIds } });

  return {
    ...(window === null ? {} : { updatedAt: { gte: window.since, lt: window.until } }),
    ...(lifecycle === 'shipped'
      ? // Fully shipped only: ship evidence with a linked code change still open is a
        // PARTIAL ship, and the list must page exactly what the KPI counted.
        ({
          shipEvidence: { some: {} },
          codeChanges: { none: { codeChange: { state: 'open' } } },
        } satisfies Prisma.DeliveryTaskWhereInput)
      : lifecycle === 'active'
        ? { lifecycle: 'active' }
        : lifecycle === 'rework'
          ? { reworkSignals: { some: { kind: { in: [...COUNTED_REWORK_KINDS] } } } }
          : lifecycle === 'runs'
            ? // Same OR-association as `listTaskRuns` (direct id or through work items): a bare
              // `workflowRuns: { some: {} }` only sees the direct column, which capture leaves
              // null for every run that arrived with work items instead of a task id.
              { id: { in: runTaskIds } }
            : {}),
    ...(and.length === 0 ? {} : { AND: and }),
  };
}

function verificationCounter(counters: Record<string, unknown>, key: string): number | null {
  const value = counters[key];
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function verificationFact(counters: Prisma.JsonValue | null) {
  if (counters === null) return null;
  const record = typeof counters === 'object' && !Array.isArray(counters) ? (counters as Record<string, unknown>) : {};
  return {
    runs: verificationCounter(record, 'verificationRuns'),
    failures: verificationCounter(record, 'verificationFailures'),
    editVerifyRounds: verificationCounter(record, 'editVerifyRounds'),
  };
}

/** The `:taskId` path segment on every canonical delivery route, read or write. */
function canonicalTaskId(rawTaskId: unknown): string {
  const parsed = CanonicalTaskIdSchema.safeParse(rawTaskId);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
  return parsed.data;
}

/** The `:artifactId` path segment on the artifact routes. */
function canonicalArtifactId(rawArtifactId: unknown): string {
  try {
    return validateCanonicalArtifactId(rawArtifactId);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid artifact id');
  }
}

function canonicalExternalRefId(rawExternalRefId: unknown): string {
  try {
    return validateCanonicalExternalRefId(rawExternalRefId);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid canonical external reference id');
  }
}

function canonicalReadRunId(rawRunId: unknown): string {
  try {
    return validateCanonicalRunId(rawRunId);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid canonical workflow run id');
  }
}

function assertTaskField(label: string, established: unknown, incoming: unknown): void {
  if (incoming !== undefined && established !== incoming) {
    taskIdentityConflict(`${label} conflicts with the established task identity`);
  }
}

function boundedNullableString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must contain between 1 and ${maximum} characters`);
  }
  return value;
}

function requiredBoundedString(value: unknown, label: string, maximum: number): string {
  const parsed = boundedNullableString(value, label, maximum);
  if (parsed === null) throw new Error(`${label} is required`);
  return parsed;
}

function exactDate(value: unknown, label: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(typeof value === 'string' ? value : NaN);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid ISO-8601 timestamp`);
  return parsed;
}

/**
 * The connector observation is not an HTTP body — it is assembled by the importers — so it keeps
 * the plain-`Error` contract of the surrounding hand-rolled checks rather than a pipe.
 */
function taskExternalRefUrl(value: unknown): string {
  const parsed = TaskExternalRefUrlSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return parsed.data;
}

function validateConnectorTaskObservation(value: unknown): ConnectorTaskObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('connector task observation must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set([
    'repositoryKey',
    'externalId',
    'externalKey',
    'externalUrl',
    'externalState',
    'sourceCreatedAt',
    'sourceUpdatedAt',
    'observedAt',
  ]);
  for (const field of Object.keys(candidate)) {
    if (!allowed.has(field)) throw new Error(`Unsupported connector task observation field: ${field}`);
  }
  const repositoryKey =
    candidate.repositoryKey === undefined || candidate.repositoryKey === null
      ? null
      : validateCaptureRepositoryKey(candidate.repositoryKey);
  const externalUrl =
    candidate.externalUrl === undefined || candidate.externalUrl === null
      ? null
      : taskExternalRefUrl(candidate.externalUrl);
  return {
    repositoryKey,
    externalId: requiredBoundedString(candidate.externalId, 'externalId', 256),
    externalKey: boundedNullableString(candidate.externalKey, 'externalKey', 256),
    externalUrl,
    externalState: boundedNullableString(candidate.externalState, 'externalState', 128),
    sourceCreatedAt:
      candidate.sourceCreatedAt === undefined || candidate.sourceCreatedAt === null
        ? null
        : exactDate(candidate.sourceCreatedAt, 'sourceCreatedAt'),
    sourceUpdatedAt: exactDate(candidate.sourceUpdatedAt, 'sourceUpdatedAt'),
    observedAt: exactDate(candidate.observedAt, 'observedAt'),
  };
}

function validateConnectorId(value: unknown): string {
  if (typeof value !== 'string' || !CONNECTOR_ID_RE.test(value)) {
    throw new Error('connectorId must be a UUID');
  }
  return value.toLowerCase();
}

function authorityFromRef(ref: AuthorityRefRow) {
  return {
    kind: 'external_ref' as const,
    externalRefId: ref.id.toString(),
    provider: ref.provider,
    externalId: ref.externalId,
    externalKey: ref.externalKey,
    connected: ref.connectorId !== null,
    sourceCreatedAt: nullableIso(ref.sourceCreatedAt),
  };
}

function externalRefSummary(ref: AuthorityRefRow) {
  return {
    id: ref.id.toString(),
    provider: ref.provider,
    externalId: ref.externalId,
  };
}

function assertSameEqualFreshnessIdentityAndState(
  established: {
    externalKey: string | null;
    externalState: string | null;
  },
  incoming: ConnectorTaskObservation,
): void {
  for (const field of ['externalKey', 'externalState'] as const) {
    if (established[field] !== incoming[field]) {
      taskExternalRefConflict(`Equal source freshness conflicts on ${field}`);
    }
  }
}

@Injectable()
export class CanonicalDeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Linked code changes per task split by state, for the ship state and its two counts. One
   * grouped read over the page's ids (same shape as `taskRunCounts`) rather than a filtered
   * relation count per row: `state` lives on the code change, not on the link table.
   */
  private async taskCodeChangeStates(
    workspaceId: string,
    taskIds: string[],
  ): Promise<Map<string, TaskCodeChangeStateCounts>> {
    if (taskIds.length === 0) return new Map();
    const links = await this.prisma.deliveryTaskCodeChange.findMany({
      where: { workspaceId, deliveryTaskId: { in: taskIds } },
      select: { deliveryTaskId: true, codeChange: { select: { state: true } } },
    });
    const counts = new Map<string, TaskCodeChangeStateCounts>();
    for (const link of links) {
      // `closed` (closed without merge) counts as neither: it neither shipped nor blocks.
      if (link.codeChange.state !== 'merged' && link.codeChange.state !== 'open') continue;
      let entry = counts.get(link.deliveryTaskId);
      if (!entry) {
        entry = { merged: 0, open: 0 };
        counts.set(link.deliveryTaskId, entry);
      }
      entry[link.codeChange.state] += 1;
    }
    return counts;
  }

  private async taskRunCounts(workspaceId: string, taskIds: string[]): Promise<Map<string, number>> {
    if (taskIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<TaskRunCountRow[]>(Prisma.sql`
      SELECT matches."taskId", COUNT(DISTINCT matches."workflowRunId")::bigint AS "runCount"
      FROM (
        SELECT run."delivery_task_id" AS "taskId", run."id" AS "workflowRunId"
        FROM "workflow_runs" AS run
        WHERE run."workspace_id" = CAST(${workspaceId} AS UUID)
          AND run."delivery_task_id" IN (${Prisma.join(taskIds)})
        UNION ALL
        SELECT ref."delivery_task_id" AS "taskId", item."workflow_run_id" AS "workflowRunId"
        FROM "workflow_run_work_items" AS item
        INNER JOIN "task_external_refs" AS ref
          ON ref."workspace_id" = item."workspace_id"
         AND ref."provider" = item."provider"
         AND ref."external_id" = item."external_id"
        WHERE item."workspace_id" = CAST(${workspaceId} AS UUID)
          AND ref."delivery_task_id" IN (${Prisma.join(taskIds)})
      ) AS matches
      GROUP BY matches."taskId"
    `);
    return new Map(
      rows.map((row) => {
        const count = Number(row.runCount);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new InternalServerErrorException('Canonical workflow run counts could not be read');
        }
        return [row.taskId, count] as const;
      }),
    );
  }

  private async linkedWorkItemKeys(
    workspaceId: string,
    workItems: Array<{ provider: string; externalId: string }>,
  ): Promise<Set<string>> {
    const identities = new Map<string, { provider: string; externalId: string }>();
    for (const item of workItems) {
      identities.set(`${item.provider}\u0000${item.externalId}`, {
        provider: item.provider,
        externalId: item.externalId,
      });
    }
    if (identities.size === 0) return new Set();
    const refs = await this.prisma.taskExternalRef.findMany({
      where: { workspaceId, OR: [...identities.values()] },
      select: { provider: true, externalId: true },
    });
    return new Set(refs.map((ref) => `${ref.provider}\u0000${ref.externalId}`));
  }

  private async transactionWithConcurrentFirstWriteRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= UNIQUE_RACE_RETRY_LIMIT) throw error;
      }
    }
  }

  private async authorityView(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    task: AuthorityTaskRow,
    knownRef?: AuthorityRefRow,
  ) {
    if (task.authorityRefId === null) {
      if (task.authority !== 'coredoc') taskAuthorityMigrationRequired();
      return { kind: 'coredoc' as const };
    }
    let authorityRef = knownRef?.id === task.authorityRefId ? knownRef : undefined;
    if (!authorityRef) {
      authorityRef =
        (await tx.taskExternalRef.findFirst({
          where: {
            workspaceId,
            deliveryTaskId: task.id,
            id: task.authorityRefId,
          },
          select: EXTERNAL_REF_IDENTITY_SELECT,
        })) ?? undefined;
    }
    if (!authorityRef) taskAuthorityConflict('Exact lifecycle authority is not attached to this task');
    return authorityFromRef(authorityRef);
  }

  private async requireCanonicalTaskContext(workspaceId: string, rawTaskId: unknown) {
    const taskId = canonicalTaskId(rawTaskId);
    const task = await this.prisma.deliveryTask.findUnique({
      where: { workspaceId_id: { workspaceId, id: taskId } },
      select: CANONICAL_TASK_CONTEXT_SELECT,
    });
    if (!task) throw new NotFoundException('Canonical delivery task not found');
    canonicalAuthority(task);
    return { taskId, task };
  }

  async ensureTask(workspaceId: string, actorId: string, rawTaskId: unknown, input: DeliveryTaskEnsureInput) {
    const taskId = canonicalTaskId(rawTaskId);

    return this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
      if (input.repositoryKey !== undefined) {
        const repository = await tx.workspaceRepo.findFirst({
          where: { workspaceId, captureRepositoryKey: input.repositoryKey },
          select: { id: true },
        });
        if (!repository) throw new BadRequestException('Repository is not connected to this workspace');
      }

      const where = { workspaceId_id: { workspaceId, id: taskId } };
      const task = await tx.deliveryTask.upsert({
        where,
        create: {
          workspaceId,
          id: taskId,
          repositoryKey: input.repositoryKey ?? null,
          lifecycle: input.lifecycle ?? 'active',
          authority: input.authority ?? 'coredoc',
          createdBy: actorId,
        },
        update: {},
        select: TASK_SELECT,
      });

      assertTaskField('repositoryKey', task.repositoryKey, input.repositoryKey);
      assertTaskField('lifecycle', task.lifecycle, input.lifecycle);
      assertTaskField('authority', task.authority, input.authority);

      return {
        id: task.id,
        repositoryKey: task.repositoryKey,
        lifecycle: task.lifecycle,
        authority: task.authority,
        externalRefs: input.externalRefs,
      };
    });
  }

  async recordCoredocShipEvidence(
    workspaceId: string,
    actorId: string,
    rawTaskId: unknown,
    input: CoredocShipEvidenceInput,
  ): Promise<{
    status: 'accepted' | 'duplicate';
    taskId: string;
    eventId: string;
    shippedAt: string;
  }> {
    const taskId = canonicalTaskId(rawTaskId);
    const occurredAt = new Date(input.shippedAt);

    try {
      return await this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
        const task = await tx.deliveryTask.findUnique({
          where: { workspaceId_id: { workspaceId, id: taskId } },
          select: { id: true },
        });
        if (!task) throw new NotFoundException('Canonical delivery task not found');

        const established = await tx.deliveryShipEvidence.findUnique({
          where: {
            workspaceId_source_sourceKey: {
              workspaceId,
              source: 'coredoc',
              sourceKey: input.eventId,
            },
          },
          select: {
            deliveryTaskId: true,
            occurredAt: true,
            provider: true,
            repoExternalId: true,
            externalId: true,
          },
        });
        if (established) {
          if (
            established.deliveryTaskId !== taskId ||
            established.occurredAt.getTime() !== occurredAt.getTime() ||
            established.provider !== null ||
            established.repoExternalId !== null ||
            established.externalId !== null
          ) {
            shipEvidenceConflict('Coredoc event contradicts established ship evidence');
          }
          return {
            status: 'duplicate' as const,
            taskId,
            eventId: input.eventId,
            shippedAt: established.occurredAt.toISOString(),
          };
        }

        const created = await tx.deliveryShipEvidence.create({
          data: {
            workspaceId,
            deliveryTaskId: taskId,
            source: 'coredoc',
            sourceKey: input.eventId,
            occurredAt,
            actorId,
            provider: null,
            repoExternalId: null,
            externalId: null,
          },
          select: { occurredAt: true },
        });
        return {
          status: 'accepted' as const,
          taskId,
          eventId: input.eventId,
          shippedAt: created.occurredAt.toISOString(),
        };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isUniqueViolation(error)) shipEvidenceConflict('Coredoc ship evidence did not converge after one retry');
      throw error;
    }
  }

  async resolveConnectorTask(rawConnectorId: unknown, rawObservation: unknown) {
    let connectorId: string;
    let observation: ConnectorTaskObservation;
    try {
      connectorId = validateConnectorId(rawConnectorId);
      observation = validateConnectorTaskObservation(rawObservation);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid connector task observation');
    }

    try {
      return await this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
        const connector = await tx.deliveryConnector.findUnique({
          where: { id: connectorId },
          select: { id: true, workspaceId: true, provider: true },
        });
        if (!connector) throw new NotFoundException('Delivery connector not found');

        if (observation.repositoryKey !== null) {
          const repository = await tx.workspaceRepo.findFirst({
            where: {
              workspaceId: connector.workspaceId,
              captureRepositoryKey: observation.repositoryKey,
            },
            select: { id: true },
          });
          if (!repository) throw new BadRequestException('Repository is not connected to this workspace');
        }

        const provider = String(connector.provider);
        const where = {
          workspaceId_provider_externalId: {
            workspaceId: connector.workspaceId,
            provider,
            externalId: observation.externalId,
          },
        };
        const established = await tx.taskExternalRef.findUnique({
          where,
          select: EXTERNAL_REF_IDENTITY_SELECT,
        });

        if (!established) {
          const task = await tx.deliveryTask.create({
            data: {
              workspaceId: connector.workspaceId,
              id: `cdt_${randomUUID()}`,
              repositoryKey: observation.repositoryKey,
              lifecycle: 'active',
              authority: `connector:${provider}`,
              authorityRefId: null,
              createdBy: `connector:${connector.id}`,
            },
            select: TASK_AUTHORITY_SELECT,
          });
          const ref = await tx.taskExternalRef.create({
            data: {
              workspaceId: connector.workspaceId,
              deliveryTaskId: task.id,
              provider,
              externalId: observation.externalId,
              externalKey: observation.externalKey,
              externalUrl: observation.externalUrl,
              externalState: observation.externalState,
              connectorId: connector.id,
              sourceCreatedAt: observation.sourceCreatedAt,
              sourceUpdatedAt: observation.sourceUpdatedAt,
              lastObservedAt: observation.observedAt,
            },
            select: EXTERNAL_REF_IDENTITY_SELECT,
          });
          const authoritativeTask = await tx.deliveryTask.update({
            where: {
              workspaceId_id: {
                workspaceId: connector.workspaceId,
                id: task.id,
              },
            },
            data: {
              authority: `connector:${provider}`,
              authorityRefId: ref.id,
            },
            select: TASK_AUTHORITY_SELECT,
          });
          return {
            status: 'accepted' as const,
            taskId: task.id,
            externalRef: externalRefSummary(ref),
            authority: await this.authorityView(tx, connector.workspaceId, authoritativeTask, ref),
          };
        }

        if (established.connectorId !== null && established.connectorId !== connector.id) {
          taskExternalRefConflict('External identity is owned by another connector');
        }

        const freshness = established.sourceUpdatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
        const incomingFreshness = observation.sourceUpdatedAt.getTime();
        const equalFreshnessUrlChanged =
          incomingFreshness === freshness && established.externalUrl !== observation.externalUrl;
        if (incomingFreshness === freshness) assertSameEqualFreshnessIdentityAndState(established, observation);

        const task = await tx.deliveryTask.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: connector.workspaceId,
              id: established.deliveryTaskId,
            },
          },
          select: TASK_AUTHORITY_SELECT,
        });
        if (!task) throw new NotFoundException('Canonical delivery task not found');
        if (observation.repositoryKey !== null && task.repositoryKey !== observation.repositoryKey) {
          taskIdentityConflict('repositoryKey conflicts with the established task identity');
        }

        if (incomingFreshness <= freshness) {
          const observationAdvanced =
            established.lastObservedAt === null ||
            observation.observedAt.getTime() > established.lastObservedAt.getTime();
          const provenanceRestored = established.connectorId === null;
          // Backfill only: an issue last touched before this column existed never advances
          // its freshness again, so a re-observation is the one chance to learn its creation.
          const creationLearned = established.sourceCreatedAt === null && observation.sourceCreatedAt !== null;
          const observedRef =
            equalFreshnessUrlChanged || observationAdvanced || provenanceRestored || creationLearned
              ? await tx.taskExternalRef.update({
                  where: { id: established.id },
                  data: {
                    ...(equalFreshnessUrlChanged ? { externalUrl: observation.externalUrl } : {}),
                    ...(provenanceRestored ? { connectorId: connector.id } : {}),
                    ...(creationLearned ? { sourceCreatedAt: observation.sourceCreatedAt } : {}),
                    ...(observationAdvanced ? { lastObservedAt: observation.observedAt } : {}),
                  },
                  select: EXTERNAL_REF_IDENTITY_SELECT,
                })
              : established;
          return {
            status: incomingFreshness < freshness ? ('stale' as const) : ('duplicate' as const),
            taskId: task.id,
            externalRef: externalRefSummary(observedRef),
            authority: await this.authorityView(tx, connector.workspaceId, task, observedRef),
          };
        }

        const refreshed = await tx.taskExternalRef.update({
          where: { id: established.id },
          data: {
            externalKey: observation.externalKey,
            externalUrl: observation.externalUrl,
            externalState: observation.externalState,
            connectorId: connector.id,
            sourceCreatedAt: observation.sourceCreatedAt,
            sourceUpdatedAt: observation.sourceUpdatedAt,
            lastObservedAt:
              established.lastObservedAt !== null && established.lastObservedAt > observation.observedAt
                ? established.lastObservedAt
                : observation.observedAt,
          },
          select: EXTERNAL_REF_IDENTITY_SELECT,
        });
        return {
          status: 'updated' as const,
          taskId: task.id,
          externalRef: externalRefSummary(refreshed),
          authority: await this.authorityView(tx, connector.workspaceId, task, refreshed),
        };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isUniqueViolation(error)) taskIdentityConflict('External identity did not converge after one retry');
      throw error;
    }
  }

  async attachExternalRef(workspaceId: string, rawTaskId: unknown, input: TaskExternalRefAttachInput) {
    const taskId = canonicalTaskId(rawTaskId);

    try {
      return await this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
        let task = await tx.deliveryTask.findUnique({
          where: { workspaceId_id: { workspaceId, id: taskId } },
          select: TASK_AUTHORITY_SELECT,
        });
        if (!task) throw new NotFoundException('Canonical delivery task not found');

        if (input.connectorId !== null) {
          const connector = await tx.deliveryConnector.findFirst({
            where: { workspaceId, id: input.connectorId },
            select: { id: true, workspaceId: true, provider: true },
          });
          if (!connector) throw new NotFoundException('Delivery connector not found');
          if (String(connector.provider) !== input.provider) {
            taskExternalRefConflict('Connector provider does not match the external identity provider');
          }
        }

        const refWhere = {
          workspaceId_provider_externalId: {
            workspaceId,
            provider: input.provider,
            externalId: input.externalId,
          },
        };
        const established = await tx.taskExternalRef.findUnique({
          where: refWhere,
          select: EXTERNAL_REF_IDENTITY_SELECT,
        });
        if (established && established.deliveryTaskId !== taskId) {
          taskIdentityConflict('External identity already belongs to another canonical task');
        }
        if (
          established &&
          established.connectorId !== null &&
          input.connectorId !== null &&
          established.connectorId !== input.connectorId
        ) {
          taskExternalRefConflict('External identity is owned by another connector');
        }

        const status = established ? ('duplicate' as const) : ('attached' as const);
        let ref = established;
        if (!ref) {
          ref = await tx.taskExternalRef.create({
            data: {
              workspaceId,
              deliveryTaskId: taskId,
              provider: input.provider,
              externalId: input.externalId,
              externalKey: null,
              externalUrl: null,
              externalState: null,
              connectorId: input.connectorId,
              sourceCreatedAt: null,
              sourceUpdatedAt: null,
              lastObservedAt: null,
            },
            select: EXTERNAL_REF_IDENTITY_SELECT,
          });
        } else if (ref.connectorId === null && input.connectorId !== null) {
          ref = await tx.taskExternalRef.update({
            where: { id: ref.id },
            data: { connectorId: input.connectorId },
            select: EXTERNAL_REF_IDENTITY_SELECT,
          });
        }

        if (input.makeAuthority) {
          task = await tx.deliveryTask.update({
            where: { workspaceId_id: { workspaceId, id: taskId } },
            data: {
              authority: `connector:${input.provider}`,
              authorityRefId: ref.id,
            },
            select: TASK_AUTHORITY_SELECT,
          });
        }

        return {
          status,
          taskId,
          externalRef: externalRefSummary(ref),
          authority: await this.authorityView(tx, workspaceId, task, ref),
        };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isUniqueViolation(error)) taskIdentityConflict('External identity did not converge after one retry');
      throw error;
    }
  }

  async detachExternalRef(
    workspaceId: string,
    rawTaskId: unknown,
    rawExternalRefId: unknown,
    input: TaskExternalRefDetachInput,
  ) {
    const taskId = canonicalTaskId(rawTaskId);
    const externalRefId = BigInt(canonicalExternalRefId(rawExternalRefId));

    return this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
      let task = await tx.deliveryTask.findUnique({
        where: { workspaceId_id: { workspaceId, id: taskId } },
        select: TASK_AUTHORITY_SELECT,
      });
      if (!task) throw new NotFoundException('Canonical delivery task not found');
      const ref = await tx.taskExternalRef.findFirst({
        where: { workspaceId, deliveryTaskId: taskId, id: externalRefId },
        select: EXTERNAL_REF_IDENTITY_SELECT,
      });
      if (!ref) throw new NotFoundException('Canonical external reference not found');

      const isAuthority = task.authorityRefId === externalRefId;
      let authorityRef: AuthorityRefRow | undefined;
      if (isAuthority) {
        if (!input.fallbackAuthority) {
          taskAuthorityConflict('Detaching the exact lifecycle authority requires an explicit fallback');
        }
        if (input.fallbackAuthority.kind === 'coredoc') {
          task = await tx.deliveryTask.update({
            where: { workspaceId_id: { workspaceId, id: taskId } },
            data: { authority: 'coredoc', authorityRefId: null },
            select: TASK_AUTHORITY_SELECT,
          });
        } else {
          const fallbackId = BigInt(input.fallbackAuthority.externalRefId);
          if (fallbackId === externalRefId) {
            taskAuthorityConflict('Fallback authority must differ from the detached reference');
          }
          authorityRef =
            (await tx.taskExternalRef.findFirst({
              where: { workspaceId, deliveryTaskId: taskId, id: fallbackId },
              select: EXTERNAL_REF_IDENTITY_SELECT,
            })) ?? undefined;
          if (!authorityRef) throw new NotFoundException('Canonical external reference not found');
          if (authorityRef.connectorId === null) {
            taskAuthorityConflict('Fallback authority must be another connected ref attached to this task');
          }
          task = await tx.deliveryTask.update({
            where: { workspaceId_id: { workspaceId, id: taskId } },
            data: {
              authority: `connector:${authorityRef.provider}`,
              authorityRefId: authorityRef.id,
            },
            select: TASK_AUTHORITY_SELECT,
          });
        }
      } else if (input.fallbackAuthority) {
        taskAuthorityConflict('Fallback authority is valid only when detaching the exact lifecycle authority');
      }

      await tx.taskExternalRef.delete({ where: { id: externalRefId } });
      return {
        status: 'detached' as const,
        taskId,
        authority: await this.authorityView(tx, workspaceId, task, authorityRef),
      };
    });
  }

  async uploadArtifactRevision(
    workspaceId: string,
    actorId: string,
    rawArtifactId: unknown,
    body: ArtifactRevisionBody,
  ) {
    const input = {
      ...body,
      artifactId: canonicalArtifactId(rawArtifactId),
      byteCount: Buffer.byteLength(body.markdown, 'utf8'),
    };
    const sha256 = createHash('sha256').update(input.markdown, 'utf8').digest('hex');

    try {
      return await this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
        const proposedRevisionId = randomUUID();
        const task = await tx.deliveryTask.findUnique({
          where: { workspaceId_id: { workspaceId, id: input.taskId } },
          select: { id: true, repositoryKey: true },
        });
        if (!task) throw new NotFoundException('Canonical delivery task not found');
        if (task.repositoryKey !== input.repositoryKey) {
          artifactIdentityConflict('Task repository conflicts with the artifact identity');
        }

        const repository = await tx.workspaceRepo.findFirst({
          where: { workspaceId, captureRepositoryKey: input.repositoryKey },
          select: { id: true },
        });
        if (!repository) throw new BadRequestException('Repository is not connected to this workspace');

        const artifact = await tx.deliveryArtifact.upsert({
          where: { workspaceId_id: { workspaceId, id: input.artifactId } },
          create: {
            workspaceId,
            id: input.artifactId,
            deliveryTaskId: input.taskId,
            repositoryKey: input.repositoryKey,
            kind: input.kind,
            createdBy: actorId,
          },
          update: {},
          select: ARTIFACT_IDENTITY_SELECT,
        });
        if (
          artifact.deliveryTaskId !== input.taskId ||
          artifact.repositoryKey !== input.repositoryKey ||
          artifact.kind !== input.kind
        ) {
          artifactIdentityConflict('Artifact identity conflicts with an established artifact');
        }

        const revision = await tx.artifactRevision.upsert({
          where: {
            workspaceId_artifactId_sha256: {
              workspaceId,
              artifactId: input.artifactId,
              sha256,
            },
          },
          create: {
            id: proposedRevisionId,
            workspaceId,
            artifactId: input.artifactId,
            sha256,
            byteCount: input.byteCount,
            markdown: input.markdown,
            checkpoint: input.checkpoint,
            runId: input.runId,
          },
          update: {},
          select: REVISION_METADATA_SELECT,
        });

        return {
          status: revision.id === proposedRevisionId ? ('accepted' as const) : ('duplicate' as const),
          artifact: {
            id: artifact.id,
            taskId: artifact.deliveryTaskId,
            repositoryKey: artifact.repositoryKey,
            kind: artifact.kind,
          },
          revision: {
            id: revision.id,
            sha256: revision.sha256,
            byteCount: revision.byteCount,
            checkpoint: revision.checkpoint,
            runId: revision.runId,
            createdAt: revision.createdAt.toISOString(),
          },
        };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('Artifact revision could not be stored');
    }
  }

  async getArtifact(workspaceId: string, rawArtifactId: unknown) {
    const artifactId = canonicalArtifactId(rawArtifactId);

    try {
      const artifact = await this.prisma.deliveryArtifact.findUnique({
        where: { workspaceId_id: { workspaceId, id: artifactId } },
        select: {
          ...ARTIFACT_IDENTITY_SELECT,
          revisions: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { ...REVISION_METADATA_SELECT, markdown: true },
          },
        },
      });
      if (!artifact) throw new NotFoundException('Canonical delivery artifact not found');
      return {
        artifact: {
          id: artifact.id,
          taskId: artifact.deliveryTaskId,
          repositoryKey: artifact.repositoryKey,
          kind: artifact.kind,
        },
        revisions: artifact.revisions.map((revision) => ({
          id: revision.id,
          sha256: revision.sha256,
          byteCount: revision.byteCount,
          checkpoint: revision.checkpoint,
          runId: revision.runId,
          createdAt: revision.createdAt.toISOString(),
          markdown: revision.markdown,
        })),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('Artifact revisions could not be read');
    }
  }

  async listTaskSummaries(
    workspaceId: string,
    rawLimit?: unknown,
    rawCursor?: unknown,
    rawDays?: unknown,
    rawLifecycle?: unknown,
    rawSince?: unknown,
    rawUntil?: unknown,
    userId?: string | null,
  ) {
    const limit = deliveryPageLimit(rawLimit);
    const window = deliveryWindow(rawDays, rawSince, rawUntil);
    const lifecycle = parseLifecycleFilter(rawLifecycle);
    const memberId = typeof userId === 'string' ? userId : null;
    const scope = deliveryCursorScope.taskSummaries(window?.scope ?? null, lifecycle, memberId);
    const cursor = deliveryCursor(rawCursor, scope, ['timestamp', 'task_id'] as const);
    const { runTaskIds, userTaskIds } = await this.resolveTaskIdFilters(workspaceId, window, lifecycle, memberId);
    const rows = await this.prisma.deliveryTask.findMany({
      where: {
        workspaceId,
        ...deliveryPopulationWhere(window, lifecycle, runTaskIds, userTaskIds),
        ...(cursor === null
          ? {}
          : {
              OR: [{ updatedAt: { lt: cursor[0] } }, { updatedAt: cursor[0], id: { lt: cursor[1] } }],
            }),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: CANONICAL_TASK_SUMMARY_SELECT,
    });
    const { page, truncated } = boundedPageRows(rows, limit);
    const pageIds = page.map((task) => task.id);
    const [runCounts, codeChangeStates] = await Promise.all([
      this.taskRunCounts(workspaceId, pageIds),
      this.taskCodeChangeStates(workspaceId, pageIds),
    ]);
    const last = page.at(-1);
    return {
      tasks: page.map((task) =>
        canonicalTaskSummary(
          task,
          runCounts.get(task.id) ?? 0,
          codeChangeStates.get(task.id) ?? EMPTY_CODE_CHANGE_STATES,
        ),
      ),
      nextCursor: truncated && last ? encodeDeliveryCursor(scope, [last.updatedAt.toISOString(), last.id]) : null,
    };
  }

  /**
   * The delivery summary (BR-6..BR-10): one aggregate over the same population the filtered task
   * list pages, folded by `foldDeliverySummary`. The population read carries no `take` on purpose
   * — the window (at most `MAX_ANALYTICS_DAYS` of updated tasks) is the bound, and a `take`
   * would silently make the KPIs describe a different population than the list.
   */
  async getDeliverySummary(
    workspaceId: string,
    rawDays?: unknown,
    rawLifecycle?: unknown,
    rawSince?: unknown,
    rawUntil?: unknown,
    userId?: string | null,
  ): Promise<CanonicalDeliverySummary> {
    // The summary is always windowed: no params means the default rolling window.
    const resolved =
      deliveryWindow(rawDays, rawSince, rawUntil) ??
      ({
        days: DEFAULT_DELIVERY_WINDOW_DAYS,
        ...rollingWindowBounds(DEFAULT_DELIVERY_WINDOW_DAYS),
        scope: { days: DEFAULT_DELIVERY_WINDOW_DAYS },
      } satisfies DeliveryWindow);
    const lifecycle = parseLifecycleFilter(rawLifecycle);
    const memberId = typeof userId === 'string' ? userId : null;
    const window = {
      days: resolved.days,
      since: resolved.since.toISOString(),
      until: resolved.until.toISOString(),
      lifecycle,
      userId: memberId,
    };
    const { runTaskIds, userTaskIds } = await this.resolveTaskIdFilters(workspaceId, resolved, lifecycle, memberId);

    const taskRows = await this.prisma.deliveryTask.findMany({
      where: { workspaceId, ...deliveryPopulationWhere(resolved, lifecycle, runTaskIds, userTaskIds) },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        lifecycle: true,
        authorityRef: { select: { sourceCreatedAt: true } },
        shipEvidence: {
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] as Prisma.DeliveryShipEvidenceOrderByWithRelationInput[],
          take: 1,
          select: { occurredAt: true },
        },
      },
    });
    if (taskRows.length === 0) {
      return {
        window,
        ...foldDeliverySummary({
          now: new Date(),
          tasks: [],
          runs: [],
          reworkSignals: [],
          codeChanges: [],
          taskCosts: [],
        }),
      };
    }
    const taskIds = taskRows.map((task) => task.id);

    const [pairs, reworkSignalRows, codeChangeRows] = await Promise.all([
      this.taskWorkflowRunPairs(workspaceId, taskIds),
      this.prisma.deliveryReworkSignal.findMany({
        where: { workspaceId, deliveryTaskId: { in: taskIds } },
        select: { deliveryTaskId: true, kind: true },
      }),
      this.prisma.deliveryTaskCodeChange.findMany({
        where: { workspaceId, deliveryTaskId: { in: taskIds } },
        select: {
          deliveryTaskId: true,
          codeChangeId: true,
          codeChange: { select: { state: true, readyForReviewAt: true, firstReviewAt: true } },
        },
      }),
    ]);
    // The ship state is read off the same linked-code-change rows the review wait folds, so
    // the summary never asks the database a second question about the same fact.
    const openCodeChangesByTask = new Map<string, number>();
    for (const link of codeChangeRows) {
      if (link.codeChange.state !== 'open') continue;
      openCodeChangesByTask.set(link.deliveryTaskId, (openCodeChangesByTask.get(link.deliveryTaskId) ?? 0) + 1);
    }
    const tasks: DeliverySummaryTaskRow[] = taskRows.map((task) => ({
      id: task.id,
      createdAt: task.createdAt,
      sourceCreatedAt: task.authorityRef?.sourceCreatedAt ?? null,
      updatedAt: task.updatedAt,
      lifecycle: task.lifecycle,
      lastShippedAt: task.shipEvidence[0]?.occurredAt ?? null,
      openCodeChanges: openCodeChangesByTask.get(task.id) ?? 0,
    }));

    // One instant for the whole summary: the fold's staleness clock and the fallback below must
    // not disagree about what "now" is.
    const now = new Date();
    const runIds = [...new Set(pairs.map((pair) => pair.runId))];
    // Stage occurrences carry no workspace column, so tenancy is asserted through the run relation.
    const [occurrenceRows, runRows] = await Promise.all([
      runIds.length === 0
        ? []
        : this.prisma.workflowStageOccurrence.findMany({
            where: { workflowRun: { workspaceId, id: { in: runIds } } },
            orderBy: [{ startedAt: { sort: 'asc', nulls: 'last' } }, { stageId: 'asc' }, { attempt: 'asc' }],
            select: { workflowRunId: true, stageId: true, attempt: true, startedAt: true, finishedAt: true },
          }),
      runIds.length === 0
        ? []
        : this.prisma.workflowRun.findMany({
            where: { workspaceId, id: { in: runIds } },
            // startedAt/finishedAt/createdAt are the run-level clock the stage classification
            // falls back to, and the fact that settles a stage still open on a finished run.
            select: {
              id: true,
              counters: true,
              agentSessionId: true,
              startedAt: true,
              finishedAt: true,
              createdAt: true,
            },
          }),
    ]);
    const occurrencesByRun = new Map<string, DeliverySummaryRunRow['stageOccurrences']>();
    for (const occurrence of occurrenceRows) {
      const list = occurrencesByRun.get(occurrence.workflowRunId);
      const entry = {
        stageId: occurrence.stageId,
        attempt: occurrence.attempt,
        startedAt: occurrence.startedAt,
        finishedAt: occurrence.finishedAt,
      };
      if (list) list.push(entry);
      else occurrencesByRun.set(occurrence.workflowRunId, [entry]);
    }
    const runsById = new Map(runRows.map((run) => [run.id, run]));
    const runs: DeliverySummaryRunRow[] = pairs.map((pair) => {
      const run = runsById.get(pair.runId);
      return {
        taskId: pair.taskId,
        runId: pair.runId,
        startedAt: run?.startedAt ?? null,
        finishedAt: run?.finishedAt ?? null,
        // A pair whose run row is missing has no observed clock; `now` ages it to zero, which
        // keeps it `in_progress` rather than asserting staleness on no evidence.
        createdAt: run?.createdAt ?? now,
        stageOccurrences: occurrencesByRun.get(pair.runId) ?? [],
        editVerifyRounds: verificationFact(run?.counters ?? null)?.editVerifyRounds ?? null,
      };
    });

    const reworkSignals: DeliverySummaryReworkSignalRow[] = reworkSignalRows.map((signal) => ({
      taskId: signal.deliveryTaskId,
      kind: signal.kind,
    }));
    const codeChanges: DeliverySummaryCodeChangeRow[] = codeChangeRows.map((link) => ({
      codeChangeId: link.codeChangeId,
      readyForReviewAt: link.codeChange.readyForReviewAt,
      firstReviewAt: link.codeChange.firstReviewAt,
    }));

    // Cost per shipped task is a fully-shipped sample, exactly like the lead time.
    const shippedTaskIds = new Set(
      tasks
        .filter((task) => deliveryShipState(task.lastShippedAt !== null, task.openCodeChanges) === 'shipped')
        .map((task) => task.id),
    );
    const taskCosts = await this.shippedTaskCosts(workspaceId, shippedTaskIds, pairs, runsById);

    return { window, ...foldDeliverySummary({ now, tasks, runs, reworkSignals, codeChanges, taskCosts }) };
  }

  /**
   * The distinct (task, run) association pairs behind BR-8/BR-9: the same OR-association
   * `listTaskRuns` uses (direct `delivery_task_id` or through work items joined to external
   * refs), deduplicated so a run matched by both branches counts once per task.
   */
  private async taskWorkflowRunPairs(workspaceId: string, taskIds: string[]): Promise<TaskWorkflowRunPairRow[]> {
    if (taskIds.length === 0) return [];
    return this.prisma.$queryRaw<TaskWorkflowRunPairRow[]>(Prisma.sql`
      SELECT DISTINCT matches."taskId", matches."runId"
      FROM (
        SELECT run."delivery_task_id" AS "taskId", run."id" AS "runId"
        FROM "workflow_runs" AS run
        WHERE run."workspace_id" = CAST(${workspaceId} AS UUID)
          AND run."delivery_task_id" IN (${Prisma.join(taskIds)})
        UNION ALL
        SELECT ref."delivery_task_id" AS "taskId", run."id" AS "runId"
        FROM "workflow_runs" AS run
        INNER JOIN "workflow_run_work_items" AS item
          ON item."workspace_id" = run."workspace_id"
         AND item."workflow_run_id" = run."id"
        INNER JOIN "task_external_refs" AS ref
          ON ref."workspace_id" = item."workspace_id"
         AND ref."provider" = item."provider"
         AND ref."external_id" = item."external_id"
        WHERE run."workspace_id" = CAST(${workspaceId} AS UUID)
          AND ref."delivery_task_id" IN (${Prisma.join(taskIds)})
      ) AS matches
      ORDER BY matches."taskId" ASC, matches."runId" ASC
    `);
  }

  /**
   * Tasks in the workspace and window that reach at least one workflow run through the same
   * UNION association `taskWorkflowRunPairs` uses (BR-6) — the `runs` filter. With `userId` the
   * association is restricted to that member's agent sessions (the member filter). Tenancy is
   * asserted through `workflow_runs.workspace_id` on both branches of the UNION.
   */
  /**
   * The two run-association id filters a windowed read needs (AC-7): `runTaskIds` behind the
   * `runs` lifecycle filter and `userTaskIds` behind the member filter.
   *
   * With BOTH asked for, the member's ids are the answer to both: `userTaskIds` is the same
   * association restricted to one member's sessions, so it is a subset of `runTaskIds` and the
   * unfiltered query would only be intersected away — one round trip instead of two. Without a
   * member there is no second query to run at all.
   */
  private async resolveTaskIdFilters(
    workspaceId: string,
    window: DeliveryWindow | null,
    lifecycle: DeliveryLifecycleFilter,
    memberId: string | null,
  ): Promise<{ runTaskIds: string[]; userTaskIds: string[] | null }> {
    if (memberId !== null) {
      const userTaskIds = await this.runAssociatedTaskIds(workspaceId, window, memberId);
      return { runTaskIds: lifecycle === 'runs' ? userTaskIds : [], userTaskIds };
    }
    const runTaskIds = lifecycle === 'runs' ? await this.runAssociatedTaskIds(workspaceId, window) : [];
    return { runTaskIds, userTaskIds: null };
  }

  private async runAssociatedTaskIds(
    workspaceId: string,
    window: DeliveryWindow | null,
    userId?: string,
  ): Promise<string[]> {
    const windowClause =
      window === null
        ? Prisma.empty
        : Prisma.sql`AND task."updated_at" >= ${window.since} AND task."updated_at" < ${window.until}`;
    // Member filter: the run must belong to one of that member's agent sessions.
    const userJoin =
      userId === undefined
        ? Prisma.empty
        : Prisma.sql`INNER JOIN "agent_sessions" AS session
          ON session."id" = run."agent_session_id"
         AND session."workspace_id" = run."workspace_id"
         AND session."user_id" = ${userId}`;
    const rows = await this.prisma.$queryRaw<ReworkTaskIdRow[]>(Prisma.sql`
      SELECT DISTINCT matches."taskId"
      FROM (
        SELECT run."delivery_task_id" AS "taskId", run."id" AS "runId"
        FROM "workflow_runs" AS run
        ${userJoin}
        WHERE run."workspace_id" = CAST(${workspaceId} AS UUID)
          AND run."delivery_task_id" IS NOT NULL
        UNION ALL
        SELECT ref."delivery_task_id" AS "taskId", run."id" AS "runId"
        FROM "workflow_runs" AS run
        ${userJoin}
        INNER JOIN "workflow_run_work_items" AS item
          ON item."workspace_id" = run."workspace_id"
         AND item."workflow_run_id" = run."id"
        INNER JOIN "task_external_refs" AS ref
          ON ref."workspace_id" = item."workspace_id"
         AND ref."provider" = item."provider"
         AND ref."external_id" = item."external_id"
        WHERE run."workspace_id" = CAST(${workspaceId} AS UUID)
      ) AS matches
      INNER JOIN "delivery_tasks" AS task
        ON task."workspace_id" = CAST(${workspaceId} AS UUID)
       AND task."id" = matches."taskId"
      WHERE TRUE
      ${windowClause}
      ORDER BY matches."taskId" ASC
    `);
    return rows.map((row) => row.taskId);
  }

  /**
   * Per-shipped-task price-map totals (BR-1 semantics, same usage-observed rule as
   * `taskEstimatedCost`): a session that reported no usage was never priceable and is not
   * evidence of an unpriced model, so it does not count at all. `sessions` is therefore the
   * number of found session rows with usage observed — a task whose only sessions reported no
   * usage (or whose rows are missing) reports `sessions: 0` and leaves the cost sample entirely
   * instead of being folded in as an unpriced task.
   */
  private async shippedTaskCosts(
    workspaceId: string,
    shippedTaskIds: Set<string>,
    pairs: TaskWorkflowRunPairRow[],
    runsById: Map<string, { agentSessionId: string }>,
  ): Promise<DeliverySummaryTaskCostRow[]> {
    if (shippedTaskIds.size === 0) return [];
    const sessionIdsByTask = new Map<string, Set<string>>();
    for (const pair of pairs) {
      if (!shippedTaskIds.has(pair.taskId)) continue;
      const agentSessionId = runsById.get(pair.runId)?.agentSessionId;
      if (agentSessionId === undefined) continue;
      const sessions = sessionIdsByTask.get(pair.taskId);
      if (sessions) sessions.add(agentSessionId);
      else sessionIdsByTask.set(pair.taskId, new Set([agentSessionId]));
    }
    const allSessionIds = [...new Set([...sessionIdsByTask.values()].flatMap((sessions) => [...sessions]))];
    const sessionRows =
      allSessionIds.length === 0
        ? []
        : await this.prisma.agentSession.findMany({
            where: { workspaceId, id: { in: allSessionIds } },
            select: {
              id: true,
              provider: true,
              model: true,
              tokensInput: true,
              tokensOutput: true,
              tokensCacheRead: true,
              tokensCacheCreation: true,
              tokensReasoning: true,
            },
          });
    const pricedById = new Map<string, number | null>();
    const usageObservedIds = new Set<string>();
    for (const session of sessionRows) {
      const usageObserved =
        session.tokensInput > 0 ||
        session.tokensOutput > 0 ||
        session.tokensCacheRead > 0 ||
        session.tokensCacheCreation > 0 ||
        session.tokensReasoning > 0;
      if (usageObserved) usageObservedIds.add(session.id);
      pricedById.set(
        session.id,
        usageObserved
          ? estimateSessionCostUsd(session.provider, session.model ?? '', {
              input: Number(session.tokensInput),
              output: Number(session.tokensOutput),
              cacheRead: Number(session.tokensCacheRead),
              cacheCreation: Number(session.tokensCacheCreation),
              reasoning: Number(session.tokensReasoning),
            })
          : null,
      );
    }
    return [...shippedTaskIds].map((taskId) => {
      const sessions = sessionIdsByTask.get(taskId) ?? new Set<string>();
      let pricedTotalUsd: number | null = null;
      let observedSessions = 0;
      for (const sessionId of sessions) {
        if (!usageObservedIds.has(sessionId)) continue;
        observedSessions += 1;
        const cost = pricedById.get(sessionId) ?? null;
        if (cost !== null) pricedTotalUsd = (pricedTotalUsd ?? 0) + cost;
      }
      return { taskId, sessions: observedSessions, pricedTotalUsd };
    });
  }

  // The task -> run -> session cost join. WorkflowRun.agentSessionId is a
  // mandatory direct FK stamped (and asserted stable) at capture ingest
  // (capture.service.ts upsertRun) alongside WorkflowRun.deliveryTaskId — both
  // columns exist and need no JSON-attribute lookup.
  private async taskEstimatedCost(workspaceId: string, taskId: string): Promise<CanonicalTaskEstimatedCost> {
    const runs = await this.prisma.$queryRaw<WorkflowRunSessionRow[]>(Prisma.sql`
      SELECT DISTINCT run."agent_session_id" AS "agentSessionId"
      FROM "workflow_runs" AS run
      WHERE run."workspace_id" = CAST(${workspaceId} AS UUID)
        AND (
          run."delivery_task_id" = ${taskId}
          OR EXISTS (
            SELECT 1
            FROM "workflow_run_work_items" AS item
            INNER JOIN "task_external_refs" AS ref
              ON ref."workspace_id" = item."workspace_id"
             AND ref."provider" = item."provider"
             AND ref."external_id" = item."external_id"
            WHERE item."workspace_id" = run."workspace_id"
              AND item."workflow_run_id" = run."id"
              AND ref."delivery_task_id" = ${taskId}
          )
        )
    `);
    const agentSessionIds = [...new Set(runs.map((run) => run.agentSessionId))];
    if (agentSessionIds.length === 0)
      return { totalUsd: null, sessions: 0, unpricedSessions: 0, sessionsWithoutUsage: 0 };

    const sessions = await this.prisma.agentSession.findMany({
      where: { workspaceId, id: { in: agentSessionIds } },
      select: {
        provider: true,
        model: true,
        tokensInput: true,
        tokensOutput: true,
        tokensCacheRead: true,
        tokensCacheCreation: true,
        tokensReasoning: true,
      },
    });

    // Null-sentinel accumulator (mirrors the byUser rollup): a task whose joined
    // sessions are all unpriced or telemetry-less must render the unpriced
    // marker, never a computed $0.00.
    // The counters partition `sessions.length` exactly (priced + unpriced +
    // withoutUsage), so a reader can never render "3 sessions · 0 unpriced sessions"
    // for a task whose sessions carry no usage at all.
    let totalUsd: number | null = null;
    let unpricedSessions = 0;
    let sessionsWithoutUsage = 0;
    for (const session of sessions) {
      const usageObserved =
        session.tokensInput > 0 ||
        session.tokensOutput > 0 ||
        session.tokensCacheRead > 0 ||
        session.tokensCacheCreation > 0 ||
        session.tokensReasoning > 0;
      if (!usageObserved) {
        sessionsWithoutUsage += 1;
        continue;
      }
      const cost = estimateSessionCostUsd(session.provider, session.model ?? '', {
        input: Number(session.tokensInput),
        output: Number(session.tokensOutput),
        cacheRead: Number(session.tokensCacheRead),
        cacheCreation: Number(session.tokensCacheCreation),
        reasoning: Number(session.tokensReasoning),
      });
      if (cost === null) unpricedSessions += 1;
      else totalUsd = (totalUsd ?? 0) + cost;
    }

    return { totalUsd, sessions: sessions.length, unpricedSessions, sessionsWithoutUsage };
  }

  async getTaskDetail(workspaceId: string, rawTaskId: unknown): Promise<CanonicalTaskDetail> {
    const taskId = canonicalTaskId(rawTaskId);
    const task = await this.prisma.deliveryTask.findUnique({
      where: { workspaceId_id: { workspaceId, id: taskId } },
      select: CANONICAL_TASK_SUMMARY_SELECT,
    });
    if (!task) throw new NotFoundException('Canonical delivery task not found');
    const [checkpoint, estimatedCost, runCounts, codeChangeStates] = await Promise.all([
      this.prisma.captureRetentionCheckpoint.findUnique({
        where: { id: CAPTURE_RETENTION_CHECKPOINT_ID },
        select: { purgedThroughReceivedAt: true },
      }),
      this.taskEstimatedCost(workspaceId, taskId),
      this.taskRunCounts(workspaceId, [taskId]),
      this.taskCodeChangeStates(workspaceId, [taskId]),
    ]);
    return {
      ...canonicalTaskSummary(
        task,
        runCounts.get(taskId) ?? 0,
        codeChangeStates.get(taskId) ?? EMPTY_CODE_CHANGE_STATES,
      ),
      fineEventRetention: {
        policyDays: 90,
        purgedThroughReceivedAt: checkpoint?.purgedThroughReceivedAt.toISOString() ?? null,
      },
      estimatedCost,
    };
  }

  async listTaskExternalRefs(
    workspaceId: string,
    rawTaskId: unknown,
    rawLimit?: unknown,
    rawCursor?: unknown,
  ): Promise<CursorPage<CanonicalTaskExternalRef>> {
    const { taskId, task } = await this.requireCanonicalTaskContext(workspaceId, rawTaskId);
    const limit = deliveryPageLimit(rawLimit);
    const scope = deliveryCursorScope.taskExternalRefs(taskId);
    const cursor = deliveryCursor(rawCursor, scope, ['provider', 'external_id', 'decimal'] as const);
    const rows = await this.prisma.taskExternalRef.findMany({
      where: {
        workspaceId,
        deliveryTaskId: taskId,
        ...(cursor === null
          ? {}
          : {
              OR: [
                { provider: { gt: cursor[0] } },
                { provider: cursor[0], externalId: { gt: cursor[1] } },
                { provider: cursor[0], externalId: cursor[1], id: { gt: cursor[2] } },
              ],
            }),
      },
      orderBy: [{ provider: 'asc' }, { externalId: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        provider: true,
        externalId: true,
        externalKey: true,
        externalUrl: true,
        externalState: true,
        connectorId: true,
        sourceUpdatedAt: true,
        lastObservedAt: true,
        _count: { select: { stateFacts: true } },
      },
    });
    const { page, truncated } = boundedPageRows(rows, limit);
    const last = page.at(-1);
    return {
      items: page.map((ref) => ({
        id: ref.id.toString(),
        provider: ref.provider,
        externalId: ref.externalId,
        externalKey: ref.externalKey,
        externalUrl: ref.externalUrl,
        externalState: ref.externalState,
        connectorId: ref.connectorId,
        sourceUpdatedAt: nullableIso(ref.sourceUpdatedAt),
        lastObservedAt: nullableIso(ref.lastObservedAt),
        isAuthority: task.authorityRefId === ref.id,
        stateFactCount: ref._count.stateFacts,
      })),
      nextCursor:
        truncated && last ? encodeDeliveryCursor(scope, [last.provider, last.externalId, last.id.toString()]) : null,
    };
  }

  async listExternalRefStateHistory(
    workspaceId: string,
    rawTaskId: unknown,
    rawExternalRefId: unknown,
    rawLimit?: unknown,
    rawCursor?: unknown,
  ): Promise<CursorPage<CanonicalExternalRefStateFact>> {
    const externalRefId = canonicalExternalRefId(rawExternalRefId);
    const { taskId } = await this.requireCanonicalTaskContext(workspaceId, rawTaskId);
    const refId = BigInt(externalRefId);
    const ref = await this.prisma.taskExternalRef.findFirst({
      where: { workspaceId, deliveryTaskId: taskId, id: refId },
      select: { id: true },
    });
    if (!ref) throw new NotFoundException('Canonical external reference not found');
    const limit = deliveryPageLimit(rawLimit);
    const scope = deliveryCursorScope.externalRefStateHistory(taskId, externalRefId);
    const cursor = deliveryCursor(rawCursor, scope, ['timestamp', 'decimal'] as const);
    const rows = await this.prisma.taskExternalRefStateFact.findMany({
      where: {
        workspaceId,
        externalRefId: refId,
        ...(cursor === null
          ? {}
          : {
              OR: [{ occurredAt: { gt: cursor[0] } }, { occurredAt: cursor[0], id: { gt: cursor[1] } }],
            }),
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        fromState: true,
        toState: true,
        sourceRef: true,
        occurredAt: true,
        sourceUpdatedAt: true,
        receivedAt: true,
        actorId: true,
      },
    });
    const { page, truncated } = boundedPageRows(rows, limit);
    const last = page.at(-1);
    return {
      items: page.map((fact) => ({
        id: fact.id.toString(),
        fromState: fact.fromState,
        toState: fact.toState,
        sourceRef: fact.sourceRef,
        occurredAt: fact.occurredAt.toISOString(),
        sourceUpdatedAt: fact.sourceUpdatedAt.toISOString(),
        receivedAt: fact.receivedAt.toISOString(),
        actorId: fact.actorId,
      })),
      nextCursor:
        truncated && last ? encodeDeliveryCursor(scope, [last.occurredAt.toISOString(), last.id.toString()]) : null,
    };
  }

  async listTaskRuns(
    workspaceId: string,
    rawTaskId: unknown,
    rawLimit?: unknown,
    rawCursor?: unknown,
  ): Promise<CursorPage<CanonicalWorkflowRun>> {
    const { taskId } = await this.requireCanonicalTaskContext(workspaceId, rawTaskId);
    const limit = deliveryPageLimit(rawLimit);
    const scope = deliveryCursorScope.taskRuns(taskId);
    const cursor = deliveryCursor(rawCursor, scope, ['exact_timestamp', 'run_id'] as const);
    const cursorFilter =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`AND (run."created_at", run."run_id") > (CAST(${cursor[0]} AS TIMESTAMPTZ), ${cursor[1]})`;
    const keys = await this.prisma.$queryRaw<WorkflowRunPageKey[]>(Prisma.sql`
      SELECT
        run."run_id" AS "runId",
        to_char(run."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
      FROM "workflow_runs" AS run
      WHERE run."workspace_id" = CAST(${workspaceId} AS UUID)
        AND (
          run."delivery_task_id" = ${taskId}
          OR EXISTS (
            SELECT 1
            FROM "workflow_run_work_items" AS item
            INNER JOIN "task_external_refs" AS ref
              ON ref."workspace_id" = item."workspace_id"
             AND ref."provider" = item."provider"
             AND ref."external_id" = item."external_id"
            WHERE item."workspace_id" = run."workspace_id"
              AND item."workflow_run_id" = run."id"
              AND ref."delivery_task_id" = ${taskId}
          )
        )
        ${cursorFilter}
      ORDER BY run."created_at" ASC, run."run_id" ASC
      LIMIT ${limit + 1}
    `);
    const { page: pageKeys, truncated } = boundedPageRows(keys, limit);
    const rows = await this.prisma.workflowRun.findMany({
      where: {
        workspaceId,
        runId: { in: pageKeys.map((key) => key.runId) },
      },
      select: {
        runId: true,
        workflowId: true,
        intent: true,
        risk: true,
        scale: true,
        repositoryKey: true,
        startedAt: true,
        finishedAt: true,
        outcome: true,
        counters: true,
        workItems: {
          orderBy: [{ provider: 'asc' }, { externalId: 'asc' }],
          select: { provider: true, externalId: true, externalKey: true },
        },
      },
    });
    const linkedKeys = await this.linkedWorkItemKeys(
      workspaceId,
      rows.flatMap((run) => run.workItems),
    );
    const rowsById = new Map(rows.map((run) => [run.runId, run]));
    const page = pageKeys.map((key) => {
      const run = rowsById.get(key.runId);
      if (!run) throw new InternalServerErrorException('Canonical workflow runs could not be read');
      return run;
    });
    const last = pageKeys.at(-1);
    return {
      items: page.map((run) => ({
        runId: run.runId,
        workflowId: run.workflowId,
        intent: run.intent,
        risk: run.risk,
        scale: run.scale,
        repositoryKey: run.repositoryKey,
        startedAt: nullableIso(run.startedAt),
        finishedAt: nullableIso(run.finishedAt),
        outcome: run.outcome,
        verification: verificationFact(run.counters),
        workItems: run.workItems.map((item) => ({
          ...item,
          linked: linkedKeys.has(`${item.provider}\u0000${item.externalId}`),
        })),
      })),
      nextCursor: truncated && last ? encodeDeliveryCursor(scope, [last.cursorCreatedAt, last.runId]) : null,
    };
  }

  async listRunStageOccurrences(
    workspaceId: string,
    rawTaskId: unknown,
    rawRunId: unknown,
    rawLimit?: unknown,
    rawCursor?: unknown,
  ): Promise<CursorPage<CanonicalStageOccurrence>> {
    const runId = canonicalReadRunId(rawRunId);
    const { taskId } = await this.requireCanonicalTaskContext(workspaceId, rawTaskId);
    const [run] = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT run."id"
      FROM "workflow_runs" AS run
      WHERE run."workspace_id" = CAST(${workspaceId} AS UUID)
        AND run."run_id" = ${runId}
        AND (
          run."delivery_task_id" = ${taskId}
          OR EXISTS (
            SELECT 1
            FROM "workflow_run_work_items" AS item
            INNER JOIN "task_external_refs" AS ref
              ON ref."workspace_id" = item."workspace_id"
             AND ref."provider" = item."provider"
             AND ref."external_id" = item."external_id"
            WHERE item."workspace_id" = run."workspace_id"
              AND item."workflow_run_id" = run."id"
              AND ref."delivery_task_id" = ${taskId}
          )
        )
      LIMIT 1
    `);
    if (!run) throw new NotFoundException('Canonical workflow run not found');
    const limit = deliveryPageLimit(rawLimit);
    const scope = deliveryCursorScope.runStageOccurrences(taskId, runId);
    const cursor = deliveryCursor(rawCursor, scope, ['stage_id', 'positive_integer', 'uuid'] as const);
    const rows = await this.prisma.workflowStageOccurrence.findMany({
      where: {
        workflowRunId: run.id,
        ...(cursor === null
          ? {}
          : {
              OR: [
                { stageId: { gt: cursor[0] } },
                { stageId: cursor[0], attempt: { gt: cursor[1] } },
                { stageId: cursor[0], attempt: cursor[1], id: { gt: cursor[2] } },
              ],
            }),
      },
      orderBy: [{ stageId: 'asc' }, { attempt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        stageId: true,
        attempt: true,
        startedAt: true,
        finishedAt: true,
        outcome: true,
      },
    });
    const { page, truncated } = boundedPageRows(rows, limit);
    const last = page.at(-1);
    return {
      items: page.map((stage) => ({
        occurrenceId: stage.id,
        runId,
        stageId: stage.stageId,
        attempt: stage.attempt,
        startedAt: nullableIso(stage.startedAt),
        finishedAt: nullableIso(stage.finishedAt),
        outcome: stage.outcome,
      })),
      nextCursor: truncated && last ? encodeDeliveryCursor(scope, [last.stageId, last.attempt, last.id]) : null,
    };
  }

  async listTaskCodeChanges(
    workspaceId: string,
    rawTaskId: unknown,
    rawLimit?: unknown,
    rawCursor?: unknown,
  ): Promise<CursorPage<CanonicalCodeChange>> {
    const { taskId } = await this.requireCanonicalTaskContext(workspaceId, rawTaskId);
    const limit = deliveryPageLimit(rawLimit);
    const scope = deliveryCursorScope.taskCodeChanges(taskId);
    const cursor = deliveryCursor(rawCursor, scope, ['nullable_timestamp', 'uuid'] as const);
    const cursorWhere =
      cursor === null
        ? {}
        : cursor[0] === null
          ? { codeChange: { createdAtSource: null }, codeChangeId: { gt: cursor[1] } }
          : {
              OR: [
                { codeChange: { createdAtSource: { gt: cursor[0] } } },
                {
                  codeChange: { createdAtSource: cursor[0] },
                  codeChangeId: { gt: cursor[1] },
                },
                { codeChange: { createdAtSource: null } },
              ],
            };
    const rows = await this.prisma.deliveryTaskCodeChange.findMany({
      where: { workspaceId, deliveryTaskId: taskId, ...cursorWhere },
      orderBy: [{ codeChange: { createdAtSource: { sort: 'asc', nulls: 'last' } } }, { codeChangeId: 'asc' }],
      take: limit + 1,
      select: {
        associationSource: true,
        associationSourceValue: true,
        codeChange: {
          select: {
            id: true,
            provider: true,
            repoExternalId: true,
            externalId: true,
            number: true,
            title: true,
            state: true,
            isDraft: true,
            sourceBranch: true,
            targetBranch: true,
            mergedAt: true,
            updatedAt: true,
            createdAtSource: true,
            readyForReviewAt: true,
            firstReviewAt: true,
            approvedAt: true,
            externalUrl: true,
            reviewCount: true,
            commentCount: true,
          },
        },
      },
    });
    const { page, truncated } = boundedPageRows(rows, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ codeChange, associationSource, associationSourceValue }) => ({
        id: codeChange.id,
        provider: codeChange.provider,
        repoExternalId: codeChange.repoExternalId,
        externalId: codeChange.externalId,
        number: codeChange.number,
        title: codeChange.title,
        state: codeChange.state,
        isDraft: codeChange.isDraft,
        sourceBranch: codeChange.sourceBranch,
        targetBranch: codeChange.targetBranch,
        createdAtSource: nullableIso(codeChange.createdAtSource),
        readyForReviewAt: nullableIso(codeChange.readyForReviewAt),
        firstReviewAt: nullableIso(codeChange.firstReviewAt),
        approvedAt: nullableIso(codeChange.approvedAt),
        mergedAt: nullableIso(codeChange.mergedAt),
        updatedAt: codeChange.updatedAt.toISOString(),
        associationSource: associationSource as CanonicalCodeChange['associationSource'],
        associationSourceValue,
        externalUrl: codeChange.externalUrl,
        reviewCount: codeChange.reviewCount,
        commentCount: codeChange.commentCount,
      })),
      nextCursor:
        truncated && last
          ? encodeDeliveryCursor(scope, [last.codeChange.createdAtSource?.toISOString() ?? null, last.codeChange.id])
          : null,
    };
  }

  async listTaskShipEvidence(
    workspaceId: string,
    rawTaskId: unknown,
    rawLimit?: unknown,
    rawCursor?: unknown,
  ): Promise<CursorPage<CanonicalShipEvidence>> {
    const { taskId } = await this.requireCanonicalTaskContext(workspaceId, rawTaskId);
    const limit = deliveryPageLimit(rawLimit);
    const scope = deliveryCursorScope.taskShipEvidence(taskId);
    const cursor = deliveryCursor(rawCursor, scope, ['timestamp', 'decimal'] as const);
    const rows = await this.prisma.deliveryShipEvidence.findMany({
      where: {
        workspaceId,
        deliveryTaskId: taskId,
        ...(cursor === null
          ? {}
          : {
              OR: [{ occurredAt: { gt: cursor[0] } }, { occurredAt: cursor[0], id: { gt: cursor[1] } }],
            }),
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        source: true,
        sourceKey: true,
        occurredAt: true,
        receivedAt: true,
        actorId: true,
        provider: true,
        repoExternalId: true,
        externalId: true,
      },
    });
    const { page, truncated } = boundedPageRows(rows, limit);
    const last = page.at(-1);
    return {
      items: page.map((evidence) => ({
        id: evidence.id.toString(),
        source: evidence.source as CanonicalShipEvidence['source'],
        sourceKey: evidence.sourceKey,
        occurredAt: evidence.occurredAt.toISOString(),
        receivedAt: evidence.receivedAt.toISOString(),
        actorId: evidence.actorId,
        provider: evidence.provider,
        repoExternalId: evidence.repoExternalId,
        externalId: evidence.externalId,
      })),
      nextCursor:
        truncated && last ? encodeDeliveryCursor(scope, [last.occurredAt.toISOString(), last.id.toString()]) : null,
    };
  }

  async listTaskReworkSignals(
    workspaceId: string,
    rawTaskId: unknown,
    rawLimit?: unknown,
    rawCursor?: unknown,
  ): Promise<CursorPage<CanonicalReworkSignal>> {
    const { taskId } = await this.requireCanonicalTaskContext(workspaceId, rawTaskId);
    const limit = deliveryPageLimit(rawLimit);
    const scope = deliveryCursorScope.taskReworkSignals(taskId);
    const cursor = deliveryCursor(rawCursor, scope, ['timestamp', 'decimal'] as const);
    const rows = await this.prisma.deliveryReworkSignal.findMany({
      where: {
        workspaceId,
        deliveryTaskId: taskId,
        ...(cursor === null
          ? {}
          : {
              OR: [{ occurredAt: { gt: cursor[0] } }, { occurredAt: cursor[0], id: { gt: cursor[1] } }],
            }),
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        kind: true,
        sourceKey: true,
        sourceRef: true,
        occurredAt: true,
        observedAt: true,
      },
    });
    const { page, truncated } = boundedPageRows(rows, limit);
    const last = page.at(-1);
    return {
      items: page.map((signal) => ({
        id: signal.id.toString(),
        kind: signal.kind as CanonicalReworkSignal['kind'],
        sourceKey: signal.sourceKey,
        sourceRef: signal.sourceRef,
        occurredAt: signal.occurredAt.toISOString(),
        observedAt: signal.observedAt.toISOString(),
      })),
      nextCursor:
        truncated && last ? encodeDeliveryCursor(scope, [last.occurredAt.toISOString(), last.id.toString()]) : null,
    };
  }

  async listTaskArtifacts(
    workspaceId: string,
    rawTaskId: unknown,
    rawLimit?: unknown,
    rawCursor?: unknown,
  ): Promise<CursorPage<CanonicalArtifactSummary>> {
    const { taskId } = await this.requireCanonicalTaskContext(workspaceId, rawTaskId);
    const limit = deliveryPageLimit(rawLimit);
    const scope = deliveryCursorScope.taskArtifacts(taskId);
    const cursor = deliveryCursor(rawCursor, scope, ['exact_timestamp', 'artifact_id'] as const);
    const cursorFilter =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`AND ("created_at", "id") > (CAST(${cursor[0]} AS TIMESTAMPTZ), ${cursor[1]})`;
    const keys = await this.prisma.$queryRaw<ArtifactPageKey[]>(Prisma.sql`
      SELECT
        "id",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
      FROM "delivery_artifacts"
      WHERE "workspace_id" = CAST(${workspaceId} AS UUID)
        AND "delivery_task_id" = ${taskId}
        ${cursorFilter}
      ORDER BY "created_at" ASC, "id" ASC
      LIMIT ${limit + 1}
    `);
    const { page: pageKeys, truncated } = boundedPageRows(keys, limit);
    const rows = await this.prisma.deliveryArtifact.findMany({
      where: {
        workspaceId,
        deliveryTaskId: taskId,
        id: { in: pageKeys.map((key) => key.id) },
      },
      select: {
        id: true,
        repositoryKey: true,
        kind: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        revisions: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { createdAt: true } },
        _count: { select: { revisions: true } },
      },
    });
    const rowsById = new Map(rows.map((artifact) => [artifact.id, artifact]));
    const page = pageKeys.map((key) => {
      const artifact = rowsById.get(key.id);
      if (!artifact) throw new InternalServerErrorException('Canonical delivery artifacts could not be read');
      return artifact;
    });
    const last = pageKeys.at(-1);
    return {
      items: page.map((artifact) => {
        const revisionUpdatedAt = artifact.revisions[0]?.createdAt;
        const updatedAt =
          revisionUpdatedAt && revisionUpdatedAt.getTime() > artifact.updatedAt.getTime()
            ? revisionUpdatedAt
            : artifact.updatedAt;
        return {
          id: artifact.id,
          repositoryKey: artifact.repositoryKey,
          kind: artifact.kind as CanonicalArtifactSummary['kind'],
          createdBy: artifact.createdBy,
          createdAt: artifact.createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
          revisionCount: artifact._count.revisions,
        };
      }),
      nextCursor: truncated && last ? encodeDeliveryCursor(scope, [last.cursorCreatedAt, last.id]) : null,
    };
  }

  async listTasks(workspaceId: string) {
    const tasks = await this.prisma.deliveryTask.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        repositoryKey: true,
        lifecycle: true,
        authority: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        externalRefs: {
          orderBy: [{ provider: 'asc' }, { externalId: 'asc' }],
          select: EXTERNAL_REF_SELECT,
        },
        artifacts: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            ...ARTIFACT_IDENTITY_SELECT,
            createdAt: true,
            updatedAt: true,
            revisions: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: REVISION_METADATA_SELECT,
            },
          },
        },
        workflowRuns: {
          orderBy: [{ createdAt: 'asc' }, { runId: 'asc' }],
          select: LEGACY_WORKFLOW_RUN_SELECT,
        },
      },
    });

    const taskIds = tasks.map((task) => task.id);
    const relationLinks =
      taskIds.length === 0
        ? []
        : await this.prisma.$queryRaw<TaskWorkflowRunLinkRow[]>(Prisma.sql`
            SELECT DISTINCT ref."delivery_task_id" AS "taskId", run."run_id" AS "runId"
            FROM "workflow_run_work_items" AS item
            INNER JOIN "task_external_refs" AS ref
              ON ref."workspace_id" = item."workspace_id"
             AND ref."provider" = item."provider"
             AND ref."external_id" = item."external_id"
            INNER JOIN "workflow_runs" AS run
              ON run."workspace_id" = item."workspace_id"
             AND run."id" = item."workflow_run_id"
            WHERE item."workspace_id" = CAST(${workspaceId} AS UUID)
              AND ref."delivery_task_id" IN (${Prisma.join(taskIds)})
          `);
    const relationRunIds = [...new Set(relationLinks.map((link) => link.runId))];
    const relationRuns =
      relationRunIds.length === 0
        ? []
        : await this.prisma.workflowRun.findMany({
            where: { workspaceId, runId: { in: relationRunIds } },
            select: LEGACY_WORKFLOW_RUN_SELECT,
          });
    const relationRunsById = new Map(relationRuns.map((run) => [run.runId, run]));
    const relationRunsByTask = new Map<string, typeof relationRuns>();
    for (const link of relationLinks) {
      const run = relationRunsById.get(link.runId);
      if (run) relationRunsByTask.set(link.taskId, [...(relationRunsByTask.get(link.taskId) ?? []), run]);
    }

    return {
      tasks: tasks.map((task) => {
        const runsById = new Map(
          [...task.workflowRuns, ...(relationRunsByTask.get(task.id) ?? [])].map((run) => [run.runId, run]),
        );
        const workflowRuns = [...runsById.values()].sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() || left.runId.localeCompare(right.runId),
        );
        return {
          id: task.id,
          repositoryKey: task.repositoryKey,
          lifecycle: task.lifecycle,
          authority: task.authority,
          createdBy: task.createdBy,
          createdAt: task.createdAt.toISOString(),
          updatedAt: task.updatedAt.toISOString(),
          externalRefs: task.externalRefs,
          artifacts: task.artifacts.map((artifact) => ({
            id: artifact.id,
            taskId: artifact.deliveryTaskId,
            repositoryKey: artifact.repositoryKey,
            kind: artifact.kind,
            createdAt: artifact.createdAt.toISOString(),
            updatedAt: (
              artifact.revisions[artifact.revisions.length - 1]?.createdAt ?? artifact.updatedAt
            ).toISOString(),
            revisions: artifact.revisions.map((revision) => ({
              id: revision.id,
              sha256: revision.sha256,
              byteCount: revision.byteCount,
              checkpoint: revision.checkpoint,
              runId: revision.runId,
              createdAt: revision.createdAt.toISOString(),
            })),
          })),
          workflowRuns: workflowRuns.map((run) => {
            const declaration = Array.isArray(run.declaredStages)
              ? (run.declaredStages as unknown as Array<{ stageId: string; after: string[] }>)
              : null;
            const declarationOrder = new Map(declaration?.map((stage, index) => [stage.stageId, index]) ?? []);
            const stageOccurrences = [...run.stageOccurrences].sort((left, right) => {
              const stageOrder =
                (declarationOrder.get(left.stageId) ?? Number.MAX_SAFE_INTEGER) -
                (declarationOrder.get(right.stageId) ?? Number.MAX_SAFE_INTEGER);
              return stageOrder || left.attempt - right.attempt || left.id.localeCompare(right.id);
            });
            return {
              runId: run.runId,
              actorId: run.actorId,
              workflowId: run.workflowId,
              intent: run.intent,
              risk: run.risk,
              scale: run.scale,
              repositoryKey: run.repositoryKey,
              declaredStages: declaration,
              startedAt: run.startedAt?.toISOString() ?? null,
              finishedAt: run.finishedAt?.toISOString() ?? null,
              outcome: run.outcome,
              stageOccurrences: stageOccurrences.map((stage) => ({
                occurrenceId: stage.id,
                stageId: stage.stageId,
                attempt: stage.attempt,
                startedAt: stage.startedAt?.toISOString() ?? null,
                finishedAt: stage.finishedAt?.toISOString() ?? null,
                outcome: stage.outcome,
              })),
            };
          }),
        };
      }),
    };
  }
}
