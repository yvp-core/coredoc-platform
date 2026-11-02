import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveManifest,
  type AssignedRepository,
  RunFailureCode,
  type TurnAssignment,
  TurnKind,
} from '@coredoc/core/agent-runner';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeExecutor } from './claude/claude-executor.js';
import { runControlServer } from './claude/run-control.js';
import { FakeCoredocApi, TOKEN, WORKSPACE } from './fake-coredoc-api.test-support.js';
import {
  BOT_TOKEN,
  bareRemote,
  FakeGithub,
  fakeImplementQuery,
  fakePlugin,
  git,
  implementAssignment,
  remoteFiles,
  remoteHead,
  repository,
  type SeenSession,
  type SessionStep,
} from './implement.test-support.js';
import { RunnerApiClient } from './runner-api.js';
import { Runner, type TurnIO } from './runner.js';

const BRANCH = 'coredoc/PROJ-1';
const SEARCH = { key: 'search-api', reason: 'Owns the search index' };

describe('request_repo in implement turns', () => {
  let api: FakeCoredocApi;
  let github: FakeGithub;
  let root: string;
  let scratch: string;
  let plugin: { path: string; log: string };

  beforeEach(async () => {
    api = new FakeCoredocApi();
    await api.listen();
    github = new FakeGithub();
    await github.listen();
    root = await mkdtemp(join(tmpdir(), 'runner-request-repo-'));
    scratch = join(root, 'scratch');
    plugin = await fakePlugin(root);
  });

  afterEach(async () => {
    await api.close();
    await github.close();
    await rm(root, { recursive: true, force: true });
  });

  async function remote(key: string, overrides: Partial<AssignedRepository> = {}) {
    const bare = await bareRemote(root, key, { 'src/index.ts': 'export {};\n' });
    github.add('example-org', key);
    return { bare, repo: repository(bare, github, key, overrides) };
  }

  function runTurn(turn: TurnAssignment, steps: SessionStep[]) {
    const seen: SeenSession[] = [];
    api.queue.push(turn);
    const client = new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN });
    const runner = new Runner({
      api: client,
      versions: { runner: '1.1.0-test' },
      heartbeatIntervalMs: 60_000,
      executor: new ClaudeExecutor({
        query: fakeImplementQuery(steps, seen),
        api: client,
        scratchRoot: scratch,
        manifest: resolveManifest(undefined, plugin.path),
        scannerPluginPath: plugin.path,
        modelApiKey: 'sk-ant-test',
        hostEnv: { PATH: process.env.PATH },
        bot: { token: BOT_TOKEN, name: 'Coredoc Bot', email: 'bot@users.noreply.example.com' },
        retryDelay: () => 0,
        windDownGraceMs: 2_000,
      }),
    });
    return { done: runner.runOnce(), seen };
  }

  const workDir = (turn: TurnAssignment) => join(scratch, 'runs', turn.run.id, 'work');

  it('read_repo clones a workspace repository for reference; nothing in it is pushed', async () => {
    const orders = await remote('orders-api');
    const search = await remote('search-api');
    const turn = implementAssignment([orders.repo], {
      branchScan: {
        epicKey: null,
        maxReads: 3,
        repositories: [{ key: 'search-api', cloneUrl: `file://${search.bare}` }],
      },
    });
    let readPath: string | undefined;
    const { done, seen } = runTurn(turn, [
      {
        reads: [{ key: 'search-api' }, { key: 'billing-api' }],
        act: async (cwd) => {
          readPath = /cloned at (\S+?) read-only/.exec(seen[0]!.toolResults[0]!)?.[1];
          await writeFile(join(readPath!, 'src', 'index.ts'), 'export const leaked = 1;\n');
          await writeFile(join(cwd, 'orders-api', 'src', 'index.ts'), 'export const orders = 1;\n');
        },
        submit: { summary: 'Orders.', repositories: [{ key: 'orders-api', summary: 'Orders' }] },
      },
    ]);
    await expect(done).resolves.toBe('completed');
    expect(JSON.stringify(seen[0]!.options.systemPrompt)).toContain('mcp__agent_run__read_repo');
    expect(readPath).toContain(join(workDir(turn), 'read'));
    expect(JSON.parse(seen[0]!.toolResults[1]!).isError).toBe(true);
    expect(remoteHead(search.bare, BRANCH)).toBeNull();
    expect(remoteHead(orders.bare, BRANCH)).not.toBeNull();
  });

  it('read_pr_feedback lists the pull request feedback oldest first without the bot’s own', async () => {
    const orders = await remote('orders-api');
    github.pulls.push({
      repository: 'example-org/orders-api',
      number: 7,
      head: `example-org:${BRANCH}`,
      base: 'main',
      title: 'Orders',
      body: '',
      draft: true,
      state: 'open',
      merged: false,
    });
    const user = (login: string) => ({ login });
    github.feedback.set('example-org/orders-api#7', {
      reviews: [
        { user: user('alice'), state: 'CHANGES_REQUESTED', body: 'Split the export.', submitted_at: '2026-10-02' },
        { user: user('alice'), state: 'COMMENTED', body: '', submitted_at: '2026-10-03' },
      ],
      comments: [
        { id: 11, user: user('bob'), path: 'src/a.ts', line: 4, body: 'Rename this.', created_at: '2026-10-01' },
        { id: 12, user: user('bob'), path: 'src/b.ts', line: null, body: 'Old line.', created_at: '2026-10-04' },
      ],
      conversation: [
        { user: user('carol'), body: 'Also CSV please.', created_at: '2026-10-05' },
        { user: user('coredoc-bot'), body: 'Bot summary.', created_at: '2026-10-06' },
      ],
    });
    const { done, seen } = runTurn(implementAssignment([orders.repo]), [
      { readFeedback: true, submit: { summary: 'Orders.', repositories: [{ key: 'orders-api', summary: 'Orders' }] } },
    ]);
    await expect(done).resolves.toBe('completed');
    const text = JSON.parse(seen[0]!.toolResults[0]!).content[0].text as string;
    expect(text).toContain('https://github.example/example-org/orders-api/pull/7');
    expect(text.indexOf('Rename this.')).toBeLessThan(text.indexOf('Split the export.'));
    expect(text).toContain('on src/a.ts:4');
    expect(text).toContain('on src/b.ts (outdated)');
    expect(text).toContain('Also CSV please.');
    expect(text).not.toContain('Bot summary.');
    expect(text).not.toContain('(COMMENTED)');
  });

  it('read_pr_feedback keeps the newest comments of a long pull request within 64 KiB and says how many it left out', async () => {
    const orders = await remote('orders-api');
    github.pulls.push({
      repository: 'example-org/orders-api',
      number: 8,
      head: `example-org:${BRANCH}`,
      base: 'main',
      title: 'Orders',
      body: '',
      draft: true,
      state: 'open',
      merged: false,
    });
    const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
    github.feedback.set('example-org/orders-api#8', {
      reviews: [],
      comments: [],
      conversation: Array.from({ length: 700 }, (_, index) => ({
        user: { login: 'carol' },
        body: `comment-${index} ${'x'.repeat(200)}`,
        created_at: day(index),
      })),
    });
    const { done, seen } = runTurn(implementAssignment([orders.repo]), [
      { readFeedback: true, submit: { summary: 'Orders.', repositories: [{ key: 'orders-api', summary: 'Orders' }] } },
    ]);
    await expect(done).resolves.toBe('completed');
    const text = JSON.parse(seen[0]!.toolResults[0]!).content[0].text as string;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(text).toContain('comment-699 ');
    expect(text).not.toContain('comment-199 ');
    const note = /(\d+) older items are not shown\./.exec(text);
    expect(Number(note?.[1])).toBe(700 - (text.match(/comment-\d+ /g) ?? []).length);
  });

  it('read_pr_feedback says when the run branch has no pull request yet', async () => {
    const orders = await remote('orders-api');
    const { done, seen } = runTurn(implementAssignment([orders.repo]), [
      { readFeedback: true, submit: { summary: 'Orders.', repositories: [{ key: 'orders-api', summary: 'Orders' }] } },
    ]);
    await expect(done).resolves.toBe('completed');
    expect(JSON.parse(seen[0]!.toolResults[0]!).content[0].text).toBe(`No pull request from ${BRANCH} yet.`);
  });

  it('read_pr_feedback is not offered on scope turns', async () => {
    const names = async (kind: TurnKind) => {
      const state = { proposedVersion: null, submitted: false, readPullFeedback: async () => '' };
      const server = runControlServer({} as TurnIO, state, kind);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      const client = new Client({ name: 'fake-claude-code', version: '0' });
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      await client.close();
      return tools.map(({ name }) => name);
    };
    expect(await names(TurnKind.Implement)).toContain('read_pr_feedback');
    expect(await names(TurnKind.Scope)).not.toContain('read_pr_feedback');
  });

  describe('under automatic acceptance', () => {
    it('clones the added repository on the run branch mid-turn, returns its path, and pushes it with the turn', async () => {
      const orders = await remote('orders-api');
      const search = await remote('search-api', { mergeOrder: 1, reason: SEARCH.reason });
      api.repoAnswer = () => ({ state: 'added', repository: search.repo });
      const turn = implementAssignment([orders.repo]);
      const clonePath = join(workDir(turn), 'search-api');
      let view: { branch: string; marker: string } | undefined;

      const { done, seen } = runTurn(turn, [
        {
          calls: [
            SEARCH,
            // Work in the new clone survives a repeated request: it is not cloned again.
            (cwd) => writeFile(join(cwd, 'search-api', 'src', 'index.ts'), 'export const search = 1;\n'),
            SEARCH,
          ],
          act: async (cwd) => {
            view = {
              branch: git(join(cwd, 'search-api'), 'branch', '--show-current'),
              marker: await readFile(join(cwd, 'search-api', 'src', 'index.ts'), 'utf8'),
            };
          },
          submit: { summary: 'Search indexes orders.', repositories: [{ key: 'search-api', summary: 'Indexer' }] },
        },
      ]);
      await expect(done).resolves.toBe('completed');

      expect(api.repoRequests).toEqual([SEARCH, SEARCH]);
      const [first, repeated] = seen[0]!.toolResults;
      expect(JSON.parse(first!)).toMatchObject({ isError: false });
      expect(first).toContain(clonePath);
      expect(repeated).toContain(clonePath);
      expect(view).toEqual({ branch: BRANCH, marker: 'export const search = 1;\n' });
      // The bot's permissions on the added repository were read before it was cloned.
      expect(github.requests.map((request) => request.path)).toContain('/repos/example-org/search-api');

      // The turn's commit and push cover the added repository.
      expect(remoteFiles(search.bare, BRANCH)).toEqual(['README.md', 'src/index.ts']);
      expect(git(search.bare, 'show', `${BRANCH}:src/index.ts`)).toBe('export const search = 1;');
      expect(api.reservations).toEqual([`${turn.turn.id}:search-api`]);
      expect(api.completions[0]!.body).toMatchObject({
        outcome: { kind: 'ended' },
        repositories: [
          { key: 'orders-api', pushedHead: null },
          { key: 'search-api', pushedHead: remoteHead(search.bare, BRANCH) },
        ],
      });
    });

    it('a refused request is a tool error and the session continues', async () => {
      const orders = await remote('orders-api');
      api.repoAnswer = () => ({ state: 'rejected', errors: ['A person declined repository "search-api".'] });
      const { done, seen } = runTurn(implementAssignment([orders.repo]), [{ calls: [SEARCH] }]);
      await expect(done).resolves.toBe('completed');
      const result = JSON.parse(seen[0]!.toolResults[0]!);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/declined repository/);
      expect(seen[0]!.denials).toEqual([]);
    });

    it('an admin or maintainer bot on the added repository fails the run before it is cloned', async () => {
      const orders = await remote('orders-api');
      const search = await remote('search-api', { mergeOrder: 1 });
      github.add('example-org', 'search-api', { admin: true });
      api.repoAnswer = () => ({ state: 'added', repository: search.repo });
      const turn = implementAssignment([orders.repo]);
      const { done, seen } = runTurn(turn, [
        {
          calls: [SEARCH],
          act: (cwd) => writeFile(join(cwd, 'orders-api', 'src', 'index.ts'), 'export const orders = 1;\n'),
        },
      ]);
      await expect(done).resolves.toBe('completed');
      expect(JSON.parse(seen[0]!.toolResults[0]!).isError).toBe(true);
      expect(existsSync(join(workDir(turn), 'search-api'))).toBe(false);
      expect(api.completions[0]!.body.outcome).toMatchObject({
        kind: 'failed',
        code: RunFailureCode.RepositoryNotEligible,
      });
      expect(remoteHead(orders.bare, BRANCH)).toBeNull();
    });
  });

  describe('under required acceptance', () => {
    it('ends the turn for a person’s decision, pushing the work so far, without a checkpoint', async () => {
      const orders = await remote('orders-api');
      api.repoAnswer = () => ({ state: 'requested' });
      const { done, seen } = runTurn(implementAssignment([orders.repo]), [
        {
          act: (cwd) => writeFile(join(cwd, 'orders-api', 'src', 'index.ts'), 'export const orders = 1;\n'),
          calls: [SEARCH],
          untilStopped: true,
          resultSubtype: 'error_max_turns',
        },
      ]);
      await expect(done).resolves.toBe('completed');
      expect(seen[0]!.toolResults[0]).toMatch(/person decides/);
      expect(seen[0]!.denials.join()).toMatch(/person decides/);
      expect(remoteHead(orders.bare, BRANCH)).not.toBeNull();
      expect(api.completions[0]!.body.outcome).toEqual({ kind: 'ended' });
    });

    it('the turn after "Add" clones the repository and tells the resumed session where it is', async () => {
      const orders = await remote('orders-api');
      api.repoAnswer = () => ({ state: 'requested' });
      const first = implementAssignment([orders.repo]);
      const { done } = runTurn(first, [{ calls: [SEARCH] }]);
      await expect(done).resolves.toBe('completed');

      const search = await remote('search-api', { mergeOrder: 1 });
      const resumed = implementAssignment([orders.repo, search.repo], {
        run: first.run,
        turn: { ...first.turn, id: randomUUID(), ordinal: 4, inputText: 'Repository `search-api` was added.' },
        hasStateArchive: true,
        repositoryDecision: { key: 'search-api', added: true },
      });
      const { done: resumedDone, seen } = runTurn(resumed, [{}]);
      await expect(resumedDone).resolves.toBe('completed');
      expect(seen[0]!.options.resume).toBe(first.run.sessionId);
      expect(seen[0]!.prompt).toContain(
        `Repository \`search-api\` is now cloned at \`${join(workDir(resumed), 'search-api')}\`. Continue where you stopped.`,
      );
      // Everything outside git was wiped with the scratch volume: the session is told to set up again.
      expect(seen[0]!.prompt).toContain('cloned again from the pushed run branch');
    });

    it('the turn after "Don\'t add" resumes with the server’s decline', async () => {
      const orders = await remote('orders-api');
      api.repoAnswer = () => ({ state: 'requested' });
      const first = implementAssignment([orders.repo]);
      await runTurn(first, [{ calls: [SEARCH] }]).done;

      const decline = 'Repository `search-api` was declined; continue without it or call submit_result noting the gap.';
      const resumed = implementAssignment([orders.repo], {
        run: first.run,
        turn: { ...first.turn, id: randomUUID(), ordinal: 4, inputText: decline },
        hasStateArchive: true,
        repositoryDecision: { key: 'search-api', added: false },
      });
      const { done, seen } = runTurn(resumed, [{}]);
      await expect(done).resolves.toBe('completed');
      expect(seen[0]!.prompt.startsWith(decline)).toBe(true);
      expect(seen[0]!.prompt).toContain('set the repositories up again');
    });
  });
});
