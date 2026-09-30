const HOSTS = new Set(['claude-code', 'codex']);
const V1_EVENT_TYPES = new Set(['workflow.run.started', 'workflow.run.finished', 'capability.used']);
const V2_EVENT_TYPES = new Set([
  'workflow.run.started',
  'workflow.run.finished',
  'workflow.stage.started',
  'workflow.stage.finished',
]);
// Schema 4 exists for exactly one event: the question the agent asked the user
// and the answer it received. It is the one capture event that carries text,
// so its grammar bounds every string; the producer redacts before recording.
const V4_EVENT_TYPES = new Set(['workflow.question.answered']);
const ANSWER_KINDS = new Set(['option', 'typed']);
const MAX_QUESTIONS_PER_ASK = 4;
const MAX_QUESTION_OPTIONS = 10;
const MAX_QUESTION_HEADER_CHARS = 32;
const MAX_QUESTION_CHARS = 500;
const MAX_OPTION_LABEL_CHARS = 100;
const MAX_OPTION_DESCRIPTION_CHARS = 300;
const MAX_ANSWER_CHARS = 500;
// Every C0 control except tab and newline, plus DEL.
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const INTENTS = new Set([
  'direct',
  'diagnose',
  'design',
  'change',
  'review',
  'spec',
  'qa',
  'qa-report',
  'benchmark',
  'security',
  'browse',
  'learn',
  'retro',
]);
const RISKS = new Set(['low', 'normal', 'high']);
const SCALES = new Set(['normal', 'large']);
const CAPABILITY_KINDS = new Set(['skill', 'agent']);
const OUTCOMES = new Set(['success', 'failed', 'blocked', 'abandoned', 'unknown']);
const STAGE_OUTCOMES = new Set(['success', 'failed', 'blocked', 'abandoned']);
const PROVISIONING_STATES = new Set(['configured', 'disabled']);
const CAPTURE_HEALTH_CODE_VALUES = new Set([
  'AUTH_REJECTED',
  'UNSUPPORTED_SCHEMA_VERSION',
  'OUTBOX_PENDING',
  'OUTBOX_OVERFLOW',
  'BINDING_MISMATCH',
  'TRANSPORT_UNAVAILABLE',
  'CONFIG_CONFLICT',
  'SUPERVISOR_UNAVAILABLE',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const COMPACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;
const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const DELIVERY_TASK_ID_RE = /^cdt_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REPOSITORY_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
const PROVISIONING_REPO_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_COUNT = 1_000_000;
const MAX_DECLARED_STAGES = 32;
const MAX_STAGE_ATTEMPT = 1_000;
const MAX_WORK_ITEMS = 8;
const WORK_ITEM_PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const WORK_ITEM_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+%=-]{0,255}$/;

const STRUCTURAL_IDENTIFIER_KEYS = new Set([
  'taskId',
  'runId',
  'workflowId',
  'sessionId',
  'eventId',
  'capabilityId',
  'repositoryKey',
]);
const FORBIDDEN_KEY_PARTS = new Set([
  'task',
  'spec',
  'body',
  'prompt',
  'message',
  'command',
  'argument',
  'arguments',
  'input',
  'output',
  'response',
  'source',
  'diff',
  'file',
  'path',
  'content',
  'transcript',
]);

export type CaptureHost = 'claude-code' | 'codex';
export type WorkflowOutcome = 'success' | 'failed' | 'blocked' | 'abandoned';
export type CaptureProvisioningState = 'configured' | 'disabled';
export type CaptureHealthCode =
  | 'AUTH_REJECTED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'OUTBOX_PENDING'
  | 'OUTBOX_OVERFLOW'
  | 'BINDING_MISMATCH'
  | 'TRANSPORT_UNAVAILABLE'
  | 'CONFIG_CONFLICT'
  | 'SUPERVISOR_UNAVAILABLE';

export type CaptureProvisioningTarget =
  | { kind: 'repository'; repoKey: string; repositoryKey: string }
  | { kind: 'repository'; repoKey: string; repositoryKey: string; profileName: string | null };

export interface CaptureProvisioningReportV1 {
  schemaVersion: 1;
  host: CaptureHost;
  target: CaptureProvisioningTarget;
  state: CaptureProvisioningState;
  pendingCount: number;
  errorCode: CaptureHealthCode | null;
  attributionPendingCount: number;
  attributionRejectedCount: number;
  attributionLastClaimAt: string | null;
}

export interface CaptureProvisioningRecordV1 {
  actorId: string;
  host: CaptureHost;
  targetKey: string;
  repositoryKey: string | null;
  state: CaptureProvisioningState;
  pendingCount: number;
  errorCode: CaptureHealthCode | null;
  attributionPendingCount: number;
  attributionRejectedCount: number;
  attributionLastClaimAt: string | null;
  configuredAt: string | null;
  disabledAt: string | null;
  reportedAt: string;
}

export interface WorkflowStartedData {
  workflowId: string;
  intent: string;
  risk: string;
  scale: string;
}

export interface DeclaredStageV2 {
  stageId: string;
  after: string[];
}

export interface WorkflowStartedDataV2 extends WorkflowStartedData {
  stages: DeclaredStageV2[];
}

export interface WorkflowWorkItemInput {
  provider: string;
  externalId: string;
  externalKey?: string;
}

export interface WorkflowStartedDataV3 extends WorkflowStartedDataV2 {
  workItems: WorkflowWorkItemInput[];
}

export interface WorkflowStageStartedDataV2 {
  occurrenceId: string;
  stageId: string;
  attempt: number;
}

export interface WorkflowStageFinishedDataV2 extends WorkflowStageStartedDataV2 {
  outcome: WorkflowOutcome;
}

export interface WorkflowCounters {
  editCalls?: number;
  editVerifyRounds?: number;
  verificationRuns?: number;
  verificationFailures?: number;
  verificationPasses?: number;
  coredocCalls?: number;
  coredocFailures?: number;
}

export interface WorkflowFinishedData {
  outcome: WorkflowOutcome;
  counters?: WorkflowCounters;
}

export interface CapabilityUsedData {
  kind: 'skill' | 'agent';
  capabilityId: string;
  outcome: WorkflowOutcome | 'unknown';
}

export type QuestionAnswerKind = 'option' | 'typed';

export interface QuestionOptionV4 {
  label: string;
  description?: string;
}

export interface QuestionAnsweredDataV4 {
  askId: string;
  questionIndex: number;
  questionCount: number;
  header?: string;
  question: string;
  options: QuestionOptionV4[];
  multiSelect: boolean;
  answer: string;
  answerKind: QuestionAnswerKind;
  stageId?: string;
}

interface CaptureEventBaseV1 {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  host: CaptureHost;
  sessionId: string;
  repositoryKey?: string;
  taskId?: string;
}

export type CaptureEventV1 =
  | (CaptureEventBaseV1 & {
      type: 'workflow.run.started';
      runId: string;
      data: WorkflowStartedData;
    })
  | (CaptureEventBaseV1 & {
      type: 'workflow.run.finished';
      runId: string;
      data: WorkflowFinishedData;
    })
  | (CaptureEventBaseV1 & {
      type: 'capability.used';
      runId?: string;
      data: CapabilityUsedData;
    });

interface CaptureEventBaseV2 {
  schemaVersion: 2;
  eventId: string;
  occurredAt: string;
  host: CaptureHost;
  sessionId: string;
  runId: string;
  repositoryKey?: string;
}

export type CaptureEventV2 =
  | (CaptureEventBaseV2 & {
      type: 'workflow.run.started';
      taskId?: string;
      data: WorkflowStartedDataV2;
    })
  | (CaptureEventBaseV2 & {
      type: 'workflow.run.finished';
      data: WorkflowFinishedData;
    })
  | (CaptureEventBaseV2 & {
      type: 'workflow.stage.started';
      data: WorkflowStageStartedDataV2;
    })
  | (CaptureEventBaseV2 & {
      type: 'workflow.stage.finished';
      data: WorkflowStageFinishedDataV2;
    });

interface CaptureEventBaseV3 {
  schemaVersion: 3;
  eventId: string;
  occurredAt: string;
  host: CaptureHost;
  sessionId: string;
  runId: string;
  repositoryKey?: string;
}

export type CaptureEventV3 = CaptureEventBaseV3 & {
  type: 'workflow.run.started';
  data: WorkflowStartedDataV3;
};

interface CaptureEventBaseV4 {
  schemaVersion: 4;
  eventId: string;
  occurredAt: string;
  host: CaptureHost;
  sessionId: string;
  runId?: string;
  repositoryKey?: string;
}

export type CaptureEventV4 = CaptureEventBaseV4 & {
  type: 'workflow.question.answered';
  data: QuestionAnsweredDataV4;
};

export type CaptureEvent = CaptureEventV1 | CaptureEventV2 | CaptureEventV3 | CaptureEventV4;

export interface CaptureReceiptV1 {
  acceptedEventIds: string[];
  duplicateEventIds: string[];
  rejected: Array<{ eventId: string | null; code: string }>;
}

export interface CaptureRepositoryBindingV1 {
  repositoryKey: string;
}

export class UnsupportedCaptureSchemaVersionError extends Error {}

function keyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function rejectForbiddenFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenFields(item);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!STRUCTURAL_IDENTIFIER_KEYS.has(key)) {
      const forbidden = keyParts(key).find((part) => FORBIDDEN_KEY_PARTS.has(part));
      if (forbidden) throw new Error(`Capture events must not contain ${forbidden}`);
    }
    rejectForbiddenFields(nested);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: unknown, allowed: Set<string>, label: string): Record<string, unknown> {
  const candidate = object(value, label);
  for (const field of Object.keys(candidate)) {
    if (!allowed.has(field)) throw new Error(`Unsupported ${label} field: ${field}`);
  }
  return candidate;
}

function member<T extends string>(value: unknown, values: Set<string>, label: string): T {
  if (typeof value !== 'string' || !values.has(value)) throw new Error(`Unsupported ${label}: ${value}`);
  return value as T;
}

function compactId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !COMPACT_ID_RE.test(value)) {
    throw new Error(`${label} must be a compact identifier`);
  }
  return value;
}

function taskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID_RE.test(value)) {
    throw new Error('taskId must be an opaque identifier of at most 128 characters');
  }
  return value;
}

export function validateDeliveryTaskId(value: unknown): string {
  const match = typeof value === 'string' ? DELIVERY_TASK_ID_RE.exec(value) : null;
  if (!match) throw new Error('taskId must use the canonical cdt_<UUID> format');
  return `cdt_${match[1].toLowerCase()}`;
}

function runId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_RE.test(value)) {
    throw new Error('runId must use the canonical cdr-YYYYMMDD-xxxxxx format');
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error(`${label} must be a UUID`);
  return value.toLowerCase();
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

export function validateCaptureRepositoryKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) {
    throw new Error('repositoryKey must be a normalized repository identifier');
  }
  const segments = value.split('/');
  if (
    segments.length < 2 ||
    segments.some((segment) => segment === '.' || segment === '..' || !REPOSITORY_SEGMENT_RE.test(segment))
  ) {
    throw new Error('repositoryKey must be a normalized repository identifier');
  }
  return value;
}

export function validateCaptureRepositoryBinding(input: unknown): CaptureRepositoryBindingV1 {
  const candidate = exactFields(input, new Set(['repositoryKey']), 'capture repository binding');
  return { repositoryKey: validateCaptureRepositoryKey(candidate.repositoryKey) };
}

export function isCaptureHealthCode(value: unknown): value is CaptureHealthCode {
  return typeof value === 'string' && CAPTURE_HEALTH_CODE_VALUES.has(value);
}

function provisioningRepoKey(value: unknown): string {
  if (typeof value !== 'string' || !PROVISIONING_REPO_KEY_RE.test(value)) {
    throw new Error('repoKey must be a compact identifier of at most 128 characters');
  }
  return value;
}

function profileName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value === 'base' || !PROFILE_NAME_RE.test(value)) {
    throw new Error('profileName must be null or a supported profile identifier');
  }
  return value;
}

export function validateCaptureProvisioningReport(input: unknown): CaptureProvisioningReportV1 {
  const candidate = exactFields(
    input,
    new Set([
      'schemaVersion',
      'host',
      'target',
      'state',
      'pendingCount',
      'errorCode',
      'attributionPendingCount',
      'attributionRejectedCount',
      'attributionLastClaimAt',
    ]),
    'capture provisioning report',
  );
  if (candidate.schemaVersion !== 1) {
    throw new Error(`Unsupported capture provisioning schemaVersion: ${candidate.schemaVersion}`);
  }
  const host = member<CaptureHost>(candidate.host, HOSTS, 'capture host');
  const state = member<CaptureProvisioningState>(candidate.state, PROVISIONING_STATES, 'provisioning state');
  const pendingCount = nonNegativeInteger(candidate.pendingCount, 'pendingCount');
  if (candidate.errorCode !== null && !isCaptureHealthCode(candidate.errorCode)) {
    throw new Error('Unsupported capture health error code');
  }
  const errorCode = candidate.errorCode as CaptureHealthCode | null;
  const attributionPendingCount = nonNegativeInteger(candidate.attributionPendingCount ?? 0, 'attributionPendingCount');
  const attributionRejectedCount = nonNegativeInteger(
    candidate.attributionRejectedCount ?? 0,
    'attributionRejectedCount',
  );
  const attributionLastClaimAt = nullableTimestamp(candidate.attributionLastClaimAt ?? null, 'attributionLastClaimAt');

  let target: CaptureProvisioningTarget;
  if (host === 'claude-code') {
    const value = exactFields(
      candidate.target,
      new Set(['kind', 'repoKey', 'repositoryKey']),
      'capture provisioning repository target',
    );
    if (value.kind !== 'repository') throw new Error('Claude provisioning requires a repository target');
    target = {
      kind: 'repository',
      repoKey: provisioningRepoKey(value.repoKey),
      repositoryKey: validateCaptureRepositoryKey(value.repositoryKey),
    };
  } else {
    const value = exactFields(
      candidate.target,
      new Set(['kind', 'repoKey', 'repositoryKey', 'profileName']),
      'capture provisioning Codex repository target',
    );
    if (value.kind !== 'repository') throw new Error('Codex provisioning requires a repository target');
    target = {
      kind: 'repository',
      repoKey: provisioningRepoKey(value.repoKey),
      repositoryKey: validateCaptureRepositoryKey(value.repositoryKey),
      profileName: profileName(value.profileName),
    };
  }

  if (state === 'disabled' && (pendingCount !== 0 || errorCode !== null)) {
    throw new Error('Disabled provisioning reports require pendingCount 0 and errorCode null');
  }

  return {
    schemaVersion: 1,
    host,
    target,
    state,
    pendingCount,
    errorCode,
    attributionPendingCount,
    attributionRejectedCount,
    attributionLastClaimAt,
  };
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    throw new Error('sessionId must be a compact identifier of at most 128 characters');
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) {
    throw new Error(`${label} must be an integer between 0 and ${MAX_COUNT}`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function declaredStages(value: unknown): DeclaredStageV2[] {
  if (!Array.isArray(value) || value.length > MAX_DECLARED_STAGES) {
    throw new Error(`workflow stages must contain at most ${MAX_DECLARED_STAGES} entries`);
  }
  const declared = new Set<string>();
  return value.map((entry) => {
    const candidate = exactFields(entry, new Set(['stageId', 'after']), 'declared stage');
    const stageId = compactId(candidate.stageId, 'stageId');
    if (declared.has(stageId)) throw new Error('workflow stages must use unique stageId values');
    if (!Array.isArray(candidate.after)) throw new Error('declared stage after must be an array');
    const after = candidate.after.map((dependency) => compactId(dependency, 'declared stage dependency'));
    if (new Set(after).size !== after.length) {
      throw new Error('declared stage after must not contain duplicates');
    }
    if (after.some((dependency) => !declared.has(dependency))) {
      throw new Error('declared stage after must reference only an earlier declared stage');
    }
    declared.add(stageId);
    return { stageId, after };
  });
}

function workflowStartedData(value: unknown): WorkflowStartedData {
  const candidate = exactFields(value, new Set(['workflowId', 'intent', 'risk', 'scale']), 'workflow.run.started data');
  return {
    workflowId: compactId(candidate.workflowId, 'workflowId'),
    intent: member(candidate.intent, INTENTS, 'workflow intent'),
    risk: member(candidate.risk, RISKS, 'workflow risk'),
    scale: member(candidate.scale, SCALES, 'workflow scale'),
  };
}

function workflowStartedDataV2(value: unknown): WorkflowStartedDataV2 {
  const candidate = exactFields(
    value,
    new Set(['workflowId', 'intent', 'risk', 'scale', 'stages']),
    'workflow.run.started data',
  );
  return {
    workflowId: compactId(candidate.workflowId, 'workflowId'),
    intent: member(candidate.intent, INTENTS, 'workflow intent'),
    risk: member(candidate.risk, RISKS, 'workflow risk'),
    scale: member(candidate.scale, SCALES, 'workflow scale'),
    stages: declaredStages(candidate.stages),
  };
}

function workItemToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !WORK_ITEM_TOKEN_RE.test(value)) {
    throw new Error(`${label} must be a shell-safe work-item token`);
  }
  return value;
}

function workflowWorkItems(value: unknown): WorkflowWorkItemInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WORK_ITEMS) {
    throw new Error(`workflow workItems must contain between 1 and ${MAX_WORK_ITEMS} entries`);
  }

  const canonical = new Map<string, WorkflowWorkItemInput>();
  for (const entry of value) {
    const candidate = exactFields(entry, new Set(['provider', 'externalId', 'externalKey']), 'workflow work item');
    if (typeof candidate.provider !== 'string' || !WORK_ITEM_PROVIDER_RE.test(candidate.provider)) {
      throw new Error('work-item provider must be a shell-safe adapter key');
    }
    const provider = candidate.provider;
    const externalId = workItemToken(candidate.externalId, 'work-item externalId');
    const externalKey =
      candidate.externalKey === undefined ? undefined : workItemToken(candidate.externalKey, 'work-item externalKey');
    const identity = `${provider}\u0000${externalId}`;
    const established = canonical.get(identity);
    if (!established) {
      canonical.set(identity, { provider, externalId, ...(externalKey === undefined ? {} : { externalKey }) });
      continue;
    }
    if (established.externalKey !== undefined && externalKey !== undefined && established.externalKey !== externalKey) {
      throw new Error('duplicate work-item identity has conflicting externalKey values');
    }
    if (established.externalKey === undefined && externalKey !== undefined) {
      canonical.set(identity, { provider, externalId, externalKey });
    }
  }

  return [...canonical.values()].sort((left, right) => {
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
    if (left.externalId === right.externalId) return 0;
    return left.externalId < right.externalId ? -1 : 1;
  });
}

function workflowStartedDataV3(value: unknown): WorkflowStartedDataV3 {
  const candidate = exactFields(
    value,
    new Set(['workflowId', 'intent', 'risk', 'scale', 'stages', 'workItems']),
    'workflow.run.started data',
  );
  return {
    workflowId: compactId(candidate.workflowId, 'workflowId'),
    intent: member(candidate.intent, INTENTS, 'workflow intent'),
    risk: member(candidate.risk, RISKS, 'workflow risk'),
    scale: member(candidate.scale, SCALES, 'workflow scale'),
    stages: declaredStages(candidate.stages),
    workItems: workflowWorkItems(candidate.workItems),
  };
}

function workflowFinishedData(value: unknown): WorkflowFinishedData {
  const candidate = exactFields(value, new Set(['outcome', 'counters']), 'workflow.run.finished data');
  const outcome = member<WorkflowOutcome | 'unknown'>(candidate.outcome, OUTCOMES, 'workflow outcome');
  if (outcome === 'unknown') throw new Error('Unsupported workflow outcome: unknown');
  let counters: WorkflowCounters | undefined;
  if (candidate.counters !== undefined) {
    const values = exactFields(
      candidate.counters,
      new Set([
        'editCalls',
        'editVerifyRounds',
        'verificationRuns',
        'verificationFailures',
        'verificationPasses',
        'coredocCalls',
        'coredocFailures',
      ]),
      'workflow counters',
    );
    counters = Object.fromEntries(
      Object.entries(values).map(([key, count]) => [key, nonNegativeInteger(count, key)]),
    ) as WorkflowCounters;
  }
  return { outcome, ...(counters === undefined ? {} : { counters }) };
}

function capabilityUsedData(value: unknown): CapabilityUsedData {
  const candidate = exactFields(value, new Set(['kind', 'capabilityId', 'outcome']), 'capability.used data');
  return {
    kind: member(candidate.kind, CAPABILITY_KINDS, 'capability kind'),
    capabilityId: compactId(candidate.capabilityId, 'capabilityId'),
    outcome: member(candidate.outcome, OUTCOMES, 'capability outcome'),
  };
}

function stageStartedData(value: unknown): WorkflowStageStartedDataV2 {
  const candidate = exactFields(value, new Set(['occurrenceId', 'stageId', 'attempt']), 'workflow.stage.started data');
  return {
    occurrenceId: uuid(candidate.occurrenceId, 'occurrenceId'),
    stageId: compactId(candidate.stageId, 'stageId'),
    attempt: positiveInteger(candidate.attempt, 'attempt', MAX_STAGE_ATTEMPT),
  };
}

function stageFinishedData(value: unknown): WorkflowStageFinishedDataV2 {
  const candidate = exactFields(
    value,
    new Set(['occurrenceId', 'stageId', 'attempt', 'outcome']),
    'workflow.stage.finished data',
  );
  return {
    occurrenceId: uuid(candidate.occurrenceId, 'occurrenceId'),
    stageId: compactId(candidate.stageId, 'stageId'),
    attempt: positiveInteger(candidate.attempt, 'attempt', MAX_STAGE_ATTEMPT),
    outcome: member(candidate.outcome, STAGE_OUTCOMES, 'stage outcome'),
  };
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || CONTROL_CHARACTER_RE.test(value)) {
    throw new Error(`${label} must be text of 1 to ${maximum} characters without control characters`);
  }
  return value;
}

function questionOptions(value: unknown): QuestionOptionV4[] {
  if (!Array.isArray(value) || value.length > MAX_QUESTION_OPTIONS) {
    throw new Error(`question options must contain at most ${MAX_QUESTION_OPTIONS} entries`);
  }
  return value.map((entry) => {
    const candidate = exactFields(entry, new Set(['label', 'description']), 'question option');
    return {
      label: boundedText(candidate.label, 'option label', MAX_OPTION_LABEL_CHARS),
      ...(candidate.description === undefined
        ? {}
        : { description: boundedText(candidate.description, 'option description', MAX_OPTION_DESCRIPTION_CHARS) }),
    };
  });
}

function questionAnsweredData(value: unknown): QuestionAnsweredDataV4 {
  const candidate = exactFields(
    value,
    new Set([
      'askId',
      'questionIndex',
      'questionCount',
      'header',
      'question',
      'options',
      'multiSelect',
      'answer',
      'answerKind',
      'stageId',
    ]),
    'workflow.question.answered data',
  );
  const questionCount = positiveInteger(candidate.questionCount, 'questionCount', MAX_QUESTIONS_PER_ASK);
  const questionIndex = positiveInteger(candidate.questionIndex, 'questionIndex', questionCount);
  if (typeof candidate.multiSelect !== 'boolean') throw new Error('multiSelect must be a boolean');
  return {
    askId: uuid(candidate.askId, 'askId'),
    questionIndex,
    questionCount,
    ...(candidate.header === undefined
      ? {}
      : { header: boundedText(candidate.header, 'header', MAX_QUESTION_HEADER_CHARS) }),
    question: boundedText(candidate.question, 'question', MAX_QUESTION_CHARS),
    options: questionOptions(candidate.options),
    multiSelect: candidate.multiSelect,
    answer: boundedText(candidate.answer, 'answer', MAX_ANSWER_CHARS),
    answerKind: member<QuestionAnswerKind>(candidate.answerKind, ANSWER_KINDS, 'answerKind'),
    ...(candidate.stageId === undefined ? {} : { stageId: compactId(candidate.stageId, 'stageId') }),
  };
}

export function validateCaptureEvent(input: unknown): CaptureEvent {
  rejectForbiddenFields(input);
  const candidate = exactFields(
    input,
    new Set([
      'schemaVersion',
      'eventId',
      'occurredAt',
      'host',
      'sessionId',
      'runId',
      'repositoryKey',
      'taskId',
      'type',
      'data',
    ]),
    'capture event',
  );
  if (!Number.isInteger(candidate.schemaVersion) || (candidate.schemaVersion as number) < 1) {
    throw new Error('capture event schemaVersion must be a positive integer');
  }
  if (![1, 2, 3, 4].includes(candidate.schemaVersion as number)) {
    throw new UnsupportedCaptureSchemaVersionError(
      `Unsupported capture event schemaVersion: ${candidate.schemaVersion}`,
    );
  }
  const sharedBase = {
    eventId: uuid(candidate.eventId, 'eventId'),
    occurredAt: timestamp(candidate.occurredAt, 'occurredAt'),
    host: member<CaptureHost>(candidate.host, HOSTS, 'capture host'),
    sessionId: sessionId(candidate.sessionId),
    ...(candidate.repositoryKey === undefined
      ? {}
      : { repositoryKey: validateCaptureRepositoryKey(candidate.repositoryKey) }),
  };

  if (candidate.schemaVersion === 1) {
    const type = member<CaptureEventV1['type']>(candidate.type, V1_EVENT_TYPES, 'capture event type');
    if ((type === 'workflow.run.started' || type === 'workflow.run.finished') && candidate.runId === undefined) {
      throw new Error(`${type} requires runId`);
    }
    const base = {
      schemaVersion: 1 as const,
      ...sharedBase,
      ...(candidate.taskId === undefined ? {} : { taskId: taskId(candidate.taskId) }),
    };
    if (type === 'workflow.run.started') {
      return { ...base, type, runId: runId(candidate.runId), data: workflowStartedData(candidate.data) };
    }
    if (type === 'workflow.run.finished') {
      return { ...base, type, runId: runId(candidate.runId), data: workflowFinishedData(candidate.data) };
    }
    return {
      ...base,
      type,
      ...(candidate.runId === undefined ? {} : { runId: runId(candidate.runId) }),
      data: capabilityUsedData(candidate.data),
    };
  }

  if (candidate.schemaVersion === 4) {
    if (!V4_EVENT_TYPES.has(candidate.type as string)) {
      throw new Error('schemaVersion 4 supports only workflow.question.answered');
    }
    if (candidate.taskId !== undefined) throw new Error('taskId is not supported on workflow.question.answered');
    return {
      schemaVersion: 4,
      ...sharedBase,
      ...(candidate.runId === undefined ? {} : { runId: runId(candidate.runId) }),
      type: 'workflow.question.answered',
      data: questionAnsweredData(candidate.data),
    };
  }

  if (candidate.schemaVersion === 3) {
    if (candidate.type !== 'workflow.run.started') {
      throw new Error(`Unsupported capture event type: ${candidate.type}`);
    }
    if (candidate.runId === undefined) throw new Error('workflow.run.started requires runId');
    if (candidate.taskId !== undefined) throw new Error('taskId and workItems are mutually exclusive');
    return {
      schemaVersion: 3,
      ...sharedBase,
      runId: runId(candidate.runId),
      type: 'workflow.run.started',
      data: workflowStartedDataV3(candidate.data),
    };
  }

  const type = member<CaptureEventV2['type']>(candidate.type, V2_EVENT_TYPES, 'capture event type');
  if (candidate.runId === undefined) throw new Error(`${type} requires runId`);
  if (type !== 'workflow.run.started' && candidate.taskId !== undefined) {
    throw new Error('taskId is supported only on V2 workflow.run.started');
  }
  const base = {
    schemaVersion: 2 as const,
    ...sharedBase,
    runId: runId(candidate.runId),
  };
  if (type === 'workflow.run.started') {
    return {
      ...base,
      type,
      ...(candidate.taskId === undefined ? {} : { taskId: validateDeliveryTaskId(candidate.taskId) }),
      data: workflowStartedDataV2(candidate.data),
    };
  }
  if (type === 'workflow.run.finished') {
    return { ...base, type, data: workflowFinishedData(candidate.data) };
  }
  if (type === 'workflow.stage.started') {
    return { ...base, type, data: stageStartedData(candidate.data) };
  }
  return { ...base, type, data: stageFinishedData(candidate.data) };
}

export function captureBatchItems(input: unknown): unknown[] {
  const candidate = exactFields(input, new Set(['events']), 'capture batch');
  if (!Array.isArray(candidate.events) || candidate.events.length < 1 || candidate.events.length > 100) {
    throw new Error('events must contain between 1 and 100 entries');
  }
  return candidate.events;
}

export function rejectionEventId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    return uuid((input as Record<string, unknown>).eventId, 'eventId');
  } catch {
    // intentional: this reads the id OFF an event already being rejected — a
    // malformed id just means the rejection is reported without one.
    return null;
  }
}
