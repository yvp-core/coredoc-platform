import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { EmbeddingsOutput, ParsedRepo, SummaryOutput } from '@coredoc/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LadybugDriver } from './ladybug/driver.js';
import { LadybugRepository } from './ladybug/repository.js';
import { buildGraphFile, type VerifiedGraphBuildComponent } from './file-builder.js';
import { openGraphFile } from './graph-file.js';

const REPO_A = 'aaaaaaaaaaaa';
const REPO_B = 'bbbbbbbbbbbb';
const SOURCE_CANARY = 'SOURCE_CANARY_1f695a32f1db4ee8b632f253ac2d1c77';
const NESTED_CANARY = 'NESTED_CANARY_a7cf72088bb3473492e08bf678dfa155';
const EMBEDDING_INPUT_CANARY = 'EMBED_CANARY_2ca16b9ec6d34e4bb4800e4935492d88';
const ABSOLUTE_PATH_CANARY = '/private/tenant/SOURCE_PATH_CANARY_463b79e745d84d42a3c7696214518a88';
const UNICODE_FUNCTION_NAME = 'unicodeSnowman_雪';
const QUOTED_SUMMARY = 'First line, with comma and "quote"\nSecond line with snow: 雪 and C:\\graphs\\contract';
const HIGH_PRECISION_EMBEDDING = [1e40, -Math.PI];

interface IterationTrace {
  iteratorCalls: number;
  nextCalls: number;
  yieldedRepoNames: string[];
}

function makeParsedRepo(repoId: string, repoName: string, includeStressEdges: boolean): ParsedRepo {
  const fileId = `${repoId}:file:src/app.ts`;
  const callerId = `${repoId}:function:src/app.ts:caller`;
  const targetId = `${repoId}:function:src/app.ts:${UNICODE_FUNCTION_NAME}`;
  const location = { filePath: 'src/app.ts', startLine: 1, endLine: 4 };
  const functions: ParsedRepo['functions'] = [
    {
      id: callerId,
      versionedId: `${callerId}@v1`,
      name: 'caller',
      kind: 'function',
      fileId,
      isAsync: false,
      isGenerator: false,
      isExported: true,
      parameters: [],
      location,
      sourceCode: `function caller() { return '${SOURCE_CANARY}'; }`,
    },
    {
      id: targetId,
      versionedId: `${targetId}@v1`,
      name: UNICODE_FUNCTION_NAME,
      kind: 'function',
      fileId,
      isAsync: false,
      isGenerator: false,
      isExported: true,
      parameters: [],
      location: { ...location, startLine: 10, endLine: 14 },
      sourceCode: `function unicode() { return '${NESTED_CANARY}'; }`,
      documentation: { sourceCode: { nested: NESTED_CANARY } } as unknown as string,
    },
  ];

  const calls: ParsedRepo['calls'] = includeStressEdges
    ? [
        {
          id: `${repoId}:call:one`,
          callerId,
          calleeId: targetId,
          calleeExpression: UNICODE_FUNCTION_NAME,
          isAsync: false,
          location,
        },
        {
          id: `${repoId}:call:duplicate`,
          callerId,
          calleeId: targetId,
          calleeExpression: UNICODE_FUNCTION_NAME,
          isAsync: false,
          location: { ...location, startLine: 2 },
        },
        {
          id: `${repoId}:call:dangling`,
          callerId,
          calleeId: `${repoId}:function:src/missing.ts:missing`,
          calleeExpression: 'missing',
          isAsync: false,
          location: { ...location, startLine: 3 },
        },
        // No calleeId: a dynamic boundary, persisted beside the graph rather
        // than as an edge.
        {
          id: `${repoId}:call:unresolved`,
          callerId,
          calleeExpression: 'this.client.emit',
          isAsync: false,
          location: { ...location, startLine: 5 },
        },
      ]
    : [];

  return {
    id: repoId,
    name: repoName,
    path: `${ABSOLUTE_PATH_CANARY}/${repoName}`,
    type: 'backend',
    parsedAt: '2026-08-10T00:00:00.000Z',
    parserVersion: 'builder-test-v1',
    parserId: 'builder-test',
    packages: [],
    files: [
      {
        id: fileId,
        versionedId: `${fileId}@v1`,
        path: 'src/app.ts',
        extension: '.ts',
        language: 'typescript',
        contentHash: 'content-v1',
        loc: 20,
      },
    ],
    functions,
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls,
    imports: [],
    externalCalls: [],
    stats: {
      totalFiles: 1,
      parsedFiles: 1,
      skippedFiles: 0,
      totalFunctions: functions.length,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: calls.length,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 1,
    },
  };
}

function makeSummary(parsedRepo: ParsedRepo): SummaryOutput {
  const caller = parsedRepo.functions.find((fn) => fn.name === 'caller') as ParsedRepo['functions'][number];
  const target = parsedRepo.functions.find(
    (fn) => fn.name === UNICODE_FUNCTION_NAME,
  ) as ParsedRepo['functions'][number];
  return {
    repoId: parsedRepo.id,
    repoName: parsedRepo.name,
    generatedAt: '2026-08-10T00:00:00.000Z',
    summarizerVersion: 'builder-test-v1',
    summaries: [
      {
        functionId: caller.id,
        versionedId: caller.versionedId,
        detailed_summary: '',
        purpose: '',
        business_logic: [],
        side_effects: [],
        data_handling: '',
        confidence_level: 'high',
        unknowns: [],
        generatedAt: '2026-08-10T00:00:00.000Z',
      },
      {
        functionId: target.id,
        versionedId: target.versionedId,
        detailed_summary: QUOTED_SUMMARY,
        purpose: 'Exercise CSV fidelity.',
        business_logic: [],
        side_effects: [],
        data_handling: '',
        confidence_level: 'high',
        unknowns: [],
        generatedAt: '2026-08-10T00:00:00.000Z',
      },
    ],
    stats: {
      totalFunctions: parsedRepo.functions.length,
      summarized: 2,
      skippedCached: 0,
      failedSummarization: 0,
      processingTimeMs: 1,
    },
  };
}

function makeEmbeddings(parsedRepo: ParsedRepo): EmbeddingsOutput {
  const target = parsedRepo.functions.find(
    (fn) => fn.name === UNICODE_FUNCTION_NAME,
  ) as ParsedRepo['functions'][number];
  return {
    repoId: parsedRepo.id,
    repoName: parsedRepo.name,
    generatedAt: '2026-08-10T00:00:00.000Z',
    provider: 'test',
    model: 'test-embedding',
    dimensions: 2,
    inputStrategy: 'source',
    functions: [
      {
        functionId: target.id,
        versionedId: target.versionedId,
        name: target.name,
        filePath: target.location.filePath,
        inputChecksum: 'embedding-input-v1',
        inputText: EMBEDDING_INPUT_CANARY,
        embedding: HIGH_PRECISION_EMBEDDING,
        generatedAt: '2026-08-10T00:00:00.000Z',
      },
    ],
    endpoints: [],
    stats: {
      totalFunctions: 1,
      totalEndpoints: 0,
      functionsEmbedded: 1,
      endpointsEmbedded: 0,
      functionsSkipped: 0,
      endpointsSkipped: 0,
      failed: 0,
      processingTimeMs: 1,
    },
  };
}

function trackedComponents(trace: IterationTrace): AsyncIterable<VerifiedGraphBuildComponent> {
  const firstParsed = makeParsedRepo(REPO_A, 'repo-a', true);
  const secondParsed = makeParsedRepo(REPO_B, 'repo-b', false);
  let firstExpired = false;
  const first: VerifiedGraphBuildComponent = {
    get parsedRepo() {
      if (firstExpired) throw new Error('the first component was retained after the iterable advanced');
      return firstParsed;
    },
    summaryOutput: makeSummary(firstParsed),
    embeddingsOutput: makeEmbeddings(firstParsed),
  };
  const second: VerifiedGraphBuildComponent = { parsedRepo: secondParsed };

  return {
    [Symbol.asyncIterator]() {
      trace.iteratorCalls += 1;
      let index = 0;
      return {
        async next(): Promise<IteratorResult<VerifiedGraphBuildComponent>> {
          trace.nextCalls += 1;
          if (index === 0) {
            index += 1;
            trace.yieldedRepoNames.push('repo-a');
            return { done: false, value: first };
          }
          if (index === 1) {
            firstExpired = true;
            index += 1;
            trace.yieldedRepoNames.push('repo-b');
            return { done: false, value: second };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

async function* freshComponents(): AsyncGenerator<VerifiedGraphBuildComponent> {
  const first = makeParsedRepo(REPO_A, 'repo-a', true);
  yield { parsedRepo: first, summaryOutput: makeSummary(first), embeddingsOutput: makeEmbeddings(first) };
  yield { parsedRepo: makeParsedRepo(REPO_B, 'repo-b', false) };
}

function artifactSidecars(artifactPath: string): string[] {
  const base = basename(artifactPath);
  return readdirSync(dirname(artifactPath))
    .filter((entry) => entry !== base && entry.startsWith(base))
    .filter((entry) => statSync(join(dirname(artifactPath), entry)).size > 0)
    .sort();
}

async function readCanonicalGraph(artifactPath: string) {
  const driver = new LadybugDriver(artifactPath, {
    readOnly: true,
    initializeSchema: false,
    ftsMode: 'load',
  });
  await driver.initialize();
  const repository = new LadybugRepository(driver);
  try {
    const names = await repository.getRepositoryNames([REPO_A, REPO_B]);
    const functionInfo = await repository.findFunction(UNICODE_FUNCTION_NAME, [REPO_A]);
    const callers = await repository.getTransitiveCallers(`${REPO_A}:function:src/app.ts:${UNICODE_FUNCTION_NAME}`, 1, [
      REPO_A,
    ]);
    const stored = await driver.withReadTransaction((tx) =>
      tx.run<{ name: string; properties: string; summary: string | null }>(
        'MATCH (n:GraphNode) RETURN n.name AS name, n.properties AS properties, n.summary AS summary ORDER BY n.id',
      ),
    );
    const embedded = await repository.getEmbeddedNodes([REPO_A]);
    return {
      repoNames: names.map((row) => row.name).sort(),
      functionSummary: functionInfo?.summary,
      emptySummary: stored.find((row) => row.name === 'caller')?.summary,
      embedding: embedded.find((row) => row.name === UNICODE_FUNCTION_NAME)?.embedding,
      callerIds: callers.map((row) => row.id).sort(),
      logicalText: JSON.stringify(stored),
    };
  } finally {
    await driver.close();
  }
}

describe('buildGraphFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-file-builder-test-'));
  const trace: IterationTrace = { iteratorCalls: 0, nextCalls: 0, yieldedRepoNames: [] };
  let result: Awaited<ReturnType<typeof buildGraphFile>>;

  beforeAll(async () => {
    const previous = process.env.ALLOW_SOURCES_IN_GRAPH;
    process.env.ALLOW_SOURCES_IN_GRAPH = '1';
    try {
      result = await buildGraphFile({
        outputPath: join(root, 'ladybug.graph'),
        workDir: join(root, 'ladybug-work'),
        components: trackedComponents(trace),
      });
    } finally {
      if (previous === undefined) delete process.env.ALLOW_SOURCES_IN_GRAPH;
      else process.env.ALLOW_SOURCES_IN_GRAPH = previous;
    }
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('hands each transformed component to onComponentTransformed once, post-strip and pre-write, and a hook throw rejects the build', async () => {
    const hookRoot = mkdtempSync(join(tmpdir(), 'coredoc-file-builder-hook-'));
    try {
      const observed: Array<{ repositoryId: string; nodeCount: number }> = [];
      await buildGraphFile({
        outputPath: join(hookRoot, 'hook.graph'),
        workDir: join(hookRoot, 'work'),
        components: (async function* () {
          yield { parsedRepo: makeParsedRepo(REPO_A, 'repo-a', false) };
          yield { parsedRepo: makeParsedRepo(REPO_B, 'repo-b', false) };
        })(),
        onComponentTransformed: (transformed) => {
          // Post-strip: the exact objects being written must carry no source.
          for (const node of transformed.nodes) {
            expect(node.properties?.sourceCode).toBeUndefined();
          }
          observed.push({ repositoryId: transformed.repositoryId, nodeCount: transformed.nodes.length });
        },
      });
      expect(observed.map(({ repositoryId }) => repositoryId)).toEqual([REPO_A, REPO_B]);
      expect(observed.every(({ nodeCount }) => nodeCount > 0)).toBe(true);

      // Pre-write: a hook rejection must fail the build and leave no artifact.
      const rejectedPath = join(hookRoot, 'rejected.graph');
      await expect(
        buildGraphFile({
          outputPath: rejectedPath,
          workDir: join(hookRoot, 'rejected-work'),
          components: (async function* () {
            yield { parsedRepo: makeParsedRepo(REPO_A, 'repo-a', false) };
          })(),
          onComponentTransformed: () => {
            throw new Error('component rejected by policy');
          },
        }),
      ).rejects.toThrow('component rejected by policy');
      expect(existsSync(rejectedPath)).toBe(false);
    } finally {
      rmSync(hookRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('restores an explicitly empty node name after COPY instead of persisting NULL', async () => {
    const nameRoot = mkdtempSync(join(tmpdir(), 'coredoc-file-builder-name-'));
    try {
      // Index routes ({ path: '' }) legitimately produce name:'' — a NULL here
      // fails the server's structural scan and rejects the whole snapshot.
      const parsed = makeParsedRepo(REPO_A, 'repo-a', false);
      parsed.functions[0]!.name = '';
      const outputPath = join(nameRoot, 'empty-name.graph');
      await buildGraphFile({
        outputPath,
        workDir: join(nameRoot, 'work'),
        components: (async function* () {
          yield { parsedRepo: parsed };
        })(),
      });
      const driver = new LadybugDriver(outputPath, { readOnly: true, initializeSchema: false, ftsMode: 'load' });
      await driver.initialize();
      try {
        const repository = new LadybugRepository(driver);
        for await (const node of repository.scanStoredNodes()) {
          expect(typeof node.name).toBe('string');
        }
      } finally {
        await driver.close();
      }
    } finally {
      rmSync(nameRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('consumes each async iterable exactly once and finishes one component before pulling the next', () => {
    expect(trace).toEqual({
      iteratorCalls: 1,
      nextCalls: 3,
      yieldedRepoNames: ['repo-a', 'repo-b'],
    });
  });

  it('returns exact dangling and duplicate-edge counters', () => {
    expect(result).toMatchObject({
      droppedDanglingEdgeCount: 1,
      deduplicatedEdgeCount: 1,
    });
  });

  it('produces one non-empty artifact and no non-empty sidecars', () => {
    expect(existsSync(result.artifactPath)).toBe(true);
    expect(statSync(result.artifactPath).isFile()).toBe(true);
    expect(result.fileSizeBytes).toBe(statSync(result.artifactPath).size);
    expect(result.fileSizeBytes).toBeGreaterThan(0);
    expect(artifactSidecars(result.artifactPath)).toEqual([]);
  });

  it('builds a readable graph and preserves RFC4180 Unicode/quoted-newline metadata', async () => {
    const graph = await readCanonicalGraph(result.artifactPath);
    expect(graph.repoNames).toEqual(['repo-a', 'repo-b']);
    expect(graph.functionSummary).toBe(QUOTED_SUMMARY);
    expect(graph.emptySummary).toBe('');
    expect(graph.embedding).toEqual(HIGH_PRECISION_EMBEDDING);
    expect(graph.callerIds).toEqual([`${REPO_A}:function:src/app.ts:caller`]);
  });

  it('carries unresolved call sites through the build-file → open-file round trip', async () => {
    const handle = await openGraphFile({
      path: result.artifactPath,
      budgets: { maxDbSizeBytes: 1024 ** 3, bufferPoolBytes: 256 * 1024 ** 2 },
    });
    try {
      expect(await handle.repository.findUnresolvedCallsByNameTail('emit', [REPO_A])).toEqual([
        {
          callerId: `${REPO_A}:function:src/app.ts:caller`,
          calleeExpression: 'this.client.emit',
          calleeNameTail: 'emit',
          filePath: 'src/app.ts',
          line: 5,
        },
      ]);
      // The resolved call in the same fixture is an edge, never a boundary.
      expect(await handle.repository.findUnresolvedCallsByNameTail(UNICODE_FUNCTION_NAME, [REPO_A])).toEqual([]);
      expect(await handle.repository.findUnresolvedCallsInFiles(['src/app.ts'], [REPO_B])).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('strips tenant source and embedding input even when source inclusion is forced on', async () => {
    const logical = (await readCanonicalGraph(result.artifactPath)).logicalText;
    const physical = readFileSync(result.artifactPath);
    for (const canary of [SOURCE_CANARY, NESTED_CANARY, EMBEDDING_INPUT_CANARY, ABSOLUTE_PATH_CANARY]) {
      expect(logical).not.toContain(canary);
      expect(physical.includes(Buffer.from(canary))).toBe(false);
    }
  });

  it('retains source only for an explicit local build while still discarding embedding input text', async () => {
    const localRoot = mkdtempSync(join(tmpdir(), 'coredoc-file-builder-local-source-'));
    const previous = process.env.ALLOW_SOURCES_IN_GRAPH;
    process.env.ALLOW_SOURCES_IN_GRAPH = '1';
    try {
      const parsedRepo = makeParsedRepo(REPO_A, 'repo-a', false);
      const localResult = await buildGraphFile({
        outputPath: join(localRoot, 'local.graph'),
        workDir: join(localRoot, 'work'),
        components: (async function* (): AsyncGenerator<VerifiedGraphBuildComponent> {
          yield { parsedRepo, embeddingsOutput: makeEmbeddings(parsedRepo) };
        })(),
        sourcePolicy: 'preserve',
      });

      const logical = (await readCanonicalGraph(localResult.artifactPath)).logicalText;
      const physical = readFileSync(localResult.artifactPath);
      expect(logical).toContain(SOURCE_CANARY);
      expect(physical.includes(Buffer.from(SOURCE_CANARY))).toBe(true);
      expect(logical).not.toContain(EMBEDDING_INPUT_CANARY);
      expect(physical.includes(Buffer.from(EMBEDDING_INPUT_CANARY))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_SOURCES_IN_GRAPH;
      else process.env.ALLOW_SOURCES_IN_GRAPH = previous;
      rmSync(localRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('removes partial artifacts and sidecars when a build fails', async () => {
    const outputPath = join(root, 'failed.graph');
    const parsedRepo = makeParsedRepo(REPO_A, 'duplicate-repo', false);
    const components = (async function* (): AsyncGenerator<VerifiedGraphBuildComponent> {
      yield { parsedRepo };
      yield { parsedRepo };
    })();

    await expect(
      buildGraphFile({
        outputPath,
        workDir: join(root, 'failed-work'),
        components,
      }),
    ).rejects.toThrow(/duplicate graph node id/i);

    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(dirname(outputPath)).filter((entry) => entry.startsWith(basename(outputPath)))).toEqual([]);
  });

  it('publishes the final path only after a successful build', async () => {
    const outputPath = join(root, 'atomic.graph');
    let finalPathWasVisibleDuringBuild = false;
    const components = (async function* (): AsyncGenerator<VerifiedGraphBuildComponent> {
      yield { parsedRepo: makeParsedRepo(REPO_A, 'atomic-repo', false) };
      finalPathWasVisibleDuringBuild = existsSync(outputPath);
      throw new Error('fail after the first component');
    })();

    await expect(
      buildGraphFile({
        outputPath,
        workDir: join(root, 'atomic-work'),
        components,
      }),
    ).rejects.toThrow('fail after the first component');
    expect(finalPathWasVisibleDuringBuild).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.startsWith(`.${basename(outputPath)}.build-`))).toEqual([]);
  });

  it('rejects NUL text with the offending node and column before writing', async () => {
    const outputPath = join(root, 'nul.graph');
    const parsedRepo = makeParsedRepo(REPO_A, 'nul-repo', false);
    const nodeId = parsedRepo.functions[0]!.id;
    parsedRepo.functions[0]!.name = 'caller\0hidden';

    await expect(
      buildGraphFile({
        outputPath,
        workDir: join(root, 'nul-work'),
        components: (async function* (): AsyncGenerator<VerifiedGraphBuildComponent> {
          yield { parsedRepo };
        })(),
      }),
    ).rejects.toThrow(new RegExp(`NUL.*${nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*name`, 'i'));
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects one edge id mapped to multiple relationship identities', async () => {
    const outputPath = join(root, 'duplicate-edge-id.graph');
    const parsedRepo = makeParsedRepo(REPO_A, 'duplicate-edge-id', true);
    const firstCall = parsedRepo.calls[0] as ParsedRepo['calls'][number];
    parsedRepo.calls = [
      firstCall,
      {
        ...firstCall,
        callerId: parsedRepo.functions[1]!.id,
        calleeId: parsedRepo.functions[0]!.id,
      },
    ];

    await expect(
      buildGraphFile({
        outputPath,
        workDir: join(root, 'duplicate-edge-id-work'),
        components: (async function* (): AsyncGenerator<VerifiedGraphBuildComponent> {
          yield { parsedRepo };
        })(),
      }),
    ).rejects.toThrow(/duplicate graph edge id.*multiple identities/i);

    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(dirname(outputPath)).filter((entry) => entry.startsWith(basename(outputPath)))).toEqual([]);
  });

  it('rebuilds the same verified input to an equivalent graph', async () => {
    const first = await buildGraphFile({
      outputPath: join(root, 'deterministic-a.graph'),
      workDir: join(root, 'deterministic-a-work'),
      components: freshComponents(),
    });
    const second = await buildGraphFile({
      outputPath: join(root, 'deterministic-b.graph'),
      workDir: join(root, 'deterministic-b-work'),
      components: freshComponents(),
    });

    expect({
      nodeCount: second.nodeCount,
      edgeCount: second.edgeCount,
      droppedDanglingEdgeCount: second.droppedDanglingEdgeCount,
      deduplicatedEdgeCount: second.deduplicatedEdgeCount,
    }).toEqual({
      nodeCount: first.nodeCount,
      edgeCount: first.edgeCount,
      droppedDanglingEdgeCount: first.droppedDanglingEdgeCount,
      deduplicatedEdgeCount: first.deduplicatedEdgeCount,
    });
    expect(await readCanonicalGraph(second.artifactPath)).toEqual(await readCanonicalGraph(first.artifactPath));
  }, 120_000);

  it('cleans partial output after aborts, iterator failures, and empty input', async () => {
    const scenarios: Array<{
      name: string;
      components: AsyncIterable<VerifiedGraphBuildComponent>;
      signal?: AbortSignal;
    }> = [];
    const preAborted = new AbortController();
    preAborted.abort(new Error('pre-aborted build'));
    scenarios.push({ name: 'pre-abort', components: freshComponents(), signal: preAborted.signal });
    const midBuildAbort = new AbortController();
    scenarios.push({
      name: 'mid-build-abort',
      signal: midBuildAbort.signal,
      components: (async function* (): AsyncGenerator<VerifiedGraphBuildComponent> {
        yield { parsedRepo: makeParsedRepo(REPO_A, 'repo-a', false) };
        midBuildAbort.abort(new Error('mid-build abort'));
      })(),
    });
    scenarios.push({
      name: 'iterator-error',
      components: (async function* (): AsyncGenerator<VerifiedGraphBuildComponent> {
        yield { parsedRepo: makeParsedRepo(REPO_A, 'repo-a', false) };
        throw new Error('component iterator failed');
      })(),
    });
    scenarios.push({
      name: 'empty',
      components: (async function* (): AsyncGenerator<VerifiedGraphBuildComponent> {
        yield* [] as VerifiedGraphBuildComponent[];
      })(),
    });

    for (const scenario of scenarios) {
      const outputPath = join(root, `${scenario.name}.graph`);
      const workDir = join(root, `${scenario.name}-work`);
      await expect(
        buildGraphFile({ outputPath, workDir, components: scenario.components, signal: scenario.signal }),
      ).rejects.toThrow();
      expect(existsSync(outputPath)).toBe(false);
      expect(readdirSync(workDir)).toEqual([]);
      expect(readdirSync(root).filter((entry) => entry.startsWith(basename(outputPath)))).toEqual([]);
    }
  }, 120_000);
});
