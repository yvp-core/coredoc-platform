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
} as const;
export type RunnerErrorCode = (typeof RunnerErrorCode)[keyof typeof RunnerErrorCode];

export const TURN_KINDS = ['scope', 'implement', 'delivery'] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

export const QUESTIONS_POLICIES = ['pause', 'assume'] as const;
export type QuestionsPolicy = (typeof QUESTIONS_POLICIES)[number];

export const SCOPE_ACCEPTANCE_POLICIES = ['required', 'automatic'] as const;
export type ScopeAcceptancePolicy = (typeof SCOPE_ACCEPTANCE_POLICIES)[number];

const versionString = z.string().trim().min(1).max(64);

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
    maxTurnDurationSeconds: z.number().int().positive(),
  }),
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

export const CompleteTurnRequestSchema = z.object({
  /** The session ended normally; what it achieved is known from the turn's recorded reports. */
  outcome: z.object({ kind: z.literal('ended') }),
  spend: TurnSpendSchema,
  versions: RunnerVersionsSchema,
});
export type CompleteTurnRequest = z.infer<typeof CompleteTurnRequestSchema>;

export const CompleteTurnResponseSchema = z.object({
  completed: z.literal(true),
});
export type CompleteTurnResponse = z.infer<typeof CompleteTurnResponseSchema>;

/** The error body every runner-facing refusal carries. */
export const RunnerErrorBodySchema = z.object({
  code: z.string().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
});
