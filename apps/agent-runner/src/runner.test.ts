import { RUNNER_PROTOCOL_VERSION, type TurnAssignment } from '@coredoc/core/agent-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignment, FakeCoredocApi, TOKEN, WORKSPACE } from './fake-coredoc-api.test-support.js';
import { RunnerApiClient } from './runner-api.js';
import { Runner, type TurnExecutor } from './runner.js';

const VERSIONS = { runner: '1.1.0-test' };

/** An executor that keeps the turn busy until the runner aborts it or `release` is called. */
function blockingExecutor(): TurnExecutor & { release: () => void; aborted: boolean } {
  let release = (): void => undefined;
  const executor = {
    aborted: false,
    release: () => release(),
    async run(_turn: TurnAssignment, io: Parameters<TurnExecutor['run']>[1]) {
      await io.emit([{ type: 'phase', phase: 'scoping' }]);
      await new Promise<void>((resolve) => {
        release = resolve;
        io.signal.addEventListener('abort', () => {
          executor.aborted = true;
          resolve();
        });
      });
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
          outcome: { kind: 'failed', code: 'agent_error', reason: leak('reason') },
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
