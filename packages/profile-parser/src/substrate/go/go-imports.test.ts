import { describe, expect, it } from 'vitest';
import { type GoFile } from './go-cst.js';
import {
  buildImportTable,
  buildPackageIndex,
  defaultLocalName,
  isInternalImportPath,
  resolveImportPath,
  resolveQualifier,
} from './go-imports.js';
import type { GoModule } from './go-modules.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

/** Build a GoFile (relPath + source + parsed root) the way the parser does. */
async function gf(relPath: string, source: string): Promise<GoFile> {
  return { relPath, source, root: await parseSource('go', source) };
}

/** A module descriptor the way `discoverGoModules` would emit it. */
function mod(modulePath: string, path = '.', isWorkspace = false): GoModule {
  return { modulePath, path, dependencies: new Set(), isWorkspace };
}

describe('defaultLocalName — the /vN trap', () => {
  it('drops a major-version segment and the gopkg.in .vN spelling', () => {
    // `github.com/go-chi/chi/v5` is imported as `chi`, never as `v5`.
    expect(defaultLocalName('github.com/go-chi/chi/v5')).toBe('chi');
    expect(defaultLocalName('gopkg.in/yaml.v3')).toBe('yaml');
    expect(defaultLocalName('net/http')).toBe('http');
    expect(defaultLocalName('fmt')).toBe('fmt');
    // A lone version segment has nothing before it — do not invent a name.
    expect(defaultLocalName('v5')).toBe('v5');
  });
});

describe('buildImportTable', () => {
  it('binds both import forms, honors aliases, counts blanks and records dot imports', async () => {
    const file = await gf(
      'internal/api/router.go',
      `package api

import "fmt"

import (
	"net/http"
	chi "github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	pg "github.com/jackc/pgx/v5"
	_ "github.com/lib/pq"
	. "math"
)
`,
    );
    const table = buildImportTable(file);
    // The single-import form has NO import_spec_list — a walk that looked for the list would see
    // no imports at all in every file that imports exactly one package.
    expect(table.byLocal.get('fmt')).toBe('fmt');
    expect(table.byLocal.get('http')).toBe('net/http');
    expect(table.byLocal.get('chi')).toBe('github.com/go-chi/chi/v5');
    expect(table.byLocal.get('middleware')).toBe('github.com/go-chi/chi/v5/middleware');
    expect(table.byLocal.get('pg')).toBe('github.com/jackc/pgx/v5');
    // `_` and `.` bind no name — binding them under the literal text would create a package
    // called '_' that every unresolved selector could latch onto.
    expect(table.byLocal.has('_')).toBe(false);
    expect(table.byLocal.has('.')).toBe(false);
    expect(table.blankCount).toBe(1);
    expect(table.dotImports).toEqual(['math']);
    expect(resolveImportPath(table, 'chi')).toBe('github.com/go-chi/chi/v5');
    expect(resolveImportPath(table, 'nope')).toBeUndefined();
  });

  it('returns the SAME table object for a file, so every lane shares one CST walk', async () => {
    const file = await gf('a.go', 'package p\n\nimport "fmt"\n');
    const first = buildImportTable(file);
    expect(buildImportTable(file)).toBe(first);
    // A re-parse is a different GoFile — it must not read the previous file's table.
    const reparsed = await gf('a.go', 'package p\n\nimport "net/http"\n');
    const second = buildImportTable(reparsed);
    expect(second).not.toBe(first);
    expect([...second.byLocal.keys()]).toEqual(['http']);
  });
});

describe('buildPackageIndex', () => {
  it('maps import paths to directories by joining each dir to its owning module', async () => {
    const files = [
      await gf('main.go', 'package main\n'),
      await gf('internal/db/store.go', 'package db\n'),
      await gf('internal/db/query.go', 'package db\n'),
      await gf('services/worker/main.go', 'package main\n'),
    ];
    const modules = [mod('github.com/acme/api', '.'), mod('github.com/acme/worker', 'services/worker')];
    const index = buildPackageIndex(files, modules);

    expect(index.byImportPath.get('github.com/acme/api')).toBe('');
    expect(index.byImportPath.get('github.com/acme/api/internal/db')).toBe('internal/db');
    // The nested module owns its own subtree — longest prefix wins, so this is NOT
    // `github.com/acme/api/services/worker`.
    expect(index.byImportPath.get('github.com/acme/worker')).toBe('services/worker');
    expect(index.importPathByDir.get('internal/db')).toBe('github.com/acme/api/internal/db');
    expect(index.filesByDir.get('internal/db')).toEqual(['internal/db/query.go', 'internal/db/store.go']);
    expect(index.packageNameByDir.get('internal/db')).toBe('db');
  });

  it('skips a go.work entry — a workspace has no module path to prefix with', async () => {
    const files = [await gf('tools/gen.go', 'package tools\n')];
    const index = buildPackageIndex(files, [mod('root', '.', true)]);
    // The directory is still indexed for its files and package name...
    expect(index.filesByDir.get('tools')).toEqual(['tools/gen.go']);
    expect(index.packageNameByDir.get('tools')).toBe('tools');
    // ...but it gets NO import path, because `root/tools` is a name no import can ever match.
    expect(index.importPathByDir.has('tools')).toBe(false);
    expect(index.byImportPath.size).toBe(0);
  });

  it('gives no import path to a directory under no module at all', async () => {
    const files = [await gf('scripts/gen.go', 'package scripts\n')];
    const index = buildPackageIndex(files, [mod('github.com/acme/api', 'services/api')]);
    expect(index.importPathByDir.has('scripts')).toBe(false);
  });
});

describe('isInternalImportPath', () => {
  const modules = [mod('github.com/acme/api', '.'), mod('root', 'ws', true)];

  it('separates this repo’s own packages from third-party and stdlib', () => {
    expect(isInternalImportPath('github.com/acme/api', modules)).toBe(true);
    expect(isInternalImportPath('github.com/acme/api/internal/db', modules)).toBe(true);
    expect(isInternalImportPath('github.com/go-chi/chi/v5', modules)).toBe(false);
    expect(isInternalImportPath('net/http', modules)).toBe(false);
    // A path that merely shares a prefix is not inside the module.
    expect(isInternalImportPath('github.com/acme/apiary', modules)).toBe(false);
    // A go.work fallback name must never make an unrelated path look internal.
    expect(isInternalImportPath('root/anything', modules)).toBe(false);
  });
});

describe('resolveQualifier — the declared package name beats the path guess', () => {
  it('resolves a qualifier whose package name differs from its directory', async () => {
    const files = [
      await gf('internal/database/store.go', 'package db\n'),
      await gf('internal/api/router.go', 'package api\n\nimport "github.com/acme/api/internal/database"\n'),
    ];
    const modules = [mod('github.com/acme/api', '.')];
    const index = buildPackageIndex(files, modules);
    const table = buildImportTable(files[1]);

    // The unaliased import binds the LAST SEGMENT by default, which is the wrong name here...
    expect(table.byLocal.get('database')).toBe('github.com/acme/api/internal/database');
    expect(table.byLocal.has('db')).toBe(false);
    // ...so a `db.FindUser()` selector only resolves through the correction pass.
    expect(resolveQualifier(table, index, 'db')).toBe('github.com/acme/api/internal/database');
    // The direct hit still wins, and an unknown qualifier stays unresolved rather than guessing.
    expect(resolveQualifier(table, index, 'database')).toBe('github.com/acme/api/internal/database');
    expect(resolveQualifier(table, index, 'nope')).toBeUndefined();
  });
});
