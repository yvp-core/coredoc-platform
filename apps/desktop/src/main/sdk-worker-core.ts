/**
 * SDK worker command routing — the side-effect-free core of {@link ./sdk-worker.ts}.
 *
 * Split out from the worker BOOTSTRAP (which reassigns console/stdout/stderr and
 * wires `parentPort` at module load) so the routing + settle logic is unit-testable
 * without a live worker thread. The bootstrap imports {@link handleCommandMessage}
 * and hands it a `post` closure over `parentPort.postMessage`.
 */

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { classifyError, EventName, scrubPaths, shutdownTelemetry, track } from '@coredoc/core/telemetry';
import { isE2EMode } from './e2e-mode.js';

export interface WorkerMessage {
  command: string;
  configPath: string;
  cwd?: string;
  projectId: string;
  repo?: string;
  args?: Record<string, unknown>;
  /** Path to Claude Code CLI executable (for SDK subprocess) */
  claudeCliPath?: string;
  /** Local harness captured by the main process at invocation start. */
  harnessProvider?: 'claude-code' | 'codex';
  /** Path to bundled Codex executable (Codex summarize only). */
  codexCliPath?: string;
  /** Node executable path for SDK subprocess */
  nodeExecPath?: string;
  /** Environment variables for SDK subprocess */
  nodeEnv?: NodeJS.ProcessEnv;
  /**
   * Set by the sandbox-confined parse child: the workspace-layout migration is
   * trusted host work already completed before entering the sandbox, and the
   * parser-storage root (where the migration reads its sentinel) is unreadable
   * inside the sandbox.
   */
  skipLayoutMigration?: boolean;
}

type WorkerArgs = Record<string, unknown> | undefined;

function toKebabCase(input: string): string {
  return input.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function getArg(args: WorkerArgs, ...keys: string[]): unknown {
  if (!args) return undefined;

  for (const key of keys) {
    if (Object.hasOwn(args, key)) {
      return args[key];
    }
  }

  for (const key of keys) {
    const kebab = toKebabCase(key);
    if (kebab !== key && Object.hasOwn(args, kebab)) {
      return args[kebab];
    }
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return undefined;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const parsed = asString(value);
  if (!parsed) return undefined;
  return (allowed as readonly string[]).includes(parsed) ? (parsed as T) : undefined;
}

function getStringArg(args: WorkerArgs, ...keys: string[]): string | undefined {
  return asString(getArg(args, ...keys));
}

function getBooleanArg(args: WorkerArgs, ...keys: string[]): boolean | undefined {
  return asBoolean(getArg(args, ...keys));
}

function getNumberArg(args: WorkerArgs, ...keys: string[]): number | undefined {
  return asNumber(getArg(args, ...keys));
}

function requireRepo(command: string, repo?: string): string {
  if (!repo || !repo.trim()) {
    throw new Error(`Command '${command}' requires a repository argument`);
  }
  return repo;
}

export async function routeCommand(msg: WorkerMessage): Promise<unknown> {
  // Note: process.chdir() is NOT supported in Node 18 worker threads.
  // All path resolution uses absolute paths via msg.configPath and process.env.

  // Load dotenv from workspace (use explicit path since we can't chdir)
  if (msg.cwd && msg.command === 'summarize' && msg.harnessProvider !== 'codex') {
    const pathMod = await import('path');
    const { config: dotenvConfig } = await import('dotenv');
    dotenvConfig({ path: pathMod.join(msg.cwd, '.env') });
  }

  // Set workspace-scoped writable paths for the SDK.
  // The SDK's buffered debug writer (appendFileSync) crashes if paths don't exist.
  // We set both process.env (for non-SDK code in this worker) AND merge into
  // msg.nodeEnv (which is passed as explicit `env` to the SDK subprocess).
  if (msg.cwd) {
    const sdkDir = join(msg.cwd, '.claude-sdk');
    const debugLogPath = join(sdkDir, 'debug', 'claude-sdk.log');
    try {
      mkdirSync(dirname(debugLogPath), { recursive: true });
    } catch {
      /* best effort */
    }

    if (!process.env.CLAUDE_CONFIG_DIR) {
      process.env.CLAUDE_CONFIG_DIR = sdkDir;
    }
    if (!process.env.CLAUDE_CODE_DEBUG_LOGS_DIR) {
      process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = debugLogPath;
    }

    // Merge debug log path into the explicit env passed to SDK subprocess,
    // since SDK ignores process.env when env is explicitly provided.
    // Do NOT propagate CLAUDE_CONFIG_DIR — it overrides where Claude Code
    // looks for its auth session (~/.claude/). Debug logs are already
    // redirected via CLAUDE_CODE_DEBUG_LOGS_DIR.
    if (msg.nodeEnv) {
      if (!msg.nodeEnv.CLAUDE_CODE_DEBUG_LOGS_DIR) {
        msg.nodeEnv.CLAUDE_CODE_DEBUG_LOGS_DIR = debugLogPath;
      }
    }
  }

  // Ladybug is the local default (cypher-capable Ask Graph, passes the graph
  // SLOs); sqlite stays available as rollback via COREDOC_DB_BACKEND=sqlite and
  // neo4j is an explicit opt-in. An explicitly set env always wins — this only
  // covers the unset case, and mirrors the main process's startup default.
  if (!process.env.COREDOC_DB_BACKEND) {
    process.env.COREDOC_DB_BACKEND = 'ladybug';
  }

  const sdk = await import('@coredoc/cli/sdk');
  const config = sdk.loadConfig(msg.configPath, { skipMigration: msg.skipLayoutMigration === true });
  const args = msg.args;
  const projectId = msg.projectId;

  switch (msg.command) {
    case 'parse':
      return sdk.parse({
        config,
        repo: msg.repo,
        projectId,
        output: getStringArg(args, 'output'),
        pretty: getBooleanArg(args, 'pretty'),
        verbose: getBooleanArg(args, 'verbose') ?? false,
        dryRun: getBooleanArg(args, 'dryRun') ?? false,
      });

    case 'summarize':
      // The worker inherits COREDOC_DESKTOP_E2E from the main process env spread.
      // summarize starts a Claude SDK subprocess — a real-token path the e2e
      // fixture server cannot intercept, so it must hard-fail, including when
      // reached through the parse→summarize chain.
      if (isE2EMode(process.env)) {
        throw new Error(
          `The '${msg.command}' command is blocked in E2E mode (COREDOC_DESKTOP_E2E=1) — it starts an LLM session.`,
        );
      }
      return sdk.runSummarize(
        {
          repo: requireRepo(msg.command, msg.repo),
          projectId,
          config: msg.configPath,
          batchSize: getNumberArg(args, 'batchSize') ?? 20,
          delay: getNumberArg(args, 'delay') ?? 100,
          force: getBooleanArg(args, 'force') ?? false,
          model: getStringArg(args, 'model'),
          verbose: getBooleanArg(args, 'verbose') ?? false,
          dryRun: getBooleanArg(args, 'dryRun') ?? false,
          repoSummary: getBooleanArg(args, 'repoSummary') ?? true,
          ...(msg.cwd && { cwd: msg.cwd }),
          ...(msg.claudeCliPath && { claudeCodeCliPath: msg.claudeCliPath }),
          ...(msg.harnessProvider && { harness: msg.harnessProvider }),
          ...(msg.codexCliPath && { codexCliPath: msg.codexCliPath }),
          ...(msg.nodeExecPath && { sdkExecutable: msg.nodeExecPath }),
          ...(msg.nodeEnv && { sdkEnv: msg.nodeEnv }),
        },
        config,
      );

    case 'embed': {
      // embed egresses to an embedding provider (ollama/openrouter) outside the
      // e2e fixture boundary — blocked for the same reason as summarize.
      if (isE2EMode(process.env)) {
        throw new Error(
          `The '${msg.command}' command is blocked in E2E mode (COREDOC_DESKTOP_E2E=1) — it egresses to an embedding provider.`,
        );
      }
      const functionsEnabled = getBooleanArg(args, 'functions');
      const endpointsEnabled = getBooleanArg(args, 'endpoints');
      const noFunctions = getBooleanArg(args, 'noFunctions') ?? functionsEnabled === false;
      const noEndpoints = getBooleanArg(args, 'noEndpoints') ?? endpointsEnabled === false;

      return sdk.runEmbed(
        {
          repo: requireRepo(msg.command, msg.repo),
          projectId,
          config: msg.configPath,
          provider: asEnum(getArg(args, 'provider'), ['ollama', 'openrouter']) ?? 'ollama',
          model: getStringArg(args, 'model'),
          apiKey: getStringArg(args, 'apiKey'),
          baseUrl: getStringArg(args, 'baseUrl'),
          dimensions: getNumberArg(args, 'dimensions') ?? 768,
          batchSize: getNumberArg(args, 'batchSize') ?? 50,
          delay: getNumberArg(args, 'delay') ?? 100,
          inputStrategy: asEnum(getArg(args, 'inputStrategy'), ['summary', 'source', 'both']) ?? 'summary',
          force: getBooleanArg(args, 'force') ?? false,
          verbose: getBooleanArg(args, 'verbose') ?? false,
          dryRun: getBooleanArg(args, 'dryRun') ?? false,
          summariesPath: getStringArg(args, 'summariesPath'),
          noFunctions,
          noEndpoints,
        },
        config,
      );
    }

    case 'push': {
      const includeSummaries = getBooleanArg(args, 'includeSummaries', 'summaries') ?? true;
      const includeEmbeddings = getBooleanArg(args, 'includeEmbeddings', 'embeddings') ?? true;

      return sdk.runUnifiedPush(
        projectId,
        requireRepo(msg.command, msg.repo),
        {
          config: msg.configPath,
          backend: asEnum(getArg(args, 'backend'), ['ladybug', 'neo4j', 'sqlite']),
          includeSummaries,
          summaries: includeSummaries,
          includeEmbeddings,
          embeddings: includeEmbeddings,
          verbose: getBooleanArg(args, 'verbose') ?? false,
          dryRun: getBooleanArg(args, 'dryRun') ?? false,
        },
        config,
      );
    }

    // The `docs`, `call-graph`, `dependency-graph`, `external-calls`, and `topology`
    // commands were removed from @coredoc/cli in the profile-parser reseed. They are
    // stubbed so the desktop app builds and fails gracefully until profile-parser-based
    // equivalents land — see the restore-desktop plan (Phase 2).
    case 'docs':
    case 'call-graph':
    case 'dependency-graph':
    case 'external-calls':
    case 'topology':
      throw new Error(
        `The "${msg.command}" command is not available in this build. Docs generation and ` +
          'graph/topology analysis are being reworked on the new profile-parser engine.',
      );

    case 'resolve': {
      const projectsArg = getStringArg(args, 'project');
      const projectIds = projectsArg
        ? projectsArg
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined;

      const { runResolveCore } = await import('@coredoc/cli/sdk');
      const result = runResolveCore({
        config,
        projectIds,
        output: getStringArg(args, 'output'),
        pretty: getBooleanArg(args, 'pretty'),
        verbose: getBooleanArg(args, 'verbose') ?? false,
      });

      return { success: true, outputPath: result.outputPath, stats: result.stats };
    }

    default:
      throw new Error(`Unknown SDK command: ${msg.command}`);
  }
}

/** Post a message back to the worker's parent. */
export type PostMessage = (message: unknown) => void;

/**
 * Handle one command message: route it, then report the result to the parent.
 *
 * SUCCESS-path flush is load-bearing. parse/summarize/push emit their SUCCESS
 * telemetry (parse_completed, summarize_completed, push_completed, parse_anomaly)
 * through posthog-node, which BATCHES (flushAt=20 / flushInterval=10s). The parent
 * calls `worker.terminate()` within milliseconds of receiving the 'result'
 * message — hard-killing the pending batch. So we drain + flush the shared
 * telemetry client HERE, after the command settles and BEFORE posting 'result',
 * or every desktop success event is systematically dropped.
 *
 * FAILURE path: a failure thrown BEFORE an operation starts (config / artifact
 * lookup, an unknown command) never reaches trackOperation, so it is reported
 * here as a desktop `command_failed` with the error type + redacted message,
 * then flushed for the same reason. An operation failure additionally carries
 * its own `<op>_failed` + exception report from trackOperation's catch.
 */
export async function handleCommandMessage(msg: WorkerMessage, post: PostMessage): Promise<void> {
  let response: unknown;
  try {
    const result = await routeCommand(msg);
    // Flush batched success telemetry before the parent terminates this worker.
    await shutdownTelemetry(500);
    response = { type: 'result', success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const { redactNames } = await import('@coredoc/cli/sdk');
      const safe = redactNames(err, [msg.repo ?? '', msg.projectId]);
      track(EventName.CommandFailed, {
        command: msg.command,
        error_code: classifyError(err),
        error_name: safe.name,
        error_message: scrubPaths(safe.message).slice(0, 500),
      });
      await shutdownTelemetry(500);
    } catch {
      // Telemetry must never mask the command's own failure.
    }
    response = { type: 'result', success: false, error: message };
  }

  // The parent hard-terminates this worker as soon as it receives the result.
  // Close/checkpoint every SQLite connection before that boundary, on success
  // and failure alike; otherwise normal commands leave WAL handles behind.
  try {
    const { closeAllDrivers, closeProjectDatabases } = await import('@coredoc/db');
    const cleanupTasks = [
      { label: 'database drivers', promise: closeAllDrivers() },
      { label: 'project databases', promise: closeProjectDatabases() },
    ];
    const cleanupResults = await Promise.allSettled(cleanupTasks.map(({ promise }) => promise));
    for (const [index, result] of cleanupResults.entries()) {
      if (result.status === 'rejected') {
        const cleanupError = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[sdk-worker] Failed to close ${cleanupTasks[index]!.label}: ${cleanupError}`);
      }
    }
  } catch (err) {
    const closeError = err instanceof Error ? err.message : String(err);
    console.warn(`[sdk-worker] Failed to initialize database cleanup: ${closeError}`);
  }

  post(response);
}
