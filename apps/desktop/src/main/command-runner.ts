/**
 * Command Runner - Executes CLI commands via SDK worker thread
 *
 * - `generate` stays in main process (uses SDK orchestrator with structured event streaming)
 * - All other commands run in a worker thread for isolation, cancellation, and main-thread responsiveness
 */

import { IpcMain, BrowserWindow, app } from 'electron';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { prepareDesktopCSharpIndex, CSHARP_EXECUTION_NOTICE } from './csharp-index-host.js';
import { prepareDesktopOptionalIndex, OPTIONAL_EXECUTION_NOTICE } from './optional-index-host.js';
import { validateOptionalIndexRequest } from '@coredoc/profile-parser/optional-index';
import {
  askAnalysisPrompt,
  showAnalysisProgress,
  getAnalysisPrompts,
  answerAnalysisPrompt,
} from './analysis-prompts.js';
import { fileURLToPath } from 'node:url';
import { IpcChannels, CommandRunOptions, CommandRunResult } from '../shared/ipc-types.js';
import { getCurrentConfigPath, getConfigDir, getCurrentConfig, resolveRepoPath } from './config-manager.js';
import { parsedRepoFile, projectDbUrl } from '@coredoc/core/utils';
import {
  formatProfileCapabilityViolations,
  formatProfileDiagnostics,
  profileCapabilityViolations,
  typecheckProfile,
  csharpProvider,
  rubyProvider,
  pythonProvider,
  rustProvider,
  goProvider,
} from '@coredoc/profile-parser';
import { writePty, resizePty, killPty, killAllPtys } from './pty-manager.js';
import { profileArtifactPath } from './parser-artifact.js';
import {
  requireProjectRoot,
  getNodeExec,
  getCliPath as runtimeGetCliPath,
  getClaudeCodeCliPath,
  getCodexCliPath,
  getAuthoringKitDir,
  getEnvPath as runtimeGetEnvPath,
} from './runtime-paths.js';
import { runCloudDocsCommand } from './cloud-docs-manager.js';
import { isE2EMode } from './e2e-mode.js';
import { startAgentRun, registerAgentRunHandlers } from './agent-run/agent-run-service.js';
import { buildCloudChannelConfig } from './telemetry-manager.js';
import { BUNDLED_POSTHOG_KEY, BUNDLED_POSTHOG_HOST } from './build-env.js';
import { buildHarnessEnvironment, readHarnessSettings } from './harness-settings.js';
import { ClaudeAdapter } from './agent-run/claude-adapter.js';
import { CodexAdapter } from './agent-run/codex-adapter.js';
import { buildSystemCodexEnvironment } from './codex-runtime.js';
import { resolveSandboxExecutable, spawnSandboxedParse, type SandboxedParseHandle } from './profile-parse-sandbox.js';
import type { AgentRunCommandResult } from './agent-run/types.js';
import type { AgentRunQuestion } from '../shared/agent-run-types.js';
import { createProfileScoreHost } from './profile-score-host.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Track running command IDs and abort controllers for generate commands
const runningAbortControllers = new Map<string, AbortController>();
// The automatic generate → parse transition consumes the same analysis choice and index.
const generatedAnalysis = new Map<
  string,
  {
    repoPath: string;
    digest: string | null;
    scorer: ReturnType<typeof createProfileScoreHost>;
  }
>();
let commandIdCounter = 0;

// Worker command registry for finalize-once guard
interface CommandExecutorEntry {
  executor: Pick<Worker, 'terminate'> | SandboxedParseHandle;
  mainWindow: BrowserWindow;
  completed: boolean;
}
const workerRegistry = new Map<string, CommandExecutorEntry>();

// Metadata for running commands (readable by renderer after reload).
// `projectId` is REQUIRED so the renderer can scope by project — without it,
// two projects that share a repo name would see each other's running commands.
interface CommandMeta {
  projectId: string;
  repoName: string;
  action: string;
  startedAt: string;
}
const commandMeta = new Map<string, CommandMeta>();

/**
 * Generate unique command ID
 */
function generateCommandId(): string {
  return `cmd-${Date.now()}-${++commandIdCounter}`;
}

/**
 * Remove command metadata entry (called by cloud-docs-manager on success)
 */
export function clearCommandMeta(id: string): void {
  commandMeta.delete(id);
}

// ---------------------------------------------------------------------------
// Worker path (import.meta.url is polyfilled in CJS esbuild output)
// ---------------------------------------------------------------------------

const WORKER_URL = new URL('./sdk-worker.js', import.meta.url);
const PARSE_CHILD_PATH = fileURLToPath(new URL('./sdk-parse-child.js', import.meta.url));

// ---------------------------------------------------------------------------
// Public helpers (kept for docs-manager.ts import)
// ---------------------------------------------------------------------------

/**
 * Get the monorepo root directory (delegates to runtime-paths).
 */
export function getRootDir(): string {
  return requireProjectRoot();
}

/**
 * Find the coredoc CLI executable (delegates to runtime-paths with fallback).
 */
export function findCliExecutable(): string {
  const cliPath = runtimeGetCliPath();
  if (cliPath) return cliPath;

  if (app.isPackaged) {
    throw new Error(
      'Bundled CLI not found in packaged app (expected node_modules/@coredoc/cli/dist/index.js). ' +
        'Rebuild and reinstall the desktop app package.',
    );
  }

  // Fallback: search manually
  const rootDir = getRootDir();
  const candidatePaths = [
    path.join(rootDir, 'packages', 'cli', 'dist', 'index.js'),
    path.join(rootDir, 'dist', 'cli', 'index.js'),
  ];

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(`Coredoc CLI executable not found. Checked: ${candidatePaths.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Worker thread finalization (emit completion exactly once)
// ---------------------------------------------------------------------------

function finalizeCommand(id: string, success: boolean, exitCode: number, error?: string): void {
  const entry = workerRegistry.get(id);
  if (!entry || entry.completed) return; // already finalized
  entry.completed = true;

  const { mainWindow, executor } = entry;
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.PTY_EXIT, { id, exitCode });
    mainWindow.webContents.send(IpcChannels.COMMAND_COMPLETED, {
      id,
      success,
      exitCode,
      ...(error && { error }),
    });
  }
  workerRegistry.delete(id);
  commandMeta.delete(id);

  // Terminate the worker thread to prevent leaks.
  // The 'exit' handler will fire but entry.completed guards against double-finalize.
  executor.terminate();
}

// ---------------------------------------------------------------------------
// SDK Worker execution
// ---------------------------------------------------------------------------

async function runSdkCommand(options: CommandRunOptions, id: string, mainWindow: BrowserWindow): Promise<void> {
  const configPath = getCurrentConfigPath();
  if (!configPath) {
    commandMeta.delete(id);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: '\r\nError: No config loaded\r\n' });
      mainWindow.webContents.send(IpcChannels.PTY_EXIT, { id, exitCode: 1 });
      mainWindow.webContents.send(IpcChannels.COMMAND_COMPLETED, {
        id,
        success: false,
        exitCode: 1,
        error: 'No config loaded',
      });
    }
    throw new Error('No config loaded');
  }

  const { execPath: nodeExecPath, env: nodeEnv } = getNodeExec();
  // Every worker is credential-free by default. Only summarize resolves harness settings and
  // receives the selected provider's credential; parse/push/embed must not depend on AI settings.
  const workerBaseEnv = buildHarnessEnvironment(process.env, {
    provider: 'claude-code',
    authMode: 'subscription',
    credentials: {},
  });
  let harnessProvider: 'claude-code' | 'codex' | undefined;
  let claudeCliPath: string | undefined;
  let codexCliPath: string | undefined;
  let sdkNodeEnv = nodeEnv;
  if (options.command === 'summarize') {
    const envPath = runtimeGetEnvPath() ?? path.join(requireProjectRoot(), '.env');
    const harnessSettings = readHarnessSettings(envPath);
    harnessProvider = harnessSettings.provider;
    sdkNodeEnv = buildHarnessEnvironment(nodeEnv, harnessSettings);
    if (harnessProvider === 'claude-code') {
      claudeCliPath = getClaudeCodeCliPath() ?? undefined;
      if (!claudeCliPath) throw new Error('Claude Code runtime not found in this build.');
    } else {
      codexCliPath = getCodexCliPath() ?? undefined;
      if (!codexCliPath) {
        throw new Error('Compatible system Codex CLI not found. Install or update Codex, then restart Coredoc.');
      }
      sdkNodeEnv = buildSystemCodexEnvironment(sdkNodeEnv, codexCliPath);
    }
  }
  let sqliteUrl: string;
  try {
    sqliteUrl = projectDbUrl(path.dirname(configPath), options.projectId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    commandMeta.delete(id);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: `\r\nError: ${message}\r\n` });
      mainWindow.webContents.send(IpcChannels.PTY_EXIT, { id, exitCode: 1 });
      mainWindow.webContents.send(IpcChannels.COMMAND_COMPLETED, { id, success: false, exitCode: 1, error: message });
    }
    throw error;
  }

  // Worker env (P0.9): spread the MAIN process env — which already carries
  // COREDOC_SESSION_ID + COREDOC_SURFACE='desktop' (set at launch by
  // initMainTelemetry) so the worker's telemetry (parse/summarize/push)
  // stitches to the desktop session — and ALSO inject the bundled PostHog
  // key/host. The bundled key lives ONLY in the desktop main bundle's build-env
  // constant, never in process.env, so without this injection the worker's
  // fresh telemetry module has no key and every parse_completed emit is a silent
  // no-op. A runtime COREDOC_POSTHOG_* env still wins. Extends the P0.8
  // session/surface forwarding — one env block, not two.
  // Ladybug's reader/writer lease is fail-fast and pid-scoped, and the worker
  // is a thread in THIS process: a cached explorer read handle would make the
  // worker's graph write throw "database is locked". Release every cached
  // project handle before handing the database over; explorer IPC reopens
  // lazily on its next call. Best-effort — a failed close surfaces as the
  // worker's own lease error, which is the honest failure anyway.
  try {
    const { closeAllDrivers, closeProjectDatabases } = await import('@coredoc/db');
    await closeProjectDatabases();
    await closeAllDrivers();
  } catch (err) {
    console.warn('[command-runner] pre-worker database release failed:', (err as Error).message);
  }

  const workerMessage = {
    command: options.command,
    configPath,
    ...(options.command !== 'parse' && { cwd: getRootDir() }),
    projectId: options.projectId,
    repo: options.repo,
    args: options.args,
    ...(claudeCliPath && { claudeCliPath }),
    ...(codexCliPath && { codexCliPath }),
    ...(harnessProvider && { harnessProvider }),
    ...(options.command !== 'parse' && { nodeExecPath, nodeEnv: sdkNodeEnv }),
  };

  if (options.command === 'parse') {
    // Workspace-layout migration is trusted host work. Complete it before entering the sandbox so
    // model-authored profile code never receives write access to the parser-storage root.
    const { loadConfig: prepareParseConfig } = await import('@coredoc/cli/sdk');
    prepareParseConfig(configPath);
    const config = getCurrentConfig();
    const configDir = getConfigDir();
    const repoName = options.repo?.trim();
    const repoPath = repoName ? resolveRepoPath(repoName, options.projectId) : undefined;
    if (!config || !configDir || !repoName || !repoPath) {
      throw new Error('A loaded project and repository are required for sandboxed profile parsing.');
    }

    const parserStorageDir = path.resolve(configDir, config.parserStorage);
    const outputArg =
      options.args && !Array.isArray(options.args) && typeof options.args.output === 'string'
        ? options.args.output.trim()
        : '';
    const outputDir = outputArg ? path.resolve(getRootDir(), outputArg) : path.resolve(configDir, config.output.dir);
    if (!sqliteUrl.startsWith('file:')) {
      throw new Error('Sandboxed profile parsing requires a project-owned local database.');
    }
    const databasePath = sqliteUrl.slice('file:'.length);
    const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
    const nodeExecutable = resolveSandboxExecutable(nodeExecPath, nodeEnv);
    const devNodeModules = path.join(getRootDir(), 'node_modules');
    const runtimeBinDirs = [
      ...(fs.existsSync(devNodeModules) ? [path.join(devNodeModules, '.bin')] : []),
      ...(nodeEnv.COREDOC_RUNTIME_MODULES ? [path.join(nodeEnv.COREDOC_RUNTIME_MODULES, '.bin')] : []),
    ];
    // ASAR loading, unpacked native modules and the helper's sibling Electron Framework
    // need physical app roots. Dev symlinks resolve from the built entry, since the
    // selected workspace is not necessarily the app checkout.
    const appRuntimePaths = app.isPackaged
      ? [process.resourcesPath, path.resolve(process.resourcesPath, '../Frameworks')]
      : [
          path.resolve(path.dirname(PARSE_CHILD_PATH), '../../node_modules'),
          path.resolve(path.dirname(PARSE_CHILD_PATH), '../../../../node_modules'),
        ].filter((candidate) => fs.existsSync(candidate));
    const runtimeReadPaths = [
      path.dirname(PARSE_CHILD_PATH),
      ...appRuntimePaths,
      path.resolve(path.dirname(nodeExecutable), '..'),
      ...(fs.existsSync(devNodeModules) ? [devNodeModules] : []),
      ...['COREDOC_RUNTIME_MODULES', 'COREDOC_TREESITTER_WASM_DIR', 'COREDOC_PROFILE_SCHEMA_DIR']
        .map((key) => nodeEnv[key])
        .filter((value): value is string => !!value?.trim()),
    ];
    const profileDir = path.dirname(profileArtifactPath(parserStorageDir, options.projectId, repoName));
    const analysisKey = `${options.projectId}/${repoName}`;
    const generated = generatedAnalysis.get(analysisKey);
    generatedAnalysis.delete(analysisKey);
    const generatedForThisProfile =
      generated?.repoPath === repoPath && generated.digest === profileDigest(path.join(profileDir, 'profile.ts'))
        ? generated.scorer
        : undefined;
    generatedForThisProfile?.beginParse();
    if (generated && !generatedForThisProfile) void generated.scorer.dispose();
    const compiledParserDir = path.resolve(
      path.dirname(parserStorageDir),
      'dist',
      'coredoc-parsers',
      options.projectId,
      repoName,
    );
    const outputFile = parsedRepoFile(outputDir, options.projectId, repoName);
    fs.mkdirSync(compiledParserDir, { recursive: true });
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const envPath = runtimeGetEnvPath();

    // The sandbox child's cwd is its private run directory, so a relative --output can no longer
    // resolve against the workspace root inside the child — resolve it HERE, against the same
    // root the sandbox write policy (outputFile) was computed from.
    const parseMessage = outputArg ? { ...workerMessage, args: { ...options.args, output: outputDir } } : workerMessage;

    const artifactDir = fs.mkdtempSync(path.join(tmpdir(), 'coredoc-desktop-index-'));
    const indexController = new AbortController();
    const analysisChanged = () => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannels.ANALYSIS_CHANGED);
    };
    const indexJobs = new Set<Promise<unknown>>();
    const prepareCompiler = (request: unknown, optionalLanguage?: string) => {
      if (generatedForThisProfile)
        return optionalLanguage
          ? generatedForThisProfile.prepareOptionalIndex(request)
          : generatedForThisProfile.prepareIndex(request);
      let clearProgress: (() => void) | undefined;
      const job = (optionalLanguage ? prepareDesktopOptionalIndex : prepareDesktopCSharpIndex)(request, {
        repoRoot: repoPath,
        artifactDir,
        nodeExecutable,
        sourceEnv: nodeEnv,
        signal: indexController.signal,
        onLog(text) {
          if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: text });
        },
        onProgress(message) {
          clearProgress?.();
          clearProgress = message
            ? showAnalysisProgress(
                { commandId: id, projectId: options.projectId, repoName, language: optionalLanguage, message },
                () => indexController.abort(),
                analysisChanged,
              )
            : undefined;
        },
        ask: (message, canUseBasic, canInstall, phase) =>
          askAnalysisPrompt(
            {
              commandId: id,
              projectId: options.projectId,
              repoName,
              language: optionalLanguage,
              message,
              canUseBasic,
              canInstall,
              phase,
            },
            indexController.signal,
            analysisChanged,
          ),
      });
      indexJobs.add(job);
      void job.finally(() => indexJobs.delete(job)).catch(() => undefined);
      return job;
    };
    let parseHandle: SandboxedParseHandle;
    try {
      parseHandle = spawnSandboxedParse({
        repoRoot: repoPath,
        nodeExecutable,
        childScript: PARSE_CHILD_PATH,
        sourceEnv: nodeEnv,
        runtimeBinDirs,
        databaseUrl: sqliteUrl,
        homeDir: app.getPath('home'),
        readPaths: [
          repoPath,
          profileDir,
          compiledParserDir,
          artifactDir,
          ...(generatedForThisProfile ? [generatedForThisProfile.artifactDir] : []),
          ...runtimeReadPaths,
        ],
        readFiles: [configPath, outputFile, ...databaseFiles],
        writePaths: [compiledParserDir],
        writeFiles: [outputFile, ...databaseFiles],
        deniedReadPaths: [...(envPath ? [envPath] : []), path.join(repoPath, '.env')],
        message: parseMessage,
        prepareCSharpIndex: (request) => prepareCompiler(request),
        prepareOptionalIndex: (request) => prepareCompiler(request, validateOptionalIndexRequest(request).language),
        onLog(text) {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: text });
          }
        },
        onResult(message) {
          if (!message.success && message.error && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: `\r\nError: ${message.error}\r\n` });
          }
          finalizeCommand(id, message.success, message.success ? 0 : 1, message.error);
        },
        onError(error) {
          console.error(`[Command ${id}] Sandboxed parse error:`, error.message);
          finalizeCommand(id, false, 1, error.message);
        },
        onClose(code, signal) {
          if (generatedForThisProfile) void generatedForThisProfile.dispose();
          indexController.abort();
          void Promise.allSettled([...indexJobs]).then(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
          finalizeCommand(id, false, code ?? 1, `Sandboxed parse exited unexpectedly${signal ? ` (${signal})` : ''}`);
        },
      });
    } catch (error) {
      if (generatedForThisProfile) void generatedForThisProfile.dispose();
      indexController.abort();
      fs.rmSync(artifactDir, { recursive: true, force: true });
      throw error;
    }
    workerRegistry.set(id, {
      executor: {
        terminate() {
          if (generatedForThisProfile) void generatedForThisProfile.dispose();
          indexController.abort();
          parseHandle.terminate();
        },
      },
      mainWindow,
      completed: false,
    });
    return;
  }

  const worker = new Worker(WORKER_URL, {
    env: {
      ...workerBaseEnv,
      COREDOC_POSTHOG_KEY: process.env.COREDOC_POSTHOG_KEY?.trim() || BUNDLED_POSTHOG_KEY,
      COREDOC_POSTHOG_HOST: process.env.COREDOC_POSTHOG_HOST?.trim() || BUNDLED_POSTHOG_HOST,
      // Every write this worker performs — parse, summarize, push, embed, and
      // the `operations` rows they record — lands in the project's own graph
      // database. Node ids embed only the repo name's hash, so without this a
      // repo named the same in two projects would overwrite the other's rows.
      COREDOC_SQLITE_URL: sqliteUrl,
    },
  });
  workerRegistry.set(id, { executor: worker, mainWindow, completed: false });

  worker.on(
    'message',
    (msg: { type: string; level?: string; text?: string; success?: boolean; data?: unknown; error?: string }) => {
      if (msg.type === 'log') {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: msg.text });
        }
      } else if (msg.type === 'result') {
        // Emit error text to PTY so it's visible in xterm before finalizing
        if (!msg.success && msg.error && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: `\r\nError: ${msg.error}\r\n` });
        }
        finalizeCommand(id, !!msg.success, msg.success ? 0 : 1, msg.error);
      }
    },
  );

  worker.on('error', (err: Error) => {
    console.error(`[Command ${id}] Worker error:`, err.message);
    finalizeCommand(id, false, 1, err.message);
  });

  worker.on('exit', (code: number) => {
    // Catch unexpected exits (crash, terminate) not covered by message handler
    finalizeCommand(id, false, code ?? 1, 'Worker exited unexpectedly');
  });

  // Send command to worker (include runtime paths for SDK subprocess)
  worker.postMessage(workerMessage);
}

// ---------------------------------------------------------------------------
// Generate command (stays in main process)
// ---------------------------------------------------------------------------

/** Absolute path to the workspace parser-storage dir ({configDir}/{config.parserStorage}). */
function getParserStorageDir(): string | null {
  const config = getCurrentConfig();
  const configDir = getConfigDir();
  if (!config || !configDir) return null;
  return path.resolve(configDir, config.parserStorage);
}

function unsafeAuthoringArtifact(rootDir: string): string | null {
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const artifactPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) return `symbolic-link artifact ${artifactPath}`;
      if (entry.isDirectory()) {
        pending.push(artifactPath);
        continue;
      }
      if (!entry.isFile()) return `non-regular artifact ${artifactPath}`;
      if ((fs.statSync(artifactPath).mode & 0o111) !== 0) return `executable artifact ${artifactPath}`;
    }
  }
  return null;
}

const ACCEPT_DOCUMENTED_GAP_LABEL = 'Accept documented gap';

interface ProfileScoreAttestation {
  onCommandCompleted(result: AgentRunCommandResult): void;
  onQuestionAnswered(questions: AgentRunQuestion[], answers: string[][]): void;
  verify(): string | null;
}

function profileDigest(profilePath: string): string | null {
  try {
    const stat = fs.lstatSync(profilePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return createHash('sha256').update(fs.readFileSync(profilePath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Bind completion to the observed score output for the exact candidate bytes. Model narration is
 * not evidence: only the harness result for the exact app-owned score command can create an attestation.
 */
function profileScoreAttestation(profilePath: string, scoreCommand: string): ProfileScoreAttestation {
  let state: {
    digest: string;
    verdict: 'pass' | 'acceptable-gap' | 'blocked' | 'accepted-gap' | 'incomplete';
    detail?: string;
  } | null = null;

  return {
    onCommandCompleted(result) {
      if (result.command.trim() !== scoreCommand.trim()) return;
      const digest = profileDigest(profilePath);
      if (!digest) {
        state = null;
        return;
      }
      const verdicts = [...result.output.matchAll(/=== Overall(?: \(all targets\))?: (PASS|FAIL) ===/g)];
      const finalVerdict = verdicts.at(-1)?.[1];
      const completions = [...result.output.matchAll(/=== Profile completion: (PASS|ACCEPTABLE_GAP|BLOCKED) ===/g)];
      const completion = completions.at(-1)?.[1];
      if (finalVerdict === 'PASS' && completion === 'PASS' && result.success) {
        state = { digest, verdict: 'pass' };
      } else if (finalVerdict === 'FAIL' && completion === 'ACCEPTABLE_GAP' && !result.success) {
        state = { digest, verdict: 'acceptable-gap' };
      } else if (finalVerdict === 'FAIL' && completion === 'BLOCKED' && !result.success) {
        state = { digest, verdict: 'blocked' };
      } else {
        // A crash, truncated tool result, or command result without the app-owned final marker
        // cannot inherit an older success, even when the profile bytes happen to be unchanged.
        state = { digest, verdict: 'incomplete', detail: result.output.trim().slice(-2000) };
      }
    },

    onQuestionAnswered(questions, answers) {
      if (state?.verdict !== 'acceptable-gap' || profileDigest(profilePath) !== state.digest) return;
      const explicitlyAccepted = questions.some(
        (question, index) =>
          question.options.some((option) => option.label === ACCEPT_DOCUMENTED_GAP_LABEL) &&
          answers[index]?.includes(ACCEPT_DOCUMENTED_GAP_LABEL),
      );
      if (explicitlyAccepted) state = { ...state, verdict: 'accepted-gap' };
    },

    verify() {
      const digest = profileDigest(profilePath);
      if (!digest) return `The profile at ${profilePath} is not available for score verification.`;
      if (!state) {
        return `The current profile has not been scored with the required app-owned score command.`;
      }
      if (state.digest !== digest) {
        if (state.verdict === 'blocked') {
          return `The last scored profile revision was BLOCKED, and the profile changed after that score; run the score command again after the latest edit.`;
        }
        return `The current profile revision has not been scored; run the score command again after the latest edit.`;
      }
      if (state.verdict === 'acceptable-gap') {
        return (
          `The current profile's score result is FAIL with PARTIAL coverage only. Continue refining it, or ask the ` +
          `user and offer the exact "${ACCEPT_DOCUMENTED_GAP_LABEL}" option for that documented gap.`
        );
      }
      if (state.verdict === 'blocked') {
        return `The current profile's score result is BLOCKED by a category failure, structural error, or consistency red flag and cannot be accepted as a documented gap.`;
      }
      if (state.verdict === 'incomplete') {
        return (
          'The required profile score command did not produce a complete result. Resolve the reported failure before scoring again.' +
          (state.detail ? `\n${state.detail}` : '')
        );
      }
      return null;
    },
  };
}

/** Require the isolated authored revision to be declarative and pass the real parse typecheck. */
function profileCompletionVerifier(
  profilePath: string,
  authoringDir: string,
  verifyScore: () => string | null,
): () => string | null {
  return () => {
    if (!fs.existsSync(profilePath)) {
      return `The agent run ended without writing the profile to ${profilePath}.`;
    }

    const profileStat = fs.lstatSync(profilePath);
    if (!profileStat.isFile() || profileStat.isSymbolicLink()) {
      return `The generated profile must be a regular, non-symbolic-link file: ${profilePath}.`;
    }

    const capabilityViolations = profileCapabilityViolations(profilePath);
    if (capabilityViolations.length > 0) {
      return formatProfileCapabilityViolations(profilePath, capabilityViolations);
    }

    const unsafeArtifact = unsafeAuthoringArtifact(authoringDir);
    if (unsafeArtifact) return `The isolated authoring output contains an unsafe ${unsafeArtifact}.`;

    const diagnostics = typecheckProfile(profilePath);
    if (diagnostics.length > 0) return formatProfileDiagnostics(profilePath, diagnostics);
    return verifyScore();
  };
}

function profileCompletionFinalizer(
  candidatePath: string,
  finalPath: string,
  verifyCandidate: () => string | null,
): () => string | null {
  return () => {
    const failure = verifyCandidate();
    if (failure) return failure;

    try {
      if (fs.existsSync(finalPath)) {
        const finalStat = fs.lstatSync(finalPath);
        if (!finalStat.isFile() || finalStat.isSymbolicLink()) {
          return `Refusing to replace a non-regular profile artifact at ${finalPath}.`;
        }
      }
      fs.renameSync(candidatePath, finalPath);
      return null;
    } catch (error) {
      return `Failed to promote the verified profile to ${finalPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

/** Emit a failing terminal message + COMMAND_COMPLETED for a generate that could not start. */
function failGenerate(id: string, mainWindow: BrowserWindow, message: string): void {
  commandMeta.delete(id);
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: `\r\n${message}\r\n` });
    mainWindow.webContents.send(IpcChannels.COMMAND_COMPLETED, { id, success: false, exitCode: 1, error: message });
  }
}

function buildAuthorProfilePrompt(opts: {
  skillPath: string;
  schemaRef: string;
  repoPath: string;
  repoName: string;
  profileOut: string;
  scoreCommand: string;
  feedback: string;
  resumeDraft: boolean;
  harness: 'claude-code' | 'codex';
}): string {
  const { skillPath, schemaRef, repoPath, repoName, profileOut, scoreCommand, feedback, harness } = opts;
  const lines = [
    `You are authoring a coredoc extraction profile for the repository "${repoName}".`,
    `The target repository is your current working directory (${repoPath}) — read ONLY files inside it (including its node_modules to learn library conventions). Do NOT look for or read coredoc's own source tree; everything you need about the profile format is provided below.`,
    `Follow the methodology in the author-profile skill at ${skillPath} and its references/ directory.`,
    `The ExtractionProfile and MultiTargetProfile schema / vocabulary reference is ${schemaRef} — read that wherever the skill points at "packages/profile-parser/..." paths.`,
    `FULL-REPO COVERAGE IS REQUIRED for production source. substrate.include MUST cover every application and library package — in a monorepo use broad globs like ['apps/**/*.ts', 'packages/**/*.ts'] (adjust to the real layout), NEVER a single app such as apps/server only. Framework rules (routes/entities/db-ops) apply where they match; plain library packages still contribute functions, classes, and their call graph. In each target, explicitly exclude tests, fixtures, mocks, and e2e helpers using the author-profile skill's Scope rules and repo-specific test conventions unless the user explicitly requests them. Preserve these exclusions when widening includes or resuming a draft: intentionally excluded test code is not a coverage gap and must never be added back just to pass scoring. The coverage scorecard only measures the included scope — a PASS on a narrow include is NOT done; cover all production source, then re-score.`,
    `To score a draft, call the ${scoreCommand} tool with no arguments. It replaces every shell score command in the skill. Desktop runs the protected scorer and handles the native analysis-mode, execution-consent and prerequisite dialogs. Never ask the user to install/enable an indexer through an authoring question: that answer cannot configure tooling. Leave C# substrate.analysis unset unless the user explicitly requested a fixed profile policy; Desktop owns the choice for this run.`,
    `Write one finished profile module to ${profileOut}, exporting an ExtractionProfile for a single-language repository or a MultiTargetProfile with exactly one target per canonical language provider when Orient finds a polyglot repository. TS and JS share the TypeScript provider and must never be split into separate targets.`,
    'The profile must remain declarative: use type-only imports, never mutate process.env or other runtime state, and never create executables or command shims beside the profile.',
  ];
  // The plan/question tools differ per harness: Claude Code has TodoWrite + AskUserQuestion,
  // Codex uses our dynamic plan/question tools. Naming a tool the harness doesn't have leaves
  // the progress UI empty — the model can't follow instructions about tools it can't call.
  const planTool = harness === 'codex' ? 'coredoc_update_plan' : 'TodoWrite';
  const askTool = harness === 'codex' ? 'coredoc_request_user_input' : 'AskUserQuestion';
  const inspectionInstructions =
    harness === 'codex'
      ? 'This is a protected Desktop run: command execution is confined to the read-only repository/authoring-kit roots, the isolated profile staging directory, a scrubbed environment, and no network. Use standard read-only inspection commands such as rg, find, sed, and cat for source evidence. Do not install dependencies, run package-manager or repository scripts, execute repo code, or create ad-hoc Node/Python/Ruby analysis scripts. The app-owned score tool is the only tool whose output counts as deterministic verification. The synthesized directional-scout matrix plus scorer red flags and targeted source spot-checks are the Audit evidence; do not run the external graph-audit command templates or treat graph-audit.md as a completion artifact. Score reports in the isolated authoring directory are temporary; the verified profile.ts is the only promoted artifact.'
      : `This is a protected Desktop run: arbitrary shell commands from the skill's Audit examples are unavailable. Do not attempt \`node -e\`, Python, Ruby, or shell workarounds, and do not install repository dependencies. Use the allowed Read/Glob/Grep tools for source evidence and the app-owned score tool for deterministic verification. In this variant, the synthesized directional-scout matrix plus scorer red flags and targeted Read/Grep spot-checks are the Audit evidence; do not run the external graph-audit command templates or treat graph-audit.md as a completion artifact. Score reports in the isolated authoring directory are temporary; the verified profile.ts is the only promoted artifact.`;
  lines.push(
    `Maintain a plan with the ${planTool} tool throughout, using exactly these five phase items, in order: 'Ground in repo shape', 'Scout conventions', 'Draft profile', 'Score & iterate', 'Finalize profile'. Mark each in_progress when you start it and completed when done. Add sub-tasks only if essential. Keep the plan updated on EVERY phase transition — it is the user's only progress view.`,
    inspectionInstructions,
    `If you need the user's input, use the ${askTool} tool — it is the only way to reach them. Do NOT ask questions in plain text; the user cannot see your messages, only ${askTool} prompts.${
      harness === 'claude-code'
        ? " Its schema may be deferred in this session: if a call is rejected for a missing schema, run ToolSearch with query 'select:AskUserQuestion' first, then retry."
        : ''
    }`,
    `The score-refine loop is budgeted: stop when the same blocking diagnostics recur without improvement across 3 score runs, inspect the final "Profile completion" marker. Only ACCEPTABLE_GAP (PARTIAL coverage with no category FAIL, structural error, consistency red flag, or unclaimed scope) may be raised through ${askTool}. First finish the audit, document the gap in the profile doc comment (category, coverage, and what you tried), and score the final bytes. THEN ask for acceptance. The acceptance option MUST be labeled exactly "${ACCEPT_DOCUMENTED_GAP_LABEL}"; also offer options to get pointers from the user or keep iterating. After acceptance, finish immediately with the gap in your summary: do not edit the profile or rerun scoring, because either requires renewed acceptance. BLOCKED must never be offered for acceptance — keep refining or end unsuccessfully. An accepted PARTIAL is a valid finish; parsing does not require a PASS scorecard.`,
    `The final score attests the exact profile bytes. Make every profile.ts change, including documentation comments, before the final score tool call. If profile.ts changes afterward for any reason, call the score tool again; never finalize or end with an unscored revision. Leave all temporary score-*.json reports in staging: Coredoc removes the whole staging directory automatically, so never delete those reports yourself.`,
    `When the profile is written and scored PASS across the whole repo (or the user accepted a documented gap), end with a short summary — parsing starts automatically when you finish. Do NOT claim the profile is written without having actually created ${profileOut}.`,
  );
  if (opts.resumeDraft) {
    lines.push(
      'This is a saved-draft retry, not a fresh authoring run. The score-first retry instructions override the skill’s full scouting/audit procedure: do not repeat the four directional scouts or the whole-repository inventory. Verify the current coverage and scope with the score tool, then inspect source only for reported gaps or a concrete correctness concern in the draft. If the score is PASS and the targeted audit finds no defect, finalize immediately without cosmetic edits or another score.',
    );
  } else if (harness === 'codex') {
    lines.push(
      'This run uses Codex. In the Scout phase, first inventory the sorted language/framework/source roots. Then use spawn_agent (never the Claude-only Task tool) with model gpt-6-luna for four directional scouts across those roots: entrypoints/messaging, data/DB, frontend, and DI/indirection/egress. Fill the available collaboration slots, dispatch any remaining direction as soon as a slot frees, and synthesize all four results before drafting. Split a direction into package-scoped follow-ups only when the inventory proves a genuinely distinct stack or convention.',
    );
  }
  if (feedback) {
    lines.push(`Incorporate this feedback from a previous attempt: ${feedback}`);
  }
  return lines.join('\n');
}

/**
 * Generate command — authors a parser profile by driving a Claude Agent SDK session (cwd = target
 * repo, using the bundled author-profile kit). The renderer shows native step progress and answers
 * the agent's AskUserQuestion prompts; permissions are enforced by canUseTool (reads/bash scoped to
 * the repo, writes scoped to the parser dir, everything else auto-denied). The session is isolated
 * from all ambient Claude config. On completion the service emits COMMAND_COMPLETED and the store's
 * generate→parse chain runs against the new profile.ts.
 */
async function runGenerateCommand(options: CommandRunOptions, id: string, mainWindow: BrowserWindow): Promise<void> {
  if (isE2EMode(process.env)) {
    throw new Error(
      'runGenerateCommand (generate) is blocked in E2E mode (COREDOC_DESKTOP_E2E=1) — no agent harness process may start.',
    );
  }

  const repoName = options.repo;
  if (!repoName) {
    failGenerate(id, mainWindow, 'Repository name is required for the generate command.');
    return;
  }

  const repoPath = resolveRepoPath(repoName, options.projectId);
  if (!repoPath || !fs.existsSync(repoPath)) {
    failGenerate(id, mainWindow, `Repository path not found for "${repoName}".`);
    return;
  }

  const kitDir = getAuthoringKitDir();
  if (!kitDir) {
    failGenerate(
      id,
      mainWindow,
      'The profile-authoring kit is not available in this build. Rebuild the app (pnpm build), or author the profile via the coredoc CLI.',
    );
    return;
  }

  // Capture provider, auth mode, and credential at invocation time. Later Settings changes affect
  // only later runs, and the child receives only its selected provider's credential.
  const envPath = runtimeGetEnvPath() ?? path.join(requireProjectRoot(), '.env');
  const harnessSettings = readHarnessSettings(envPath);
  const claudeCliPath = harnessSettings.provider === 'claude-code' ? getClaudeCodeCliPath() : undefined;
  const codexCliPath = harnessSettings.provider === 'codex' ? getCodexCliPath() : undefined;
  if (harnessSettings.provider === 'claude-code' && !claudeCliPath) {
    failGenerate(id, mainWindow, 'Claude Code runtime not found in this build.');
    return;
  }
  if (harnessSettings.provider === 'codex' && !codexCliPath) {
    failGenerate(
      id,
      mainWindow,
      'Compatible system Codex CLI not found. Install or update Codex, then restart Coredoc.',
    );
    return;
  }

  const parserStorageDir = getParserStorageDir();
  if (!parserStorageDir) {
    failGenerate(id, mainWindow, 'No workspace config loaded — open a project first.');
    return;
  }

  const profileOut = profileArtifactPath(parserStorageDir, options.projectId, repoName);
  const profileDir = path.dirname(profileOut);
  // Ensure the profile output directory exists so the agent can write into it.
  fs.mkdirSync(profileDir, { recursive: true });

  const { execPath: nodeExecPath, env: nodeEnv } = getNodeExec();
  const scoreNodeExecPath = resolveSandboxExecutable(nodeExecPath, nodeEnv);
  const env = codexCliPath
    ? buildSystemCodexEnvironment(buildHarnessEnvironment(nodeEnv, harnessSettings), codexCliPath)
    : buildHarnessEnvironment(nodeEnv, harnessSettings);
  const coredocCliPath = runtimeGetCliPath() ?? findCliExecutable();
  const feedback = typeof options.args?.feedback === 'string' ? options.args.feedback.trim() : '';
  // Pin provider-specific authoring defaults; explicit per-run model requests still win.
  const requestedModel =
    typeof options.args?.model === 'string' && options.args.model.trim().length > 0
      ? options.args.model.trim()
      : undefined;
  const model = requestedModel ?? (harnessSettings.provider === 'claude-code' ? 'claude-sonnet-5' : 'gpt-6-sol');

  // Schema reference: packaged apps read the bundled copy inside the kit; in dev the monorepo is
  // present, so the skill's native "packages/profile-parser/..." refs resolve once we grant its root.
  const extraAddDirs: string[] = [];
  // Read-only roots the score command's toolchain needs inside a deny-by-default harness sandbox
  // (Codex): the Node runtime and the CLI bundle plus everything it resolves at runtime. These
  // are sandbox grants only — the agent's Read/Glob/Grep scope (policy.readDirs) excludes them.
  const toolchainReadDirs = [path.resolve(path.dirname(scoreNodeExecPath), '..'), path.dirname(coredocCliPath)];
  let schemaRef = path.join(kitDir, 'references', 'profile-parser-README.md');
  if (!app.isPackaged) {
    try {
      const root = requireProjectRoot();
      schemaRef = path.join(root, 'packages', 'profile-parser', 'README.md');
      // Grant only profile-parser (schema/types), not the whole monorepo, so the session
      // doesn't wander into unrelated coredoc packages.
      extraAddDirs.push(path.join(root, 'packages', 'profile-parser'));
      // Dev CLI dist resolves @coredoc/* and deps through the monorepo's node_modules and
      // workspace package dists.
      toolchainReadDirs.push(path.join(root, 'node_modules'), path.join(root, 'packages'));
    } catch {
      /* fall back to the kit's bundled schema ref */
    }
  }
  for (const key of ['COREDOC_RUNTIME_MODULES', 'COREDOC_TREESITTER_WASM_DIR', 'COREDOC_PROFILE_SCHEMA_DIR']) {
    const value = nodeEnv[key]?.trim();
    if (value) toolchainReadDirs.push(value);
  }

  // Attribute this run's economics to the project's cloud workspace, if it has
  // one. Resolved HERE, at run start, and bound to THIS run (passed through to
  // emitAgentRun at completion) rather than parked in process-global state — so
  // a second, concurrent agent-run can never redirect this run's summary to its
  // own workspace. No workspace → cloud attribution stays absent (anon-only).
  const cloud = getCurrentConfig()?.projects.find((p) => p.id === options.projectId)?.cloud;
  const cloudTelemetry = cloud?.enabled && cloud.workspaceId ? buildCloudChannelConfig(cloud.workspaceId) : undefined;

  // Never let an authoring agent edit the live profile in place. Its entire writable surface is a
  // fresh sibling directory; only a verified profile.ts is atomically promoted after the run ends.
  const authoringDir = fs.mkdtempSync(path.join(profileDir, '.authoring-'));
  // The SDK's debug writer also needs writable storage; it must never create
  // .claude-sdk inside the source checkout being inspected.
  if (harnessSettings.provider === 'claude-code')
    env.CLAUDE_CODE_DEBUG_LOGS_DIR = path.join(authoringDir, 'claude-sdk.log');
  const candidateProfileOut = path.join(authoringDir, 'profile.ts');
  const draftPath = path.join(profileDir, 'profile.draft.ts');
  const seedPath = fs.existsSync(draftPath) ? draftPath : profileOut;
  if (fs.existsSync(seedPath)) {
    const existingProfile = fs.lstatSync(seedPath);
    if (existingProfile.isFile() && !existingProfile.isSymbolicLink()) {
      // Regeneration starts from the current source, but all edits and score reports stay isolated
      // until the revised bytes earn a fresh score attestation.
      fs.copyFileSync(seedPath, candidateProfileOut);
    }
  }
  const abortController = new AbortController();
  runningAbortControllers.set(id, abortController);
  let promoted = false;
  let analysisMode: 'basic' | 'enhanced' | undefined;
  const consentedLanguages = new Set<string>();
  const scoreProgress = new Map<string, () => void>();
  const analysisChanged = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannels.ANALYSIS_CHANGED);
  };
  const scorer = createProfileScoreHost({
    profilePath: candidateProfileOut,
    mode: () => analysisMode,
    controller: abortController,
    compiler: {
      repoRoot: repoPath,
      nodeExecutable: scoreNodeExecPath,
      sourceEnv: nodeEnv,
      onLog(data) {
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data });
      },
      onProgress(message, language) {
        const key = language ?? 'csharp';
        scoreProgress.get(key)?.();
        scoreProgress.delete(key);
        if (message)
          scoreProgress.set(
            key,
            showAnalysisProgress(
              { commandId: id, projectId: options.projectId, repoName, language, message },
              () => abortController.abort(),
              analysisChanged,
            ),
          );
      },
      ask: async (message, canUseBasic, canInstall, phase, language) => {
        // The native dialog before authoring already grants this run's execution consent.
        if (phase === 'execution' && analysisMode === 'enhanced' && consentedLanguages.has(language ?? 'csharp'))
          return 'run';
        const choice = await askAnalysisPrompt(
          { commandId: id, projectId: options.projectId, repoName, language, message, canUseBasic, canInstall, phase },
          abortController.signal,
          analysisChanged,
        );
        if (choice === 'basic') analysisMode = 'basic';
        if (phase === 'execution' && choice === 'run') consentedLanguages.add(language ?? 'csharp');
        return choice;
      },
    },
    sandbox: {
      repoRoot: repoPath,
      nodeExecutable: scoreNodeExecPath,
      childScript: PARSE_CHILD_PATH,
      sourceEnv: nodeEnv,
      runtimeBinDirs: [path.dirname(scoreNodeExecPath)],
      homeDir: app.getPath('home'),
      readPaths: [repoPath, authoringDir, path.dirname(PARSE_CHILD_PATH), ...new Set(toolchainReadDirs)],
      readFiles: [],
      writePaths: [authoringDir],
      writeFiles: [],
      deniedReadPaths: [envPath, path.join(repoPath, '.env')],
    },
  });

  try {
    const csharpSources = csharpProvider.sourceFiles(
      {
        parserId: 'desktop-language-discovery',
        substrate: { language: 'csharp', include: ['**/*.cs'] },
      },
      repoPath,
    );
    const rubySources = rubyProvider.sourceFiles(
      { parserId: 'desktop-language-discovery', substrate: { language: 'ruby', include: ['**/*.rb'] } },
      repoPath,
    );
    const languages: string[] = [];
    if (csharpSources.included.length) languages.push('csharp');
    if (rubySources.included.length) languages.push('ruby');
    if (
      pythonProvider.sourceFiles(
        { parserId: 'desktop-language-discovery', substrate: { language: 'python', include: ['**/*.py'] } },
        repoPath,
      ).included.length
    )
      languages.push('python');
    if (
      rustProvider.sourceFiles(
        { parserId: 'desktop-language-discovery', substrate: { language: 'rust', include: ['**/*.rs'] } },
        repoPath,
      ).included.length
    )
      languages.push('rust');
    if (
      goProvider.sourceFiles(
        { parserId: 'desktop-language-discovery', substrate: { language: 'go', include: ['**/*.go'] } },
        repoPath,
      ).included.length
    )
      languages.push('go');
    if (languages.length) {
      const choice = await askAnalysisPrompt(
        {
          commandId: id,
          projectId: options.projectId,
          repoName,
          language:
            languages.length === 1
              ? languages[0] === 'csharp'
                ? undefined
                : languages[0]
              : languages
                  .map(
                    (language) => ({ csharp: 'C#', ruby: 'Ruby', python: 'Python', rust: 'Rust', go: 'Go' })[language],
                  )
                  .join(' / '),
          message: [
            OPTIONAL_EXECUTION_NOTICE,
            ...(languages.includes('csharp') ? [CSHARP_EXECUTION_NOTICE] : []),
            ...(languages.includes('rust')
              ? [
                  'Rust analysis executes Cargo build scripts and procedural macros with network access. Only run it for repositories you trust; LAN/host services are not isolated on every platform.',
                ]
              : []),
            ...(languages.includes('go')
              ? [
                  'Go analysis loads modules and may run build tooling with network access. Only run it for repositories you trust; LAN/host services are not isolated on every platform.',
                ]
              : []),
          ].join(' '),
          canUseBasic: true,
          canInstall: false,
          phase: 'execution',
        },
        abortController.signal,
        analysisChanged,
      );
      if (choice !== 'basic' && choice !== 'run') throw new DOMException('Analysis cancelled', 'AbortError');
      analysisMode = choice === 'basic' ? 'basic' : 'enhanced';
      if (choice === 'run') for (const language of languages) consentedLanguages.add(language);
    }
    const scoreCommand = 'coredoc_score_profile';
    const prompt = buildAuthorProfilePrompt({
      skillPath: path.join(kitDir, 'SKILL.md'),
      schemaRef,
      repoPath,
      repoName,
      profileOut: candidateProfileOut,
      scoreCommand: harnessSettings.provider === 'codex' ? scoreCommand : 'mcp__coredoc__score_profile',
      resumeDraft: fs.existsSync(draftPath),
      feedback: [
        analysisMode
          ? `The user selected ${analysisMode} analysis in Desktop. Use the score tool; do not override substrate.analysis or ask the user to configure tools.`
          : '',
        fs.existsSync(draftPath)
          ? 'A saved, unverified draft is already staged at the output path. Read it and call the score tool first. Reuse its conventions; inspect relevant source only for reported gaps instead of repeating whole-repository scouting. It still requires a fresh score and audit before promotion.'
          : '',
        feedback,
      ]
        .filter(Boolean)
        .join('\n'),
      harness: harnessSettings.provider,
    });
    const scoreAttestation = profileScoreAttestation(candidateProfileOut, scoreCommand);
    const verifyProfileCompletion = profileCompletionVerifier(
      candidateProfileOut,
      authoringDir,
      scoreAttestation.verify,
    );
    const finalizeProfileCompletion = profileCompletionFinalizer(
      candidateProfileOut,
      profileOut,
      verifyProfileCompletion,
    );

    const adapter =
      harnessSettings.provider === 'codex' ? new CodexAdapter(codexCliPath as string) : new ClaudeAdapter();
    await startAgentRun(
      id,
      {
        prompt,
        cwd: repoPath,
        model,
        additionalDirectories: [kitDir, authoringDir, ...extraAddDirs],
        policy: {
          repoDir: repoPath,
          writeDirs: [authoringDir],
          readDirs: [repoPath, kitDir, authoringDir, ...extraAddDirs],
          toolchainReadDirs: [...new Set(toolchainReadDirs)],
          safeCommandPrefixes: [],
          deniedPaths: [envPath],
        },
        env,
        nodeExecPath,
        ...(claudeCliPath ? { claudeCliPath } : {}),
        abortController,
        ...(cloudTelemetry && { cloud: cloudTelemetry }),
        verifyCompletion: verifyProfileCompletion,
        deliverableExists: () => fs.existsSync(candidateProfileOut),
        finalizeCompletion: () => {
          const failure = finalizeProfileCompletion();
          if (!failure) {
            promoted = true;
            const key = `${options.projectId}/${repoName}`;
            void generatedAnalysis.get(key)?.scorer.dispose();
            generatedAnalysis.set(key, { repoPath, digest: profileDigest(profileOut), scorer });
          }
          return failure;
        },
        scoreProfile: async () => {
          const violations = profileCapabilityViolations(candidateProfileOut);
          if (violations.length)
            return { success: false, output: formatProfileCapabilityViolations(candidateProfileOut, violations) };
          const result = await scorer.score();
          scoreAttestation.onCommandCompleted({ command: scoreCommand, ...result });
          return result;
        },
        onCommandCompleted: scoreAttestation.onCommandCompleted,
        onQuestionAnswered: scoreAttestation.onQuestionAnswered,
      },
      mainWindow,
      adapter,
    );
  } finally {
    for (const clear of scoreProgress.values()) clear();
    if (!promoted) await scorer.dispose();
    // Keep only the unverified draft, never the large score reports or executables.
    // A retry seeds isolated staging from it and must earn a fresh score attestation.
    if (!promoted && fs.existsSync(candidateProfileOut)) {
      const stat = fs.lstatSync(candidateProfileOut);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.copyFileSync(candidateProfileOut, draftPath);
    } else if (promoted) fs.rmSync(draftPath, { force: true });
    fs.rmSync(authoringDir, { recursive: true, force: true });
    runningAbortControllers.delete(id);
    commandMeta.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a CLI command
 */
export async function runCommand(options: CommandRunOptions, mainWindow: BrowserWindow): Promise<CommandRunResult> {
  const id = generateCommandId();

  // Track metadata for all commands so renderer can query after reload
  commandMeta.set(id, {
    projectId: options.projectId,
    repoName: options.repo ?? '',
    action: options.command,
    startedAt: new Date().toISOString(),
  });

  try {
    if (options.command === 'generate' && options.repo) {
      // Generate stays in main process (uses SDK orchestrator with structured event streaming)
      runGenerateCommand(options, id, mainWindow).catch((error) => {
        console.error(`[Command ${id}] Generate command failed:`, error);
        commandMeta.delete(id);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannels.COMMAND_COMPLETED, {
            id,
            success: false,
            exitCode: 1,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    } else if (options.command === 'cloud-docs') {
      // Cloud docs runs in main process (uses Claude Agent SDK with cloud MCP)
      runCloudDocsCommand(options, id, mainWindow).catch((error) => {
        console.error(`[Command ${id}] Cloud docs command failed:`, error);
        const msg = error instanceof Error ? error.message : String(error);
        commandMeta.delete(id);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data: `\r\nError: ${msg}\r\n` });
          mainWindow.webContents.send(IpcChannels.COMMAND_COMPLETED, {
            id,
            success: false,
            exitCode: 1,
            error: msg,
          });
        }
      });
    } else {
      // Report a successful start only after preflight has released cached
      // database handles and the worker is registered, so an immediate cancel
      // cannot race ahead of the worker registry.
      await runSdkCommand(options, id, mainWindow);
    }

    return { id, started: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    finalizeCommand(id, false, 1, message);
    commandMeta.delete(id);
    return {
      id,
      started: false,
      error: message,
    };
  }
}

/**
 * Cancel a running command
 */
export function cancelCommand(id: string): boolean {
  // Abort SDK orchestrator if this is a generate command
  const ac = runningAbortControllers.get(id);
  if (ac) {
    ac.abort();
    runningAbortControllers.delete(id);
    commandMeta.delete(id);
    return true;
  }

  // Terminate worker thread if this is a worker command
  const entry = workerRegistry.get(id);
  if (entry) {
    finalizeCommand(id, false, 130, 'Cancelled'); // 130 = SIGINT
    return true;
  }

  // Terminate an interactive PTY session (e.g. a running generate).
  if (killPty(id)) {
    commandMeta.delete(id);
    return true;
  }

  return false;
}

/**
 * Cancel all running commands
 */
export function cancelAllCommands(): void {
  for (const { scorer } of generatedAnalysis.values()) void scorer.dispose();
  generatedAnalysis.clear();
  // Cancel all generate commands
  for (const ac of runningAbortControllers.values()) {
    ac.abort();
  }
  runningAbortControllers.clear();

  // Terminate all worker threads
  for (const [_id, entry] of workerRegistry) {
    entry.executor.terminate();
    entry.completed = true;
  }
  workerRegistry.clear();

  // Terminate any interactive PTY sessions (e.g. generate).
  killAllPtys();

  commandMeta.clear();
}

/**
 * Get currently running commands (for renderer state recovery after reload)
 */
export function getRunningCommands(): {
  id: string;
  projectId: string;
  repoName: string;
  action: string;
  startedAt: string;
}[] {
  return Array.from(commandMeta.entries()).map(([id, meta]) => ({
    id,
    projectId: meta.projectId,
    repoName: meta.repoName,
    action: meta.action,
    startedAt: meta.startedAt,
  }));
}

/**
 * Register IPC handlers for command operations
 */
export function registerCommandHandlers(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  ipcMain.handle(IpcChannels.ANALYSIS_PROMPTS, (event) =>
    event.sender === mainWindow.webContents ? getAnalysisPrompts() : [],
  );
  ipcMain.handle(
    IpcChannels.ANALYSIS_ANSWER,
    (event, id: string, choice: unknown) => event.sender === mainWindow.webContents && answerAnalysisPrompt(id, choice),
  );
  ipcMain.handle(IpcChannels.COMMAND_RUN, (_event, options: CommandRunOptions) => {
    return runCommand(options, mainWindow);
  });

  ipcMain.handle(IpcChannels.COMMAND_CANCEL, (_event, id: string) => {
    return cancelCommand(id);
  });

  ipcMain.handle(IpcChannels.COMMAND_GET_RUNNING, () => {
    return getRunningCommands();
  });

  // PTY input/resize handlers (kept for generate command xterm compatibility)
  ipcMain.handle(IpcChannels.PTY_WRITE, (_event, id: string, data: string) => {
    return writePty(id, data);
  });

  ipcMain.handle(IpcChannels.PTY_RESIZE, (_event, id: string, cols: number, rows: number) => {
    return resizePty(id, cols, rows);
  });

  // Agent-run answer/state handlers (profile authoring via the SDK path)
  registerAgentRunHandlers(ipcMain);
}
