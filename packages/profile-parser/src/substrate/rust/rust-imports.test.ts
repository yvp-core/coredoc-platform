import { describe, expect, it } from 'vitest';
import { type RustCrate, parseCargoManifest } from './rust-crates.js';
import { type RustFile } from './rust-cst.js';
import { buildModuleIndex, buildUseTable, moduleDir, resolveUseTarget } from './rust-imports.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

/** Build a RustFile (relPath + source + parsed root) the way the parser does. */
async function rf(relPath: string, source: string): Promise<RustFile> {
  return { relPath, source, root: await parseSource('rust', source) };
}

/** A single-crate workspace descriptor. */
function crate(name: string, path = '.'): RustCrate {
  return { name, path, dependencies: new Set(), isWorkspaceRoot: false, isPackage: true };
}

describe('buildUseTable', () => {
  it('binds plain, aliased, grouped and nested-grouped paths', async () => {
    const file = await rf(
      'src/lib.rs',
      `
use crate::db::models::{User, Post as P};
use my_api::client as api_client;
use std::collections::HashMap;
use a::{b::{c}, e};
`,
    );
    const table = buildUseTable(file);
    expect(table.byLocal.get('User')?.path).toBe('crate::db::models::User');
    expect(table.byLocal.get('P')?.path).toBe('crate::db::models::Post');
    expect(table.byLocal.get('api_client')?.path).toBe('my_api::client');
    expect(table.byLocal.get('HashMap')?.path).toBe('std::collections::HashMap');
    expect(table.byLocal.get('c')?.path).toBe('a::b::c');
    expect(table.byLocal.get('e')?.path).toBe('a::e');
  });

  it('COUNTS glob imports and never binds them', async () => {
    // Anchor `#[program]` mods contain `use super::*;` universally, and diesel's
    // `use schema::users::dsl::*;` is how bare table names come into scope — which is why the
    // db-op gate matches known table names instead of trying to resolve the glob.
    const table = buildUseTable(await rf('src/lib.rs', 'use super::*;\nuse schema::users::dsl::*;'));
    expect(table.globCount).toBe(2);
    expect(table.byLocal.size).toBe(0);
  });

  it('binds the module itself for `use foo::{self, Bar}`', async () => {
    const table = buildUseTable(await rf('src/lib.rs', 'use crate::foo::{self, Bar};'));
    expect(table.byLocal.get('foo')?.path).toBe('crate::foo');
    expect(table.byLocal.get('Bar')?.path).toBe('crate::foo::Bar');
  });
});

describe('moduleDir — the asymmetry that decides the whole module graph', () => {
  // Trap 6: `lib.rs`/`main.rs`/`mod.rs` own their OWN directory; any other `foo.rs` owns the
  // sibling `foo/`. A naive `dirname(F)` is right for crate roots and wrong for every
  // 2018-style `foo.rs` + `foo/` pair.
  it('resolves crate roots against their own dir and plain modules against a sibling dir', () => {
    expect(moduleDir('src/lib.rs')).toBe('src');
    expect(moduleDir('src/main.rs')).toBe('src');
    expect(moduleDir('src/db/mod.rs')).toBe('src/db');
    expect(moduleDir('src/db.rs')).toBe('src/db');
    expect(moduleDir('src/db/models.rs')).toBe('src/db/models');
  });
});

describe('buildModuleIndex — walk `mod` declarations forward from the crate root', () => {
  it('names file-backed modules through both the foo.rs and foo/mod.rs layouts', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod db;\npub mod api;'),
      // `src/db.rs` declaring `mod models;` resolves to `src/db/models.rs`, NOT `src/models.rs`.
      await rf('src/db.rs', 'pub mod models;\npub fn connect() {}'),
      await rf('src/db/models.rs', 'pub fn all() {}'),
      await rf('src/api/mod.rs', 'pub fn serve() {}'),
      await rf('src/models.rs', 'pub fn decoy() {}'),
    ];
    const index = buildModuleIndex(files, [crate('my-api')]);
    expect(index.byModule.get('my_api')).toBe('src/lib.rs');
    expect(index.byModule.get('my_api::db')).toBe('src/db.rs');
    expect(index.byModule.get('my_api::db::models')).toBe('src/db/models.rs');
    expect(index.byModule.get('my_api::api')).toBe('src/api/mod.rs');
    // The decoy is declared by no `mod`, so the walk never reaches it — it must NOT have
    // stolen the `my_api::db::models` name.
    expect(index.byModule.get('my_api::db::models')).not.toBe('src/models.rs');
  });

  it('registers an inline `mod` against the same file and shifts its children’s directory', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod outer { pub mod inner; pub fn f() {} }'),
      await rf('src/outer/inner.rs', 'pub fn g() {}'),
    ];
    const index = buildModuleIndex(files, [crate('demo')]);
    expect(index.byModule.get('demo::outer')).toBe('src/lib.rs');
    expect(index.byModule.get('demo::outer::inner')).toBe('src/outer/inner.rs');
  });

  it('indexes a hyphenated Cargo name under its underscored code spelling', async () => {
    // Trap 7: `[package] name = "my-api"` is `use my_api::…` in code. Miss this and every
    // cross-crate `use` in the workspace silently fails to resolve.
    const files = [await rf('crates/my-api/src/lib.rs', 'pub fn go() {}')];
    const index = buildModuleIndex(files, [crate('my-api', 'crates/my-api')]);
    expect(index.byModule.get('my_api')).toBe('crates/my-api/src/lib.rs');
  });

  it('gives an unreachable file a path-derived name NON-authoritatively', async () => {
    const files = [await rf('src/lib.rs', 'pub fn f() {}'), await rf('src/bin/tool.rs', 'fn main() {}')];
    const index = buildModuleIndex(files, [crate('demo')]);
    expect(index.moduleOfFile.get('src/bin/tool.rs')).toBe('demo::bin::tool');
    expect(index.byModule.get('demo')).toBe('src/lib.rs'); // the authoritative name is untouched
  });
});

describe('resolveUseTarget', () => {
  it('absolutizes crate:: / self:: / super:: heads', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod util;\npub mod api;'),
      await rf('src/util.rs', 'pub fn helper() {}'),
      await rf('src/api.rs', 'pub fn serve() {}'),
    ];
    const index = buildModuleIndex(files, [crate('demo')]);
    const api = files[2];
    const table = buildUseTable(api);

    expect(resolveUseTarget(table, index, 'src/api.rs', 'crate::util::helper')).toEqual({
      filePath: 'src/util.rs',
      tail: ['helper'],
      viaUse: false,
    });
    expect(resolveUseTarget(table, index, 'src/api.rs', 'self::serve')).toEqual({
      filePath: 'src/api.rs',
      tail: ['serve'],
      viaUse: false,
    });
    expect(resolveUseTarget(table, index, 'src/api.rs', 'super::util::helper')).toEqual({
      filePath: 'src/util.rs',
      tail: ['helper'],
      viaUse: false,
    });
  });

  it('resolves through the use table and marks the tier', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod util;\npub mod api;'),
      await rf('src/util.rs', 'pub fn helper() {}'),
      await rf('src/api.rs', 'use crate::util::helper;\npub fn serve() { helper(); }'),
    ];
    const index = buildModuleIndex(files, [crate('demo')]);
    const target = resolveUseTarget(buildUseTable(files[2]), index, 'src/api.rs', 'helper');
    expect(target).toEqual({ filePath: 'src/util.rs', tail: ['helper'], viaUse: true });
  });

  it('returns undefined for an external crate rather than guessing a file', async () => {
    const files = [await rf('src/lib.rs', 'use serde::Serialize;')];
    const index = buildModuleIndex(files, [crate('demo')]);
    expect(resolveUseTarget(buildUseTable(files[0]), index, 'src/lib.rs', 'serde::to_string')).toBeUndefined();
  });
});

describe('parseCargoManifest', () => {
  it('reads the package name/version, the workspace marker and every dependency table', () => {
    const manifest = parseCargoManifest(
      `
[package]
name = "my-api"        # hyphenated on purpose
version = "0.3.1"

[workspace]
members = ["crates/*"]

[dependencies]
anchor-lang = "0.29"
serde = { version = "1", features = ["derive"] }
tokio.workspace = true

[dev-dependencies]
proptest = "1"

[target.'cfg(unix)'.dependencies]
nix = "0.27"

[dependencies.reqwest]
version = "0.12"
`,
      'fallback',
    );
    expect(manifest.name).toBe('my-api');
    expect(manifest.version).toBe('0.3.1');
    expect(manifest.isWorkspaceRoot).toBe(true);
    expect(manifest.isPackage).toBe(true);
    expect([...manifest.dependencies].sort()).toEqual(
      ['anchor-lang', 'nix', 'proptest', 'reqwest', 'serde', 'tokio'].sort(),
    );
  });

  it('falls back to the directory name for a virtual workspace manifest', () => {
    const manifest = parseCargoManifest('[workspace]\nmembers = ["a"]\n', 'root');
    expect(manifest.name).toBe('root');
    expect(manifest.isPackage).toBe(false);
  });
});

describe('buildUseTable — memoization', () => {
  it('returns the SAME table object for a file, so the three lanes share one CST walk', async () => {
    const file = await rf('src/a.rs', 'use crate::db::models::User;\nuse foo::*;\n');
    const first = buildUseTable(file);
    expect(buildUseTable(file)).toBe(first);
    // A re-parse is a different RustFile — it must not read the previous file's table.
    const reparsed = await rf('src/a.rs', 'use crate::other::Thing;\n');
    const second = buildUseTable(reparsed);
    expect(second).not.toBe(first);
    expect([...second.byLocal.keys()]).toEqual(['Thing']);
  });
});
