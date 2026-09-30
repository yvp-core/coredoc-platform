import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AccessMode, TreatmentAdherence } from './types.js';
import type {
  AgentStatus,
  CurrentAgentRunResult,
  ToolCallSummary,
  Usage,
} from './types.js';
import { REQUIRED_MCP_TOOL_SUFFIXES, workspaceFaultResult, type RunAgentOpts } from './agent.js';
import { agentWorkspaceFault } from './access-workspace.js';

/**
 * OpenAI Codex CLI runner — the `--provider=codex` counterpart of agent.ts.
 *
 * Grounded against codex-cli 0.148.0 (`codex exec --help`). Notable facts that
 * shaped this file and are NOT guesses:
 *   - `codex exec` has no `--ask-for-approval`; non-interactive runs are always
 *     approval-policy `never`. An MCP tool call is therefore *rejected* unless
 *     the server is configured with `default_tools_approval_mode = "approve"`
 *     (valid variants: auto | prompt | writes | approve). Verified live: with
 *     `auto` the call fails with "MCP tool call requires approval, but approval
 *     policy is never"; with `approve` it returns real tool output.
 *   - `--ignore-user-config` is required: this machine's `~/.codex/config.toml`
 *     already defines an `mcp_servers.coredoc` (cloud streamable-HTTP) entry,
 *     and `-c` overrides *merge* into it, producing
 *     "url is not supported for stdio". Ignoring the user config also keeps the
 *     eval hermetic (no personal MCP servers / plugins leaking into a run).
 *     Auth still resolves from `$CODEX_HOME/auth.json`.
 *   - The MCP server subprocess is spawned by codex itself, outside the
 *     model-facing sandbox, so the filesystem policy does not block it reading
 *     the graph DB inside coredoc-parser (verified live from a foreign cwd).
 *
 * Contract-level differences from the Claude runner, all deliberate:
 *   - `maxTurns` has no codex equivalent — ignored (see buildCodexArgs).
 *   - `allowedTools` / `extraTools` / `baseTools` have no equivalent either:
 *     codex ships a fixed toolset. A named read-only permissions profile scoped
 *     to the declared roots is what guarantees the worktree is never mutated and
 *     nothing outside those roots is read.
 *   - `systemPrompt` has no flag on `codex exec`; it is prepended to the user
 *     prompt as a delimited block.
 */

export const CODEX_BIN = 'codex';
export const CODEX_MCP_SERVER_NAME = 'coredoc-eval';

/** Normalized view of one `codex exec --json` JSONL stream. */
export interface CodexStreamParse {
  responseText: string;
  toolCalls: ToolCallSummary[];
  usage: Usage;
  /** Model id if any event carries one; codex 0.148 usually omits it. */
  model: string | null;
  /** Terminal failures reported by the stream itself (turn.failed / error). */
  streamError: string | null;
  turnCompleted: boolean;
  turnFailed: boolean;
  events: unknown[];
}

/**
 * Maps a codex item type onto the tool name vocabulary the rest of the harness
 * already speaks (analyze-mcp.ts / report.ts key off `mcp__` prefixes and the
 * Claude base-tool names).
 */
export function codexItemToToolName(item: {
  type?: string;
  server?: string;
  tool?: string;
}): string | null {
  switch (item.type) {
    case 'mcp_tool_call':
      // `mcp__<server>__<tool>` mirrors the Claude SDK naming so tool-mix and
      // gap analysis stay provider-agnostic.
      return `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'unknown'}`;
    case 'command_execution':
      // codex executes everything (read, grep, glob) through one shell tool.
      return 'Bash';
    case 'file_change':
      return 'Edit';
    case 'web_search':
      return 'WebSearch';
    default:
      // agent_message / reasoning / todo_list / error are not tool calls.
      return null;
  }
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

/**
 * Parses the `codex exec --json` JSONL stream.
 *
 * Event shapes observed live on 0.148.0:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{...}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"coredoc",
 *      "tool":"describe_repository","arguments":{},"result":{...}|null,"error":{...}|null,
 *      "status":"completed"|"failed"}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution",
 *      "command":"/bin/zsh -lc 'cat f.txt'","aggregated_output":"...","exit_code":0,
 *      "status":"completed"}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
 *      "cache_write_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}
 *
 * Non-JSON lines (e.g. codex's "Reading additional input from stdin...") are
 * preserved as `{type:'raw',text}` so the transcript stays lossless.
 */
export function parseCodexStream(stdout: string): CodexStreamParse {
  const events: unknown[] = [];
  const toolCallCounts = new Map<string, number>();
  const agentMessages: string[] = [];
  const usage = emptyUsage();
  let model: string | null = null;
  let streamError: string | null = null;
  let turnCompleted = false;
  let turnFailed = false;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      events.push({ type: 'raw', text: trimmed });
      continue;
    }
    events.push(parsed);

    const ev = parsed as {
      type?: string;
      model?: string;
      error?: unknown;
      message?: string;
      item?: { type?: string; text?: string; server?: string; tool?: string };
      usage?: Record<string, number>;
    };
    // codex 0.148 does not put the model on any documented event; read it
    // opportunistically so a future version fills the RunRecord for free.
    if (typeof ev.model === 'string') model = ev.model;

    if (ev.type === 'item.completed' && ev.item) {
      const item = ev.item;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        agentMessages.push(item.text);
      }
      const toolName = codexItemToToolName(item);
      if (toolName) toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);
    } else if (ev.type === 'turn.completed' && ev.usage) {
      turnCompleted = true;
      streamError = null;
      // One `codex exec` invocation emits exactly one turn.completed; take the
      // last one rather than summing, because a resumed/continued turn would
      // report cumulative counters and summing would double-count.
      const u = ev.usage;
      const cached = u.cached_input_tokens ?? 0;
      const cacheWrite = u.cache_write_input_tokens ?? 0;
      // codex's input_tokens is the *total* prompt size including the cached
      // part; the Claude shape keeps them disjoint, so subtract to keep
      // totalTokens (the sum) from double-counting.
      usage.inputTokens = Math.max(0, (u.input_tokens ?? 0) - cached);
      usage.cacheReadTokens = cached;
      usage.cacheCreationTokens = cacheWrite;
      usage.outputTokens = u.output_tokens ?? 0;
    } else if (ev.type === 'turn.completed') {
      turnCompleted = true;
      streamError = null;
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      const detail =
        typeof ev.message === 'string'
          ? ev.message
          : JSON.stringify(ev.error ?? ev).slice(0, 500);
      streamError = `codex ${ev.type}: ${detail}`;
      if (ev.type === 'turn.failed') turnFailed = true;
    }
  }

  usage.totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  // Codex does not report a dollar cost (ChatGPT-plan usage is not priced per
  // call). Leave 0 rather than inventing pricing; the report renders $0.000.
  usage.costUsd = 0;

  return {
    responseText: agentMessages.at(-1) ?? '',
    toolCalls: [...toolCallCounts.entries()].map(([name, count]) => ({ name, count })),
    usage,
    model,
    streamError,
    turnCompleted,
    turnFailed,
    events,
  };
}

export interface CodexOutcome {
  agentStatus: AgentStatus;
  responseText: string;
  error: string | null;
  treatmentAdherence: TreatmentAdherence;
}

/**
 * Whether the required MCP server's tools were reachable for a withMcp run.
 *
 * Codex 0.148/0.150 never advertises its tool list on the `--json` stream (nor
 * in the session rollout file), so when the server subprocess fails to start
 * codex silently proceeds tool-less and the agent answers from bash alone.
 * That is an infrastructure failure, not a treatment-integrity failure by the
 * agent, and must not be scored ITT 0.
 */
export enum McpAvailability {
  /** Not probed — treat a missing MCP call as the agent's own choice. */
  Unknown = 'unknown',
  /** The server started and advertised the WHOLE required toolset. */
  Available = 'available',
  /**
   * The server could not be started, advertised no tools, or advertised only
   * part of the required toolset — the treatment surface was never fully
   * applied, so the run is infrastructure, not agent noncompliance. Same bar as
   * the Claude runner's init-record check (REQUIRED_MCP_TOOL_SUFFIXES).
   */
  Unavailable = 'unavailable',
}

export function classifyCodexOutcome(opts: {
  parsed: CodexStreamParse;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  lastMessage: string | null;
  timeoutMs?: number;
  requiredMcpServerName?: string;
  /** Result of probing the required server; see {@link McpAvailability}. */
  requiredMcpAvailability?: McpAvailability;
}): CodexOutcome {
  const notApplicable = TreatmentAdherence.NotApplicable;
  if (opts.timedOut) {
    return {
      agentStatus: 'task_failed',
      responseText: '',
      error: `codex exec timed out after ${opts.timeoutMs ?? '<unknown>'}ms (partial output kept)`,
      treatmentAdherence: notApplicable,
    };
  }
  if (opts.exitCode !== 0) {
    return {
      agentStatus: 'infrastructure_error',
      responseText: '',
      error: `codex exec exited with code ${opts.exitCode ?? '<none>'}: ${opts.stderr.trim().slice(-500)}`,
      treatmentAdherence: notApplicable,
    };
  }
  if (opts.parsed.turnFailed || (!opts.parsed.turnCompleted && opts.parsed.streamError)) {
    return {
      agentStatus: 'infrastructure_error',
      responseText: '',
      error: opts.parsed.streamError ?? 'codex turn failed',
      treatmentAdherence: notApplicable,
    };
  }
  if (!opts.parsed.turnCompleted) {
    return {
      agentStatus: 'infrastructure_error',
      responseText: '',
      error: 'codex exec stream ended before turn.completed',
      treatmentAdherence: notApplicable,
    };
  }
  if (opts.lastMessage === null || !opts.lastMessage.trim()) {
    return {
      agentStatus: 'infrastructure_error',
      responseText: '',
      error: 'codex turn.completed but output-last-message was missing or empty',
      treatmentAdherence: notApplicable,
    };
  }
  if (
    opts.requiredMcpServerName &&
    !opts.parsed.toolCalls.some(
      ({ name, count }) =>
        count > 0 && name.startsWith(`mcp__${opts.requiredMcpServerName}__`),
    )
  ) {
    // No MCP call happened. Whether that is the agent's fault depends on
    // whether the tools existed at all: a server that never registered leaves
    // codex tool-less and silent, which is infrastructure, not treatment.
    if (opts.requiredMcpAvailability === McpAvailability.Unavailable) {
      return {
        agentStatus: 'infrastructure_error',
        responseText: '',
        error: `required MCP server ${opts.requiredMcpServerName} advertised no tools: the server never registered, so the withMcp treatment was never applied`,
        treatmentAdherence: notApplicable,
      };
    }
    // Tools were reachable (or at least not provably absent) and the agent
    // answered anyway. That is a treatment-dose failure, NOT a failed task:
    // the answer is real and gets graded. Adherence carries the dose signal,
    // and reporting keeps the run out of the headline estimand.
    return {
      agentStatus: 'completed',
      responseText: opts.lastMessage,
      error: null,
      treatmentAdherence: TreatmentAdherence.Noncompliant,
    };
  }
  return {
    agentStatus: 'completed',
    responseText: opts.lastMessage,
    error: null,
    treatmentAdherence: opts.requiredMcpServerName
      ? TreatmentAdherence.Compliant
      : notApplicable,
  };
}

/** Escapes a string for embedding in a TOML basic string. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Builds the `-c mcp_servers.<name>={...}` inline-table override. The `-c`
 * value is parsed as TOML, so an inline table expresses command/args/env in a
 * single flag — no temp config.toml or CODEX_HOME shim is needed, and auth
 * keeps resolving from the real `$CODEX_HOME/auth.json`.
 */
export function buildMcpServerOverride(
  serverCommand: string,
  env: Record<string, string> | undefined,
  serverName = CODEX_MCP_SERVER_NAME,
): string {
  const envEntries = Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${tomlString(v)}`)
    .join(',');
  const fields = [
    'command="node"',
    `args=[${tomlString(serverCommand)}]`,
    ...(envEntries ? [`env={${envEntries}}`] : []),
    'startup_timeout_sec=60',
    'required=true',
    // Without this every MCP call is rejected: `codex exec` runs with approval
    // policy `never` and MCP tools default to requiring approval.
    'default_tools_approval_mode="approve"',
  ];
  return `mcp_servers.${serverName}={${fields.join(',')}}`;
}

/** Named permissions profile applied to codex worktree runs. */
const WORKTREE_PERMISSION_PROFILE = 'coredoc-eval-worktree';

/**
 * Builds the `filesystem` inline table of a read-only permissions profile:
 * platform minimum, the cwd, and one entry per additional declared root.
 *
 * Grammar verified against codex-cli 0.150.1 (probe, 2026-08-29): an absolute
 * path is a valid filesystem key ("filesystem path `…` must be absolute, use
 * `~/...`, or start with `:`") and grants read on its subtree — a probe agent
 * read a file under a granted sibling directory and was refused a sibling that
 * was not granted, under `--strict-config` with no warning on stderr.
 */
function readOnlyFilesystemTable(additionalReadRoots: readonly string[]): string {
  const entries = ['":minimal"="read"', '":workspace_roots"={"."="read"}'];
  for (const root of [...new Set(additionalReadRoots)]) {
    entries.push(`${tomlString(root)}="read"`);
  }
  return `{${entries.join(',')}}`;
}

export interface CodexArgsOpts {
  cwd: string;
  lastMessagePath: string;
  withMcp: boolean;
  /**
   * Absolute paths of the cell's pinned sibling checkouts, granted read access
   * alongside the cwd. Empty for every run that pins no siblings.
   */
  additionalReadRoots?: readonly string[];
  mcpServerCommand?: string;
  mcpServerEnv?: Record<string, string>;
  prompt: string;
  historylessWorkspaceOnly?: boolean;
  /**
   * `codex exec -m/--model <name>`. Optional: codex resolves its own default
   * (config.toml / CLI default) when omitted. Recorded verbatim in the
   * report meta / RunRecord model field when provided — codex 0.148 does
   * not otherwise surface a model id anywhere in its `--json` stream.
   */
  model?: string;
}

export function buildCodexArgs(opts: CodexArgsOpts): string[] {
  const args = [
    'exec',
    '--json',
    // Hermetic: no personal config.toml / MCP servers / plugins in an eval.
    '--ignore-user-config',
    '--strict-config',
    '--skip-git-repo-check',
    // Hermetic: codex auto-injects the worktree's AGENTS.md into instructions
    // (verified live: a cd-target run quoted ours verbatim, ~19k input tokens),
    // which the claude arm never sees (SDK loads no project settings) — an
    // asymmetric confound that also biases codex toward re-verifying tools.
    // 0 means "no limit", so 1 byte is the effective off-switch.
    '-c',
    'project_doc_max_bytes=1',
    // Every mode runs under a named read-only permissions profile rather than
    // `--sandbox read-only`, which blocks writes and network but not reads
    // elsewhere on the filesystem — a codex worktree agent could otherwise read
    // another checkout of the same repo at a different revision. The historyless
    // profile is cwd-only; the worktree profile additionally grants the cell's
    // pinned sibling checkouts, which preflight has verified. Neither profile
    // declares a `network` table, so both inherit the same network treatment the
    // historyless arm has run under since it shipped.
    ...(opts.historylessWorkspaceOnly
      ? [
          '-c',
          'default_permissions="coredoc-eval-historyless"',
          '-c',
          `permissions.coredoc-eval-historyless.filesystem=${readOnlyFilesystemTable([])}`,
        ]
      : [
          '-c',
          `default_permissions=${tomlString(WORKTREE_PERMISSION_PROFILE)}`,
          '-c',
          `permissions.${WORKTREE_PERMISSION_PROFILE}.filesystem=${readOnlyFilesystemTable(opts.additionalReadRoots ?? [])}`,
        ]),
    '-C',
    opts.cwd,
    '--output-last-message',
    opts.lastMessagePath,
  ];
  if (opts.model) args.push('-m', opts.model);
  // NOTE: `maxTurns` is intentionally absent — codex exec has no turn cap flag.
  if (opts.withMcp && opts.mcpServerCommand) {
    args.push('-c', buildMcpServerOverride(opts.mcpServerCommand, {
      ...opts.mcpServerEnv,
      COREDOC_MCP_METRICS_DISABLED: '1',
    }));
  }
  // `--` terminates flag parsing: eval prompts routinely start with a `---`
  // section delimiter, which clap otherwise rejects as an unknown argument.
  args.push('--', opts.prompt);
  return args;
}

/** Composes the single prompt string codex receives (no system-prompt flag). */
export function buildCodexPrompt(opts: {
  systemPrompt: string;
  prompt: string;
}): string {
  const parts = [`--- operating instructions ---\n${opts.systemPrompt}`];
  parts.push(`--- task ---\n${opts.prompt}`);
  return parts.join('\n\n');
}

/**
 * Fail fast at pipeline start rather than mid-matrix: verify the CLI exists and
 * that credentials are present.
 */
export function assertCodexAvailable(): void {
  let version: string;
  try {
    version = execFileSync(CODEX_BIN, ['--version'], { encoding: 'utf8' }).trim();
  } catch (e) {
    throw new Error(
      `--provider=codex requires the codex CLI on PATH (npm i -g @openai/codex). ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  if (!existsSync(join(codexHome, 'auth.json'))) {
    throw new Error(
      `codex is installed (${version}) but not authenticated: no auth.json in ${codexHome}. Run \`codex login\` first.`,
    );
  }
}

export interface RunCodexAgentOpts extends RunAgentOpts {
  /**
   * `--codex-model` / `COREDOC_EVAL_CODEX_MODEL` passthrough. Distinct from
   * the base `model` field (which carries the Claude agent model id and has
   * no meaning for codex) — kept separate so the claude runner never mistakes
   * this for its own model option.
   */
  codexModel?: string;
}

export async function runCodexAgent(opts: RunCodexAgentOpts): Promise<CurrentAgentRunResult> {
  if (!opts.codexModel) {
    throw new Error('Codex eval requires an explicit --codex-model; the CLI stream does not report a resolved model.');
  }
  // Same spawn-time workspace precondition as the Claude runner: `codex exec -C`
  // into an empty directory yields a graded "I cannot find the repo" answer.
  const fault = agentWorkspaceFault(opts.cwd, opts.accessMode);
  if (fault) {
    return workspaceFaultResult({
      fault,
      transcriptPath: opts.transcriptPath,
      model: opts.codexModel,
    });
  }
  const withMcp = (opts.armFactors ?? { mcp: opts.arm !== 'withoutMcp' }).mcp;
  const lastMessagePath = `${opts.transcriptPath}.last-message.txt`;
  const prompt = buildCodexPrompt({
    systemPrompt: opts.systemPrompt,
    prompt: opts.prompt,
  });
  const args = buildCodexArgs({
    cwd: opts.cwd,
    lastMessagePath,
    withMcp,
    ...(opts.mcpServerCommand && { mcpServerCommand: opts.mcpServerCommand }),
    ...(opts.mcpServerEnv && { mcpServerEnv: opts.mcpServerEnv }),
    ...(opts.codexModel && { model: opts.codexModel }),
    ...(opts.additionalReadRoots?.length && {
      additionalReadRoots: opts.additionalReadRoots,
    }),
    ...(opts.accessMode === AccessMode.HistorylessSnapshot && {
      historylessWorkspaceOnly: true,
    }),
    prompt,
  });

  mkdirSync(dirname(opts.transcriptPath), { recursive: true });

  const startedAt = Date.now();
  const { stdout, stderr, exitCode, timedOut } = await spawnCodex(args, opts.timeoutMs);
  const parsed = parseCodexStream(stdout);

  writeFileSync(opts.transcriptPath, JSON.stringify(parsed.events, null, 2));
  writeFileSync(`${opts.transcriptPath}.stderr.log`, stderr);

  // Only probe on the path where the answer matters: a withMcp run that made
  // no MCP call at all. Every other run either used the tools (so they existed)
  // or never required them.
  const madeRequiredMcpCall = parsed.toolCalls.some(
    ({ name, count }) => count > 0 && name.startsWith(`mcp__${CODEX_MCP_SERVER_NAME}__`),
  );
  const requiredMcpAvailability =
    withMcp && !madeRequiredMcpCall && opts.mcpServerCommand
      ? await probeMcpToolAvailability(opts.mcpServerCommand, opts.mcpServerEnv)
      : McpAvailability.Unknown;

  const outcome = classifyCodexOutcome({
    parsed,
    exitCode,
    timedOut,
    stderr,
    lastMessage: existsSync(lastMessagePath) ? readFileSync(lastMessagePath, 'utf8') : null,
    timeoutMs: opts.timeoutMs,
    ...(withMcp && {
      requiredMcpServerName: CODEX_MCP_SERVER_NAME,
      requiredMcpAvailability,
    }),
  });

  return {
    ...outcome,
    usage: parsed.usage,
    latencyMs: Date.now() - startedAt,
    toolCalls: parsed.toolCalls,
    transcriptPath: opts.transcriptPath,
    // Prefer the explicit --codex-model flag (what we actually asked codex
    // to run as) over anything opportunistically parsed off the stream —
    // codex 0.148 doesn't emit one, but a future version might.
    model: opts.codexModel,
  };
}

/** Wall-clock cap for the stdio handshake; the server's own startup cap is 60s. */
const MCP_PROBE_TIMEOUT_MS = 60_000;

/**
 * Probes the MCP server the way codex would: spawn it over stdio, `initialize`,
 * then `tools/list`.
 *
 * This is the only deterministic signal available — codex emits no tool
 * inventory anywhere (verified against the 2026-08-24 rollout files for both a
 * working and a failing withMcp session), and parsing the agent's prose ("the
 * requested coredoc tools are not exposed") is not a contract. Because the
 * probe runs after the agent, a *transient* startup failure would still be
 * classified as `task_failed`; that direction is the safe one (it never
 * excuses an agent that had tools and ignored them).
 */
/**
 * Reads a `tools/list` result as the availability verdict.
 *
 * Symmetric with the Claude runner's `evaluateInitMcpAvailability`: a server
 * that registered only part of REQUIRED_MCP_TOOL_SUFFIXES is Unavailable, not
 * Available — a half-registered server is an infrastructure fault, and scoring
 * it as treatment would attribute the missing tools to the agent.
 */
export function evaluateToolsListAvailability(tools: unknown): McpAvailability {
  if (!Array.isArray(tools) || tools.length === 0) return McpAvailability.Unavailable;
  const advertised = new Set(
    tools.flatMap((tool) => {
      const name = typeof tool === 'object' && tool !== null ? (tool as { name?: unknown }).name : undefined;
      return typeof name === 'string' ? [name] : [];
    }),
  );
  return REQUIRED_MCP_TOOL_SUFFIXES.every((name) => advertised.has(name))
    ? McpAvailability.Available
    : McpAvailability.Unavailable;
}

export async function probeMcpToolAvailability(
  serverCommand: string,
  env: Record<string, string> | undefined,
  timeoutMs = MCP_PROBE_TIMEOUT_MS,
): Promise<McpAvailability> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (availability: McpAvailability) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolvePromise(availability);
    };

    const child = spawn(process.execPath, [serverCommand], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, ...(env ?? {}), OPENSSL_CONF: '/dev/null' },
    });
    const timer = setTimeout(() => settle(McpAvailability.Unavailable), timeoutMs);

    child.on('error', () => settle(McpAvailability.Unavailable));
    child.on('close', () => settle(McpAvailability.Unavailable));

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: unknown; result?: { tools?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
          );
          continue;
        }
        if (message.id === 2) {
          settle(evaluateToolsListAvailability(message.result?.tools));
        }
      }
    });

    child.stdin.on('error', () => settle(McpAvailability.Unavailable));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'coredoc-eval-mcp-probe', version: '0.0.0' },
        },
      })}\n`,
    );
  });
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function spawnCodex(args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, {
      // stdin closed: codex otherwise blocks reading "additional input".
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // macOS: a stray OPENSSL_CONF in the parent env makes codex child
        // processes fail with EPERM. Neutralize it for the child only.
        OPENSSL_CONF: '/dev/null',
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate if codex ignores SIGTERM; the harness must not hang a pipeline.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      stderr += `\n${e.message}`;
      resolve({ stdout, stderr, exitCode: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}
