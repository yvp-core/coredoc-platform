import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import type { ParsedRepo } from '@coredoc/core/types';
import { McpGraphReader } from './graph.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it('reads a prepared Ladybug graph through the installed CLI bootstrap', async () => {
  root = await mkdtemp(join(tmpdir(), 'review-real-graph-'));
  vi.stubEnv('COREDOC_HOME', root);
  const repoPath = join(root, 'repo'),
    outputDir = join(root, 'output');
  const configPath = join(root, 'config.json');
  await mkdir(repoPath);
  await mkdir(join(outputDir, 'pilot'), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      version: '2.0',
      projects: [{ id: 'pilot', name: 'Pilot', repos: [{ name: 'repo', path: repoPath, type: 'backend' }] }],
      output: { dir: outputDir, format: 'json', prettyPrint: true },
      parserStorage: join(root, 'parsers'),
    }),
  );
  const parsed: ParsedRepo = {
    id: new StableIdGenerator(repoPath, 'repo').getRepoHash(),
    name: 'repo',
    path: repoPath,
    type: 'backend',
    parsedAt: '2026-09-16T00:00:00Z',
    parserVersion: 'fixture',
    parserId: 'fixture',
    git: { remoteUrl: 'https://github.com/owner/repo.git', commitHash: 'a'.repeat(40), branch: 'main' },
    packages: [],
    files: [],
    functions: [],
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
      totalFiles: 0,
      parsedFiles: 0,
      skippedFiles: 0,
      totalFunctions: 0,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 1,
    },
  };
  await writeFile(join(outputDir, 'pilot/repo.json'), JSON.stringify(parsed));
  const cli = await import('../../dist/sdk/index.js');
  const db = await import('@coredoc/db');
  await cli.runUnifiedPush(
    'pilot',
    'repo',
    { config: configPath, backend: 'ladybug', includeSummaries: false, includeEmbeddings: false, crossRepo: false },
    cli.loadConfig(configPath),
  );
  await db.closeProjectDatabases();
  const graph = new McpGraphReader(
    {
      local: { cliPath: resolve('dist/index.js'), configPath, projectId: 'pilot', backend: 'ladybug' },
      scope: repoPath,
      repoName: 'repo',
      locallyPreparedBase: true,
    },
    'owner/repo',
    '',
    AbortSignal.timeout(15000),
  );
  const callTool = Client.prototype.callTool;
  vi.spyOn(Client.prototype, 'callTool').mockImplementation(async function (...args) {
    const response = await callTool.apply(this, args);
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    return response;
  });
  try {
    expect(await graph.snapshot()).toMatchObject({
      commit: 'a'.repeat(40),
      snapshotId: expect.stringMatching(/^parse:/),
    });
    await expect(graph.query('search_symbols', 'missing-fixture-symbol')).resolves.toHaveProperty('evidence');
  } finally {
    await graph.close();
  }
}, 20000);
