/**
 * G1 — the python target must emit the File/Package/Class/Import nodes the rest of its own graph
 * already references. The point of these tests is the JOIN: a fileId/classId that only "looks
 * right" is what shipped before, so every assertion recomputes the reference from the emitted
 * node set rather than from a literal.
 */
import { pythonProvider } from '../../providers/python.js';
import type { ParsedRepo } from '@coredoc/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PythonProfile } from '../../types.js';

const FILES: Record<string, string> = {
  'pyproject.toml': '[project]\nname = "demo"\n',
  'svc/pyproject.toml': '[project]\nname = "svc"\n',
  'app/__init__.py': '',
  'app/models.py': `from django.db import models


class Base(models.Model):
    pass


class Widget(Base, models.Model):
    name = models.CharField(max_length=50)

    class Meta:
        abstract = False
`,
  'app/service.py': `from app.models import Widget
from app import helpers as h
import json


class Svc:
    def run(self, count: int, label: str = "x") -> dict:
        return self.helper(count)

    def helper(self, count: int):
        def inner():
            return count

        return inner()
`,
  'app/helpers.py': `def shout(text: str) -> str:
    return text.upper()
`,
  'svc/worker.py': `def work():
    return 1
`,
  'app/stubs.pyi': `def declared(a: int) -> str: ...
`,
};

const PROFILE: PythonProfile = {
  parserId: 'struct',
  repoType: 'backend',
  substrate: { language: 'python', include: ['**/*.py', '**/*.pyi'] },
};

describe('python substrate — structure nodes (G1)', () => {
  let root: string;
  let repo: ParsedRepo;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'py-structure-'));
    for (const [rel, src] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, src);
    }
    repo = await pythonProvider.parse(PROFILE, { repoRoot: root, repoName: 'struct' });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('emits one FileNode per parsed file, matching stats.parsedFiles', () => {
    expect(repo.files.length).toBe(repo.stats.parsedFiles);
    expect(repo.files.map((f) => f.path).sort()).toEqual([
      'app/__init__.py',
      'app/helpers.py',
      'app/models.py',
      'app/service.py',
      'app/stubs.pyi',
      'svc/worker.py',
    ]);
    const stub = repo.files.find((f) => f.path === 'app/stubs.pyi')!;
    expect(stub.extension).toBe('.pyi');
    expect(stub.language).toBe('python');
    expect(stub.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every function fileId resolves to an emitted FileNode (zero dangling)', () => {
    const fileIds = new Set(repo.files.map((f) => f.id));
    expect(repo.functions.filter((fn) => !fileIds.has(fn.fileId)).map((fn) => fn.name)).toEqual([]);
    expect(repo.functions.length).toBeGreaterThan(0);
  });

  it('every entity fileId resolves to an emitted FileNode', () => {
    const fileIds = new Set(repo.files.map((f) => f.id));
    expect(repo.entities.filter((e) => !fileIds.has(e.fileId)).map((e) => e.name)).toEqual([]);
  });

  it('every method classId resolves to an emitted ClassNode (zero phantom classes)', () => {
    const classIds = new Set(repo.classes.map((c) => c.id));
    const dangling = repo.functions.filter((fn) => fn.classId !== undefined && !classIds.has(fn.classId));
    expect(dangling.map((fn) => `${fn.location.filePath}:${fn.name}`)).toEqual([]);
    expect(repo.functions.some((fn) => fn.classId !== undefined)).toBe(true);
  });

  it('every FileNode packageId resolves to an emitted Package', () => {
    const pkgIds = new Set(repo.packages.map((p) => p.id));
    expect(repo.files.filter((f) => !pkgIds.has(f.packageId))).toEqual([]);
  });

  it('assigns files to the nearest distribution root, root "." as fallback', () => {
    const pkgById = new Map(repo.packages.map((p) => [p.id, p]));
    const pathOf = (rel: string): string => pkgById.get(repo.files.find((f) => f.path === rel)!.packageId)!.path;
    expect(pathOf('svc/worker.py')).toBe('svc');
    expect(pathOf('app/models.py')).toBe('.');
    expect(repo.packages.find((p) => p.path === 'svc')?.manifestFile).toBe('svc/pyproject.toml');
    expect(repo.packages.find((p) => p.path === 'svc')?.language).toBe('python');
    expect(repo.packages.find((p) => p.path === '.')?.manifestFile).toBe('pyproject.toml');
    // The shared fallback root is left unlabelled — the multi-target merge decides its language
    // from the dominant language of the files that end up under it.
    expect(repo.packages.find((p) => p.path === '.')?.language).toBeUndefined();
  });

  it('emits a ClassNode carrying base classes verbatim and its DIRECT methods', () => {
    const widget = repo.classes.find((c) => c.name === 'Widget')!;
    // `class Widget(Base, models.Model)` — every base is kept, spelled as written.
    expect([widget.extends?.name, ...(widget.implements ?? []).map((i) => i.name)]).toEqual(['Base', 'models.Model']);

    const svc = repo.classes.find((c) => c.name === 'Svc')!;
    const fnById = new Map(repo.functions.map((f) => [f.id, f]));
    expect(svc.methods.map((id) => fnById.get(id)?.name).sort()).toEqual(['helper', 'run']);
    // `inner` is a closure inside a method, not a method of the class.
    expect(svc.methods.map((id) => fnById.get(id)?.name)).not.toContain('inner');
    expect(svc.location.filePath).toBe('app/service.py');
  });

  it('emits one ImportEdge per (file, module) with names, type-only flag and resolved target', () => {
    const svcFileId = repo.files.find((f) => f.path === 'app/service.py')!.id;
    const edges = repo.imports.filter((e) => e.sourceFileId === svcFileId);
    expect(edges.map((e) => e.moduleSpecifier).sort()).toEqual(['app', 'app.models', 'json']);

    const models = edges.find((e) => e.moduleSpecifier === 'app.models')!;
    expect(models.importKind).toBe('named');
    expect(models.importedNames).toEqual([{ name: 'Widget' }]);
    expect(models.targetFileId).toBe(repo.files.find((f) => f.path === 'app/models.py')!.id);
    expect(models.isTypeOnly).toBe(false);

    // `from app import helpers as h` — the alias is recorded, the symbol is the real name.
    const app = edges.find((e) => e.moduleSpecifier === 'app')!;
    expect(app.importedNames).toEqual([{ name: 'helpers', alias: 'h' }]);

    // An external module resolves to no file rather than to a fabricated one.
    expect(edges.find((e) => e.moduleSpecifier === 'json')?.targetFileId).toBeUndefined();
    // stats agree with what was emitted.
    expect(repo.stats.totalImports).toBe(repo.imports.length);
  });

  it('records annotation TEXT on return types and parameters', () => {
    const run = repo.functions.find((f) => f.name === 'run' && f.location.filePath === 'app/service.py')!;
    expect(run.returnType?.text).toBe('dict');
    expect(run.parameters.map((p) => [p.name, p.type?.text])).toEqual([
      ['self', undefined],
      ['count', 'int'],
      ['label', 'str'],
    ]);
    // An unannotated def carries no returnType at all (never an empty string).
    const helper = repo.functions.find((f) => f.name === 'helper')!;
    expect(helper.returnType).toBeUndefined();
  });

  it('parses .pyi stubs as real defs', () => {
    const declared = repo.functions.find((f) => f.name === 'declared');
    expect(declared?.location.filePath).toBe('app/stubs.pyi');
    expect(declared?.returnType?.text).toBe('str');
  });

  it('reports honest stats and no extracted variables', () => {
    expect(repo.stats.totalClasses).toBe(repo.classes.length);
    // Variables are NOT extracted by any python lane — the empty array is the honest report.
    expect(repo.variables).toEqual([]);
    // BR-4: the db-op resolution record reaches `ParseStats`.
    const db = repo.stats.dbOpResolution;
    if (!db) throw new Error('expected stats.dbOpResolution');
    expect(db.boundDbOps + db.outOfScopeDbOps).toBeLessThanOrEqual(db.dbOpSites);
  });
});
