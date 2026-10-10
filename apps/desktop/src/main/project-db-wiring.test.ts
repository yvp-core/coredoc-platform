/**
 * Per-project graph database wiring, asserted through behavior.
 *
 * Each failure mode here is silent: the code compiles, every other test passes,
 * and the app reads or writes the wrong database — which at runtime just
 * answers with nothing, indistinguishable from "this code was never parsed".
 *
 * These used to be `expect(source).toContain(...)` greps. They were both weaker
 * and more brittle than they looked: the command-runner regex only checked that
 * two tokens sat within 120 characters of each other, so passing the WRONG
 * project id still passed, while extracting the expression into a helper would
 * have failed it. What matters is the url each entry point actually resolves,
 * so that is what these assert.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_PATH = '/tmp/ws/coredoc.config.json';

// --- command-runner harness --------------------------------------------------

/** Env of every worker spawned, in order — what the binding tests assert on. */
const workerEnvs = vi.hoisted(() => [] as Array<Record<string, string | undefined>>);
/** Stand-in for a collaborator the binding tests never exercise. */
const noop = vi.hoisted(() => () => undefined);

vi.mock('worker_threads', () => ({
  Worker: class {
    constructor(_url: unknown, opts: { env: Record<string, string | undefined> }) {
      workerEnvs.push(opts.env);
    }
    on = noop;
    postMessage = noop;
    terminate = noop;
  },
}));

vi.mock('./profile-parse-sandbox.js', () => ({
  resolveSandboxExecutable: (executable: string) => executable,
  spawnSandboxedParse: (options: { databaseUrl: string }) => {
    workerEnvs.push({ COREDOC_SQLITE_URL: options.databaseUrl });
    return { terminate: noop };
  },
}));

const mainWindow = {
  isDestroyed: () => false,
  webContents: { send: noop },
};

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/app', getPath: () => '/tmp/home', isPackaged: false },
  BrowserWindow: class {},
}));
vi.mock('./cloud-docs-manager.js', () => ({ runCloudDocsCommand: noop }));
vi.mock('./agent-run/agent-run-service.js', () => ({ startAgentRun: noop, registerAgentRunHandlers: noop }));
vi.mock('./telemetry-manager.js', () => ({ buildCloudChannelConfig: () => ({}) }));
vi.mock('./build-env.js', () => ({ BUNDLED_POSTHOG_KEY: '', BUNDLED_POSTHOG_HOST: '' }));

// --- state-manager: operations timestamps ------------------------------------

const getOpsTimestamps = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@coredoc/cli/sdk', () => ({ getOpsTimestamps, loadConfig: vi.fn() }));

vi.mock('./config-manager.js', () => ({
  // `output.dir` / `parserStorage` are read by state-manager's own path
  // helpers; the values only have to resolve, nothing here touches disk.
  getCurrentConfig: () => ({
    projects: [],
    output: { dir: 'coredoc-output' },
    parserStorage: 'parsers',
  }),
  getCurrentConfigPath: () => CONFIG_PATH,
  getConfigDir: () => '/tmp/ws',
  resolveRepoPath: () => '/tmp/repo',
}));
vi.mock('./review-manager.js', () => ({ getApprovalStatus: () => undefined }));
vi.mock('./parser-artifact.js', () => ({
  resolveParserArtifactPath: () => undefined,
  profileArtifactPath: () => '/tmp/ws/parsers/p/r/profile.ts',
}));
vi.mock('./runtime-paths.js', () => ({
  getOutputDir: () => '/tmp/ws/coredoc-output',
  getParserStorageDir: () => '/tmp/ws/parsers',
  getConfigPath: () => CONFIG_PATH,
  requireProjectRoot: () => '/tmp/ws',
  getNodeExec: () => ({ execPath: '/usr/bin/node', env: {} }),
  getCliPath: () => '/tmp/ws/cli.js',
  getClaudeCodeCliPath: () => '/tmp/ws/claude',
  getAuthoringKitDir: () => '/tmp/ws/kit',
  getEnvPath: () => '/tmp/ws/.env',
}));

describe('operations timestamps', () => {
  beforeEach(() => {
    getOpsTimestamps.mockClear();
    delete process.env.COREDOC_SQLITE_URL;
  });

  it('reads the scoped project’s database, not a process-global default', async () => {
    // `operations` rows live in the same per-project file as the graph they
    // describe. The desktop serves several projects in one process, so reading
    // them from a global reported "never parsed" for every repo that had a
    // parse history.
    const { getRepoDetailState } = await import('./state-manager.js');

    await getRepoDetailState('proj-1', 'api');

    expect(getOpsTimestamps).toHaveBeenCalledWith('proj-1', 'api', '/tmp/ws');
  });

  it('ignores an ambient database pin', async () => {
    process.env.COREDOC_SQLITE_URL = 'file:/tmp/pinned.db';
    const { getRepoDetailState } = await import('./state-manager.js');

    await getRepoDetailState('proj-1', 'api');

    expect(getOpsTimestamps).toHaveBeenCalledWith('proj-1', 'api', '/tmp/ws');
  });
});

// --- command-runner: the worker every desktop WRITE goes through -------------

describe('command worker database binding', () => {
  beforeEach(() => {
    workerEnvs.length = 0;
    delete process.env.COREDOC_SQLITE_URL;
  });

  // 30s: the worker is mocked, but the first `await import('./command-runner.js')`
  // pays the transform of the whole main-process import graph. Under a full
  // workspace `pnpm test` (turbo running every package in parallel) that first
  // import alone can exceed the 5s default — these two tests then time out while
  // passing cleanly in isolation, which is exactly how they got (wrongly) deleted
  // once. The timeout is machine-load headroom, not a slow test.
  it('gives the worker the database of the project it was asked to run for', { timeout: 30_000 }, async () => {
    // Parse, summarize, push and embed all write through this worker, along
    // with the `operations` rows they record. Node ids embed only the repo
    // name's hash, so without a per-project url a repo named the same in two
    // projects overwrites the other's rows.
    const { runCommand } = await import('./command-runner.js');

    await runCommand({ command: 'parse', projectId: 'proj-1', repo: 'repo', args: [] } as never, mainWindow as never);

    expect(workerEnvs).toHaveLength(1);
    expect(workerEnvs[0].COREDOC_SQLITE_URL).toBe('file:/tmp/ws/coredoc.db.d/proj-1.db');
  });

  it('binds each project separately across runs', { timeout: 30_000 }, async () => {
    const { runCommand } = await import('./command-runner.js');

    await runCommand({ command: 'parse', projectId: 'proj-1', repo: 'repo', args: [] } as never, mainWindow as never);
    await runCommand({ command: 'parse', projectId: 'proj-2', repo: 'repo', args: [] } as never, mainWindow as never);

    expect(workerEnvs.map((e) => e.COREDOC_SQLITE_URL)).toEqual([
      'file:/tmp/ws/coredoc.db.d/proj-1.db',
      'file:/tmp/ws/coredoc.db.d/proj-2.db',
    ]);
  });

  it('overrides an ambient database pin with the project-owned file', async () => {
    process.env.COREDOC_SQLITE_URL = 'file:/tmp/pinned.db';
    const { runCommand } = await import('./command-runner.js');

    await runCommand({ command: 'parse', projectId: 'proj-1', repo: 'repo', args: [] } as never, mainWindow as never);

    expect(workerEnvs[0].COREDOC_SQLITE_URL).toBe('file:/tmp/ws/coredoc.db.d/proj-1.db');
  });

  it('is cancellable as soon as a successful start is reported', async () => {
    const { cancelCommand, runCommand } = await import('./command-runner.js');

    const result = await runCommand(
      { command: 'parse', projectId: 'proj-1', repo: 'repo', args: [] } as never,
      mainWindow as never,
    );

    expect(result.started).toBe(true);
    expect(cancelCommand(result.id)).toBe(true);
  });
});

// --- index.ts: the one remaining source-level check --------------------------

describe('startup database binding', () => {
  it('never pins a workspace-wide COREDOC_SQLITE_URL at startup', () => {
    // Deliberately a lint-style backstop rather than a wiring test: a
    // process-global default would silently re-collapse every project onto one
    // file, and the isolation would become a no-op while every other test kept
    // passing. Only catches a literal assignment in this file — it is a
    // tripwire for the obvious mistake, not proof of the invariant.
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf-8');
    expect(source).not.toMatch(/process\.env\.COREDOC_SQLITE_URL\s*=/);
  });
});
