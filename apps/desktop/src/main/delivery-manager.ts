/**
 * Desktop MAIN-process boundary for canonical Delivery reads. Only bounded,
 * validated fields cross IPC and transport errors collapse to closed codes.
 * This surface is strictly read-only; external links are validated in MAIN.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { shell, type IpcMain } from 'electron';
import { validateAnalyticsWindow } from './analytics-window.js';
import { externalHttpsUrl } from '../shared/external-url.js';
import {
  ApiError,
  getCanonicalArtifactRevisions,
  getCanonicalExternalRefStateHistory,
  getCanonicalDeliveryTasks,
  getCanonicalRunStageOccurrences,
  getCanonicalTaskArtifacts,
  getCanonicalTaskCodeChanges,
  getCanonicalTaskDetail,
  getCanonicalTaskExternalRefs,
  getCanonicalTaskReworkSignals,
  getCanonicalTaskRuns,
  getCanonicalTaskShipEvidence,
  getCanonicalTaskSummaries,
  getDeliverySummary,
} from './server-api.js';
import {
  CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED,
  CANONICAL_DELIVERY_UNAVAILABLE,
  IpcChannels,
  type CanonicalArtifactItem,
  type CanonicalArtifactRevisionMetadata,
  type CanonicalArtifactRevisionsResponse,
  type CanonicalAuthority,
  type CanonicalCodeChangeItem,
  type CanonicalCursorPage,
  type CanonicalDeclaredStage,
  type CanonicalDeliveryArtifact,
  type CanonicalDeliveryOutcome,
  type CanonicalDeliveryTask,
  type CanonicalDeliveryTasksResponse,
  type CanonicalDeliverySummary,
  type CanonicalExternalRefItem,
  type CanonicalExternalRefStateFactItem,
  type CanonicalReworkSignalItem,
  type CanonicalRunItem,
  type CanonicalRunVerification,
  type CanonicalShipEvidenceItem,
  type CanonicalStageOccurrence,
  type CanonicalStageOccurrenceItem,
  type CanonicalTaskDetail,
  type CanonicalTaskExternalRef,
  type CanonicalTaskSummary,
  type CanonicalTaskSummariesResponse,
  type CanonicalWorkflowRun,
  type CanonicalWorkflowOutcome,
  type DeliveryExternalTarget,
  type DeliveryLifecycleFilter,
  type SampledMedian,
  MAX_ANALYTICS_DAYS,
} from '../shared/ipc-types.js';

/**
 * A GitHub `owner/name` slug: word chars, dot, dash — and exactly one separating
 * slash. Each half must not be all-dots (rejects `../..`, `owner/..`), so a
 * traversal-looking descriptor never composes even though the host is pinned.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^cdt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACT_ID_RE = /^cda_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;
const COMPACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;
const WORK_ITEM_PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const WORK_ITEM_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+%=-]{0,255}$/;
const DECIMAL_ID_RE = /^[1-9][0-9]{0,18}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_CANONICAL_PAGE_SIZE = 100;
const MAX_CANONICAL_CURSOR_LENGTH = 2_048;
// The v2 reads are not paginated yet. Fail closed instead of truncating facts or
// letting a malformed server response allocate unbounded renderer state.
const MAX_TASKS = 1_000;
const MAX_EXTERNAL_REFS = 32;
const MAX_RUNS_PER_TASK = 1_000;
const MAX_DECLARED_STAGES = 32;
const MAX_STAGE_OCCURRENCES = 32_000;
// This is historical task state, not the current artifact-config fan-out (16).
// Config rotation can legitimately leave many more artifacts attached to one task.
const MAX_HISTORICAL_ARTIFACTS_PER_TASK = 256;
const MAX_REVISIONS_PER_ARTIFACT = 1_000;
const MAX_WORK_ITEMS_PER_RUN = 8;
const MAX_MARKDOWN_BYTES = 1_048_576;
const DELIVERY_LIFECYCLE_FILTERS = [
  'all',
  'shipped',
  'active',
  'rework',
  'runs',
] as const satisfies readonly DeliveryLifecycleFilter[];
// One row per declared stage of a workflow; MAX_DECLARED_STAGES (32) per run,
// doubled as headroom for a workspace running more than one workflow shape.
const MAX_SUMMARY_STAGES = 64;
const REWORK_SOURCE_KINDS = ['tracker_reopened', 'review_changes_requested', 'review_commented'] as const;
// Every kind a stored rework row can carry: the counted sources plus the legacy
// `stage_reentry`, which no figure counts but which older rows still hold.
const REWORK_SIGNAL_KINDS = [...REWORK_SOURCE_KINDS, 'stage_reentry'] as const;
const SHIP_STATES = ['none', 'partial', 'shipped'] as const;
// A WorkOS user id is far shorter; this is the same generous ceiling the contract
// puts on the wire so a hostile renderer cannot smuggle a payload through it.
const MAX_MEMBER_ID_LENGTH = 256;

/**
 * A provenance URL inside a canonical response: the shared open-policy plus the
 * stricter rule this projection has always had — no query, no fragment. These
 * are canonical resource links the server composed (a PR, an issue), and a
 * query or fragment on one means the row is not what it claims to be.
 */
function cleanHttpsUrl(value: unknown): string {
  const url = externalHttpsUrl(value);
  // `new URL` reports no query for `https://host?` and no fragment for
  // `https://host#`, so the raw string is checked too.
  if (url === null || url.includes('?') || url.includes('#')) throw new TypeError('Invalid canonical response');
  return url;
}

/**
 * Trusted-compose: turn a renderer-supplied SAFE descriptor into an absolute URL,
 * or `null` when it fails validation. Pure and exported so validation is
 * unit-tested without touching shell.
 *
 * Gated on the shared open policy, not the stricter `cleanHttpsUrl` above: the
 * renderer gates its links on the same predicate, and a main process that
 * refused more would make links that look clickable do nothing. Main still
 * validates rather than trusting the string, so a compromised renderer cannot
 * reach another scheme, a credentialed host, or the local filesystem.
 */
export function composeDeliveryUrl(target: DeliveryExternalTarget): string | null {
  return externalHttpsUrl(target.externalUrl);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid canonical response');
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum = 4_096): string {
  if (typeof value !== 'string' || value.length > maximum) throw new TypeError('Invalid canonical response');
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

function nullableBoundedString(value: unknown, maximum: number): string | null {
  return value === null ? null : string(value, maximum);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Invalid canonical response');
  return value;
}

/**
 * The delivery member filter at the trust boundary. `mine` is sugar for the
 * caller's own id, so the two are mutually exclusive — a request carrying both is
 * a renderer bug, and answering it would silently pick a scope for the user.
 */
function memberFilter(mine: unknown, userId: unknown): { mine: boolean; userId: string | null } {
  const scoped = boolean(mine);
  if (userId === null || userId === undefined) return { mine: scoped, userId: null };
  const id = string(userId, MAX_MEMBER_ID_LENGTH);
  if (id.length === 0 || scoped) throw new TypeError('Invalid delivery member filter');
  return { mine: scoped, userId: id };
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError('Invalid canonical response');
  }
  return value as number;
}

function nullableInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return value === null ? null : integer(value, minimum, maximum);
}

function nullableFiniteNumber(value: unknown, minimum = 0): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError('Invalid canonical response');
  }
  return value;
}

function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError('Invalid canonical response');
  return value;
}

function matching(value: unknown, pattern: RegExp): string {
  const candidate = string(value);
  if (!pattern.test(candidate)) throw new TypeError('Invalid canonical response');
  return candidate;
}

function cursor(value: unknown): string {
  const candidate = string(value, MAX_CANONICAL_CURSOR_LENGTH);
  if (candidate.length === 0 || !/^[A-Za-z0-9_-]+$/.test(candidate)) {
    throw new TypeError('Invalid canonical response');
  }
  return candidate;
}

function nullableCursor(value: unknown): string | null {
  return value === null ? null : cursor(value);
}

function canonicalPageRequest(limit: unknown, rawCursor: unknown): { limit: number; cursor?: string } {
  const boundedLimit = integer(limit, 1, MAX_CANONICAL_PAGE_SIZE);
  return rawCursor === undefined ? { limit: boundedLimit } : { limit: boundedLimit, cursor: cursor(rawCursor) };
}

function canonicalWorkspaceId(value: unknown): string {
  return matching(value, UUID_RE);
}

function timestamp(value: unknown): string {
  const candidate = matching(value, ISO_TIMESTAMP_RE);
  const year = Number(candidate.slice(0, 4));
  const month = Number(candidate.slice(5, 7));
  const day = Number(candidate.slice(8, 10));
  const hour = Number(candidate.slice(11, 13));
  const minute = Number(candidate.slice(14, 16));
  const second = Number(candidate.slice(17, 19));
  const maximumDay =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (month < 1 || month > 12 || day < 1 || day > maximumDay || hour > 23 || minute > 59 || second > 59) {
    throw new TypeError('Invalid canonical response');
  }
  if (!Number.isFinite(Date.parse(candidate))) throw new TypeError('Invalid canonical response');
  return candidate;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function member<T extends string>(value: unknown, values: readonly T[]): T {
  const candidate = string(value);
  if (!values.includes(candidate as T)) throw new TypeError('Invalid canonical response');
  return candidate as T;
}

function nullableOutcome(value: unknown): CanonicalDeliveryOutcome | null {
  return value === null ? null : member(value, ['success', 'failed', 'blocked', 'abandoned'] as const);
}

function nullableWorkflowOutcome(value: unknown): CanonicalWorkflowOutcome | null {
  return value === null ? null : member(value, ['success', 'failed', 'blocked', 'abandoned', 'unknown'] as const);
}

function projectExternalRef(value: unknown): CanonicalTaskExternalRef {
  const ref = object(value);
  return {
    provider: string(ref.provider, 64),
    externalId: string(ref.externalId, 256),
    externalKey: nullableString(ref.externalKey),
    externalUrl: nullableString(ref.externalUrl),
    externalState: nullableString(ref.externalState),
  };
}

function projectDeclaredStage(value: unknown): CanonicalDeclaredStage {
  const stage = object(value);
  return {
    stageId: matching(stage.stageId, COMPACT_ID_RE),
    after: list(stage.after, MAX_DECLARED_STAGES - 1).map((dependency) => matching(dependency, COMPACT_ID_RE)),
  };
}

function projectStageOccurrence(value: unknown): CanonicalStageOccurrence {
  const occurrence = object(value);
  return {
    occurrenceId: matching(occurrence.occurrenceId, UUID_RE),
    stageId: matching(occurrence.stageId, COMPACT_ID_RE),
    attempt: integer(occurrence.attempt, 1, 1_000),
    startedAt: nullableTimestamp(occurrence.startedAt),
    finishedAt: nullableTimestamp(occurrence.finishedAt),
    outcome: nullableOutcome(occurrence.outcome),
  };
}

function projectWorkflowRun(value: unknown): CanonicalWorkflowRun {
  const run = object(value);
  return {
    runId: matching(run.runId, RUN_ID_RE),
    actorId: string(run.actorId),
    workflowId: nullableString(run.workflowId),
    intent: nullableString(run.intent),
    risk: nullableString(run.risk),
    scale: nullableString(run.scale),
    repositoryKey: nullableString(run.repositoryKey),
    declaredStages:
      run.declaredStages === null
        ? null
        : list(run.declaredStages, MAX_DECLARED_STAGES).map((stage) => projectDeclaredStage(stage)),
    startedAt: nullableTimestamp(run.startedAt),
    finishedAt: nullableTimestamp(run.finishedAt),
    outcome: nullableWorkflowOutcome(run.outcome),
    stageOccurrences: list(run.stageOccurrences, MAX_STAGE_OCCURRENCES).map(projectStageOccurrence),
  };
}

function projectRevisionMetadata(value: unknown): CanonicalArtifactRevisionMetadata {
  const revision = object(value);
  return {
    id: matching(revision.id, UUID_RE),
    sha256: matching(revision.sha256, SHA256_RE),
    byteCount: integer(revision.byteCount, 0, MAX_MARKDOWN_BYTES),
    checkpoint: member(revision.checkpoint, ['run-finish', 'session-end', 'session-start-reconcile'] as const),
    runId: revision.runId === null ? null : matching(revision.runId, RUN_ID_RE),
    createdAt: timestamp(revision.createdAt),
  };
}

function projectArtifact(value: unknown): CanonicalDeliveryArtifact {
  const artifact = object(value);
  return {
    id: matching(artifact.id, ARTIFACT_ID_RE),
    taskId: matching(artifact.taskId, TASK_ID_RE),
    repositoryKey: string(artifact.repositoryKey),
    kind: member(artifact.kind, ['spec', 'design', 'implementation_issue'] as const),
    createdAt: timestamp(artifact.createdAt),
    updatedAt: timestamp(artifact.updatedAt),
    revisions: list(artifact.revisions, MAX_REVISIONS_PER_ARTIFACT).map(projectRevisionMetadata),
  };
}

function projectTask(value: unknown): CanonicalDeliveryTask {
  const task = object(value);
  return {
    id: matching(task.id, TASK_ID_RE),
    repositoryKey: nullableString(task.repositoryKey),
    lifecycle: member(task.lifecycle, ['active', 'completed', 'abandoned'] as const),
    authority: string(task.authority),
    createdBy: string(task.createdBy),
    createdAt: timestamp(task.createdAt),
    updatedAt: timestamp(task.updatedAt),
    externalRefs: list(task.externalRefs, MAX_EXTERNAL_REFS).map(projectExternalRef),
    workflowRuns: list(task.workflowRuns, MAX_RUNS_PER_TASK).map(projectWorkflowRun),
    artifacts: list(task.artifacts, MAX_HISTORICAL_ARTIFACTS_PER_TASK).map(projectArtifact),
  };
}

function projectCanonicalTasks(value: unknown): CanonicalDeliveryTasksResponse {
  return { tasks: list(object(value).tasks, MAX_TASKS).map(projectTask) };
}

function projectAuthority(value: unknown): CanonicalAuthority {
  const authority = object(value);
  const kind = member(authority.kind, ['coredoc', 'external_ref'] as const);
  if (kind === 'coredoc') return { kind };
  return {
    kind,
    externalRefId: matching(authority.externalRefId, DECIMAL_ID_RE),
    provider: string(authority.provider, 64),
    externalId: string(authority.externalId, 256),
    externalKey: nullableBoundedString(authority.externalKey, 256),
    connected: boolean(authority.connected),
    sourceCreatedAt: nullableTimestamp(authority.sourceCreatedAt),
  };
}

function projectCounts(value: unknown) {
  const counts = object(value);
  return {
    externalRefs: integer(counts.externalRefs),
    workflowRuns: integer(counts.workflowRuns),
    codeChanges: integer(counts.codeChanges),
    // Tolerant: the merged/open split arrived with the partial-ship widening; a
    // server that predates it omits both, which is an older server, not a hostile
    // payload. Present-but-malformed still fails the envelope.
    mergedCodeChanges: counts.mergedCodeChanges === undefined ? 0 : integer(counts.mergedCodeChanges),
    openCodeChanges: counts.openCodeChanges === undefined ? 0 : integer(counts.openCodeChanges),
    shipEvidence: integer(counts.shipEvidence),
    reworkSignals: integer(counts.reworkSignals),
    artifacts: integer(counts.artifacts),
  };
}

function projectTaskSummary(value: unknown): CanonicalTaskSummary {
  const task = object(value);
  const everShipped = boolean(task.everShipped);
  return {
    id: matching(task.id, TASK_ID_RE),
    title: nullableBoundedString(task.title, 512),
    repositoryKey: nullableBoundedString(task.repositoryKey, 256),
    lifecycle: member(task.lifecycle, ['active', 'completed', 'abandoned'] as const),
    authority: projectAuthority(task.authority),
    createdBy: string(task.createdBy),
    createdAt: timestamp(task.createdAt),
    updatedAt: timestamp(task.updatedAt),
    everShipped,
    lastShippedAt: nullableTimestamp(task.lastShippedAt),
    // Tolerant: `shipState` arrived with the partial-ship widening. An older
    // server only knows "shipped or not", which is exactly what `everShipped`
    // already says — it can never mean `partial`.
    shipState: task.shipState === undefined ? (everShipped ? 'shipped' : 'none') : member(task.shipState, SHIP_STATES),
    counts: projectCounts(task.counts),
  };
}

function projectTaskSummaries(value: unknown, limit: number): CanonicalTaskSummariesResponse {
  const response = object(value);
  return {
    tasks: list(response.tasks, limit).map(projectTaskSummary),
    nextCursor: nullableCursor(response.nextCursor),
  };
}

function projectTaskDetail(value: unknown, expectedTaskId: string): CanonicalTaskDetail {
  const response = object(value);
  const summary = projectTaskSummary(response);
  if (summary.id !== expectedTaskId) throw new TypeError('Invalid canonical response');
  const retention = object(response.fineEventRetention);
  const estimatedCost = object(response.estimatedCost);
  return {
    ...summary,
    fineEventRetention: {
      policyDays: integer(retention.policyDays, 90, 90) as 90,
      purgedThroughReceivedAt: nullableTimestamp(retention.purgedThroughReceivedAt),
    },
    estimatedCost: {
      totalUsd: nullableFiniteNumber(estimatedCost.totalUsd),
      sessions: integer(estimatedCost.sessions),
      unpricedSessions: integer(estimatedCost.unpricedSessions),
      // Tolerant: an older server predating this field omits it. Defaulting to 0
      // (rather than failing the whole task-detail projection) keeps a version-skew
      // desktop>server pairing working — the field is additive, never authoritative.
      sessionsWithoutUsage:
        estimatedCost.sessionsWithoutUsage === undefined ? 0 : integer(estimatedCost.sessionsWithoutUsage),
    },
  };
}

function projectCursorPage<T>(value: unknown, limit: number, projector: (item: unknown) => T): CanonicalCursorPage<T> {
  const response = object(value);
  return {
    items: list(response.items, limit).map(projector),
    nextCursor: nullableCursor(response.nextCursor),
  };
}

function projectExternalRefItem(value: unknown): CanonicalExternalRefItem {
  const ref = object(value);
  return {
    id: matching(ref.id, DECIMAL_ID_RE),
    provider: string(ref.provider, 64),
    externalId: string(ref.externalId, 256),
    externalKey: nullableBoundedString(ref.externalKey, 256),
    externalUrl: ref.externalUrl === null ? null : cleanHttpsUrl(ref.externalUrl),
    externalState: nullableBoundedString(ref.externalState, 128),
    connectorId: ref.connectorId === null ? null : matching(ref.connectorId, UUID_RE),
    sourceUpdatedAt: nullableTimestamp(ref.sourceUpdatedAt),
    lastObservedAt: nullableTimestamp(ref.lastObservedAt),
    isAuthority: boolean(ref.isAuthority),
    stateFactCount: integer(ref.stateFactCount),
  };
}

function projectExternalRefStateFactItem(value: unknown): CanonicalExternalRefStateFactItem {
  const fact = object(value);
  return {
    id: matching(fact.id, DECIMAL_ID_RE),
    fromState: nullableBoundedString(fact.fromState, 128),
    toState: string(fact.toState, 128),
    sourceRef: string(fact.sourceRef, 512),
    occurredAt: timestamp(fact.occurredAt),
    sourceUpdatedAt: timestamp(fact.sourceUpdatedAt),
    receivedAt: timestamp(fact.receivedAt),
    actorId: nullableString(fact.actorId),
  };
}

function projectVerification(value: unknown): CanonicalRunVerification | null {
  if (value === null) return null;
  const verification = object(value);
  return {
    runs: nullableInteger(verification.runs),
    failures: nullableInteger(verification.failures),
    editVerifyRounds: nullableInteger(verification.editVerifyRounds),
  };
}

function projectRunWorkItem(value: unknown) {
  const workItem = object(value);
  return {
    provider: matching(workItem.provider, WORK_ITEM_PROVIDER_RE),
    externalId: matching(workItem.externalId, WORK_ITEM_VALUE_RE),
    externalKey: workItem.externalKey === null ? null : matching(workItem.externalKey, WORK_ITEM_VALUE_RE),
    linked: boolean(workItem.linked),
  };
}

function projectRunItem(value: unknown): CanonicalRunItem {
  const run = object(value);
  return {
    runId: matching(run.runId, RUN_ID_RE),
    workflowId: nullableBoundedString(run.workflowId, 76),
    intent: nullableBoundedString(run.intent, 32),
    risk: nullableBoundedString(run.risk, 16),
    scale: nullableBoundedString(run.scale, 16),
    repositoryKey: nullableBoundedString(run.repositoryKey, 256),
    startedAt: nullableTimestamp(run.startedAt),
    finishedAt: nullableTimestamp(run.finishedAt),
    outcome: nullableWorkflowOutcome(run.outcome),
    verification: projectVerification(run.verification),
    workItems: list(run.workItems, MAX_WORK_ITEMS_PER_RUN).map(projectRunWorkItem),
  };
}

function projectStageOccurrenceItem(value: unknown, expectedRunId: string): CanonicalStageOccurrenceItem {
  const occurrence = object(value);
  const runId = matching(occurrence.runId, RUN_ID_RE);
  if (runId !== expectedRunId) throw new TypeError('Invalid canonical response');
  return {
    occurrenceId: matching(occurrence.occurrenceId, UUID_RE),
    runId,
    stageId: matching(occurrence.stageId, COMPACT_ID_RE),
    attempt: integer(occurrence.attempt, 1, 1_000),
    startedAt: nullableTimestamp(occurrence.startedAt),
    finishedAt: nullableTimestamp(occurrence.finishedAt),
    outcome: nullableOutcome(occurrence.outcome),
  };
}

/**
 * A code-change row's `externalUrl` is not authority-critical the way an
 * external-ref's is (S4): the row still renders, minus its link, when the
 * stored URL fails `cleanHttpsUrl`'s strict check. Mirrors the
 * `composeDeliveryUrl` degrade-to-null pattern above, so one malformed row
 * cannot fail the whole `projectCursorPage` map and reject the entire page.
 */
function projectCodeChangeExternalUrl(value: unknown): string | null {
  if (value == null) return null;
  try {
    return cleanHttpsUrl(value);
  } catch {
    return null;
  }
}

/**
 * Additive PR lifecycle marks. Tolerant of absence on purpose: a server
 * predating them omits the field, and defaulting to `null` (rather than
 * failing the whole page) keeps a desktop>server skew working — the marks are
 * evidence, never authoritative. A present-but-malformed value still throws.
 * Precedent: `sessionsWithoutUsage` in `projectTaskDetail`.
 */
function tolerantTimestamp(value: unknown): string | null {
  return value === undefined ? null : nullableTimestamp(value);
}

function projectCodeChangeItem(value: unknown): CanonicalCodeChangeItem {
  const change = object(value);
  return {
    id: matching(change.id, UUID_RE),
    provider: string(change.provider, 64),
    repoExternalId: string(change.repoExternalId, 256),
    externalId: string(change.externalId, 256),
    number: nullableInteger(change.number, 1),
    title: nullableString(change.title),
    state: member(change.state, ['open', 'merged', 'closed'] as const),
    isDraft: boolean(change.isDraft),
    sourceBranch: nullableString(change.sourceBranch),
    targetBranch: nullableString(change.targetBranch),
    createdAtSource: tolerantTimestamp(change.createdAtSource),
    readyForReviewAt: tolerantTimestamp(change.readyForReviewAt),
    firstReviewAt: tolerantTimestamp(change.firstReviewAt),
    approvedAt: tolerantTimestamp(change.approvedAt),
    mergedAt: nullableTimestamp(change.mergedAt),
    updatedAt: timestamp(change.updatedAt),
    externalUrl: projectCodeChangeExternalUrl(change.externalUrl),
    reviewCount: nullableInteger(change.reviewCount ?? null),
    commentCount: nullableInteger(change.commentCount ?? null),
    associationSource: member(change.associationSource, ['external_ref', 'issue_key', 'run_id'] as const),
    associationSourceValue: string(change.associationSourceValue, 256),
  };
}

function projectShipEvidenceItem(value: unknown): CanonicalShipEvidenceItem {
  const evidence = object(value);
  return {
    id: matching(evidence.id, DECIMAL_ID_RE),
    source: member(evidence.source, ['github_pr_merged', 'connector_transition', 'coredoc'] as const),
    sourceKey: string(evidence.sourceKey, 512),
    occurredAt: timestamp(evidence.occurredAt),
    receivedAt: timestamp(evidence.receivedAt),
    actorId: nullableString(evidence.actorId),
    provider: nullableBoundedString(evidence.provider, 64),
    repoExternalId: nullableBoundedString(evidence.repoExternalId, 256),
    externalId: nullableBoundedString(evidence.externalId, 256),
  };
}

function projectReworkSignalItem(value: unknown): CanonicalReworkSignalItem {
  const signal = object(value);
  return {
    id: matching(signal.id, DECIMAL_ID_RE),
    kind: member(signal.kind, REWORK_SIGNAL_KINDS),
    sourceKey: string(signal.sourceKey, 512),
    sourceRef: string(signal.sourceRef, 512),
    occurredAt: timestamp(signal.occurredAt),
    observedAt: timestamp(signal.observedAt),
  };
}

function projectArtifactItem(value: unknown): CanonicalArtifactItem {
  const artifact = object(value);
  return {
    id: matching(artifact.id, ARTIFACT_ID_RE),
    repositoryKey: string(artifact.repositoryKey, 256),
    kind: member(artifact.kind, ['spec', 'design', 'implementation_issue'] as const),
    createdBy: string(artifact.createdBy),
    createdAt: timestamp(artifact.createdAt),
    updatedAt: timestamp(artifact.updatedAt),
    revisionCount: integer(artifact.revisionCount),
  };
}

function projectArtifactRevisions(value: unknown, expectedArtifactId: string): CanonicalArtifactRevisionsResponse {
  const response = object(value);
  const artifact = object(response.artifact);
  const artifactId = matching(artifact.id, ARTIFACT_ID_RE);
  if (artifactId !== expectedArtifactId) throw new TypeError('Invalid canonical response');
  return {
    artifact: {
      id: artifactId,
      taskId: matching(artifact.taskId, TASK_ID_RE),
      repositoryKey: string(artifact.repositoryKey),
      kind: member(artifact.kind, ['spec', 'design', 'implementation_issue'] as const),
    },
    revisions: list(response.revisions, MAX_REVISIONS_PER_ARTIFACT).map((value) => {
      const revision = object(value);
      const markdown = string(revision.markdown, MAX_MARKDOWN_BYTES);
      const metadata = projectRevisionMetadata(revision);
      const byteCount = Buffer.byteLength(markdown, 'utf8');
      const sha256 = createHash('sha256').update(markdown, 'utf8').digest('hex');
      if (byteCount > MAX_MARKDOWN_BYTES || metadata.byteCount !== byteCount || metadata.sha256 !== sha256) {
        throw new TypeError('Invalid canonical response');
      }
      return { ...metadata, markdown };
    }),
  };
}

function projectSampledMedian(value: unknown): SampledMedian {
  const median = object(value);
  return { value: nullableFiniteNumber(median.value), sampleSize: integer(median.sampleSize) };
}

function projectDeliverySummary(value: unknown): CanonicalDeliverySummary {
  const summary = object(value);
  const window = object(summary.window);
  const tasks = object(summary.tasks);
  const cost = object(summary.costPerShippedTaskUsd);
  // Tolerant: `window.until`, `window.userId`, `tasks.partiallyShipped`, the whole
  // per-source rework block and the per-stage `incomplete`/`inProgress` counts arrived
  // with the custom-range, member-filter, partial-ship and run-completeness widenings.
  // A server that predates them omits them, which is an older server, not a hostile
  // payload. Present-but-malformed still fails the envelope, so a wrong shape never
  // reaches the renderer as a default.
  const rework = summary.rework === undefined ? {} : object(summary.rework);
  const bySource = rework.bySource ?? REWORK_SOURCE_KINDS.map((kind) => ({ kind, signals: 0, tasks: 0 }));
  const since = timestamp(window.since);
  return {
    window: {
      days: integer(window.days, 1, MAX_ANALYTICS_DAYS),
      since,
      until: window.until === undefined ? since : timestamp(window.until),
      lifecycle: member(window.lifecycle, DELIVERY_LIFECYCLE_FILTERS),
      userId: window.userId === undefined ? null : nullableBoundedString(window.userId, MAX_MEMBER_ID_LENGTH),
    },
    tasks: {
      matching: integer(tasks.matching),
      shipped: integer(tasks.shipped),
      partiallyShipped: tasks.partiallyShipped === undefined ? 0 : integer(tasks.partiallyShipped),
      withRework: integer(tasks.withRework),
      active: integer(tasks.active),
    },
    leadTimeMs: projectSampledMedian(summary.leadTimeMs),
    reviewStageMs: projectSampledMedian(summary.reviewStageMs),
    costPerShippedTaskUsd: {
      ...projectSampledMedian(cost),
      unpricedTasks: integer(cost.unpricedTasks),
    },
    stages: list(summary.stages, MAX_SUMMARY_STAGES).map((entry) => {
      const stage = object(entry);
      return {
        stageId: matching(stage.stageId, COMPACT_ID_RE),
        claimedMs: projectSampledMedian(stage.claimedMs),
        // `== null` on purpose: an explicit null is absence too (the shape `nullableInteger`
        // accepts elsewhere), while any other malformed value still fails the envelope.
        incomplete: stage.incomplete == null ? 0 : integer(stage.incomplete),
        inProgress: stage.inProgress == null ? 0 : integer(stage.inProgress),
      };
    }),
    unclaimedMs: projectSampledMedian(summary.unclaimedMs),
    reviewWaitMs: projectSampledMedian(summary.reviewWaitMs),
    editVerifyRoundsPerRun: projectSampledMedian(summary.editVerifyRoundsPerRun),
    rework: {
      // One row per counted source, always all three (zero-filled by the server).
      bySource: list(bySource, REWORK_SOURCE_KINDS.length).map((entry) => {
        const source = object(entry);
        return {
          kind: member(source.kind, REWORK_SOURCE_KINDS),
          signals: integer(source.signals),
          tasks: integer(source.tasks),
        };
      }),
    },
  };
}

function canonicalError(
  error: unknown,
): typeof CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED | typeof CANONICAL_DELIVERY_UNAVAILABLE {
  return error instanceof ApiError && (error.status === 401 || error.status === 403)
    ? CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED
    : CANONICAL_DELIVERY_UNAVAILABLE;
}

async function canonicalEnvelope<T>(fn: () => Promise<unknown>, project: (value: unknown) => T) {
  try {
    return { success: true, data: project(await fn()) };
  } catch (error) {
    return { success: false, error: canonicalError(error) };
  }
}

async function canonicalPagedEnvelope<T>(
  rawLimit: unknown,
  rawCursor: unknown,
  read: (limit: number, cursor?: string) => Promise<unknown>,
  project: (value: unknown, limit: number) => T,
) {
  try {
    const request = canonicalPageRequest(rawLimit, rawCursor);
    return { success: true, data: project(await read(request.limit, request.cursor), request.limit) };
  } catch (error) {
    return { success: false, error: canonicalError(error) };
  }
}

async function canonicalTaskPagedEnvelope<T>(
  rawTaskId: unknown,
  rawLimit: unknown,
  rawCursor: unknown,
  read: (taskId: string, limit: number, cursor?: string) => Promise<unknown>,
  project: (value: unknown, limit: number) => T,
) {
  try {
    const taskId = matching(rawTaskId, TASK_ID_RE);
    const request = canonicalPageRequest(rawLimit, rawCursor);
    return {
      success: true,
      data: project(await read(taskId, request.limit, request.cursor), request.limit),
    };
  } catch (error) {
    return { success: false, error: canonicalError(error) };
  }
}

async function canonicalTaskEnvelope<T>(
  rawTaskId: unknown,
  read: (taskId: string) => Promise<unknown>,
  project: (value: unknown, taskId: string) => T,
) {
  try {
    const taskId = matching(rawTaskId, TASK_ID_RE);
    return { success: true, data: project(await read(taskId), taskId) };
  } catch (error) {
    return { success: false, error: canonicalError(error) };
  }
}

export function registerDeliveryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.DELIVERY_GET_CANONICAL_TASKS, (_event, workspaceId: string) =>
    canonicalEnvelope(() => getCanonicalDeliveryTasks(workspaceId), projectCanonicalTasks),
  );

  // The window/filter are validated before the request so a malformed selector
  // never reaches the server.
  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_TASK_SUMMARIES,
    (
      _event,
      workspaceId: string,
      limit: unknown,
      cursorValue?: unknown,
      window?: unknown,
      lifecycle?: unknown,
      mine?: unknown,
      userId?: unknown,
    ) =>
      canonicalPagedEnvelope(
        limit,
        cursorValue,
        (boundedLimit, boundedCursor) => {
          const validatedWorkspaceId = canonicalWorkspaceId(workspaceId);
          // An unfiltered request stays the exact call it is today — same
          // population, same cursor scope (BR-6); the filter is appended only
          // when the renderer supplies one.
          if (window === undefined && lifecycle === undefined && mine === undefined && userId === undefined) {
            return getCanonicalTaskSummaries(validatedWorkspaceId, boundedLimit, boundedCursor);
          }
          const filter = memberFilter(mine ?? false, userId);
          return getCanonicalTaskSummaries(
            validatedWorkspaceId,
            boundedLimit,
            boundedCursor,
            window === undefined ? undefined : validateAnalyticsWindow(window),
            lifecycle === undefined ? undefined : member(lifecycle, DELIVERY_LIFECYCLE_FILTERS),
            mine === undefined ? undefined : filter.mine,
            filter.userId,
          );
        },
        projectTaskSummaries,
      ),
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_SUMMARY,
    (_event, workspaceId: string, window: unknown, lifecycle: unknown, mine: unknown, userId: unknown) =>
      canonicalEnvelope(() => {
        const filter = memberFilter(mine, userId);
        return getDeliverySummary(
          canonicalWorkspaceId(workspaceId),
          validateAnalyticsWindow(window),
          member(lifecycle, DELIVERY_LIFECYCLE_FILTERS),
          filter.mine,
          filter.userId,
        );
      }, projectDeliverySummary),
  );

  ipcMain.handle(IpcChannels.DELIVERY_GET_CANONICAL_TASK_DETAIL, (_event, workspaceId: string, taskId: unknown) =>
    canonicalTaskEnvelope(
      taskId,
      (validatedTaskId) => getCanonicalTaskDetail(canonicalWorkspaceId(workspaceId), validatedTaskId),
      projectTaskDetail,
    ),
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_TASK_EXTERNAL_REFS,
    (_event, workspaceId: string, taskId: unknown, limit: unknown, cursorValue?: unknown) =>
      canonicalTaskPagedEnvelope(
        taskId,
        limit,
        cursorValue,
        (validatedTaskId, boundedLimit, boundedCursor) =>
          getCanonicalTaskExternalRefs(canonicalWorkspaceId(workspaceId), validatedTaskId, boundedLimit, boundedCursor),
        (value, boundedLimit) => projectCursorPage(value, boundedLimit, projectExternalRefItem),
      ),
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_EXTERNAL_REF_STATE_HISTORY,
    async (
      _event,
      workspaceId: string,
      taskIdValue: unknown,
      externalRefIdValue: unknown,
      limitValue: unknown,
      cursorValue?: unknown,
    ) => {
      try {
        const validatedWorkspaceId = canonicalWorkspaceId(workspaceId);
        const taskId = matching(taskIdValue, TASK_ID_RE);
        const externalRefId = matching(externalRefIdValue, DECIMAL_ID_RE);
        const request = canonicalPageRequest(limitValue, cursorValue);
        const value = await getCanonicalExternalRefStateHistory(
          validatedWorkspaceId,
          taskId,
          externalRefId,
          request.limit,
          request.cursor,
        );
        return {
          success: true,
          data: projectCursorPage(value, request.limit, projectExternalRefStateFactItem),
        };
      } catch (error) {
        return { success: false, error: canonicalError(error) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_TASK_RUNS,
    (_event, workspaceId: string, taskId: unknown, limit: unknown, cursorValue?: unknown) =>
      canonicalTaskPagedEnvelope(
        taskId,
        limit,
        cursorValue,
        (validatedTaskId, boundedLimit, boundedCursor) =>
          getCanonicalTaskRuns(canonicalWorkspaceId(workspaceId), validatedTaskId, boundedLimit, boundedCursor),
        (value, boundedLimit) => projectCursorPage(value, boundedLimit, projectRunItem),
      ),
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_RUN_STAGE_OCCURRENCES,
    async (
      _event,
      workspaceId: string,
      taskIdValue: unknown,
      runIdValue: unknown,
      limitValue: unknown,
      cursorValue?: unknown,
    ) => {
      try {
        const validatedWorkspaceId = canonicalWorkspaceId(workspaceId);
        const taskId = matching(taskIdValue, TASK_ID_RE);
        const runId = matching(runIdValue, RUN_ID_RE);
        const request = canonicalPageRequest(limitValue, cursorValue);
        const value = await getCanonicalRunStageOccurrences(
          validatedWorkspaceId,
          taskId,
          runId,
          request.limit,
          request.cursor,
        );
        return {
          success: true,
          data: projectCursorPage(value, request.limit, (item) => projectStageOccurrenceItem(item, runId)),
        };
      } catch (error) {
        return { success: false, error: canonicalError(error) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_TASK_CODE_CHANGES,
    (_event, workspaceId: string, taskId: unknown, limit: unknown, cursorValue?: unknown) =>
      canonicalTaskPagedEnvelope(
        taskId,
        limit,
        cursorValue,
        (validatedTaskId, boundedLimit, boundedCursor) =>
          getCanonicalTaskCodeChanges(canonicalWorkspaceId(workspaceId), validatedTaskId, boundedLimit, boundedCursor),
        (value, boundedLimit) => projectCursorPage(value, boundedLimit, projectCodeChangeItem),
      ),
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_TASK_SHIP_EVIDENCE,
    (_event, workspaceId: string, taskId: unknown, limit: unknown, cursorValue?: unknown) =>
      canonicalTaskPagedEnvelope(
        taskId,
        limit,
        cursorValue,
        (validatedTaskId, boundedLimit, boundedCursor) =>
          getCanonicalTaskShipEvidence(canonicalWorkspaceId(workspaceId), validatedTaskId, boundedLimit, boundedCursor),
        (value, boundedLimit) => projectCursorPage(value, boundedLimit, projectShipEvidenceItem),
      ),
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_TASK_REWORK_SIGNALS,
    (_event, workspaceId: string, taskId: unknown, limit: unknown, cursorValue?: unknown) =>
      canonicalTaskPagedEnvelope(
        taskId,
        limit,
        cursorValue,
        (validatedTaskId, boundedLimit, boundedCursor) =>
          getCanonicalTaskReworkSignals(
            canonicalWorkspaceId(workspaceId),
            validatedTaskId,
            boundedLimit,
            boundedCursor,
          ),
        (value, boundedLimit) => projectCursorPage(value, boundedLimit, projectReworkSignalItem),
      ),
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_TASK_ARTIFACTS,
    (_event, workspaceId: string, taskId: unknown, limit: unknown, cursorValue?: unknown) =>
      canonicalTaskPagedEnvelope(
        taskId,
        limit,
        cursorValue,
        (validatedTaskId, boundedLimit, boundedCursor) =>
          getCanonicalTaskArtifacts(canonicalWorkspaceId(workspaceId), validatedTaskId, boundedLimit, boundedCursor),
        (value, boundedLimit) => projectCursorPage(value, boundedLimit, projectArtifactItem),
      ),
  );

  ipcMain.handle(
    IpcChannels.DELIVERY_GET_CANONICAL_ARTIFACT_REVISIONS,
    (_event, workspaceId: string, artifactId: string) =>
      canonicalEnvelope(
        () => getCanonicalArtifactRevisions(workspaceId, artifactId),
        (value) => projectArtifactRevisions(value, artifactId),
      ),
  );

  // Open a delivery link externally. The URL is composed/validated in MAIN from the
  // renderer's SAFE descriptor — never a raw renderer-supplied URL. An invalid
  // descriptor returns an actionable error and opens nothing (Scenario 4).
  ipcMain.handle(
    IpcChannels.DELIVERY_OPEN_EXTERNAL,
    async (_event, target: DeliveryExternalTarget): Promise<{ success: boolean; error?: string }> => {
      const url = composeDeliveryUrl(target);
      if (!url) return { success: false, error: 'Invalid link target.' };
      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
