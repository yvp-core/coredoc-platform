import { lstatSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  query,
  type CanUseTool,
  type HookCallback,
  type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import {
  AccessMode,
  TreatmentAdherence,
  type AgentStatus,
  type Arm,
  type ArmFactors,
  type CurrentAgentRunResult,
  type ToolCallSummary,
  type Usage,
} from './types.js';
import { armFactorsFor } from './arms.js';
import { agentWorkspaceFault } from './access-workspace.js';

/**
 * Server key `coredoc-eval`, NOT `coredoc`: ~/.claude.json carries per-project
 * `disabledMcpServers` state keyed by the target repo's path (the user disables
 * their own coredoc servers while dogfooding), and the CLI applies that disable
 * to any same-named server — even under strictMcpConfig and SDK settings
 * isolation (measured: an entire matrix arm ran with the server "disabled").
 * A harness-owned name sidesteps every such collision.
 *
 * agent-codex.ts declares the same literal separately (CODEX_MCP_SERVER_NAME):
 * it imports FROM this module, so importing back would close a cycle.
 */
export const EVAL_MCP_SERVER_NAME = 'coredoc-eval';

const BASE_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const;
const MCP_TOOL_NAMES = [
  'mcp__coredoc-eval__describe_repository',
  'mcp__coredoc-eval__list_entrypoints',
  'mcp__coredoc-eval__search_symbols',
  'mcp__coredoc-eval__list_file_symbols',
  'mcp__coredoc-eval__explain',
  'mcp__coredoc-eval__find_callers',
  'mcp__coredoc-eval__find_dependents',
  'mcp__coredoc-eval__analyze_change_impact',
  'mcp__coredoc-eval__find_entity_usage',
  'mcp__coredoc-eval__describe_db_schema',
  'mcp__coredoc-eval__get_extraction_coverage',
  'mcp__coredoc-eval__list_service_dependencies',
  'mcp__coredoc-eval__trace_cross_repo_call',
  // Only listed/dispatchable by the MCP server on ladybug/neo4j backends — on
  // sqlite runs the server simply doesn't advertise it, so allowing it here is
  // harmless (the agent never sees it in its tool list).
  'mcp__coredoc-eval__run_cypher_query',
];
const MCP_TOOLS = new Set<string>(MCP_TOOL_NAMES);

/**
 * The tools the coredoc MCP server advertises on every backend and config —
 * the treatment surface a withMcp arm is supposed to receive in full.
 *
 * run_cypher_query is deliberately excluded: only the ladybug/neo4j backends
 * list it, so requiring it would mark every healthy sqlite session unavailable.
 */
export const REQUIRED_MCP_TOOL_NAMES = MCP_TOOL_NAMES.filter(
  (name) => name !== 'mcp__coredoc-eval__run_cypher_query',
);

const MCP_TOOL_PREFIX = `mcp__${EVAL_MCP_SERVER_NAME}__`;
/**
 * The same required toolset expressed as BARE MCP tool names — the form a
 * `tools/list` response uses. Exported so the codex runner's out-of-band probe
 * (agent-codex.ts) checks the identical set the Claude in-band init check does;
 * a partially registered server must classify as infrastructure on both runners.
 */
export const REQUIRED_MCP_TOOL_SUFFIXES = REQUIRED_MCP_TOOL_NAMES.map((name) =>
  name.slice(MCP_TOOL_PREFIX.length),
);

const HISTORYLESS_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Floor below which a terminal assistant turn is treated as housekeeping
 * rather than the answer. Observed acknowledgments were 228 and 328 bytes; the
 * eval prompts all ask for multi-section answers, which run into the
 * thousands. Kept deliberately low so a terse-but-real answer is never
 * replaced by an earlier progress message.
 */
const SUBSTANTIVE_ANSWER_MIN_CHARS = 400;

export function buildAllowedTools(
  baseTools: readonly string[],
  extraTools: readonly string[],
  includeMcp: boolean,
): string[] {
  const tools = [...baseTools, ...extraTools];
  if (includeMcp) tools.push(...MCP_TOOL_NAMES);
  return tools;
}

/**
 * Whether the required MCP server's tools were reachable for a withMcp run.
 *
 * The Claude counterpart of agent-codex.ts's McpAvailability, but it needs no
 * probe subprocess: the SDK stream opens with a `system`/`init` record carrying
 * the resolved `tools` list and `mcp_servers` statuses, which is the in-band,
 * deterministic signal — and it arrives before the answer turn is billed.
 */
export enum ClaudeMcpAvailability {
  /** No init record seen — a missing MCP call cannot be attributed either way. */
  Unknown = 'unknown',
  /**
   * The server connected and the session advertises the whole required
   * toolset (see REQUIRED_MCP_TOOL_NAMES).
   */
  Available = 'available',
  /**
   * The server is missing, not connected, or advertised only part of the
   * required toolset — the treatment surface was not fully applied.
   */
  Unavailable = 'unavailable',
}

/**
 * Reads one stream message as the MCP availability probe.
 *
 * Anything that is not a system/init record proves nothing (Unknown). An init
 * record IS the probe, so a malformed or incompletely tooled one resolves to
 * Unavailable rather than Unknown: it was the session's own answer about what
 * exists.
 */
export function evaluateInitMcpAvailability(
  initMessage: unknown,
  serverName: string,
): ClaudeMcpAvailability {
  const message =
    typeof initMessage === 'object' && initMessage !== null
      ? (initMessage as Record<string, unknown>)
      : null;
  if (message?.type !== 'system' || message.subtype !== 'init') {
    return ClaudeMcpAvailability.Unknown;
  }
  const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
  const connected = servers.some((value) => {
    const server =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
    return server?.name === serverName && server.status === 'connected';
  });
  if (!connected) return ClaudeMcpAvailability.Unavailable;
  const tools = Array.isArray(message.tools) ? message.tools : [];
  const advertised = new Set(tools.filter((name): name is string => typeof name === 'string'));
  const advertisesRequiredToolset = REQUIRED_MCP_TOOL_SUFFIXES.every((suffix) =>
    advertised.has(`mcp__${serverName}__${suffix}`),
  );
  return advertisesRequiredToolset
    ? ClaudeMcpAvailability.Available
    : ClaudeMcpAvailability.Unavailable;
}

/**
 * Treatment-dose classification for a Claude run; mirrors the codex contract
 * documented on {@link TreatmentAdherence}.
 *
 * Noncompliance is only ever claimed with positive probe evidence: without an
 * init record (Unknown) a zero-MCP-call run could equally be a server that
 * never registered, and guessing would corrupt the adherence measure.
 */
export function classifyClaudeAdherence(opts: {
  probeApplicable: boolean;
  availability: ClaudeMcpAvailability;
  agentCompleted: boolean;
  madeRequiredMcpCall: boolean;
}): TreatmentAdherence {
  if (!opts.probeApplicable || !opts.agentCompleted) return TreatmentAdherence.NotApplicable;
  if (opts.madeRequiredMcpCall) return TreatmentAdherence.Compliant;
  return opts.availability === ClaudeMcpAvailability.Available
    ? TreatmentAdherence.Noncompliant
    : TreatmentAdherence.NotApplicable;
}

function mcpUnavailableError(arm: Arm): string {
  return `required MCP server ${EVAL_MCP_SERVER_NAME} did not advertise its required toolset in the SDK init record: the server never registered or registered incompletely, so the ${arm} treatment was never applied`;
}

export interface RunAgentOpts {
  prompt: string;
  systemPrompt: string;
  model: string;
  cwd: string;
  arm: Arm;
  armFactors?: ArmFactors;
  extraTools: readonly string[];
  /**
   * Overrides the default `['Read','Grep','Glob','Bash']` base toolset. The
   * planning eval passes a read-only `['Read','Grep','Glob']` so an arm can
   * never mutate the real workspace checkout (no Bash/Edit/Write).
   */
  baseTools?: readonly string[];
  /** Defaults to worktree access for existing harness callers. */
  accessMode?: AccessMode;
  /**
   * Absolute paths of the cell's pinned sibling checkouts. Read access to them
   * is part of the declared surface in worktree mode (fleet-on-disk cells read
   * siblings by absolute path); ignored in every other access mode.
   */
  additionalReadRoots?: readonly string[];
  mcpServerCommand?: string;
  mcpServerEnv?: Record<string, string>;
  /** Local SDK plugins used by the planning-arm experiment. */
  pluginPaths?: readonly string[];
  /** Plugin-provided skills preloaded through an SDK main-agent definition. */
  skills?: readonly string[];
  /** Request validated SDK output; legacy prose callers keep their current behavior. */
  outputSchema?: Record<string, unknown>;
  maxTurns: number;
  maxBudgetUsd?: number;
  timeoutMs: number;
  transcriptPath: string;
  onPermissionAudit?: (entry: HistorylessPermissionAuditEntry) => void;
}

export interface PermissionAuditEntry {
  phase: 'pre-tool-use' | 'can-use-tool';
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
  behavior: 'allow' | 'deny';
}

/** Historical name kept for the permission-canary call site. */
export type HistorylessPermissionAuditEntry = PermissionAuditEntry;

/**
 * A filesystem confinement envelope for one access mode: which tools the agent
 * may call at all, and which root every path argument must stay under.
 *
 * Two call sites share it — the historyless snapshot (strict: no Bash, no
 * symlinks, no non-existent paths) and the worktree (checkouts legitimately
 * contain symlinks and Bash, so those are permitted but still root-checked).
 */
export interface ConfinementPolicy {
  /** Absolute directory every path argument must resolve inside. */
  root: string;
  /**
   * Further absolute directories a path argument may resolve inside. Used for
   * the cell's pinned sibling checkouts, which preflight has verified are at
   * their pinned SHA and clean — they are part of the declared read surface,
   * unlike the user's live unpinned checkout of the target repo.
   */
  additionalRoots: readonly string[];
  /** Whether the arm's coredoc-eval MCP tools are part of the treatment. */
  includeMcp: boolean;
  /** Tool names the agent may call at all; anything else is denied. */
  allowedTools: readonly string[];
  /** Permit a symlink whose realpath still resolves inside the root. */
  allowInternalSymlinks: boolean;
  /** Permit a path that does not exist yet (the tool reports ENOENT itself). */
  allowMissingPaths: boolean;
  /** Names the envelope in deny messages. */
  label: string;
}

const PATH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);

/**
 * Absolute prefixes a Bash command may reference even though they sit outside
 * the root: system binaries and null/std devices, none of which can hold a
 * checkout of the repository under analysis. Without this, ordinary commands
 * (`grep -r x . 2>/dev/null`, `/usr/bin/env`) would be denied and the control
 * arm would be crippled for a reason unrelated to the treatment.
 */
const BASH_SYSTEM_PREFIXES = [
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/bin/',
  '/sbin/',
  '/usr/',
  '/opt/homebrew/',
  '/opt/local/',
];

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  );
}

function isWithinAny(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isWithin(root, candidate));
}

/**
 * Every accepted root: each declared root both as configured and with symlinks
 * resolved, because a root may itself sit behind a symlink (macOS /tmp) while a
 * command names it by its unresolved path. `roots[0]` is the resolved cwd, which
 * is what relative path arguments resolve against.
 */
function policyRoots(policy: ConfinementPolicy): string[] {
  const declared = [resolve(policy.root), ...policy.additionalRoots.map((root) => resolve(root))];
  const resolved = declared.map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
  return [...new Set([...resolved, ...declared])];
}

function safePath(policy: ConfinementPolicy, roots: readonly string[], value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const candidate = resolve(roots[0]!, value);
  try {
    if (lstatSync(candidate).isSymbolicLink() && !policy.allowInternalSymlinks) return false;
    return isWithinAny(roots, realpathSync(candidate));
  } catch {
    // A path that does not exist can only be judged lexically.
    return policy.allowMissingPaths ? isWithinAny(roots, candidate) : false;
  }
}

/** Resolve a new write through its nearest existing parent, including directory symlinks. */
function safeWritePath(policy: ConfinementPolicy, value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const roots = policyRoots({ ...policy, additionalRoots: [] });
  const candidate = resolve(roots[0]!, value);
  let ancestor = candidate;
  for (;;) {
    try {
      const entry = lstatSync(ancestor);
      if (entry.isSymbolicLink() && !policy.allowInternalSymlinks) return false;
      // realpath failure (including a dangling symlink) must not fall back to lexical acceptance.
      const resolved = realpathSync(ancestor);
      return isWithinAny(roots, resolve(resolved, relative(ancestor, candidate)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !policy.allowMissingPaths) return false;
      // A dangling symlink itself exists: never walk past it as though it were a missing directory.
      try {
        lstatSync(ancestor);
        return false;
      } catch {}
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  }
}

function safePattern(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value) || value.startsWith('~')) {
    return false;
  }
  return !value.split(/[\\/]/).includes('..');
}

/**
 * Best-effort confinement of a Bash command to the envelope root.
 *
 * Bash cannot be confined the way a typed path argument can: the harness sees a
 * shell string, not the syscalls it will make. This rejects the shapes that
 * caused the observed breach — an absolute path outside the root (2026-08-24
 * acme-calculations: a worktree agent read the user's live unpinned checkout) and
 * `..`/`~` traversal out of the cwd.
 *
 * RESIDUAL RISK (accepted here, detected after the fact): command substitution,
 * variable expansion, base64/quoted paths, `cd` into a symlinked directory, and
 * any escape a child process performs on its own all bypass this scan. It is a
 * fast reject, not a proof; confinement-audit.ts re-scans the completed
 * transcript and records the breaches this pass could not stop.
 */
function safeBashCommand(roots: readonly string[], value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return offendingBashToken(roots, value) === null;
}

/**
 * The first token of a shell command that names a location outside every
 * declared root, or null when the command names none.
 *
 * Shared with the post-hoc transcript audit so the live fast-reject and the
 * after-the-fact breach detector judge a command by exactly the same rule.
 */
export function offendingBashToken(roots: readonly string[], command: string): string | null {
  for (const token of command.split(/[\s;|&()<>'"`]+/)) {
    if (token === '') continue;
    if (token.startsWith('~')) return token;
    if (token.startsWith('/')) {
      if (BASH_SYSTEM_PREFIXES.some((prefix) => token.startsWith(prefix))) continue;
      if (!isWithinAny(roots, resolve(token))) return token;
      continue;
    }
    if (token.split(/[\\/]/).includes('..')) return token;
  }
  return null;
}

/**
 * The path argument of a typed tool call when it lands outside every declared
 * root, or null when it stays inside (or names a system prefix). Purely
 * lexical: the post-hoc audit runs after the workspace may already be reset.
 */
export function offendingToolPath(roots: readonly string[], value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (BASH_SYSTEM_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  const candidate = resolve(roots[0] ?? '/', value);
  return isWithinAny(roots, candidate) ? null : value;
}

export function decideConfinedToolUse(
  policy: ConfinementPolicy,
  toolName: string,
  input: Record<string, unknown>,
): 'allow' | 'deny' {
  // ToolSearch only fetches tool *schemas* (deferred-tool loading on newer CLI
  // builds); it touches no filesystem path and no graph data. Denying it bricks
  // the whole session before its first Read — observed live 2026-08-28: every
  // worktree agent turn died on the envelope before loading any tool.
  if (toolName === 'ToolSearch') return 'allow';
  const roots = policyRoots(policy);
  const root = roots[0]!;
  if (PATH_TOOLS.has(toolName)) {
    if (!policy.allowedTools.includes(toolName)) return 'deny';
    // Implementation evals may opt into writes, but sibling checkouts remain read-only.
    if (toolName === 'Edit' || toolName === 'Write') {
      return safeWritePath(policy, input.file_path) ? 'allow' : 'deny';
    }
    if (toolName === 'Read') {
      return safePath(policy, roots, input.file_path) ? 'allow' : 'deny';
    }
    if (toolName === 'Grep') {
      return safePath(policy, roots, input.path ?? root) && safePattern(input.glob)
        ? 'allow'
        : 'deny';
    }
    if (toolName === 'Glob') {
      return safePath(policy, roots, input.path ?? root) && safePattern(input.pattern)
        ? 'allow'
        : 'deny';
    }
    return safeBashCommand(roots, input.command) ? 'allow' : 'deny';
  }
  if (MCP_TOOLS.has(toolName)) return policy.includeMcp ? 'allow' : 'deny';
  // Non-filesystem extras (e.g. TodoWrite) are allowed only if the arm asked
  // for them; every unlisted tool, including foreign MCP servers, is denied.
  return policy.allowedTools.includes(toolName) ? 'allow' : 'deny';
}

export function historylessConfinementPolicy(
  snapshotRoot: string,
  includeMcp: boolean,
): ConfinementPolicy {
  return {
    root: snapshotRoot,
    // The snapshot is the whole declared surface; nothing else is readable.
    additionalRoots: [],
    includeMcp,
    allowedTools: [...HISTORYLESS_TOOLS],
    allowInternalSymlinks: false,
    allowMissingPaths: false,
    label: 'historyless snapshot',
  };
}

export function worktreeConfinementPolicy(
  worktreeRoot: string,
  includeMcp: boolean,
  allowedTools: readonly string[],
  additionalRoots: readonly string[] = [],
): ConfinementPolicy {
  return {
    root: worktreeRoot,
    // The cell's pinned sibling checkouts. Preflight asserts each one is at its
    // pinned SHA and clean, which is what makes them part of the declared
    // surface — the user's live unpinned checkout of the TARGET repo is not.
    additionalRoots: [...additionalRoots],
    includeMcp,
    allowedTools: [...allowedTools],
    // A real checkout legitimately contains symlinks and paths the agent guesses
    // before they exist; only the resolved location has to stay inside the pinned
    // worktree.
    allowInternalSymlinks: true,
    allowMissingPaths: true,
    label: 'worktree',
  };
}

function confinedToolPermission(
  policy: ConfinementPolicy,
  onAudit?: (entry: PermissionAuditEntry) => void,
): CanUseTool {
  return async (toolName, input, options) => {
    const behavior = decideConfinedToolUse(policy, toolName, input);
    onAudit?.({
      phase: 'can-use-tool',
      toolName,
      input,
      toolUseId: options?.toolUseID ?? null,
      behavior,
    });
    return behavior === 'allow'
      ? { behavior: 'allow' as const, updatedInput: input }
      : {
          behavior: 'deny' as const,
          message: `Tool ${toolName} is outside the ${policy.label} permission envelope.`,
        };
  };
}

function confinedPreToolUseHook(
  policy: ConfinementPolicy,
  onAudit?: (entry: PermissionAuditEntry) => void,
): HookCallback {
  return async (input, toolUseId) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const preTool = input as PreToolUseHookInput;
    const toolInput =
      preTool.tool_input && typeof preTool.tool_input === 'object'
        ? (preTool.tool_input as Record<string, unknown>)
        : {};
    const behavior = decideConfinedToolUse(policy, preTool.tool_name, toolInput);
    onAudit?.({
      phase: 'pre-tool-use',
      toolName: preTool.tool_name,
      input: toolInput,
      toolUseId: toolUseId ?? preTool.tool_use_id ?? null,
      behavior,
    });
    if (behavior === 'allow') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason:
          `Tool ${preTool.tool_name} is outside the ${policy.label} permission envelope.`,
      },
    };
  };
}

/**
 * Terminal result for a run that was never dispatched because its workspace was
 * unusable. Deliberately provider-shaped rather than a throw: one broken cell
 * must not abort a paid matrix, and it must not be gradeable either.
 */
export function workspaceFaultResult(opts: {
  fault: string;
  transcriptPath: string;
  model: string;
}): CurrentAgentRunResult {
  mkdirSync(dirname(opts.transcriptPath), { recursive: true });
  writeFileSync(opts.transcriptPath, '[]');
  return {
    agentStatus: 'infrastructure_error',
    treatmentAdherence: TreatmentAdherence.NotApplicable,
    responseText: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    latencyMs: 0,
    toolCalls: [],
    transcriptPath: opts.transcriptPath,
    error: `Agent workspace precondition failed before dispatch: ${opts.fault}`,
    model: opts.model,
  };
}

export async function runAgent(opts: RunAgentOpts): Promise<CurrentAgentRunResult> {
  // Before anything is spawned or billed: the cwd must hold the checkout this
  // arm is supposed to read (see agentWorkspaceFault).
  const fault = agentWorkspaceFault(opts.cwd, opts.accessMode);
  if (fault) {
    return workspaceFaultResult({
      fault,
      transcriptPath: opts.transcriptPath,
      model: opts.model,
    });
  }
  const noCheckout = opts.accessMode === AccessMode.NoCheckout;
  const historyless = opts.accessMode === AccessMode.HistorylessSnapshot;
  const hasExtensions = (opts.pluginPaths?.length ?? 0) > 0 || (opts.skills?.length ?? 0) > 0;
  if ((noCheckout || historyless) && hasExtensions) {
    throw new Error('Plugin and skill configuration is forbidden in isolated eval modes.');
  }
  const armFactors = opts.armFactors ?? armFactorsFor(opts.arm);
  const allowedTools = buildAllowedTools(
    noCheckout || historyless ? [] : (opts.baseTools ?? BASE_TOOLS),
    noCheckout || historyless ? [] : opts.extraTools,
    historyless ? false : armFactors.mcp,
  );

  // See EVAL_MCP_SERVER_NAME for why the key is harness-owned.
  const mcpServers =
    armFactors.mcp && opts.mcpServerCommand
      ? {
          [EVAL_MCP_SERVER_NAME]: {
            command: 'node',
            args: [opts.mcpServerCommand],
            env: {
              ...opts.mcpServerEnv,
              COREDOC_MCP_METRICS_DISABLED: '1',
            },
          },
        }
      : undefined;
  // Worktree runs get the analogous envelope, pinned to the worktree root: a
  // 2026-08-24 acme-calculations agent walked out of its pinned worktree and read
  // the user's live checkout, so the answer cited an unevaluated revision. Only
  // an explicit AccessMode.Worktree opts in — the planning and intent harnesses
  // leave accessMode unset and carry their own tool sets (including MCP tools
  // this envelope does not know), so their behavior is unchanged.
  const confinement = historyless
    ? historylessConfinementPolicy(opts.cwd, armFactors.mcp)
    : opts.accessMode === AccessMode.Worktree
      ? worktreeConfinementPolicy(
          opts.cwd,
          armFactors.mcp,
          [...(opts.baseTools ?? BASE_TOOLS), ...opts.extraTools],
          opts.additionalReadRoots ?? [],
        )
      : undefined;
  // The SDK synthesizes this output-only tool from outputFormat; it cannot read/write files.
  if (opts.outputSchema) {
    allowedTools.push('StructuredOutput');
    if (confinement) confinement.allowedTools = [...confinement.allowedTools, 'StructuredOutput'];
  }
  const confinedPermission = confinement
    ? confinedToolPermission(confinement, opts.onPermissionAudit)
    : undefined;
  const confinedHook = confinement
    ? confinedPreToolUseHook(confinement, opts.onPermissionAudit)
    : undefined;

  // Adherence is only measurable where the matrix owns the whole envelope. The
  // planning and intent harnesses call runAgent with accessMode unset and carry
  // their own adherence semantics, so the probe stays off for them.
  const mcpProbeApplicable =
    armFactors.mcp && opts.mcpServerCommand !== undefined && opts.accessMode !== undefined;

  const abortController = new AbortController();
  let timedOut = false;
  let mcpUnavailable = false;
  let mcpAvailability = ClaudeMcpAvailability.Unknown;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, opts.timeoutMs);

  const messages: unknown[] = [];
  let responseText = '';
  // Last assistant turn long enough to plausibly be the answer. See
  // SUBSTANTIVE_ANSWER_MIN_CHARS.
  let lastSubstantiveAssistantText = '';
  const toolCallCounts = new Map<string, number>();
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  let error: string | null = null;
  let agentStatus: AgentStatus = 'infrastructure_error';
  let sawTerminalResult = false;
  const startedAt = Date.now();

  try {
    for await (const message of query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        ...(opts.outputSchema && { outputFormat: { type: 'json_schema' as const, schema: opts.outputSchema } }),
        systemPrompt: opts.systemPrompt,
        allowedTools,
        cwd: opts.cwd,
        maxTurns: opts.maxTurns,
        ...(opts.maxBudgetUsd !== undefined && { maxBudgetUsd: opts.maxBudgetUsd }),
        abortController,
        ...(opts.pluginPaths?.length && {
          plugins: opts.pluginPaths.map((path) => ({ type: 'local' as const, path })),
        }),
        ...(opts.skills?.length && {
          agent: 'coredoc-eval-main',
          agents: {
            'coredoc-eval-main': {
              description: 'Runs the configured Coredoc evaluation arm.',
              prompt: opts.systemPrompt,
              skills: [...opts.skills],
            },
          },
        }),
        ...(noCheckout
          ? { tools: [] }
          : historyless
            ? { tools: [...HISTORYLESS_TOOLS] }
            : opts.baseTools
              ? { tools: [...opts.baseTools, ...opts.extraTools] }
              : {}),
        ...(confinement && {
          canUseTool: confinedPermission,
          hooks: {
            PreToolUse: [{ hooks: [confinedHook!] }],
          },
        }),
        // Session/settings isolation stays historyless-only: worktree mode is the
        // diagnostic mode and deliberately keeps the default SDK session shape.
        ...(historyless && {
          permissionMode: 'default' as const,
          persistSession: false,
          settingSources: [],
        }),
        // A worktree cwd can resolve target-repo MCP settings, while an isolated
        // cwd can inherit account connectors. Strict mode scopes both paths to
        // exactly the harness-supplied servers (including none for the control).
        // Always opt into strict MCP configuration. A missing `mcpServers`
        // field lets account connectors leak into worktree controls even when
        // `allowedTools` names no MCP tool; `{}` is the only honest control.
        mcpServers: mcpServers ?? {},
        strictMcpConfig: true,
      },
    })) {
      messages.push(message);

      if (mcpAvailability === ClaudeMcpAvailability.Unknown) {
        mcpAvailability = evaluateInitMcpAvailability(message, EVAL_MCP_SERVER_NAME);
        if (mcpProbeApplicable && mcpAvailability === ClaudeMcpAvailability.Unavailable) {
          // The init record is the whole treatment declaration: with no coredoc
          // tools in it the withMcp dose is zero for the rest of the session.
          // Abort now so the answer turn is neither billed nor graded.
          mcpUnavailable = true;
          abortController.abort();
        }
      }

      // Result messages carry the SDK's terminal status. SDKResultError signals
      // max-turns / max-budget / execution failures we'd otherwise miss because
      // the iterator completes normally. Authoritative usage also lives here.
      if (message.type === 'result') {
        const r = message as unknown as {
          subtype?: string;
          is_error?: boolean;
          result?: string;
          structured_output?: unknown;
          usage?: Record<string, number>;
          total_cost_usd?: number;
        };
        sawTerminalResult = true;
        if (!r.is_error && r.subtype === 'success') {
          agentStatus = 'completed';
          const terminalText = typeof r.result === 'string' ? r.result : '';
          // `r.result` is the SDK's LAST assistant turn, which is not always
          // the answer: when a backgrounded Bash task finishes after the agent
          // has written its plan, the SDK emits one more turn acknowledging it
          // ("That background `find` is no longer needed…") and that
          // housekeeping sentence became the whole graded response in 2 of 12
          // claude cells on 2026-08-24. Fall back to the last substantive
          // assistant turn only when the terminal text is too short to be an
          // answer at all — a genuinely short terminal answer still wins,
          // because no assistant turn clears the floor in that run.
          if (opts.outputSchema) {
            if (r.structured_output === undefined) {
              agentStatus = 'task_failed';
              error = 'SDK completed without required structured output';
            } else {
              responseText = JSON.stringify(r.structured_output);
              error = null;
            }
          } else {
            responseText =
              terminalText.trim().length >= SUBSTANTIVE_ANSWER_MIN_CHARS || !lastSubstantiveAssistantText
                ? terminalText
                : lastSubstantiveAssistantText;
            error = null;
          }
        } else {
          agentStatus = /max_turns|max_budget|structured_output/i.test(r.subtype ?? '')
            ? 'task_failed'
            : 'infrastructure_error';
          error = `SDK result error: subtype=${r.subtype ?? 'unknown'}${r.result ? ` — ${r.result}` : ''}`;
        }
        if (r.usage) {
          // Prefer the result's authoritative usage totals when present.
          usage.inputTokens = r.usage.input_tokens ?? usage.inputTokens;
          usage.outputTokens = r.usage.output_tokens ?? usage.outputTokens;
          usage.cacheReadTokens = r.usage.cache_read_input_tokens ?? usage.cacheReadTokens;
          usage.cacheCreationTokens =
            r.usage.cache_creation_input_tokens ?? usage.cacheCreationTokens;
        }
        if (typeof r.total_cost_usd === 'number') usage.costUsd = r.total_cost_usd;
      }

      if (message.type === 'assistant' && message.message) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          const textBlocks: string[] = [];
          for (const block of content) {
            if (block.type === 'tool_use' && typeof block.name === 'string') {
              toolCallCounts.set(block.name, (toolCallCounts.get(block.name) ?? 0) + 1);
            }
            if (block.type === 'text' && typeof block.text === 'string') textBlocks.push(block.text);
          }
          const turnText = textBlocks.join('\n').trim();
          if (turnText.length >= SUBSTANTIVE_ANSWER_MIN_CHARS) lastSubstantiveAssistantText = turnText;
        }
        const u = (message.message as unknown as { usage?: Record<string, number> }).usage;
        if (u) {
          usage.inputTokens += u.input_tokens ?? 0;
          usage.outputTokens += u.output_tokens ?? 0;
          usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        }
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // The SDK's own message for our own AbortController firing is the
    // generic "Claude Code process aborted by user" — misleading in the
    // Failures table, which otherwise reads as a user-initiated cancel
    // rather than the harness's own wall-clock cap. Mirrors the codex
    // runner's `codex exec timed out after <n>ms` wording.
    if (mcpUnavailable) {
      agentStatus = 'infrastructure_error';
      error = mcpUnavailableError(opts.arm);
    } else {
      agentStatus = timedOut ? 'task_failed' : 'infrastructure_error';
      error = timedOut ? `harness timeout after ${opts.timeoutMs}ms (SDK reported: ${message})` : message;
    }
  } finally {
    clearTimeout(timer);
  }

  usage.totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

  mkdirSync(dirname(opts.transcriptPath), { recursive: true });
  writeFileSync(opts.transcriptPath, JSON.stringify(messages, null, 2));

  const toolCalls: ToolCallSummary[] = [...toolCallCounts.entries()].map(([name, count]) => ({
    name,
    count,
  }));

  // Aborting mid-stream can also surface as plain iterator completion rather
  // than a throw, so the verdict is forced here regardless of what the stream
  // reported — including over the generic "ended before a terminal result".
  if (mcpUnavailable) {
    agentStatus = 'infrastructure_error';
    error = mcpUnavailableError(opts.arm);
  } else if (!sawTerminalResult && error === null) {
    agentStatus = 'infrastructure_error';
    error = 'Claude SDK stream ended before a terminal result message';
  }

  const madeRequiredMcpCall = [...toolCallCounts].some(
    ([name, count]) => count > 0 && name.startsWith(`mcp__${EVAL_MCP_SERVER_NAME}__`),
  );

  return {
    agentStatus,
    treatmentAdherence: classifyClaudeAdherence({
      probeApplicable: mcpProbeApplicable,
      availability: mcpAvailability,
      agentCompleted: agentStatus === 'completed',
      madeRequiredMcpCall,
    }),
    responseText,
    usage,
    latencyMs: Date.now() - startedAt,
    toolCalls,
    transcriptPath: opts.transcriptPath,
    error,
    // The model we asked the SDK to run as (e.g. --claude-model override).
    // Distinct from the judge's model, which is pinned separately.
    model: opts.model,
  };
}
