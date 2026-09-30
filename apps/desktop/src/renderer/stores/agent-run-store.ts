import { create } from 'zustand';
import {
  AgentRunEventType,
  AgentRunPhase,
  type AgentRunEvent,
  type AgentRunEventEnvelope,
  type AgentRunQuestion,
  type AgentTodoItem,
} from '../../shared/agent-run-types';

export interface AgentRun {
  phase: AgentRunPhase;
  todos: AgentTodoItem[];
  pendingQuestion: { requestId: string; questions: AgentRunQuestion[] } | null;
  /** Full structured transcript, shown only in the collapsible debug panel. */
  rawLog: string;
  error?: string;
  costUsd?: number;
}

export function initialAgentRun(): AgentRun {
  return { phase: AgentRunPhase.Starting, todos: [], pendingQuestion: null, rawLog: '' };
}

/**
 * Pure reducer: fold one event into a run. Exported for unit testing — no DOM, no IPC.
 * Raw-log growth is bounded on the main side; the renderer just appends.
 */
export function applyAgentRunEvent(run: AgentRun, event: AgentRunEvent): AgentRun {
  switch (event.type) {
    case AgentRunEventType.Phase:
      return { ...run, phase: event.phase };
    case AgentRunEventType.Todos:
      return { ...run, todos: event.items };
    case AgentRunEventType.Question:
      return { ...run, pendingQuestion: { requestId: event.requestId, questions: event.questions } };
    case AgentRunEventType.QuestionResolved:
      return run.pendingQuestion?.requestId === event.requestId ? { ...run, pendingQuestion: null } : run;
    case AgentRunEventType.Raw:
      return { ...run, rawLog: run.rawLog + `${event.text}\n` };
    case AgentRunEventType.Done:
      return {
        ...run,
        phase: event.ok ? AgentRunPhase.Done : AgentRunPhase.Error,
        pendingQuestion: null,
        error: event.error,
        costUsd: event.costUsd,
      };
    default:
      return run;
  }
}

interface AgentRunStoreState {
  runs: Map<string, AgentRun>;
  applyEvent: (envelope: AgentRunEventEnvelope) => void;
  answerQuestion: (id: string, requestId: string, answers: string[][]) => Promise<void>;
  dismissRun: (id: string) => void;
}

let agentRunCleanup: (() => void) | undefined;

export const useAgentRunStore = create<AgentRunStoreState>((set, get) => {
  if (typeof window !== 'undefined' && window.electronAPI) {
    agentRunCleanup?.(); // HMR: drop the previous subscription
    agentRunCleanup = window.electronAPI.onAgentRunEvent((envelope) => get().applyEvent(envelope));
  }

  return {
    runs: new Map(),

    applyEvent: ({ id, event }) => {
      set((state) => {
        const next = new Map(state.runs);
        const current = next.get(id) ?? initialAgentRun();
        next.set(id, applyAgentRunEvent(current, event as AgentRunEvent));
        return { runs: next };
      });
    },

    answerQuestion: async (id, requestId, answers) => {
      // Optimistically clear the prompt so the UI can't double-submit.
      set((state) => {
        const run = state.runs.get(id);
        if (!run?.pendingQuestion || run.pendingQuestion.requestId !== requestId) return state;
        const next = new Map(state.runs);
        next.set(id, { ...run, pendingQuestion: null });
        return { runs: next };
      });
      await window.electronAPI.answerAgentRun(id, { requestId, answers });
    },

    dismissRun: (id) => {
      set((state) => {
        if (!state.runs.has(id)) return state;
        const next = new Map(state.runs);
        next.delete(id);
        return { runs: next };
      });
    },
  };
});
