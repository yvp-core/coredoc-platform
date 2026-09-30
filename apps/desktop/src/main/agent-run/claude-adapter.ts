/**
 * Claude adapter — drives a profile-authoring session with the Claude Agent SDK's `query()`
 * and maps its message stream onto the harness-agnostic AgentRunEvent contract.
 *
 * This is the ONLY place that touches SDK-specific types, so version drift is contained here.
 * `canUseTool` is our single permission decision point:
 *   - AskUserQuestion → interactive (io.askQuestion), answered back via updatedInput.answers
 *   - everything else → the pure `evaluateToolUse` policy
 * Denied tools return WITHOUT `interrupt`, so the agent self-corrects instead of dead-ending.
 */

import type { Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentRunEventType, AgentRunPhase, AgentTodoStatus } from '../../shared/agent-run-types';
import type { AgentRunQuestion, AgentTodoItem } from '../../shared/agent-run-types';
import { isE2EMode } from '../e2e-mode.js';
import { cleanRuntimeLog, createRuntimeLogFilter } from '../runtime-log.js';
import { evaluateToolUse } from './permission-policy';
import type { AgentRunAdapter, AgentRunIO, AgentRunRequest } from './types';
import { isCanonicalInside } from '../canonical-path.js';

type QueryFn = (params: { prompt: string; options?: Options }) => Query;

// The SDK is ESM-only (sdk.mjs) — must be dynamically imported from the CJS main bundle.
let _queryFn: QueryFn | null = null;
async function getRealQuery(): Promise<QueryFn> {
  if (!_queryFn) {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    _queryFn = mod.query as unknown as QueryFn;
  }
  return _queryFn;
}

const TODO_STATUS: Record<string, AgentTodoStatus> = {
  pending: AgentTodoStatus.Pending,
  in_progress: AgentTodoStatus.InProgress,
  completed: AgentTodoStatus.Completed,
};

/** Truncate a value to a compact one-line summary for the raw log. */
function summarize(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const oneLine = (s ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return JSON.stringify(item) ?? '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(value) ?? '';
}

function parseTodos(input: Record<string, unknown>): AgentTodoItem[] {
  let raw = input.todos as unknown;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const item = (t ?? {}) as Record<string, unknown>;
    const text = String(item.content ?? item.task ?? item.text ?? '');
    const status = TODO_STATUS[String(item.status ?? '')] ?? AgentTodoStatus.Pending;
    return { text, status };
  });
}

/** Map the SDK's AskUserQuestion tool input to our harness-agnostic question shape. */
function toQuestions(input: Record<string, unknown>): AgentRunQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.map((q) => {
    const item = (q ?? {}) as Record<string, unknown>;
    const options = Array.isArray(item.options)
      ? item.options.map((o) => {
          const opt = (o ?? {}) as Record<string, unknown>;
          return { label: String(opt.label ?? ''), description: String(opt.description ?? '') };
        })
      : [];
    return {
      question: String(item.question ?? ''),
      header: String(item.header ?? ''),
      multiSelect: Boolean(item.multiSelect),
      options,
    };
  });
}

/**
 * Build the SDK's expected `answers` map (question text → answer string; multi-select
 * comma-separated) from the user's per-question label selections.
 */
function toAnswersMap(questions: AgentRunQuestion[], answers: string[][]): Record<string, string> {
  const map: Record<string, string> = {};
  questions.forEach((q, i) => {
    map[q.question] = (answers[i] ?? []).join(', ');
  });
  return map;
}

export class ClaudeAdapter implements AgentRunAdapter {
  /** `queryFnFactory` is a test seam; production defaults to the real dynamic SDK import. */
  constructor(private readonly queryFnFactory: () => Promise<QueryFn> = getRealQuery) {}

  async run(req: AgentRunRequest, io: AgentRunIO): Promise<void> {
    if (isE2EMode(process.env)) {
      throw new Error(
        'ClaudeAdapter.run is blocked in E2E mode (COREDOC_DESKTOP_E2E=1) — no agent SDK session may start.',
      );
    }

    const query = await this.queryFnFactory();
    const scoreServer = req.scoreProfile
      ? await import('@anthropic-ai/claude-agent-sdk').then(({ createSdkMcpServer, tool }) =>
          createSdkMcpServer({
            name: 'coredoc',
            tools: [
              tool(
                'score_profile',
                'Score the current profile through Desktop. Desktop handles analysis mode, consent and tools. Call with no arguments.',
                {},
                async () => {
                  const result = await req.scoreProfile!();
                  return { content: [{ type: 'text', text: result.output }], isError: !result.success };
                },
              ),
            ],
          }),
        )
      : undefined;

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      context: { blockedPath?: string } = {},
    ): Promise<PermissionResult> => {
      if (toolName === 'mcp__coredoc__score_profile' && req.scoreProfile)
        return { behavior: 'allow', updatedInput: {} };
      if (toolName === 'AskUserQuestion') {
        const questions = toQuestions(input);
        try {
          const answers = await io.askQuestion(questions);
          req.onQuestionAnswered?.(questions, answers);
          return { behavior: 'allow', updatedInput: { ...input, answers: toAnswersMap(questions, answers) } };
        } catch {
          // Run was aborted while awaiting the user — end the turn.
          return { behavior: 'deny', message: 'The run was cancelled by the user.', interrupt: true };
        }
      }

      if (context.blockedPath) {
        return {
          behavior: 'deny',
          message: `Denied by the Claude sandbox: ${context.blockedPath} is outside the Coredoc profile scope.`,
        };
      }

      const decision = evaluateToolUse(toolName, input, req.policy);
      if (decision.action === 'deny') {
        io.emit({ type: AgentRunEventType.Raw, text: `[denied] ${toolName}: ${summarize(input, 100)}` });
        return { behavior: 'deny', message: decision.message };
      }
      return { behavior: 'allow', updatedInput: input };
    };

    io.emit({ type: AgentRunEventType.Phase, phase: AgentRunPhase.Running });

    const stderrFilter = createRuntimeLogFilter();
    const emitStderr = (text: string) => {
      const cleaned = text.trimEnd();
      if (cleaned) io.emit({ type: AgentRunEventType.Raw, text: `[stderr] ${cleaned}` });
    };

    const options: Options = {
      cwd: req.cwd,
      model: req.model,
      additionalDirectories: req.additionalDirectories,
      permissionMode: 'default',
      // Load NO ambient settings — not the user's global config and not the TARGET repo's own
      // .claude/ (which could inject unrelated CLAUDE.md/hooks/skills into the authoring session).
      // The author-profile skill is reached by absolute path from the prompt, not skill autoloading.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: scoreServer ? { coredoc: scoreServer } : {},
      // The SDK's default system prompt is empty; use Claude Code's so tool/skill following holds.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      abortController: req.abortController,
      env: req.env,
      executable: req.nodeExecPath as unknown as 'node',
      canUseTool,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        network: {
          allowedDomains: [],
          allowLocalBinding: false,
          allowUnixSockets: [],
          allowAllUnixSockets: false,
        },
        filesystem: {
          allowRead: req.policy.readDirs,
          allowWrite: req.policy.writeDirs,
          denyRead: req.policy.deniedPaths ?? [],
          denyWrite: req.policy.readDirs.filter(
            // A deny on a readable parent overrides the allow on its staged writable child.
            (readDir) =>
              !req.policy.writeDirs.some(
                (writeDir) => isCanonicalInside(readDir, writeDir) || isCanonicalInside(writeDir, readDir),
              ),
          ),
        },
      },
      stderr: (data: string) => {
        emitStderr(stderrFilter.push(data));
      },
      ...(req.claudeCliPath ? { pathToClaudeCodeExecutable: req.claudeCliPath } : {}),
    };

    // Per-run tool_use tally; rides the terminal Done event as `toolCalls`.
    const runState = { toolCalls: 0, bashCommands: new Map<string, string>() };

    try {
      for await (const message of query({ prompt: req.prompt, options })) {
        if (req.abortController.signal.aborted) break;
        this.handleMessage(message, io, runState, req);
      }
    } finally {
      emitStderr(stderrFilter.flush());
    }
  }

  private handleMessage(
    message: SDKMessage,
    io: AgentRunIO,
    runState: { toolCalls: number; bashCommands: Map<string, string> },
    req: AgentRunRequest,
  ): void {
    switch (message.type) {
      case 'assistant': {
        const content = message.message?.content ?? [];
        for (const block of content) {
          if (block.type === 'text') {
            const text = block.text.trim();
            if (text) io.emit({ type: AgentRunEventType.Raw, text: `[text] ${summarize(text)}` });
          } else if (block.type === 'tool_use') {
            runState.toolCalls += 1;
            const input = (block.input ?? {}) as Record<string, unknown>;
            if (block.name === 'Bash' && typeof input.command === 'string') {
              runState.bashCommands.set(block.id, input.command);
            }
            if (block.name === 'TodoWrite') {
              io.emit({ type: AgentRunEventType.Todos, items: parseTodos(input) });
            } else {
              io.emit({ type: AgentRunEventType.Raw, text: `[tool] ${block.name} ${summarize(input, 120)}` });
            }
          }
        }
        break;
      }

      case 'user': {
        const content = message.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const b = block as { content?: unknown; is_error?: boolean; tool_use_id?: string };
            const tag = b.is_error ? '[result:error]' : '[result]';
            const resultSummary = summarize(cleanRuntimeLog(toolResultText(b.content)), 120);
            if (resultSummary) io.emit({ type: AgentRunEventType.Raw, text: `${tag} ${resultSummary}` });
            const command = b.tool_use_id ? runState.bashCommands.get(b.tool_use_id) : undefined;
            if (command) {
              runState.bashCommands.delete(b.tool_use_id as string);
              req.onCommandCompleted?.({ command, success: !b.is_error, output: toolResultText(b.content) });
            }
          }
        }
        break;
      }

      case 'system': {
        const sys = message as { subtype?: string; model?: string };
        if (sys.subtype === 'init') {
          io.emit({ type: AgentRunEventType.Raw, text: `[init] model=${sys.model ?? 'unknown'}` });
        }
        break;
      }

      case 'result': {
        const res = message as {
          subtype?: string;
          total_cost_usd?: number;
          session_id?: string;
          errors?: string[];
          duration_ms?: number;
          num_turns?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        const ok = res.subtype === 'success';
        io.emit({
          type: AgentRunEventType.Done,
          ok,
          error: ok ? undefined : res.errors?.join(', ') || `Session ended: ${res.subtype ?? 'error'}`,
          costUsd: res.total_cost_usd,
          sessionId: res.session_id,
          numTurns: res.num_turns,
          tokensIn: res.usage?.input_tokens,
          tokensOut: res.usage?.output_tokens,
          toolCalls: runState.toolCalls,
          durationMs: res.duration_ms,
        });
        break;
      }
    }
  }
}
