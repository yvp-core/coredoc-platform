/** The server-runner contract. Imports zod only, so the runner's dependency graph stays small. */
import { z } from 'zod';

/** Bumped on any incompatible change to the schemas below. */
export const RUNNER_PROTOCOL_VERSION = 1;

/** Every request about a turn carries the claim's lease token in this header (reads included). */
export const RUNNER_LEASE_HEADER = 'x-coredoc-lease-token';

export enum RunnerErrorCode {
  /** Expired, re-claimed or unknown lease: stop the turn. */
  LeaseLost = 'LEASE_LOST',
  RunnerIncompatible = 'RUNNER_INCOMPATIBLE',
  /** The server has already failed the run with `archive_too_large`. */
  ArchiveTooLarge = 'ARCHIVE_TOO_LARGE',
}

/** Also the run's phase. */
export enum TurnKind {
  Scope = 'scope',
  Implement = 'implement',
  Delivery = 'delivery',
}

export enum QuestionsPolicy {
  Pause = 'pause',
  Assume = 'assume',
}

export enum ScopeAcceptancePolicy {
  Required = 'required',
  Automatic = 'automatic',
}

const versionString = z.string().trim().min(1).max(64);

/**
 * Cap on the state archive (Claude Code's config and session directory plus the plugin's state
 * home). The server's body-size tier for the archive route derives from it.
 */
export const MAX_STATE_ARCHIVE_BYTES = 128 * 1024 * 1024;

export enum RunFailureCode {
  InvalidRepositoryLabel = 'invalid_repository_label',
  TooManyRepositories = 'too_many_repositories',
  IssueNotReadable = 'issue_not_readable',
  RunOwnerRemoved = 'run_owner_removed',
  ConnectorInactive = 'connector_inactive',
  PluginMissing = 'plugin_missing',
  AgentError = 'agent_error',
  SessionMismatch = 'session_mismatch',
  RepositoryNotEligible = 'repository_not_eligible',
  BranchExists = 'branch_exists',
  PushRejected = 'push_rejected',
  SecretScanBlocked = 'secret_scan_blocked',
  NoOutcome = 'no_outcome',
  BudgetExhausted = 'budget_exhausted',
  WallClockExceeded = 'wall_clock_exceeded',
  WaitingExpired = 'waiting_expired',
  NoChanges = 'no_changes',
  GithubError = 'github_error',
  JiraError = 'jira_error',
  ArchiveTooLarge = 'archive_too_large',
  ReportLimitExceeded = 'report_limit_exceeded',
  DeliveryFailed = 'delivery_failed',
  RunnerLost = 'runner_lost',
}

/** The failure codes a runner may report; its reason stays on the run page, never in Jira. */
export const RUNNER_FAILURE_CODES = [
  RunFailureCode.PluginMissing,
  RunFailureCode.SessionMismatch,
  RunFailureCode.AgentError,
  RunFailureCode.ArchiveTooLarge,
  RunFailureCode.BudgetExhausted,
  RunFailureCode.RepositoryNotEligible,
  RunFailureCode.BranchExists,
  RunFailureCode.PushRejected,
  RunFailureCode.SecretScanBlocked,
  RunFailureCode.GithubError,
  RunFailureCode.DeliveryFailed,
] as const;
export type RunnerFailureCode = (typeof RUNNER_FAILURE_CODES)[number];

/** Implement turns: the run's repositories. Scope turns: its eligible seeds, read only, for the bot permission check. */
export const AssignedRepositorySchema = z.object({
  key: z.string(),
  reason: z.string(),
  mergeOrder: z.number().int().nonnegative(),
  /** Never carries a credential. */
  cloneUrl: z.string().min(1),
  github: z.object({ apiBaseUrl: z.string().min(1), owner: z.string().min(1), name: z.string().min(1) }),
  /** True once this run reserved the run branch here: a run branch found on the remote is then its own. */
  branchCreated: z.boolean(),
  withheldPaths: z.array(z.string()),
});
export type AssignedRepository = z.infer<typeof AssignedRepositorySchema>;

export const RunnerVersionsSchema = z.object({
  runner: versionString,
  sdk: versionString.optional(),
  claudeCode: versionString.optional(),
  plugin: versionString.optional(),
});
export type RunnerVersions = z.infer<typeof RunnerVersionsSchema>;

export const ClaimRequestSchema = z.object({
  protocolVersion: z.number().int().positive(),
  versions: RunnerVersionsSchema,
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

/** A closed list: the server words each code, so settings never show runner-chosen text beyond the masked detail. */
export enum RunnerStartupProblemCode {
  SdkUnusable = 'sdk_unusable',
  PluginMissing = 'plugin_missing',
  PluginErrors = 'plugin_errors',
  PluginSkillsMissing = 'plugin_skills_missing',
  BotAdmin = 'bot_admin',
  BotUnreadable = 'bot_unreadable',
  RegistryConfigInvalid = 'registry_config_invalid',
}

/**
 * Sent instead of claiming while the start-up check fails; the next claim clears it. Added within
 * protocol version 1: a server without the route answers 404, which the runner ignores.
 */
export const RunnerStartupProblemSchema = z.strictObject({
  protocolVersion: z.number().int().positive(),
  versions: RunnerVersionsSchema,
  code: z.enum(RunnerStartupProblemCode),
  /** Masked by the runner for the credentials it holds; the server redacts and caps it too. */
  detail: z.string().trim().min(1).max(500).optional(),
});
export type RunnerStartupProblem = z.infer<typeof RunnerStartupProblemSchema>;

export const RunnerStartupProblemResponseSchema = z.object({ recorded: z.literal(true) });
export type RunnerStartupProblemResponse = z.infer<typeof RunnerStartupProblemResponseSchema>;

export const TurnAssignmentSchema = z.object({
  turn: z.object({
    id: z.uuid(),
    kind: z.enum(TurnKind),
    ordinal: z.number().int().positive(),
    /** 1 on the first claim; raised each time an expired lease re-queues the turn. */
    attempt: z.number().int().positive(),
    inputText: z.string().nullable(),
  }),
  lease: z.object({
    token: z.uuid(),
    expiresAt: z.iso.datetime(),
  }),
  run: z.object({
    id: z.uuid(),
    issueKey: z.string(),
    questionsPolicy: z.enum(QuestionsPolicy),
    scopeAcceptancePolicy: z.enum(ScopeAcceptancePolicy),
    /** Null means Claude Code's default model. */
    model: z.string().nullable(),
    sessionId: z.uuid(),
    remainingSpendUsd: z.number(),
    /** The SDK reports a resumed session's cost cumulatively, so a turn's spend is the result's total minus this. */
    priorSessionSpendUsd: z.number().nonnegative(),
    maxTurnDurationSeconds: z.number().int().positive(),
    seeds: z.array(z.string()),
    branch: z.string().min(1),
  }),
  prd: z.object({ markdown: z.string() }).nullable(),
  acceptedSpec: z
    .object({
      version: z.number().int().positive(),
      markdown: z.string(),
      /** Null when the system accepted it under automatic acceptance. */
      acceptedBy: z.string().nullable(),
      acceptedAt: z.iso.datetime(),
      /** sha256 of the markdown, hex. */
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .nullable(),
  repositories: z.array(AssignedRepositorySchema),
  /** Delivery turns only; pull requests in merge order. */
  delivery: z
    .object({
      pullRequests: z.array(z.object({ key: z.string(), title: z.string().min(1), body: z.string() })),
    })
    .nullable()
    .default(null),
  /** Minted at claim and deleted when the turn ends; `path` resolves against the runner's API base. */
  mcp: z.object({ token: z.string().min(1), path: z.string().startsWith('/') }).nullable(),
  hasStateArchive: z.boolean(),
  /**
   * Keyed by question text. The resumed session re-runs the deferred AskUserQuestion call and the
   * runner's pre-tool hook supplies these answers.
   */
  answer: z
    .object({
      requestId: z.uuid(),
      toolUseId: z.string(),
      answers: z.record(z.string(), z.string()),
    })
    .nullable(),
  /** An added repository is also among `repositories`. */
  repositoryDecision: z.object({ key: z.string(), added: z.boolean() }).nullable(),
});
export type TurnAssignment = z.infer<typeof TurnAssignmentSchema>;

export const HeartbeatRequestSchema = z.object({
  versions: RunnerVersionsSchema,
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const HeartbeatResponseSchema = z.object({
  /** True when the run became terminal: end the session, skip pushes, do not complete. */
  stop: z.boolean(),
  leaseExpiresAt: z.iso.datetime(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

export const AGENT_TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

const boundedText = z.string().max(16_384);

/** Caps on the structured activity events; each event stays well under the server's stored-payload cap. */
export const MAX_TOOL_TARGET_CHARS = 500;
export const MAX_TOOL_SUMMARY_CHARS = 200;
export const MAX_TOOL_ERROR_OUTPUT_CHARS = 4_000;
export const MAX_TOOL_INTENT_IDS = 50;
export const MAX_AGENT_MESSAGE_CHARS = 4_000;

/**
 * Status, turn and run events are server-owned and deliberately absent, so a runner cannot forge a
 * status change. `message`, `tool`, `skill` and `result` were added within protocol version 1 and
 * replace `raw`; a server must still accept `raw` from older runners. Upgrade the server first.
 */
export const RunnerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('phase'), phase: z.string().min(1).max(64) }),
  z.object({
    type: z.literal('todos'),
    items: z.array(z.object({ text: z.string().max(2_000), status: z.enum(AGENT_TODO_STATUSES) })).max(200),
  }),
  z.object({ type: z.literal('raw'), text: boundedText }),
  z.object({ type: z.literal('message'), text: z.string().max(MAX_AGENT_MESSAGE_CHARS) }),
  /** One tool call, reported when its result arrives (or when the session ended without one). */
  z.object({
    type: z.literal('tool'),
    /** The tool's name; for an MCP tool, the name within its server. */
    name: z.string().min(1).max(200),
    server: z.string().min(1).max(200).optional(),
    target: z.string().max(MAX_TOOL_TARGET_CHARS).optional(),
    summary: z.string().max(MAX_TOOL_SUMMARY_CHARS).optional(),
    isError: z.boolean(),
    errorOutput: z.string().max(MAX_TOOL_ERROR_OUTPUT_CHARS).optional(),
    /** Items a `get_intent_context` returned, or an `intent_propose` created or updated. */
    intentIds: z.array(z.string().min(1).max(200)).max(MAX_TOOL_INTENT_IDS).optional(),
  }),
  /** A skill the agent loaded, by its full name (`plugin:skill`). */
  z.object({ type: z.literal('skill'), name: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('result'),
    summary: z.string().max(4_000),
    points: z.array(z.string().max(2_000)).max(100),
  }),
  z.object({
    type: z.literal('done'),
    ok: z.boolean(),
    error: boundedText.optional(),
    costUsd: z.number().nonnegative().optional(),
    numTurns: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;

export const MAX_EVENTS_PER_BATCH = 100;

export const EventBatchSchema = z.object({
  events: z.array(RunnerEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type EventBatch = z.infer<typeof EventBatchSchema>;

export const EventBatchResponseSchema = z.object({
  seqs: z.array(z.number().int().positive()),
  stop: z.boolean(),
});
export type EventBatchResponse = z.infer<typeof EventBatchResponseSchema>;

/** Null when no SDK result arrived (spend unknown). */
export const TurnSpendSchema = z
  .object({
    costUsd: z.number().nonnegative(),
    sdkTurns: z.number().int().nonnegative().optional(),
  })
  .nullable();

export const TurnOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ended') }),
  z.object({ kind: z.literal('failed'), code: z.enum(RUNNER_FAILURE_CODES), reason: z.string().max(2_000) }),
  /** Duration limit or SDK turn cap reached without a run-control outcome: the work is pushed and the run continues. */
  z.object({ kind: z.literal('checkpoint') }),
  /**
   * The model stayed unavailable through Claude Code's own retries. The server re-queues the turn,
   * consuming an attempt; the last attempt fails the run with `agent_error` and this reason.
   */
  z.object({ kind: z.literal('transient'), reason: z.string().max(2_000) }),
]);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/** Above this a withheld workflow diff is reported by its paths only. */
export const MAX_WORKFLOW_DIFF_BYTES = 64 * 1024;

const repositoryPath = z.string().min(1).max(1_024);
const commitSha = z.string().regex(/^[0-9a-f]{40,64}$/);

export const RepositoryReportSchema = z.object({
  key: z.string().trim().min(1).max(255),
  /** Null when the run branch is not on the remote. */
  pushedHead: commitSha.nullable(),
  /** Reported by path only. */
  withheldPaths: z.array(repositoryPath).max(500),
  /** `diff` only when it passed the secret scan and fits the cap. */
  workflowDiff: z
    .object({
      paths: z.array(repositoryPath).min(1).max(100),
      diff: z.string().max(MAX_WORKFLOW_DIFF_BYTES).nullable(),
      note: z.string().max(500).nullable(),
    })
    .nullable(),
  /** Binary files the secret scan could not review; listed for a person instead of blocking the push. */
  binaryPaths: z.array(repositoryPath).max(500),
});
export type RepositoryReport = z.infer<typeof RepositoryReportSchema>;

/** Untrusted: the server reads every reported pull request back from GitHub and re-checks an unchanged repository. */
export const DeliveryReportSchema = z.object({
  key: z.string().trim().min(1).max(255),
  /** Null when GitHub refused a pull request for having no commits. */
  pullRequest: z.object({ number: z.number().int().positive() }).nullable(),
});
export type DeliveryReport = z.infer<typeof DeliveryReportSchema>;

export const CompleteTurnRequestSchema = z.object({
  outcome: TurnOutcomeSchema,
  spend: TurnSpendSchema,
  versions: RunnerVersionsSchema,
  repositories: z.array(RepositoryReportSchema).max(50).default([]),
  /** Reported even after a stop. */
  deliveries: z.array(DeliveryReportSchema).max(50).default([]),
  /** The failure reason when a second outcome-less turn in a row fails the run. */
  lastMessage: z.string().max(2_000).nullable().optional(),
});
export type CompleteTurnRequest = z.input<typeof CompleteTurnRequestSchema>;
export type CompleteTurn = z.output<typeof CompleteTurnRequestSchema>;

export const CompleteTurnResponseSchema = z.object({
  completed: z.literal(true),
});
export type CompleteTurnResponse = z.infer<typeof CompleteTurnResponseSchema>;

const shortText = z.string().trim().min(1).max(2_000);

/** Size cap on a proposal's spec markdown; the server also checks it in bytes. */
export const MAX_SPEC_MARKDOWN_CHARS = 256 * 1024;

/** Bounds shapes only; the server checks the scope rules and returns broken ones to the agent as a tool error. */
export const ProposeScopeRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4_000),
  specMarkdown: z.string().min(1).max(MAX_SPEC_MARKDOWN_CHARS),
  repositories: z
    .array(z.object({ key: z.string().trim().min(1).max(255), reason: shortText, changes: shortText }))
    .max(50),
  /** Repository keys in the order their pull requests should merge; defaults to the listed order. */
  mergeOrder: z.array(z.string().trim().min(1).max(255)).max(50).default([]),
  risks: z.array(shortText).max(50).default([]),
  intentReferences: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  assumptions: z.array(shortText).max(50).default([]),
  droppedSeeds: z
    .array(z.object({ key: z.string().trim().min(1).max(255), reason: shortText }))
    .max(50)
    .default([]),
  /** Product questions the PRD leaves open; never decided by the agent. */
  candidates: z
    .array(z.object({ question: shortText, blocks: shortText }))
    .max(50)
    .default([]),
});
export type ProposeScopeRequest = z.input<typeof ProposeScopeRequestSchema>;
export type ProposeScope = z.output<typeof ProposeScopeRequestSchema>;

export const ProposeScopeResponseSchema = z.discriminatedUnion('accepted', [
  /** Stored as this turn's draft version; published when the turn completes. */
  z.object({ accepted: z.literal(true), version: z.number().int().positive(), stop: z.boolean() }),
  z.object({ accepted: z.literal(false), errors: z.array(z.string()).min(1), stop: z.boolean() }),
]);
export type ProposeScopeResponse = z.infer<typeof ProposeScopeResponseSchema>;

/** Claude Code's AskUserQuestion shape; the host adds the free-text "Other" answer. */
export const AskedQuestionSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  header: z.string().trim().min(1).max(64),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        description: z.string().max(2_000),
        preview: z.string().max(16_384).optional(),
      }),
    )
    .min(2)
    .max(4),
  multiSelect: z.boolean().default(false),
});
export type AskedQuestion = z.output<typeof AskedQuestionSchema>;

export const ReportQuestionRequestSchema = z.object({
  /** The AskUserQuestion call's tool use id; the resume turn re-runs that call. */
  toolUseId: z.string().min(1).max(255),
  questions: z.array(AskedQuestionSchema).min(1).max(4),
});
export type ReportQuestionRequest = z.input<typeof ReportQuestionRequestSchema>;
export type ReportQuestion = z.output<typeof ReportQuestionRequestSchema>;

export const ReportQuestionResponseSchema = z.discriminatedUnion('state', [
  /** Pause policy: the question waits for a person; defer the call so the session ends without losing it. */
  z.object({ state: z.literal('open'), requestId: z.uuid(), stop: z.boolean() }),
  /** Assume policy: answer the call at once with these answers, keyed by question text. */
  z.object({
    state: z.literal('auto_answered'),
    requestId: z.uuid(),
    answers: z.record(z.string(), z.string()),
    stop: z.boolean(),
  }),
  /** Not recorded (the run ended, or a question is already open); do not let the call through. */
  z.object({ state: z.literal('refused'), reason: z.string(), stop: z.boolean() }),
]);
export type ReportQuestionResponse = z.infer<typeof ReportQuestionResponseSchema>;

export const RunnerErrorBodySchema = z.object({
  code: z.string().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
});

/** Ends the turn; the run moves to delivery only when the end-of-turn push touched a repository. */
export const SubmitResultRequestSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  repositories: z
    .array(z.object({ key: z.string().trim().min(1).max(255), summary: shortText }))
    .max(50)
    .default([]),
  assumptions: z.array(shortText).max(50).default([]),
  notBuiltOrTested: z
    .array(z.object({ key: z.string().trim().min(1).max(255), reason: shortText }))
    .max(50)
    .default([]),
  notes: z.string().trim().max(4_000).default(''),
});
export type SubmitResultRequest = z.input<typeof SubmitResultRequestSchema>;
export type SubmitResult = z.output<typeof SubmitResultRequestSchema>;

export const SubmitResultResponseSchema = z.discriminatedUnion('accepted', [
  /** Stored as this turn's result; the completion transaction applies it. */
  z.object({ accepted: z.literal(true), stop: z.boolean() }),
  z.object({ accepted: z.literal(false), errors: z.array(z.string()).min(1), stop: z.boolean() }),
]);
export type SubmitResultResponse = z.infer<typeof SubmitResultResponseSchema>;

/** Validated like proposal repositories and against the repository cap. */
export const RequestRepoRequestSchema = z.object({
  key: z.string().trim().min(1).max(255),
  reason: shortText,
});
export type RequestRepoRequest = z.input<typeof RequestRepoRequestSchema>;
export type RequestRepo = z.output<typeof RequestRepoRequestSchema>;

export const RequestRepoResponseSchema = z.discriminatedUnion('state', [
  /** Appended under automatic acceptance, or already there: clone it unless this turn has, and continue. */
  z.object({ state: z.literal('added'), repository: AssignedRepositorySchema, stop: z.boolean() }),
  /** Required acceptance: a person decides when the turn ends, so end it. */
  z.object({ state: z.literal('requested'), stop: z.boolean() }),
  /** Nothing was recorded. */
  z.object({ state: z.literal('rejected'), errors: z.array(z.string()).min(1), stop: z.boolean() }),
]);
export type RequestRepoResponse = z.infer<typeof RequestRepoResponseSchema>;

/** Sent before the runner's first push of the run branch to a repository. */
export const ReserveBranchRequestSchema = z.object({
  repository: z.string().trim().min(1).max(255),
});
export type ReserveBranchRequest = z.infer<typeof ReserveBranchRequestSchema>;

export const ReserveBranchResponseSchema = z.object({
  reserved: z.literal(true),
  branch: z.string(),
});
export type ReserveBranchResponse = z.infer<typeof ReserveBranchResponseSchema>;
