/**
 * Ports for implement-turn tests: a stateful fake of GitHub's REST API, local
 * bare repositories driven with real git, a fake plugin whose secret preflight
 * flags a marker string, and a scripted fake SDK session that edits clones and
 * calls run-control tools over a real MCP client.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AssignedRepository, SubmitResultRequest, TurnAssignment } from '@coredoc/core/agent-runner';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { assignment } from './fake-coredoc-api.test-support.js';
import type { QueryFn } from './claude/claude-executor.js';

export const BOT_TOKEN = 'ghp_bot_token_for_tests_0123456789';

/** Real git, outside the runner, as a person or a fixture builder would run it. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'A Person',
      GIT_AUTHOR_EMAIL: 'person@example.com',
      GIT_COMMITTER_NAME: 'A Person',
      GIT_COMMITTER_EMAIL: 'person@example.com',
    },
  }).trim();
}

/** A bare repository with one commit on `main`, as GitHub would hold it. */
export async function bareRemote(root: string, name: string, files: Record<string, string> = {}): Promise<string> {
  const bare = join(root, 'remotes', `${name}.git`);
  await mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '--quiet', '-b', 'main');
  const seed = await mkdtemp(join(tmpdir(), 'runner-seed-'));
  git(seed, 'init', '--quiet', '-b', 'main');
  for (const [path, content] of Object.entries({ 'README.md': `# ${name}\n`, ...files })) {
    await mkdir(join(seed, path, '..'), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'initial');
  git(seed, 'push', '--quiet', bare, 'main');
  return bare;
}

/** A person's commit pushed straight to a branch of the remote. */
export async function pushAsPerson(bare: string, branch: string, path: string, content: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), 'runner-person-'));
  git(work, 'clone', '--quiet', bare, '.');
  const exists = git(work, 'ls-remote', '--heads', 'origin', branch) !== '';
  git(work, 'checkout', '--quiet', '-B', branch, exists ? `origin/${branch}` : 'origin/main');
  await writeFile(join(work, path), content);
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'a person was here');
  git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  return git(work, 'rev-parse', 'HEAD');
}

export function remoteHead(bare: string, branch: string): string | null {
  const line = git(bare, 'ls-remote', '--heads', bare, branch);
  return line ? line.split(/\s+/)[0]! : null;
}

/** Files in the tree of a remote branch's head. */
export function remoteFiles(bare: string, branch: string): string[] {
  return git(bare, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean).sort();
}

export const SECRET_MARKER = 'sk_live_fakesecret0000';

/**
 * A plugin directory whose launcher answers `git-delivery-preflight` the way
 * the real one does: JSON on stdout with a verdict and findings. It blocks
 * any staged or outbound added line holding SECRET_MARKER, and logs each
 * invocation (arguments and the git environment) for assertions.
 */
export async function fakePlugin(root: string): Promise<{ path: string; log: string }> {
  const path = join(root, 'plugin');
  const log = join(root, 'preflight.jsonl');
  await mkdir(join(path, 'bin'), { recursive: true });
  const script = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const op = args[args.indexOf('--operation') + 1];
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args, cwd: process.cwd(),
  GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  auth: process.env.GIT_CONFIG_COUNT ? process.env.GIT_CONFIG_VALUE_0 : null,
}) + '\\n');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
let patch = '';
if (op === 'commit') patch = git('diff', '--cached', '--no-color');
else {
  const base = args[args.indexOf('--base') + 1];
  patch = git('log', '-p', '--no-color', 'refs/remotes/origin/' + base + '..HEAD');
}
const findings = [];
let path = null;
for (const line of patch.split('\\n')) {
  const header = /^\\+\\+\\+ b\\/(.*)$/.exec(line);
  if (header) { path = header[1]; continue; }
  if (line.startsWith('+') && line.includes(${JSON.stringify(SECRET_MARKER)})) findings.push({ id: 'stripe.secret_key', tier: 'HIGH', path, line: 1 });
}
process.stdout.write(JSON.stringify({
  schema: 'coredoc.git-delivery-preflight/v1', operation: op,
  verdict: findings.length ? 'blocked' : 'ready', reason: findings.length ? 'secret-detected' : null,
  scan: { complete: true, findings, binaryPaths: [] },
}) + '\\n');
`;
  await writeFile(join(path, 'bin', 'coredoc-workflows'), script);
  await chmod(join(path, 'bin', 'coredoc-workflows'), 0o755);
  return { path, log };
}

interface FakeRepository {
  permissions: Record<string, boolean>;
  /** Server errors answered before the read succeeds. */
  failures: number;
  status?: number;
}

/** A stateful fake of GitHub's REST API: repository reads with the bot's permissions. */
export class FakeGithub {
  readonly repositories = new Map<string, FakeRepository>();
  readonly requests: Array<{ path: string; authorization?: string; apiVersion?: string }> = [];
  private server!: Server;
  baseUrl = '';

  add(owner: string, name: string, permissions: Partial<Record<string, boolean>> = {}): void {
    this.repositories.set(`${owner}/${name}`, {
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true, ...permissions } as Record<
        string,
        boolean
      >,
      failures: 0,
    });
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      this.requests.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        apiVersion: req.headers['x-github-api-version'] as string | undefined,
      });
      const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(req.url ?? '');
      const repo = match ? this.repositories.get(`${match[1]}/${match[2]}`) : undefined;
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) return reply(401, { message: 'Bad credentials' });
      if (!repo) return reply(404, { message: 'Not Found' });
      if (repo.failures > 0) {
        repo.failures -= 1;
        return reply(502, { message: 'Bad gateway' }, { 'retry-after': '0' });
      }
      if (repo.status) return reply(repo.status, { message: 'refused' });
      return reply(200, {
        full_name: `${match![1]}/${match![2]}`,
        default_branch: 'main',
        permissions: repo.permissions,
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function repository(bare: string, github: FakeGithub, key: string, overrides: Partial<AssignedRepository> = {}) {
  return {
    key,
    reason: `Owns ${key}`,
    mergeOrder: 0,
    cloneUrl: `file://${bare}`,
    github: { apiBaseUrl: github.baseUrl, owner: 'example-org', name: key },
    branchCreated: false,
    withheldPaths: [],
    ...overrides,
  } satisfies AssignedRepository;
}

export function implementAssignment(repositories: AssignedRepository[], overrides: Partial<TurnAssignment> = {}) {
  const base = assignment();
  return assignment({
    turn: { ...base.turn, kind: 'implement', ordinal: 3 },
    run: { ...base.run, branch: 'coredoc/PROJ-1' },
    prd: null,
    acceptedSpec: {
      version: 2,
      markdown: '# Spec\n\nAdd an orders export.\n',
      acceptedBy: 'member@example.com',
      acceptedAt: '2026-10-10T09:00:00.000Z',
      digest: 'a'.repeat(64),
    },
    repositories,
    ...overrides,
  });
}

/** What one fake session invocation does, in order. */
export interface SessionStep {
  /** Edits the agent makes; `cwd` is the work directory holding the clones. */
  act?: (cwd: string) => Promise<void>;
  submit?: SubmitResultRequest;
  /** Ends with a result of this subtype instead of success. */
  resultSubtype?: 'success' | 'error_max_turns';
  /** Keep working (calling tools) until the runner refuses tools, as at the duration limit. */
  untilStopped?: boolean;
}

export interface SeenSession {
  prompt: string;
  options: Options;
  /** What tool calls were refused with, after the session's work. */
  denials: string[];
  toolResults: string[];
}

async function preToolUse(options: Options, toolName: string): Promise<string | null> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
  const answer = (await hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: { command: 'ls' },
      tool_use_id: randomUUID(),
      session_id: options.sessionId ?? options.resume ?? '',
      transcript_path: '',
      cwd: options.cwd ?? '',
    } as never,
    undefined,
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  const output = answer.hookSpecificOutput;
  return output?.permissionDecision === 'deny' ? (output.permissionDecisionReason ?? 'denied') : null;
}

/** A scripted SDK query: each invocation of the session runs the next step. */
export function fakeImplementQuery(steps: SessionStep[], seen: SeenSession[]): QueryFn {
  return ({ prompt, options }) =>
    (async function* () {
      const step = steps[seen.length] ?? {};
      const record: SeenSession = { prompt, options, denials: [], toolResults: [] };
      seen.push(record);
      const sessionId = options.sessionId ?? options.resume!;
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        plugins: [{ name: 'coredoc-workflows', path: options.plugins![0]!.path }],
        skills: ['coredoc-workflows:implement'],
      } as unknown as SDKMessage;

      // Claude Code keeps its transcript under its config directory, keyed by the work directory.
      const configDir = options.env!.CLAUDE_CONFIG_DIR!;
      await mkdir(join(configDir, 'projects', 'work'), { recursive: true });
      await writeFile(join(configDir, 'projects', 'work', `${sessionId}.jsonl`), `${JSON.stringify({ prompt })}\n`, {
        flag: 'a',
      });

      await step.act?.(options.cwd!);
      if (step.submit) {
        const server = options.mcpServers!.agent_run as { instance: { connect(transport: unknown): Promise<void> } };
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        const client = new Client({ name: 'fake-claude-code', version: '0' });
        await client.connect(clientTransport);
        const answer = await client.callTool({
          name: 'submit_result',
          arguments: step.submit as unknown as Record<string, unknown>,
        });
        record.toolResults.push(JSON.stringify(answer.content));
        await client.close();
      }
      if (step.untilStopped) {
        while (!options.abortController?.signal.aborted) {
          const denial = await preToolUse(options, 'Bash');
          if (denial) {
            record.denials.push(denial);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } else {
        const denial = await preToolUse(options, 'Bash');
        if (denial) record.denials.push(denial);
      }
      yield {
        type: 'result',
        subtype: step.resultSubtype ?? 'success',
        is_error: false,
        total_cost_usd: seen.length * 1.5,
        num_turns: 5,
        duration_ms: 1000,
        session_id: sessionId,
      } as unknown as SDKMessage;
    })();
}
