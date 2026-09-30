const HOSTS = new Set(["claude-code", "codex"]);
const V1_EVENT_TYPES = new Set([
  "workflow.run.started",
  "workflow.run.finished",
  "capability.used",
]);
const V2_EVENT_TYPES = new Set([
  "workflow.run.started",
  "workflow.run.finished",
  "workflow.stage.started",
  "workflow.stage.finished",
]);
// Schema 4 exists for exactly one event: the question the agent asked the user
// and the answer it received. It is the one capture event that carries text,
// so its grammar bounds every string and the producer redacts before recording.
const V4_EVENT_TYPES = new Set(["workflow.question.answered"]);
const ANSWER_KINDS = new Set(["option", "typed"]);
/** Bounds a producer must apply before recording a question event. */
export const QUESTION_LIMITS = Object.freeze({
  questionsPerAsk: 4,
  options: 10,
  headerChars: 32,
  questionChars: 500,
  optionLabelChars: 100,
  optionDescriptionChars: 300,
  answerChars: 500,
});
const MAX_QUESTIONS_PER_ASK = QUESTION_LIMITS.questionsPerAsk;
const MAX_QUESTION_OPTIONS = QUESTION_LIMITS.options;
const MAX_QUESTION_HEADER_CHARS = QUESTION_LIMITS.headerChars;
const MAX_QUESTION_CHARS = QUESTION_LIMITS.questionChars;
const MAX_OPTION_LABEL_CHARS = QUESTION_LIMITS.optionLabelChars;
const MAX_OPTION_DESCRIPTION_CHARS = QUESTION_LIMITS.optionDescriptionChars;
const MAX_ANSWER_CHARS = QUESTION_LIMITS.answerChars;
const INTENTS = new Set([
  "direct",
  "diagnose",
  "design",
  "change",
  "review",
  "spec",
  "qa",
  "qa-report",
  "benchmark",
  "security",
  "browse",
  "learn",
  "retro",
]);
const RISKS = new Set(["low", "normal", "high"]);
const SCALES = new Set(["normal", "large"]);
const CAPABILITY_KINDS = new Set(["skill", "agent"]);
const OUTCOMES = new Set([
  "success",
  "failed",
  "blocked",
  "abandoned",
  "unknown",
]);
const STAGE_OUTCOMES = new Set([
  "success",
  "failed",
  "blocked",
  "abandoned",
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const COMPACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;
const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const DELIVERY_TASK_ID_RE =
  /^cdt_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REPOSITORY_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_COUNT = 1_000_000;
const MAX_DECLARED_STAGES = 32;
const MAX_STAGE_ATTEMPT = 1_000;
const MAX_WORK_ITEMS = 8;
const WORK_ITEM_PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const WORK_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+%=-]{0,255}$/;

const STRUCTURAL_IDENTIFIER_KEYS = new Set([
  "taskId",
  "runId",
  "workflowId",
  "sessionId",
  "eventId",
  "capabilityId",
  "repositoryKey",
]);
const FORBIDDEN_KEY_PARTS = new Set([
  "task",
  "spec",
  "body",
  "prompt",
  "message",
  "command",
  "argument",
  "arguments",
  "input",
  "output",
  "response",
  "source",
  "diff",
  "file",
  "path",
  "content",
  "transcript",
]);

function keyParts(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function rejectForbiddenFields(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenFields(item);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!STRUCTURAL_IDENTIFIER_KEYS.has(key)) {
      const forbidden = keyParts(key).find((part) =>
        FORBIDDEN_KEY_PARTS.has(part),
      );
      if (forbidden) {
        throw new Error(`Capture events must not contain ${forbidden}`);
      }
    }
    rejectForbiddenFields(nested);
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactFields(value, allowed, label) {
  const candidate = object(value, label);
  for (const field of Object.keys(candidate)) {
    if (!allowed.has(field)) {
      throw new Error(`Unsupported ${label} field: ${field}`);
    }
  }
  return candidate;
}

function member(value, values, label) {
  if (!values.has(value)) {
    throw new Error(`Unsupported ${label}: ${value}`);
  }
  return value;
}

function compactId(value, label) {
  if (typeof value !== "string" || !COMPACT_ID_RE.test(value)) {
    throw new Error(`${label} must be a compact identifier`);
  }
  return value;
}

function taskId(value) {
  if (typeof value !== "string" || !TASK_ID_RE.test(value)) {
    throw new Error("taskId must be an opaque identifier of at most 128 characters");
  }
  return value;
}

function deliveryTaskId(value) {
  const match =
    typeof value === "string" ? DELIVERY_TASK_ID_RE.exec(value) : null;
  if (!match) {
    throw new Error("taskId must use the canonical cdt_<UUID> format");
  }
  return `cdt_${match[1].toLowerCase()}`;
}

function runId(value) {
  if (typeof value !== "string" || !RUN_ID_RE.test(value)) {
    throw new Error("runId must use the canonical cdr-YYYYMMDD-xxxxxx format");
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function timestamp(value, label) {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_RE.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function repositoryKey(value) {
  if (typeof value !== "string" || value.length > 256) {
    throw new Error("repositoryKey must be a normalized repository identifier");
  }
  const segments = value.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !REPOSITORY_SEGMENT_RE.test(segment),
    )
  ) {
    throw new Error("repositoryKey must be a normalized repository identifier");
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new Error(`${label} must be an integer between 0 and ${MAX_COUNT}`);
  }
  return value;
}

function workItemToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} must match the shell-safe work-item grammar`);
  }
  return value;
}

export function workflowWorkItemsV3(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WORK_ITEMS) {
    throw new Error(`workflow workItems must contain between 1 and ${MAX_WORK_ITEMS} entries`);
  }
  const canonical = new Map();
  for (const entry of value) {
    const candidate = exactFields(
      entry,
      new Set(["provider", "externalId", "externalKey"]),
      "workflow work item",
    );
    const provider = workItemToken(
      candidate.provider,
      WORK_ITEM_PROVIDER_RE,
      "work item provider",
    );
    const externalId = workItemToken(
      candidate.externalId,
      WORK_ITEM_ID_RE,
      "work item externalId",
    );
    const externalKey =
      candidate.externalKey === undefined
        ? undefined
        : workItemToken(
            candidate.externalKey,
            WORK_ITEM_ID_RE,
            "work item externalKey",
          );
    const identity = `${provider}\0${externalId}`;
    const previous = canonical.get(identity);
    if (
      previous?.externalKey !== undefined &&
      externalKey !== undefined &&
      previous.externalKey !== externalKey
    ) {
      throw new Error("duplicate workflow work item has conflicting externalKey values");
    }
    canonical.set(identity, {
      provider,
      externalId,
      ...(previous?.externalKey === undefined && externalKey === undefined
        ? {}
        : { externalKey: previous?.externalKey ?? externalKey }),
    });
  }
  return [...canonical.values()].sort((left, right) => {
    if (left.provider !== right.provider) {
      return left.provider < right.provider ? -1 : 1;
    }
    if (left.externalId === right.externalId) return 0;
    return left.externalId < right.externalId ? -1 : 1;
  });
}

export function declaredWorkflowStagesV2(value) {
  if (!Array.isArray(value) || value.length > MAX_DECLARED_STAGES) {
    throw new Error(
      `workflow stages must contain at most ${MAX_DECLARED_STAGES} entries`,
    );
  }
  const declared = new Set();
  return value.map((entry) => {
    const candidate = exactFields(
      entry,
      new Set(["stageId", "after"]),
      "declared stage",
    );
    const stageId = compactId(candidate.stageId, "stageId");
    if (declared.has(stageId)) {
      throw new Error("workflow stages must use unique stageId values");
    }
    if (!Array.isArray(candidate.after)) {
      throw new Error("declared stage after must be an array");
    }
    const after = candidate.after.map((dependency) =>
      compactId(dependency, "declared stage dependency"),
    );
    if (new Set(after).size !== after.length) {
      throw new Error("declared stage after must not contain duplicates");
    }
    if (after.some((dependency) => !declared.has(dependency))) {
      throw new Error(
        "declared stage after must reference only an earlier declared stage",
      );
    }
    declared.add(stageId);
    return { stageId, after };
  });
}

function workflowStartedData(value, schemaVersion) {
  const candidate = exactFields(
    value,
    new Set([
      "workflowId",
      "intent",
      "risk",
      "scale",
      ...(schemaVersion >= 2 ? ["stages"] : []),
      ...(schemaVersion === 3 ? ["workItems"] : []),
    ]),
    "workflow.run.started data",
  );
  return {
    workflowId: compactId(candidate.workflowId, "workflowId"),
    intent: member(candidate.intent, INTENTS, "workflow intent"),
    risk: member(candidate.risk, RISKS, "workflow risk"),
    scale: member(candidate.scale, SCALES, "workflow scale"),
    ...(schemaVersion >= 2
      ? { stages: declaredWorkflowStagesV2(candidate.stages) }
      : {}),
    ...(schemaVersion === 3
      ? { workItems: workflowWorkItemsV3(candidate.workItems) }
      : {}),
  };
}

function workflowFinishedData(value) {
  const candidate = exactFields(
    value,
    new Set(["outcome", "counters"]),
    "workflow.run.finished data",
  );
  const outcome = member(candidate.outcome, OUTCOMES, "workflow outcome");
  if (outcome === "unknown") {
    throw new Error("Unsupported workflow outcome: unknown");
  }
  let counters;
  if (candidate.counters !== undefined) {
    const values = exactFields(
      candidate.counters,
      new Set([
        "editCalls",
        "editVerifyRounds",
        "verificationRuns",
        "verificationFailures",
        "verificationPasses",
        "coredocCalls",
        "coredocFailures",
      ]),
      "workflow counters",
    );
    counters = Object.fromEntries(
      Object.entries(values).map(([key, count]) => [
        key,
        nonNegativeInteger(count, key),
      ]),
    );
  }
  return {
    outcome,
    ...(counters === undefined ? {} : { counters }),
  };
}

function capabilityUsedData(value) {
  const candidate = exactFields(
    value,
    new Set(["kind", "capabilityId", "outcome"]),
    "capability.used data",
  );
  return {
    kind: member(candidate.kind, CAPABILITY_KINDS, "capability kind"),
    capabilityId: compactId(candidate.capabilityId, "capabilityId"),
    outcome: member(candidate.outcome, OUTCOMES, "capability outcome"),
  };
}

function stageStartedData(value) {
  const candidate = exactFields(
    value,
    new Set(["occurrenceId", "stageId", "attempt"]),
    "workflow.stage.started data",
  );
  return {
    occurrenceId: uuid(candidate.occurrenceId, "occurrenceId"),
    stageId: compactId(candidate.stageId, "stageId"),
    attempt: positiveInteger(candidate.attempt, "attempt", MAX_STAGE_ATTEMPT),
  };
}

function stageFinishedData(value) {
  const candidate = exactFields(
    value,
    new Set(["occurrenceId", "stageId", "attempt", "outcome"]),
    "workflow.stage.finished data",
  );
  return {
    occurrenceId: uuid(candidate.occurrenceId, "occurrenceId"),
    stageId: compactId(candidate.stageId, "stageId"),
    attempt: positiveInteger(candidate.attempt, "attempt", MAX_STAGE_ATTEMPT),
    outcome: member(candidate.outcome, STAGE_OUTCOMES, "stage outcome"),
  };
}

function positiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

// Text fields admit printable characters, tabs, and newlines only. A carriage
// return or any other control character is a sign the producer copied raw
// host output rather than a redacted, bounded string.
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;

function boundedText(value, label, maximum) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    CONTROL_CHARACTER_RE.test(value)
  ) {
    throw new Error(
      `${label} must be text of 1 to ${maximum} characters without control characters`,
    );
  }
  return value;
}

function questionOptions(value) {
  if (!Array.isArray(value) || value.length > MAX_QUESTION_OPTIONS) {
    throw new Error(
      `question options must contain at most ${MAX_QUESTION_OPTIONS} entries`,
    );
  }
  return value.map((entry) => {
    const candidate = exactFields(
      entry,
      new Set(["label", "description"]),
      "question option",
    );
    return {
      label: boundedText(candidate.label, "option label", MAX_OPTION_LABEL_CHARS),
      ...(candidate.description === undefined
        ? {}
        : {
            description: boundedText(
              candidate.description,
              "option description",
              MAX_OPTION_DESCRIPTION_CHARS,
            ),
          }),
    };
  });
}

function questionAnsweredData(value) {
  const candidate = exactFields(
    value,
    new Set([
      "askId",
      "questionIndex",
      "questionCount",
      "header",
      "question",
      "options",
      "multiSelect",
      "answer",
      "answerKind",
      "stageId",
    ]),
    "workflow.question.answered data",
  );
  const questionCount = positiveInteger(
    candidate.questionCount,
    "questionCount",
    MAX_QUESTIONS_PER_ASK,
  );
  const questionIndex = positiveInteger(
    candidate.questionIndex,
    "questionIndex",
    questionCount,
  );
  if (typeof candidate.multiSelect !== "boolean") {
    throw new Error("multiSelect must be a boolean");
  }
  return {
    askId: uuid(candidate.askId, "askId"),
    questionIndex,
    questionCount,
    ...(candidate.header === undefined
      ? {}
      : { header: boundedText(candidate.header, "header", MAX_QUESTION_HEADER_CHARS) }),
    question: boundedText(candidate.question, "question", MAX_QUESTION_CHARS),
    options: questionOptions(candidate.options),
    multiSelect: candidate.multiSelect,
    answer: boundedText(candidate.answer, "answer", MAX_ANSWER_CHARS),
    answerKind: member(candidate.answerKind, ANSWER_KINDS, "answerKind"),
    ...(candidate.stageId === undefined
      ? {}
      : { stageId: compactId(candidate.stageId, "stageId") }),
  };
}

function eventData(schemaVersion, type, value) {
  switch (type) {
    case "workflow.run.started":
      return workflowStartedData(value, schemaVersion);
    case "workflow.run.finished":
      return workflowFinishedData(value);
    case "capability.used":
      return capabilityUsedData(value);
    case "workflow.stage.started":
      return stageStartedData(value);
    case "workflow.stage.finished":
      return stageFinishedData(value);
    case "workflow.question.answered":
      return questionAnsweredData(value);
    default:
      throw new Error(`Unsupported capture event type: ${type}`);
  }
}

export function captureEvent(input) {
  rejectForbiddenFields(input);
  const candidate = exactFields(
    input,
    new Set([
      "schemaVersion",
      "eventId",
      "occurredAt",
      "host",
      "sessionId",
      "runId",
      "repositoryKey",
      "taskId",
      "type",
      "data",
    ]),
    "capture event",
  );
  if (![1, 2, 3, 4].includes(candidate.schemaVersion)) {
    throw new Error(
      `Unsupported capture event schemaVersion: ${candidate.schemaVersion}`,
    );
  }
  const schemaVersion = candidate.schemaVersion;
  if (schemaVersion === 3 && candidate.type !== "workflow.run.started") {
    throw new Error("schemaVersion 3 supports only workflow.run.started");
  }
  if (schemaVersion === 4 && !V4_EVENT_TYPES.has(candidate.type)) {
    throw new Error("schemaVersion 4 supports only workflow.question.answered");
  }
  const type = member(
    candidate.type,
    schemaVersion === 1
      ? V1_EVENT_TYPES
      : schemaVersion === 4
        ? V4_EVENT_TYPES
        : V2_EVENT_TYPES,
    "capture event type",
  );
  const requiresRun =
    schemaVersion === 2 ||
    type === "workflow.run.started" ||
    type === "workflow.run.finished";
  if (requiresRun && candidate.runId === undefined) {
    throw new Error(`${type} requires runId`);
  }
  if (
    schemaVersion === 2 &&
    candidate.taskId !== undefined &&
    type !== "workflow.run.started"
  ) {
    throw new Error("taskId is supported only on v2 workflow.run.started");
  }
  if (schemaVersion === 3 && candidate.taskId !== undefined) {
    throw new Error("taskId and workItems are mutually exclusive");
  }
  if (schemaVersion === 4 && candidate.taskId !== undefined) {
    throw new Error("taskId is not supported on workflow.question.answered");
  }
  return {
    schemaVersion,
    eventId: uuid(candidate.eventId, "eventId"),
    occurredAt: timestamp(candidate.occurredAt, "occurredAt"),
    host: member(candidate.host, HOSTS, "capture host"),
    sessionId: compactSessionId(candidate.sessionId),
    ...(candidate.runId === undefined ? {} : { runId: runId(candidate.runId) }),
    ...(candidate.repositoryKey === undefined
      ? {}
      : { repositoryKey: repositoryKey(candidate.repositoryKey) }),
    ...(candidate.taskId === undefined
      ? {}
      : {
          taskId:
            schemaVersion === 1
              ? taskId(candidate.taskId)
              : deliveryTaskId(candidate.taskId),
        }),
    type,
    data: eventData(schemaVersion, type, candidate.data),
  };
}

function compactSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID_RE.test(value)) {
    throw new Error(
      "sessionId must be a compact identifier of at most 128 characters",
    );
  }
  return value;
}

export function captureContext(input) {
  const candidate = exactFields(
    input,
    new Set(["host", "sessionId", "repositoryKey"]),
    "capture context",
  );
  return {
    host: member(candidate.host, HOSTS, "capture host"),
    sessionId: compactSessionId(candidate.sessionId),
    ...(candidate.repositoryKey === undefined
      ? {}
      : { repositoryKey: repositoryKey(candidate.repositoryKey) }),
  };
}

function receiptIds(value, label, attempted) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label} must contain at most 100 entries`);
  }
  const ids = value.map((entry) => uuid(entry, `${label} event id`));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  for (const id of ids) {
    if (!attempted.has(id)) {
      throw new Error(`${label} contains an event that was not attempted`);
    }
  }
  return ids;
}

export function captureReceipt(input, attemptedIds) {
  const candidate = exactFields(
    input,
    new Set(["acceptedEventIds", "duplicateEventIds", "rejected"]),
    "capture receipt",
  );
  const attempted = new Set(
    attemptedIds.map((value) => uuid(value, "attempted event id")),
  );
  const acceptedEventIds = receiptIds(
    candidate.acceptedEventIds,
    "acceptedEventIds",
    attempted,
  );
  const duplicateEventIds = receiptIds(
    candidate.duplicateEventIds,
    "duplicateEventIds",
    attempted,
  );
  if (!Array.isArray(candidate.rejected) || candidate.rejected.length > 100) {
    throw new Error("rejected must contain at most 100 entries");
  }
  const rejected = candidate.rejected.map((entry) => {
    const value = exactFields(
      entry,
      new Set(["eventId", "code"]),
      "rejected receipt entry",
    );
    const eventId =
      value.eventId === null ? null : uuid(value.eventId, "rejected event id");
    if (eventId !== null && !attempted.has(eventId)) {
      throw new Error("rejected contains an event that was not attempted");
    }
    return {
      eventId,
      code: compactId(value.code, "rejection code"),
    };
  });

  const categorized = [
    ...acceptedEventIds,
    ...duplicateEventIds,
    ...rejected.flatMap(({ eventId }) => (eventId === null ? [] : [eventId])),
  ];
  if (new Set(categorized).size !== categorized.length) {
    throw new Error("capture receipt must categorize an event only once");
  }
  return { acceptedEventIds, duplicateEventIds, rejected };
}
