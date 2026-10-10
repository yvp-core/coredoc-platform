import { randomUUID } from 'node:crypto';
import {
  RunFailureCode,
  RUNNER_PROTOCOL_VERSION,
  RunnerStartupProblemCode,
  type TurnAssignment,
} from '@coredoc/core/agent-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignment, FakeCoredocApi, TOKEN, WORKSPACE } from './fake-coredoc-api.test-support.js';
import { RunnerApiClient, RunnerApiError } from './runner-api.js';
import { Runner, type TurnExecutor } from './runner.js';

const VERSIONS = { runner: '1.1.0-test' };

/** An executor that keeps the turn busy until the runner aborts it or `release` is called. */
function blockingExecutor(): TurnExecutor & { release: () => void; aborted: boolean } {
  let release = (): void => undefined;
  // Created up front, so a release that comes while emit is still in flight is not lost.
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor = {
    aborted: false,
    release: () => release(),
    async run(_turn: TurnAssignment, io: Parameters<TurnExecutor['run']>[1]) {
      await io.emit([{ type: 'phase', phase: 'scoping' }]);
      const aborted = new Promise<void>((resolve) => {
        // A heartbeat can end the session while emit is still in flight.
        if (io.signal.aborted) resolve();
        else io.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([released, aborted.then(() => (executor.aborted = true))]);
      return { spend: null };
    },
  };
  return executor;
}

describe('runner loop', () => {
  let api: FakeCoredocApi;

  beforeEach(async () => {
    api = new FakeCoredocApi();
    await api.listen();
  });

  afterEach(async () => {
    await api.close();
  });

  function runner(executor: TurnExecutor, heartbeatIntervalMs = 5) {
    return new Runner({
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      executor,
      versions: VERSIONS,
      heartbeatIntervalMs,
      idlePollMs: 5,
    });
  }

  it('reports idle when no turn is queued, sending its protocol and versions', async () => {
    await expect(runner(blockingExecutor()).runOnce()).resolves.toBe('idle');
    expect(api.claims).toEqual([{ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS }]);
  });

  it('claims a turn, heartbeats, posts the executor’s events and completes it', async () => {
    const turn = assignment();
    api.queue.push(turn);
    const executor = blockingExecutor();
    const done = runner(executor).runOnce();
    await waitFor(() => api.heartbeats >= 2);
    executor.release();

    await expect(done).resolves.toBe('completed');
    expect(api.events).toEqual([{ type: 'phase', phase: 'scoping' }]);
    expect(api.completions).toEqual([
      { turnId: turn.turn.id, body: { outcome: { kind: 'ended' }, spend: null, versions: VERSIONS } },
    ]);
  });

  it('a stop heartbeat ends the session and does not complete the turn', async () => {
    api.queue.push(assignment());
    api.heartbeatAnswer = 'stop';
    const executor = blockingExecutor();

    await expect(runner(executor).runOnce()).resolves.toBe('stopped');
    expect(executor.aborted).toBe(true);
    expect(api.completions).toEqual([]);
  });

  it('a shutdown ends the session, does not complete the turn and claims nothing more', async () => {
    api.queue.push(assignment());
    api.queue.push(assignment());
    const executor = blockingExecutor();
    const shutdown = new AbortController();
    const stopped = runner(executor).start(shutdown.signal);
    await waitFor(() => api.heartbeats >= 1);

    shutdown.abort();
    await stopped;
    expect(executor.aborted).toBe(true);
    expect(api.completions).toEqual([]);
    expect(api.claims).toHaveLength(1);
  });

  it('masks the credentials it holds in every event and report it sends', async () => {
    const modelKey = 'sk-ant-model-key-for-the-runner-test';
    const botToken = 'github_pat_bot_token_for_the_runner_test';
    const turn = assignment();
    const mcpToken = turn.mcp!.token;
    const leak = (where: string) => `${where}: ${modelKey} ${botToken} ${TOKEN} ${mcpToken}`;
    api.queue.push(turn);
    const executor: TurnExecutor = {
      async run(_turn, io) {
        await io.emit([
          { type: 'raw', text: leak('raw') },
          { type: 'todos', items: [{ text: leak('todo'), status: 'pending' }] },
        ]);
        await io.reportQuestion({
          toolUseId: 'toolu_1',
          questions: [
            {
              question: leak('question'),
              header: 'Format',
              options: [
                { label: 'CSV', description: 'Spreadsheets' },
                { label: 'JSON', description: 'Integrations' },
              ],
              multiSelect: false,
            },
          ],
        });
        await io.proposeScope({
          title: 'Export orders',
          summary: leak('summary'),
          specMarkdown: '# Spec',
          repositories: [{ key: 'orders-api', reason: 'Owns orders', changes: leak('changes') }],
        } as never);
        await io.submitResult({ summary: leak('result'), repositories: [] } as never);
        return {
          spend: null,
          outcome: { kind: 'failed', code: RunFailureCode.AgentError, reason: leak('reason') },
          lastMessage: leak('last message'),
        };
      },
    };
    const masked = new Runner({
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      executor,
      versions: VERSIONS,
      heartbeatIntervalMs: 60_000,
      secrets: [modelKey, botToken, TOKEN],
    });

    await expect(masked.runOnce()).resolves.toBe('completed');
    const sent = JSON.stringify([api.events, api.questions, api.proposals, api.results, api.completions]);
    for (const secret of [modelKey, botToken, TOKEN, mcpToken]) expect(sent).not.toContain(secret);
    expect(api.events[0]).toEqual({ type: 'raw', text: 'raw: [REDACTED] [REDACTED] [REDACTED] [REDACTED]' });
    expect(api.completions[0]!.body.lastMessage).toBe('last message: [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  });

  it('a failed start-up check is reported to the server, masked, and nothing is claimed', async () => {
    const botToken = 'github_pat_bot_token_for_the_startup_test';
    api.queue.push(assignment());
    const shutdown = new AbortController();
    const checking = new Runner({
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      executor: blockingExecutor(),
      versions: VERSIONS,
      secrets: [botToken],
      startupCheck: async () => ({
        versions: { ...VERSIONS, sdk: '0.3.285' },
        problem: { code: RunnerStartupProblemCode.BotAdmin, detail: `acme/orders (token ${botToken})` },
      }),
      startupRetryMs: 5,
    });
    const started = checking.start(shutdown.signal);
    await waitFor(() => api.startupProblems.length >= 2);
    shutdown.abort();
    await started;

    expect(api.startupProblems[0]).toEqual({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      versions: { ...VERSIONS, sdk: '0.3.285' },
      code: RunnerStartupProblemCode.BotAdmin,
      detail: 'acme/orders (token [REDACTED])',
    });
    expect(api.claims).toEqual([]);
  });

  it('keeps checking when the server cannot take the start-up report, and claims once the check passes', async () => {
    api.startupCheckAnswer = 404;
    let checks = 0;
    const shutdown = new AbortController();
    const checking = new Runner({
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      executor: blockingExecutor(),
      versions: VERSIONS,
      idlePollMs: 5,
      startupCheck: async () => ({
        versions: VERSIONS,
        problem: ++checks < 3 ? { code: RunnerStartupProblemCode.PluginMissing } : null,
      }),
      startupRetryMs: 5,
    });
    const started = checking.start(shutdown.signal);
    await waitFor(() => api.claims.length >= 1);
    shutdown.abort();
    await started;

    expect(checks).toBe(3);
  });

  it('a lost lease stops the turn without completing it', async () => {
    api.queue.push(assignment());
    api.heartbeatAnswer = 'lease_lost';
    const executor = blockingExecutor();

    await expect(runner(executor).runOnce()).resolves.toBe('lease_lost');
    expect(executor.aborted).toBe(true);
    expect(api.completions).toEqual([]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('runner retries against Coredoc', () => {
  let api: FakeCoredocApi;
  /** Waits the client asked for; time moves only through them. */
  let waits: number[];
  let clock: number;

  beforeEach(async () => {
    api = new FakeCoredocApi();
    await api.listen();
    waits = [];
    clock = Date.now();
  });

  afterEach(async () => {
    await api.close();
  });

  function runner(executor: TurnExecutor) {
    return new Runner({
      api: new RunnerApiClient({
        baseUrl: api.baseUrl,
        workspaceId: WORKSPACE,
        token: TOKEN,
        now: () => clock,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
      }),
      executor,
      versions: VERSIONS,
      heartbeatIntervalMs: 60_000,
    });
  }

  /** Emits one event, then returns. */
  const emitting: TurnExecutor = {
    async run(_turn, io) {
      await io.emit([{ type: 'phase', phase: 'scoping' }]);
      return { spend: null };
    },
  };

  it('retries a 429 after its Retry-After and completes the turn', async () => {
    api.queue.push(assignment());
    api.faults.push({ action: 'complete', status: 429, retryAfter: '7' });

    await expect(runner(emitting).runOnce()).resolves.toBe('completed');
    expect(waits).toEqual([7_000]);
    expect(api.completions).toHaveLength(1);
  });

  it('retries transient 5xx answers and dropped connections with growing waits', async () => {
    api.queue.push(assignment());
    api.faults.push(
      { action: 'events', status: 503 },
      { action: 'events', drop: true },
      { action: 'events', status: 500 },
      { action: 'complete', status: 502 },
    );

    await expect(runner(emitting).runOnce()).resolves.toBe('completed');
    expect(api.events).toEqual([{ type: 'phase', phase: 'scoping' }]);
    expect(api.turnRequests).toEqual(['events', 'events', 'events', 'events', 'complete', 'complete']);
    expect(waits).toEqual([1_000, 2_000, 4_000, 1_000]);
  });

  it('does not repeat a question after an answer that may have recorded it', async () => {
    api.queue.push(assignment());
    api.faults.push({ action: 'questions', status: 500 });
    let refusal: unknown;
    const asking: TurnExecutor = {
      async run(_turn, io) {
        refusal = await io
          .reportQuestion({
            toolUseId: 'toolu_1',
            questions: [
              {
                question: 'Which format?',
                header: 'Format',
                options: [
                  { label: 'CSV', description: 'Spreadsheets' },
                  { label: 'JSON', description: 'Integrations' },
                ],
                multiSelect: false,
              },
            ],
          })
          .catch((error: unknown) => error);
        return { spend: null };
      },
    };

    await expect(runner(asking).runOnce()).resolves.toBe('completed');
    expect(refusal).toBeInstanceOf(RunnerApiError);
    expect(api.turnRequests.filter((action) => action === 'questions')).toHaveLength(1);
  });

  it('stops the turn on LEASE_LOST without retrying', async () => {
    api.queue.push(assignment());
    api.faults.push({ action: 'events', status: 409, code: 'LEASE_LOST' });

    await expect(runner(emitting).runOnce()).resolves.toBe('lease_lost');
    expect(api.turnRequests).toEqual(['events']);
    expect(waits).toEqual([]);
  });

  it('gives up once the next attempt would fall after the lease expires', async () => {
    api.queue.push(assignment({ lease: { token: randomUUID(), expiresAt: new Date(clock + 10_000).toISOString() } }));
    for (let fault = 0; fault < 10; fault += 1) api.faults.push({ action: 'complete', status: 503 });

    await expect(runner(emitting).runOnce()).rejects.toThrow(RunnerApiError);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(api.completions).toEqual([]);
  });
});
