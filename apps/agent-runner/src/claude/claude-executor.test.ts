import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProposeScopeRequest, TurnAssignment } from '@coredoc/core/agent-runner';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignment, FakeCoredocApi, TOKEN, WORKSPACE } from '../fake-coredoc-api.test-support.js';
import { RunnerApiClient } from '../runner-api.js';
import { Runner } from '../runner.js';
import { ClaudeExecutor, type QueryFn } from './claude-executor.js';

const PLUGIN = '/opt/coredoc-workflows';
const VERSIONS = { runner: '1.1.0-test' };

const proposal: ProposeScopeRequest = {
  title: 'Order exports',
  summary: 'CSV exports.',
  specMarkdown: '# Spec',
  repositories: [{ key: 'orders-api', reason: 'Owns orders', changes: 'Export endpoint' }],
};

const COLOUR_QUESTION = {
  question: 'Which colour should the export button use?',
  header: 'Colour',
  options: [
    { label: 'Red', description: 'Matches the alerts' },
    { label: 'Blue', description: 'Matches the brand', preview: '<button class="blue">' },
  ],
  multiSelect: false,
};

/** An AskUserQuestion call the fake model makes. */
interface AskScript {
  toolUseId: string;
  /** Set when the call comes from a subagent. */
  agentId?: string;
  /** Model a hook that timed out or errored: Claude Code falls through to the permission callback. */
  skipHooks?: boolean;
}

/** How Claude Code resolved an AskUserQuestion call. */
interface AskRecord {
  decision: 'allow' | 'deny' | 'defer';
  reason?: string;
  answers?: Record<string, string>;
}

interface SessionScript {
  /** The session id the init message reports; the expected one when omitted. */
  reportSessionId?: string;
  plugins?: Array<{ name: string; path: string }>;
  pluginErrors?: Array<{ plugin: string; type: string; message: string }>;
  propose?: ProposeScopeRequest[];
  /** AskUserQuestion calls, in order, before any proposal; a deferred one ends the session. */
  ask?: AskScript[];
  result?: Partial<Extract<SDKMessage, { type: 'result' }>> | 'throw';
}

/**
 * A scripted fake of the SDK query: it reports init, reads what Claude Code
 * would read, calls run-control tools over a real MCP client against the
 * in-process server the executor configured, and ends with a result.
 */
function fakeQuery(
  script: SessionScript,
  seen: Array<{ prompt: string; options: Options; prd?: string; toolErrors: string[]; asks: AskRecord[] }>,
): QueryFn {
  return ({ prompt, options }) =>
    (async function* () {
      const record = {
        prompt,
        options,
        toolErrors: [] as string[],
        prd: undefined as string | undefined,
        asks: [] as AskRecord[],
      };
      seen.push(record);
      const sessionId = options.sessionId ?? options.resume!;
      yield {
        type: 'system',
        subtype: 'init',
        session_id: script.reportSessionId ?? sessionId,
        model: 'default',
        plugins: script.plugins ?? [{ name: 'coredoc-workflows', path: PLUGIN }],
        ...(script.pluginErrors ? { plugin_errors: script.pluginErrors } : {}),
        skills: ['coredoc-workflows:spec'],
      } as unknown as SDKMessage;
      if (options.abortController?.signal.aborted) return;

      const prdPath = join(options.cwd!, 'PRD.md');
      if (existsSync(prdPath)) record.prd = await readFile(prdPath, 'utf8');
      // Claude Code writes its transcript under its config directory.
      const configDir = options.env!.CLAUDE_CONFIG_DIR!;
      await mkdir(join(configDir, 'projects', 'work'), { recursive: true });
      await writeFile(
        join(configDir, 'projects', 'work', `${sessionId}.jsonl`),
        `{"prompt":${JSON.stringify(prompt)}}\n`,
        {
          flag: 'a',
        },
      );

      for (const ask of script.ask ?? []) {
        const outcome = await askUserQuestion(options, ask, sessionId);
        record.asks.push(outcome);
        if (outcome.decision === 'defer') {
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            total_cost_usd: 0.4,
            num_turns: 2,
            duration_ms: 500,
            session_id: sessionId,
            terminal_reason: 'tool_deferred',
            deferred_tool_use: { id: ask.toolUseId, name: 'AskUserQuestion', input: { questions: [COLOUR_QUESTION] } },
          } as unknown as SDKMessage;
          return;
        }
      }

      if (script.propose?.length) {
        const server = options.mcpServers!.agent_run as { instance: { connect(transport: unknown): Promise<void> } };
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        const client = new Client({ name: 'fake-claude-code', version: '0' });
        await client.connect(clientTransport);
        for (const call of script.propose) {
          const answer = await client.callTool({
            name: 'propose_scope',
            arguments: call as unknown as Record<string, unknown>,
          });
          if (answer.isError) record.toolErrors.push(JSON.stringify(answer.content));
        }
        await client.close();
      }

      if (script.result === 'throw') throw new Error('Claude Code process exited with code 1');
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 1.2,
        num_turns: 7,
        duration_ms: 1000,
        session_id: sessionId,
        ...script.result,
      } as unknown as SDKMessage;
    })();
}

/**
 * Claude Code's handling of one AskUserQuestion call: the pre-tool hooks
 * decide first (deny over defer over allow); with no decision, the permission
 * callback does.
 */
async function askUserQuestion(options: Options, ask: AskScript, sessionId: string): Promise<AskRecord> {
  const toolInput = { questions: [COLOUR_QUESTION] };
  const outputs = [];
  if (!ask.skipHooks) {
    for (const matcher of options.hooks?.PreToolUse ?? []) {
      if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test('AskUserQuestion')) continue;
      for (const hook of matcher.hooks) {
        const output = await hook(
          {
            hook_event_name: 'PreToolUse',
            session_id: sessionId,
            transcript_path: '/dev/null',
            cwd: options.cwd!,
            tool_name: 'AskUserQuestion',
            tool_input: toolInput,
            tool_use_id: ask.toolUseId,
            ...(ask.agentId ? { agent_id: ask.agentId, agent_type: 'general-purpose' } : {}),
          },
          ask.toolUseId,
          { signal: new AbortController().signal },
        );
        if ('hookSpecificOutput' in output && output.hookSpecificOutput?.hookEventName === 'PreToolUse') {
          outputs.push(output.hookSpecificOutput);
        }
      }
    }
  }
  const denied = outputs.find((output) => output.permissionDecision === 'deny');
  if (denied) return { decision: 'deny', reason: denied.permissionDecisionReason };
  if (outputs.some((output) => output.permissionDecision === 'defer')) return { decision: 'defer' };
  const allowed = outputs.find((output) => output.permissionDecision === 'allow');
  if (allowed) {
    const input = (allowed.updatedInput ?? toolInput) as { answers?: Record<string, string> };
    return { decision: 'allow', answers: input.answers };
  }
  const verdict = await options.canUseTool!('AskUserQuestion', toolInput, {
    signal: new AbortController().signal,
    toolUseID: ask.toolUseId,
    requestId: 'req-1',
    ...(ask.agentId ? { agentID: ask.agentId } : {}),
  });
  if (!verdict) throw new Error('the permission callback returned no verdict');
  if (verdict.behavior === 'deny') return { decision: 'deny', reason: verdict.message };
  return { decision: 'allow', answers: (verdict.updatedInput as { answers?: Record<string, string> }).answers };
}

describe('Claude executor in the runner loop', () => {
  let api: FakeCoredocApi;
  let scratch: string;

  beforeEach(async () => {
    api = new FakeCoredocApi();
    await api.listen();
    scratch = await mkdtemp(join(tmpdir(), 'runner-scratch-'));
  });

  afterEach(async () => {
    await api.close();
    await rm(scratch, { recursive: true, force: true });
  });

  function runTurn(turn: TurnAssignment, script: SessionScript) {
    const seen: Parameters<typeof fakeQuery>[1] = [];
    api.queue.push(turn);
    const client = new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN });
    const runner = new Runner({
      api: client,
      versions: VERSIONS,
      heartbeatIntervalMs: 60_000,
      executor: new ClaudeExecutor({
        query: fakeQuery(script, seen),
        api: client,
        scratchRoot: scratch,
        pluginPath: PLUGIN,
        modelApiKey: 'sk-ant-test',
        hostEnv: { PATH: '/usr/bin' },
      }),
    });
    return { done: runner.runOnce(), seen };
  }

  it('a scope turn writes the PRD file, forwards a proposal, uploads the archive and completes', async () => {
    const turn = assignment({ run: { ...assignment().run, priorSessionSpendUsd: 0.5 } });
    const { done, seen } = runTurn(turn, {
      propose: [{ ...proposal, repositories: [] }, proposal],
    });
    api.proposalErrors = ['Propose at least one repository.'];

    await expect(done).resolves.toBe('completed');
    const [session] = seen;
    expect(session!.prd).toContain('Customers need order exports.');
    expect(session!.options.sessionId).toBe(turn.run.sessionId);
    expect(session!.options.resume).toBeUndefined();
    expect(session!.prompt).toContain('PRD');
    expect(session!.toolErrors.join()).toContain('Propose at least one repository.');
    expect(api.proposals).toEqual([expect.objectContaining({ title: 'Order exports' })]);
    expect(api.uploads).toBe(1);
    // The turn's spend is the SDK's cumulative total minus what the session already reported.
    expect(api.completions).toEqual([
      {
        turnId: turn.turn.id,
        body: { outcome: { kind: 'ended' }, spend: { costUsd: 0.7, sdkTurns: 7 }, versions: VERSIONS },
      },
    ]);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('a later turn restores the archive and resumes the same session with its input text', async () => {
    const first = assignment();
    await runTurn(first, { propose: [proposal] }).done;

    const second = assignment({
      turn: { ...first.turn, id: crypto.randomUUID(), ordinal: 2, inputText: 'Also cover billing exports.' },
      run: first.run,
      hasStateArchive: true,
    });
    const { done, seen } = runTurn(second, { propose: [proposal] });
    await expect(done).resolves.toBe('completed');
    expect(seen[0]!.options.resume).toBe(first.run.sessionId);
    expect(seen[0]!.options.sessionId).toBeUndefined();
    expect(seen[0]!.prompt).toBe('Also cover billing exports.');
  });

  it.each([
    ['session_mismatch', { reportSessionId: '00000000-0000-4000-8000-000000000000' }],
    ['plugin_missing', { plugins: [] }],
    [
      'plugin_missing',
      { pluginErrors: [{ plugin: 'coredoc-workflows', type: 'hook-load-failed', message: 'bad hook' }] },
    ],
    ['agent_error', { result: 'throw' as const }],
    [
      'agent_error',
      { result: { subtype: 'error_during_execution', is_error: true, errors: ['authentication_failed'] } },
    ],
  ])('fails the run with %s', async (code, script) => {
    const { done } = runTurn(assignment(), script as SessionScript);
    await expect(done).resolves.toBe('completed');
    expect(api.completions[0]!.body.outcome).toMatchObject({ kind: 'failed', code });
  });

  it.each([
    0, -3,
  ])('with a remaining budget of %s, starts no session and fails the run with budget_exhausted', async (remainingSpendUsd) => {
    const turn = assignment({ run: { ...assignment().run, remainingSpendUsd } });
    const { done, seen } = runTurn(turn, { propose: [proposal] });

    await expect(done).resolves.toBe('completed');
    expect(seen).toEqual([]);
    expect(api.uploads).toBe(0);
    expect(api.completions[0]!.body).toMatchObject({
      outcome: { kind: 'failed', code: 'budget_exhausted' },
      spend: null,
    });
  });

  it.each([
    ['a missing remaining budget', { remainingSpendUsd: undefined }, 'budget_exhausted'],
    ['a non-finite remaining budget', { remainingSpendUsd: Number.POSITIVE_INFINITY }, 'budget_exhausted'],
    ['a missing turn duration limit', { maxTurnDurationSeconds: undefined }, 'agent_error'],
    ['a zero turn duration limit', { maxTurnDurationSeconds: 0 }, 'agent_error'],
  ])('fails closed on %s, without starting a session', async (_name, overrides, code) => {
    const seen: Parameters<typeof fakeQuery>[1] = [];
    const executor = new ClaudeExecutor({
      query: fakeQuery({ propose: [proposal] }, seen),
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      scratchRoot: scratch,
      pluginPath: PLUGIN,
      modelApiKey: 'sk-ant-test',
      hostEnv: {},
    });
    const turn = assignment();
    // The contract refuses these shapes; the executor must not rely on that alone.
    const hostile = { ...turn, run: { ...turn.run, ...overrides } } as unknown as TurnAssignment;
    const io = {
      signal: new AbortController().signal,
      emit: async () => undefined,
      proposeScope: async () => {
        throw new Error('no session may run');
      },
      downloadArchive: async () => Buffer.alloc(0),
      uploadArchive: async () => {
        throw new Error('nothing may be uploaded');
      },
      submitResult: async () => {
        throw new Error('no session may run');
      },
      reserveBranch: async () => {
        throw new Error('nothing may be pushed');
      },
      reportQuestion: async () => {
        throw new Error('no session may run');
      },
      requestRepo: async () => {
        throw new Error('no session may run');
      },
    };

    const result = await executor.run(hostile, io);
    expect(seen).toEqual([]);
    expect(result).toMatchObject({ spend: null, outcome: { kind: 'failed', code } });
  });

  describe('questions', () => {
    it('under pause, reports the question, defers the call and completes the turn with the question parked', async () => {
      api.questionState = 'open';
      const turn = assignment();
      const { done, seen } = runTurn(turn, { ask: [{ toolUseId: 'toolu_ask_1' }] });

      await expect(done).resolves.toBe('completed');
      expect(api.questions).toEqual([{ toolUseId: 'toolu_ask_1', questions: [COLOUR_QUESTION] }]);
      expect(seen[0]!.asks).toEqual([{ decision: 'defer' }]);
      expect(api.uploads).toBe(1);
      expect(api.completions[0]!.body).toMatchObject({ outcome: { kind: 'ended' }, spend: { costUsd: 0.4 } });
    });

    it('the resume turn re-runs the deferred call with the person’s answers and reports no new question', async () => {
      const answers = { [COLOUR_QUESTION.question]: 'Blue' };
      const turn = assignment({
        turn: { ...assignment().turn, ordinal: 2, inputText: 'A person answered your question.' },
        answer: { requestId: crypto.randomUUID(), toolUseId: 'toolu_ask_1', answers },
      });
      const { done, seen } = runTurn(turn, { ask: [{ toolUseId: 'toolu_ask_1' }], propose: [proposal] });

      await expect(done).resolves.toBe('completed');
      expect(seen[0]!.asks).toEqual([{ decision: 'allow', answers }]);
      expect(api.questions).toEqual([]);
      expect(api.proposals).toHaveLength(1);
    });

    it('under assume, answers at once with the server’s answer and the session continues', async () => {
      api.questionState = 'auto_answered';
      const turn = assignment({ run: { ...assignment().run, questionsPolicy: 'assume' } });
      const { done, seen } = runTurn(turn, { ask: [{ toolUseId: 'toolu_ask_1' }], propose: [proposal] });

      await expect(done).resolves.toBe('completed');
      expect(api.questions).toHaveLength(1);
      expect(seen[0]!.asks).toEqual([
        { decision: 'allow', answers: { [COLOUR_QUESTION.question]: expect.stringMatching(/No one is available/) } },
      ]);
      expect(api.proposals).toHaveLength(1);
      expect(api.completions[0]!.body.outcome).toEqual({ kind: 'ended' });
    });

    it('a subagent’s question is returned to the main session and never reported', async () => {
      const { done, seen } = runTurn(assignment(), {
        ask: [{ toolUseId: 'toolu_sub', agentId: 'agent-7' }],
        propose: [proposal],
      });

      await expect(done).resolves.toBe('completed');
      expect(seen[0]!.asks).toEqual([
        { decision: 'deny', reason: expect.stringContaining('return this question to the main session') },
      ]);
      expect(api.questions).toEqual([]);
    });

    it('a question the server refuses is denied, not let through unanswered', async () => {
      api.questionState = 'refused';
      const { done, seen } = runTurn(assignment(), { ask: [{ toolUseId: 'toolu_ask_1' }], propose: [proposal] });

      await expect(done).resolves.toBe('completed');
      expect(seen[0]!.asks).toEqual([{ decision: 'deny', reason: expect.any(String) }]);
    });

    it('when no hook decided, the permission callback never lets a question through unanswered', async () => {
      const { done, seen } = runTurn(assignment(), {
        ask: [{ toolUseId: 'toolu_ask_1', skipHooks: true }],
        propose: [proposal],
      });

      await expect(done).resolves.toBe('completed');
      expect(seen[0]!.asks).toEqual([{ decision: 'deny', reason: expect.any(String) }]);
    });

    it('reports the agent’s final message with the completion', async () => {
      const { done } = runTurn(assignment(), { result: { result: 'I could not tell which service owns exports.' } });

      await expect(done).resolves.toBe('completed');
      expect(api.completions[0]!.body.lastMessage).toBe('I could not tell which service owns exports.');
    });

    it('a subagent’s question that reaches the permission callback is returned to the main session', async () => {
      const { done, seen } = runTurn(assignment(), {
        ask: [{ toolUseId: 'toolu_sub', agentId: 'agent-7', skipHooks: true }],
        propose: [proposal],
      });

      await expect(done).resolves.toBe('completed');
      expect(seen[0]!.asks).toEqual([
        { decision: 'deny', reason: expect.stringContaining('return this question to the main session') },
      ]);
    });
  });

  it('a scope turn that reaches the SDK turn cap without a proposal reports a checkpoint, not an outcome-less end', async () => {
    const { done } = runTurn(assignment(), { result: { subtype: 'error_max_turns', is_error: true } as never });
    await expect(done).resolves.toBe('completed');
    expect(api.uploads).toBe(1);
    expect(api.completions[0]!.body.outcome).toEqual({ kind: 'checkpoint' });
  });

  it('a scope turn that proposed before the SDK turn cap ends with its proposal', async () => {
    const { done } = runTurn(assignment(), {
      propose: [proposal],
      result: { subtype: 'error_max_turns', is_error: true } as never,
    });
    await expect(done).resolves.toBe('completed');
    expect(api.completions[0]!.body.outcome).toEqual({ kind: 'ended' });
  });

  it('an archive over the cap fails the run with archive_too_large instead of uploading', async () => {
    const turn = assignment();
    api.queue.push(turn);
    const client = new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN });
    const runner = new Runner({
      api: client,
      versions: VERSIONS,
      heartbeatIntervalMs: 60_000,
      executor: new ClaudeExecutor({
        query: fakeQuery({ propose: [proposal] }, []),
        api: client,
        scratchRoot: scratch,
        pluginPath: PLUGIN,
        modelApiKey: 'sk-ant-test',
        hostEnv: {},
        maxArchiveBytes: 10,
      }),
    });
    await expect(runner.runOnce()).resolves.toBe('completed');
    expect(api.uploads).toBe(0);
    expect(api.completions[0]!.body.outcome).toMatchObject({ kind: 'failed', code: 'archive_too_large' });
  });

  it('refuses a restored archive that escapes the state directory, without starting a session', async () => {
    const { gzipSync } = await import('node:zlib');
    const header = Buffer.alloc(512, 0);
    header.write('../../escape.txt', 0);
    header.write('0000644\0', 100);
    header.write('00000000001\0', 124);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    api.archive = gzipSync(Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]));

    const { done, seen } = runTurn(assignment({ hasStateArchive: true }), {});
    await expect(done).rejects.toThrow(/outside the state directory/);
    expect(seen).toEqual([]);
    expect(api.completions).toEqual([]);
    expect(await readdir(scratch)).toEqual([]);
  });
});
