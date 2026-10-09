import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssignedRepository, TurnAssignment } from '@coredoc/core/agent-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeExecutor } from './claude/claude-executor.js';
import { assignment, FakeCoredocApi, TOKEN, WORKSPACE } from './fake-coredoc-api.test-support.js';
import { BOT_TOKEN, FakeGithub } from './implement.test-support.js';
import { RunnerApiClient } from './runner-api.js';
import { Runner } from './runner.js';

const VERSIONS = { runner: '1.1.0-test' };
const BRANCH = 'coredoc/PROJ-1';

describe('delivery turns in the runner loop', () => {
  let api: FakeCoredocApi;
  let github: FakeGithub;
  let scratch: string;

  beforeEach(async () => {
    api = new FakeCoredocApi();
    await api.listen();
    github = new FakeGithub();
    await github.listen();
    scratch = await mkdtemp(join(tmpdir(), 'runner-delivery-'));
    github.add('example-org', 'billing-api');
    github.add('example-org', 'orders-api');
  });

  afterEach(async () => {
    await api.close();
    await github.close();
    await rm(scratch, { recursive: true, force: true });
  });

  const repo = (key: string, mergeOrder: number): AssignedRepository => ({
    key,
    reason: `Owns ${key}`,
    mergeOrder,
    cloneUrl: `https://github.example/example-org/${key}.git`,
    github: { apiBaseUrl: github.baseUrl, owner: 'example-org', name: key },
    branchCreated: true,
    withheldPaths: [],
  });

  function deliveryTurn(version = 1): TurnAssignment {
    const base = assignment();
    return assignment({
      turn: { ...base.turn, kind: 'delivery', ordinal: 5 },
      run: { ...base.run, branch: BRANCH },
      prd: null,
      mcp: null,
      repositories: [repo('billing-api', 0), repo('orders-api', 1)],
      delivery: {
        pullRequests: ['billing-api', 'orders-api'].map((key) => ({
          key,
          title: 'PROJ-1: Order exports',
          body: `Changes in ${key} (body v${version})`,
        })),
      },
    });
  }

  function runTurn(turn: TurnAssignment, heartbeatIntervalMs = 60_000) {
    api.queue.push(turn);
    const client = new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN });
    return new Runner({
      api: client,
      versions: VERSIONS,
      heartbeatIntervalMs,
      executor: new ClaudeExecutor({
        query: () => {
          throw new Error('a delivery turn starts no agent session');
        },
        api: client,
        scratchRoot: scratch,
        pluginPath: join(scratch, 'no-plugin'),
        modelApiKey: 'sk-ant-test',
        hostEnv: { PATH: process.env.PATH },
        bot: { token: BOT_TOKEN, name: 'Coredoc Bot', email: 'bot@users.noreply.example.com' },
        retryDelay: () => 0,
      }),
    }).runOnce();
  }

  const lastCompletion = () => api.completions.at(-1)!.body;

  it('opens one draft pull request per repository against the default branch, and reuses them when run twice', async () => {
    await expect(runTurn(deliveryTurn(1))).resolves.toBe('completed');
    expect(github.pulls.map((pull) => [pull.repository, pull.head, pull.base, pull.draft, pull.title])).toEqual([
      ['example-org/billing-api', `example-org:${BRANCH}`, 'main', true, 'PROJ-1: Order exports'],
      ['example-org/orders-api', `example-org:${BRANCH}`, 'main', true, 'PROJ-1: Order exports'],
    ]);
    const [billing, orders] = github.pulls;
    expect(lastCompletion()).toMatchObject({
      outcome: { kind: 'ended' },
      spend: null,
      deliveries: [
        { key: 'billing-api', pullRequest: { number: billing!.number } },
        { key: 'orders-api', pullRequest: { number: orders!.number } },
      ],
    });

    await expect(runTurn(deliveryTurn(2))).resolves.toBe('completed');
    expect(github.pulls).toHaveLength(2);
    expect(github.pulls.map((pull) => pull.body)).toEqual(['Changes in billing-api (body v2)', 'Changes in orders-api (body v2)']);
    expect(lastCompletion().deliveries).toEqual([
      { key: 'billing-api', pullRequest: { number: billing!.number } },
      { key: 'orders-api', pullRequest: { number: orders!.number } },
    ]);
    expect(github.requests.every((request) => request.apiVersion === '2022-11-28')).toBe(true);
  });

  it.each([
    ['a 422', { status: 422, message: 'A pull request already exists', afterStoring: true }],
    ['a 502', { status: 502, afterStoring: true }],
  ])('%s on create is followed by a lookup by head before any retry', async (_name, answer) => {
    github.createAnswers = [answer];
    await expect(runTurn(deliveryTurn())).resolves.toBe('completed');
    expect(github.pullsIn('example-org/billing-api')).toHaveLength(1);
    const creates = github.requests.filter((request) => request.method === 'POST');
    expect(creates).toHaveLength(2);
    expect(lastCompletion().deliveries[0]).toEqual({
      key: 'billing-api',
      pullRequest: { number: github.pullsIn('example-org/billing-api')[0]!.number },
    });
  });

  it('a transient refusal that stored nothing is retried after the lookup finds nothing', async () => {
    github.createAnswers = [{ status: 503 }];
    await expect(runTurn(deliveryTurn())).resolves.toBe('completed');
    expect(github.pulls).toHaveLength(2);
    expect(lastCompletion().outcome).toEqual({ kind: 'ended' });
  });

  it('a “no commits” refusal records the repository as unchanged', async () => {
    github.createAnswers = [{ status: 422, message: `No commits between main and ${BRANCH}` }];
    await expect(runTurn(deliveryTurn())).resolves.toBe('completed');
    expect(lastCompletion().deliveries[0]).toEqual({ key: 'billing-api', pullRequest: null });
    expect(github.pullsIn('example-org/billing-api')).toEqual([]);
  });

  it('a closed or merged pull request on the run branch is recorded without being reopened or edited', async () => {
    github.pulls.push({
      repository: 'example-org/billing-api',
      number: 77,
      head: `example-org:${BRANCH}`,
      base: 'main',
      title: 'Old',
      body: 'Old body',
      draft: false,
      state: 'closed',
      merged: true,
    });
    await expect(runTurn(deliveryTurn())).resolves.toBe('completed');
    expect(github.pullsIn('example-org/billing-api')).toMatchObject([{ number: 77, state: 'closed', body: 'Old body' }]);
    expect(lastCompletion().deliveries[0]).toEqual({ key: 'billing-api', pullRequest: { number: 77 } });
  });

  it('a permanent refusal fails the turn with delivery_failed, reporting what it already opened', async () => {
    // The first create succeeds; the second is refused.
    github.beforeCreate = async () => {
      if (github.pulls.length === 1) github.createAnswers = [{ status: 403, message: 'Forbidden' }];
    };
    await expect(runTurn(deliveryTurn())).resolves.toBe('completed');
    expect(lastCompletion().outcome).toMatchObject({ kind: 'failed', code: 'delivery_failed' });
    expect(lastCompletion().deliveries).toEqual([
      { key: 'billing-api', pullRequest: { number: github.pulls[0]!.number } },
    ]);
  });

  it('a stop opens nothing more but still completes with the pull requests already opened', async () => {
    github.beforeCreate = async () => {
      if (github.pulls.length === 0) return;
      // The second create waits until the server has told the runner to stop.
      api.heartbeatAnswer = 'stop';
      const seen = api.heartbeats;
      await waitFor(() => api.heartbeats >= seen + 2);
    };
    await expect(runTurn(deliveryTurn(), 5)).resolves.toBe('stopped');
    expect(github.pulls).toHaveLength(2);
    // The create already in flight landed; nothing was written after the stop.
    expect(lastCompletion().deliveries.map((report: { key: string }) => report.key)).toEqual(['billing-api', 'orders-api']);

    api.heartbeatAnswer = 'continue';
    github.pulls.length = 0;
    github.beforeCreate = async () => {
      api.heartbeatAnswer = 'stop';
      const seen = api.heartbeats;
      await waitFor(() => api.heartbeats >= seen + 2);
    };
    const before = api.completions.length;
    await expect(runTurn(deliveryTurn(), 5)).resolves.toBe('stopped');
    expect(github.pulls).toHaveLength(1);
    expect(api.completions).toHaveLength(before + 1);
    expect(lastCompletion().deliveries).toEqual([
      { key: 'billing-api', pullRequest: { number: github.pulls[0]!.number } },
    ]);
  });

  it('a lost lease stops delivery without completing the turn', async () => {
    github.beforeCreate = async () => {
      api.heartbeatAnswer = 'lease_lost';
      const seen = api.heartbeats;
      await waitFor(() => api.heartbeats >= seen + 2);
    };
    await expect(runTurn(deliveryTurn(), 5)).resolves.toBe('lease_lost');
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
