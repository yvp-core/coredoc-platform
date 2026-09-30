import { describe, it, expect, afterEach, vi } from 'vitest';
import { ClaudeAdapter } from './claude-adapter';
import { AgentRunEventType, AgentRunPhase, AgentTodoStatus } from '../../shared/agent-run-types';
import type { AgentRunEvent } from '../../shared/agent-run-types';
import type { AgentRunIO, AgentRunRequest } from './types';
import type { PolicyContext } from './permission-policy';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  createSdkMcpServer: (options: unknown) => ({ type: 'sdk', instance: options }),
}));

const REPO = '/work/repo';
const PARSER_DIR = '/work/parsers/repo';

const policy: PolicyContext = {
  repoDir: REPO,
  writeDirs: [PARSER_DIR],
  readDirs: [REPO, PARSER_DIR],
  safeCommandPrefixes: [],
};

function makeRequest(): AgentRunRequest {
  return {
    prompt: 'author a profile',
    cwd: REPO,
    model: 'sonnet',
    additionalDirectories: [PARSER_DIR],
    policy,
    env: {},
    nodeExecPath: '/usr/bin/node',
    abortController: new AbortController(),
  };
}

/** Captures emitted events and answers questions with a canned selection. */
function makeIO(answer: string[][]): { io: AgentRunIO; events: AgentRunEvent[]; questionsAsked: unknown[] } {
  const events: AgentRunEvent[] = [];
  const questionsAsked: unknown[] = [];
  const io: AgentRunIO = {
    emit: (e) => events.push(e),
    askQuestion: async (questions) => {
      questionsAsked.push(questions);
      return answer;
    },
  };
  return { io, events, questionsAsked };
}

describe('ClaudeAdapter', () => {
  it('connects the score MCP tool to the trusted desktop callback', async () => {
    const request = makeRequest();
    request.scoreProfile = vi.fn().mockResolvedValue({ success: true, output: '=== Profile completion: PASS ===' });
    const fakeQuery = ({
      options,
    }: {
      options: {
        canUseTool: (tool: string, input: Record<string, unknown>) => Promise<unknown>;
        mcpServers: {
          coredoc: { instance: { tools: Array<{ handler: (input: Record<string, unknown>) => Promise<unknown> }> } };
        };
      };
    }) =>
      (async function* () {
        expect(await options.canUseTool('mcp__coredoc__score_profile', {})).toEqual({
          behavior: 'allow',
          updatedInput: {},
        });
        const result = await options.mcpServers.coredoc.instance.tools[0].handler({});
        expect(result).toEqual({
          content: [{ type: 'text', text: '=== Profile completion: PASS ===' }],
          isError: false,
        });
        expect(request.scoreProfile).toHaveBeenCalledWith();
        yield { type: 'result', subtype: 'success' };
      })();
    await new ClaudeAdapter(async () => fakeQuery as never).run(request, makeIO([]).io);
  });
  afterEach(() => {
    delete process.env.COREDOC_DESKTOP_E2E;
  });

  it('blocks the run under COREDOC_DESKTOP_E2E without invoking the SDK query', async () => {
    process.env.COREDOC_DESKTOP_E2E = '1';
    let queryCalled = false;
    const fakeQuery = () => {
      queryCalled = true;
      return (async function* () {
        yield { type: 'result', subtype: 'success' };
      })();
    };

    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const { io } = makeIO([]);

    await expect(adapter.run(makeRequest(), io)).rejects.toThrow(/E2E mode/);
    expect(queryCalled).toBe(false);
  });

  it('maps TodoWrite → Todos, result → Done, and text/tool → Raw', async () => {
    const fakeQuery = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', model: 'claude-sonnet' };
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Working on it' },
              {
                type: 'tool_use',
                name: 'TodoWrite',
                input: {
                  todos: [
                    { content: 'Ground in repo shape', status: 'in_progress', activeForm: 'Grounding' },
                    { content: 'Draft profile', status: 'pending', activeForm: 'Drafting' },
                  ],
                },
              },
            ],
          },
        };
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.05, session_id: 'sess-1' };
      })();

    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const { io, events } = makeIO([['Full repo']]);
    await adapter.run(makeRequest(), io);

    expect(events[0]).toEqual({ type: AgentRunEventType.Phase, phase: AgentRunPhase.Running });

    const todos = events.find((e) => e.type === AgentRunEventType.Todos);
    expect(todos).toBeDefined();
    if (todos?.type === AgentRunEventType.Todos) {
      expect(todos.items).toEqual([
        { text: 'Ground in repo shape', status: AgentTodoStatus.InProgress },
        { text: 'Draft profile', status: AgentTodoStatus.Pending },
      ]);
    }

    const done = events.find((e) => e.type === AgentRunEventType.Done);
    expect(done).toMatchObject({ type: AgentRunEventType.Done, ok: true, costUsd: 0.05, sessionId: 'sess-1' });

    expect(events.some((e) => e.type === AgentRunEventType.Raw && e.text.startsWith('[text]'))).toBe(true);
    expect(events.some((e) => e.type === AgentRunEventType.Raw && e.text.startsWith('[init]'))).toBe(true);
  });

  it('filters a split Electron codesign probe while flushing real stderr', async () => {
    const fakeQuery = (params: { options?: { stderr?: (data: string) => void } }) =>
      (async function* () {
        params.options?.stderr?.('[0825/132625.675326:ERROR:electron/shell/common/mac/code');
        params.options?.stderr?.('sign_util.cc:79] task_name_for_pid: (os/kern) failure (5)\n');
        params.options?.stderr?.('real unterminated error');
        yield { type: 'result', subtype: 'success' };
      })();

    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const { io, events } = makeIO([]);
    await adapter.run(makeRequest(), io);

    const raw = events.flatMap((event) => (event.type === AgentRunEventType.Raw ? [event.text] : []));
    expect(raw).toContain('[stderr] real unterminated error');
    expect(raw.join('\n')).not.toContain('task_name_for_pid');
  });

  it('answers AskUserQuestion via io.askQuestion and returns updatedInput.answers', async () => {
    let permissionResult: unknown;
    const fakeQuery = (params: { options?: { canUseTool?: unknown } }) =>
      (async function* () {
        const canUseTool = params.options?.canUseTool as (
          name: string,
          input: Record<string, unknown>,
        ) => Promise<unknown>;
        permissionResult = await canUseTool('AskUserQuestion', {
          questions: [
            {
              question: 'What coverage scope?',
              header: 'Coverage',
              multiSelect: false,
              options: [
                { label: 'Full repo', description: 'all packages' },
                { label: 'One app', description: 'single app' },
              ],
            },
          ],
        });
        yield { type: 'result', subtype: 'success' };
      })();

    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const { io, questionsAsked } = makeIO([['Full repo']]);
    const request = makeRequest();
    request.onQuestionAnswered = vi.fn();
    await adapter.run(request, io);

    expect(questionsAsked).toHaveLength(1);
    expect(permissionResult).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: expect.anything(),
        answers: { 'What coverage scope?': 'Full repo' },
      },
    });
    expect(request.onQuestionAnswered).toHaveBeenCalledWith(
      [expect.objectContaining({ question: 'What coverage scope?' })],
      [['Full repo']],
    );
  });

  it('correlates an approved Bash tool result with its exact command', async () => {
    const fakeQuery = () =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'score-1',
                name: 'Bash',
                input: { command: 'node score.js' },
              },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'score-1',
                is_error: false,
                content: '=== Overall: PASS ===',
              },
            ],
          },
        };
        yield { type: 'result', subtype: 'success' };
      })();

    const request = makeRequest();
    request.onCommandCompleted = vi.fn();
    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    await adapter.run(request, makeIO([]).io);

    expect(request.onCommandCompleted).toHaveBeenCalledWith({
      command: 'node score.js',
      success: true,
      output: '=== Overall: PASS ===',
    });
  });

  it('denies an out-of-policy tool, emits a [denied] Raw line, and continues', async () => {
    let denyResult: { behavior?: string; message?: string; interrupt?: boolean } = {};
    const fakeQuery = (params: { options?: { canUseTool?: unknown } }) =>
      (async function* () {
        const canUseTool = params.options?.canUseTool as (
          name: string,
          input: Record<string, unknown>,
        ) => Promise<typeof denyResult>;
        denyResult = await canUseTool('Read', { file_path: '/etc/hosts' });
        yield { type: 'result', subtype: 'success' };
      })();

    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const { io, events } = makeIO([]);
    await adapter.run(makeRequest(), io);

    expect(denyResult.behavior).toBe('deny');
    expect(denyResult.interrupt).toBeUndefined(); // run continues, no interrupt
    expect(events.some((e) => e.type === AgentRunEventType.Raw && e.text.startsWith('[denied] Read'))).toBe(true);
    expect(events.some((e) => e.type === AgentRunEventType.Done)).toBe(true);
  });

  it('enables a no-network sandbox with only the policy read/write roots', async () => {
    let sdkOptions: Record<string, unknown> | undefined;
    const fakeQuery = (params: { options?: Record<string, unknown> }) => {
      sdkOptions = params.options;
      return (async function* () {
        yield { type: 'result', subtype: 'success' };
      })();
    };
    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const request = makeRequest();
    request.policy.deniedPaths = ['/work/.env'];
    const { io } = makeIO([]);

    await adapter.run(request, io);

    expect(sdkOptions?.sandbox).toEqual({
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
        allowRead: [REPO, PARSER_DIR],
        allowWrite: [PARSER_DIR],
        denyRead: ['/work/.env'],
        denyWrite: [REPO],
      },
    });
  });

  it('does not deny a readable parent that contains the staged write directory', async () => {
    let sdkOptions: Record<string, unknown> | undefined;
    const fakeQuery = (params: { options?: Record<string, unknown> }) => {
      sdkOptions = params.options;
      return (async function* () {
        yield { type: 'result', subtype: 'success' };
      })();
    };
    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const request = makeRequest();
    request.policy = {
      ...request.policy,
      writeDirs: [`${PARSER_DIR}/.authoring-test`],
      readDirs: [REPO, PARSER_DIR],
    };
    const { io } = makeIO([]);

    await adapter.run(request, io);

    expect(sdkOptions?.sandbox).toMatchObject({
      filesystem: {
        allowWrite: [`${PARSER_DIR}/.authoring-test`],
        denyWrite: [REPO],
      },
    });
  });

  it('forwards economics from the result and counts every tool_use (incl. TodoWrite) as toolCalls', async () => {
    const fakeQuery = () =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'TodoWrite',
                input: { todos: [{ content: 'Ground', status: 'in_progress' }] },
              },
              { type: 'tool_use', name: 'Read', input: { file_path: '/work/repo/a.ts' } },
            ],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.05,
          session_id: 'sess-1',
          duration_ms: 4200,
          num_turns: 7,
          usage: { input_tokens: 1200, output_tokens: 340 },
        };
      })();

    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const { io, events } = makeIO([]);
    await adapter.run(makeRequest(), io);

    const done = events.find((e) => e.type === AgentRunEventType.Done);
    expect(done).toMatchObject({
      type: AgentRunEventType.Done,
      ok: true,
      costUsd: 0.05,
      sessionId: 'sess-1',
      toolCalls: 2,
      numTurns: 7,
      tokensIn: 1200,
      tokensOut: 340,
      durationMs: 4200,
    });
  });

  it('leaves economics fields undefined when the result omits usage/num_turns/duration', async () => {
    const fakeQuery = () =>
      (async function* () {
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, session_id: 'sess-2' };
      })();

    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const { io, events } = makeIO([]);
    await adapter.run(makeRequest(), io);

    const done = events.find((e) => e.type === AgentRunEventType.Done);
    expect(done?.type).toBe(AgentRunEventType.Done);
    if (done?.type === AgentRunEventType.Done) {
      expect(done.toolCalls).toBe(0);
      expect(done.numTurns).toBeUndefined();
      expect(done.tokensIn).toBeUndefined();
      expect(done.tokensOut).toBeUndefined();
      expect(done.durationMs).toBeUndefined();
    }
  });

  it('reports a non-success result as Done with ok=false', async () => {
    const fakeQuery = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_max_turns', errors: ['too many turns'] };
      })();

    const adapter = new ClaudeAdapter(async () => fakeQuery as never);
    const { io, events } = makeIO([]);
    await adapter.run(makeRequest(), io);

    const done = events.find((e) => e.type === AgentRunEventType.Done);
    expect(done).toMatchObject({ ok: false, error: 'too many turns' });
  });
});
