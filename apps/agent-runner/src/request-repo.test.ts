import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssignedRepository, TurnAssignment } from '@coredoc/core/agent-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeExecutor } from './claude/claude-executor.js';
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
import { Runner } from './runner.js';

const BRANCH = 'coredoc/PROJ-1';
const SEARCH = { key: 'search-api', reason: 'Owns the search index' };

/**
 * `request_repo` in the runner: the mid-turn clone under automatic
 * acceptance, the turn that ends for a person's decision under required
 * acceptance, and the turn that resumes with that decision.
 */
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
        pluginPath: plugin.path,
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
      expect(api.completions[0]!.body.outcome).toMatchObject({ kind: 'failed', code: 'repository_not_eligible' });
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
      expect(seen[0]!.prompt).toBe(
        `Repository \`search-api\` is now cloned at \`${join(workDir(resumed), 'search-api')}\`. Continue where you stopped.`,
      );
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
      expect(seen[0]!.prompt).toBe(decline);
    });
  });
});
