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

interface SessionScript {
  /** The session id the init message reports; the expected one when omitted. */
  reportSessionId?: string;
  plugins?: Array<{ name: string; path: string }>;
  pluginErrors?: Array<{ plugin: string; type: string; message: string }>;
  propose?: ProposeScopeRequest[];
  result?: Partial<Extract<SDKMessage, { type: 'result' }>> | 'throw';
}

/**
 * A scripted fake of the SDK query: it reports init, reads what Claude Code
 * would read, calls run-control tools over a real MCP client against the
 * in-process server the executor configured, and ends with a result.
 */
function fakeQuery(
  script: SessionScript,
  seen: Array<{ prompt: string; options: Options; prd?: string; toolErrors: string[] }>,
): QueryFn {
  return ({ prompt, options }) =>
    (async function* () {
      const record = { prompt, options, toolErrors: [] as string[], prd: undefined as string | undefined };
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
    };

    const result = await executor.run(hostile, io);
    expect(seen).toEqual([]);
    expect(result).toMatchObject({ spend: null, outcome: { kind: 'failed', code } });
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
