/**
 * Telemetry event/id vocabulary — the single source of truth for event names,
 * error codes, pipeline step names, and the base props auto-carried on every
 * event.
 *
 * String VALUES are byte-identical to what is emitted on the wire (PostHog
 * event name, `error_code` prop, etc.) — do not change them once shipped.
 * Callsites reference members (`EventName.ParseCompleted`), never bare
 * string literals.
 */

/** Telemetry event names emitted across the CLI/desktop/MCP surfaces. */
export enum EventName {
  CommandCompleted = 'command_completed',
  CommandFailed = 'command_failed',
  RepoAdded = 'repo_added',
  ProfileAuthored = 'profile_authored',
  ParseCompleted = 'parse_completed',
  ParseFailed = 'parse_failed',
  ParseAnomaly = 'parse_anomaly',
  SummarizeCompleted = 'summarize_completed',
  PushCompleted = 'push_completed',
  PushFailed = 'push_failed',
  ResolveCompleted = 'resolve_completed',
  McpFirstAnswer = 'mcp_first_answer',
  McpSessionSummary = 'mcp_session_summary',
  McpFeedback = 'mcp_feedback',
  AgentRun = 'agent_run',
}

/**
 * Closed error-code vocabulary, shared across two purposes:
 *  - the `error_code` prop on every `*_failed` event
 *  - the `rule_id` vocabulary for parse anomalies (`ParseAnomaly` events)
 *
 * Keep closed and small (YAGNI) — do not add a code with no emitter.
 */
export enum ErrorCode {
  // Failure codes (`*_failed` events' `error_code` prop)
  WasmMissing = 'wasm_missing',
  AuthFailed = 'auth_failed',
  NetworkError = 'network_error',
  ParseError = 'parse_error',
  PushRejected = 'push_rejected',
  Unknown = 'unknown',

  // Anomaly rule_ids (parse-anomaly detection, consumed by detectParseAnomalies())
  // WasmMissing above doubles as the third anomaly hint — no extra member needed.
  ZeroCallsNonzeroFunctions = 'zero_calls_nonzero_functions',
  ErrorRateGt20Pct = 'error_rate_gt_20pct',
}

/** Pipeline step names used in parse timing/anomaly breakdowns. */
export enum StepName {
  Substrate = 'substrate',
  Scip = 'scip',
  Extract = 'extract',
  Write = 'write',
}

/** Surface an event originated from — a config/env value, not a constrained emit vocabulary. */
export type Surface = 'cli' | 'desktop' | 'ci' | 'mcp';

/** Schema version stamped onto every event's `schema_version` base prop. */
export const SCHEMA_VERSION = 1;

/**
 * Keys auto-carried on every event. Only the shape is defined here — how
 * these are populated (install id generation, session/invocation scoping,
 * etc.) is out of scope for this file.
 */
export interface BaseProps {
  install_id: string;
  session_id: string;
  invocation_id: string;
  surface: Surface;
  /** Optional — a command with no repo in scope has none. */
  repo_id?: string;
  cli_version: string;
  engine_version: string;
  platform: string;
  schema_version: number;
}

/**
 * Permissive event-prop bag. Closed-schema discipline is enforced by callers
 * passing enum-typed prop objects, not by this alias — no per-event
 * discriminated union in P0 (YAGNI).
 */
export type Props = Record<string, string | number | boolean | undefined>;
