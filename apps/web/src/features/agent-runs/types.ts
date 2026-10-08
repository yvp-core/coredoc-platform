/**
 * Wire types of the cloud agent runs API, restated locally (the web app never
 * imports workspace packages). Mirrors
 * apps/server/src/modules/cloud-agent-runs/cloud-agent-run.service.ts
 * (`project`, `events`) and cloud-agent-run-settings.service.ts (`view`).
 */

export type RunStatus =
  | 'queued'
  | 'scoping'
  | 'awaiting_answer'
  | 'awaiting_scope_acceptance'
  | 'implementing'
  | 'delivering'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TurnKind = 'scope' | 'implement' | 'delivery';
export type TurnState = 'queued' | 'claimed' | 'completed' | 'abandoned';

export interface AgentRunTurn {
  id: string;
  kind: TurnKind;
  state: TurnState;
  ordinal: number;
  attempt: number;
  queuedAt: string;
  claimedAt: string | null;
}

export interface AgentRun {
  id: string;
  issueKey: string;
  status: RunStatus;
  phase: TurnKind;
  trigger: 'jira_label' | 'manual' | 'rerun';
  startedBy: string | null;
  runOwner: { userId: string; email: string | null };
  questionsPolicy: 'pause' | 'assume';
  scopeAcceptancePolicy: 'required' | 'automatic';
  model: string | null;
  branch: string;
  failureCode: string | null;
  failureReason: string | null;
  spend: { usd: number; maxUsd: number; unknownTurns: number };
  /** The queued or claimed turn, if any. */
  currentTurn: AgentRunTurn | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentRunList {
  runs: AgentRun[];
  nextOffset: number | null;
}

export interface AgentRunEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  truncated: boolean;
  createdAt: string;
}

export interface AgentRunEventPage {
  events: AgentRunEvent[];
  lastSeq: number;
}

export type RunnerRefusal = 'creator_not_admin' | 'runner_incompatible';

export interface RunnerTokenStatus {
  id: string;
  name: string;
  tokenPrefix: string | null;
  createdBy: string;
  createdByEmail: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  lastAction: 'claim' | 'heartbeat' | null;
  protocolVersion: number | null;
  versions: { runner?: string; sdk?: string; claudeCode?: string; plugin?: string } | null;
  refusal: RunnerRefusal | null;
  refusalDetail: string | null;
}

export interface AgentRunSettings {
  enabled: boolean;
  runOwner: { userId: string; email: string | null; valid: boolean } | null;
  triggerLabel: string;
  questionsPolicy: 'pause' | 'assume';
  scopeAcceptancePolicy: 'required' | 'automatic';
  maxSpendUsd: number;
  maxStartedRuns: number;
  maxRepositories: number;
  model: string | null;
  runnerTokens: RunnerTokenStatus[];
}
