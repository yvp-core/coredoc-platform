import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignment, FakeCoredocApi, TOKEN, WORKSPACE } from '../fake-coredoc-api.test-support.js';
import { RunnerApiClient } from '../runner-api.js';
import { Runner, type TurnExecutor } from '../runner.js';
import { GithubApi } from '../github/github-api.js';
import { BOT_TOKEN, FakeGithub } from '../implement.test-support.js';
import { checkClaudeStartup, checkRunnerStartup, type StartupQueryFn } from './startup-check.js';
import { RunnerStartupProblemCode, resolveManifest, type ResolvedManifest } from '@coredoc/core/agent-runner';

/** Claude Code's initialize answer listing these commands; the plugin's skills are prefixed with its name. */
function initResult(commands: string[]): StartupQueryFn {
  return () => ({ initializationResult: async () => ({ commands: commands.map((name) => ({ name })) }) });
}

const VERSIONS = { runner: '1.1.0-test', sdk: '0.3.285', claudeCode: '2.1.285' };

const idleExecutor: TurnExecutor = { run: async () => ({ spend: null }) };

async function writePlugin(dir: string, name: string, version?: string) {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, ...(version ? { version } : {}) }),
  );
}

describe('runner start-up check', () => {
  let api: FakeCoredocApi;
  let scratch: string;
  let plugin: string;

  beforeEach(async () => {
    api = new FakeCoredocApi();
    await api.listen();
    scratch = await mkdtemp(join(tmpdir(), 'runner-startup-'));
    plugin = await mkdtemp(join(tmpdir(), 'runner-plugin-'));
    await mkdir(join(plugin, '.claude-plugin'));
    await writeFile(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'coredoc-workflows', version: '0.14.0' }),
    );
    await mkdir(join(plugin, 'bin'));
    await writeFile(join(plugin, 'bin', 'coredoc-workflows'), '#!/bin/sh\n', { mode: 0o755 });
  });

  afterEach(async () => {
    await api.close();
    await rm(scratch, { recursive: true, force: true });
    await rm(plugin, { recursive: true, force: true });
  });

  async function startFor(query: StartupQueryFn, github?: FakeGithub, manifest = resolveManifest(undefined, plugin)) {
    const logs: string[] = [];
    api.queue.push(assignment());
    const runner = new Runner({
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      executor: idleExecutor,
      versions: VERSIONS,
      idlePollMs: 5,
      startupRetryMs: 5,
      startupCheck: () => {
        const claude = {
          query,
          manifest,
          manifestDigest: null,
          scannerPluginPath: plugin,
          scratchRoot: scratch,
          versions: VERSIONS,
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

  it('claims nothing while the plugin has no manifest, and logs why with the versions', async () => {
    await rm(join(plugin, '.claude-plugin'), { recursive: true });
    const logs = await startFor(initResult(['coredoc-workflows:spec']));
    expect(api.claims).toEqual([]);
    expect(logs.join('\n')).toContain('No plugin manifest');
    expect(logs.join('\n')).toContain('claude code 2.1.285');
    expect(api.startupProblems[0]).toMatchObject({ code: RunnerStartupProblemCode.PluginMissing });
  });

  it('claims nothing while Claude Code does not answer, naming the wait', async () => {
    const report = await checkClaudeStartup({
      // A Claude Code that never answers its initialize request.
      query: () => ({ initializationResult: () => new Promise<never>(() => undefined) }),
      manifest: resolveManifest(undefined, plugin),
      manifestDigest: null,
      scannerPluginPath: plugin,
      scratchRoot: scratch,
      versions: VERSIONS,
      timeoutMs: 20,
    });
    expect(report.problem).toEqual({
      code: RunnerStartupProblemCode.SdkUnusable,
      detail: 'Claude Code did not initialise within 0 s.',
    });
  });

  it('claims nothing while the SDK cannot start Claude Code', async () => {
    const logs = await startFor(() => {
      throw new Error('spawn claude ENOENT');
    });
    expect(api.claims).toEqual([]);
    expect(logs.join('\n')).toContain('spawn claude ENOENT');
    expect(api.startupProblems[0]).toMatchObject({
      code: RunnerStartupProblemCode.SdkUnusable,
      detail: 'spawn claude ENOENT',
    });
  });

  describe('the bot account', () => {
    const loaded = initResult(['init', 'coredoc-workflows:spec']);
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
      expect(api.startupProblems[0]).toMatchObject({
        code: RunnerStartupProblemCode.BotAdmin,
        detail: 'acme/billing-api',
      });
    });

    it('claims while the bot has the Write role only', async () => {
      github.add('acme', 'orders-api');
      await startFor(loaded, github);
      expect(api.claims.length).toBeGreaterThan(0);
    });
  });

  it('reports a plugin whose skills Claude Code does not list', async () => {
    await startFor(initResult(['init', 'review']));
    expect(api.claims).toEqual([]);
    expect(api.startupProblems[0]).toMatchObject({ code: RunnerStartupProblemCode.PluginSkillsMissing });
  });

  it('claims once the plugin and its skills load, reporting the versions it found', async () => {
    await startFor(initResult(['init', 'coredoc-workflows:spec']));
    expect(api.claims[0]).toMatchObject({
      versions: { runner: '1.1.0-test', sdk: '0.3.285', claudeCode: '2.1.285', plugin: '0.14.0' },
    });
  });

  describe('a runner manifest', () => {
    let acmePlugin: string;

    beforeEach(async () => {
      acmePlugin = await mkdtemp(join(tmpdir(), 'runner-acme-plugin-'));
      await writePlugin(acmePlugin, 'acme-agent-run', '0.1.0');
    });

    afterEach(async () => {
      await rm(acmePlugin, { recursive: true, force: true });
    });

    function acmeManifest(
      overrides: Partial<{ plugins: string[]; entrySkill: string; implementEntrySkill: string }> = {},
    ): ResolvedManifest {
      return resolveManifest(
        JSON.stringify({
          version: 1,
          plugins: (overrides.plugins ?? [plugin, acmePlugin]).map((path) => ({ path })),
          phases: {
            scope: { model: 'claude-opus-5-5', entrySkill: overrides.entrySkill ?? 'acme-agent-run:scope' },
            implement: { model: 'claude-sonnet-5-5', entrySkill: overrides.implementEntrySkill },
          },
        }),
        '/opt/unused',
      );
    }

    const bothLoaded = initResult([
      'init',
      'coredoc-workflows:spec',
      'acme-agent-run:scope',
      'acme-agent-run:implement',
    ]);

    it('claims with the effective manifest in its versions once every plugin and entry skill loads', async () => {
      const report = await checkClaudeStartup({
        query: bothLoaded,
        manifest: acmeManifest(),
        manifestDigest: 'sha256:abc',
        scannerPluginPath: plugin,
        scratchRoot: scratch,
        versions: VERSIONS,
      });
      expect(report).toEqual({
        problem: null,
        versions: {
          ...VERSIONS,
          plugin: '0.14.0',
          manifest: {
            digest: 'sha256:abc',
            models: { scope: 'claude-opus-5-5', implement: 'claude-sonnet-5-5' },
            plugins: [
              { name: 'coredoc-workflows', version: '0.14.0' },
              { name: 'acme-agent-run', version: '0.1.0' },
            ],
          },
        },
      });
    });

    it('claims without coredoc-workflows in the session when every phase has an entry skill, scanning with the plugin at its own path', async () => {
      const report = await checkClaudeStartup({
        query: initResult(['init', 'acme-agent-run:scope', 'acme-agent-run:implement']),
        manifest: acmeManifest({ plugins: [acmePlugin], implementEntrySkill: 'acme-agent-run:implement' }),
        manifestDigest: 'sha256:abc',
        scannerPluginPath: plugin,
        scratchRoot: scratch,
        versions: VERSIONS,
      });
      expect(report.problem).toBeNull();
      expect(report.versions).toMatchObject({
        plugin: '0.14.0',
        manifest: { plugins: [{ name: 'acme-agent-run', version: '0.1.0' }] },
      });
    });

    it.each([
      [
        'an entry skill Claude Code does not list',
        () => acmeManifest({ entrySkill: 'acme-agent-run:review' }),
        () => plugin,
        RunnerStartupProblemCode.PluginSkillsMissing,
        'acme-agent-run:review',
      ],
      [
        'a plugin without a manifest',
        () => acmeManifest({ plugins: [plugin, join(scratch, 'missing')] }),
        () => plugin,
        RunnerStartupProblemCode.PluginMissing,
        'No plugin manifest',
      ],
      [
        'no plugin manifest at the scanner path',
        () => acmeManifest({ plugins: [acmePlugin], implementEntrySkill: 'acme-agent-run:implement' }),
        () => join(scratch, 'missing'),
        RunnerStartupProblemCode.PluginMissing,
        'No plugin manifest',
      ],
      [
        'no launcher at the scanner path',
        () => acmeManifest({ plugins: [acmePlugin], implementEntrySkill: 'acme-agent-run:implement' }),
        () => acmePlugin,
        RunnerStartupProblemCode.PluginMissing,
        'bin/coredoc-workflows',
      ],
      [
        'no coredoc-workflows plugin while a phase has no entry skill',
        () => acmeManifest({ plugins: [acmePlugin] }),
        () => plugin,
        RunnerStartupProblemCode.ManifestInvalid,
        'coredoc-workflows',
      ],
    ])('reports %s', async (_case, manifest, scannerPluginPath, code, detail) => {
      const report = await checkClaudeStartup({
        query: bothLoaded,
        manifest: manifest(),
        manifestDigest: null,
        scannerPluginPath: scannerPluginPath(),
        scratchRoot: scratch,
        versions: VERSIONS,
      });
      expect(report.problem?.code).toBe(code);
      expect(report.problem?.detail).toContain(detail);
    });
  });
});
