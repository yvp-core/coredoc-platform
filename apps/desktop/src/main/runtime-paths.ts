/**
 * Runtime Paths - Centralized path resolution + node execution for dev & packaged modes.
 *
 * Two distinct root concepts:
 * - **Workspace** (projectRoot): where coredoc.config.json, coredoc-output/, coredoc-parsers/ live (user data)
 * - **Resources** (resourcesRoot): where CLI scripts, MCP server, ops-entry live (app binaries)
 *
 * Dev mode: both resolve to the monorepo root (via import.meta.url-based __dirname)
 * Packaged mode:
 *   - Workspace → app.getPath('userData')/workspace (auto-created with default config)
 *   - Resources → app.getAppPath() (ASAR bundle containing node_modules/@coredoc/*)
 */

import { app } from 'electron';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { resolveE2EWorkspaceDir } from './e2e-mode.js';
import { resolveSystemCodexCliPath } from './codex-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dev mode: esbuild output lives at apps/desktop/dist/main/index.js
// Monorepo root is 4 directory levels up
const DEV_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let projectRoot: string | null = null;
let initialized = false;
let cachedCodexCliPath: string | null | undefined;

// ---------------------------------------------------------------------------
// Default workspace config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  version: '2.0',
  projects: [],
  output: { dir: './coredoc-output', format: 'json', prettyPrint: true },
  parserStorage: './coredoc-parsers',
  exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
};

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

function getDefaultWorkspaceDir(): string {
  return path.join(app.getPath('userData'), 'workspace');
}

/**
 * Ensure a directory has the minimum workspace structure (coredoc.config.json).
 * Creates the directory and a default config if missing.
 */
function ensureWorkspace(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'coredoc.config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Project root (workspace) resolution
// ---------------------------------------------------------------------------

function isExistingDir(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function getStoragePath(): string {
  return path.join(app.getPath('userData'), 'project-root.json');
}

/**
 * Initialise project root (workspace). Call once at startup.
 *
 * - Dev mode: uses `process.cwd()` (which is `apps/desktop`) + `../..`
 * - Packaged mode: tries persisted path, then auto-creates default workspace.
 */
export async function initProjectRoot(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!app.isPackaged) {
    // Dev mode — resolve from compiled file location, not cwd.
    // The e2e harness overrides this so a launch reads a seeded throwaway
    // workspace instead of the developer's monorepo; the override is inert
    // unless COREDOC_DESKTOP_E2E=1, which packaged builds reject (e2e-mode.ts).
    // Under the flag the seeded dir is required, so DEV_ROOT is unreachable.
    projectRoot = resolveE2EWorkspaceDir(process.env, isExistingDir) ?? DEV_ROOT;
    return;
  }

  // Packaged mode — try persisted workspace
  try {
    const storagePath = getStoragePath();
    if (fs.existsSync(storagePath)) {
      const data = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      if (data.projectRoot && fs.existsSync(data.projectRoot)) {
        projectRoot = data.projectRoot as string;
        ensureWorkspace(data.projectRoot as string);
        return;
      }
    }
  } catch {
    // Corrupt file — ignore, fall through to auto-create
  }

  // First launch → auto-create workspace
  const defaultDir = getDefaultWorkspaceDir();
  ensureWorkspace(defaultDir);
  setProjectRoot(defaultDir);
}

/** Sync getter — returns workspace path. Always non-null after init in packaged mode. */
export function getProjectRoot(): string | null {
  return projectRoot;
}

/**
 * Strict variant — throws if called before initProjectRoot().
 * Use this in places that require a valid workspace path.
 */
export function requireProjectRoot(): string {
  if (!projectRoot) {
    throw new Error('Project root not initialized. Call initProjectRoot() first.');
  }
  return projectRoot;
}

/** Persist a project root (workspace) and update the in-memory cache. */
export function setProjectRoot(rootPath: string): void {
  projectRoot = rootPath;

  try {
    const storagePath = getStoragePath();
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, JSON.stringify({ projectRoot: rootPath }), 'utf-8');
  } catch (err) {
    console.error('[runtime-paths] Failed to persist project root:', err);
  }
}

// ---------------------------------------------------------------------------
// Resources root (bundled binaries)
// ---------------------------------------------------------------------------

/**
 * Root for resolving bundled binary paths (CLI, MCP, ops-entry).
 * - Dev mode: monorepo root (process.cwd() + ../..)
 * - Packaged mode: ASAR app directory (contains node_modules/@coredoc/*)
 */
function getResourcesRoot(): string {
  if (!app.isPackaged) {
    return DEV_ROOT;
  }
  return app.getAppPath();
}

function getPackagedResourceRoots(): string[] {
  if (!app.isPackaged) {
    return [getResourcesRoot()];
  }

  const appPath = app.getAppPath();
  const roots = new Set<string>();

  if (appPath.includes('app.asar')) {
    roots.add(appPath.replace('app.asar', 'app.asar.unpacked'));
  }
  if (appPath.endsWith('.asar')) {
    roots.add(`${appPath}.unpacked`);
  }
  roots.add(path.join(process.resourcesPath, 'app.asar.unpacked'));

  roots.add(appPath);
  roots.add(path.join(process.resourcesPath, 'app.asar'));

  return [...roots];
}

function getBundledRuntimeDirs(): string[] {
  if (!app.isPackaged) {
    return [path.join(getResourcesRoot(), 'dist', 'runtime')];
  }

  return getPackagedResourceRoots().map((root) => path.join(root, 'dist', 'runtime'));
}

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findClaudeCliInNodeModules(nodeModulesRoot: string): string | null {
  const direct = path.join(nodeModulesRoot, '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  if (fs.existsSync(direct)) {
    return direct;
  }

  const pnpmStore = path.join(nodeModulesRoot, '.pnpm');
  if (!fs.existsSync(pnpmStore)) {
    return null;
  }

  try {
    const entries = fs.readdirSync(pnpmStore);
    for (const entry of entries) {
      if (!entry.startsWith('@anthropic-ai+claude-agent-sdk@')) {
        continue;
      }
      const cliPath = path.join(pnpmStore, entry, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    }
  } catch {
    // Ignore unreadable store entries and continue with fallback candidates.
  }

  return null;
}

// ---------------------------------------------------------------------------
// Node execution (for spawning CLI / MCP in packaged mode)
// ---------------------------------------------------------------------------

export interface NodeExec {
  execPath: string;
  env: NodeJS.ProcessEnv;
}

let cachedNodeExec: NodeExec | null = null;

function getMacHelperExecPath(): string | null {
  if (process.platform !== 'darwin') return null;

  // In a packaged app:
  // - Main executable: <App>.app/Contents/MacOS/<App>
  // - Helper:          <App>.app/Contents/Frameworks/<App> Helper.app/Contents/MacOS/<App> Helper
  const appBinaryName = path.basename(process.execPath);
  const contentsDir = path.resolve(process.execPath, '..', '..');
  const helperName = `${appBinaryName} Helper`;
  const helperExec = path.join(contentsDir, 'Frameworks', `${helperName}.app`, 'Contents', 'MacOS', helperName);

  return fs.existsSync(helperExec) ? helperExec : null;
}

function canExecuteAsNode(execPath: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const result = spawnSync(execPath, ['-e', 'process.exit(0)'], {
      env,
      stdio: 'ignore',
      timeout: 2500,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function resolveAbsoluteSystemNodePath(): string | null {
  try {
    const result = spawnSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
      env: { ...process.env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    });

    if (result.error || result.status !== 0) {
      return null;
    }

    const execPath = result.stdout.trim();
    return path.isAbsolute(execPath) ? execPath : null;
  } catch {
    return null;
  }
}

function resolveElectronNodeExec(): NodeExec | null {
  const electronNodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (!canExecuteAsNode(process.execPath, electronNodeEnv)) {
    return null;
  }

  return { execPath: process.execPath, env: electronNodeEnv };
}

function resolvePackagedNodeExec(): NodeExec {
  const electronNodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  const candidates: NodeExec[] = [];
  const helperExec = getMacHelperExecPath();
  if (helperExec) {
    candidates.push({ execPath: helperExec, env: electronNodeEnv });
  }

  // Prefer system node before falling back to app binary to avoid spawning
  // additional dock apps on macOS.
  candidates.push({ execPath: 'node', env: { ...process.env } });
  candidates.push({ execPath: process.execPath, env: electronNodeEnv });

  for (const candidate of candidates) {
    if (canExecuteAsNode(candidate.execPath, candidate.env)) {
      return candidate;
    }
  }

  // Last-resort fallback
  return { execPath: process.execPath, env: electronNodeEnv };
}

/**
 * Returns the correct node executable + env for spawning child processes.
 *
 * - Dev mode: system `node`
 * - Packaged mode: Electron helper binary (macOS) or main binary, with `ELECTRON_RUN_AS_NODE=1`
 */
export function getNodeExec(): NodeExec {
  if (!app.isPackaged) {
    return { execPath: 'node', env: { ...process.env } };
  }

  if (cachedNodeExec) {
    return cachedNodeExec;
  }

  cachedNodeExec = resolvePackagedNodeExec();
  return cachedNodeExec;
}

/**
 * Returns a launchable executable for external MCP clients.
 *
 * In dev mode we prefer an absolute Node path so GUI-launched tools do not
 * depend on their own PATH setup. In packaged mode we prefer the bundled
 * Electron/Helper runtime over an arbitrary system node version.
 */
export function getExternalNodeExec(): NodeExec {
  if (!app.isPackaged) {
    const systemNodePath = resolveAbsoluteSystemNodePath();
    if (systemNodePath && canExecuteAsNode(systemNodePath, { ...process.env })) {
      return { execPath: systemNodePath, env: { ...process.env } };
    }

    const electronNodeExec = resolveElectronNodeExec();
    if (electronNodeExec) {
      return electronNodeExec;
    }
  } else {
    const bundledNodeExec = getNodeExec();
    if (bundledNodeExec.execPath !== 'node') {
      return bundledNodeExec;
    }

    const electronNodeExec = resolveElectronNodeExec();
    if (electronNodeExec) {
      return electronNodeExec;
    }
  }

  return getNodeExec();
}

// ---------------------------------------------------------------------------
// Derived convenience paths — workspace-relative
// ---------------------------------------------------------------------------

export function getConfigPath(): string | null {
  if (!projectRoot) return null;
  return path.join(projectRoot, 'coredoc.config.json');
}

export function getEnvPath(): string | null {
  if (!projectRoot) return null;
  return path.join(projectRoot, '.env');
}

// ---------------------------------------------------------------------------
// Binary paths — resources-relative
// ---------------------------------------------------------------------------

export function getCliPath(): string | null {
  if (app.isPackaged) {
    const runtimeCandidates = getBundledRuntimeDirs().map((dir) =>
      path.join(dir, 'packages', 'cli', 'dist', 'index.js'),
    );
    const legacyCandidates = getPackagedResourceRoots().map((root) =>
      path.join(root, 'node_modules', '@coredoc', 'cli', 'dist', 'index.js'),
    );
    return firstExistingPath([...runtimeCandidates, ...legacyCandidates]);
  }

  const root = getResourcesRoot();
  return firstExistingPath([
    path.join(root, 'dist', 'runtime', 'packages', 'cli', 'dist', 'index.js'),
    path.join(root, 'packages', 'cli', 'dist', 'index.js'),
  ]);
}

export function getMcpServerPath(): string | null {
  if (app.isPackaged) {
    const runtimeCandidates = getBundledRuntimeDirs().map((dir) =>
      path.join(dir, 'packages', 'mcp', 'dist', 'index.js'),
    );
    const legacyCandidates = getPackagedResourceRoots().map((root) =>
      path.join(root, 'node_modules', '@coredoc', 'mcp', 'dist', 'index.js'),
    );
    return firstExistingPath([...runtimeCandidates, ...legacyCandidates]);
  }

  const root = getResourcesRoot();
  return firstExistingPath([
    path.join(root, 'dist', 'runtime', 'packages', 'mcp', 'dist', 'index.js'),
    path.join(root, 'packages', 'mcp', 'dist', 'index.js'),
  ]);
}

export function getReferenceDir(): string | null {
  if (!app.isPackaged) return null;
  const candidates = getBundledRuntimeDirs().map((dir) => path.join(dir, 'reference'));
  return firstExistingPath(candidates);
}

/**
 * Resolve the profile-authoring kit dir (the author-profile skill + bundled schema refs).
 * Packaged: copied under dist/runtime/authoring-kit (asar-unpacked so the child claude
 * process can read it). Dev: the monorepo skill dir is used directly.
 */
export function getAuthoringKitDir(): string | null {
  if (app.isPackaged) {
    return firstExistingPath(getBundledRuntimeDirs().map((dir) => path.join(dir, 'authoring-kit')));
  }
  try {
    return firstExistingPath([path.join(requireProjectRoot(), 'skills', 'author-profile')]);
  } catch {
    return null;
  }
}

export function getRuntimeNodeModulesDir(): string | null {
  if (!app.isPackaged) return null;
  // afterPack hook renames _vendor → node_modules, but check both for robustness
  const candidates = getBundledRuntimeDirs().flatMap((dir) => [
    path.join(dir, 'node_modules'),
    path.join(dir, '_vendor'),
  ]);
  return firstExistingPath(candidates);
}

/**
 * Resolve a `@coredoc/profile-parser` package directory that carries its type declarations.
 *
 * Same root cause as the WASM dir below: `@coredoc/*` is esbuilt into the parse worker, so the
 * profile typecheck gate cannot find its own package on disk (the nearest package.json above the
 * bundle is electron-vite's `{"type":"commonjs"}` stub). It compiles the authored profile against
 * `dist/index.d.ts`, so a copy WITH declarations is required — packaging keeps them via the
 * dedicated `from: dist/runtime` matcher in build.files. Returns null if none is found; the gate
 * then throws its own error naming the env var.
 */
export function getProfileParserSchemaDir(): string | null {
  const candidates: string[] = [];
  if (app.isPackaged) {
    for (const runtimeDir of getBundledRuntimeDirs()) {
      // afterPack renames _vendor → node_modules; check both, plus the packages/ copy.
      candidates.push(
        path.join(runtimeDir, 'node_modules', '@coredoc', 'profile-parser'),
        path.join(runtimeDir, '_vendor', '@coredoc', 'profile-parser'),
        path.join(runtimeDir, 'packages', 'profile-parser'),
      );
    }
  } else {
    candidates.push(path.join(DEV_ROOT, 'packages', 'profile-parser'));
  }

  return (
    candidates.find(
      (dir) => fs.existsSync(path.join(dir, 'dist', 'index.d.ts')) || fs.existsSync(path.join(dir, 'src', 'index.ts')),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Tree-sitter WASM (substrate engine)
// ---------------------------------------------------------------------------

let cachedWasmDir: string | null | undefined;

/**
 * Resolve the published grammar directory and the core `web-tree-sitter.wasm`
 * (from web-tree-sitter). Dev resolves from the monorepo's installed packages; packaged reads the
 * bundled `dist/runtime/{_vendor,node_modules}` copy.
 */
function resolveTreeSitterWasmSources(): { grammarDir: string; coreWasm: string; csharpWasm: string } | null {
  if (!app.isPackaged) {
    try {
      // Anchor resolution at @coredoc/profile-parser — the bundled main process cannot
      // resolve these data packages from its own location.
      const req = createRequire(path.join(DEV_ROOT, 'packages', 'profile-parser', 'package.json'));
      const grammarDir = path.join(path.dirname(req.resolve('@cursorless/tree-sitter-wasms/package.json')), 'out');
      const coreWasm = req.resolve('web-tree-sitter/web-tree-sitter.wasm');
      const csharpWasm = req.resolve('tree-sitter-c-sharp/tree-sitter-c_sharp.wasm');
      if (fs.existsSync(grammarDir) && fs.existsSync(coreWasm) && fs.existsSync(csharpWasm)) {
        return { grammarDir, coreWasm, csharpWasm };
      }
    } catch {
      /* fall through to null */
    }
    return null;
  }

  for (const runtimeDir of getBundledRuntimeDirs()) {
    // afterPack renames _vendor → node_modules; check both.
    for (const mods of ['_vendor', 'node_modules']) {
      const grammarDir = path.join(runtimeDir, mods, '@cursorless', 'tree-sitter-wasms', 'out');
      const coreWasm = path.join(runtimeDir, mods, 'web-tree-sitter', 'web-tree-sitter.wasm');
      const csharpWasm = path.join(runtimeDir, mods, 'tree-sitter-c-sharp', 'tree-sitter-c_sharp.wasm');
      if (fs.existsSync(grammarDir) && fs.existsSync(coreWasm) && fs.existsSync(csharpWasm)) {
        return { grammarDir, coreWasm, csharpWasm };
      }
    }
  }
  return null;
}

function copyWasmIfNeeded(src: string, dst: string): void {
  const srcStat = fs.statSync(src);
  if (fs.existsSync(dst)) {
    const dstStat = fs.statSync(dst);
    if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) return;
  }
  fs.copyFileSync(src, dst);
}

/**
 * Ensure a single directory holds every tree-sitter WASM the substrate engine needs — the core
 * `web-tree-sitter.wasm` plus the language grammars — and return it.
 *
 * Why: `@coredoc/*` (including the tree-sitter loader) is bundled into the parse worker, but the
 * `tree-sitter-wasms` / `web-tree-sitter` data packages are NOT resolvable from the bundle's
 * location, so the loader's `getWasmDir()` throws and every file fails structural parse (only
 * WASM-independent Prisma entities survive). Pointing `COREDOC_TREESITTER_WASM_DIR` at this combined
 * dir satisfies both `getWasmDir()` (grammars) and the core wasm's last-resort `join(wasmDir,
 * 'web-tree-sitter.wasm')` lookup. Returns null if the source wasms can't be located.
 */
export function ensureTreeSitterWasmDir(): string | null {
  if (cachedWasmDir !== undefined) return cachedWasmDir;

  const sources = resolveTreeSitterWasmSources();
  if (!sources) {
    cachedWasmDir = null;
    return null;
  }

  const dest = path.join(app.getPath('userData'), 'tree-sitter-wasm');
  try {
    fs.mkdirSync(dest, { recursive: true });
    copyWasmIfNeeded(sources.coreWasm, path.join(dest, 'web-tree-sitter.wasm'));
    for (const file of fs.readdirSync(sources.grammarDir)) {
      if (file.endsWith('.wasm') && file !== 'tree-sitter-c_sharp.wasm')
        copyWasmIfNeeded(path.join(sources.grammarDir, file), path.join(dest, file));
    }
    copyWasmIfNeeded(sources.csharpWasm, path.join(dest, 'tree-sitter-c_sharp.wasm'));
    cachedWasmDir = dest;
  } catch {
    cachedWasmDir = null;
  }
  return cachedWasmDir;
}

export function getClaudeCodeCliPath(): string | null {
  const roots = app.isPackaged ? getPackagedResourceRoots() : [getResourcesRoot()];

  const nodeModulesCandidates: string[] = [];
  for (const root of roots) {
    // afterPack renames _vendor → node_modules in packaged mode; check both
    nodeModulesCandidates.push(path.join(root, 'dist', 'runtime', 'node_modules'));
    nodeModulesCandidates.push(path.join(root, 'dist', 'runtime', '_vendor'));
    nodeModulesCandidates.push(path.join(root, 'dist', 'runtime', 'packages', 'parser-gen', 'node_modules'));
    nodeModulesCandidates.push(path.join(root, 'node_modules'));
    nodeModulesCandidates.push(path.join(root, 'node_modules', '@coredoc', 'parser-gen', 'node_modules'));
  }

  if (!app.isPackaged) {
    const root = getResourcesRoot();
    nodeModulesCandidates.push(path.join(root, 'apps', 'desktop', 'node_modules'));
    nodeModulesCandidates.push(path.join(root, 'packages', 'parser-gen', 'node_modules'));
  }

  for (const nodeModulesRoot of nodeModulesCandidates) {
    const cliPath = findClaudeCliInNodeModules(nodeModulesRoot);
    if (cliPath) {
      return cliPath;
    }
  }

  return null;
}

/** Resolve a compatible Codex CLI installed by the desktop user. */
export function getCodexCliPath(): string | null {
  cachedCodexCliPath ??= resolveSystemCodexCliPath({
    pathValue: process.env.PATH,
    homeDir: app.getPath('home'),
  });
  return cachedCodexCliPath;
}
