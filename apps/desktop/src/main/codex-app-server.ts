import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface CodexAppServerMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface CodexAppServerRunOptions {
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  model?: string;
  developerInstructions?: string;
  /** JSON Schema constraining the final assistant message for each turn. */
  outputSchema?: Record<string, unknown>;
  /** Remove Codex environments, dynamic tools, and agent/utility tools for pure generation turns. */
  toolMode?: 'none';
  /** Client-owned tools exposed to the model for this thread. */
  dynamicTools?: Array<{
    type: 'function';
    name: string;
    description: string;
    inputSchema: unknown;
    deferLoading?: boolean;
  }>;
  permissionProfile: string;
  runtimeWorkspaceRoots?: string[];
  config?: Record<string, unknown>;
  onNotification?: (message: CodexAppServerMessage) => void;
  onRequestUserInput?: (params: Record<string, unknown>) => Promise<unknown>;
  onDynamicToolCall?: (params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Called after each COMPLETED turn. Return a prompt to start a follow-up turn on the same
   * thread (context preserved), or null to finish the run. Codex turns end whenever the model
   * decides to stop — unlike the Claude SDK's run-to-result loop — so multi-phase work needs
   * an explicit "continue" nudge when the deliverable is not there yet.
   */
  nextTurn?: (completedTurns: number) => string | null;
}

export interface CodexAppServerRunResult {
  threadId: string;
  turnId: string;
  status: string;
  /** Number of turns run on the thread (1 when no follow-up nudges were needed). */
  turns: number;
  durationMs?: number;
  /** Codex's own reason for a failed turn (`turn.error.message`). */
  error?: string;
}

type SpawnAppServer = (
  executablePath: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; detached: boolean },
) => ChildProcessWithoutNullStreams;

interface CodexAppServerTimeouts {
  requestMs: number;
  completionMs: number;
  shutdownGraceMs: number;
}

type TerminateAppServer = (child: ChildProcessWithoutNullStreams, shutdownGraceMs: number) => void;

interface ThreadStartResult {
  thread?: { id?: string };
  activePermissionProfile?: { id?: string };
}

interface TurnStartResult {
  turn?: { id?: string };
}

interface ConfigReadResult {
  config?: { mcp_servers?: unknown };
  origins?: unknown;
}

interface IsolatedCodexConfig {
  config: Record<string, unknown>;
  mcpServerAliases: Map<string, string>;
  permissionProfile: string;
}

/**
 * While persistence is on (the current default), Coredoc-owned Codex threads are materialized
 * under ~/.codex/sessions like ordinary Codex runs, so external session viewers can render and
 * debug them. Set COREDOC_CODEX_PERSIST_SESSIONS=false in the runtime .env to restore fully
 * ephemeral threads. The default is planned to flip to false a few releases from now — keep it
 * in sync with the same flag in @coredoc/cli's summarize codex-exec.
 */
export function codexSessionPersistenceEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.COREDOC_CODEX_PERSIST_SESSIONS?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(
    `COREDOC_CODEX_PERSIST_SESSIONS must be "true" or "false", got "${env.COREDOC_CODEX_PERSIST_SESSIONS}".`,
  );
}

const MAX_STDERR_BYTES = 16_384;
const DEFAULT_TIMEOUTS: CodexAppServerTimeouts = {
  requestMs: 30_000,
  completionMs: 60 * 60_000,
  shutdownGraceMs: 2_000,
};

function errorMessage(error: CodexAppServerMessage['error']): string {
  return error?.message ? `Codex App Server: ${error.message}` : 'Codex App Server request failed.';
}

function defaultSpawn(
  executablePath: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; detached: boolean },
): ChildProcessWithoutNullStreams {
  return spawn(executablePath, args, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isNullableRecord(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value);
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

const CODEX_SHELL_WRAPPERS = ['/bin/zsh -c', '/bin/zsh -lc', '/bin/bash -c', '/bin/bash -lc', '/bin/sh -c'];

export function isApprovedCommand(command: string, approvedCommands: string[]): boolean {
  const requested = command.trim();
  return approvedCommands.some((candidate) => {
    const approved = candidate.trim();
    if (requested === approved) return true;
    // App Server command items expose the exact model command wrapped in the platform shell.
    // Compare only literal wrappers Coredoc constructs here; never parse or execute shell text.
    const serialized = JSON.stringify(approved);
    return CODEX_SHELL_WRAPPERS.some((wrapper) => requested === `${wrapper} ${serialized}`);
  });
}

function hasConfigOrigin(origins: unknown, configPath: string): boolean {
  if (!isRecord(origins)) return true;
  return Object.keys(origins).some(
    (originPath) => originPath === configPath || originPath.startsWith(`${configPath}.`),
  );
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    const force = signal === 'SIGKILL' ? ['/f'] : [];
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', ...force], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }

  // Only real app-server children are detached into their own process group. Injected
  // test children deliberately omit spawnargs so this cannot signal an unrelated PID.
  if (child.pid && child.spawnargs?.includes('app-server')) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have exited between the state check and the group signal.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function defaultTerminate(child: ChildProcessWithoutNullStreams, shutdownGraceMs: number): void {
  signalProcessTree(child, 'SIGTERM');
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, 'SIGKILL');
  }, shutdownGraceMs);
  forceKill.unref();
  child.once('exit', () => clearTimeout(forceKill));
}

function isolateCodexConfig(
  requestedConfig: Record<string, unknown> | undefined,
  effectiveConfig: unknown,
  requestedPermissionProfile: string,
  toolMode?: 'none',
): IsolatedCodexConfig {
  if (!isRecord(effectiveConfig) || !isRecord(effectiveConfig.config)) {
    throw new Error('Codex App Server returned an unexpected config/read response.');
  }
  if (!isNullableRecord(effectiveConfig.config.mcp_servers)) {
    throw new Error('Codex App Server returned an unexpected config/read response.');
  }
  if (!isNullableRecord(effectiveConfig.config.permissions)) {
    throw new Error('Codex App Server returned an unexpected config/read response.');
  }
  if (!isNullableRecord(effectiveConfig.config.shell_environment_policy)) {
    throw new Error('Codex App Server returned an unexpected config/read response.');
  }
  const supportedShellPolicyKeys = new Set([
    'inherit',
    'ignore_default_excludes',
    'exclude',
    'set',
    'include_only',
    // config/read exposes the derived matcher list; it is not a user-settable TOML field.
    'filters',
    'experimental_use_profile',
  ]);
  if (
    isRecord(effectiveConfig.config.shell_environment_policy) &&
    Object.keys(effectiveConfig.config.shell_environment_policy).some((key) => !supportedShellPolicyKeys.has(key))
  ) {
    throw new Error('Codex App Server refused an unknown ambient shell environment policy.');
  }
  const ambientProvider = effectiveConfig.config.model_provider;
  const ambientProviders = effectiveConfig.config.model_providers;
  const ambientOpenAiBaseUrl = effectiveConfig.config.openai_base_url;
  const ambientChatGptBaseUrl = effectiveConfig.config.chatgpt_base_url;
  if (
    !isNullableString(ambientProvider) ||
    !isNullableRecord(ambientProviders) ||
    !isNullableString(ambientOpenAiBaseUrl) ||
    !isNullableString(ambientChatGptBaseUrl)
  ) {
    throw new Error('Codex App Server returned an unexpected config/read response.');
  }
  if (
    (ambientProvider !== undefined && ambientProvider !== null && ambientProvider !== 'openai') ||
    (isRecord(ambientProviders) && Object.hasOwn(ambientProviders, 'openai')) ||
    (typeof ambientOpenAiBaseUrl === 'string' && hasConfigOrigin(effectiveConfig.origins, 'openai_base_url')) ||
    (typeof ambientChatGptBaseUrl === 'string' && hasConfigOrigin(effectiveConfig.origins, 'chatgpt_base_url'))
  ) {
    throw new Error('Codex App Server refused an unsafe model provider override from the user configuration.');
  }
  const baseRequested = requestedConfig ?? {};
  const baseTools = asRecord(baseRequested.tools);
  const requested =
    toolMode === 'none'
      ? {
          ...baseRequested,
          agents: { ...asRecord(baseRequested.agents), enabled: false },
          features: {
            ...asRecord(baseRequested.features),
            multi_agent: false,
            multi_agent_v2: false,
            shell_tool: false,
            view_image: false,
            goals: false,
            tool_suggest: false,
            skill_mcp_dependency_install: false,
          },
          tools: {
            ...baseTools,
            update_plan: { ...asRecord(baseTools.update_plan), enabled: false },
            experimental_request_user_input: {
              ...asRecord(baseTools.experimental_request_user_input),
              enabled: false,
            },
          },
        }
      : baseRequested;
  const ambientShellPolicy = asRecord(effectiveConfig.config.shell_environment_policy);
  if (!isNullableRecord(ambientShellPolicy.set)) {
    throw new Error('Codex App Server returned an unexpected config/read response.');
  }
  const neutralizedAmbientShellSet = Object.fromEntries(
    Object.keys(asRecord(ambientShellPolicy.set)).map((key) => [key, '']),
  );
  const requestedMcpServers = asRecord(requested.mcp_servers);
  const ambientMcpServers = asRecord(effectiveConfig.config.mcp_servers);
  const requestedPermissions = asRecord(requested.permissions);
  const ambientPermissions = asRecord(effectiveConfig.config.permissions);
  const disabledAmbientMcpServers = Object.fromEntries(
    Object.keys(ambientMcpServers).map((serverId) => [serverId, { enabled: false }]),
  );
  const isolatedMcpServers: Record<string, unknown> = { ...disabledAmbientMcpServers };
  const occupiedServerIds = new Set([...Object.keys(ambientMcpServers), ...Object.keys(requestedMcpServers)]);
  const mcpServerAliases = new Map<string, string>();
  let runtimeServerNumber = 1;

  for (const [serverId, serverConfig] of Object.entries(requestedMcpServers)) {
    let isolatedServerId = serverId;
    if (Object.hasOwn(ambientMcpServers, serverId)) {
      do {
        isolatedServerId = `coredoc_runtime${runtimeServerNumber === 1 ? '' : `_${runtimeServerNumber}`}`;
        runtimeServerNumber += 1;
      } while (occupiedServerIds.has(isolatedServerId));
      occupiedServerIds.add(isolatedServerId);
      mcpServerAliases.set(serverId, isolatedServerId);
    }
    isolatedMcpServers[isolatedServerId] = serverConfig;
  }

  const isolatedPermissions = { ...requestedPermissions };
  let permissionProfile = requestedPermissionProfile;
  if (
    Object.hasOwn(requestedPermissions, requestedPermissionProfile) &&
    Object.hasOwn(ambientPermissions, requestedPermissionProfile)
  ) {
    const occupiedPermissionIds = new Set([...Object.keys(ambientPermissions), ...Object.keys(requestedPermissions)]);
    let permissionNumber = 1;
    do {
      permissionProfile = `coredoc_runtime_permission${permissionNumber === 1 ? '' : `_${permissionNumber}`}`;
      permissionNumber += 1;
    } while (occupiedPermissionIds.has(permissionProfile));
    isolatedPermissions[permissionProfile] = requestedPermissions[requestedPermissionProfile];
    delete isolatedPermissions[requestedPermissionProfile];
  }

  return {
    config: {
      ...requested,
      features: {
        ...asRecord(requested.features),
        plugins: false,
        apps: false,
        hooks: false,
      },
      mcp_servers: isolatedMcpServers,
      // Codex 0.156+ fails every sampling request with "failed to load workspace requirements"
      // when a thread defines [permissions] without a matching default_permissions.
      ...(requested.permissions !== undefined
        ? { permissions: isolatedPermissions, default_permissions: permissionProfile }
        : {}),
      model_provider: 'openai',
      notify: [],
      allow_login_shell: false,
      shell_environment_policy: {
        inherit: 'none',
        ignore_default_excludes: false,
        exclude: [],
        set: { ...neutralizedAmbientShellSet, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        include_only: ['PATH'],
        experimental_use_profile: false,
      },
    },
    mcpServerAliases,
    permissionProfile,
  };
}

function rewriteMcpToolNames(value: string | undefined, aliases: Map<string, string>): string | undefined {
  let rewritten = value;
  for (const [source, target] of aliases) {
    rewritten = rewritten?.split(`mcp__${source}__`).join(`mcp__${target}__`);
  }
  return rewritten;
}

/** A deliberately small JSONL client for the Codex App Server surface used by Coredoc. */
export class CodexAppServerClient {
  constructor(
    private readonly executablePath: string,
    private readonly spawnAppServer: SpawnAppServer = defaultSpawn,
    private readonly timeouts: CodexAppServerTimeouts = DEFAULT_TIMEOUTS,
    private readonly terminateAppServer: TerminateAppServer = defaultTerminate,
  ) {}

  async run(options: CodexAppServerRunOptions): Promise<CodexAppServerRunResult> {
    if (options.signal.aborted) throw new Error('Codex run cancelled.');
    // Resolved before spawning so a malformed flag fails fast without leaking a child process.
    const ephemeral = !codexSessionPersistenceEnabled(options.env);

    // Coredoc-owned runs (authoring, chat, summarize) are metered by their own telemetry; the
    // machine-wide managed [otel] exporter must NOT also stream them to the capture relay —
    // these ephemeral sessions never claim attribution, so every record would sit in the
    // relay's claim buffer and be rejected ("Session attribution degraded"). The exporter is
    // process-level (started from user config before any thread override), so it can only be
    // disabled here, on the spawn command line.
    const child = this.spawnAppServer(this.executablePath, ['-c', 'otel.exporter="none"', 'app-server'], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let nextId = 1;
    let stdoutBuffer = '';
    let stderr = '';
    let threadId: string | undefined;
    let turnId: string | undefined;
    let cancelled = false;
    let settled = false;
    let terminalError: Error | undefined;
    const reportedDeclinedOperations = new Set<string>();
    const pending = new Map<
      number | string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
    >();
    // One waiter per in-flight turn; re-armed by the follow-up-turn loop below. A server
    // request can reject it before turn/start has returned, so every await observes rejection.
    let turnWaiter: { resolve: (message: CodexAppServerMessage) => void; reject: (error: Error) => void } | undefined;
    const awaitTurnCompletion = (): Promise<CodexAppServerMessage> =>
      new Promise<CodexAppServerMessage>((resolve, reject) => {
        if (terminalError) {
          reject(terminalError);
          return;
        }
        const timeout = setTimeout(() => {
          turnWaiter = undefined;
          reject(new Error('Codex App Server timed out waiting for turn completion.'));
        }, this.timeouts.completionMs);
        timeout.unref();
        turnWaiter = {
          resolve: (message) => {
            clearTimeout(timeout);
            resolve(message);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        };
      });

    const send = (message: CodexAppServerMessage): void => {
      if (terminalError) throw terminalError;
      if (child.stdin.destroyed || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Codex App Server closed its input stream.');
      }
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) rejectPending(new Error(`Codex App Server input failed: ${error.message}`));
      });
    };
    const request = <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex App Server timed out waiting for ${method}.`));
        }, this.timeouts.requestMs);
        timeout.unref();
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
        try {
          send({ id, method, params });
        } catch (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };
    const rejectPending = (error: Error): void => {
      terminalError ??= error;
      for (const item of pending.values()) {
        clearTimeout(item.timeout);
        item.reject(error);
      }
      pending.clear();
      const waiter = turnWaiter;
      turnWaiter = undefined;
      waiter?.reject(error);
    };
    const respond = (id: number | string, result: unknown): void => send({ id, result });

    const handleServerRequest = async (message: CodexAppServerMessage): Promise<void> => {
      if (message.id === undefined || !message.method) return;
      if (message.method === 'item/tool/call') {
        if (!options.onDynamicToolCall) {
          respond(message.id, {
            success: false,
            contentItems: [{ type: 'inputText', text: 'This Coredoc dynamic tool is unavailable.' }],
          });
          return;
        }
        try {
          respond(message.id, await options.onDynamicToolCall(message.params ?? {}));
        } catch (error) {
          send({
            id: message.id,
            error: { code: -32_000, message: error instanceof Error ? error.message : 'Dynamic tool failed.' },
          });
        }
        return;
      }
      if (message.method === 'item/tool/requestUserInput') {
        if (!options.onRequestUserInput) {
          respond(message.id, { answers: {} });
          return;
        }
        try {
          respond(message.id, await options.onRequestUserInput(message.params ?? {}));
        } catch (error) {
          send({
            id: message.id,
            error: { code: -32_000, message: error instanceof Error ? error.message : 'Input failed.' },
          });
        }
        return;
      }

      if (message.method === 'item/permissions/requestApproval' || message.method === 'turn/requestPermissions') {
        respond(message.id, { permissions: {} });
        rejectPending(new Error('Codex requested permissions beyond the active Coredoc profile.'));
        return;
      }
      if (
        message.method === 'item/commandExecution/requestApproval' ||
        message.method === 'item/fileChange/requestApproval'
      ) {
        // Runs use approvalPolicy=never: operations inside the active sandbox execute directly.
        // A request here is therefore unexpected. Deny only that operation and keep the turn alive.
        respond(message.id, { decision: 'decline' });
        const operation = message.method === 'item/fileChange/requestApproval' ? 'file change' : 'command';
        if (!reportedDeclinedOperations.has(operation)) {
          reportedDeclinedOperations.add(operation);
          options.onNotification?.({ method: 'coredoc/operationApprovalDeclined', params: { operation } });
        }
        return;
      }
      if (message.method.includes('requestApproval')) {
        respond(message.id, { decision: 'cancel' });
        rejectPending(new Error('Codex requested an operation that Coredoc did not authorize.'));
        return;
      }
      send({
        id: message.id,
        error: { code: -32_601, message: 'Unsupported Codex App Server request.' },
      });
      rejectPending(new Error(`Codex App Server sent unsupported request: ${message.method}.`));
    };

    const handleMessage = (message: CodexAppServerMessage): void => {
      if (message.id !== undefined && !message.method) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timeout);
        if (message.error) waiter.reject(new Error(errorMessage(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      if (message.id !== undefined && message.method) {
        void handleServerRequest(message).catch((error) =>
          rejectPending(error instanceof Error ? error : new Error(String(error))),
        );
        return;
      }
      if (!message.method) return;
      options.onNotification?.(message);
      // Scout turns share the stream; their completion or cancellation must not end the owning run.
      if (message.method === 'turn/completed' && message.params?.threadId === threadId) {
        const waiter = turnWaiter;
        turnWaiter = undefined;
        waiter?.resolve(message);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line) as CodexAppServerMessage);
          } catch {
            rejectPending(new Error('Codex App Server returned invalid JSON.'));
          }
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    child.stdin.once('error', (error) => rejectPending(error));
    child.once('error', (error) => rejectPending(error));
    child.once('exit', (code, signal) => {
      if (settled) return;
      const detail = stderr.trim();
      rejectPending(
        new Error(
          `Codex App Server exited before the turn completed (${signal ?? code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`,
        ),
      );
    });

    const onAbort = (): void => {
      cancelled = true;
      if (threadId && turnId) {
        void request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      } else if (!threadId) {
        rejectPending(new Error('Codex run cancelled.'));
      }
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await request('initialize', {
        clientInfo: { name: 'coredoc-desktop', title: 'Coredoc Desktop', version: '1.1.0' },
        capabilities: { experimentalApi: true },
      });
      send({ method: 'initialized', params: {} });
      if (options.signal.aborted) throw new Error('Codex run cancelled.');

      // Codex merges user and project config into thread overrides. Enumerate and disable ambient extension sources first.
      const effectiveConfig = await request<ConfigReadResult>('config/read', {
        includeLayers: false,
        cwd: options.cwd,
      });
      const isolated = isolateCodexConfig(options.config, effectiveConfig, options.permissionProfile, options.toolMode);
      if (options.signal.aborted) throw new Error('Codex run cancelled.');

      const thread = await request<ThreadStartResult>('thread/start', {
        cwd: options.cwd,
        ephemeral,
        approvalPolicy: 'never',
        serviceName: 'coredoc_desktop',
        permissions: isolated.permissionProfile,
        runtimeWorkspaceRoots: options.runtimeWorkspaceRoots,
        ...(options.toolMode === 'none'
          ? { environments: [], dynamicTools: [] }
          : options.dynamicTools
            ? { dynamicTools: options.dynamicTools }
            : {}),
        config: isolated.config,
        model: options.model,
        developerInstructions: rewriteMcpToolNames(options.developerInstructions, isolated.mcpServerAliases),
      });
      threadId = thread.thread?.id;
      if (!threadId) throw new Error('Codex App Server did not return a thread id.');
      if (thread.activePermissionProfile?.id !== isolated.permissionProfile) {
        throw new Error(`Codex did not activate the required "${isolated.permissionProfile}" permission profile.`);
      }
      if (options.signal.aborted) throw new Error('Codex run cancelled.');

      const runTurn = async (text: string): Promise<{ status: string; durationMs?: number; error?: string }> => {
        // Arm the waiter BEFORE turn/start so a fast completion can never race past it.
        const completion = awaitTurnCompletion();
        void completion.catch(() => undefined);
        try {
          const turn = await request<TurnStartResult>('turn/start', {
            threadId,
            input: [{ type: 'text', text }],
            outputSchema: options.outputSchema,
          });
          turnId = turn.turn?.id;
          if (!turnId) throw new Error('Codex App Server did not return a turn id.');
          if (cancelled || options.signal.aborted) {
            void request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
          }
        } catch (error) {
          const waiter = turnWaiter;
          turnWaiter = undefined;
          waiter?.reject(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        const completed = await completion;
        const completedTurn = completed.params?.turn as
          | { status?: string; durationMs?: number; error?: { message?: string } | null }
          | undefined;
        return {
          status: completedTurn?.status ?? 'completed',
          ...(completedTurn?.durationMs !== undefined ? { durationMs: completedTurn.durationMs } : {}),
          ...(completedTurn?.error?.message ? { error: completedTurn.error.message } : {}),
        };
      };

      // A Codex turn ends whenever the model decides to stop — unlike the Claude SDK's
      // run-to-result loop — so `nextTurn` lets the caller nudge multi-phase work forward on the
      // same thread (context preserved) until the deliverable exists or the caller gives up.
      let outcome = await runTurn(rewriteMcpToolNames(options.prompt, isolated.mcpServerAliases) ?? options.prompt);
      let turns = 1;
      let durationMs = outcome.durationMs;
      while (outcome.status === 'completed' && !cancelled && !options.signal.aborted && options.nextTurn) {
        const followUp = options.nextTurn(turns);
        if (!followUp) break;
        outcome = await runTurn(followUp);
        turns += 1;
        if (outcome.durationMs !== undefined) durationMs = (durationMs ?? 0) + outcome.durationMs;
      }
      if (cancelled || outcome.status === 'interrupted') throw new Error('Codex run cancelled.');
      return {
        threadId,
        turnId: turnId as string,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
        turns,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    } finally {
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      for (const item of pending.values()) {
        clearTimeout(item.timeout);
        item.reject(new Error('Codex App Server run ended.'));
      }
      pending.clear();
      this.terminateAppServer(child, this.timeouts.shutdownGraceMs);
    }
  }
}
