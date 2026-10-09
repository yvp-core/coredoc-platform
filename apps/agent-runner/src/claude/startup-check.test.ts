import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignment, FakeCoredocApi, TOKEN, WORKSPACE } from '../fake-coredoc-api.test-support.js';
import { RunnerApiClient } from '../runner-api.js';
import { Runner, type TurnExecutor } from '../runner.js';
import { GithubApi } from '../github/github-api.js';
import { BOT_TOKEN, FakeGithub } from '../implement.test-support.js';
import { checkClaudeStartup, checkRunnerStartup, type StartupQueryFn } from './startup-check.js';

const PLUGIN = '/opt/coredoc-workflows';

function initOnly(init: Record<string, unknown>): StartupQueryFn {
  return () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        claude_code_version: '2.1.285',
        session_id: 's',
        ...init,
      } as unknown as SDKMessage;
    })();
}

const idleExecutor: TurnExecutor = { run: async () => ({ spend: null }) };

describe('runner start-up check', () => {
  let api: FakeCoredocApi;
  let scratch: string;

  beforeEach(async () => {
    api = new FakeCoredocApi();
    await api.listen();
    scratch = await mkdtemp(join(tmpdir(), 'runner-startup-'));
  });

  afterEach(async () => {
    await api.close();
    await rm(scratch, { recursive: true, force: true });
  });

  async function startFor(query: StartupQueryFn, github?: FakeGithub) {
    const logs: string[] = [];
    api.queue.push(assignment());
    const runner = new Runner({
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      executor: idleExecutor,
      versions: { runner: '1.1.0-test', sdk: '0.3.285' },
      idlePollMs: 5,
      startupRetryMs: 5,
      startupCheck: () => {
        const claude = {
          query,
          pluginPath: PLUGIN,
          scratchRoot: scratch,
          versions: { runner: '1.1.0-test', sdk: '0.3.285' },
        };
        return github
          ? checkRunnerStartup({
              ...claude,
              github: new GithubApi({ token: BOT_TOKEN, retryDelay: () => 0 }),
              githubApiUrl: github.baseUrl,
            })
          : checkClaudeStartup(claude);
      },
      log: (line) => logs.push(line),
    });
    const shutdown = new AbortController();
    const running = runner.start(shutdown.signal);
    await new Promise((resolve) => setTimeout(resolve, 60));
    shutdown.abort();
    await running;
    return logs;
  }

  it('claims nothing while the plugin reports errors, and logs why with the versions', async () => {
    const logs = await startFor(
      initOnly({
        plugins: [{ name: 'coredoc-workflows', path: PLUGIN, version: '0.14.0' }],
        plugin_errors: [{ plugin: 'coredoc-workflows', type: 'hook-load-failed', message: 'hooks.json is invalid' }],
        skills: [],
      }),
    );
    expect(api.claims).toEqual([]);
    expect(logs.join('\n')).toContain('hooks.json is invalid');
    expect(logs.join('\n')).toContain('claude code 2.1.285');
    expect(api.startupProblems[0]).toMatchObject({
      code: 'plugin_errors',
      detail: 'coredoc-workflows: hooks.json is invalid',
      versions: { claudeCode: '2.1.285', plugin: '0.14.0' },
    });
  });

  it('claims nothing while the SDK cannot start Claude Code', async () => {
    const logs = await startFor(() => {
      throw new Error('spawn claude ENOENT');
    });
    expect(api.claims).toEqual([]);
    expect(logs.join('\n')).toContain('spawn claude ENOENT');
    expect(api.startupProblems[0]).toMatchObject({ code: 'sdk_unusable', detail: 'spawn claude ENOENT' });
  });

  describe('the bot account', () => {
    const loaded = initOnly({
      plugins: [{ name: 'coredoc-workflows', path: PLUGIN, version: '0.14.0' }],
      skills: ['coredoc-workflows:spec'],
    });
    let github: FakeGithub;

    beforeEach(async () => {
      github = new FakeGithub();
      await github.listen();
    });

    afterEach(async () => {
      await github.close();
    });

    it.each([
      'admin',
      'maintain',
    ])('claims nothing while the bot has %s permission on a repository it sees', async (role) => {
      github.add('acme', 'orders-api');
      github.add('acme', 'billing-api', { [role]: true });
      const logs = await startFor(loaded, github);
      expect(api.claims).toEqual([]);
      expect(logs.join('\n')).toContain('acme/billing-api');
      expect(api.startupProblems[0]).toMatchObject({ code: 'bot_admin', detail: 'acme/billing-api' });
    });

    it('claims while the bot has the Write role only', async () => {
      github.add('acme', 'orders-api');
      await startFor(loaded, github);
      expect(api.claims.length).toBeGreaterThan(0);
    });
  });

  it.each([
    ['is not listed', { plugins: [], skills: [] }, 'plugin_missing'],
    [
      'loads without its skills',
      { plugins: [{ name: 'coredoc-workflows', path: PLUGIN, version: '0.14.0' }], skills: [] },
      'plugin_skills_missing',
    ],
  ])('reports a plugin that %s', async (_case, init, code) => {
    await startFor(initOnly(init));
    expect(api.claims).toEqual([]);
    expect(api.startupProblems[0]).toMatchObject({ code });
  });

  it('claims once the plugin and its skills load, reporting the versions it found', async () => {
    await startFor(
      initOnly({
        plugins: [{ name: 'coredoc-workflows', path: PLUGIN, version: '0.14.0' }],
        skills: ['coredoc-workflows:spec'],
      }),
    );
    expect(api.claims[0]).toMatchObject({
      versions: { runner: '1.1.0-test', sdk: '0.3.285', claudeCode: '2.1.285', plugin: '0.14.0' },
    });
  });
});
