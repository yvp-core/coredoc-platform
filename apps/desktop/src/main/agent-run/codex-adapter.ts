import path from 'node:path';
import { AgentRunEventType, AgentRunPhase, AgentTodoStatus } from '../../shared/agent-run-types.js';
import type { AgentRunQuestion, AgentTodoItem } from '../../shared/agent-run-types.js';
import { CodexAppServerClient, isApprovedCommand } from '../codex-app-server.js';
import type { CodexAppServerMessage, CodexAppServerRunOptions, CodexAppServerRunResult } from '../codex-app-server.js';
import { isE2EMode } from '../e2e-mode.js';
import { cleanRuntimeLog } from '../runtime-log.js';
import type { AgentRunAdapter, AgentRunIO, AgentRunRequest } from './types.js';

interface CodexClient {
  run(options: CodexAppServerRunOptions): Promise<CodexAppServerRunResult>;
}

type CodexClientFactory = (executablePath: string) => CodexClient;

const PROFILE_ID = 'coredoc-profile';
// Codex ends a turn whenever the model decides to stop (often while directional scouts are still
// finishing), so bound the pre-draft loop separately from the final repair. Four scout hand-offs
// consumed the old shared five-turn cap in production and left no turn to re-score the final bytes.
const MAX_TURNS_WITHOUT_DELIVERABLE = 5;
const MAX_DELIVERABLE_RECOVERY_TURNS = 1;
const REQUEST_USER_INPUT_TOOL = 'coredoc_request_user_input';
const REQUEST_USER_INPUT_DYNAMIC_TOOL = {
  type: 'function' as const,
  name: REQUEST_USER_INPUT_TOOL,
  description:
    'Ask the Coredoc user one to three short questions and wait for their answers. Use this instead of asking in assistant text.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            header: { type: 'string' },
            question: { type: 'string' },
            multiSelect: { type: 'boolean' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { label: { type: 'string' }, description: { type: 'string' } },
                required: ['label', 'description'],
              },
            },
          },
          required: ['id', 'header', 'question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
};
const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
]);
// Echoed prompts and reasoning stubs (Codex sends them as items with empty content) are not trace.
const SILENT_ITEM_TYPES = new Set(['userMessage', 'reasoning']);

function summarize(value: unknown, max = 160): string {
  const text = (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summarizeTail(value: unknown, max = 2_000): string {
  const text = (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function todoStatus(status: unknown): AgentTodoStatus {
  if (status === 'completed') return AgentTodoStatus.Completed;
  if (status === 'inProgress' || status === 'in_progress') return AgentTodoStatus.InProgress;
  return AgentTodoStatus.Pending;
}

function questionsFrom(params: Record<string, unknown>): {
  ids: string[];
  questions: AgentRunQuestion[];
} {
  const source = Array.isArray(params.questions) ? params.questions : [];
  const ids: string[] = [];
  const questions = source.map((raw, index) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    ids.push(String(item.id ?? `question-${index + 1}`));
    const options = Array.isArray(item.options)
      ? item.options.map((rawOption) => {
          const option = (rawOption ?? {}) as Record<string, unknown>;
          return {
            label: String(option.label ?? option.value ?? ''),
            description: String(option.description ?? ''),
          };
        })
      : [];
    return {
      question: String(item.question ?? ''),
      header: String(item.header ?? ''),
      multiSelect: Boolean(item.multiSelect),
      options,
    };
  });
  return { ids, questions };
}

export function buildCodexProfileConfig(req: AgentRunRequest): Record<string, unknown> {
  const filesystem: Record<string, 'read' | 'write' | 'deny'> = {
    ':root': 'deny',
    ':minimal': 'read',
  };
  for (const readDir of req.policy.readDirs) filesystem[readDir] = 'read';
  // The score command's toolchain (Node runtime, CLI bundle, resolved modules) must be readable
  // under this deny-by-default profile or the allow-listed command cannot even start.
  for (const toolchainDir of req.policy.toolchainReadDirs ?? []) filesystem[toolchainDir] = 'read';
  for (const writeDir of req.policy.writeDirs) filesystem[writeDir] = 'write';

  // Credentials are not profile-authoring inputs, including when parser storage is itself a read root.
  for (const readDir of new Set([
    ...req.policy.readDirs,
    ...(req.policy.toolchainReadDirs ?? []),
    ...req.policy.writeDirs,
  ])) {
    for (const pattern of ['.env', '.env.*', '**/.env', '**/.env.*']) {
      filesystem[path.join(readDir, pattern)] = 'deny';
    }
  }

  return {
    project_doc_max_bytes: 0,
    web_search: 'disabled',
    features: { multi_agent: true },
    tools: { experimental_request_user_input: { enabled: false } },
    permissions: {
      [PROFILE_ID]: {
        filesystem,
        network: { enabled: false },
      },
    },
  };
}

export class CodexAdapter implements AgentRunAdapter {
  constructor(
    private readonly executablePath: string,
    private readonly clientFactory: CodexClientFactory = (pathToCodex) => new CodexAppServerClient(pathToCodex),
  ) {}

  async run(req: AgentRunRequest, io: AgentRunIO): Promise<void> {
    if (isE2EMode(process.env)) {
      throw new Error('CodexAdapter.run is blocked in E2E mode (COREDOC_DESKTOP_E2E=1) — no Codex process may start.');
    }

    io.emit({ type: AgentRunEventType.Phase, phase: AgentRunPhase.Running });
    const state: { toolCalls: number; tokensIn?: number; tokensOut?: number } = { toolCalls: 0 };
    let deliverableRecoveryTurns = 0;
    const client = this.clientFactory(this.executablePath);
    const result = await client.run({
      prompt: req.prompt,
      cwd: req.cwd,
      env: req.env,
      signal: req.abortController.signal,
      model: req.model,
      permissionProfile: PROFILE_ID,
      runtimeWorkspaceRoots: [...new Set([...req.policy.readDirs, ...req.policy.writeDirs])],
      dynamicTools: [
        REQUEST_USER_INPUT_DYNAMIC_TOOL,
        {
          type: 'function' as const,
          name: 'coredoc_update_plan',
          description: 'Update the profile-generation checklist shown in Desktop on every phase transition.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              plan: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    step: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                  },
                  required: ['step', 'status'],
                },
              },
            },
            required: ['plan'],
          },
        },
        ...(req.scoreProfile
          ? [
              {
                type: 'function' as const,
                name: 'coredoc_score_profile',
                description:
                  'Score the current profile through Desktop. Desktop handles analysis mode, consent and tools. Call with no arguments. In code mode, print the complete result with text(await tools.coredoc_score_profile({})); do not assume it has an MCP content array or repeat scoring just to redisplay output.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
            ]
          : []),
      ],
      config: buildCodexProfileConfig(req),
      onNotification: (message) => this.handleNotification(message, io, state, req),
      nextTurn: (completedTurns) => {
        if (!req.verifyCompletion) return null;
        const failure = req.verifyCompletion();
        if (!failure) return null;
        // The author is allowed to end unsuccessfully. A completed failed score is
        // different from an early scout hand-off or an unscored draft needing repair.
        if (/current profile's score result is BLOCKED/i.test(failure)) return null;
        const deliverableExists = req.deliverableExists?.() ?? false;
        if (completedTurns < MAX_TURNS_WITHOUT_DELIVERABLE) {
          // The base budget applies even when regeneration copied the live profile into staging,
          // or a new run wrote profile.ts early and still has scout/score work left to do.
        } else if (deliverableExists) {
          if (deliverableRecoveryTurns >= MAX_DELIVERABLE_RECOVERY_TURNS) return null;
          deliverableRecoveryTurns += 1;
        } else {
          return null;
        }
        io.emit({
          type: AgentRunEventType.Raw,
          text: `[continue] turn ${completedTurns} ended without the deliverable — nudging Codex to continue`,
        });
        if (/score result is FAIL with PARTIAL coverage only/i.test(failure)) {
          return (
            `Your current profile has already been scored: ${failure} ` +
            `If the gap is documented and you choose to offer acceptance, ask via ${REQUEST_USER_INPUT_TOOL} now. ` +
            'After acceptance, finish without editing the profile or rerunning scoring. ' +
            'If documentation or rules still need edits, finish those and score before asking for acceptance.'
          );
        }
        const recoveryInstruction = /not been scored|changed after (?:that|the) score/i.test(failure)
          ? 'The candidate exists but its exact bytes are not attested. Do not edit profile.ts before first rerunning the exact score command. If that score requires a profile change, make it and score again afterward. '
          : 'Continue now with the remaining phases — draft the profile, WRITE it to the required file path, and iterate. ';
        return (
          `Your previous turn ended but the run is NOT finished: ${failure} ` +
          recoveryInstruction +
          'Run the exact score command before finalizing; every later profile edit, including comments, requires ' +
          'another score run. Do not end your turn again until the profile file is written and its current ' +
          'revision is scored ' +
          `(or you have asked the user via ${REQUEST_USER_INPUT_TOOL}).`
        );
      },
      onDynamicToolCall: async (params) => {
        if (params.tool === 'coredoc_update_plan') {
          const args = params.arguments as { plan?: Array<{ step: string; status: string }> } | undefined;
          if (!Array.isArray(args?.plan)) {
            return { success: false, contentItems: [{ type: 'inputText', text: 'Expected a plan array.' }] };
          }
          io.emit({
            type: AgentRunEventType.Todos,
            items: args.plan.map((item) => ({ text: item.step, status: todoStatus(item.status) })),
          });
          return { success: true, contentItems: [{ type: 'inputText', text: 'Desktop checklist updated.' }] };
        }
        if (params.tool === 'coredoc_score_profile' && req.scoreProfile) {
          const result = await req.scoreProfile();
          return { success: result.success, contentItems: [{ type: 'inputText', text: result.output }] };
        }
        if (params.tool !== REQUEST_USER_INPUT_TOOL) {
          return {
            success: false,
            contentItems: [{ type: 'inputText', text: `Unknown Coredoc tool: ${String(params.tool ?? '')}` }],
          };
        }
        const args =
          params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        const { ids, questions } = questionsFrom(args);
        const selected = await io.askQuestion(questions);
        req.onQuestionAnswered?.(questions, selected);
        const answers = Object.fromEntries(ids.map((id, index) => [id, { answers: selected[index] ?? [] }]));
        return {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify({ answers }) }],
        };
      },
    });

    const ok = result.status === 'completed';
    io.emit({
      type: AgentRunEventType.Done,
      ok,
      ...(ok ? {} : { error: result.error ?? `Codex turn ended with status: ${result.status}` }),
      sessionId: result.threadId,
      numTurns: result.turns,
      tokensIn: state.tokensIn,
      tokensOut: state.tokensOut,
      toolCalls: state.toolCalls,
      durationMs: result.durationMs,
    });
  }

  private handleNotification(
    message: CodexAppServerMessage,
    io: AgentRunIO,
    state: { toolCalls: number; tokensIn?: number; tokensOut?: number },
    req: AgentRunRequest,
  ): void {
    const params = message.params ?? {};
    if (message.method === 'coredoc/operationApprovalDeclined') {
      const operation = params.operation === 'file change' ? 'file change' : 'command';
      io.emit({
        type: AgentRunEventType.Raw,
        text: `[warning] Coredoc declined an unexpected ${operation} approval request.`,
      });
      return;
    }
    if (message.method === 'turn/plan/updated') {
      const plan = Array.isArray(params.plan) ? params.plan : [];
      const items: AgentTodoItem[] = plan.map((raw) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        return { text: String(item.step ?? ''), status: todoStatus(item.status) };
      });
      io.emit({ type: AgentRunEventType.Todos, items });
      return;
    }

    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = (params.item ?? {}) as Record<string, unknown>;
      const itemType = String(item.type ?? 'item');
      if (SILENT_ITEM_TYPES.has(itemType)) return;
      // Codex streams agentMessage word-by-word via item/agentMessage/delta; the completed item
      // carries the full text, so emit ONE readable line instead of a delta-per-token trace.
      if (itemType === 'agentMessage') {
        if (message.method === 'item/completed') {
          const text = summarize(item.text);
          if (text) io.emit({ type: AgentRunEventType.Raw, text: `[text] ${text}` });
        }
        return;
      }
      if (message.method === 'item/started' && TOOL_ITEM_TYPES.has(itemType)) state.toolCalls += 1;
      if (itemType === 'commandExecution') {
        if (message.method === 'item/started') {
          io.emit({ type: AgentRunEventType.Raw, text: `[tool] commandExecution ${summarize(item.command)}` });
        } else {
          const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
          const status = String(item.status ?? (exitCode === 0 ? 'completed' : 'failed'));
          const duration = typeof item.durationMs === 'number' ? `${item.durationMs}ms` : '';
          const rawOutput =
            typeof item.aggregatedOutput === 'string'
              ? item.aggregatedOutput
              : (JSON.stringify(item.aggregatedOutput) ?? '');
          const output = summarizeTail(cleanRuntimeLog(rawOutput));
          const command = typeof item.command === 'string' ? item.command : '';
          if (command) {
            const canonicalCommand = req.policy.safeCommandPrefixes.find((approved) =>
              isApprovedCommand(command, [approved]),
            );
            req.onCommandCompleted?.({
              command: canonicalCommand ?? command,
              success: status === 'completed' && (exitCode === undefined || exitCode === 0),
              output: rawOutput,
            });
          }
          const summary = [status, exitCode === undefined ? '' : `exit=${exitCode}`, duration]
            .filter(Boolean)
            .join(' ');
          io.emit({
            type: AgentRunEventType.Raw,
            text: `[result] commandExecution ${summary}${output ? ` · ${output}` : ''}`,
          });
        }
        return;
      }
      if (message.method === 'item/completed') {
        const result = item.error ?? item.output ?? item.result ?? item.status;
        const detail = summarizeTail(result);
        // Many completed items merely echo their started payload. Suppress those duplicates;
        // emit a result only when Codex supplied an actual status/output/error.
        if (detail) io.emit({ type: AgentRunEventType.Raw, text: `[result] ${itemType} ${detail}` });
        return;
      }
      const changes = Array.isArray(item.changes)
        ? item.changes.map((change) => String((change as Record<string, unknown>)?.path ?? '')).join(', ')
        : undefined;
      io.emit({
        type: AgentRunEventType.Raw,
        text: `[tool] ${itemType} ${summarize(item.command ?? changes ?? item)}`,
      });
      return;
    }

    if (message.method === 'thread/tokenUsage/updated') {
      const usage = (params.tokenUsage ?? params.usage ?? {}) as Record<string, unknown>;
      const total = (usage.total ?? usage) as Record<string, unknown>;
      const input = total.inputTokens ?? total.input_tokens;
      const output = total.outputTokens ?? total.output_tokens;
      if (typeof input === 'number') state.tokensIn = input;
      if (typeof output === 'number') state.tokensOut = output;
    }
  }
}
