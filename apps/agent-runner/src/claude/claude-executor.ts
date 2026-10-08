/**
 * The Claude Code executor: runs one turn's agent session through the pinned
 * Agent SDK with the plugin loaded by path, the run preamble, the tool policy,
 * the Coredoc MCP and the run-control server, then reports what happened.
 * Scope turns only for now; implement turns land with SF-001 ticket 06.
 */
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MAX_STATE_ARCHIVE_BYTES, type TurnAssignment, type TurnOutcome } from '@coredoc/core/agent-runner';
import type { RunnerApiClient } from '../runner-api.js';
import type { TurnExecutor, TurnIO, TurnResult } from '../runner.js';
import { runPreamble, scopePrompt } from './prompts.js';
import { RUN_CONTROL_SERVER, type RunControlState, runControlServer } from './run-control.js';
import { sessionEnvironment } from './session-environment.js';
import { eventsFor } from './session-events.js';
import { extractStateArchive, packStateArchive } from './state-archive.js';
import { DENIED_TOOLS, evaluateToolUse } from './tool-policy.js';
import { createTurnDirectories, sessionExists, type TurnPaths, turnPaths, wipeScratch } from './turn-paths.js';

/** The SDK's `query`, injected so tests drive a scripted fake instead of a model. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/** A high fixed runaway guard (spec: 500), not a setting. */
const SDK_MAX_TURNS = 500;
/** Coredoc MCP tool calls are otherwise effectively unbounded. */
const MCP_TOOL_TIMEOUT_MS = 120_000;
/** Long enough for the plugin to suspend its run at session end; Phase 0 measures it with five clones. */
const SESSION_END_HOOK_TIMEOUT_MS = 120_000;

export interface ClaudeExecutorOptions {
  query: QueryFn;
  /** Resolves the assignment's MCP path against the Coredoc API base. */
  api: Pick<RunnerApiClient, 'resolve'>;
  /** The only writable volume; wiped at the end of every turn. */
  scratchRoot: string;
  /** The pinned coredoc-workflows plugin, loaded by path. */
  pluginPath: string;
  modelApiKey: string;
  modelBaseUrl?: string;
  hostEnv: NodeJS.ProcessEnv;
  maxArchiveBytes?: number;
  log?: (message: string) => void;
}

interface SessionOutcome {
  failure: { code: 'plugin_missing' | 'session_mismatch' | 'agent_error'; reason: string } | null;
  result: Extract<SDKMessage, { type: 'result' }> | null;
}

export class ClaudeExecutor implements TurnExecutor {
  private readonly log: (message: string) => void;

  constructor(private readonly options: ClaudeExecutorOptions) {
    this.log = options.log ?? (() => undefined);
  }

  async run(turn: TurnAssignment, io: TurnIO): Promise<TurnResult> {
    if (turn.turn.kind !== 'scope') {
      await io.emit([{ type: 'raw', text: `[runner] ${turn.turn.kind} turns are not supported by this runner yet` }]);
      return { spend: null };
    }
    const paths = turnPaths(this.options.scratchRoot, turn.run.id, turn.turn.id);
    try {
      await createTurnDirectories(paths);
      if (turn.hasStateArchive) await extractStateArchive(await io.downloadArchive(), paths.state);
      return await this.scopeTurn(turn, io, paths);
    } finally {
      await wipeScratch(this.options.scratchRoot);
    }
  }

  private async scopeTurn(turn: TurnAssignment, io: TurnIO, paths: TurnPaths): Promise<TurnResult> {
    const prdPath = join(paths.work, 'PRD.md');
    await writeFile(prdPath, turn.prd?.markdown ?? '(The server sent no PRD.)\n', 'utf8');

    const resume = sessionExists(paths, turn.run.sessionId);
    const firstPrompt = scopePrompt(turn, prdPath, join(paths.work, 'spec.md'));
    const prompt = resume
      ? (turn.turn.inputText ?? 'Continue where you stopped.')
      : turn.turn.inputText
        ? `${firstPrompt}\n\n${turn.turn.inputText}`
        : firstPrompt;

    const control: RunControlState = { proposedVersion: null };
    const session = await this.runSession(turn, io, paths, prompt, resume, control);
    if (io.signal.aborted) return { spend: spendOf(session.result, turn) };

    let outcome: TurnOutcome = { kind: 'ended' };
    if (session.failure && (session.failure.code !== 'agent_error' || control.proposedVersion === null)) {
      // Classified from the runner's own state: a recorded proposal outlives a late SDK error.
      outcome = { kind: 'failed', code: session.failure.code, reason: session.failure.reason.slice(0, 2_000) };
    }
    if (outcome.kind === 'ended') {
      const archive = await packStateArchive(paths.state);
      const cap = this.options.maxArchiveBytes ?? MAX_STATE_ARCHIVE_BYTES;
      if (archive.length > cap) {
        outcome = {
          kind: 'failed',
          code: 'archive_too_large',
          reason: `The session state archive is ${archive.length} bytes; the limit is ${cap}.`,
        };
      } else {
        await io.uploadArchive(archive);
      }
    }
    return { spend: spendOf(session.result, turn), outcome };
  }

  private async runSession(
    turn: TurnAssignment,
    io: TurnIO,
    paths: TurnPaths,
    prompt: string,
    resume: boolean,
    control: RunControlState,
  ): Promise<SessionOutcome> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    io.signal.addEventListener('abort', stop, { once: true });
    // Reaching the turn's duration limit stops the session; the server's checkpoint rule continues it.
    const deadline = setTimeout(stop, turn.run.maxTurnDurationSeconds * 1000);

    const outcome: SessionOutcome = { failure: null, result: null };
    const fail = (failure: NonNullable<SessionOutcome['failure']>) => {
      outcome.failure ??= failure;
      stop();
    };
    try {
      for await (const message of this.options.query({
        prompt,
        options: this.sessionOptions(turn, io, paths, resume, control, abort),
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          const problem = this.initProblem(message, turn.run.sessionId);
          if (problem) {
            fail(problem);
            break;
          }
        }
        if (message.type === 'result') {
          outcome.result = message;
          if (message.subtype !== 'success' || message.is_error) {
            const errors = 'errors' in message ? message.errors : [];
            fail({ code: 'agent_error', reason: errors?.join('; ') || `The session ended with ${message.subtype}` });
          }
        }
        const events = eventsFor(message);
        if (message.type === 'result') {
          events.push({
            type: 'done',
            ok: outcome.failure === null,
            costUsd: spendOf(message, turn)?.costUsd,
            numTurns: message.num_turns,
            durationMs: message.duration_ms,
          });
        }
        await io.emit(events);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        fail({ code: 'agent_error', reason: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      clearTimeout(deadline);
      io.signal.removeEventListener('abort', stop);
    }
    return outcome;
  }

  /** The plugin and its skills must be listed with no plugin errors, and the session must be the phase's. */
  private initProblem(
    init: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>,
    sessionId: string,
  ): SessionOutcome['failure'] {
    if (init.session_id !== sessionId) {
      return {
        code: 'session_mismatch',
        reason: `Claude Code reported session ${init.session_id}; the run expects ${sessionId}.`,
      };
    }
    const problem = pluginProblem(init, this.options.pluginPath);
    return problem ? { code: 'plugin_missing', reason: problem } : null;
  }

  private sessionOptions(
    turn: TurnAssignment,
    io: TurnIO,
    paths: TurnPaths,
    resume: boolean,
    control: RunControlState,
    abortController: AbortController,
  ): Options {
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const verdict = evaluateToolUse(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (verdict.decision === 'allow') return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      };
    };
    const mcpServers: Options['mcpServers'] = { [RUN_CONTROL_SERVER]: runControlServer(io, control) };
    if (turn.mcp) {
      // Under the key `coredoc`: the plugin recognises Coredoc tools by that name segment.
      mcpServers.coredoc = {
        type: 'http',
        url: this.options.api.resolve(turn.mcp.path),
        headers: { Authorization: `Bearer ${turn.mcp.token}` },
        timeout: MCP_TOOL_TIMEOUT_MS,
      };
    }
    return {
      cwd: paths.work,
      ...(resume ? { resume: turn.run.sessionId } : { sessionId: turn.run.sessionId }),
      ...(turn.run.model ? { model: turn.run.model } : {}),
      env: sessionEnvironment({
        hostEnv: this.options.hostEnv,
        paths,
        sessionId: turn.run.sessionId,
        modelApiKey: this.options.modelApiKey,
        modelBaseUrl: this.options.modelBaseUrl,
        sessionEndHookTimeoutMs: SESSION_END_HOOK_TIMEOUT_MS,
      }),
      // The target repositories' own Claude settings and hooks are never loaded.
      settingSources: [],
      plugins: [{ type: 'local', path: this.options.pluginPath }],
      mcpServers,
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: runPreamble(turn) },
      permissionMode: 'default',
      // AskUserQuestion is offered only when a permission callback is set; the policy lives in the hook.
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      disallowedTools: [...DENIED_TOOLS],
      maxTurns: SDK_MAX_TURNS,
      ...(turn.run.remainingSpendUsd > 0 ? { maxBudgetUsd: turn.run.remainingSpendUsd } : {}),
      abortController,
      stderr: (line) => this.log(`[claude] ${line.trimEnd()}`),
    };
  }
}

/** Why the init message says the plugin did not load, or null when it did. */
export function pluginProblem(
  init: {
    plugins?: Array<{ name: string; path: string }>;
    plugin_errors?: Array<{ plugin: string; message: string }>;
    skills?: string[];
  },
  pluginPath: string,
): string | null {
  if (init.plugin_errors?.length) {
    return `Plugin errors: ${init.plugin_errors.map((error) => `${error.plugin}: ${error.message}`).join('; ')}`;
  }
  const plugin = init.plugins?.find((candidate) => resolve(candidate.path) === resolve(pluginPath));
  if (!plugin) return `The plugin at ${pluginPath} is not listed by Claude Code.`;
  if (!init.skills?.some((skill) => skill.startsWith(`${plugin.name}:`))) {
    return `The plugin ${plugin.name} loaded without its skills.`;
  }
  return null;
}

/** The pinned SDK reports a resumed session's cost cumulatively; this turn's spend is the difference. */
function spendOf(result: SessionOutcome['result'], turn: TurnAssignment): TurnResult['spend'] {
  if (!result) return null;
  return {
    costUsd: Math.max(0, Math.round((result.total_cost_usd - turn.run.priorSessionSpendUsd) * 1e6) / 1e6),
    sdkTurns: result.num_turns,
  };
}
