import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import type { ParsedRepo } from '@coredoc/core/types';

const ENV_KEYS = [
  'HOME',
  'ALLOW_SOURCES_IN_GRAPH',
  'COREDOC_DB_BACKEND',
  'COREDOC_LADYBUG_PATH',
  'COREDOC_SCOPE',
  'COREDOC_SQLITE_URL',
  'MCP_CONFIG_PATH',
] as const;

const originalEnv = new Map<string, string | undefined>();
let workspace: string;
let readerProcess: ChildProcess | undefined;

type ToolCallHandler = (request: unknown) => Promise<{
  isError?: boolean;
  content: Array<{ text: string }>;
}>;

function toolCallHandler(server: unknown): ToolCallHandler {
  const handlers = (server as { _requestHandlers: Map<string, ToolCallHandler> })._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('Built MCP server did not register tools/call');
  return handler;
}

async function startReaderProcess(configDir: string, projectId: string): Promise<ChildProcess> {
  const dbEntry = new URL('../../db/dist/index.js', import.meta.url).href;
  const script = `
    const db = await import(${JSON.stringify(dbEntry)});
    await db.openProjectDatabase(${JSON.stringify(configDir)}, ${JSON.stringify(projectId)}, {
      mode: 'read',
      backend: 'ladybug',
    });
    process.send?.('READY');
    process.on('message', async (message) => {
      if (message !== 'CLOSE') return;
      await db.closeProjectDatabases();
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Timed out waiting for the Ladybug reader process'));
    }, 10_000);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Ladybug reader exited before READY (${code}): ${stderr}`));
    });
    child.once('message', (message) => {
      if (message !== 'READY') return;
      clearTimeout(timeout);
      resolve();
    });
  });
  return child;
}

async function stopReaderProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.send?.('CLOSE');
  const didExit = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!didExit) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

async function runBuiltCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: { ...process.env, COREDOC_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) throw new Error(`Built CLI exited ${code}: ${stderr || stdout}`);
  return { stdout, stderr };
}

function parsedFixture(repoPath: string, repoName = 'pilot-repo', functionName = 'ПривітLadybug'): ParsedRepo {
  const repoId = new StableIdGenerator(repoPath, repoName).getRepoHash();
  const fileId = `${repoId}:file:src/pilot.ts`;
  const functionId = `${repoId}:function:src/pilot.ts:${functionName}`;
  return {
    id: repoId,
    name: repoName,
    path: repoPath,
    type: 'backend',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: 'test',
    parserId: 'local-ladybug-integration',
    packages: [],
    files: [
      {
        id: fileId,
        versionedId: `${fileId}@v1`,
        path: 'src/pilot.ts',
        extension: '.ts',
        packageId: repoId,
        language: 'typescript',
        contentHash: 'fixture-hash',
        loc: 3,
      },
    ],
    functions: [
      {
        id: functionId,
        versionedId: `${functionId}@v1`,
        kind: 'function',
        name: functionName,
        fileId,
        isAsync: false,
        isGenerator: false,
        isExported: true,
        parameters: [],
        sourceCode: `export function ${functionName}(): string { return "ok"; }`,
        location: { filePath: 'src/pilot.ts', startLine: 1, endLine: 3 },
      },
    ],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: {
      totalFiles: 1,
      parsedFiles: 1,
      skippedFiles: 0,
      totalFunctions: 1,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 1,
    },
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  workspace = mkdtempSync(join(tmpdir(), 'coredoc-local-ladybug-'));
  process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
  process.env.COREDOC_DB_BACKEND = 'ladybug';
  delete process.env.COREDOC_LADYBUG_PATH;
  delete process.env.COREDOC_SQLITE_URL;
});

afterEach(async () => {
  await stopReaderProcess(readerProcess);
  readerProcess = undefined;
  const { closeAllDrivers, closeProjectDatabases } = await import('@coredoc/db');
  await Promise.allSettled([closeAllDrivers(), closeProjectDatabases()]);
  rmSync(workspace, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('local Ladybug runtime', () => {
  it('publishes parsed repositories even when the first configured repo is unparsed', async () => {
    const outputDir = join(workspace, 'coredoc-output');
    const projectOutputDir = join(outputDir, 'pilot');
    const configPath = join(workspace, 'coredoc.config.json');
    const repos = ['unparsed', 'parsed'].map((name) => ({ name, path: join(workspace, name), type: 'backend' }));
    for (const repo of repos) mkdirSync(repo.path);
    mkdirSync(projectOutputDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [{ id: 'pilot', name: 'Pilot', repos }],
        output: { dir: outputDir, format: 'json', prettyPrint: true },
        parserStorage: join(workspace, 'coredoc-parsers'),
      }),
    );
    const parsed = parsedFixture(repos[1]!.path, 'parsed');
    const parsedPath = join(projectOutputDir, 'parsed.json');
    writeFileSync(parsedPath, JSON.stringify(parsed));
    const cli = await import('../dist/sdk/index.js');
    const db = await import('@coredoc/db');
    const config = cli.loadConfig(configPath);

    await expect(
      cli.runUnifiedPush(
        'pilot',
        'parsed',
        {
          config: configPath,
          backend: 'ladybug',
          includeSummaries: false,
          includeEmbeddings: false,
        },
        config,
      ),
    ).resolves.toMatchObject({ success: true, repositoryName: 'parsed' });

    const args = [
      'push',
      '--project',
      'pilot',
      '--config',
      configPath,
      '--backend',
      'ladybug',
      '--no-summaries',
      '--no-embeddings',
    ];
    const result = await runBuiltCli(args, workspace);
    expect(result.stdout.match(/Published complete Ladybug graph/g)).toHaveLength(1);
    let graph = await db.openProjectDatabase(workspace, 'pilot', { mode: 'read', backend: 'ladybug' });
    expect((await graph.graph.listAllRepositories()).map(({ name }) => name)).toEqual(['parsed']);
    await db.closeProjectDatabases();

    rmSync(parsedPath);
    await expect(runBuiltCli(args, workspace)).rejects.toThrow(/No parsed repo artifacts/);
    graph = await db.openProjectDatabase(workspace, 'pilot', { mode: 'read', backend: 'ladybug' });
    expect((await graph.graph.listAllRepositories()).map(({ name }) => name)).toEqual(['parsed']);
  }, 30_000);

  it('bootstraps a cold FTS cache for an SDK push and rebuilds only once for a project-wide CLI push', async () => {
    // A developer's installed extension must not hide a broken first push on a fresh machine.
    process.env.HOME = join(workspace, 'extension-home');
    mkdirSync(process.env.HOME);
    const outputDir = join(workspace, 'coredoc-output');
    const projectOutputDir = join(outputDir, 'pilot');
    const configPath = join(workspace, 'coredoc.config.json');
    const repoAPath = join(workspace, 'repos', 'repo-a');
    const repoBPath = join(workspace, 'repos', 'repo-b');
    mkdirSync(repoAPath, { recursive: true });
    mkdirSync(repoBPath, { recursive: true });
    mkdirSync(projectOutputDir, { recursive: true });

    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [
          {
            id: 'pilot',
            name: 'Pilot',
            repos: [
              { name: 'repo-a', path: repoAPath, type: 'backend' },
              { name: 'repo-b', path: repoBPath, type: 'backend' },
            ],
          },
        ],
        output: { dir: outputDir, format: 'json', prettyPrint: true },
        parserStorage: join(workspace, 'coredoc-parsers'),
      }),
    );
    const repoA = parsedFixture(repoAPath, 'repo-a', 'fromRepoA');
    const repoB = parsedFixture(repoBPath, 'repo-b', 'fromRepoB');
    const repoBPackageId = `${repoB.id}:package:.`;
    repoB.packages = [{ id: repoBPackageId, name: 'repo-b', path: '.', description: 'manifest description' }];
    repoB.files[0]!.packageId = repoBPackageId;
    writeFileSync(join(projectOutputDir, 'repo-a.json'), JSON.stringify(repoA));
    writeFileSync(join(projectOutputDir, 'repo-b.json'), JSON.stringify(repoB));
    writeFileSync(
      join(projectOutputDir, 'repo-b-summaries.json'),
      JSON.stringify({
        repoId: repoB.id,
        repoName: repoB.name,
        generatedAt: '2026-08-11T00:00:00.000Z',
        summarizerVersion: 'test',
        summaries: [],
        stats: {
          totalFunctions: 1,
          summarized: 0,
          skippedCached: 0,
          failedSummarization: 0,
          processingTimeMs: 1,
        },
        packageSummaries: [
          {
            packageId: repoBPackageId,
            purpose: 'AI package purpose',
            generatedAt: '2026-08-11T00:00:00.000Z',
          },
        ],
      }),
    );

    const cli = await import('../dist/sdk/index.js');
    const db = await import('@coredoc/db');
    const config = cli.loadConfig(configPath);
    await cli.runUnifiedPush(
      'pilot',
      'repo-a',
      {
        config: configPath,
        backend: 'ladybug',
        includeSummaries: true,
        includeEmbeddings: false,
        crossRepo: true,
      },
      config,
    );

    const batch = await runBuiltCli(
      [
        'push',
        '--project',
        'pilot',
        '--config',
        configPath,
        '--backend',
        'ladybug',
        '--no-embeddings',
        '--no-cross-repo',
      ],
      workspace,
    );
    expect(batch.stdout.match(/Published complete Ladybug graph/g)).toHaveLength(1);

    const graph = await db.openProjectDatabase(workspace, 'pilot', { mode: 'read', backend: 'ladybug' });
    const repositories = await graph.graph.getRepositoryNames([repoA.id, repoB.id]);
    expect(repositories.map(({ name }) => name).sort()).toEqual(['repo-a', 'repo-b']);
    const repoBFunction = await graph.graph.getNodeWithProperties(repoB.functions[0]!.id, [repoB.id]);
    expect(repoBFunction?.properties.sourceCode).toContain('fromRepoB');
    const repoBPackage = await graph.graph.getNodeWithProperties(repoBPackageId, [repoB.id]);
    expect(repoBPackage?.properties.description).toBe('AI package purpose');
    await db.closeProjectDatabases();

    const graphDir = join(workspace, 'coredoc.db.d');
    const ladybugPath = join(graphDir, 'pilot.lbdb');
    expect(existsSync(ladybugPath)).toBe(true);
    expect(existsSync(`${ladybugPath}.wal`)).toBe(false);
    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
    expect(readdirSync(graphDir).filter((entry) => entry.includes('.replace-') || entry.includes('.build-'))).toEqual(
      [],
    );
  }, 30_000);

  it('pushes through built CLI, reads through non-injected built MCP, explains the reader lock, and retries', async () => {
    const repoPath = join(workspace, 'repos', 'pilot-repo');
    const outputDir = join(workspace, 'coredoc-output');
    const parsedPath = join(outputDir, 'pilot', 'pilot-repo.json');
    const configPath = join(workspace, 'coredoc.config.json');
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(outputDir, 'pilot'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [
          {
            id: 'pilot',
            name: 'Pilot',
            repos: [{ name: 'pilot-repo', path: repoPath, type: 'backend' }],
          },
        ],
        output: { dir: outputDir, format: 'json', prettyPrint: true },
        parserStorage: join(workspace, 'coredoc-parsers'),
      }),
    );
    writeFileSync(parsedPath, JSON.stringify(parsedFixture(repoPath)));

    // Deliberately import built package entrypoints: this test must fail when
    // source is fixed but the runtime dist consumed by CLI/MCP is stale.
    const cli = await import('../dist/sdk/index.js');
    const db = await import('@coredoc/db');
    const mcp = await import('@coredoc/mcp');
    const config = cli.loadConfig(configPath);
    const push = () =>
      cli.runUnifiedPush(
        'pilot',
        'pilot-repo',
        {
          config: configPath,
          includeSummaries: false,
          includeEmbeddings: false,
          crossRepo: false,
        },
        config,
      );

    const firstPush = await push();
    expect(firstPush.backend).toBe('ladybug');
    const ladybugPath = join(workspace, 'coredoc.db.d', 'pilot.lbdb');
    expect(existsSync(ladybugPath)).toBe(true);
    expect(existsSync(`${ladybugPath}.wal`)).toBe(false);
    expect(existsSync(`${ladybugPath}.shadow`)).toBe(false);
    expect(existsSync(`${ladybugPath}.tmp`)).toBe(false);
    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
    expect(existsSync(`${ladybugPath}.readers`)).toBe(false);

    process.env.MCP_CONFIG_PATH = configPath;
    process.env.COREDOC_SCOPE = 'project:pilot';
    const server = mcp.createServer();
    const callTool = toolCallHandler(server);
    const search = () =>
      callTool({
        method: 'tools/call',
        params: {
          name: 'search_symbols',
          arguments: {
            query: 'ПривітLadybug',
            exact: true,
            includeSource: true,
            format: 'summary',
            scope: repoPath,
          },
        },
      });

    const firstRead = await search();
    expect(firstRead.isError, JSON.stringify(firstRead.content)).not.toBe(true);
    expect(firstRead.content[0].text).toContain('ПривітLadybug');
    expect(firstRead.content[0].text).toContain('return "ok"');

    const readHandle = await db.openProjectDatabase(workspace, 'pilot', {
      mode: 'read',
      backend: 'ladybug',
    });
    await expect(readHandle.graph.deleteRepository(parsedFixture(repoPath).id)).rejects.toThrow(/read-only/i);

    // Ladybug's lock is process-scoped on this platform, while local MCP and
    // CLI are separate processes in production. Close the in-process verifier
    // and hold a real read-only handle in a child process for the lock check.
    await db.closeProjectDatabases();
    readerProcess = await startReaderProcess(workspace, 'pilot');

    await expect(push()).rejects.toThrow(/Stop the local Coredoc MCP process, retry the push, then restart MCP/i);
    const stillReadable = await search();
    expect(stillReadable.isError, JSON.stringify(stillReadable.content)).not.toBe(true);
    expect(stillReadable.content[0].text).toContain('ПривітLadybug');

    await db.closeProjectDatabases();
    await stopReaderProcess(readerProcess);
    readerProcess = undefined;
    await expect(push()).resolves.toMatchObject({ success: true, backend: 'ladybug' });
    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
    expect(existsSync(`${ladybugPath}.readers`)).toBe(false);
  }, 30_000);
});
