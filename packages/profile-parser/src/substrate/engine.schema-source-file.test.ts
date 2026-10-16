/**
 * Schema-source file nodes.
 *
 * A prisma entity rule attributes every model to `schema.prisma`, a file the TS/JS substrate
 * never sees — so `entities[].fileId` used to name a file node that did not exist (44 dangling
 * refs on coredoc-parser's own parse). The engine must emit a file node for any non-substrate
 * source file a rule attributes nodes to.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../facts/graph/graph-builder.js';
import type { BaselineResult } from '../facts/pipeline.js';
import { checkReferentialIntegrity } from '../integrity/referential-integrity.js';
import type { ExtractionProfile } from '../types.js';
import { SubstrateProfileEngine } from './engine.js';
import type { Substrate } from './interface.js';

const SCHEMA = 'apps/server/prisma/schema.prisma';
const SCHEMA_SOURCE = `
model Workspace {
  id    String @id
  name  String
  repos Repo[]
}

model Repo {
  id          String    @id
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  workspaceId String
}
`;

const profile = {
  name: 'fake',
  include: ['**/*.ts'],
  exclude: [],
  di: { style: 'constructor-type', stripGenerics: true },
  entities: [{ orm: 'prisma', schemaPath: SCHEMA }],
} as unknown as ExtractionProfile;

function fakeSubstrate(idGen: StableIdGenerator): Substrate {
  return {
    files: () => [{ relativePath: 'apps/server/src/app.ts' }],
    classes: () => [],
    functions: () => [],
    callShapes: () => [],
    resolveConst: () => undefined,
    resolveConstMember: () => undefined,
    requireRegistry: () => new Map(),
    internalCalls: () => [],
    externalCalls: () => [],
    hasFunctionId: () => true,
    resolveMethodOnClass: () => undefined,
    functionId: () => undefined,
    componentSites: () => [],
    resolveJsxTagBySCIP: () => undefined,
    resolveJsxTagByImport: () => undefined,
    routeSites: () => [],
    stateStoreSites: () => [],
    idGen,
  } as unknown as Substrate;
}

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Run the engine over a repo that has (or has not) a schema at SCHEMA. */
function run(opts: { schema?: string; packages?: string[] } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'schema-file-'));
  if (opts.schema !== undefined) {
    mkdirSync(join(dir, dirname(SCHEMA)), { recursive: true });
    writeFileSync(join(dir, SCHEMA), opts.schema);
  }
  const idGen = new StableIdGenerator(dir, 'k');
  const graph = new CodeGraph();
  const packages = opts.packages ?? ['.'];
  for (const path of packages) {
    graph.addPackage({ id: idGen.packageId(path), name: path, path });
  }
  // The one substrate file, owned by the deepest package that contains it — the baseline
  // pipeline always emits this, and scopeGraph keeps a package only while a file names it.
  const owner = packages.includes('apps/server') ? 'apps/server' : '.';
  graph.addFile({
    id: idGen.fileId('apps/server/src/app.ts'),
    versionedId: idGen.versionedFileId('apps/server/src/app.ts', 'h'),
    path: 'apps/server/src/app.ts',
    extension: '.ts',
    packageId: idGen.packageId(owner),
    language: 'typescript',
    contentHash: 'h',
  });
  const engine = new SubstrateProfileEngine(profile, fakeSubstrate(idGen));
  const baseline = {
    graph,
    idGen,
    errors: [],
    plan: {
      vueFiles: [],
      languages: { typescript: { fileCount: 0, files: [] }, javascript: { fileCount: 0, files: [] } },
    },
  } as unknown as BaselineResult;
  return { repo: engine.run(baseline, { repoRoot: dir, repoName: 'fake' }), idGen };
}

describe('schema-source file nodes', () => {
  it('emits a file node for the prisma schema so entities.fileId resolves', () => {
    const { repo, idGen } = run({ schema: SCHEMA_SOURCE });
    expect(repo.entities.map((e) => e.name).sort()).toEqual(['Repo', 'Workspace']);
    const file = repo.files.find((f) => f.path === SCHEMA);
    expect(file).toBeDefined();
    expect(file?.id).toBe(idGen.fileId(SCHEMA));
    expect(repo.entities.every((e) => e.fileId === file?.id)).toBe(true);
    // Marked as a schema source, and it owns no parsed symbols.
    expect(file).toMatchObject({ language: 'prisma', extension: '.prisma' });
    expect(repo.functions.filter((f) => f.fileId === file?.id)).toEqual([]);
    expect(repo.classes.filter((c) => c.fileId === file?.id)).toEqual([]);
  });

  it('leaves the parse referentially intact — 0 dangling refs, honest stats', () => {
    const { repo } = run({ schema: SCHEMA_SOURCE });
    const report = checkReferentialIntegrity(repo);
    expect(report.danglingRefs).toBe(0);
    expect(report.byCollection).toEqual({});
    expect(repo.stats.parsedFiles).toBe(repo.files.length);
  });

  it('attributes the schema file to the workspace package containing it, not the root', () => {
    const { repo, idGen } = run({ schema: SCHEMA_SOURCE, packages: ['.', 'apps/server', 'apps/web'] });
    const file = repo.files.find((f) => f.path === SCHEMA);
    expect(file?.packageId).toBe(idGen.packageId('apps/server'));
  });

  it('emits nothing when the schema path names no readable schema (no phantom file node)', () => {
    const { repo } = run({});
    expect(repo.entities).toEqual([]);
    expect(repo.files.some((f) => f.path === SCHEMA)).toBe(false);
  });
});
