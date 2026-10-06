import { describe, it, expect } from 'vitest';
import { DiffEngine } from './diff-engine.js';
import type { EmbeddingsOutput, ParsedRepo, SummaryOutput } from '@coredoc/core/types';

function makeRepo(overrides: Partial<ParsedRepo> = {}): ParsedRepo {
  return {
    id: 'test-repo',
    name: 'test',
    path: '/test',
    parsedAt: '2026-01-01T00:00:00.000Z',
    parserVersion: '1.0.0',
    parserId: 'test-parser',
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
    stats: { totalFiles: 0, totalFunctions: 0, totalClasses: 0, totalEntrypoints: 0, parseTimeMs: 0 },
    ...overrides,
  } as ParsedRepo;
}

describe('DiffEngine', () => {
  const engine = new DiffEngine();

  it('returns empty changeset when repos are identical', async () => {
    const files = [
      {
        id: 'f1',
        versionedId: 'f1@abc',
        path: 'src/index.ts',
        extension: '.ts',
        packageId: 'pkg',
        language: 'typescript',
        contentHash: 'hash1',
      },
    ];
    const repo = makeRepo({ files: files as any });

    const changeset = await engine.computeChangeset(repo, repo);

    expect(changeset).not.toBeNull();
    expect(changeset!.nodesToAdd).toHaveLength(0);
    expect(changeset!.nodesToUpdate).toHaveLength(0);
    expect(changeset!.nodeIdsToDelete).toHaveLength(0);

    expect(changeset!.stats.filesUnchanged).toBe(1);
  });

  it('detects added files', async () => {
    const oldRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'h1',
        },
      ] as any,
    });
    const newRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'h1',
        },
        {
          id: 'f2',
          versionedId: 'f2@def',
          path: 'src/b.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'h2',
        },
      ] as any,
    });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);

    expect(changeset).not.toBeNull();
    expect(changeset!.stats.filesAdded).toBe(1);
    expect(changeset!.stats.filesUnchanged).toBe(1);
  });

  it('detects deleted files', async () => {
    const oldRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'h1',
        },
        {
          id: 'f2',
          versionedId: 'f2@def',
          path: 'src/b.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'h2',
        },
      ] as any,
    });
    const newRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'h1',
        },
      ] as any,
    });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);

    expect(changeset).not.toBeNull();
    expect(changeset!.stats.filesDeleted).toBe(1);
    expect(changeset!.stats.filesUnchanged).toBe(1);
  });

  it('detects modified files by contentHash change (under threshold)', async () => {
    // Keep multiple files so the statistics exercise both changed and unchanged paths.
    const unchangedFiles = Array.from({ length: 3 }, (_, i) => ({
      id: `unchanged-${i}`,
      versionedId: `unchanged-${i}@v1`,
      path: `src/unchanged-${i}.ts`,
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: `stable-hash-${i}`,
    }));

    const oldRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'old-hash',
        },
        ...unchangedFiles,
      ] as any,
    });
    const newRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@def',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'new-hash',
        },
        ...unchangedFiles,
      ] as any,
    });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);

    expect(changeset).not.toBeNull();
    expect(changeset!.stats.filesModified).toBe(1);
    expect(changeset!.stats.filesUnchanged).toBe(3);
  });

  it('keeps broad same-id edits incremental instead of recommending a destructive full push', async () => {
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const oldRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'old-hash',
        },
      ] as any,
      functions: [
        {
          id: 'fn1',
          versionedId: 'fn1@old',
          name: 'doStuff',
          location: loc,
          parameters: [],
          returnType: { raw: 'void' },
          isExported: true,
          isAsync: false,
        },
      ] as any,
    });
    const newRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@def',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'new-hash',
        },
      ] as any,
      functions: [
        {
          id: 'fn1',
          versionedId: 'fn1@new',
          name: 'doStuff',
          location: loc,
          parameters: [],
          returnType: { raw: 'void' },
          isExported: true,
          isAsync: false,
        },
      ] as any,
    });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);
    expect(changeset.nodesToUpdate.map((node) => node.id)).toContain('fn1');
  });

  it('includes totalNodeCount and totalEdgeCount in changeset', async () => {
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const unchangedFiles = Array.from({ length: 3 }, (_, i) => ({
      id: `unchanged-${i}`,
      versionedId: `unchanged-${i}@v1`,
      path: `src/unchanged-${i}.ts`,
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: `stable-hash-${i}`,
    }));
    const oldRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'old-hash',
        },
        ...unchangedFiles,
      ] as any,
      functions: [
        {
          id: 'fn1',
          versionedId: 'fn1@old',
          name: 'doStuff',
          location: loc,
          parameters: [],
          returnType: { raw: 'void' },
          isExported: true,
          isAsync: false,
        },
      ] as any,
    });
    const newRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@def',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'new-hash',
        },
        ...unchangedFiles,
      ] as any,
      functions: [
        {
          id: 'fn1',
          versionedId: 'fn1@new',
          name: 'doStuff',
          location: loc,
          parameters: [],
          returnType: { raw: 'void' },
          isExported: true,
          isAsync: false,
        },
      ] as any,
    });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);
    expect(changeset).not.toBeNull();
    // Total counts should reflect the full graph (all files, not just changed)
    expect(changeset!.totalNodeCount).toBeGreaterThan(0);
    expect(changeset!.totalEdgeCount).toBeGreaterThanOrEqual(0);
  });

  it('includes totalNodeCount and totalEdgeCount in empty changeset', async () => {
    const files = [
      {
        id: 'f1',
        versionedId: 'f1@abc',
        path: 'src/index.ts',
        extension: '.ts',
        packageId: 'pkg',
        language: 'typescript',
        contentHash: 'hash1',
      },
    ];
    const repo = makeRepo({ files: files as any });

    const changeset = await engine.computeChangeset(repo, repo);
    expect(changeset).not.toBeNull();
    expect(changeset!.totalNodeCount).toBeGreaterThan(0);
    expect(changeset!.totalEdgeCount).toBeGreaterThanOrEqual(0);
  });

  it('catches node-id rotation in unchanged files (engine/profile upgrade) instead of dropping it', async () => {
    // The production bug this guards: profile upgrade changed entrypoint id
    // generation while source files (contentHash) stayed identical. The old
    // file-scoped diff saw "0 files changed" and returned an empty changeset —
    // new-id nodes were never inserted, old-id nodes never deleted.
    const file = {
      id: 'f1',
      versionedId: 'f1@abc',
      path: 'src/a.ts',
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: 'same-hash',
    };
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const stableFns = Array.from({ length: 9 }, (_, i) => ({
      id: `stable-${i}`,
      versionedId: `stable-${i}@v1`,
      name: `stable${i}`,
      location: loc,
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    }));
    const rotated = (id: string) => ({
      id,
      versionedId: `${id}@v1`,
      name: 'handler',
      location: loc,
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    });

    const oldRepo = makeRepo({ files: [file] as any, functions: [rotated('old-id-fn'), ...stableFns] as any });
    const newRepo = makeRepo({ files: [file] as any, functions: [rotated('new-id-fn'), ...stableFns] as any });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);

    expect(changeset).not.toBeNull();
    expect(changeset!.stats.filesUnchanged).toBe(1);
    expect(changeset!.nodesToAdd.map((n) => n.id)).toContain('new-id-fn');
    expect(changeset!.nodeIdsToDelete).toContain('old-id-fn');
    // Both generations get their edges rewired
    expect(changeset!.edgeNodeIdsToWipe).toContain('old-id-fn');
    expect(changeset!.edgeNodeIdsToWipe).toContain('new-id-fn');
    // Untouched nodes stay untouched
    expect(changeset!.nodeIdsToDelete).not.toContain('stable-0');
    expect(changeset!.nodesToUpdate.map((n) => n.id)).not.toContain('stable-0');
  });

  it('rejects a degenerate parse that extracted no code instead of deleting the graph', async () => {
    // The failure both thresholds miss: files parse fine (identical
    // contentHash, so changedFilePaths is empty) but the profile/engine
    // extracted nothing. Before the guard this returned an incremental
    // changeset whose nodeIdsToDelete was every code node in the repo.
    const file = {
      id: 'f1',
      versionedId: 'f1@abc',
      path: 'src/a.ts',
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: 'same-hash',
    };
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const fns = Array.from({ length: 5 }, (_, i) => ({
      id: `fn-${i}`,
      versionedId: `fn-${i}@v1`,
      name: `fn${i}`,
      location: loc,
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    }));

    await expect(
      engine.computeChangeset(
        makeRepo({ files: [file] as any, functions: fns as any }),
        makeRepo({ files: [file] as any, functions: [] as any }),
      ),
    ).rejects.toThrow(/would delete 5\/5 previous code nodes/);
  });

  it('still rejects a degenerate parse that carries the root package node', async () => {
    // The parser registers a root package unconditionally, so a broken parse is
    // never literally node-free — the realistic shape is files + one package and
    // no code. A guard that counts packages as code would let this through.
    const file = {
      id: 'f1',
      versionedId: 'f1@abc',
      path: 'src/a.ts',
      extension: '.ts',
      packageId: 'pkg-root',
      language: 'typescript',
      contentHash: 'same-hash',
    };
    const rootPackage = { id: 'pkg-root', name: 'root', path: '.' };
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const fns = Array.from({ length: 5 }, (_, i) => ({
      id: `fn-${i}`,
      versionedId: `fn-${i}@v1`,
      name: `fn${i}`,
      location: loc,
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    }));

    await expect(
      engine.computeChangeset(
        makeRepo({ packages: [rootPackage] as any, files: [file] as any, functions: fns as any }),
        makeRepo({ packages: [rootPackage] as any, files: [file] as any, functions: [] as any }),
      ),
    ).rejects.toThrow(/would delete 5\/5 previous code nodes/);
  });

  it('rejects a collapse to one code node using the old graph as the deletion baseline', async () => {
    const file = {
      id: 'f1',
      versionedId: 'f1@abc',
      path: 'src/a.ts',
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: 'same-hash',
    };
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const fns = Array.from({ length: 5 }, (_, i) => ({
      id: `fn-${i}`,
      versionedId: `fn-${i}@v1`,
      name: `fn${i}`,
      location: loc,
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    }));

    await expect(
      engine.computeChangeset(
        makeRepo({ files: [file] as any, functions: fns as any }),
        makeRepo({ files: [file] as any, functions: [fns[0]] as any }),
      ),
    ).rejects.toThrow(/would delete 4\/5 previous code nodes/);
  });

  it('allows a genuinely empty repo to stay empty (no previous code nodes)', async () => {
    const file = {
      id: 'f1',
      versionedId: 'f1@abc',
      path: 'README.md',
      extension: '.md',
      packageId: 'pkg',
      language: 'markdown',
      contentHash: 'h1',
    };
    const changeset = await engine.computeChangeset(
      makeRepo({ files: [file] as any }),
      makeRepo({ files: [file] as any }),
    );
    expect(changeset).not.toBeNull();
    expect(changeset!.nodeIdsToDelete).toHaveLength(0);
  });

  it('does not escalate to full push when only file nodes are deleted', async () => {
    // The churn ratio must compare code nodes to code nodes: counting deleted
    // file nodes against a code-node total can exceed 1.0 and turn an ordinary
    // file removal into a full repository rewrite.
    const loc = { filePath: 'src/keep.ts', startLine: 1, endLine: 10 };
    const keptFn = {
      id: 'fn-keep',
      versionedId: 'fn-keep@v1',
      name: 'keep',
      location: loc,
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    };
    const mkFile = (n: string, hash: string) => ({
      id: `f-${n}`,
      versionedId: `f-${n}@v1`,
      path: `src/${n}.ts`,
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: hash,
    });
    const keep = mkFile('keep', 'h-keep');
    const empties = Array.from({ length: 4 }, (_, i) => mkFile(`empty${i}`, `h-empty${i}`));

    const changeset = await engine.computeChangeset(
      makeRepo({ files: [keep, ...empties] as any, functions: [keptFn] as any }),
      makeRepo({ files: [keep] as any, functions: [keptFn] as any }),
    );

    expect(changeset).not.toBeNull();
    expect(changeset!.nodeIdsToDelete).toEqual(expect.arrayContaining(['f-empty0']));
    expect(changeset!.nodeIdsToDelete).not.toContain('fn-keep');
  });

  it('requires an explicit rebuild for massive id rotation', async () => {
    const file = {
      id: 'f1',
      versionedId: 'f1@abc',
      path: 'src/a.ts',
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: 'same-hash',
    };
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const fns = (prefix: string) =>
      Array.from({ length: 5 }, (_, i) => ({
        id: `${prefix}-${i}`,
        versionedId: `${prefix}-${i}@v1`,
        name: `fn${i}`,
        location: loc,
        parameters: [],
        returnType: { raw: 'void' },
        isExported: true,
        isAsync: false,
      }));

    const oldRepo = makeRepo({ files: [file] as any, functions: fns('old') as any });
    const newRepo = makeRepo({ files: [file] as any, functions: fns('new') as any });

    await expect(
      engine.computeChangeset(
        oldRepo,
        newRepo,
        null,
        null,
        'coredoc push test --remote --workspace-id ws_exact --rebuild',
      ),
    ).rejects.toThrow(
      /would delete 5\/5 previous code nodes.*coredoc push test --remote --workspace-id ws_exact --rebuild/,
    );
  });

  it('refreshes edges when extraction changes but files and nodes stay identical', async () => {
    const file = {
      id: 'f1',
      versionedId: 'f1@abc',
      path: 'src/a.ts',
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: 'same-hash',
    };
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const functions = ['caller', 'old-target', 'new-target'].map((id) => ({
      id,
      versionedId: `${id}@v1`,
      name: id,
      location: loc,
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    }));
    const oldCall = {
      id: 'call-old',
      callerId: 'caller',
      calleeId: 'old-target',
      calleeExpression: 'oldTarget()',
      isAsync: false,
      location: loc,
    };
    const newCall = {
      id: 'call-new',
      callerId: 'caller',
      calleeId: 'new-target',
      calleeExpression: 'newTarget()',
      isAsync: false,
      location: loc,
    };

    const changeset = await engine.computeChangeset(
      makeRepo({ files: [file] as any, functions: functions as any, calls: [oldCall] as any }),
      makeRepo({ files: [file] as any, functions: functions as any, calls: [newCall] as any }),
    );

    expect(changeset.nodesToAdd).toEqual([]);
    expect(changeset.nodesToUpdate).toEqual([]);
    expect(changeset.nodeIdsToDelete).toEqual([]);
    expect(changeset.edgeNodeIdsToWipe).toEqual(expect.arrayContaining(['f1', 'caller', 'old-target', 'new-target']));
    expect(changeset.edgeTypesToPreserve).toEqual(['RESOLVES_TO']);
    expect(changeset.edgesToInsert.map((edge) => edge.id)).toContain('call-new');
    expect(changeset.edgesToInsert.map((edge) => edge.id)).not.toContain('call-old');
  });

  it('rejects a material edge-family collapse even when every node remains stable', async () => {
    const file = {
      id: 'f1',
      versionedId: 'f1@abc',
      path: 'src/a.ts',
      extension: '.ts',
      packageId: 'pkg',
      language: 'typescript',
      contentHash: 'same-hash',
    };
    const loc = { filePath: 'src/a.ts', startLine: 1, endLine: 10 };
    const functions = ['caller', ...Array.from({ length: 5 }, (_, index) => `target-${index}`)].map((id) => ({
      id,
      versionedId: `${id}@v1`,
      name: id,
      location: loc,
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    }));
    const calls = functions.slice(1).map((target, index) => ({
      id: `call-${index}`,
      callerId: 'caller',
      calleeId: target.id,
      calleeExpression: `${target.name}()`,
      isAsync: false,
      location: loc,
    }));

    await expect(
      engine.computeChangeset(
        makeRepo({ files: [file] as any, functions: functions as any, calls: calls as any }),
        makeRepo({ files: [file] as any, functions: functions as any, calls: [] }),
      ),
    ).rejects.toThrow(/reduce CALLS edges from 5 to 0.*--rebuild/);
  });

  it('updates the repository node when repository metadata changes', async () => {
    const oldRepo = makeRepo({
      parsedAt: '2026-04-01T00:00:00.000Z',
      parserVersion: '1.0.0',
    });
    const newRepo = makeRepo({
      parsedAt: '2026-04-02T00:00:00.000Z',
      parserVersion: '2.0.0',
    });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);

    expect(changeset.nodesToUpdate).toContainEqual(
      expect.objectContaining({
        id: 'test-repo',
        type: 'repository',
        properties: expect.objectContaining({
          parsedAt: '2026-04-02T00:00:00.000Z',
          parserVersion: '2.0.0',
        }),
      }),
    );
    expect(changeset.edgeNodeIdsToWipe).toContain('test-repo');
  });

  it('updates package and route nodes when metadata changes without a versionedId', async () => {
    const parsedAt = '2026-04-01T00:00:00.000Z';
    const oldRepo = makeRepo({
      parsedAt,
      packages: [{ id: 'pkg', name: 'web', path: '.', version: '1.0.0', description: 'Old package' }] as any,
      routes: [
        {
          id: 'route',
          path: '/users',
          componentName: 'UsersPage',
          guards: ['authenticated'],
          meta: { layout: 'default' },
          isLazy: false,
        },
      ],
    });
    const newRepo = makeRepo({
      parsedAt,
      packages: [{ id: 'pkg', name: 'web', path: '.', version: '2.0.0', description: 'New package' }] as any,
      routes: [
        {
          id: 'route',
          path: '/users',
          componentName: 'UsersPage',
          guards: ['authenticated', 'admin'],
          meta: { layout: 'admin' },
          isLazy: true,
        },
      ],
    });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);

    expect(changeset.nodesToUpdate.map((node) => node.id)).toEqual(expect.arrayContaining(['pkg', 'route']));
    expect(changeset.nodesToUpdate.find((node) => node.id === 'pkg')?.properties).toMatchObject({
      version: '2.0.0',
      description: 'New package',
    });
    expect(changeset.nodesToUpdate.find((node) => node.id === 'route')?.properties).toMatchObject({
      guards: ['authenticated', 'admin'],
      meta: { layout: 'admin' },
      isLazy: true,
    });
  });

  it('does not classify the current summary and embedding snapshot as a structural node change', async () => {
    const parsedAt = '2026-04-01T00:00:00.000Z';
    const fn = {
      id: 'fn1',
      versionedId: 'fn1@same',
      name: 'doStuff',
      location: { filePath: 'src/a.ts', startLine: 1, endLine: 10 },
      parameters: [],
      returnType: { raw: 'void' },
      isExported: true,
      isAsync: false,
    } as ParsedRepo['functions'][number];
    const repo = makeRepo({ parsedAt, functions: [fn] });
    const summaryOutput = {
      repoId: 'test-repo',
      repoName: 'test',
      generatedAt: parsedAt,
      summarizerVersion: '1.0.0',
      summaries: [
        {
          functionId: 'fn1',
          versionedId: 'fn1@same',
          detailed_summary: 'Summary',
          purpose: 'Do work',
          business_logic: [],
          side_effects: [],
          data_handling: '',
          confidence_level: 'high',
          unknowns: [],
          generatedAt: parsedAt,
        },
      ],
      repositorySummary: {
        overview: 'Repository overview',
        dataModel: 'Data model',
        externalIntegrations: [],
        generatedAt: parsedAt,
      },
      stats: {
        totalFunctions: 1,
        summarized: 1,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 1,
      },
    } as SummaryOutput;
    const embeddingsOutput = {
      repoId: 'test-repo',
      repoName: 'test',
      generatedAt: parsedAt,
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 2,
      inputStrategy: 'summary',
      functions: [
        {
          functionId: 'fn1',
          versionedId: 'fn1@same',
          name: 'doStuff',
          filePath: 'src/a.ts',
          inputChecksum: 'checksum-1',
          embedding: [0.1, 0.2],
          generatedAt: parsedAt,
        },
      ],
      endpoints: [],
      stats: {},
    } as EmbeddingsOutput;

    const changeset = await engine.computeChangeset(repo, repo, summaryOutput, embeddingsOutput);

    expect(changeset.nodesToUpdate).toEqual([]);
  });

  it('returns incremental changeset for cosmetic-only changes even at 100% files touched', async () => {
    // Formatter changed whitespace in every file → contentHash differs, but
    // function versionedIds are identical → no real node changes
    const oldRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'old-hash',
        },
      ] as any,
      functions: [
        {
          id: 'fn1',
          versionedId: 'fn1@same',
          name: 'doStuff',
          location: { filePath: 'src/a.ts', startLine: 1, endLine: 10 },
          parameters: [],
          returnType: { raw: 'void' },
          isExported: true,
          isAsync: false,
        },
      ] as any,
    });
    const newRepo = makeRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@def',
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'pkg',
          language: 'typescript',
          contentHash: 'new-hash', // file hash changed (whitespace)
        },
      ] as any,
      functions: [
        {
          id: 'fn1',
          versionedId: 'fn1@same', // same versionedId → no real change
          name: 'doStuff',
          location: { filePath: 'src/a.ts', startLine: 1, endLine: 10 },
          parameters: [],
          returnType: { raw: 'void' },
          isExported: true,
          isAsync: false,
        },
      ] as any,
    });

    const changeset = await engine.computeChangeset(oldRepo, newRepo);
    // Should NOT return null — no real code changes, incremental is fine
    expect(changeset).not.toBeNull();
    expect(changeset!.nodesToAdd).toHaveLength(0);
    // File node itself is updated (contentHash changed), but no code-element changes
    const codeNodeUpdates = changeset!.nodesToUpdate.filter((n) => n.type !== 'file');
    expect(codeNodeUpdates).toHaveLength(0);
    expect(changeset!.nodeIdsToDelete).toHaveLength(0);
  });

  it('includes current summaries and embeddings in nodes rewritten by the atomic changeset', async () => {
    const makeFunction = (versionedId: string) =>
      ({
        id: 'fn1',
        versionedId,
        name: 'doStuff',
        location: { filePath: 'src/a.ts', startLine: 1, endLine: 10 },
        parameters: [],
        returnType: { raw: 'void' },
        isExported: true,
        isAsync: false,
      }) as ParsedRepo['functions'][number];
    const oldRepo = makeRepo({ functions: [makeFunction('fn1@old')] });
    const newRepo = makeRepo({ functions: [makeFunction('fn1@new')] });
    const summaryOutput = {
      repoId: 'test-repo',
      repoName: 'test',
      generatedAt: '2026-04-02T00:00:00.000Z',
      summarizerVersion: '1.0.0',
      summaries: [
        {
          functionId: 'fn1',
          versionedId: 'fn1@new',
          detailed_summary: 'Preserved summary',
          purpose: 'Do work',
          business_logic: [],
          side_effects: [],
          data_handling: '',
          confidence_level: 'high',
          unknowns: [],
          generatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
      stats: {
        totalFunctions: 1,
        summarized: 1,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 1,
      },
    } as SummaryOutput;
    const embeddingsOutput = {
      repoId: 'test-repo',
      repoName: 'test',
      generatedAt: '2026-04-02T00:00:00.000Z',
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 2,
      inputStrategy: 'summary',
      functions: [
        {
          functionId: 'fn1',
          versionedId: 'fn1@new',
          name: 'doStuff',
          filePath: 'src/a.ts',
          inputChecksum: 'checksum-1',
          embedding: [0.1, 0.2],
          generatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
      endpoints: [],
      stats: {},
    } as EmbeddingsOutput;

    const changeset = await engine.computeChangeset(oldRepo, newRepo, summaryOutput, embeddingsOutput);
    const updatedFunction = changeset.nodesToUpdate.find((node) => node.id === 'fn1');

    expect(updatedFunction).toMatchObject({
      summary: 'Preserved summary',
      embedding: [0.1, 0.2],
      properties: {
        purpose: 'Do work',
        embeddingChecksum: 'checksum-1',
        embeddingModel: 'nomic-embed-text',
      },
    });
  });
});
