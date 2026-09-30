import {
  appendFileSync,
  readFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { parseArgs } from 'node:util';
import { allowSourcesInGraph, projectDbPath, projectDbUrl } from '@coredoc/core/utils';
import {
  AccessMode,
  AgentProvider,
  ConfinementMode,
  GraphBackend,
  JudgeMode,
  parseBackend,
  parseProvider,
  type Target,
  type CaseId,
  type Arm,
  type JudgeScore,
  type CurrentRunRecord,
  type RunConfinement,
} from './types.js';
import { runAgent } from './agent.js';
import { auditTranscriptConfinement } from './confinement-audit.js';
import { assertCodexAvailable, runCodexAgent } from './agent-codex.js';
import { emptyUsage } from './judge.js';
import {
  DEFAULT_JUDGE_SPEC,
  JudgeBackend,
  formatJudgeSpec,
  judgeWithSpec,
  parseJudgeSpec,
} from './judge-codex.js';
import {
  assertAccessModeSupported,
  buildAccessModeMcpEnv,
  createAccessWorkspace,
  planAccessWorkspaceSpecs,
  resolveAccessMode,
  type AccessWorkspace,
} from './access-workspace.js';
import { appendRunRecord, writeReport } from './report.js';
import { mcpDoseOf } from './run-record.js';
import { armFactorsFor, buildArmSystemPrompt, parseArmSelection } from './arms.js';
import {
  loadTargets,
  parseLifecycleSelection,
  selectRunnableCells,
  type LoadedTarget,
  type SelectedCell,
} from './target-loader.js';
import { assertCellTruth, preflightCell, type CellPreflight } from './preflight.js';
import {
  createRunManifest,
  fingerprintGraphBackend,
  fingerprintNamedPaths,
  fingerprintPath,
  fingerprintWorkingTree,
  gitHead,
  recordPermissionCanaryEvidence,
  sha256,
  type RunManifest,
} from './provenance.js';
import { analyzeRunDir } from './analyze-mcp.js';
import {
  assertPrimaryDispatchReady,
  assertPrimaryExecutionReady,
} from './primary-readiness.js';
import {
  createPermissionCanaryConfig,
  runPermissionCanary,
  type LivePermissionCanary,
} from './permission-canary.js';
import { assertRegisteredPrimary } from './primary-registry.js';
import { planPrimaryWaveSchedule } from './primary-wave-schedule.js';
import { parsePositiveIntegerFlag } from './cli-integers.js';
import { compareCodeUnits } from './deterministic-order.js';
import {
  assertOracleBatchReady,
  applyOracleBatchExecution,
  applyOracleBatchFailure,
  createOracleBatchJob,
  createOracleBinding,
  executeOracleBatchJob,
  OracleBatchExecutionError,
  oracleBatchArtifact,
  oracleBatchArtifactPath,
  ORACLE_BATCH_BASE_TIMEOUT_MS,
  parseJudgeMode,
  writeOracleBinding,
  type DowngradedVerdict,
  type VerdictCounts,
} from './oracle-batch.js';
import { explainRepoCase } from '../cases/explain-repo.js';
import { explainFunctionCase } from '../cases/explain-function.js';
import { blastRadiusCase } from '../cases/blast-radius.js';
import { entrypointDeepDiveCase } from '../cases/entrypoint-deep-dive.js';
import { entityImpactCase } from '../cases/entity-impact.js';
import { dataFlowTraceCase } from '../cases/data-flow-trace.js';
import { typeImpactCase } from '../cases/type-impact.js';
import { routeDeepDiveCase } from '../cases/route-deep-dive.js';
import { routeApiSurfaceCase } from '../cases/route-api-surface.js';
import { componentDecisionCase } from '../cases/component-decision.js';
import { crossRepoTraceCase } from '../cases/cross-repo-trace.js';
import {
  featureImplementationPlanCase,
  scorePrimaryFeaturePlan,
} from '../cases/feature-implementation-plan.js';
import { backendFrontendPairCase } from '../cases/backend-frontend-pair.js';
import { flagImpactAuditCase } from '../cases/flag-impact-audit.js';
import { transitiveCallersClosureCase } from '../cases/transitive-callers-closure.js';
import { serviceDependencyMapCase } from '../cases/service-dependency-map.js';
import { callerIntersectionCase } from '../cases/caller-intersection.js';
import { entrypointPermissionAuditCase } from '../cases/entrypoint-permission-audit.js';
import { deepChainSideEffectsCase } from '../cases/deep-chain-side-effects.js';
import { impactDiffCase } from '../cases/impact-diff.js';

const AGENT_MODEL = 'claude-sonnet-5';
const SYSTEM_PROMPT =
  'You are a careful, terse senior engineer. Cite file paths in backticks. Do not fabricate.';
// A string `systemPrompt` REPLACES the Claude Code preset (see the SDK's
// systemPrompt docs), and the preset is what normally carries the environment
// preamble naming the working directory. Without this paragraph a worktree-mode
// agent has no evidence that its cwd holds the repository the prompt names, and
// goes hunting: 2026-08-24 acme-calculations read the user's live checkout at
// `/Users/.../acme-calculations` (unpinned revision — a provenance leak), and
// a 2026-08-28 withoutMcp run answered "I could not find the repository" and
// was graded 0. Symmetric across arms because it lives in the
// shared base prompt.
const WORKTREE_SYSTEM_PROMPT =
  `${SYSTEM_PROMPT} Your working directory is a checkout of the repository under analysis, ` +
  'pinned to the exact commit being evaluated. Read it directly with paths relative to the working ' +
  'directory. Do not search the wider filesystem for another copy of the repository: any copy ' +
  'outside the working directory is a different revision and must not be cited.';
const NO_CHECKOUT_SYSTEM_PROMPT =
  `${SYSTEM_PROMPT} No repository checkout is available. Use only explicitly provided tools. ` +
  'Do not attempt filesystem access or claim source inspection without tool evidence.';
const HISTORYLESS_SYSTEM_PROMPT =
  `${SYSTEM_PROMPT} The working directory is an exact tracked snapshot of the requested commit. ` +
  'It intentionally contains no .git metadata, history, future objects, or sibling repositories. ' +
  'Use only Read, Grep, Glob, and explicitly provided coredoc-eval tools; do not attempt writes or external filesystem access.';

/** Base prompt every arm of a run shares; only the access mode varies it. */
export function baseSystemPromptFor(accessMode: AccessMode): string {
  if (accessMode === AccessMode.NoCheckout) return NO_CHECKOUT_SYSTEM_PROMPT;
  if (accessMode === AccessMode.HistorylessSnapshot) return HISTORYLESS_SYSTEM_PROMPT;
  return WORKTREE_SYSTEM_PROMPT;
}

const PER_RUN_TIMEOUT_MS = 10 * 60 * 1000;
// Exploratory cases run more turns (see EXPLORATORY_MAX_TURNS below) and
// correspondingly need more wall-clock before the harness kills them —
// the 2026-08-20 full runs saw 22 codex + ~10 claude runs die with a
// timeout/abort mid cross-repo/route-api-surface cluster at the flat 10min cap.
const EXPLORATORY_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const PER_RUN_MAX_TURNS = 60;
// Exploratory cases that may need more turns on large repos. The 2026-05-14
// eval saw cross-repo and route-api-surface burn 1.9M+ tokens in one rabbit-
// hole; a 2026-05-16 eval on a large polyglot target saw route-api-surface DNF on ALL 6 runs
// at the 30-turn cap because the case requires enumerating 13 reachable
// files + 8 endpoints across featureFlagLogic.ts.
//
// Raised from 30 → 45 to accommodate large-repo enumeration while still
// preventing the rabbit-hole loops the original 30-cap fixed. PER_RUN cap
// also raised so non-exploratory cases on large repos don't hit it.
const EXPLORATORY_CASES = new Set<CaseId>([
  'cross-repo-trace',
  'route-api-surface',
  'component-decision',
  'feature-implementation-plan',
  'flag-impact-audit',
  'transitive-callers-closure',
  'service-dependency-map',
  'caller-intersection',
  'entrypoint-permission-audit',
  'deep-chain-side-effects',
  // Whole-workspace enumeration from a diff: same enumeration cost profile as
  // cross-repo-trace, so it gets the exploratory turn/timeout budget too.
  'impact-diff',
]);
const EXPLORATORY_MAX_TURNS = 45;
/**
 * Synthesis-heavy cases: enumeration is only the FIRST half of the work, and the
 * second half (composing a per-layer implementation plan over everything found)
 * costs turns of its own. In an earlier paid run the feature-implementation-plan MCP arm died
 * with `error_max_turns` in 2 of 3 runs at 4.3-4.8M tokens, while the one run that
 * finished scored best in the matrix — the cap, not the case, was the failure.
 *
 * Deliberately a separate, explicitly-listed tier rather than a bump to
 * EXPLORATORY_MAX_TURNS: raising the shared exploratory cap would change the budget
 * of ten other cases and invalidate their comparability with earlier waves.
 */
const SYNTHESIS_HEAVY_CASES = new Set<CaseId>(['feature-implementation-plan']);
const SYNTHESIS_HEAVY_MAX_TURNS = 80;

/**
 * Resolve a case's turn budget. Tiers are checked most-specific first, so a case in
 * BOTH sets (feature-implementation-plan is also exploratory, for the wall-clock
 * budget) gets the synthesis-heavy cap. Every case in neither set keeps the flat
 * default. Wall-clock (`timeoutMs`) is NOT tiered here — synthesis-heavy cases are
 * exploratory too, so they already carry EXPLORATORY_RUN_TIMEOUT_MS.
 */
export function turnBudgetFor(caseId: CaseId): number {
  if (SYNTHESIS_HEAVY_CASES.has(caseId)) return SYNTHESIS_HEAVY_MAX_TURNS;
  if (EXPLORATORY_CASES.has(caseId)) return EXPLORATORY_MAX_TURNS;
  return PER_RUN_MAX_TURNS;
}

type AnyCase =
  | { id: 'explain-repo'; def: typeof explainRepoCase; paramsKey: 'explainRepo' }
  | { id: 'explain-function'; def: typeof explainFunctionCase; paramsKey: 'explainFunction' }
  | { id: 'blast-radius'; def: typeof blastRadiusCase; paramsKey: 'blastRadius' }
  | { id: 'entrypoint-deep-dive'; def: typeof entrypointDeepDiveCase; paramsKey: 'entrypointDeepDive' }
  | { id: 'entity-impact'; def: typeof entityImpactCase; paramsKey: 'entityImpact' }
  | { id: 'data-flow-trace'; def: typeof dataFlowTraceCase; paramsKey: 'dataFlowTrace' }
  | { id: 'type-impact'; def: typeof typeImpactCase; paramsKey: 'typeImpact' }
  | { id: 'route-deep-dive'; def: typeof routeDeepDiveCase; paramsKey: 'routeDeepDive' }
  | { id: 'route-api-surface'; def: typeof routeApiSurfaceCase; paramsKey: 'routeApiSurface' }
  | { id: 'component-decision'; def: typeof componentDecisionCase; paramsKey: 'componentDecision' }
  | { id: 'cross-repo-trace'; def: typeof crossRepoTraceCase; paramsKey: 'crossRepoTrace' }
  | { id: 'feature-implementation-plan'; def: typeof featureImplementationPlanCase; paramsKey: 'featureImplementationPlan' }
  | { id: 'backend-frontend-pair'; def: typeof backendFrontendPairCase; paramsKey: 'backendFrontendPair' }
  | { id: 'flag-impact-audit'; def: typeof flagImpactAuditCase; paramsKey: 'flagImpactAudit' }
  | { id: 'transitive-callers-closure'; def: typeof transitiveCallersClosureCase; paramsKey: 'transitiveCallersClosure' }
  | { id: 'service-dependency-map'; def: typeof serviceDependencyMapCase; paramsKey: 'serviceDependencyMap' }
  | { id: 'caller-intersection'; def: typeof callerIntersectionCase; paramsKey: 'callerIntersection' }
  | { id: 'entrypoint-permission-audit'; def: typeof entrypointPermissionAuditCase; paramsKey: 'entrypointPermissionAudit' }
  | { id: 'deep-chain-side-effects'; def: typeof deepChainSideEffectsCase; paramsKey: 'deepChainSideEffects' }
  | { id: 'impact-diff'; def: typeof impactDiffCase; paramsKey: 'impactDiff' };

const ALL_CASES: AnyCase[] = [
  { id: 'explain-repo', def: explainRepoCase, paramsKey: 'explainRepo' },
  { id: 'explain-function', def: explainFunctionCase, paramsKey: 'explainFunction' },
  { id: 'blast-radius', def: blastRadiusCase, paramsKey: 'blastRadius' },
  { id: 'entrypoint-deep-dive', def: entrypointDeepDiveCase, paramsKey: 'entrypointDeepDive' },
  { id: 'entity-impact', def: entityImpactCase, paramsKey: 'entityImpact' },
  { id: 'data-flow-trace', def: dataFlowTraceCase, paramsKey: 'dataFlowTrace' },
  { id: 'type-impact', def: typeImpactCase, paramsKey: 'typeImpact' },
  { id: 'route-deep-dive', def: routeDeepDiveCase, paramsKey: 'routeDeepDive' },
  { id: 'route-api-surface', def: routeApiSurfaceCase, paramsKey: 'routeApiSurface' },
  { id: 'component-decision', def: componentDecisionCase, paramsKey: 'componentDecision' },
  { id: 'cross-repo-trace', def: crossRepoTraceCase, paramsKey: 'crossRepoTrace' },
  { id: 'feature-implementation-plan', def: featureImplementationPlanCase, paramsKey: 'featureImplementationPlan' },
  { id: 'backend-frontend-pair', def: backendFrontendPairCase, paramsKey: 'backendFrontendPair' },
  { id: 'flag-impact-audit', def: flagImpactAuditCase, paramsKey: 'flagImpactAudit' },
  { id: 'transitive-callers-closure', def: transitiveCallersClosureCase, paramsKey: 'transitiveCallersClosure' },
  { id: 'service-dependency-map', def: serviceDependencyMapCase, paramsKey: 'serviceDependencyMap' },
  { id: 'caller-intersection', def: callerIntersectionCase, paramsKey: 'callerIntersection' },
  { id: 'entrypoint-permission-audit', def: entrypointPermissionAuditCase, paramsKey: 'entrypointPermissionAudit' },
  { id: 'deep-chain-side-effects', def: deepChainSideEffectsCase, paramsKey: 'deepChainSideEffects' },
  { id: 'impact-diff', def: impactDiffCase, paramsKey: 'impactDiff' },
];

/**
 * Prevents macOS from sleeping mid-run — a full matrix can run well past an
 * hour, and a sleep mid-run stalls the agent process, which then trips
 * PER_RUN_TIMEOUT_MS/EXPLORATORY_RUN_TIMEOUT_MS spuriously (2026-08-20 saw 22
 * codex + ~10 claude runs die this way in consecutive-case clusters).
 * `caffeinate -dims` prevents display, idle, and system sleep for as long as
 * the child lives; killed in the `finally` alongside worktree cleanup.
 * No-op on non-darwin platforms — `caffeinate` doesn't exist there.
 */
function startCaffeinate(): ChildProcess | null {
  if (platform() !== 'darwin') return null;
  try {
    const child = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    child.on('error', () => {
      // Best-effort: a missing/broken caffeinate must not fail the eval run.
      console.warn('[warn] caffeinate unavailable; the Mac may sleep mid-run.');
    });
    return child;
  } catch {
    console.warn('[warn] caffeinate unavailable; the Mac may sleep mid-run.');
    return null;
  }
}

export async function cleanupRunResources(
  workspaces: readonly Pick<AccessWorkspace, 'cleanup'>[],
  sleepGuard: { kill(): unknown } | null,
): Promise<void> {
  try {
    const results = await Promise.allSettled(
      workspaces.map(async (workspace) => workspace.cleanup()),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Multiple access workspaces failed to clean up.');
    }
  } finally {
    sleepGuard?.kill();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      case: { type: 'string' },
      runs: { type: 'string' },
      arm: { type: 'string' },
      concurrency: { type: 'string' },
      project: { type: 'string' },
      provider: { type: 'string' },
      backend: { type: 'string' },
      'codex-model': { type: 'string' },
      'claude-model': { type: 'string' },
      judge: { type: 'string' },
      'judge-mode': { type: 'string' },
      'judge-timeout-ms': { type: 'string' },
      'no-checkout': { type: 'boolean' },
      'historyless-snapshot': { type: 'boolean' },
      lifecycle: { type: 'string' },
      'preflight-only': { type: 'boolean' },
      'run-primary-with-canary': { type: 'boolean' },
    },
  });
  const provider = parseProvider(values.provider, process.env.COREDOC_EVAL_PROVIDER);
  const backend = parseBackend(values.backend, process.env.COREDOC_EVAL_BACKEND);
  const accessMode = resolveAccessMode(
    values['no-checkout'],
    values['historyless-snapshot'],
  );
  assertAccessModeSupported(accessMode, provider);
  // codex exec accepts -m/--model; codex 0.148 doesn't surface the model on
  // its JSONL stream, so recording it is only possible when the caller tells
  // us explicitly. Ignored (never sent to the CLI) for the claude provider.
  const codexModel = values['codex-model'] ?? process.env.COREDOC_EVAL_CODEX_MODEL;
  if (provider === AgentProvider.Codex && !codexModel) {
    throw new Error(
      '--provider=codex requires --codex-model=<exact-id>; codex JSONL does not report its resolved model.',
    );
  }
  // Claude agent model override — e.g. running the claude arm against
  // claude-opus-5-5 instead of the default claude-sonnet-5. Independent of the
  // judge, which is chosen with --judge.
  const claudeModel = values['claude-model'] ?? process.env.COREDOC_EVAL_CLAUDE_MODEL ?? AGENT_MODEL;
  // `--judge <backend>:<model>`, e.g. codex:gpt-6-sol. Absent → the pinned
  // claude judge, so an unflagged run scores exactly as it always has.
  const judgeSpecRaw = values.judge ?? process.env.COREDOC_EVAL_JUDGE;
  const judgeSpec = judgeSpecRaw ? parseJudgeSpec(judgeSpecRaw) : DEFAULT_JUDGE_SPEC;
  const judgeMode = parseJudgeMode(
    values['judge-mode'] ?? process.env.COREDOC_EVAL_JUDGE_MODE,
  );
  // Base component only — the oracle batch adds its own per-response budget on
  // top, because judge output scales with the number of responses in the batch.
  const judgeBaseTimeoutMs = parsePositiveIntegerFlag(
    values['judge-timeout-ms'] ?? process.env.COREDOC_EVAL_JUDGE_TIMEOUT_MS,
    '--judge-timeout-ms',
    ORACLE_BATCH_BASE_TIMEOUT_MS,
  );
  // Fail fast before any worktree or agent work: a missing/unauthenticated
  // codex CLI must not surface halfway through the matrix — whether codex is
  // driving the agent, the judge, or both.
  if (provider === AgentProvider.Codex || judgeSpec.backend === JudgeBackend.Codex) {
    assertCodexAvailable();
  }
  const runsPerCell = parsePositiveIntegerFlag(values.runs, '--runs', 3);
  const lifecycles = parseLifecycleSelection(values.lifecycle);
  // Max parallel (target, arm) pipelines. Each pipeline owns its own
  // worktree, so distinct pipelines have no shared state — only the
  // per-API rate limit caps you. Default = unbounded (run every pipeline
  // concurrently). Set to 1 to recover the old sequential behaviour or
  // to throttle when hitting API limits.
  const concurrency =
    values.concurrency === undefined
      ? Infinity
      : parsePositiveIntegerFlag(values.concurrency, '--concurrency', 1);

  const here = dirname(fileURLToPath(import.meta.url));
  const evalsRoot = resolve(here, '..');
  const repoRoot = resolve(evalsRoot, '..');
  const mcpServerPath = join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');

  // Pin the MCP server's config lookup to the coredoc-parser repo-root config.
  // External target worktrees cannot discover it by walking upward, and the
  // no-checkout cwd intentionally contains nothing. MCP_CONFIG_PATH binds the
  // project graph; no-checkout additionally supplies COREDOC_CURRENT_REPO.
  const mcpConfigPath = join(repoRoot, 'coredoc.config.json');
  const projectId = values.project ?? process.env.COREDOC_EVAL_PROJECT;
  if (!projectId) {
    throw new Error('Choose the graph owner with --project <id> or COREDOC_EVAL_PROJECT.');
  }
  const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as {
    projects: Array<{ id: string; repos: Array<{ name: string; key?: string }> }>;
  };
  const evalProject = config.projects.find((project) => project.id === projectId);
  if (!evalProject) throw new Error(`Project "${projectId}" not found in ${mcpConfigPath}.`);
  const sqliteUrl = projectDbUrl(repoRoot, projectId);
  const ladybugPath = projectDbPath(repoRoot, projectId).replace(/\.db$/, '.lbdb');
  const sqlitePath = sqliteUrl.slice('file:'.length);
  // Graph binding env, shared by (a) the MCP server subprocess (mcpServerEnv
  // below) and (b) the in-process verifier, which reads getConfiguredBackend()
  // off process.env directly via @coredoc/db's backend-factory singleton.
  //
  // COREDOC_SQLITE_URL is set in BOTH backend cases: backend-factory keeps a
  // dedicated ops-only SqliteDriver for MCP metrics / operations even when the
  // graph backend is ladybug (`opsOnlyDriver = new SqliteDriver()`, which
  // resolves its path from COREDOC_SQLITE_URL with no override param) — so a
  // ladybug run still needs it set for those ops paths to work. COREDOC_DB_BACKEND
  // is set explicitly in both cases too, so a `sqlite` run can't accidentally
  // inherit a `ladybug` value leaking in from the invoking shell's env.
  const graphEnv: Record<string, string> = { COREDOC_SQLITE_URL: sqliteUrl };
  if (backend === GraphBackend.Ladybug) {
    if (!existsSync(ladybugPath)) {
      throw new Error(
        `No Ladybug graph database for project "${projectId}" at ${ladybugPath}. ` +
          `Run \`coredoc push --project ${projectId}\` first (or pass --backend=sqlite).`,
      );
    }
    graphEnv.COREDOC_DB_BACKEND = 'ladybug';
    graphEnv.COREDOC_LADYBUG_PATH = ladybugPath;
  } else {
    if (!existsSync(sqlitePath)) {
      throw new Error(
        `No graph database for project "${projectId}". Run \`coredoc push --project ${projectId}\` first.`,
      );
    }
    graphEnv.COREDOC_DB_BACKEND = 'sqlite';
  }
  // Source-in-graph is an explicit opt-in factor: pass it through only when the
  // invoking shell sets it, so the MCP subprocess (includeSource tool param) and
  // the in-process verifier see the same capability. The graph must have been
  // pushed with the same flag, or includeSource returns nodes without source.
  if (allowSourcesInGraph()) {
    graphEnv.ALLOW_SOURCES_IN_GRAPH = '1';
  }
  // Programmatic verifiers open the graph in-process (via getEvalRepository in
  // harness/verifier.ts), bound to the same project id + config dir as the MCP
  // subprocess so the two arms cannot inspect different graphs. They open
  // read-mode (shared lease) rather than the low-level getRepository() singleton
  // (exclusive lease on ladybug) so they never collide with the concurrently
  // running MCP subprocess's read lease.
  for (const [k, v] of Object.entries(graphEnv)) process.env[k] = v;
  process.env.COREDOC_EVAL_CONFIG_DIR = repoRoot;
  process.env.COREDOC_EVAL_PROJECT = projectId;

  const arms = parseArmSelection(values.arm);
  const skillFile = join(repoRoot, 'skills', 'coredoc-mcp', 'SKILL.md');
  const skillGuide = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null;
  const baseSystemPrompt = baseSystemPromptFor(accessMode);
  const systemPromptByArm = new Map(
    arms.map((arm) => [
      arm,
      buildArmSystemPrompt(baseSystemPrompt, armFactorsFor(arm), skillGuide),
    ]),
  );

  const targetsDir = join(evalsRoot, 'targets');
  const reposRoot = process.env.COREDOC_EVAL_REPOS ?? join(targetsDir, '..', '..', '..');
  const targets = loadTargets(targetsDir, reposRoot).filter(
    (t) => !values.target || t.name === values.target,
  );
  if (targets.length === 0) throw new Error('No target manifests matched the requested selector.');
  const projectRepoKeys = new Set(evalProject.repos.flatMap((repo) => [repo.name, repo.key].filter(Boolean)));
  const outsideProject = targets.filter((target) => !projectRepoKeys.has(target.repoKey));
  if (outsideProject.length > 0) {
    throw new Error(
      `Target(s) ${outsideProject.map((target) => target.name).join(', ')} are not in project "${projectId}". ` +
        'Run each project as a separate eval invocation.',
    );
  }
  // --case accepts a single id or a comma-separated list, e.g.
  // --case=route-api-surface,component-decision,cross-repo-trace — useful
  // for resuming after a partial run died mid-matrix.
  const caseFilter = values.case ? new Set(values.case.split(',').map((s) => s.trim())) : null;
  const caseById = new Map(ALL_CASES.map((item) => [item.id, item]));
  if (caseFilter) {
    for (const caseId of caseFilter) {
      if (!caseById.has(caseId as CaseId)) throw new Error(`Unknown --case "${caseId}".`);
    }
  }
  type PlannedCell = { selected: SelectedCell; definition: AnyCase };
  const plannedByTarget = new Map<string, PlannedCell[]>();
  for (const target of targets) {
    const planned = selectRunnableCells(target, lifecycles)
      .filter((selected) => !caseFilter || caseFilter.has(selected.caseId))
      .map((selected) => ({ selected, definition: caseById.get(selected.caseId)! }));
    plannedByTarget.set(target.name, planned);
  }
  if ([...plannedByTarget.values()].every((planned) => planned.length === 0)) {
    throw new Error('No runnable cells matched the lifecycle/case selectors.');
  }
  if (judgeMode === JudgeMode.OracleBatch) {
    assertOracleBatchReady(
      targets.flatMap((target) =>
        (plannedByTarget.get(target.name) ?? []).map(({ selected }) => ({
          target: target.name,
          selected,
        })),
      ),
    );
  }
  const readinessSelections = targets.flatMap((target) =>
    (plannedByTarget.get(target.name) ?? []).map(({ selected }) => ({
      repoKey: target.repoKey,
      targetSha: target.gitSha,
      selected,
    })),
  );
  const hasPrimarySelection = readinessSelections.some(
    ({ selected }) => selected.cell.lifecycle === 'primary',
  );
  if (hasPrimarySelection && evalProject.repos.length !== 1) {
    throw new Error(
      'Registered primary historyless runs require a single-repository graph project boundary.',
    );
  }
  assertPrimaryExecutionReady(
    readinessSelections,
    accessMode,
    values['preflight-only'] === true,
    values['run-primary-with-canary'] === true,
    provider,
  );
  const primaryWaveSchedule =
    hasPrimarySelection && values['preflight-only'] !== true
      ? planPrimaryWaveSchedule(
          arms,
          runsPerCell,
        )
      : null;

  // Provider + backend suffix keeps claude/codex and ladybug/sqlite runs in
  // separate dirs — they are not comparable cell-for-cell and must never be
  // aggregated into one report.
  const accessSuffix =
    accessMode === AccessMode.NoCheckout
      ? '-no-checkout'
      : accessMode === AccessMode.HistorylessSnapshot
        ? '-historyless-snapshot'
        : '';
  const runId =
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${provider}-${backend}` + accessSuffix;
  const runDir = join(evalsRoot, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const jsonl = join(runDir, 'results.jsonl');
  const records: CurrentRunRecord[] = [];
  const oracleJudgeUsage = { calls: 0, totalTokens: 0, costUsd: 0 };
  const startedAt = Date.now();
  const manifestPath = join(runDir, 'run-manifest.json');
  let runManifest: RunManifest | null = null;
  let livePermissionCanary: LivePermissionCanary | null = null;

  // Cleanup only exact workspaces created by this invocation. In no-checkout
  // mode these are harness-owned OS temp dirs; otherwise they are worktrees.
  const createdWorkspaces: AccessWorkspace[] = [];

  // Covers workspace setup through pipeline completion — the long-running
  // stretch a sleeping Mac would otherwise stall mid-agent-run.
  const caffeinate = startCaffeinate();

  try {
    type Pipeline = { target: LoadedTarget; arm: Arm; workspace: AccessWorkspace };
    const pipelineSpecs = planAccessWorkspaceSpecs(
      targets,
      arms,
      values['preflight-only'] === true,
    );

    // Paid runs keep one workspace per target × arm. Preflight needs only one
    // representative exact-SHA workspace per target because no agent runs.
    const pipelines: Pipeline[] = await Promise.all(
      pipelineSpecs.map(async ({ target, arm }) => {
        const workspace = await createAccessWorkspace({
          target,
          arm,
          provider,
          accessMode,
        });
        createdWorkspaces.push(workspace);
        return { target, arm, workspace };
      }),
    );

    // Complete every revision/truth preflight before any agent dispatch. This
    // is deliberately a separate phase: a late mismatch must never leave a
    // half-paid matrix whose arms observed different source/graph snapshots.
    const preflightByCell = new Map<string, CellPreflight>();
    const promptByCell = new Map<string, string>();
    for (const target of targets) {
      const representative = pipelines.find((pipeline) => pipeline.target.name === target.name);
      if (!representative) throw new Error(`No workspace was created for target ${target.name}.`);
      for (const planned of plannedByTarget.get(target.name) ?? []) {
        const { selected, definition } = planned;
        const params = selected.cell.params as never;
        const prompt = definition.def.buildPrompt(target, params);
        const key = `${target.name}|${selected.caseId}`;
        promptByCell.set(key, prompt);
        assertCellTruth({
          selected,
          prompt,
          targetRepoKey: target.repoKey,
          pathExists(repoKey, filePath) {
            const pin = selected.cell.repoRevisions?.[repoKey];
            const repoPath = repoKey === target.repoKey ? target.path : pin?.path;
            const revision = repoKey === target.repoKey ? target.gitSha : pin?.gitSha;
            if (!repoPath || !revision) return false;
            try {
              execFileSync('git', ['-C', repoPath, 'cat-file', '-e', `${revision}:${filePath}`], {
                stdio: 'ignore',
              });
              return true;
            } catch {
              return false;
            }
          },
        });
        preflightByCell.set(
          key,
          await preflightCell({
            target,
            selected,
            verifierSha: representative.workspace.verifierGitSha,
            agentSha: representative.workspace.agentGitSha,
            accessMode,
          }),
        );
      }
    }

    const graphBackendPath = backend === GraphBackend.Ladybug ? ladybugPath : sqlitePath;
    const graphIdentity = await fingerprintGraphBackend(backend, graphBackendPath);
    const cellManifestRows = await Promise.all(
      targets.flatMap((target) =>
        (plannedByTarget.get(target.name) ?? []).map(async ({ selected }) => {
          const key = `${target.name}|${selected.caseId}`;
          const sourcePath = join(evalsRoot, 'cases', `${selected.caseId}.ts`);
          const revisions = preflightByCell.get(key)?.revisions ?? [];
          const promptHash = sha256(promptByCell.get(key) ?? '');
          const oracle = selected.cell.truth
            ? createOracleBinding({
                target: target.name,
                caseId: selected.caseId,
                promptHash,
                targetRepoKey: target.repoKey,
                targetGitSha: target.gitSha,
                siblingRevisions: selected.cell.repoRevisions,
                provenance: selected.cell.provenance,
                truth: selected.cell.truth,
              })
            : null;
          if (oracle) {
            writeOracleBinding(runDir, oracle.binding, oracle.oracleHash);
          }
          return {
            target: target.name,
            case: selected.caseId,
            lifecycle: selected.cell.lifecycle,
            primaryVerifierId: selected.cell.admission?.verifierId ?? null,
            promptHash,
            oracleHash: oracle?.oracleHash ?? null,
            caseHash: await fingerprintPath(sourcePath),
            verifierHash: await fingerprintNamedPaths({
              case: sourcePath,
              citations: join(evalsRoot, 'harness', 'citations.ts'),
              structuredTruth: join(evalsRoot, 'harness', 'structured-truth.ts'),
              verifier: join(evalsRoot, 'harness', 'verifier.ts'),
              ...(selected.cell.lifecycle === 'primary'
                ? { primaryRegistry: join(evalsRoot, 'harness', 'primary-registry.ts') }
                : {}),
            }),
            repoRevisions: Object.fromEntries(
              revisions.slice(1).map((revision) => [
                revision.repoKey,
                {
                  requestedGitSha: revision.requestedSha,
                  graphGitSha: revision.graphSha,
                  localObjectSha: revision.localObjectSha,
                  checkoutHeadSha: revision.checkoutHeadSha,
                  checkoutTrackedClean: revision.checkoutTrackedClean,
                },
              ]),
            ),
          };
        }),
      ),
    );
    const graphRepositories = new Map<
      string,
      { repoKey: string; parsedGitSha: string; parsedAt: string | null; parserVersion: string | null }
    >();
    for (const result of preflightByCell.values()) {
      for (const revision of result.revisions) {
        graphRepositories.set(revision.repoKey, {
          repoKey: revision.repoKey,
          parsedGitSha: revision.graphSha,
          parsedAt: revision.parsedAt,
          parserVersion: revision.parserVersion,
        });
      }
    }
    const skillHash = skillGuide ? sha256(skillGuide) : null;
    const anthropicPackage = join(evalsRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
    const anthropicVersion = existsSync(anthropicPackage)
      ? (JSON.parse(readFileSync(anthropicPackage, 'utf8')) as { version?: string }).version ?? null
      : null;
    const codexVersion =
      provider === AgentProvider.Codex || judgeSpec.backend === JudgeBackend.Codex
        ? execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
        : null;
    const harnessIdentity = {
      head: gitHead(repoRoot),
      dirtyFingerprint: fingerprintWorkingTree(repoRoot),
    };
    const mcpSchemaHash = await fingerprintNamedPaths({
      descriptions: join(repoRoot, 'packages', 'mcp', 'src', 'tool-descriptions.ts'),
      schemas: join(repoRoot, 'packages', 'mcp', 'src', 'tool-schemas.ts'),
      tools: join(repoRoot, 'packages', 'mcp', 'src', 'tools'),
    });
    const mcpBuildHash = await fingerprintPath(join(repoRoot, 'packages', 'mcp', 'dist'));
    const sdkRuntimeHash = await fingerprintNamedPaths({
      sdk: join(evalsRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
      cli: join(evalsRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
    });
    if (accessMode === AccessMode.HistorylessSnapshot && !sdkRuntimeHash) {
      throw new Error('Cannot fingerprint the Claude SDK runtime for the permission canary.');
    }
    const permissionCanaryConfig =
      accessMode === AccessMode.HistorylessSnapshot
        ? createPermissionCanaryConfig({
            harnessHead: harnessIdentity.head,
            harnessDirtyFingerprint: harnessIdentity.dirtyFingerprint,
            mcpSchemaHash,
            mcpBuildHash,
            sdkRuntimeHash: sdkRuntimeHash!,
            model: claudeModel,
          })
        : null;
    runManifest = createRunManifest({
      createdAt: new Date().toISOString(),
      harness: harnessIdentity,
      targets: targets.map((target) => {
        const pipeline = pipelines.find((candidate) => candidate.target.name === target.name)!;
        return {
          manifestPath: target.manifestPath,
          manifestHash: target.manifestHash,
          repoKey: target.repoKey,
          requestedGitSha: target.gitSha,
          actualVerifierGitSha: pipeline.workspace.verifierGitSha,
          actualAgentGitSha: pipeline.workspace.agentGitSha,
        };
      }),
      graph: {
        backend,
        path: graphBackendPath,
        fingerprint: graphIdentity.fingerprint,
        // Whether the MCP server exposed includeSource/source bodies this run.
        // Two otherwise-identical withMcp runs differ materially on this factor.
        sourceInGraph: allowSourcesInGraph(),
        repositories: [...graphRepositories.values()].sort((a, b) =>
          compareCodeUnits(a.repoKey, b.repoKey)),
      },
      cells: cellManifestRows,
      arms: arms.map((arm) => ({
        arm,
        factors: armFactorsFor(arm),
        systemPromptHash: sha256(systemPromptByArm.get(arm)!),
        skillHash: armFactorsFor(arm).productGuide ? skillHash : null,
      })),
      mcp: {
        mcpSchemaHash,
        mcpBuildHash,
      },
      models: {
        provider,
        agentModel: provider === AgentProvider.Codex ? codexModel! : claudeModel,
        agentSdkVersion: provider === AgentProvider.Codex ? codexVersion : anthropicVersion,
        judgeProvider: judgeSpec.backend,
        judgeModel: judgeSpec.model,
        judgeSdkVersion:
          judgeSpec.backend === JudgeBackend.Codex ? codexVersion : anthropicVersion,
        judgeMode,
      },
      permissionCanary: {
        config: permissionCanaryConfig,
        evidence: null,
      },
    });
    writeFileSync(manifestPath, `${JSON.stringify(runManifest, null, 2)}\n`);
    if (values['run-primary-with-canary']) {
      const pipeline = pipelines[0];
      if (!pipeline || !permissionCanaryConfig) {
        throw new Error('Permission canary requires a prepared historyless primary workspace.');
      }
      const canaryRelativePath = join('permission-canary', 'transcript.json');
      const canary = await runPermissionCanary({
        snapshotRoot: pipeline.workspace.agentCwd,
        originalTargetPath: pipeline.target.path,
        harnessManifestPath: pipeline.target.manifestPath,
        harnessTruthPath: join(evalsRoot, 'harness', 'primary-registry.ts'),
        config: permissionCanaryConfig,
        mcpServerCommand: mcpServerPath,
        mcpServerEnv: buildAccessModeMcpEnv(
          {
            MCP_CONFIG_PATH: mcpConfigPath,
            COREDOC_SCOPE: `project:${projectId}`,
            ...graphEnv,
          },
          accessMode,
          pipeline.target.repoKey,
        ),
        transcriptPath: join(runDir, canaryRelativePath),
        transcriptRelativePath: canaryRelativePath,
      });
      recordPermissionCanaryEvidence(runManifest, canary.evidence);
      writeFileSync(manifestPath, `${JSON.stringify(runManifest, null, 2)}\n`);
      await pipeline.workspace.reset();
      livePermissionCanary = canary.liveCapability;
      if (!canary.evidence.passed) {
        throw new Error(
          `Primary permission canary failed closed: ${canary.evidence.failureCodes.join(', ')}.`,
        );
      }
    }
    if (values['preflight-only']) {
      const canaryStatus = values['run-primary-with-canary']
        ? ' and permission canary complete'
        : '';
      console.log(`Preflight complete; no agents or judges dispatched. Manifest: ${manifestPath}`);
      if (canaryStatus) console.log(`Preflight${canaryStatus}; primary and judge were not dispatched.`);
      return;
    }
    if (hasPrimarySelection) {
      assertPrimaryDispatchReady(
        readinessSelections,
        accessMode,
        livePermissionCanary,
        permissionCanaryConfig?.materialFingerprint ?? '',
      );
    }

    // Build one pipeline per (target, arm). Pipelines are independent:
    //   - distinct workspaces → no filesystem races during agent execution
    //   - distinct MCP subprocesses (one per agent invocation)
    //   - records.push and appendFileSync(O_APPEND) are concurrency-safe
    // Cases × runs WITHIN a pipeline still serialize because they share a
    // workspace and worktree reset would race against a parallel run.

    async function runOne(
      pipeline: Pipeline,
      planned: PlannedCell,
      runIndex: number,
    ): Promise<void> {
      const { target, arm, workspace } = pipeline;
      const factors = armFactorsFor(arm);
      const { selected, definition } = planned;
      const params = selected.cell.params as never;
      const caseId = selected.caseId;
      await workspace.reset();
      const artifactDir = join(
        runDir,
        'runs',
        target.name,
        caseId,
        arm,
        `run-${runIndex}`,
      );
      mkdirSync(artifactDir, { recursive: true });
      const transcriptPath = join(artifactDir, 'transcript.json');
      const prompt = promptByCell.get(`${target.name}|${caseId}`)!;
      writeFileSync(join(artifactDir, 'prompt.txt'), prompt);

      // The cell's pinned sibling checkouts: preflight has asserted each is at
      // its pinned SHA and clean, so reading them is part of the declared
      // surface (the fleet-on-disk baseline depends on it).
      const siblingRoots = Object.values(selected.cell.repoRevisions ?? {}).flatMap((pin) =>
        pin.path ? [pin.path] : [],
      );

      const agentOpts = {
        prompt,
        systemPrompt: systemPromptByArm.get(arm)!,
        model: claudeModel,
        cwd: workspace.agentCwd,
        arm,
        armFactors: factors,
        accessMode,
        additionalReadRoots: siblingRoots,
        extraTools: definition.def.extraTools,
        mcpServerCommand: mcpServerPath,
        mcpServerEnv: buildAccessModeMcpEnv(
          {
            MCP_CONFIG_PATH: mcpConfigPath,
            COREDOC_SCOPE: `project:${projectId}`,
            ...graphEnv,
          },
          accessMode,
          target.repoKey,
        ),
        maxTurns: turnBudgetFor(caseId),
        timeoutMs: EXPLORATORY_CASES.has(caseId)
          ? EXPLORATORY_RUN_TIMEOUT_MS
          : PER_RUN_TIMEOUT_MS,
        transcriptPath,
      };
      const runResult =
        provider === AgentProvider.Codex
          ? await runCodexAgent({
              ...agentOpts,
              codexModel: codexModel!,
            })
          : await runAgent(agentOpts);
      writeFileSync(join(artifactDir, 'response.md'), runResult.responseText);
      writeFileSync(join(artifactDir, 'usage.json'), JSON.stringify(runResult.usage, null, 2));

      // What the run was actually confined by, stated per run. Codex carries no
      // breach list: its permissions profile refuses the access rather than
      // letting it through for a detector to find afterwards.
      const worktreeMode = accessMode === AccessMode.Worktree;
      const confinementRoots = [workspace.agentCwd, ...(worktreeMode ? siblingRoots : [])];
      const confinement: RunConfinement =
        provider === AgentProvider.Codex
          ? {
              mode: ConfinementMode.CodexRestrictedProfile,
              declaredRoots: confinementRoots,
              breaches: [],
            }
          : accessMode === AccessMode.HistorylessSnapshot
            ? {
                mode: ConfinementMode.HistorylessEnvelope,
                declaredRoots: confinementRoots,
                breaches: [],
              }
            : worktreeMode
              ? {
                  mode: ConfinementMode.WorktreeEnvelope,
                  declaredRoots: confinementRoots,
                  breaches: auditTranscriptConfinement({
                    transcriptText: existsSync(transcriptPath)
                      ? readFileSync(transcriptPath, 'utf8')
                      : '[]',
                    roots: confinementRoots,
                  }),
                }
              : { mode: ConfinementMode.None, declaredRoots: [], breaches: [] };
      for (const breach of confinement.breaches) {
        console.error(
          `[confinement-breach] ${target.name}/${caseId}/${arm}/run-${runIndex}: ${breach.toolName} reached ${breach.path}`,
        );
      }

      const verifierTarget: Target = { ...target, path: workspace.verifierPath };
      const programmatic =
        runResult.agentStatus === 'completed'
          ? selected.cell.lifecycle === 'primary'
            ? scorePrimaryFeaturePlan(
                assertRegisteredPrimary({
                  repoKey: target.repoKey,
                  targetSha: target.gitSha,
                  selected,
                }).verifier,
                runResult.responseText,
                (path) => {
                  try {
                    execFileSync(
                      'git',
                      ['-C', workspace.verifierPath, 'cat-file', '-e', `${target.gitSha}:${path}`],
                      { stdio: 'ignore' },
                    );
                    return true;
                  } catch {
                    return false;
                  }
                },
              )
            : await definition.def.verify(verifierTarget, params, runResult)
          : null;
      writeFileSync(join(artifactDir, 'verifier.json'), JSON.stringify(programmatic, null, 2));

      let judgeScore: JudgeScore;
      if (runResult.agentStatus !== 'completed') {
        judgeScore = {
          score: null,
          judgeStatus: 'not_run',
          dimensions: [],
          raw: '',
          usage: emptyUsage(),
        };
      } else if (judgeMode === JudgeMode.OracleBatch) {
        judgeScore = {
          score: null,
          judgeStatus: 'not_run',
          dimensions: [],
          raw: 'pending oracle batch judge',
          usage: emptyUsage(),
        };
      } else {
        try {
          judgeScore = await judgeWithSpec({
            spec: judgeSpec,
            judge: {
              prompt,
              responseText: runResult.responseText,
              dimensions: definition.def.judgeRubric.dimensions,
              rubricDescription: definition.def.judgeRubric.description,
            },
            codexLastMessagePath: join(artifactDir, 'codex-judge-last-message.txt'),
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[judge-error] ${target.name}/${caseId}/${arm}: ${message}`);
          judgeScore = {
            score: null,
            judgeStatus: 'missing',
            dimensions: [],
            raw: `judge failed: ${message}`,
            usage: emptyUsage(),
          };
        }
      }
      writeFileSync(join(artifactDir, 'judge.json'), JSON.stringify(judgeScore, null, 2));

      const record: CurrentRunRecord = {
        target: target.name,
        case: caseId,
        arm,
        lifecycle: selected.cell.lifecycle,
        armFactors: factors,
        cohortId: runManifest!.cohortId,
        agentStatus: runResult.agentStatus,
        judgeStatus: judgeScore.judgeStatus ?? 'missing',
        treatmentAdherence: runResult.treatmentAdherence,
        mcpDose: mcpDoseOf(runResult.toolCalls),
        provider,
        backend,
        accessMode,
        confinement,
        runIndex,
        programmatic,
        judge: judgeScore,
        final: null,
        agent: runResult,
      };
      appendRunRecord(jsonl, record);
      records.push(record);

      console.log(
        `[run] ${target.name}/${caseId}/${arm}/run-${runIndex} → agent=${runResult.agentStatus} adherence=${runResult.treatmentAdherence} prog=${programmatic?.score ?? 'missing'} judge=${judgeMode === JudgeMode.OracleBatch && runResult.agentStatus === 'completed' ? 'pending-batch' : (judgeScore.score ?? 'missing')} tokens=${runResult.usage.totalTokens} latency=${(runResult.latencyMs / 1000).toFixed(1)}s`,
      );
    }

    async function runPipeline(pipeline: Pipeline): Promise<void> {
      for (const planned of plannedByTarget.get(pipeline.target.name) ?? []) {
        for (let runIndex = 0; runIndex < runsPerCell; runIndex++) {
          await runOne(pipeline, planned, runIndex);
        }
      }
    }

    if (primaryWaveSchedule) {
      console.log(
        'Running registered primary in serial AB/BA order with effective concurrency=1; starts do not overlap, so no stagger applies.',
      );
      for (const target of targets) {
        for (const planned of plannedByTarget.get(target.name) ?? []) {
          for (const unit of primaryWaveSchedule) {
            const pipeline = pipelines.find(
              (candidate) => candidate.target.name === target.name && candidate.arm === unit.arm,
            );
            if (!pipeline) {
              throw new Error(`No ${unit.arm} workspace was created for primary target ${target.name}.`);
            }
            await runOne(pipeline, planned, unit.runIndex);
          }
        }
      }
    } else {
      // Bounded-concurrency pool: process up to `concurrency` pipelines at once,
      // pulling the next as each finishes. Cheaper than Promise.all when the
      // matrix is large and the user wants to cap parallel API load.
      const pool = Math.min(concurrency, pipelines.length);
      console.log(
        `Running ${pipelines.length} pipelines (target × arm) with concurrency=${pool === Infinity ? 'unlimited' : pool}`,
      );
      let next = 0;
      const workers = Array.from({ length: pool }, async () => {
        while (true) {
          const idx = next++;
          if (idx >= pipelines.length) return;
          await runPipeline(pipelines[idx]!);
        }
      });
      await Promise.all(workers);
    }

    if (judgeMode === JudgeMode.OracleBatch) {
      for (const target of targets) {
        for (const { selected } of plannedByTarget.get(target.name) ?? []) {
          const matching = records.filter(
            (record) => record.target === target.name && record.case === selected.caseId,
          );
          if (!selected.cell.truth) {
            for (const record of matching) {
              if (record.agentStatus !== 'completed') continue;
              record.judge = {
                score: null,
                judgeStatus: 'not_run',
                dimensions: [],
                raw: 'oracle batch not applicable: cell has no curated truth',
                usage: emptyUsage(),
              };
              record.judgeStatus = 'not_run';
              const judgePath = join(
                runDir,
                'runs',
                record.target,
                record.case,
                record.arm,
                `run-${record.runIndex}`,
                'judge.json',
              );
              writeFileSync(judgePath, JSON.stringify(record.judge, null, 2));
            }
            continue;
          }
          const cellManifest = runManifest.cells.find(
            (cell) => cell.target === target.name && cell.case === selected.caseId,
          );
          if (!cellManifest?.oracleHash) {
            throw new Error(`${target.name}/${selected.caseId}: oracle hash missing from run manifest.`);
          }
          const key = `${target.name}|${selected.caseId}`;
          const job = createOracleBatchJob({
            target: target.name,
            caseId: selected.caseId,
            prompt: promptByCell.get(key)!,
            oracleHash: cellManifest.oracleHash,
            truth: selected.cell.truth,
            records,
            cohortId: runManifest.cohortId,
          });
          if (!job) continue;
          const artifactPath = oracleBatchArtifactPath(runDir, job);
          mkdirSync(dirname(artifactPath), { recursive: true });
          let raw = '';
          let batchUsage = emptyUsage();
          let error: string | null = null;
          let downgradedVerdicts: DowngradedVerdict[] = [];
          let verdictCounts: VerdictCounts | null = null;
          try {
            oracleJudgeUsage.calls += 1;
            const execution = await executeOracleBatchJob(
              job,
              judgeSpec,
              join(dirname(artifactPath), `${selected.caseId}-codex-last-message.txt`),
              { baseTimeoutMs: judgeBaseTimeoutMs },
            );
            raw = execution.raw;
            batchUsage = execution.usage;
            downgradedVerdicts = execution.downgradedVerdicts;
            verdictCounts = execution.verdictCounts;
            oracleJudgeUsage.totalTokens += execution.usage.totalTokens;
            oracleJudgeUsage.costUsd += execution.usage.costUsd;
            applyOracleBatchExecution(job, execution);
          } catch (caught) {
            if (caught instanceof OracleBatchExecutionError) {
              raw = caught.raw;
              batchUsage = caught.usage;
              oracleJudgeUsage.totalTokens += caught.usage.totalTokens;
              oracleJudgeUsage.costUsd += caught.usage.costUsd;
            }
            error = caught instanceof Error ? caught.message : String(caught);
            console.error(`[oracle-batch-error] ${target.name}/${selected.caseId}: ${error}`);
            applyOracleBatchFailure(job, error);
          }
          writeFileSync(
            artifactPath,
            `${JSON.stringify(
              oracleBatchArtifact({
                job,
                raw,
                usage: batchUsage,
                error,
                downgradedVerdicts,
                verdictCounts,
              }),
              null,
              2,
            )}\n`,
          );
          for (const member of job.members) {
            const judgePath = join(
              runDir,
              'runs',
              member.record.target,
              member.record.case,
              member.record.arm,
              `run-${member.record.runIndex}`,
              'judge.json',
            );
            writeFileSync(judgePath, JSON.stringify(member.record.judge, null, 2));
          }
        }
      }
      const replacement = `${jsonl}.tmp`;
      writeFileSync(
        replacement,
        records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
      );
      renameSync(replacement, jsonl);
    }
  } finally {
    await cleanupRunResources(createdWorkspaces, caffeinate);
  }

  if (!runManifest) throw new Error('Run manifest was not created before execution.');
  const graphBackendPath = backend === GraphBackend.Ladybug ? ladybugPath : sqlitePath;
  const graphAfter = await fingerprintGraphBackend(backend, graphBackendPath);
  runManifest.graphFingerprintAfter = graphAfter.fingerprint;
  runManifest.graphChangedDuringRun = graphAfter.fingerprint !== runManifest.graph.fingerprint;
  runManifest.oracleJudgeUsage =
    judgeMode === JudgeMode.OracleBatch ? oracleJudgeUsage : null;
  writeFileSync(manifestPath, `${JSON.stringify(runManifest, null, 2)}\n`);
  const reportPath = join(runDir, 'REPORT.md');
  const reportMeta = {
    runId,
    wallClockMs: Date.now() - startedAt,
    agentModel:
      provider === AgentProvider.Codex
        ? `codex:${codexModel}`
        : claudeModel,
    judgeModel: formatJudgeSpec(judgeSpec),
    judgeMode,
    oracleJudgeUsage:
      judgeMode === JudgeMode.OracleBatch ? oracleJudgeUsage : undefined,
    commit: runManifest.harness.head,
    actualTargetSha: runManifest.targets
      .map((target) => `${target.repoKey}=${target.actualVerifierGitSha}`)
      .join(', '),
    graphParsedSha: runManifest.graph.repositories
      .map((repo) => `${repo.repoKey}=${repo.parsedGitSha}`)
      .join(', '),
    cohortId: runManifest.cohortId,
    provider,
    backend,
    accessMode,
    sourceInGraph: runManifest.graph.sourceInGraph,
  };
  if (runManifest.graphChangedDuringRun) {
    const reason =
      `Graph backend changed during the eval: ${runManifest.graph.fingerprint} -> ${graphAfter.fingerprint}.`;
    writeReport({
      reportPath,
      records,
      runManifest,
      meta: reportMeta,
      invalidatedReason: reason,
    });
    throw new Error(reason);
  }

  writeReport({
    reportPath,
    records,
    runManifest,
    meta: reportMeta,
  });

  // Append the MCP-gap section to the same REPORT.md and write per-run-dir
  // mcp-gaps.jsonl with one record per failed MCP call so downstream tooling
  // (parser regression triage, response-shape changes) can consume it.
  const analysis = analyzeRunDir(runDir);
  appendFileSync(reportPath, `${analysis.reportSection.join('\n')}\n`);

  console.log(`\nReport: ${reportPath}`);
  console.log(`MCP gaps: ${analysis.records.length} flagged → ${analysis.jsonlPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
