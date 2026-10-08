/**
 * The runner API contract (SF-001): the only meeting point of the Coredoc
 * server and the customer-run agent runner. Both sides parse with these
 * schemas, so neither can drift without the other failing to compile or to
 * parse. Imports zod only, so the runner's dependency graph stays small.
 */
import { z } from 'zod';

/** Bumped on any incompatible change to the schemas below. */
export const RUNNER_PROTOCOL_VERSION = 1;
/** Protocol versions the server accepts on claim; anything else gets `RUNNER_INCOMPATIBLE`. */
export const SUPPORTED_RUNNER_PROTOCOL_VERSIONS: readonly number[] = [1];

/** Every request about a turn carries the claim's lease token in this header (reads included). */
export const RUNNER_LEASE_HEADER = 'x-coredoc-lease-token';

/** Typed refusal codes a runner branches on. */
export const RunnerErrorCode = {
  /** The lease is not this runner's any more (expired, re-claimed or unknown): stop the turn. */
  LeaseLost: 'LEASE_LOST',
  /** The server does not support the runner's protocol version. */
  RunnerIncompatible: 'RUNNER_INCOMPATIBLE',
  /** The uploaded state archive is over `MAX_STATE_ARCHIVE_BYTES`; the run failed with `archive_too_large`. */
  ArchiveTooLarge: 'ARCHIVE_TOO_LARGE',
} as const;
export type RunnerErrorCode = (typeof RunnerErrorCode)[keyof typeof RunnerErrorCode];

export const TURN_KINDS = ['scope', 'implement', 'delivery'] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

export const QUESTIONS_POLICIES = ['pause', 'assume'] as const;
export type QuestionsPolicy = (typeof QUESTIONS_POLICIES)[number];

export const SCOPE_ACCEPTANCE_POLICIES = ['required', 'automatic'] as const;
export type ScopeAcceptancePolicy = (typeof SCOPE_ACCEPTANCE_POLICIES)[number];

const versionString = z.string().trim().min(1).max(64);

/**
 * Cap on the state archive (Claude Code's config and session directory plus
 * the plugin's state home). Provisional until Phase 0 sizes a long run's
 * archive (SF-001 ticket 13); the runner checks it before uploading and the
 * server's body-size tier for the archive route is derived from it.
 */
export const MAX_STATE_ARCHIVE_BYTES = 128 * 1024 * 1024;

/**
 * Failures the runner detects and reports through `complete`. The server
 * fails the run with the code and keeps the reason (agent-written text stays
 * on the run page, never in Jira).
 */
export const RUNNER_FAILURE_CODES = [
  'plugin_missing',
  'session_mismatch',
  'agent_error',
  'archive_too_large',
  /** No spend left to bound a session with: the runner starts none. */
  'budget_exhausted',
] as const;
export type RunnerFailureCode = (typeof RUNNER_FAILURE_CODES)[number];

/** A repository the run works in (implement turns); the scope phase has none yet. */
export const AssignedRepositorySchema = z.object({
  key: z.string(),
  reason: z.string(),
  mergeOrder: z.number().int().nonnegative(),
});
export type AssignedRepository = z.infer<typeof AssignedRepositorySchema>;

/** Component versions a runner reports on claim, heartbeat and completion; shown in settings. */
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

export const TurnAssignmentSchema = z.object({
  turn: z.object({
    id: z.uuid(),
    kind: z.enum(TURN_KINDS),
    ordinal: z.number().int().positive(),
    /** 1 on the first claim; raised each time an expired lease re-queues the turn. */
    attempt: z.number().int().positive(),
    /** An answer, review feedback, a nudge or a continuation; null on a phase's first turn. */
    inputText: z.string().nullable(),
  }),
  lease: z.object({
    token: z.uuid(),
    expiresAt: z.iso.datetime(),
  }),
  run: z.object({
    id: z.uuid(),
    issueKey: z.string(),
    questionsPolicy: z.enum(QUESTIONS_POLICIES),
    scopeAcceptancePolicy: z.enum(SCOPE_ACCEPTANCE_POLICIES),
    /** Null means Claude Code's default model. */
    model: z.string().nullable(),
    /** The phase's predetermined session id. */
    sessionId: z.uuid(),
    remainingSpendUsd: z.number(),
    /**
     * Spend already reported for this phase's session. The pinned SDK reports
     * a resumed session's cost cumulatively, so a turn's spend is the result's
     * total minus this.
     */
    priorSessionSpendUsd: z.number().nonnegative(),
    maxTurnDurationSeconds: z.number().int().positive(),
    /** Repository keys named up front (labels or the manual start): the scope's starting points. */
    seeds: z.array(z.string()),
  }),
  /** The PRD, read from Jira when a scope turn is claimed; null for other kinds. */
  prd: z.object({ markdown: z.string() }).nullable(),
  repositories: z.array(AssignedRepositorySchema),
  /**
   * The per-turn MCP-only token for the Coredoc MCP, minted at claim and
   * deleted when the turn ends; `path` is resolved against the runner's API
   * base. Null for delivery turns.
   */
  mcp: z.object({ token: z.string().min(1), path: z.string().startsWith('/') }).nullable(),
  /** Whether a previous state archive exists to download before the session starts. */
  hasStateArchive: z.boolean(),
  /**
   * On the turn that resumes after a person answered a clarification: the
   * answers, keyed by question text as AskUserQuestion takes them. The
   * resumed session re-runs the deferred AskUserQuestion call and the
   * runner's pre-tool hook supplies these answers.
   */
  answer: z
    .object({
      requestId: z.uuid(),
      toolUseId: z.string(),
      answers: z.record(z.string(), z.string()),
    })
    .nullable(),
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

/**
 * Events a runner may report. Status, turn and run events are server-owned and
 * deliberately absent, so a runner can never forge a status change on the
 * timeline.
 */
export const RunnerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('phase'), phase: z.string().min(1).max(64) }),
  z.object({
    type: z.literal('todos'),
    items: z.array(z.object({ text: z.string().max(2_000), status: z.enum(AGENT_TODO_STATUSES) })).max(200),
  }),
  z.object({ type: z.literal('raw'), text: boundedText }),
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
  /** Sequence numbers the server assigned, in batch order. */
  seqs: z.array(z.number().int().positive()),
  stop: z.boolean(),
});
export type EventBatchResponse = z.infer<typeof EventBatchResponseSchema>;

/** Spend the SDK result reported for this turn; null when no result arrived (unknown spend). */
export const TurnSpendSchema = z
  .object({
    costUsd: z.number().nonnegative(),
    sdkTurns: z.number().int().nonnegative().optional(),
  })
  .nullable();

export const TurnOutcomeSchema = z.discriminatedUnion('kind', [
  /** The session ended normally; what it achieved is known from the turn's recorded reports. */
  z.object({ kind: z.literal('ended') }),
  /** The runner detected a failure that fails the run. */
  z.object({ kind: z.literal('failed'), code: z.enum(RUNNER_FAILURE_CODES), reason: z.string().max(2_000) }),
]);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

export const CompleteTurnRequestSchema = z.object({
  outcome: TurnOutcomeSchema,
  spend: TurnSpendSchema,
  versions: RunnerVersionsSchema,
  /** The agent's final message, the reason a second outcome-less turn in a row fails the run with. */
  lastMessage: z.string().max(2_000).nullable().optional(),
});
export type CompleteTurnRequest = z.infer<typeof CompleteTurnRequestSchema>;

export const CompleteTurnResponseSchema = z.object({
  completed: z.literal(true),
});
export type CompleteTurnResponse = z.infer<typeof CompleteTurnResponseSchema>;

const shortText = z.string().trim().min(1).max(2_000);

/** Size cap on a proposal's spec markdown; the server also checks it in bytes. */
export const MAX_SPEC_MARKDOWN_CHARS = 256 * 1024;

/**
 * `propose_scope`: the agent's scope proposal. The schema bounds shapes; the
 * rules (eligible repositories, seeds accounted for, the repository cap) are
 * checked by the server, and broken rules go back to the agent as a tool error.
 */
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
  /** Product questions the PRD leaves open, each with what it blocks; never decided by the agent. */
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
  /** Rules the proposal broke, for the agent to fix and propose again. */
  z.object({ accepted: z.literal(false), errors: z.array(z.string()).min(1), stop: z.boolean() }),
]);
export type ProposeScopeResponse = z.infer<typeof ProposeScopeResponseSchema>;

/**
 * One clarification in Claude Code's AskUserQuestion shape: a header, two to
 * four options with descriptions and optional previews, optional multiple
 * selection. The host adds the free-text "Other" answer.
 */
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

/** A question the agent asked through AskUserQuestion; the server decides by the run's policy what happens to it. */
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
  /** The question was not recorded (the run ended, or a question is already open); do not let it through. */
  z.object({ state: z.literal('refused'), reason: z.string(), stop: z.boolean() }),
]);
export type ReportQuestionResponse = z.infer<typeof ReportQuestionResponseSchema>;

/** The error body every runner-facing refusal carries. */
export const RunnerErrorBodySchema = z.object({
  code: z.string().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
});
