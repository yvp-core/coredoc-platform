import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignment, FakeCoredocApi, TOKEN, WORKSPACE } from '../fake-coredoc-api.test-support.js';
import { RunnerApiClient } from '../runner-api.js';
import { Runner, type TurnExecutor } from '../runner.js';
import { checkClaudeStartup, type StartupQueryFn } from './startup-check.js';

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

  async function startFor(query: StartupQueryFn) {
    const logs: string[] = [];
    api.queue.push(assignment());
    const runner = new Runner({
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      executor: idleExecutor,
      versions: { runner: '1.1.0-test', sdk: '0.3.285' },
      idlePollMs: 5,
      startupRetryMs: 5,
      startupCheck: () =>
        checkClaudeStartup({
          query,
          pluginPath: PLUGIN,
          scratchRoot: scratch,
          versions: { runner: '1.1.0-test', sdk: '0.3.285' },
        }),
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
  });

  it('claims nothing while the SDK cannot start Claude Code', async () => {
    const logs = await startFor(() => {
      throw new Error('spawn claude ENOENT');
    });
    expect(api.claims).toEqual([]);
    expect(logs.join('\n')).toContain('spawn claude ENOENT');
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
