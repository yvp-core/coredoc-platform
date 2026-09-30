/**
 * Electron Main Process Entry Point
 */

// MUST stay the first import: this side effect repoints userData at the e2e
// harness profile, and managers below (auth-manager, runtime-paths, docs-manager)
// read app.getPath('userData') at module scope — a later swap is silently
// non-hermetic. No-op unless COREDOC_DESKTOP_E2E=1.
import './e2e-mode-boot.js';
// Second import on purpose: defaults COREDOC_HOME to ~/.coredoc-dev for
// unpackaged runs (after e2e-boot so the e2e predicate sees final env, before
// the managers and initMainTelemetry below so every ~/.coredoc consumer and
// spawned child agrees on the override).
import './coredoc-home-boot.js';
// Third import on purpose: loads the fleet-managed config (pinned server URL /
// update feed) before any manager resolves a server URL or the updater starts.
import './managed-config-boot.js';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { registerConfigHandlers } from './config-manager.js';
import { closeProjectDatabases } from '@coredoc/db';
import { registerStateHandlers } from './state-manager.js';
import { registerCommandHandlers, cancelAllCommands } from './command-runner.js';
import { registerMcpHandlers } from './mcp-bridge.js';
import { registerChatHandlers } from './chat-service.js';
import { registerDialogHandlers } from './dialog-manager.js';
import { registerSessionHandlers } from './session-manager.js';
import { registerDocsHandlers } from './docs-manager.js';
import { registerReviewHandlers } from './review-manager.js';
import { registerGraphHandlers } from './graph-manager.js';
import { registerSettingsHandlers } from './settings-manager.js';
import { registerCliAliasHandlers } from './cli-alias-manager.js';
import {
  registerTelemetryHandlers,
  captureMainException,
  shutdownMainTelemetry,
  initMainTelemetry,
} from './telemetry-manager.js';
import { registerObservabilityHandlers } from './observability-manager.js';
import { registerDeliveryHandlers } from './delivery-manager.js';
import { registerIntentHandlers } from './intent-manager.js';
import { registerWorkspaceHandlers } from './workspace-manager.js';
import { registerLinkedReposHandlers } from './linked-repos-manager.js';
import { registerOnboardingHandlers } from './onboarding-manager.js';
import { registerUpdateHandlers, shutdownUpdateManager } from './update-manager.js';
import { handleAuthCallback, startLogin } from './auth-manager.js';
import { parseCoredocDeepLink } from './deep-link.js';
import { configureDesktopQaDebugging } from './qa-debug.js';
import { isE2EMode } from './e2e-mode.js';
import { registerLinuxAppImageProtocol } from './linux-protocol.js';
import { resolveRendererLoadTarget } from './renderer-load-target.js';
import { resolveMacGit } from './git-runtime.js';
import { config as dotenvConfig } from 'dotenv';
import {
  initProjectRoot,
  getEnvPath,
  getRuntimeNodeModulesDir,
  ensureTreeSitterWasmDir,
  getProfileParserSchemaDir,
} from './runtime-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Ensure the full user shell PATH is loaded.
 * Electron apps launched from Finder/Dock get a minimal PATH that excludes
 * /usr/local/bin, /opt/homebrew/bin, nvm paths, etc. — so `node` is not found.
 * This reads the login shell's PATH to fix that.
 */
function ensureShellPath(): void {
  try {
    const shellBin = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(shellBin, ['-lc', 'echo -n "$PATH"'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result) {
      process.env.PATH = result;
    }
  } catch {
    // Best-effort: if shell fails, keep existing PATH
  }
}

// Fix PATH before anything spawns child processes
ensureShellPath();
if (process.platform === 'darwin') {
  try {
    const git = resolveMacGit();
    process.env.PATH = [git.directory, process.env.PATH].filter(Boolean).join(path.delimiter);
  } catch (error) {
    // Missing Git must not prevent the app opening; parsing reports the setup error.
    console.warn('[Git]', error instanceof Error ? error.message : error);
  }
}

// Initialize the shared telemetry client and mint the desktop session id BEFORE
// the crash hooks below can fire. Sets COREDOC_SESSION_ID / COREDOC_SURFACE on
// process.env so the sdk-worker and CLI spawns (which inherit it) stitch to the
// same session and tag surface:'desktop'. The env PostHog key still wins over
// the bundled one at first emit (workspace .env is loaded later in whenReady).
initMainTelemetry();

let mainWindow: BrowserWindow | null = null;
const pendingDeepLinks: string[] = [];

const PROTOCOL = 'coredoc';

// QA automation is an explicit development-only capability. Chromium binds the
// endpoint to loopback, while the renderer continues to use the real preload,
// IPC handlers, userData directory, and safeStorage-backed login session.
configureDesktopQaDebugging(app.commandLine, process.env, app.isPackaged);

// Protocol-client registration is machine-global state, so an e2e launch must not
// touch it: it would deregister the developer's real coredoc:// handler and point
// it at a throwaway build. The predicate itself is unit-tested in e2e-mode.test.ts;
// this module is side-effect-only wiring and has no unit test of its own.
const IS_E2E = isE2EMode(process.env);

if (!IS_E2E) {
  // Register custom protocol for OAuth deep link callback
  // Remove any stale registration first, then register with this app's binary
  app.removeAsDefaultProtocolClient(PROTOCOL);
  if (process.defaultApp && process.argv.length >= 2) {
    const scriptPath = path.resolve(process.argv[1]!);
    console.log(`[Protocol] Registering ${PROTOCOL}:// → ${process.execPath} ${scriptPath}`);
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [scriptPath]);
  } else {
    console.log(`[Protocol] Registering ${PROTOCOL}:// (packaged mode)`);
    app.setAsDefaultProtocolClient(PROTOCOL);
    // Linux AppImage: setAsDefaultProtocolClient is a no-op without an installed
    // .desktop file. Write one ourselves so coredoc:// can route to this binary.
    void registerLinuxAppImageProtocol(PROTOCOL, 'Coredoc');
  }
}

// Single-instance lock — ensures deep links go to the existing window
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // Handle deep link from second instance (Windows/Linux)
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (url) dispatchDeepLink(url);
    focusMainWindow();
  });

  // Windows and Linux pass a cold-launch protocol URL in the first process's
  // argv. macOS delivers the equivalent through open-url below.
  const initialUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (initialUrl) pendingDeepLinks.push(initialUrl);
}

// Handle deep link on macOS (open-url event)
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith(`${PROTOCOL}://`)) {
    dispatchDeepLink(url);
  }
});

function focusMainWindow(): void {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

function dispatchDeepLink(url: string): void {
  if (!mainWindow) {
    pendingDeepLinks.push(url);
    return;
  }

  void handleDeepLink(url);
}

async function handleDeepLink(url: string): Promise<void> {
  try {
    const deepLink = parseCoredocDeepLink(url);
    focusMainWindow();

    if (deepLink.type === 'auth-callback') {
      await handleAuthCallback(deepLink.url);
      return;
    }

    // Opening the real browser escapes the hermetic boundary (and hijacks the
    // developer's session), so an e2e run fails loudly instead of launching one.
    if (IS_E2E) {
      throw new Error('Interactive login is blocked in E2E mode — refusing to open a browser.');
    }
    const authorizeUrl = await startLogin();
    await shell.openExternal(authorizeUrl);
  } catch (err) {
    console.error('[Protocol] Deep link failed:', err);
  }
}

async function drainPendingDeepLinks(): Promise<void> {
  for (const url of pendingDeepLinks.splice(0)) {
    await handleDeepLink(url);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, '../../resources/icons/icon.png'),
    width: 1400,
    height: 900,
    minWidth: 1300,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
  });

  // No renderer content may spawn a window: an `_blank` link or `window.open`
  // would otherwise load an arbitrary URL as a full BrowserWindow. Outbound
  // links go through the openExternal IPCs, which validate before shell.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const rendererTarget = resolveRendererLoadTarget(app.isPackaged, process.env);
  if (rendererTarget.type === 'url') {
    mainWindow.loadURL(rendererTarget.url);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// Track if handlers have been registered
let handlersRegistered = false;

/**
 * Safely register a single IPC handler group. If registration throws,
 * log the error and continue so other handlers still get registered.
 */
function safeRegister(name: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(`[IPC] Failed to register ${name} handlers:`, error);
  }
}

function registerHandlers(window: BrowserWindow) {
  if (handlersRegistered) return;

  safeRegister('config', () => registerConfigHandlers(ipcMain));
  safeRegister('state', () => registerStateHandlers(ipcMain, window));
  safeRegister('command', () => registerCommandHandlers(ipcMain, window));
  safeRegister('mcp', () => registerMcpHandlers(ipcMain, window));
  safeRegister('chat', () => registerChatHandlers(ipcMain, window));
  safeRegister('dialog', () => registerDialogHandlers(ipcMain));
  safeRegister('session', () => registerSessionHandlers(ipcMain));
  safeRegister('docs', () => registerDocsHandlers(ipcMain));
  safeRegister('review', () => registerReviewHandlers(ipcMain));
  safeRegister('graph', () => registerGraphHandlers(ipcMain));
  safeRegister('settings', () => registerSettingsHandlers(ipcMain));
  safeRegister('cliAlias', () => registerCliAliasHandlers(ipcMain));
  safeRegister('telemetry', () => registerTelemetryHandlers(ipcMain));
  safeRegister('observability', () => registerObservabilityHandlers(ipcMain));
  safeRegister('delivery', () => registerDeliveryHandlers(ipcMain));
  safeRegister('intent', () => registerIntentHandlers(ipcMain));
  safeRegister('workspace', () => registerWorkspaceHandlers(window));
  safeRegister('linkedRepos', () => registerLinkedReposHandlers());
  safeRegister('onboarding', () => registerOnboardingHandlers());
  safeRegister('update', () => registerUpdateHandlers(ipcMain, window));
  // Cloud docs are handled via command-runner.ts (command === 'cloud-docs')

  // Shell handlers
  safeRegister('shell', () => {
    ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
      return shell.openPath(filePath);
    });
    ipcMain.handle('shell:showItemInFolder', (_event, filePath: string) => {
      shell.showItemInFolder(filePath);
    });
  });

  handlersRegistered = true;
}

app
  .whenReady()
  .then(async () => {
    try {
      await initProjectRoot();
    } catch (error) {
      console.error('[Startup] initProjectRoot failed:', error);
      // Continue anyway — handlers can still be registered, just without a workspace
    }

    try {
      // Load general workspace configuration; harness launchers separately isolate credentials per selected provider.
      const envPath = getEnvPath();
      if (envPath) {
        dotenvConfig({ path: envPath });
      }
    } catch (error) {
      console.error('[Startup] dotenv config failed:', error);
    }

    // Ladybug is the local default: it is cypher-capable (the explorer's "Ask the
    // graph" box is gated on that) and passes the graph SLOs sqlite missed. sqlite
    // remains available as rollback via COREDOC_DB_BACKEND=sqlite; neo4j is an
    // explicit opt-in. An explicitly set env — including one loaded from the
    // workspace .env above — always wins; only the unset case defaults here.
    if (!process.env.COREDOC_DB_BACKEND) {
      process.env.COREDOC_DB_BACKEND = 'ladybug';
    }

    // Deliberately NOT setting COREDOC_SQLITE_URL to a workspace-wide file.
    // Graph databases are per project (`{workspace}/coredoc.db.d/{id}.db`):
    // node ids embed only the repo name's hash, so one shared file lets a repo
    // named the same in two projects overwrite the other's rows. Readers go
    // through `openProjectDatabase(configDir, projectId)` and writers through
    // the worker env in command-runner, both keyed by the project they serve.
    // A process-global default here would silently pin every one of them back
    // to a single file and quietly undo that. Ambient URL pins are ignored by
    // project-bound readers and overwritten for command workers.

    // In packaged mode, parser-loader needs COREDOC_RUNTIME_MODULES to rewrite
    // bare specifier imports (e.g. '@coredoc/core') to absolute file:// URLs.
    // Set early so getNodeExec() caches a snapshot that includes it.
    const runtimeModulesDir = getRuntimeNodeModulesDir();
    if (runtimeModulesDir && !process.env.COREDOC_RUNTIME_MODULES) {
      process.env.COREDOC_RUNTIME_MODULES = runtimeModulesDir;
    }

    // The parse worker (and score/summarize subprocesses) run the tree-sitter+SCIP substrate, but
    // the bundled @coredoc engine can't resolve the tree-sitter-wasms / web-tree-sitter data
    // packages from its location — so point it at a combined WASM dir. Set before getNodeExec()
    // snapshots the env and before any parse can run; the worker inherits process.env.
    if (!process.env.COREDOC_TREESITTER_WASM_DIR) {
      const wasmDir = ensureTreeSitterWasmDir();
      if (wasmDir) {
        process.env.COREDOC_TREESITTER_WASM_DIR = wasmDir;
      } else {
        console.error('[Startup] Could not locate tree-sitter WASM files — structural parsing will fail.');
      }
    }

    // Same bundling problem, different data: the profile typecheck gate compiles the authored
    // profile against @coredoc/profile-parser's own `dist/index.d.ts`, which the bundled engine
    // cannot find from its location. Without this, `parse` fails on every profile.
    if (!process.env.COREDOC_PROFILE_SCHEMA_DIR) {
      const schemaDir = getProfileParserSchemaDir();
      if (schemaDir) {
        process.env.COREDOC_PROFILE_SCHEMA_DIR = schemaDir;
      } else {
        console.error('[Startup] Could not locate the profile-parser schema — parsing will fail the typecheck gate.');
      }
    }

    // Set dock icon (needed for dev mode on macOS)
    if (process.platform === 'darwin') {
      const iconPath = path.join(__dirname, '../../resources/icons/icon.png');
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty() && app.dock) app.dock.setIcon(icon);
    }

    const window = createWindow();

    try {
      registerHandlers(window);
    } catch (error) {
      console.error('[Startup] registerHandlers failed:', error);
      dialog.showErrorBox(
        'Coredoc Startup Error',
        `Failed to register IPC handlers: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await drainPendingDeepLinks();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        // Update handlers to use new window for state/command events
        // Note: Config handlers don't need window reference
      }
    });
  })
  .catch((error) => {
    console.error('[Startup] Fatal startup error:', error);
    dialog.showErrorBox(
      'Coredoc Fatal Error',
      `Application failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

app.on('window-all-closed', () => {
  // Product behavior: closing the last window should fully exit the app,
  // including on macOS (no lingering dock icon).
  app.quit();
});

/** Set once the shutdown drain has run, so the re-entered quit goes through. */
let graphConnectionsClosed = false;

app.on('before-quit', (event) => {
  cancelAllCommands();
  shutdownUpdateManager();
  if (graphConnectionsClosed) return;

  // The pool holds one connection per project the user opened; without this
  // each one dies with the process, leaving its WAL un-checkpointed.
  //
  // Closing is async, so the quit has to be held: firing this without waiting
  // let Electron tear the process down first and never actually checkpointed
  // anything, which is the whole point of doing it here.
  event.preventDefault();
  closeProjectDatabases()
    .catch(() => {
      /* best-effort on the way out */
    })
    .finally(() => {
      graphConnectionsClosed = true;
      app.quit();
    });
});

// Handle uncaught exceptions — log locally and forward to PostHog so we get
// stack traces from production crashes (respects telemetry opt-in).
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  captureMainException(error, { source: 'uncaughtException' }).catch(() => {
    /* swallowed */
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  captureMainException(reason, { source: 'unhandledRejection' }).catch(() => {
    /* swallowed */
  });
});

app.on('before-quit', () => {
  shutdownMainTelemetry().catch(() => {
    /* swallowed */
  });
});
