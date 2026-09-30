export type CaseId =
  | 'explain-repo'
  | 'explain-function'
  | 'blast-radius'
  | 'entrypoint-deep-dive'
  | 'entity-impact'
  | 'data-flow-trace'
  | 'type-impact'
  | 'route-deep-dive'
  | 'route-api-surface'
  | 'component-decision'
  | 'cross-repo-trace'
  | 'feature-implementation-plan'
  | 'backend-frontend-pair'
  | 'flag-impact-audit'
  | 'transitive-callers-closure'
  | 'service-dependency-map'
  | 'caller-intersection'
  | 'entrypoint-permission-audit'
  | 'deep-chain-side-effects'
  | 'impact-diff';
export type Arm = 'withMcp' | 'mcpOnly' | 'withoutMcp';

export interface ArmFactors {
  mcp: boolean;
  productGuide: boolean;
}

export type RunnableLifecycle = 'primary' | 'smoke' | 'diagnostic';
export type CellLifecycle = RunnableLifecycle | 'quarantine';

export interface CellProvenance {
  kind: 'source-audit' | 'counterfactual' | 'historical-diff';
  snapshotCommit: string;
  artifactBaseCommit?: string;
  sourceCommit?: string;
  evidence: string[];
}

/** Registry key in `primary-registry.ts`; unregistered ids are rejected there. */
export type PrimaryVerifierId = string;

export interface PrimaryAdmission {
  artifact: {
    kind: 'issue' | 'pr' | 'incident' | 'security-audit' | 'deprecation' | 'migration';
    ref: string;
  };
  /** Who would observe the represented failure or decision. */
  observer: string;
  /** Concrete decision or risk the cell is intended to measure. */
  decision: string;
  /** Exact registered verifier; arbitrary primary scorers are never admitted. */
  verifierId: PrimaryVerifierId;
}

export interface StructuredFact {
  repoKey: string;
  gitSha: string;
  file: string;
  qualifiedSymbol?: string;
  relation?: string;
  method?: string;
  path?: string;
  depth?: number;
  effect?: string;
  useKind?: string;
}

export interface StructuredTruth {
  required: StructuredFact[];
  accepted: StructuredFact[];
  forbidden: StructuredFact[];
}

export interface RepoRevisionPin {
  gitSha: string;
  path?: string;
}

export interface RunnableCell {
  lifecycle: RunnableLifecycle;
  provenance: CellProvenance;
  params: Record<string, unknown>;
  /** Mandatory only for headline-admitted primary cells. */
  admission?: PrimaryAdmission;
  /** Mandatory only for primary; optional during diagnostic/smoke migration. */
  truth?: StructuredTruth;
  repoRevisions?: Record<string, RepoRevisionPin>;
  /**
   * Access mode this cell must run under. A cell whose truth is held out of a
   * mode (e.g. a historical-diff cell whose artifact is reachable from .git in
   * worktree mode) declares the mode here; selecting it under any other mode is
   * refused at preflight — loudly, never silently downgraded.
   */
  requiresAccessMode?: AccessMode;
}

export interface QuarantineCell {
  lifecycle: 'quarantine';
  reasonCode: string;
  reason: string;
}

export type EvalCell = RunnableCell | QuarantineCell;

/** Repository access available to the evaluated agent. */
export enum AccessMode {
  Worktree = 'worktree',
  NoCheckout = 'no-checkout',
  HistorylessSnapshot = 'historyless-snapshot',
}

/**
 * How the agent's filesystem access was actually confined for one run. Recorded
 * per run because the guarantee differs by provider and access mode, and a
 * report that does not say which envelope applied cannot be audited.
 */
export enum ConfinementMode {
  /** Claude: snapshot-root envelope, no Bash, no symlinks. */
  HistorylessEnvelope = 'historyless-envelope',
  /** Claude: worktree + pinned sibling roots, Bash best-effort + post-hoc audit. */
  WorktreeEnvelope = 'worktree-envelope',
  /** Codex: named read-only permissions profile scoped to the declared roots. */
  CodexRestrictedProfile = 'codex-restricted-profile',
  /** Codex: `--sandbox read-only`, which bounds writes but not reads. */
  CodexReadOnlySandbox = 'codex-read-only-sandbox',
  /** No filesystem envelope applied — the run has no checkout to confine. */
  None = 'none',
}

/** One filesystem access that left the declared roots and was not refused. */
export interface ConfinementBreach {
  toolName: string;
  /** The path argument or shell token that landed outside every declared root. */
  path: string;
  toolUseId: string | null;
}

export interface RunConfinement {
  mode: ConfinementMode;
  declaredRoots: string[];
  breaches: ConfinementBreach[];
}

/** Graph backend the harness points the MCP server + in-process verifier at. */
export enum GraphBackend {
  Ladybug = 'ladybug',
  Sqlite = 'sqlite',
}

/**
 * `--backend=ladybug|sqlite` (env fallback COREDOC_EVAL_BACKEND). Default
 * `ladybug` — the product default backend since the file_snapshot/Ladybug
 * migration. `run_cypher_query` is only listed on ladybug/neo4j, so sqlite
 * runs simply never see that tool (harmless, not an error).
 */
export function parseBackend(
  flag: string | undefined,
  envValue: string | undefined,
): GraphBackend {
  const raw = flag ?? envValue ?? GraphBackend.Ladybug;
  const known = Object.values(GraphBackend) as string[];
  if (!known.includes(raw)) {
    throw new Error(`Unknown --backend "${raw}". Expected one of: ${known.join(', ')}.`);
  }
  return raw as GraphBackend;
}

/** Agent harness driving both arms of an invocation. Chosen with `--provider`. */
export enum AgentProvider {
  Claude = 'claude',
  Codex = 'codex',
}

export enum JudgeMode {
  LegacyUngrounded = 'legacy-ungrounded',
  OracleBatch = 'oracle-batch',
}

/**
 * `--provider=claude|codex` (env fallback COREDOC_EVAL_PROVIDER). Lives next to
 * the enum because run.ts self-executes on import and can't be unit-tested.
 * The provider applies to BOTH arms — mixing them within one matrix would make
 * the with/without-MCP delta meaningless.
 */
export function parseProvider(
  flag: string | undefined,
  envValue: string | undefined,
): AgentProvider {
  const raw = flag ?? envValue ?? AgentProvider.Claude;
  const known = Object.values(AgentProvider) as string[];
  if (!known.includes(raw)) {
    throw new Error(`Unknown --provider "${raw}". Expected one of: ${known.join(', ')}.`);
  }
  return raw as AgentProvider;
}

export interface Target {
  name: string;
  path: string;
  /** Legacy display metadata only. Runtime checkout is always pinned by gitSha. */
  baseBranch?: string;
  repoKey: string;
  /** Required by the schema-v2 loader for every runnable target; optional here for legacy case fixtures. */
  gitSha?: string;
  cases: {
    explainRepo: Record<string, never>;
    explainFunction: {
      symbol: string;
      filePath: string;
      /**
       * Hand-curated callers — when present, the verifier uses this list as the
       * sole truth set instead of querying the graph. Each entry is either a
       * bare function name or `Class.method`. Lets a target's eval be scored
       * against source-grep truth, independent of what the parser captured.
       */
      expectedCallers?: string[];
    };
    blastRadius: { change: string; expectedTouchedFiles: string[] };
    entrypointDeepDive: {
      method?: string;
      path: string;
      /** Hand-curated reachable function names (override graph BFS). */
      expectedReachableFunctions?: string[];
      /** Hand-curated reachable file paths (override graph BFS). */
      expectedReachableFiles?: string[];
    };
    entityImpact: {
      entity: string;
      field?: string;
      /** Hand-curated consumer functions (override `getEntityConsumers`). */
      expectedConsumers?: string[];
    };
    dataFlowTrace: {
      method?: string;
      path: string;
      field: string;
      /**
       * Hand-curated terminal sinks (entity names + external service names).
       * Overrides graph-derived `OPERATES_ON` + `external_call` union.
       */
      expectedSinks?: string[];
    };
    typeImpact: {
      type: string;
      kind: 'interface' | 'type_alias' | 'enum' | 'class';
      /**
       * Where the type is defined. Disambiguates same-named types across
       * languages in polyglot repos (a type can exist both as a TS type
       * alias and as a Python Pydantic model — without filePath the
       * agent picks one arbitrarily and the truth doesn't match).
       */
      filePath?: string;
      /** Hand-curated consumers (override `getTypeUsages` + extensions/impls). */
      expectedConsumers?: string[];
    };
    routeDeepDive: {
      path: string;
      component: string;
      /** Hand-curated reachable function/component names. */
      expectedReachableFunctions?: string[];
      /** Hand-curated file paths for the component subtree. */
      expectedFiles?: string[];
    };
    routeApiSurface: {
      path: string;
      component: string;
      /** Hand-curated outbound HTTP endpoints — overrides graph `external_call` walk. */
      expectedEndpoints?: { method: string; path: string }[];
      /** Hand-curated files that host the call sites. */
      expectedFiles?: string[];
    };
    componentDecision: { feature: string; expectedComponents: string[] };
    crossRepoTrace: {
      method: string;
      path: string;
      expectedRepos: string[];
      expectedTouchedFiles?: string[];
    };
    /**
     * Complex case: "Here's a feature to add. Plan the implementation: list
     * the type defs, data hooks, API routes, UI components, and tests you'd
     * touch." Tests holistic codebase understanding — knowing the *conventions*
     * across layers, not just where one thing lives.
     */
    featureImplementationPlan: {
      feature: string;
      expectedFiles: string[];
      planSections?: string[];
      scopeHint?: string;
    };
    /**
     * Complex case: "Given backend endpoint X, trace to UI." Tests cross-layer
     * traversal (external_call → data hook → page). MCP can walk
     * `find_dependents` from the hook node; a non-MCP agent has to grep the
     * literal URL string, find the hook file, then grep the hook name.
     */
    backendFrontendPair: {
      endpoint: { method: string; path: string };
      expectedFiles: string[];
    };
    /**
     * Complex case: "This hook is a runtime gate. List every call site and
     * what each gates." Tests call-graph traversal at scale (hook → callers)
     * combined with conditional-logic reading.
     */
    flagImpactAudit: {
      hook: string;
      hookFile: string;
      expectedCallSites: string[];
    };
    /**
     * Complex case: "List every function that transitively calls X up to
     * depth 3." Tests recursive call-graph traversal. MCP wins because
     * find_callers returns direct callers in one query; doing this with
     * grep requires exponential recursive lookups.
     */
    transitiveCallersClosure: {
      symbol: string;
      filePath: string;
      expectedClosure: string[];
    };
    /**
     * Complex case: "Enumerate every external service this codebase calls."
     * MCP wins because list_service_dependencies aggregates this directly;
     * grep must classify URLs and SDK init patterns one by one.
     */
    serviceDependencyMap: {
      expectedServices: string[];
    };
    /**
     * Complex case: "Find components that use BOTH hook A AND hook B."
     * MCP wins via two find_callers + intersection; grep must intersect
     * file lists then identify enclosing functions per file.
     */
    callerIntersection: {
      hookA: string;
      hookB: string;
      expectedComponents: string[];
    };
    /**
     * Complex case: "Of HTTP API entrypoints, which are authenticated?"
     * MCP wins via list_entrypoints + per-entrypoint metadata; grep must
     * enumerate file globs then read each.
     */
    entrypointPermissionAudit: {
      /**
       * Per-target hint describing the repo's auth pattern. The case prompt
       * embeds this verbatim so the agent doesn't have to guess. Previously
       * the prompt hardcoded one target's API route directory, and a run
       * on a different target said it was looking at the wrong repo and
       * audited it anyway.
       */
      authPatternHint: string;
      expectedAuthenticated: string[];
      expectedUnauthenticated: string[];
    };
    /**
     * Complex case: "Trace the full effect chain of entrypoint/function X
     * (6+ hops, ending in side effects)." MCP wins because function
     * summaries are generated in topological order — explain (detailLevel:
     * full) on a deep caller returns bottom-up aggregated knowledge in one call.
     * Without MCP the agent must Read each of 6+ files.
     */
    deepChainSideEffects: {
      kind: 'entrypoint' | 'function';
      method?: string;
      path?: string;
      symbol?: string;
      filePath?: string;
      expectedChain: { function: string; filePath: string; depth: number; sideEffect: string }[];
    };
    /**
     * Complex case: "This diff is about to land — what's the blast radius?"
     * The CI-gate / machine-consumer slice: impact is asked for across the
     * whole workspace, not just the repo the diff edits. MCP wins via
     * find_callers / find_dependents / analyze_change_impact /
     * trace_cross_repo_call; without it the agent must grep the diff's
     * identifiers outward, repo by repo.
     */
    impactDiff: {
      /** Unified diff (real hunk(s), trimmed to what matters — presented verbatim in the prompt). */
      diff: string;
      /** One-line human summary of the change ("renames X", "changes the return shape of Y"). */
      changeSummary: string;
      /** Files (repo-prefixed where cross-repo) that a reviewer must be pointed at. */
      expectedImpactedFiles: string[];
      /** Optional surfaces that must be NAMED (entrypoint paths, route paths, entity names). */
      expectedImpactedSurfaces?: string[];
    };
  };
}

export interface VerifierScore {
  score: number;
  details: Record<string, number | string | string[]>;
}

export interface JudgeDimension {
  name: string;
  value: number;
}

export interface JudgeScore {
  score: number | null;
  /** Required on newly produced scores; absent only in historical JSONL. */
  judgeStatus?: JudgeStatus;
  dimensions: JudgeDimension[];
  raw: string;
  usage: Usage;
  /** Present only for the prebuilt-oracle batch grader. */
  factualVerdict?: 'pass' | 'minor_error' | 'major_error';
  /** Shared batch identity; several per-run scores may come from one model call. */
  batchId?: string;
}

export interface CurrentJudgeScore extends JudgeScore {
  score: number;
  judgeStatus: 'completed';
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ToolCallSummary {
  name: string;
  count: number;
}

export type AgentStatus = 'completed' | 'task_failed' | 'infrastructure_error';
export type JudgeStatus = 'completed' | 'not_run' | 'missing';

/**
 * Whether a run actually received the treatment its arm prescribes — reported
 * separately from answer quality.
 *
 * A withMcp run that completed with a real answer but never called an MCP tool
 * is a *dose* failure, not a *quality* failure: scoring it ITT 0 destroyed the
 * quality signal of an otherwise gradable answer. Noncompliant runs are graded
 * normally, excluded from the headline estimand (like infrastructure_error),
 * and surfaced in a labelled descriptive row instead.
 */
export enum TreatmentAdherence {
  /**
   * Adherence carries no meaning for this run: the arm requires no MCP, the
   * run never reached a gradable answer, the treatment was never applied at
   * all (server unavailable → infrastructure_error), or the provider exposes
   * no availability signal to separate agent choice from infrastructure.
   */
  NotApplicable = 'not_applicable',
  /** The run made at least one completed call to the required MCP server. */
  Compliant = 'compliant',
  /** Tools were reachable, the agent answered, and it called none of them. */
  Noncompliant = 'noncompliant',
}

export interface AgentRunResult {
  /** Required on newly produced records; absent only on historical fixtures/results. */
  agentStatus?: AgentStatus;
  /** Required on newly produced records; absent on legacy results.jsonl. */
  treatmentAdherence?: TreatmentAdherence;
  responseText: string;
  usage: Usage;
  latencyMs: number;
  toolCalls: ToolCallSummary[];
  transcriptPath: string;
  error: string | null;
  /**
   * Model the provider reported for this run. The Claude runner takes it from
   * the invocation; codex 0.148 does not surface a model on its JSONL stream,
   * so it stays absent there.
   */
  model?: string;
}

export interface CurrentAgentRunResult extends AgentRunResult {
  agentStatus: AgentStatus;
  treatmentAdherence: TreatmentAdherence;
}

export interface RunRecord {
  target: string;
  case: CaseId;
  arm: Arm;
  runIndex: number;
  /** Required for new records; absent only in historical JSONL. */
  lifecycle?: RunnableLifecycle | 'legacy';
  armFactors?: ArmFactors;
  cohortId?: string;
  agentStatus?: AgentStatus;
  judgeStatus?: JudgeStatus;
  /**
   * Treatment-dose outcome; see {@link TreatmentAdherence}. Absent on records
   * written before adherence was separated from quality — the normalization
   * boundary reads those as `not_applicable`.
   */
  treatmentAdherence?: TreatmentAdherence;
  /**
   * Treatment dose: MCP tool calls this run completed (sum of mcp__-prefixed
   * toolCalls counts). Recorded first-class so a near-untreated withMcp cell is
   * visible next to its delta instead of hiding behind binary adherence. Absent
   * on records written before the field existed — the normalization boundary
   * derives it from agent.toolCalls, which is the same arithmetic.
   */
  mcpDose?: number;
  /** Optional so pre-no-checkout results.jsonl remains reportable as worktree data. */
  accessMode?: AccessMode;
  /**
   * Which filesystem envelope this run actually ran under, the roots it
   * declared, and any post-hoc detected escape from them. Absent only on
   * records written before confinement was recorded.
   */
  confinement?: RunConfinement;
  /**
   * Agent harness that produced this run. Always written by run.ts; results.jsonl
   * files predating providers lack it, which report.ts tolerates.
   */
  provider: AgentProvider;
  /**
   * Graph backend the MCP server + verifier read from this run. Always written
   * by run.ts; results.jsonl files predating the flag lack it, which report.ts
   * tolerates the same way it does for `provider`.
   */
  backend: GraphBackend;
  programmatic: VerifierScore | null;
  judge: JudgeScore;
  /** Historical blended score only. New records write null and reports never headline it. */
  final: number | null;
  agent: AgentRunResult;
}

export interface CurrentRunRecord extends RunRecord {
  lifecycle: RunnableLifecycle;
  armFactors: ArmFactors;
  cohortId: string;
  agentStatus: AgentStatus;
  judgeStatus: JudgeStatus;
  treatmentAdherence: TreatmentAdherence;
  mcpDose: number;
  confinement: RunConfinement;
  final: null;
  agent: CurrentAgentRunResult;
}

export interface CaseDef<TParams> {
  id: CaseId;
  buildPrompt(target: Target, params: TParams): string;
  extraTools: readonly string[];
  verify(target: Target, params: TParams, run: AgentRunResult): Promise<VerifierScore>;
  judgeRubric: { dimensions: readonly string[]; description: string };
}
