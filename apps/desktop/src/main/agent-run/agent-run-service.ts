/**
 * Agent-run service — session registry + IPC bridge for profile-authoring runs.
 *
 * Owns the per-command Session (raw-log buffer, live snapshot, pending-question resolver),
 * forwards AgentRunEvents to the renderer over AGENT_RUN_EVENT, and resolves AskUserQuestion
 * round-trips via AGENT_RUN_ANSWER. On completion it emits the SAME COMMAND_COMPLETED contract
 * the old PTY path used, so the renderer's generate→parse→summarize→push chain is unchanged.
 *
 * Harness-agnostic: it talks to an AgentRunAdapter, not the SDK. Swapping in a Codex/Gemini/ACP
 * adapter is a one-line change here.
 */

import type { BrowserWindow, IpcMain } from 'electron';
import { emitAgentRun } from '@coredoc/core/telemetry';
import type { CloudChannelConfig } from '@coredoc/core/telemetry';
import { IpcChannels } from '../../shared/ipc-types.js';
import {
  AgentRunEventType,
  AgentRunPhase,
  type AgentRunAnswer,
  type AgentRunEvent,
  type AgentRunQuestion,
} from '../../shared/agent-run-types.js';
import type { AgentRunAdapter, AgentRunIO, AgentRunRequest } from './types.js';

interface PendingQuestion {
  requestId: string;
  questions: AgentRunQuestion[];
  resolve: (answers: string[][]) => void;
  reject: (err: Error) => void;
}

/** Coarse run economics, captured from the terminal Done event (0 until seen). */
interface RunEconomics {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

interface Session {
  id: string;
  mainWindow: BrowserWindow;
  abortController: AbortController;
  phase: AgentRunPhase;
  /** Error the adapter reported on its own Done event. */
  error?: string;
  pending: PendingQuestion | null;
  questionSeq: number;
  /** Count of AskUserQuestion round-trips shown to the user this run. */
  interventions: number;
  /** Folded from Done; stays zeroed when the adapter throws without a Done. */
  economics: RunEconomics;
  /**
   * This run's OWN cloud-workspace attribution, captured at START. Passed to
   * `emitAgentRun` at completion so the summary POSTs to THIS run's workspace —
   * never a concurrent run's (the process-global channel is not consulted).
   */
  cloud?: CloudChannelConfig;
}

const sessions = new Map<string, Session>();

function safeSend(win: BrowserWindow, channel: string, data: unknown): void {
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, data);
  } catch {
    /* window torn down mid-send — nothing to do */
  }
}

/** Fold an event into the session state the run's completion reads. */
function fold(session: Session, event: AgentRunEvent): void {
  switch (event.type) {
    case AgentRunEventType.Phase:
      session.phase = event.phase;
      break;
    case AgentRunEventType.QuestionResolved:
      if (session.pending?.requestId === event.requestId) session.pending = null;
      break;
    case AgentRunEventType.Done:
      session.phase = event.ok ? AgentRunPhase.Done : AgentRunPhase.Error;
      if (!event.ok && event.error) session.error = event.error;
      session.economics = {
        tokensIn: event.tokensIn ?? 0,
        tokensOut: event.tokensOut ?? 0,
        costUsd: event.costUsd ?? 0,
        turns: event.numTurns ?? 0,
        toolCalls: event.toolCalls ?? 0,
        durationMs: event.durationMs ?? 0,
      };
      break;
    // Question is folded in askQuestion (it also stores the resolver).
  }
}

function emit(session: Session, event: AgentRunEvent): void {
  fold(session, event);
  safeSend(session.mainWindow, IpcChannels.AGENT_RUN_EVENT, { id: session.id, event });
}

/**
 * Start an agent run. Resolves after the run ends and COMMAND_COMPLETED has been emitted.
 * The caller (command-runner) owns cleanup of its own registries; this owns the Session.
 */
export async function startAgentRun(
  id: string,
  request: AgentRunRequest,
  mainWindow: BrowserWindow,
  adapter: AgentRunAdapter,
): Promise<void> {
  const session: Session = {
    id,
    mainWindow,
    abortController: request.abortController,
    phase: AgentRunPhase.Starting,
    pending: null,
    questionSeq: 0,
    interventions: 0,
    economics: { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0, toolCalls: 0, durationMs: 0 },
    cloud: request.cloud,
  };
  sessions.set(id, session);

  // If the run is aborted while a question is outstanding, reject it so the adapter unwinds.
  const onAbort = () => session.pending?.reject(new Error('Run aborted'));
  request.abortController.signal.addEventListener('abort', onAbort);

  const io: AgentRunIO = {
    emit: (event) => emit(session, event),
    askQuestion: (questions) =>
      new Promise<string[][]>((resolve, reject) => {
        if (request.abortController.signal.aborted) {
          reject(new Error('Run aborted'));
          return;
        }
        const requestId = `${id}-q${++session.questionSeq}`;
        session.interventions += 1;
        session.pending = { requestId, questions, resolve, reject };
        emit(session, { type: AgentRunEventType.Question, requestId, questions });
      }),
  };

  let ok = false;
  let error: string | undefined;
  try {
    await adapter.run(request, io);
    // A well-behaved adapter emits Done itself; fall back to success if it didn't.
    ok = session.phase !== AgentRunPhase.Error;
    if (!ok) error = session.error;
    // The adapter reports what the harness CLAIMED; verify the deliverable actually exists.
    if (ok && request.verifyCompletion) {
      const failure = request.verifyCompletion();
      if (failure) {
        ok = false;
        error = failure;
        emit(session, { type: AgentRunEventType.Done, ok: false, error: failure });
      }
    }
    if (ok && request.finalizeCompletion) {
      const failure = request.finalizeCompletion();
      if (failure) {
        ok = false;
        error = failure;
        emit(session, { type: AgentRunEventType.Done, ok: false, error: failure });
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    // Aborted runs are a user action, not a failure to surface loudly.
    if (request.abortController.signal.aborted)
      error =
        request.abortController.signal.reason instanceof Error &&
        request.abortController.signal.reason.name !== 'AbortError'
          ? request.abortController.signal.reason.message
          : 'Cancelled';
    emit(session, { type: AgentRunEventType.Done, ok: false, error });
    ok = false;
  } finally {
    request.abortController.signal.removeEventListener('abort', onAbort);
    session.pending = null;
    sessions.delete(id);
  }

  // Record the run's economics (cloud) + a coarse aggregate (anon). Fire-and-forget:
  // emitAgentRun gates on opt-in and never throws. A thrown adapter (no Done) folds to
  // zeroed economics above, so failures are still counted. The run's own cloud target
  // (captured at START) is passed through so the summary POSTs to THIS run's workspace,
  // immune to a concurrent run re-wiring the process-global channel.
  const summary = {
    runId: session.id,
    kind: 'author-profile',
    outcome: ok ? 'success' : request.abortController.signal.aborted ? 'cancelled' : 'error',
    ...session.economics,
    interventions: session.interventions,
  };
  if (session.cloud) {
    emitAgentRun(summary, { cloud: session.cloud });
  } else {
    emitAgentRun(summary);
  }

  safeSend(mainWindow, IpcChannels.COMMAND_COMPLETED, {
    id,
    success: ok,
    exitCode: ok ? 0 : 1,
    ...(error ? { error } : {}),
  });
}

/** Resolve an outstanding AskUserQuestion. Returns false if there was nothing to answer. */
function answerAgentRun(id: string, answer: AgentRunAnswer): boolean {
  const session = sessions.get(id);
  if (!session?.pending || session.pending.requestId !== answer.requestId) return false;
  const { resolve, requestId } = session.pending;
  session.pending = null;
  emit(session, { type: AgentRunEventType.QuestionResolved, requestId });
  resolve(answer.answers);
  return true;
}

export function registerAgentRunHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.AGENT_RUN_ANSWER, (_event, id: string, answer: AgentRunAnswer) =>
    answerAgentRun(id, answer),
  );
}
