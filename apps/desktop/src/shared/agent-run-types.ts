/**
 * Agent-run event contract — harness-agnostic.
 *
 * The main process runs an agent session (today: Claude Agent SDK; later possibly
 * Codex/Gemini/ACP adapters) and streams these events to the renderer, which renders
 * a minimal step-progress UI. Renderer and IPC never see harness-specific types —
 * every adapter maps its native stream onto this union.
 */

export enum AgentRunPhase {
  Starting = 'starting',
  Running = 'running',
  Done = 'done',
  Error = 'error',
}

export enum AgentTodoStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Completed = 'completed',
}

export enum AgentRunEventType {
  Phase = 'phase',
  Todos = 'todos',
  Question = 'question',
  QuestionResolved = 'question_resolved',
  Raw = 'raw',
  Done = 'done',
}

export interface AgentTodoItem {
  text: string;
  status: AgentTodoStatus;
}

export interface AgentRunQuestionOption {
  label: string;
  description: string;
}

export interface AgentRunQuestion {
  question: string;
  /** Short chip/tag label (e.g. "Coverage"). */
  header: string;
  multiSelect: boolean;
  options: AgentRunQuestionOption[];
}

export type AgentRunEvent =
  | { type: AgentRunEventType.Phase; phase: AgentRunPhase }
  | { type: AgentRunEventType.Todos; items: AgentTodoItem[] }
  | { type: AgentRunEventType.Question; requestId: string; questions: AgentRunQuestion[] }
  | { type: AgentRunEventType.QuestionResolved; requestId: string }
  /** One compact transcript line for the collapsible debug log (never shown by default). */
  | { type: AgentRunEventType.Raw; text: string }
  | {
      type: AgentRunEventType.Done;
      ok: boolean;
      error?: string;
      costUsd?: number;
      sessionId?: string;
      /** Coarse run economics, forwarded from the harness result message when available. */
      numTurns?: number;
      tokensIn?: number;
      tokensOut?: number;
      /** Count of tool_use blocks observed across the run (incl. TodoWrite). */
      toolCalls?: number;
      durationMs?: number;
    };

/** Envelope sent over AGENT_RUN_EVENT; `id` is the command id the run belongs to. */
export interface AgentRunEventEnvelope {
  id: string;
  event: AgentRunEvent;
}

/**
 * The user's answer to a Question event. `answers[i]` holds the selected option labels
 * (or a single free-text entry) for `questions[i]` — one element for single-select,
 * several for multiSelect.
 */
export interface AgentRunAnswer {
  requestId: string;
  answers: string[][];
}

/** Snapshot for renderer reload recovery (AGENT_RUN_GET_STATE). */
export interface AgentRunSnapshot {
  phase: AgentRunPhase;
  todos: AgentTodoItem[];
  pendingQuestion: { requestId: string; questions: AgentRunQuestion[] } | null;
  rawLog: string;
}
