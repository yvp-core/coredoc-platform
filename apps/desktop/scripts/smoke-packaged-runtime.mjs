/**
 * Smoke test for packaged desktop app runtime.
 *
 * Usage:
 *   node ./scripts/smoke-packaged-runtime.mjs --pre   # Pre-packaging checks (after pnpm build)
 *   node ./scripts/smoke-packaged-runtime.mjs --post   # Post-packaging checks (after electron-builder)
 *
 * Exits with code 0 if all checks pass, 1 otherwise.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');

const mode = process.argv.includes('--post') ? 'post' : 'pre';
// The overrides keep release-layout regressions testable on any CI host without
// changing the production defaults used by the packaging jobs.
const smokePlatform = process.env.COREDOC_SMOKE_PLATFORM ?? process.platform;

let passed = 0;
let failed = 0;
const failures = [];

function safeReaddir(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function recordFailure(name, error) {
  failed++;
  const msg = error instanceof Error ? error.message : String(error);
  failures.push({ name, error: msg });
  console.log(`  \u2717 ${name}: ${msg}`);
}

function withRuntimeNodeModules(runtimeRoot, fn) {
  const vendorDir = path.join(runtimeRoot, '_vendor');
  const nodeModulesDir = path.join(runtimeRoot, 'node_modules');
  const renamed = existsSync(vendorDir) && !existsSync(nodeModulesDir);
  if (renamed) renameSync(vendorDir, nodeModulesDir);
  try {
    return fn();
  } finally {
    if (renamed) renameSync(nodeModulesDir, vendorDir);
  }
}

function check(name, fn) {
  try {
    const result = fn();
    if (result === false) {
      throw new Error('Check returned false');
    }
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    recordFailure(name, err);
  }
}

function checkBundledScore(parseEntry, runtimeRoot) {
  check('bundled authoring scorer executes TS source and structural checks', () => {
    withRuntimeNodeModules(runtimeRoot, () => {
      const fixture = mkdtempSync(path.join(tmpdir(), 'coredoc-desktop-score-smoke-'));
      try {
        const repo = path.join(fixture, 'repo');
        mkdirSync(repo);
        writeFileSync(path.join(repo, 'index.ts'), 'export function greet() { return "hello"; }\n');
        const profilePath = path.join(fixture, 'profile.ts');
        writeFileSync(
          profilePath,
          `export default {
          parserId: 'smoke/desktop-score', repoType: 'backend',
          substrate: { language: 'ts', include: ['**/*.ts'] },
        };\n`,
        );
        const modules = path.join(runtimeRoot, 'node_modules');
        const wasm = path.join(fixture, 'wasm');
        mkdirSync(wasm);
        copyFileSync(
          path.join(modules, 'web-tree-sitter', 'web-tree-sitter.wasm'),
          path.join(wasm, 'web-tree-sitter.wasm'),
        );
        for (const language of ['typescript', 'tsx', 'javascript']) {
          const name = `tree-sitter-${language}.wasm`;
          copyFileSync(path.join(modules, '@cursorless', 'tree-sitter-wasms', 'out', name), path.join(wasm, name));
        }
        const result = spawnSync(process.execPath, [parseEntry], {
          cwd: fixture,
          input: JSON.stringify({ command: 'score-profile', profilePath, repoRoot: repo }),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: fixture,
            TMPDIR: fixture,
            COREDOC_TELEMETRY_DISABLED: '1',
            COREDOC_RUNTIME_MODULES: modules,
            COREDOC_PROFILE_SCHEMA_DIR: path.join(modules, '@coredoc', 'profile-parser'),
            COREDOC_TREESITTER_WASM_DIR: wasm,
          },
        });
        const protocol = String(result.output[3] ?? '');
        if (
          result.error ||
          result.status !== 0 ||
          !protocol.includes('"success":true') ||
          !result.stdout?.includes('=== Profile completion: PASS ===')
        ) {
          throw new Error(
            `${result.error?.message ?? 'Bundled score failed'}\n${protocol}\n${result.stderr}\n${result.stdout}`,
          );
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Pre-packaging checks (run after `pnpm run build`)
// ---------------------------------------------------------------------------

function runPreChecks() {
  console.log('\n=== Pre-packaging smoke test ===\n');

  const runtimeRoot = path.join(desktopDir, 'dist', 'runtime');

  // 1. dist/runtime/ exists
  check('dist/runtime/ directory exists', () => {
    if (!existsSync(runtimeRoot)) throw new Error(`Not found: ${runtimeRoot}`);
  });

  // 2. CLI entrypoint exists
  const cliEntry = path.join(runtimeRoot, 'packages', 'cli', 'dist', 'index.js');
  check('CLI entrypoint exists', () => {
    if (!existsSync(cliEntry)) throw new Error(`Not found: ${cliEntry}`);
  });

  // 3. CLI --help executes (against the vendored runtime layout).
  // In the packaged app the afterPack hook renames _vendor → node_modules next to the
  // CLI, so its bare imports resolve from there. Mirror that here for the duration of the
  // check: the repo-root node_modules does NOT carry non-hoisted CLI deps (e.g. the
  // ai-sdk provider packages), so resolving against it would be a false negative.
  check('CLI --help executes successfully', () => {
    withRuntimeNodeModules(runtimeRoot, () => {
      execFileSync('node', [cliEntry, '--help'], {
        timeout: 15_000,
        stdio: 'pipe',
        cwd: repoRoot,
      });
    });
  });

  // 4. MCP server entrypoint exists
  const mcpEntry = path.join(runtimeRoot, 'packages', 'mcp', 'dist', 'index.js');
  check('MCP server entrypoint exists', () => {
    if (!existsSync(mcpEntry)) throw new Error(`Not found: ${mcpEntry}`);
  });

  // 5. MCP server responds to JSON-RPC initialize
  check('MCP server responds to initialize handshake', () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), 'coredoc-desktop-mcp-smoke-'));
    const projectId = 'smoke-project';
    const repoName = 'smoke-repo';
    const configPath = path.join(fixtureDir, 'coredoc.config.json');
    const fixtureEnv = {
      ...process.env,
      COREDOC_DB_BACKEND: 'sqlite',
      COREDOC_SCOPE: `project:${projectId}`,
      COREDOC_SMOKE_FIXTURE_DIR: fixtureDir,
      COREDOC_TELEMETRY_DISABLED: '1',
      MCP_CONFIG_PATH: configPath,
    };
    // Project routing owns the database path; an ambient legacy pin must not
    // redirect this fixture or make the smoke depend on a developer machine.
    delete fixtureEnv.COREDOC_SQLITE_URL;
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [
          {
            id: projectId,
            name: 'Smoke Project',
            repos: [{ name: repoName, path: './smoke-repo', type: 'backend' }],
          },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
      }),
    );

    const initRequest =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0.0' },
        },
      }) + '\n';

    try {
      withRuntimeNodeModules(runtimeRoot, () => {
        const dbEntry = path.join(runtimeRoot, 'packages', 'db', 'dist', 'index.js');
        const setupScript = `
          import { closeProjectDatabases, NodeType, openProjectDatabase } from ${JSON.stringify(pathToFileURL(dbEntry).href)};
          const database = await openProjectDatabase(process.env.COREDOC_SMOKE_FIXTURE_DIR, ${JSON.stringify(projectId)});
          await database.graph.pushNodes([{
            id: '000000000000',
            type: NodeType.Repository,
            name: ${JSON.stringify(repoName)},
            properties: { type: 'backend' },
            filePath: ''
          }]);
          await closeProjectDatabases();
        `;
        execFileSync('node', ['--input-type=module', '-e', setupScript], {
          timeout: 15_000,
          stdio: 'pipe',
          cwd: fixtureDir,
          env: fixtureEnv,
        });

        const result = execFileSync('node', [mcpEntry], {
          input: initRequest,
          timeout: 15_000,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: fixtureDir,
          env: fixtureEnv,
        });
        const stdout = result.toString();
        if (!stdout.includes('"result"') || !stdout.includes('"serverInfo"')) {
          throw new Error(`Unexpected MCP response: ${stdout.slice(0, 200)}`);
        }
      });
    } catch (err) {
      if (err.stdout) {
        const out = err.stdout.toString();
        if (out.includes('"result"') && out.includes('"serverInfo"')) return; // OK
      }
      throw new Error(`MCP initialize failed: ${err.message}`);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  // 7. _vendor directory exists
  const vendorDir = path.join(runtimeRoot, '_vendor');
  check('_vendor/ directory exists', () => {
    if (!existsSync(vendorDir)) throw new Error(`Not found: ${vendorDir}`);
  });

  // 8. @coredoc/* packages exist in _vendor (parser-gen/docs-gen removed in the reseed;
  //    profile-parser is the parse engine the vendored CLI loads at runtime)
  const coredocPackages = ['cli', 'mcp', 'core', 'db', 'profile-parser'];
  for (const pkg of coredocPackages) {
    check(`_vendor/@coredoc/${pkg} exists`, () => {
      const pkgDir = path.join(vendorDir, '@coredoc', pkg);
      if (!existsSync(pkgDir)) throw new Error(`Not found: ${pkgDir}`);
    });
  }

  // 9. Key external deps exist in _vendor (web-tree-sitter is the profile-parser
  //    parse-engine runtime dep — assert it is vendored so parse works in the packaged app)
  const criticalDeps = ['commander', 'dotenv', 'web-tree-sitter'];
  for (const dep of criticalDeps) {
    check(`_vendor/${dep} exists`, () => {
      const depDir = path.join(vendorDir, dep);
      if (!existsSync(depDir)) throw new Error(`Not found: ${depDir}`);
    });
  }

  // 9b. Profile typecheck schema is present in the staged runtime. `coredoc profile score`
  //     compiles the authored profile against these declarations; without them the scorer
  //     throws instead of scoring, which is what the packaged app hit when electron-builder's
  //     built-in `d.ts` exclusion stripped them.
  for (const rel of [
    ['_vendor', '@coredoc', 'profile-parser', 'dist', 'index.d.ts'],
    ['_vendor', 'typescript', 'lib', 'lib.es2022.d.ts'],
  ]) {
    check(`type declarations staged: ${path.join(...rel)}`, () => {
      const p = path.join(runtimeRoot, ...rel);
      if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    });
  }

  // 10. Main process output exists
  check('main process output exists', () => {
    const mainEntry = path.join(desktopDir, 'dist', 'main', 'index.js');
    if (!existsSync(mainEntry)) throw new Error(`Not found: ${mainEntry}`);
  });

  // 11. SDK worker output exists
  check('SDK worker output exists', () => {
    const workerEntry = path.join(desktopDir, 'dist', 'main', 'sdk-worker.js');
    if (!existsSync(workerEntry)) throw new Error(`Not found: ${workerEntry}`);
  });

  // 12. Generated profiles are imported only by this separately sandboxed process entry.
  check('sandboxed parse child output exists', () => {
    const parseEntry = path.join(desktopDir, 'dist', 'main', 'sdk-parse-child.js');
    if (!existsSync(parseEntry)) throw new Error(`Not found: ${parseEntry}`);
  });
  checkBundledScore(path.join(desktopDir, 'dist', 'main', 'sdk-parse-child.js'), runtimeRoot);
}

// ---------------------------------------------------------------------------
// Post-packaging checks (run after electron-builder)
// ---------------------------------------------------------------------------

function runPostChecks() {
  console.log('\n=== Post-packaging smoke test ===\n');

  // Find the packaged app
  const distElectron = process.env.COREDOC_SMOKE_DIST_ELECTRON
    ? path.resolve(desktopDir, process.env.COREDOC_SMOKE_DIST_ELECTRON)
    : path.join(desktopDir, 'dist-electron');
  if (!existsSync(distElectron)) {
    recordFailure('packaged output directory exists', `Not found: ${distElectron} — run electron-builder first`);
    return;
  }

  // Find platform-specific resources dir.
  // Search per-platform subdirectories first (dist-electron/mac/, dist-electron/win/,
  // dist-electron/linux/), then fall back to the flat layout (dist-electron/).
  let resourcesDir = null;
  if (smokePlatform === 'darwin') {
    // Look for <App>.app/Contents/Resources
    const macSearchDirs = [
      path.join(distElectron, 'macOS-arm64', 'mac-arm64'),
      path.join(distElectron, 'macOS-arm64', 'mac'),
      path.join(distElectron, 'macOS-arm64'),
      path.join(distElectron, 'macOS-x64', 'mac-x64'),
      path.join(distElectron, 'macOS-x64', 'mac'),
      path.join(distElectron, 'macOS-x64'),
      path.join(distElectron, 'mac', 'mac-arm64'),
      path.join(distElectron, 'mac', 'mac'),
      path.join(distElectron, 'mac'),
      path.join(distElectron, 'mac-arm64'),
      path.join(distElectron, 'mac-x64'),
      distElectron,
    ];
    for (const searchDir of macSearchDirs) {
      if (!existsSync(searchDir)) continue;
      const apps = safeReaddir(searchDir).filter((e) => e.endsWith('.app'));
      if (apps.length > 0) {
        resourcesDir = path.join(searchDir, apps[0], 'Contents', 'Resources');
        break;
      }
    }
  } else if (smokePlatform === 'linux') {
    const linuxCandidates = [
      ...safeReaddir(path.join(distElectron, 'linux'))
        .filter((e) => e.match(/^linux-.*-unpacked$/))
        .map((e) => path.join(distElectron, 'linux', e, 'resources')),
      ...safeReaddir(distElectron)
        .filter((e) => e.match(/^linux-.*-unpacked$/))
        .map((e) => path.join(distElectron, e, 'resources')),
    ];
    resourcesDir = linuxCandidates.find((d) => existsSync(d)) ?? null;
  } else {
    const winCandidates = [
      path.join(distElectron, 'win', 'win-unpacked', 'resources'),
      path.join(distElectron, 'win-unpacked', 'resources'),
    ];
    resourcesDir = winCandidates.find((d) => existsSync(d)) ?? null;
  }

  if (!resourcesDir || !existsSync(resourcesDir)) {
    recordFailure(
      'packaged resources directory found',
      `Could not find a packaged resources directory in ${distElectron}`,
    );
    return;
  }

  console.log(`  Resources dir: ${resourcesDir}\n`);

  // 1. ASAR exists
  const asarPath = path.join(resourcesDir, 'app.asar');
  check('app.asar exists', () => {
    if (!existsSync(asarPath)) throw new Error(`Not found: ${asarPath}`);
  });

  // 2. Unpacked dir exists
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  check('app.asar.unpacked/ exists', () => {
    if (!existsSync(unpackedDir)) throw new Error(`Not found: ${unpackedDir}`);
  });

  // 3. Runtime in unpacked
  const unpackedRuntime = path.join(unpackedDir, 'dist', 'runtime');
  check('dist/runtime/ in unpacked dir', () => {
    if (!existsSync(unpackedRuntime)) throw new Error(`Not found: ${unpackedRuntime}`);
  });

  // 4. _vendor → node_modules rename succeeded
  const runtimeNodeModules = path.join(unpackedRuntime, 'node_modules');
  const runtimeVendor = path.join(unpackedRuntime, '_vendor');
  check('_vendor renamed to node_modules in unpacked', () => {
    if (existsSync(runtimeVendor) && !existsSync(runtimeNodeModules)) {
      throw new Error('_vendor still exists, node_modules not found — afterPack may have failed');
    }
    if (!existsSync(runtimeNodeModules)) {
      throw new Error(`Neither _vendor nor node_modules found in ${unpackedRuntime}`);
    }
  });

  // 5. CLI entry in unpacked
  check('CLI entrypoint in unpacked', () => {
    const cli = path.join(unpackedRuntime, 'packages', 'cli', 'dist', 'index.js');
    if (!existsSync(cli)) throw new Error(`Not found: ${cli}`);
  });

  // 7. MCP entry in unpacked
  check('MCP server entrypoint in unpacked', () => {
    const mcp = path.join(unpackedRuntime, 'packages', 'mcp', 'dist', 'index.js');
    if (!existsSync(mcp)) throw new Error(`Not found: ${mcp}`);
  });

  check('Codex SDK is not packaged', () => {
    const sdkPath = path.join(unpackedDir, 'node_modules', '@openai', 'codex-sdk');
    if (existsSync(sdkPath)) throw new Error(`Unexpected bundled Codex SDK: ${sdkPath}`);
  });

  check('Codex native runtime is not packaged', () => {
    const openaiDir = path.join(unpackedDir, 'node_modules', '@openai');
    const bundledCodex = safeReaddir(openaiDir).filter((name) => name === 'codex' || name.startsWith('codex-'));
    if (bundledCodex.length > 0) throw new Error(`Unexpected bundled Codex packages: ${bundledCodex.join(', ')}`);
  });

  // 8. Type declarations survived packaging. electron-builder strips `*.d.ts` by default
  //    (`excludedExts`), which silently disarms the profile typecheck gate: the app packages
  //    and launches fine, then `coredoc profile score` throws mid-authoring. The dedicated
  //    `from: dist/runtime` matcher in build.files is what keeps them; this asserts it works.
  for (const rel of [
    ['node_modules', '@coredoc', 'profile-parser', 'dist', 'index.d.ts'],
    ['node_modules', 'typescript', 'lib', 'lib.es2022.d.ts'],
  ]) {
    check(`type declarations packaged: ${path.join(...rel)}`, () => {
      const p = path.join(unpackedRuntime, ...rel);
      if (!existsSync(p)) throw new Error(`Not found: ${p} — electron-builder's d.ts exclusion may have won`);
    });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`Smoke test mode: ${mode}`);

if (mode === 'pre') {
  runPreChecks();
} else {
  runPostChecks();
}

// Summary
console.log(`\n--- Summary: ${passed} passed, ${failed} failed ---`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
