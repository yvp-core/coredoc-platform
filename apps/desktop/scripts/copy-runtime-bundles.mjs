/**
 * Copy runtime bundles for Electron packaging.
 *
 * Produces a flat dist/runtime/ directory with NO symlinks:
 *   dist/runtime/
 *     packages/{cli,mcp,core,db,...}/   ← @coredoc/* packages (source minus node_modules/src)
 *     _vendor/                          ← NOT named node_modules (electron-builder prunes those)
 *       @coredoc/{cli,mcp,core,...}/    ← copies for cross-package import resolution
 *       commander/                      ← real files, resolved from pnpm symlinks
 *       ...                             ← all transitive runtime deps
 *
 * The directory is named `_vendor` instead of `node_modules` because electron-builder
 * applies special dependency pruning to any directory named `node_modules`.
 * An afterPack hook (after-pack.mjs) renames _vendor → node_modules in the unpacked
 * ASAR directory so Node's ESM resolver can find bare imports.
 *
 * Version conflicts: pnpm may install different versions of the same package for
 * different parents (e.g. ollama@1.2.1 at root, ollama@0.6.3 for @langchain/ollama).
 * When a conflict is detected, the alternate version is nested inside the parent's
 * own node_modules/ directory, mirroring how npm handles hoisting conflicts.
 *
 * This replaces the old script that copied the entire .pnpm store (1.8 GB)
 * and preserved symlinks (which break inside ASAR archives).
 *
 * Type declarations: the `.d.ts` files this copies are NOT automatically packaged.
 * electron-builder lists `d.ts` in its built-in `excludedExts` and appends that exclusion
 * after every user pattern in `build.files`, so it cannot be undone by adding an include
 * there. The desktop package.json therefore carries a second file matcher with its own
 * `from: dist/runtime` — electron-builder applies the built-in exclusions only to the FIRST
 * matcher, so that one lets the declarations through. They are not optional: the profile
 * typecheck gate (`@coredoc/profile-parser` → `profile-typecheck.ts`) compiles the user's
 * profile against `@coredoc/profile-parser`'s `dist/index.d.ts` plus TypeScript's own lib
 * files, and `coredoc profile score` throws without them. Keep the matcher's filter in sync
 * with what that gate reads — re-including every `*.d.ts` would add ~12 MB of dep typings
 * nothing loads.
 */

import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');

const runtimeRoot = path.join(desktopDir, 'dist', 'runtime');
const runtimePackages = path.join(runtimeRoot, 'packages');
const runtimeVendor = path.join(runtimeRoot, '_vendor');

const rootNodeModules = path.join(repoRoot, 'node_modules');

// profile-parser is the engine the CLI `parse` loads at runtime (it replaced the
// old ts-morph parser-gen model). docs-gen and parser-gen were removed in the reseed.
const packageNames = ['cli', 'mcp', 'core', 'db', 'profile-parser'];

// ─── Runtime dep exclusions ──────────────────────────────────────────────────
//
// These packages are NOT needed by child processes (MCP server, CLI parse).
// They're only used by the main process or SDK worker, which are served by
// the esbuild bundle. Excluding them saves ~200MB from the runtime bundle.
//
// @anthropic-ai/*  — summarize (SDK worker / main process)
// @langchain/*     — embed command (SDK worker)
//
const SKIP_RUNTIME_DEPS = new Set([
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@langchain/core',
  '@langchain/ollama',
  '@langchain/openai',
]);

// Also skip any dep whose scope is in this set (catches transitive deps)
const SKIP_RUNTIME_SCOPES = new Set(['@anthropic-ai', '@langchain']);

function shouldSkipDep(depName) {
  if (SKIP_RUNTIME_DEPS.has(depName)) return true;
  const scope = depName.startsWith('@') ? depName.split('/')[0] : null;
  if (scope && SKIP_RUNTIME_SCOPES.has(scope)) return true;
  return false;
}

// ─── Filters ─────────────────────────────────────────────────────────────────

const EXCLUDE_DIRS = new Set(['node_modules', 'src', '.turbo', '__tests__', '.git']);
const EXCLUDE_EXTENSIONS = new Set(['.test.ts', '.test.js', '.spec.ts', '.spec.js']);

function shouldExclude(srcPath) {
  const basename = path.basename(srcPath);
  if (EXCLUDE_DIRS.has(basename)) return true;
  for (const ext of EXCLUDE_EXTENSIONS) {
    if (basename.endsWith(ext)) return true;
  }
  return false;
}

// ─── Dependency resolution ───────────────────────────────────────────────────

/**
 * Read a package.json and return its runtime dependency names
 * (dependencies + optionalDependencies).
 */
function getRuntimeDeps(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return [];

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  // The parser loads this package's WASM, never its native Node bindings.
  if (pkgJson.name === 'tree-sitter-c-sharp') return [];
  const deps = Object.keys(pkgJson.dependencies || {});
  const optDeps = Object.keys(pkgJson.optionalDependencies || {});
  return [...deps, ...optDeps];
}

/**
 * Read a package.json version field.
 */
function getPkgVersion(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Given a package's real path inside a pnpm store, return the containing
 * node_modules directory. Handles both scoped and unscoped packages:
 *
 *   .pnpm/glob@10/node_modules/glob           → .pnpm/glob@10/node_modules/
 *   .pnpm/@langchain+ollama@1/node_modules/@langchain/ollama
 *                                              → .pnpm/@langchain+ollama@1/node_modules/
 */
function getContainingNodeModules(realPath) {
  const parts = realPath.split(path.sep);
  const nmIdx = parts.lastIndexOf('node_modules');
  if (nmIdx >= 0) {
    return parts.slice(0, nmIdx + 1).join(path.sep);
  }
  return path.dirname(realPath);
}

/**
 * Resolve a dependency name to its real filesystem path.
 *
 * pnpm uses a nested .pnpm store where transitive deps are siblings of their
 * parent package. Resolution tries sibling first (exact version pnpm chose
 * for that parent), then falls back to root hoisted version, and finally
 * checks each workspace package's own node_modules (for deps that pnpm
 * doesn't hoist to root).
 */
function resolveDepPath(depName, parentRealPath) {
  // 1. Sibling resolution (pnpm places deps as siblings in the same node_modules)
  //    Must use the node_modules dir, not just dirname — scoped packages like
  //    @langchain/ollama have an extra directory level (@langchain/) between
  //    node_modules/ and the package dir.
  if (parentRealPath) {
    const nmDir = getContainingNodeModules(parentRealPath);
    const siblingPath = path.join(nmDir, depName);
    try {
      return realpathSync(siblingPath);
    } catch {
      // Not a sibling — fall through to root
    }
  }

  // 2. Root node_modules (hoisted deps)
  const rootPath = path.join(rootNodeModules, depName);
  try {
    return realpathSync(rootPath);
  } catch {
    // Not hoisted — fall through to workspace packages
  }

  // 3. Workspace packages' own node_modules (pnpm doesn't hoist all deps)
  for (const name of packageNames) {
    const localPath = path.join(repoRoot, 'packages', name, 'node_modules', depName);
    try {
      return realpathSync(localPath);
    } catch {
      // Not in this package — try next
    }
  }

  return null;
}

/**
 * Copy a dependency directory, filtering out nested node_modules.
 */
function copyDep(realPath, destPath) {
  if (JSON.parse(readFileSync(path.join(realPath, 'package.json'), 'utf-8')).name === 'tree-sitter-c-sharp') {
    mkdirSync(destPath, { recursive: true });
    for (const file of ['package.json', 'LICENSE', 'tree-sitter-c_sharp.wasm']) {
      cpSync(path.join(realPath, file), path.join(destPath, file));
    }
    return;
  }
  cpSync(realPath, destPath, {
    recursive: true,
    filter: (src) => {
      if (src === realPath) return true;
      if (path.basename(src) === 'node_modules') return false;
      return true;
    },
  });
}

/**
 * Queue-based dependency resolver with version conflict handling.
 *
 * Tracks which real path was copied for each dep name. When the same dep name
 * resolves to a different real path (= different version), the alternate version
 * is nested inside the parent's node_modules/ directory within _vendor.
 *
 * Example conflict:
 *   _vendor/ollama/           ← v1.2.1 (hoisted, first copy)
 *   _vendor/@langchain/ollama/node_modules/ollama/  ← v0.6.3 (nested for this parent)
 */
function collectAndCopyDeps(depNames, parentRealPath) {
  /** depName → realPath of the copy in top-level _vendor/ */
  const copiedRealPaths = new Map();
  /** depName set for deps fully processed (top-level + transitive enqueued) */
  const _visited = new Set();
  const unresolved = new Set();

  // Queue entries: { depName, parentRealPath, parentDepName }
  // parentDepName is used to create nested node_modules for version conflicts
  const queue = depNames
    .filter((n) => !n.startsWith('@coredoc/') && !shouldSkipDep(n))
    .map((depName) => ({ depName, parentRealPath, parentDepName: null }));

  while (queue.length > 0) {
    const { depName, parentRealPath: parent, parentDepName } = queue.shift();

    const realPath = resolveDepPath(depName, parent);
    if (!realPath) {
      if (!unresolved.has(depName)) {
        console.warn(`  [warn] Optional dep not installed, skipping: ${depName}`);
        unresolved.add(depName);
      }
      continue;
    }

    // Check for version conflict
    const existingRealPath = copiedRealPaths.get(depName);

    if (existingRealPath) {
      if (existingRealPath === realPath) {
        // Same version already at top level — nothing to do
        continue;
      }

      // Different version needed by this parent → nest inside parent's node_modules
      if (parentDepName) {
        const nestedDest = path.join(runtimeVendor, parentDepName, 'node_modules', depName);
        if (!existsSync(nestedDest)) {
          if (depName.startsWith('@')) {
            mkdirSync(path.dirname(nestedDest), { recursive: true });
          } else {
            mkdirSync(path.join(runtimeVendor, parentDepName, 'node_modules'), { recursive: true });
          }
          copyDep(realPath, nestedDest);
          const v1 = getPkgVersion(existingRealPath);
          const v2 = getPkgVersion(realPath);
          console.log(`  [conflict] ${depName}: ${v1} (top) vs ${v2} (nested in ${parentDepName})`);
        }
      }

      // Still need to process this version's transitive deps
      // but they should also be nested or already covered
      const transitiveDeps = getRuntimeDeps(realPath);
      for (const td of transitiveDeps) {
        if (!td.startsWith('@coredoc/') && !shouldSkipDep(td)) {
          queue.push({ depName: td, parentRealPath: realPath, parentDepName: parentDepName || depName });
        }
      }
      continue;
    }

    // First time seeing this dep — copy to top-level _vendor/
    copiedRealPaths.set(depName, realPath);

    const destPath = path.join(runtimeVendor, depName);
    if (!existsSync(destPath)) {
      if (depName.startsWith('@')) {
        mkdirSync(path.join(runtimeVendor, depName.split('/')[0]), { recursive: true });
      }
      copyDep(realPath, destPath);
    }

    // Enqueue transitive deps with sibling context
    const transitiveDeps = getRuntimeDeps(realPath);
    for (const td of transitiveDeps) {
      if (!td.startsWith('@coredoc/') && !shouldSkipDep(td)) {
        queue.push({ depName: td, parentRealPath: realPath, parentDepName: depName });
      }
    }
  }

  return copiedRealPaths.size;
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('[desktop] Building runtime bundles (symlink-free)...');

// 1. Clean and recreate
rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimePackages, { recursive: true });
mkdirSync(path.join(runtimeVendor, '@coredoc'), { recursive: true });

// 2. Copy @coredoc/* packages
for (const name of packageNames) {
  const src = path.join(repoRoot, 'packages', name);
  if (!existsSync(src)) {
    throw new Error(`Package dir not found: ${src}`);
  }

  const pkgDest = path.join(runtimePackages, name);
  const nmDest = path.join(runtimeVendor, '@coredoc', name);

  cpSync(src, pkgDest, {
    recursive: true,
    dereference: true,
    filter: (srcPath) => !shouldExclude(srcPath),
  });

  cpSync(src, nmDest, {
    recursive: true,
    dereference: true,
    filter: (srcPath) => !shouldExclude(srcPath),
  });

  console.log(`  [copied] @coredoc/${name}`);
}

// 2b. Copy the self-contained profile-authoring kit (author-profile skill + the profile-parser
// schema doc) so the packaged app can drive profile authoring without the monorepo present.
// The desktop's generate flow points the isolated Claude Code session at this dir.
const kitDest = path.join(runtimeRoot, 'authoring-kit');
const skillSrc = path.join(repoRoot, 'skills', 'author-profile');
if (existsSync(skillSrc)) {
  cpSync(skillSrc, kitDest, { recursive: true, dereference: true, filter: (srcPath) => !shouldExclude(srcPath) });
  const readmeSrc = path.join(repoRoot, 'packages', 'profile-parser', 'README.md');
  if (existsSync(readmeSrc)) {
    mkdirSync(path.join(kitDest, 'references'), { recursive: true });
    cpSync(readmeSrc, path.join(kitDest, 'references', 'profile-parser-README.md'));
  }
  console.log('  [kit] authoring-kit (author-profile skill + schema doc)');
} else {
  console.warn('  [kit] WARNING: skills/author-profile not found — packaged profile authoring will be unavailable');
}

// 3. Collect all runtime deps from @coredoc/* packages
const allDepNames = [];
for (const name of packageNames) {
  const pkgDir = path.join(repoRoot, 'packages', name);
  const deps = getRuntimeDeps(pkgDir);
  allDepNames.push(...deps);
}

// 5. Resolve and copy all transitive deps with version conflict handling
const totalCopied = collectAndCopyDeps(allDepNames, null);

console.log(`  [deps] Copied ${totalCopied} unique top-level dependencies`);

// 6. Summary
console.log(`[desktop] Runtime workspace prepared at ${runtimeRoot}`);
console.log(`  No symlinks. No .pnpm store.`);
console.log(`  Excluded scopes: ${[...SKIP_RUNTIME_SCOPES].join(', ')}`);
