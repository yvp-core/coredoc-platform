/**
 * Parser Loader
 *
 * Dynamically loads parsers from the parser storage directory.
 */

import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { ParserMetadata } from '@coredoc/core/types';
import { RepoType, ParsedRepo } from '@coredoc/core/types';
import { parserDir as buildParserDir } from '@coredoc/core/utils';
import {
  applyIntegrityReport,
  assertProfileTypechecks,
  lintMessagingSystems,
  parseMultiTarget,
  resolveProfileModule,
} from '@coredoc/profile-parser';

// =============================================================================
// Types
// =============================================================================

export interface ParserOptions {
  repoRoot: string;
  repoName: string;
  repoKey?: string;
  repoType?: RepoType;
  exclude?: string[];
}

export interface Parser {
  parse(): Promise<ParsedRepo>;
}

export interface ParserInfo {
  projectId: string;
  name: string;
  path: string;
  /** Which artifact backs this parser: a declarative `profile.ts` (preferred) or a legacy `parser.ts`. */
  kind: 'profile' | 'parser';
  metadata?: ParserMetadata;
}

const require = createRequire(import.meta.url);
let cachedTs: typeof import('typescript') | null = null;

function getTypeScript(): typeof import('typescript') {
  if (cachedTs) return cachedTs;

  try {
    cachedTs = require('typescript') as typeof import('typescript');
    return cachedTs;
  } catch {
    throw new Error(
      'TypeScript runtime is required to compile parser.ts but was not found. ' +
        "Install 'typescript' as a runtime dependency for the desktop app package.",
    );
  }
}

// =============================================================================
// Parser Loading
// =============================================================================

/**
 * Load a parser for a specific repo.
 *
 * Canonical profile sources live under parserStorage. Compiled profile.mjs under dist is
 * only a rebuildable runtime cache and is never accepted without profile.ts. If the repo
 * has no direct source artifact, legacy parser metadata targetRepos are checked within
 * the same project.
 */
export async function loadParser(
  parserStorage: string,
  projectId: string,
  repoName: string,
  options: ParserOptions,
): Promise<Parser | null> {
  const parserDir = buildParserDir(parserStorage, projectId, repoName);

  // Profile-run path (preferred): a declarative ExtractionProfile (authored via the
  // author-profile loop) run through the tree-sitter+SCIP substrate engine. A profile
  // artifact takes precedence over a legacy ts-morph parser.ts in the same directory.
  const profileSourcePath = path.join(parserDir, 'profile.ts');
  const profileDistPath = getDistArtifactPath(parserStorage, projectId, repoName, 'profile.mjs');
  if (fs.existsSync(profileSourcePath)) {
    // Before transpiling: `tryRefreshCompiledParser` uses ts.transpileModule, which is a
    // single-file syntactic transform and accepts a profile whose rules do not match the
    // schema. Such rules load and extract nothing, so the parse "succeeds" with silent
    // holes. Fail here instead.
    assertProfileTypechecks(profileSourcePath);
    tryRefreshCompiledParser(profileSourcePath, profileDistPath);
    return await loadProfileFromPath(fs.existsSync(profileDistPath) ? profileDistPath : profileSourcePath, options);
  }
  const sourcePath = path.join(parserDir, 'parser.ts');
  const distPath = getDistParserPath(parserStorage, projectId, repoName);

  // Keep dist parser in sync with source when parser.ts changed.
  if (fs.existsSync(sourcePath)) {
    tryRefreshCompiledParser(sourcePath, distPath);
  }

  // Try compiled JS first
  if (fs.existsSync(distPath)) {
    return await loadParserFromPath(distPath, options);
  }

  // Try TypeScript source (requires tsx or ts-node)
  if (fs.existsSync(sourcePath)) {
    return await loadParserFromPath(sourcePath, options);
  }

  // Search all parsers within this project for one that targets this repo
  const parsers = await listAvailableParsers(parserStorage);
  for (const parserInfo of parsers) {
    if (parserInfo.projectId !== projectId) continue;
    if (parserInfo.metadata?.targetRepos?.includes(repoName)) {
      const parserPath = path.join(parserInfo.path, 'parser.ts');
      const compiledPath = getDistParserPath(parserStorage, parserInfo.projectId, parserInfo.name);
      if (fs.existsSync(parserPath)) {
        tryRefreshCompiledParser(parserPath, compiledPath);
      }
      if (fs.existsSync(compiledPath)) {
        return await loadParserFromPath(compiledPath, options);
      }
      if (fs.existsSync(parserPath)) {
        return await loadParserFromPath(parserPath, options);
      }
    }
  }

  return null;
}

// =============================================================================
// Import Rewriting (packaged desktop mode)
// =============================================================================

/**
 * Resolve a bare specifier (e.g. '@coredoc/core/types', 'ts-morph') to an
 * absolute file path inside the given node_modules directory by reading the
 * package's `exports` or `main` field.
 */
/**
 * Resolve a condition value from a package.json exports entry.
 * Handles nested condition objects like: { import: { types: "...", default: "..." } }
 * Prefers: import > default > require, and within those: default > first string found.
 */
function resolveExportEntry(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry === null || entry === undefined || typeof entry !== 'object') return null;

  const obj = entry as Record<string, unknown>;
  // Try common condition keys in priority order
  for (const key of ['import', 'default', 'require', 'node']) {
    const val = obj[key];
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val !== null) {
      // Nested: e.g. import: { types: "...", default: "..." }
      const nested = resolveExportEntry(val);
      if (nested) return nested;
    }
  }
  return null;
}

function resolveSpecifierToFile(specifier: string, nodeModulesDir: string): string | null {
  const parts = specifier.startsWith('@') ? specifier.split('/').slice(0, 2) : [specifier.split('/')[0]];
  const pkgName = parts.join('/');
  const rawSubpath = specifier.slice(pkgName.length);
  const subpath = rawSubpath ? `.${rawSubpath}` : '.';

  const pkgJsonPath = path.join(nodeModulesDir, pkgName, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const exports = pkgJson.exports;

  if (exports?.[subpath]) {
    const importPath = resolveExportEntry(exports[subpath]);
    if (importPath) {
      const resolved = path.join(nodeModulesDir, pkgName, importPath);
      return fs.existsSync(resolved) ? resolved : null;
    }
  }

  // Fallback: main / module fields
  if (subpath === '.') {
    const mainField = pkgJson.module ?? pkgJson.main;
    if (mainField) {
      const resolved = path.join(nodeModulesDir, pkgName, mainField);
      return fs.existsSync(resolved) ? resolved : null;
    }
  }

  return null;
}

/**
 * Rewrite bare specifier imports in transpiled JS to absolute file:// URLs
 * pointing into the runtime node_modules directory. This is needed in packaged
 * desktop mode where the parser lives in the workspace but dependencies are
 * in the app's runtime bundle at a completely different path.
 */
function rewriteImportsForRuntime(code: string, nodeModulesDir: string): string {
  // Match all bare specifier imports (not relative ./ or ../ or absolute / or file://)
  return code.replace(/from\s+["']([^"'./][^"']*)["']/g, (match, specifier: string) => {
    // Skip Node.js built-ins (node:fs, node:path, etc.)
    if (specifier.startsWith('node:')) return match;

    const resolved = resolveSpecifierToFile(specifier, nodeModulesDir);
    if (resolved) {
      return `from "${pathToFileURL(resolved).href}"`;
    }
    return match; // Leave unchanged if can't resolve
  });
}

// =============================================================================
// Parser Compilation
// =============================================================================

function getDistArtifactPath(parserStorage: string, projectId: string, parserName: string, file: string): string {
  return path.join(path.dirname(parserStorage), 'dist', 'coredoc-parsers', projectId, parserName, file);
}

function getDistParserPath(parserStorage: string, projectId: string, parserName: string): string {
  return getDistArtifactPath(parserStorage, projectId, parserName, 'parser.js');
}

function tryRefreshCompiledParser(sourcePath: string, compiledPath: string): void {
  const sourceStat = fs.statSync(sourcePath);
  const compiledStat = fs.existsSync(compiledPath) ? fs.statSync(compiledPath) : undefined;
  const compiledCode = compiledStat ? fs.readFileSync(compiledPath, 'utf-8') : '';
  const isCommonJs = compiledCode.includes('Object.defineProperty(exports') || compiledCode.includes('module.exports');
  // In packaged mode, recompile when the compiled JS has import paths that don't
  // match the current runtime: bare @coredoc/* specifiers (compiled without
  // COREDOC_RUNTIME_MODULES) or file:// URLs pointing to a stale modules dir
  // (e.g. _vendor vs node_modules after an app update).
  const currentRuntimeModules = process.env.COREDOC_RUNTIME_MODULES;
  let needsImportRewrite = false;
  if (currentRuntimeModules) {
    const hasBareCoredocImports = compiledCode.includes("from '@coredoc/") || compiledCode.includes('from "@coredoc/');
    const hasStaleRewrittenPaths =
      compiledCode.includes('from "file://') && !compiledCode.includes(pathToFileURL(currentRuntimeModules).href);
    needsImportRewrite = hasBareCoredocImports || hasStaleRewrittenPaths;
  }
  if (compiledStat && compiledStat.mtimeMs >= sourceStat.mtimeMs && !isCommonJs && !needsImportRewrite) {
    return;
  }

  const ts = getTypeScript();
  const sourceCode = fs.readFileSync(sourcePath, 'utf-8');
  const transpiled = ts.transpileModule(sourceCode, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      sourceMap: true,
      inlineSources: true,
      removeComments: false,
    },
    fileName: sourcePath,
    reportDiagnostics: false,
  });

  let outputCode = transpiled.outputText;

  // In packaged desktop mode, parser is in workspace but dependencies are in
  // the app's runtime bundle. Rewrite bare specifier imports to absolute paths.
  const runtimeModules = process.env.COREDOC_RUNTIME_MODULES;
  if (runtimeModules && fs.existsSync(runtimeModules)) {
    outputCode = rewriteImportsForRuntime(outputCode, runtimeModules);
  }

  fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
  const tmpPath = `${compiledPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, outputCode, 'utf-8');
  if (transpiled.sourceMapText) {
    fs.writeFileSync(`${tmpPath}.map`, transpiled.sourceMapText, 'utf-8');
  }
  fs.renameSync(tmpPath, compiledPath);
  if (transpiled.sourceMapText) {
    fs.renameSync(`${tmpPath}.map`, `${compiledPath}.map`);
  }
}

/**
 * Load a parser from a specific file path.
 */
async function loadParserFromPath(parserPath: string, options: ParserOptions): Promise<Parser> {
  // We need to use ts-node or tsx to load TypeScript files at runtime
  // For now, we'll use dynamic import with tsx
  try {
    // Try to import the module
    // Note: This requires the project to be run with tsx or ts-node
    const module = await import(pathToFileURL(parserPath).href);

    // Look for createParser export
    if (typeof module.createParser === 'function') {
      return module.createParser(options);
    }

    // Look for default export that's a class
    if (module.default && typeof module.default === 'function') {
      return new module.default(options);
    }

    // Look for Parser class export
    const ParserClass = Object.values(module).find(
      (exp): exp is new (opts: ParserOptions) => Parser =>
        typeof exp === 'function' && exp.prototype && typeof exp.prototype.parse === 'function',
    );

    if (ParserClass) {
      return new ParserClass(options);
    }

    throw new Error(`No valid parser export found in ${parserPath}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unknown file extension')) {
      throw new Error(
        `Cannot load TypeScript parser directly. Run with 'npx tsx' or build first.\n` +
          `  npx tsx src/cli/index.ts parse\n` +
          `  # or\n` +
          `  npm run build && node dist/cli/index.js parse`,
      );
    }
    throw error;
  }
}

// =============================================================================
// Profile-run path (substrate engine)
// =============================================================================

/**
 * Load a per-repo profile module and return a Parser. Dispatch is owned by
 * `resolveProfileModule` in `@coredoc/profile-parser`: a single-language export resolves
 * to the `LanguageProvider` whose `substrate.language` matches it (TS/JS → SCIP engine,
 * Ruby → Ruby substrate) and is run via `provider.parse`; a multi-target composite export
 * is run via `parseMultiTarget`, which fans out to one provider per target and merges the
 * results. SCIP preflight and the per-language adaptation live inside the providers.
 */
async function loadProfileFromPath(profilePath: string, options: ParserOptions): Promise<Parser> {
  const module = await import(pathToFileURL(profilePath).href);
  const resolved = resolveProfileModule(module as Record<string, unknown>);
  if (!resolved) {
    throw new Error(`No registered-language profile export found in ${profilePath}`);
  }
  // Warn, don't throw: two similar spellings CAN be two real buses. But when they
  // are not, every cross-repo messaging edge split across them silently resolves to
  // nothing while the parse still reports success — so it has to be said out loud.
  for (const target of resolved.kind === 'multi' ? resolved.profile.targets : [resolved.profile]) {
    for (const warning of lintMessagingSystems(target as Parameters<typeof lintMessagingSystems>[0])) {
      console.warn(`[coredoc/profile] ${path.basename(profilePath)}: ${warning.message}`);
    }
  }
  const opts = {
    repoRoot: options.repoRoot,
    repoName: options.repoName,
    repoKey: options.repoKey,
  };
  return {
    // Referential integrity is recorded on every parse result. The multi-target
    // path already runs it inside mergeParsedRepos; applying it again here is
    // idempotent (it replaces its own error entries) and keeps the single-target
    // path from being the one that ships a dangling graph unannounced.
    parse: async () => {
      const parsed =
        resolved.kind === 'multi'
          ? await parseMultiTarget(resolved.profile, opts)
          : await resolved.provider.parse(resolved.profile, opts);
      applyIntegrityReport(parsed);
      return parsed;
    },
  };
}

// =============================================================================
// Parser Discovery
// =============================================================================

/**
 * List all available parsers in the storage directory.
 *
 * Walks two levels: `{parserStorage}/{projectId}/{repoName}/`.
 * Skips the `.layout-version` sentinel and any `_orphaned` bucket directories.
 */
export async function listAvailableParsers(parserStorage: string): Promise<ParserInfo[]> {
  const parsers: ParserInfo[] = [];

  if (!fs.existsSync(parserStorage)) {
    return parsers;
  }

  const projectEntries = fs.readdirSync(parserStorage, { withFileTypes: true });

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    if (projectEntry.name.startsWith('.') || projectEntry.name.startsWith('_')) continue;

    const projectDir = path.join(parserStorage, projectEntry.name);
    const repoEntries = fs.readdirSync(projectDir, { withFileTypes: true });

    for (const repoEntry of repoEntries) {
      if (!repoEntry.isDirectory()) continue;

      const repoParserDir = path.join(projectDir, repoEntry.name);
      const metadataFile = path.join(repoParserDir, 'metadata.json');

      // Mirror loadParser/hasParser precedence: a declarative profile.ts is the
      // canonical artifact and wins over a legacy ts-morph parser.ts. Repos
      // authored via the current author-profile workflow only have profile.ts,
      // so gating discovery on parser.ts would hide them entirely.
      let kind: 'profile' | 'parser';
      if (fs.existsSync(path.join(repoParserDir, 'profile.ts'))) {
        kind = 'profile';
      } else if (fs.existsSync(path.join(repoParserDir, 'parser.ts'))) {
        kind = 'parser';
      } else {
        continue;
      }

      let metadata: ParserMetadata | undefined;
      if (fs.existsSync(metadataFile)) {
        try {
          metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
        } catch {
          // Ignore invalid metadata
        }
      }

      parsers.push({
        projectId: projectEntry.name,
        name: repoEntry.name,
        path: repoParserDir,
        kind,
        metadata,
      });
    }
  }

  return parsers;
}

/**
 * Check if a parser exists for a `(projectId, repoName)` pair.
 */
export function hasParser(parserStorage: string, projectId: string, repoName: string): boolean {
  const dir = buildParserDir(parserStorage, projectId, repoName);
  return fs.existsSync(path.join(dir, 'profile.ts')) || fs.existsSync(path.join(dir, 'parser.ts'));
}

/**
 * Get parser metadata for a `(projectId, repoName)` pair.
 */
export function getParserMetadata(parserStorage: string, projectId: string, repoName: string): ParserMetadata | null {
  const metadataPath = path.join(buildParserDir(parserStorage, projectId, repoName), 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  } catch {
    return null;
  }
}
