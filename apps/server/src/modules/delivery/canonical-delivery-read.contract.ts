import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { BadRequestException } from '@nestjs/common';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_DECODED_BYTES = 1_024;
const MAX_CURSOR_ENCODED_CHARS = 2_048;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EXACT_DATABASE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^cdt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACT_ID_RE = /^cda_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;
const PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const COMPACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;
const DECIMAL_RE = /^[1-9][0-9]{0,18}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export type DeliveryCursorKeyKind =
  | 'timestamp'
  | 'exact_timestamp'
  | 'nullable_timestamp'
  | 'uuid'
  | 'task_id'
  | 'artifact_id'
  | 'run_id'
  | 'provider'
  | 'external_id'
  | 'stage_id'
  | 'positive_integer'
  | 'decimal';

type DeliveryCursorValue<Kind extends DeliveryCursorKeyKind> = Kind extends 'timestamp'
  ? Date
  : Kind extends 'exact_timestamp'
    ? string
    : Kind extends 'nullable_timestamp'
      ? Date | null
      : Kind extends 'positive_integer'
        ? number
        : Kind extends 'decimal'
          ? bigint
          : string;

export type DeliveryCursorTuple<Kinds extends readonly DeliveryCursorKeyKind[]> = {
  [Index in keyof Kinds]: Kinds[Index] extends DeliveryCursorKeyKind ? DeliveryCursorValue<Kinds[Index]> : never;
};

export type CanonicalAuthority =
  | { kind: 'coredoc' }
  | {
      kind: 'external_ref';
      externalRefId: string;
      provider: string;
      externalId: string;
      externalKey: string | null;
      connected: boolean;
      /** Tracker-issue creation instant; null for refs never observed with one. */
      sourceCreatedAt: string | null;
    };

export interface CanonicalTaskCounts {
  externalRefs: number;
  workflowRuns: number;
  codeChanges: number;
  /** Linked code changes in state `merged`. */
  mergedCodeChanges: number;
  /** Linked code changes still open (a draft PR is open); `closed` counts as neither. */
  openCodeChanges: number;
  shipEvidence: number;
  reworkSignals: number;
  artifacts: number;
}

/**
 * Ship state of a task: `shipped` only when nothing is still open. Ship evidence with an
 * open linked code change is `partial` — the task shipped something, not everything.
 */
export type CanonicalTaskShipState = 'none' | 'partial' | 'shipped';

/** The single ship-state rule, applied identically by the summary fold and the task list. */
export function deliveryShipState(everShipped: boolean, openCodeChanges: number): CanonicalTaskShipState {
  if (!everShipped) return 'none';
  return openCodeChanges > 0 ? 'partial' : 'shipped';
}

export interface CanonicalTaskSummary {
  id: string;
  repositoryKey: string | null;
  lifecycle: 'active' | 'completed' | 'abandoned';
  authority: CanonicalAuthority;
  title: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  everShipped: boolean;
  lastShippedAt: string | null;
  shipState: CanonicalTaskShipState;
  counts: CanonicalTaskCounts;
}

/**
 * The three session counters partition `sessions` exactly:
 * `sessions === priced + unpricedSessions + sessionsWithoutUsage`. A reader that shows
 * only `unpricedSessions` next to `sessions` would otherwise render the self-contradictory
 * "unpriced · 3 sessions · 0 unpriced sessions" for a task whose sessions reported no usage
 * at all.
 */
export interface CanonicalTaskEstimatedCost {
  totalUsd: number | null;
  sessions: number;
  /** Sessions with observed usage whose model has no price. */
  unpricedSessions: number;
  /** Sessions that reported no token usage at all, so pricing was never attempted. */
  sessionsWithoutUsage: number;
}

export interface CanonicalTaskDetail extends CanonicalTaskSummary {
  fineEventRetention: {
    policyDays: 90;
    purgedThroughReceivedAt: string | null;
  };
  estimatedCost: CanonicalTaskEstimatedCost;
}

export interface CursorPage<Item> {
  items: Item[];
  nextCursor: string | null;
}

export interface CanonicalTaskExternalRef {
  id: string;
  provider: string;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  externalState: string | null;
  connectorId: string | null;
  sourceUpdatedAt: string | null;
  lastObservedAt: string | null;
  isAuthority: boolean;
  stateFactCount: number;
}

export interface CanonicalExternalRefStateFact {
  id: string;
  fromState: string | null;
  toState: string;
  sourceRef: string;
  occurredAt: string;
  sourceUpdatedAt: string;
  receivedAt: string;
  actorId: string | null;
}

export interface CanonicalRunVerification {
  runs: number | null;
  failures: number | null;
  editVerifyRounds: number | null;
}

export interface CanonicalWorkflowWorkItem {
  provider: string;
  externalId: string;
  externalKey: string | null;
  linked: boolean;
}

export interface CanonicalWorkflowRun {
  runId: string;
  workflowId: string | null;
  intent: string | null;
  risk: string | null;
  scale: string | null;
  repositoryKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: string | null;
  verification: CanonicalRunVerification | null;
  workItems: CanonicalWorkflowWorkItem[];
}

export interface CanonicalStageOccurrence {
  occurrenceId: string;
  runId: string;
  stageId: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: string | null;
}

export interface CanonicalCodeChange {
  id: string;
  provider: string;
  repoExternalId: string;
  externalId: string;
  number: number | null;
  title: string | null;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  sourceBranch: string | null;
  targetBranch: string | null;
  createdAtSource: string | null;
  readyForReviewAt: string | null;
  firstReviewAt: string | null;
  approvedAt: string | null;
  mergedAt: string | null;
  updatedAt: string;
  associationSource: 'external_ref' | 'issue_key' | 'run_id';
  associationSourceValue: string;
  externalUrl: string | null;
  reviewCount: number | null;
  commentCount: number | null;
}

export interface CanonicalShipEvidence {
  id: string;
  source: 'github_pr_merged' | 'connector_transition' | 'coredoc';
  sourceKey: string;
  occurredAt: string;
  receivedAt: string;
  actorId: string | null;
  provider: string | null;
  repoExternalId: string | null;
  externalId: string | null;
}

/**
 * The rework kinds that every rework figure counts. `stage_reentry` is deliberately absent:
 * a stage re-entry is an iteration fact, not rework (see ADR-20260908-per-member-delivery-filter
 * for the surrounding product decision), so it no longer counts and is no longer produced.
 */
export const COUNTED_REWORK_KINDS = ['tracker_reopened', 'review_changes_requested', 'review_commented'] as const;

export type CountedReworkKind = (typeof COUNTED_REWORK_KINDS)[number];

export interface CanonicalReworkSignal {
  id: string;
  /** `stage_reentry` is LEGACY: no longer produced, ignored by every rework figure. */
  kind: CountedReworkKind | 'stage_reentry';
  sourceKey: string;
  sourceRef: string;
  occurredAt: string;
  observedAt: string;
}

export interface CanonicalArtifactSummary {
  id: string;
  repositoryKey: string;
  kind: 'spec' | 'design' | 'implementation_issue';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revisionCount: number;
}

export type DeliveryLifecycleFilter = 'all' | 'shipped' | 'active' | 'rework' | 'runs';

/** Cursor identity of the effective window: a rolling span, or explicit UTC calendar bounds. */
export type DeliveryWindowScope = { days: number } | { since: string; until: string };

/** Every aggregate carries the size of the sample it was folded from (BR-11). */
export interface SampledMedian {
  value: number | null;
  sampleSize: number;
}

export interface DeliveryStageMedian {
  stageId: string;
  /** Median over occurrences with both ends observed; an unfinished occurrence is never a sample. */
  claimedMs: SampledMedian;
  /** Occurrences started whose `workflow.stage.finished` never arrived within the staleness window. */
  incomplete: number;
  /** Occurrences started, still unfinished, young enough that the finish may still arrive. */
  inProgress: number;
}

export interface DeliveryReworkBySource {
  kind: CountedReworkKind;
  signals: number;
  tasks: number;
}

export interface CanonicalDeliverySummary {
  window: {
    days: number;
    since: string;
    /** Exclusive end of the window. */
    until: string;
    lifecycle: DeliveryLifecycleFilter;
    /** The workspace member the population is restricted to; null for the whole workspace. */
    userId: string | null;
  };
  tasks: { matching: number; shipped: number; partiallyShipped: number; withRework: number; active: number };
  leadTimeMs: SampledMedian;
  /** Convenience projection of the `review` entry in `stages`. */
  reviewStageMs: SampledMedian;
  costPerShippedTaskUsd: SampledMedian & { unpricedTasks: number };
  stages: DeliveryStageMedian[];
  unclaimedMs: SampledMedian;
  reviewWaitMs: SampledMedian;
  editVerifyRoundsPerRun: SampledMedian;
  /** Always one row per counted kind, zero-filled, in `COUNTED_REWORK_KINDS` order. */
  rework: { bySource: DeliveryReworkBySource[] };
}

const DELIVERY_LIFECYCLE_FILTERS: readonly DeliveryLifecycleFilter[] = ['all', 'shipped', 'active', 'rework', 'runs'];

/**
 * Unlike `parseDeliveryPageLimit` this throws the HTTP exception directly: the filter is only
 * ever read from a query string on the canonical read routes, so there is no non-HTTP caller
 * that would need a transport-free error to translate.
 */
export function parseLifecycleFilter(raw: unknown): DeliveryLifecycleFilter {
  if (raw === undefined) return 'all';
  if (typeof raw !== 'string' || !DELIVERY_LIFECYCLE_FILTERS.includes(raw as DeliveryLifecycleFilter)) {
    throw new BadRequestException(`lifecycle must be one of ${DELIVERY_LIFECYCLE_FILTERS.join(', ')}`);
  }
  return raw as DeliveryLifecycleFilter;
}

export class InvalidDeliveryCursorError extends Error {
  readonly code = 'INVALID_DELIVERY_CURSOR' as const;

  constructor() {
    super('Invalid canonical delivery cursor');
    this.name = 'InvalidDeliveryCursorError';
  }
}

export const deliveryCursorScope = {
  /**
   * The population predicate is part of the cursor identity: a key minted while paging
   * "shipped tasks updated in 30 days" must not resume a differently filtered page — which is
   * why the custom calendar range and the member filter bind here too. The unfiltered call
   * keeps the original constant so cursors issued before the filters existed still decode.
   */
  taskSummaries: (
    window: DeliveryWindowScope | null,
    lifecycle: DeliveryLifecycleFilter,
    userId: string | null = null,
  ) => {
    if (window === null && lifecycle === 'all' && userId === null) return 'task-summaries';
    const bounds =
      window === null ? 'all' : 'days' in window ? String(window.days) : `${window.since}..${window.until}`;
    return `task-summaries:${bounds}:${lifecycle}${userId === null ? '' : `:user:${userId}`}`;
  },
  taskExternalRefs: (taskId: string) => `task:${taskId}:external-refs`,
  externalRefStateHistory: (taskId: string, externalRefId: string) =>
    `task:${taskId}:external-ref:${externalRefId}:state-history`,
  taskRuns: (taskId: string) => `task:${taskId}:runs`,
  runStageOccurrences: (taskId: string, runId: string) => `task:${taskId}:run:${runId}:stage-occurrences`,
  taskCodeChanges: (taskId: string) => `task:${taskId}:code-changes`,
  taskShipEvidence: (taskId: string) => `task:${taskId}:ship-evidence`,
  taskReworkSignals: (taskId: string) => `task:${taskId}:rework-signals`,
  taskArtifacts: (taskId: string) => `task:${taskId}:artifacts`,
} as const;

function invalidCursor(): never {
  throw new InvalidDeliveryCursorError();
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) invalidCursor();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalidCursor();
  return value;
}

function exactDatabaseTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !EXACT_DATABASE_TIMESTAMP_RE.test(value) || value.startsWith('0000-')) {
    invalidCursor();
  }
  const parsed = new Date(value);
  const millisecondPrefix = `${value.slice(0, 23)}Z`;
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== millisecondPrefix) invalidCursor();
  return value;
}

function parseCursorValue(value: unknown, kind: DeliveryCursorKeyKind): bigint | Date | number | string | null {
  if (kind === 'timestamp') return new Date(exactTimestamp(value));
  if (kind === 'exact_timestamp') return exactDatabaseTimestamp(value);
  if (kind === 'nullable_timestamp') return value === null ? null : new Date(exactTimestamp(value));
  if (kind === 'positive_integer') {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000) invalidCursor();
    return value as number;
  }
  if (kind === 'decimal') {
    if (typeof value !== 'string' || !DECIMAL_RE.test(value)) invalidCursor();
    const parsed = BigInt(value);
    if (parsed > MAX_SIGNED_BIGINT) invalidCursor();
    return parsed;
  }
  if (typeof value !== 'string') invalidCursor();
  const valid =
    (kind === 'uuid' && UUID_RE.test(value)) ||
    (kind === 'task_id' && TASK_ID_RE.test(value)) ||
    (kind === 'artifact_id' && ARTIFACT_ID_RE.test(value)) ||
    (kind === 'run_id' && RUN_ID_RE.test(value)) ||
    (kind === 'provider' && PROVIDER_RE.test(value)) ||
    (kind === 'external_id' && value.length >= 1 && value.length <= 256) ||
    (kind === 'stage_id' && COMPACT_ID_RE.test(value));
  if (!valid) invalidCursor();
  return value;
}

export function parseDeliveryPageLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,2}$/.test(raw)) {
    throw new Error('limit must be an integer between 1 and 100');
  }
  const parsed = Number(raw);
  if (parsed > MAX_PAGE_LIMIT) throw new Error('limit must be an integer between 1 and 100');
  return parsed;
}

export function encodeDeliveryCursor(scope: string, key: readonly (string | number | null)[]): string {
  const decoded = JSON.stringify({ v: 1, scope, key });
  if (Buffer.byteLength(decoded, 'utf8') > MAX_CURSOR_DECODED_BYTES) {
    throw new Error('Canonical delivery cursor exceeds the decoded size bound');
  }
  const encoded = Buffer.from(decoded, 'utf8').toString('base64url');
  if (encoded.length > MAX_CURSOR_ENCODED_CHARS) {
    throw new Error('Canonical delivery cursor exceeds the encoded size bound');
  }
  return encoded;
}

export function decodeDeliveryCursor<const Kinds extends readonly DeliveryCursorKeyKind[]>(
  raw: unknown,
  expectedScope: string,
  kinds: Kinds,
): DeliveryCursorTuple<Kinds> | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > MAX_CURSOR_ENCODED_CHARS || !BASE64URL_RE.test(raw)) {
    invalidCursor();
  }

  let bytes: Buffer;
  let decoded: string;
  try {
    bytes = Buffer.from(raw, 'base64url');
    if (bytes.length > MAX_CURSOR_DECODED_BYTES || bytes.toString('base64url') !== raw) invalidCursor();
    decoded = utf8.decode(bytes);
  } catch (error) {
    if (error instanceof InvalidDeliveryCursorError) throw error;
    invalidCursor();
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded!);
  } catch {
    invalidCursor();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCursor();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !Object.hasOwn(record, 'v') ||
    !Object.hasOwn(record, 'scope') ||
    !Object.hasOwn(record, 'key') ||
    record.v !== 1 ||
    record.scope !== expectedScope ||
    !Array.isArray(record.key) ||
    record.key.length !== kinds.length
  ) {
    invalidCursor();
  }
  return record.key.map((part, index) => parseCursorValue(part, kinds[index]!)) as DeliveryCursorTuple<Kinds>;
}

export function validateCanonicalExternalRefId(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value) || BigInt(value) > MAX_SIGNED_BIGINT) {
    throw new Error('externalRefId must be a positive bounded decimal string');
  }
  return value;
}

export function validateCanonicalRunId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_RE.test(value)) {
    throw new Error('runId must use the canonical cdr-YYYYMMDD-xxxxxx format');
  }
  return value;
}
