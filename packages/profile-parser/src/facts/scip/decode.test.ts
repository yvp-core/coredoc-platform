import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@scip-code/scip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeRange,
  descriptorSuffixAfterFile,
  isDefinition,
  loadScipIndexes,
  packageSymbolKey,
  parseMoniker,
} from './decode.js';

describe('scip decode helpers', () => {
  it('decodeRange handles 3-int and 4-int forms', () => {
    expect(decodeRange([5, 2, 9])).toEqual({ startLine: 5, startChar: 2, endLine: 5, endChar: 9 });
    expect(decodeRange([5, 2, 7, 4])).toEqual({ startLine: 5, startChar: 2, endLine: 7, endChar: 4 });
  });

  it('isDefinition tests the 0x1 bit', () => {
    expect(isDefinition(1)).toBe(true);
    expect(isDefinition(0)).toBe(false);
    expect(isDefinition(8)).toBe(false); // ReadAccess only
    expect(isDefinition(9)).toBe(true); // Definition | ReadAccess
  });

  it('parseMoniker splits scheme/manager/package/version and detects local + external', () => {
    const ext = parseMoniker('scip-typescript npm @nestjs/axios 2.0.0 src/`http.service.d.ts`/HttpService#get().');
    expect(ext).toMatchObject({
      scheme: 'scip-typescript',
      manager: 'npm',
      packageName: '@nestjs/axios',
      version: '2.0.0',
    });
    const local = parseMoniker('local 42');
    expect(local).toEqual({ local: '42' });
  });
});

describe('descriptorSuffixAfterFile', () => {
  it('returns the symbol-descriptor chain after a src file component', () => {
    expect(descriptorSuffixAfterFile('src/`index.ts`/containsSourceCode().')).toBe('containsSourceCode().');
    expect(descriptorSuffixAfterFile('src/lib/`client.ts`/GraphClient#query().')).toBe('GraphClient#query().');
  });

  it('returns the SAME suffix for a published-declaration (dist/.d.ts) reference', () => {
    // The whole point: a cross-package ref resolves through dist/*.d.ts, the def lives in src/*.ts;
    // the file part differs but the suffix is identical, so it is a stable cross-file join key.
    expect(descriptorSuffixAfterFile('dist/`index.d.ts`/containsSourceCode().')).toBe('containsSourceCode().');
    expect(descriptorSuffixAfterFile('dist/lib/`client.d.ts`/GraphClient#query().')).toBe('GraphClient#query().');
  });

  it('handles .mts / .cjs / .jsx file extensions', () => {
    expect(descriptorSuffixAfterFile('src/`m.mts`/f().')).toBe('f().');
    expect(descriptorSuffixAfterFile('dist/`c.cjs`/f().')).toBe('f().');
    expect(descriptorSuffixAfterFile('src/`view.jsx`/Comp#render().')).toBe('Comp#render().');
  });

  it('is undefined when there is no recognizable file component', () => {
    expect(descriptorSuffixAfterFile('')).toBeUndefined();
    expect(descriptorSuffixAfterFile('42')).toBeUndefined();
  });
});

describe('packageSymbolKey', () => {
  it('builds a file-path-independent key: a dist ref and its src def share one key', () => {
    const ref = 'scip-typescript npm @coredoc/db 1.0.0 dist/`index.d.ts`/containsSourceCode().';
    const def = 'scip-typescript npm @coredoc/db 1.0.0 src/`index.ts`/containsSourceCode().';
    expect(packageSymbolKey(ref)).toBe('@coredoc/db containsSourceCode().');
    expect(packageSymbolKey(def)).toBe(packageSymbolKey(ref));
  });

  it('distinguishes different packages and different symbols', () => {
    expect(packageSymbolKey('scip-typescript npm @coredoc/db 1.0.0 dist/`index.d.ts`/foo().')).toBe(
      '@coredoc/db foo().',
    );
    expect(packageSymbolKey('scip-typescript npm @coredoc/mcp 1.0.0 dist/`index.d.ts`/foo().')).toBe(
      '@coredoc/mcp foo().',
    );
  });

  it('is undefined for a local symbol, an empty-package (stdlib) symbol, or a fileless symbol', () => {
    expect(packageSymbolKey('local 5')).toBeUndefined();
    // empty package field (`.`) = TS stdlib → not a workspace package.
    expect(packageSymbolKey('scip-typescript npm . . src/`x.ts`/map().')).toBeUndefined();
  });
});

describe('loadScipIndexes (per-project merge)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-merge-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a one-index `.scip` file whose documents carry a single occurrence each. */
  const writeIndex = (name: string, projectRoot: string, paths: string[]): string => {
    const file = join(dir, `${name}.scip`);
    const index = create(IndexSchema, {
      metadata: { projectRoot },
      documents: paths.map((relativePath) => ({
        relativePath,
        occurrences: [{ symbol: `sym ${name} ${relativePath}`, symbolRoles: 1, range: [0, 0, 1] }],
      })),
    });
    writeFileSync(file, toBinary(IndexSchema, index));
    return file;
  };

  it('concatenates documents from every per-project index', () => {
    const a = writeIndex('a', 'file:///repo', ['apps/www/a.ts', 'apps/www/b.ts']);
    const b = writeIndex('b', 'file:///repo', ['packages/ui/c.ts']);
    const merged = loadScipIndexes([{ scipPath: a }, { scipPath: b }]);
    expect(merged.documents.map((d) => d.relativePath)).toEqual(['apps/www/a.ts', 'apps/www/b.ts', 'packages/ui/c.ts']);
    expect(merged.projectRoot).toBe('file:///repo');
    expect(merged.duplicateDocuments).toBe(0);
  });

  it('dedupes a file claimed by two projects with no owning project, order wins, counted apart', () => {
    // Overlapping tsconfig include: shared.ts lands in both programs. Keeping both would
    // double every occurrence in it. Neither index declares a project, so order decides.
    const a = writeIndex('a', 'file:///repo', ['shared.ts', 'a.ts']);
    const b = writeIndex('b', 'file:///repo', ['shared.ts', 'b.ts']);
    const merged = loadScipIndexes([{ scipPath: a }, { scipPath: b }]);
    expect(merged.documents.map((d) => d.relativePath)).toEqual(['shared.ts', 'a.ts', 'b.ts']);
    expect(merged.duplicateDocuments).toBe(1);
    expect(merged.orderResolvedDuplicates).toBe(1);
    expect(merged.documents[0].occurrences[0].symbol).toBe('sym a shared.ts');
  });

  it('gives a duplicated file to the project whose root is its longest path prefix', () => {
    // The umbrella (root) project is merged FIRST and its program pulls in apps/server's
    // sources through project references — the file still belongs to apps/server.
    const root = writeIndex('root', 'file:///repo', ['apps/server/src/x.ts', 'apps/server/src/y.ts']);
    const server = writeIndex('server', 'file:///repo', ['apps/server/src/x.ts', 'apps/server/src/y.ts']);
    const merged = loadScipIndexes([
      { scipPath: root, project: '.' },
      { scipPath: server, project: 'apps/server' },
    ]);
    expect(merged.documents.map((d) => d.relativePath)).toEqual(['apps/server/src/x.ts', 'apps/server/src/y.ts']);
    expect(merged.documents.map((d) => d.occurrences[0].symbol)).toEqual([
      'sym server apps/server/src/x.ts',
      'sym server apps/server/src/y.ts',
    ]);
    expect(merged).toMatchObject({ duplicateDocuments: 2, orderResolvedDuplicates: 0 });
  });

  it('keeps the owner even when the owning index is merged first', () => {
    const server = writeIndex('server', 'file:///repo', ['apps/server/src/x.ts']);
    const root = writeIndex('root', 'file:///repo', ['apps/server/src/x.ts']);
    const merged = loadScipIndexes([
      { scipPath: server, project: 'apps/server' },
      { scipPath: root, project: '.' },
    ]);
    expect(merged.documents[0].occurrences[0].symbol).toBe('sym server apps/server/src/x.ts');
    expect(merged.orderResolvedDuplicates).toBe(0);
  });

  it('falls back to order when no claiming project contains the file (paths alias)', () => {
    // A `paths` alias pulls a file neither project's dir contains into both programs.
    const a = writeIndex('a', 'file:///repo', ['vendor/shared.ts']);
    const b = writeIndex('b', 'file:///repo', ['vendor/shared.ts']);
    const merged = loadScipIndexes([
      { scipPath: a, project: 'apps/web' },
      { scipPath: b, project: 'apps/server' },
    ]);
    expect(merged.documents[0].occurrences[0].symbol).toBe('sym a vendor/shared.ts');
    expect(merged).toMatchObject({ duplicateDocuments: 1, orderResolvedDuplicates: 1 });
  });

  it('prefers the deepest of three claimants regardless of merge order', () => {
    const root = writeIndex('root', 'file:///repo', ['apps/server/api/x.ts']);
    const deep = writeIndex('deep', 'file:///repo', ['apps/server/api/x.ts']);
    const mid = writeIndex('mid', 'file:///repo', ['apps/server/api/x.ts']);
    const merged = loadScipIndexes([
      { scipPath: root, project: '.' },
      { scipPath: deep, project: 'apps/server/api' },
      { scipPath: mid, project: 'apps/server' },
    ]);
    expect(merged.documents[0].occurrences[0].symbol).toBe('sym deep apps/server/api/x.ts');
    expect(merged).toMatchObject({ duplicateDocuments: 2, orderResolvedDuplicates: 0 });
  });

  it('takes projectRoot from the first index that has one', () => {
    const empty = writeIndex('empty', '', []);
    const real = writeIndex('real', 'file:///repo', ['a.ts']);
    expect(loadScipIndexes([{ scipPath: empty }, { scipPath: real }]).projectRoot).toBe('file:///repo');
  });

  it('is the plain single-index load when given one path', () => {
    const only = writeIndex('only', 'file:///repo', ['a.ts']);
    expect(loadScipIndexes([{ scipPath: only }])).toMatchObject({ projectRoot: 'file:///repo', duplicateDocuments: 0 });
  });

  it('drops an undecodable index and reports it, keeping every other project', () => {
    // Measured on posthog: one project's index decodes forever-badly (a string that is not valid
    // UTF-8). Throwing would trade every healthy project for that one.
    const good = writeIndex('good', 'file:///repo', ['a.ts']);
    const bad = join(dir, 'bad.scip');
    writeFileSync(bad, Buffer.from([0xff, 0xff, 0xff, 0xff]));
    const merged = loadScipIndexes([{ scipPath: good }, { scipPath: bad }]);
    expect(merged.documents.map((d) => d.relativePath)).toEqual(['a.ts']);
    expect(merged.undecodable).toEqual([{ scipPath: bad, error: expect.stringMatching(/corrupt or incomplete/) }]);
  });

  /**
   * A `.scip` that is a perfectly framed protobuf but carries invalid UTF-8 inside one string —
   * the reproducible posthog `nodejs` case. Built by serializing a valid index and overwriting two
   * bytes of a known symbol string in place, so only the string's VALIDITY changes (the field
   * length, and therefore the framing, is untouched).
   */
  const writeInvalidUtf8Index = (name: string, symbol: string): string => {
    const file = join(dir, `${name}.scip`);
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///repo' },
      documents: [
        { relativePath: `${name}.ts`, occurrences: [{ symbol, symbolRoles: 1, range: [1, 2, 3, 4] }] },
        {
          relativePath: `${name}-other.ts`,
          occurrences: [{ symbol: 'clean symbol', symbolRoles: 0, range: [0, 0, 5] }],
        },
      ],
    });
    const bytes = toBinary(IndexSchema, index);
    const at = Buffer.from(bytes).indexOf(Buffer.from(symbol, 'utf8'));
    expect(at).toBeGreaterThanOrEqual(0);
    // 0xFF 0xFE is not a legal UTF-8 sequence anywhere.
    bytes[at + 1] = 0xff;
    bytes[at + 2] = 0xfe;
    writeFileSync(file, bytes);
    return file;
  };

  it('the invalid-UTF-8 fixture really does fail a strict protobuf decode', () => {
    // Pins the premise of the two tests below: without the lenient retry this index is lost.
    const bad = writeInvalidUtf8Index('utf8', 'scip typescript npm nodejs 1.0 `a.ts`/run().');
    expect(() => fromBinary(IndexSchema, readFileSync(bad))).toThrow(/utf-8/i);
  });

  it('decodes an index with invalid UTF-8 leniently and reports it instead of dropping it', () => {
    const good = writeIndex('good', 'file:///repo', ['a.ts']);
    const bad = writeInvalidUtf8Index('utf8', 'scip typescript npm nodejs 1.0 `a.ts`/run().');
    const merged = loadScipIndexes([{ scipPath: good }, { scipPath: bad }]);
    // Kept, not dropped: the project's documents are in the merge and nothing is undecodable.
    expect(merged.undecodable).toEqual([]);
    expect(merged.documents.map((d) => d.relativePath)).toEqual(['a.ts', 'utf8.ts', 'utf8-other.ts']);
    expect(merged.lenientUtf8Indexes).toEqual([{ scipPath: bad, invalidStrings: 1 }]);
    // Everything but the damaged string survives intact.
    expect(merged.projectRoot).toBe('file:///repo');
    expect(merged.documents[1].occurrences[0]).toMatchObject({ symbolRoles: 1, range: [1, 2, 3, 4] });
    expect(merged.documents[2].occurrences[0].symbol).toBe('clean symbol');
    // The damaged bytes became U+FFFD rather than taking the whole index down.
    expect(merged.documents[1].occurrences[0].symbol).toContain('�');
  });

  it('reports lenient UTF-8 decoding on the single-index path too', () => {
    const bad = writeInvalidUtf8Index('utf8', 'scip typescript npm nodejs 1.0 `a.ts`/run().');
    const merged = loadScipIndexes([{ scipPath: bad }]);
    expect(merged.documents).toHaveLength(2);
    expect(merged.lenientUtf8).toEqual({ invalidStrings: 1 });
    expect(merged.lenientUtf8Indexes).toEqual([{ scipPath: bad, invalidStrings: 1 }]);
  });

  it('leaves a clean index unmarked', () => {
    const only = writeIndex('only', 'file:///repo', ['a.ts']);
    expect(loadScipIndexes([{ scipPath: only }]).lenientUtf8).toBeUndefined();
    expect(loadScipIndexes([{ scipPath: only }, { scipPath: only }]).lenientUtf8Indexes).toEqual([]);
  });

  it('still throws for a corrupt SINGLE index — there is nothing to salvage there', () => {
    const bad = join(dir, 'only-bad.scip');
    writeFileSync(bad, Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(() => loadScipIndexes([{ scipPath: bad }])).toThrow(/corrupt or incomplete/);
  });

  it('does not rescue a TRUNCATED index — leniency is only about UTF-8 validity', () => {
    // A half-written index (interrupted scip-typescript run): framing is broken, so the lenient
    // retry fails too and the actionable "re-index" error stands.
    const whole = toBinary(
      IndexSchema,
      create(IndexSchema, {
        metadata: { projectRoot: 'file:///repo' },
        documents: [{ relativePath: 'a.ts', occurrences: [{ symbol: 'scip x y z `a.ts`/run().', range: [0, 0, 1] }] }],
      }),
    );
    const bad = join(dir, 'truncated.scip');
    writeFileSync(bad, whole.slice(0, whole.length - 6));
    expect(() => loadScipIndexes([{ scipPath: bad }])).toThrow(/corrupt or incomplete/);
    const good = writeIndex('good', 'file:///repo', ['b.ts']);
    const merged = loadScipIndexes([{ scipPath: good }, { scipPath: bad }]);
    expect(merged.lenientUtf8Indexes).toEqual([]);
    expect(merged.undecodable).toEqual([{ scipPath: bad, error: expect.stringMatching(/corrupt or incomplete/) }]);
  });
});
