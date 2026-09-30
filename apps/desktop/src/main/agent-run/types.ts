/**
 * Main-process-only agent-run interfaces.
 *
 * `AgentRunAdapter` is the seam that lets a future Codex/Gemini/ACP adapter drive the
 * same UI: each adapter maps its native stream onto AgentRunEvent (emitted via `io.emit`)
 * and its native interactive prompts onto `io.askQuestion`.
 */

import type { CloudChannelConfig } from '@coredoc/core/telemetry';
import type { AgentRunEvent, AgentRunQuestion } from '../../shared/agent-run-types';
import type { PolicyContext } from './permission-policy';

export interface AgentRunCommandResult {
  command: string;
  success: boolean;
  output: string;
}

export interface AgentRunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  /** Extra roots the agent may read (schema refs, authoring kit, parser storage). */
  additionalDirectories: string[];
  policy: PolicyContext;
  env: NodeJS.ProcessEnv;
  nodeExecPath: string;
  claudeCliPath?: string;
  abortController: AbortController;
  /**
   * The run's OWN cloud-workspace attribution, resolved at run START. Bound to
   * the run (not the process) so concurrent agent-runs can't cross-attribute
   * their economics: it is passed straight to `emitAgentRun` at completion.
   * Absent for local-only projects (anon aggregate only).
   */
  cloud?: CloudChannelConfig;
  /**
   * Post-run validation of the run's deliverable, called only when the adapter reported
   * success. A returned message converts the run into a failure with that error — the
   * guard against a harness ending its turn claiming success without producing the
   * artifact (observed with Codex finishing "done" while profile.ts was never written).
   */
  verifyCompletion?: () => string | null;
  /** Whether the isolated deliverable currently exists, used to reserve a bounded final repair turn. */
  deliverableExists?: () => boolean;
  /**
   * Commit a verified deliverable before success is published to the renderer. A returned
   * message converts the run into a failure. Generate uses this to atomically promote an
   * isolated candidate profile only after the final verification pass.
   */
  finalizeCompletion?: () => string | null;
  /** Observe the harness result for an app-approved command without trusting model narration. */
  onCommandCompleted?: (result: AgentRunCommandResult) => void;
  /** Observe the exact user selections returned through the harness-native question tool. */
  onQuestionAnswered?: (questions: AgentRunQuestion[], answers: string[][]) => void;
  /** App-owned scoring; the agent supplies no paths, commands, or compiler permissions. */
  scoreProfile?: () => Promise<{ success: boolean; output: string }>;
}

export interface AgentRunIO {
  emit(event: AgentRunEvent): void;
  /**
   * Ask the user something and resolve with their selections: `answers[i]` are the chosen
   * option labels (or a single free-text entry) for `questions[i]`. Rejects if the run is
   * aborted before the user answers.
   */
  askQuestion(questions: AgentRunQuestion[]): Promise<string[][]>;
}

export interface AgentRunAdapter {
  /** Resolves when the session ends (success, error, or abort). */
  run(req: AgentRunRequest, io: AgentRunIO): Promise<void>;
}
