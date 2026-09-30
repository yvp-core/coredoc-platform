// evals/harness/run-intent.ts
/**
 * The intent quality and token gate (issue 06): two arms over the fixed
 * behavior corpus, AC-10 judged deterministically from tool events and AC-12 by
 * a blind per-artifact fact judge.
 *
 *   baseline — the coredoc code-graph MCP tools, WITHOUT `get_intent_context`
 *              and without the intent methodology.
 *   intent   — the same, plus the intent tool in the allowlist and the
 *              canonical `coredoc-workflows` intent-context methodology inlined
 *              in the operating instructions (and, on claude, ALSO staged as a
 *              skill, which is how the capability ships).
 *
 * Claude can hold the code-graph surface constant, so its arm difference is
 * attributable to the overlay. Codex cannot filter one MCP tool: its control
 * loses the whole graph server and is therefore diagnostic, never gating.
 *
 * Quality is the gate; tokens, cost and latency are DIAGNOSTIC only (epic
 * rollout step 4). The run is manual and paid — there is no CI wiring, in line
 * with the rest of `evals/`.
 *
 * Invocation:
 *
 *   pnpm --dir evals run eval:intent:setup
 *   pnpm --dir evals run eval:intent --smoke
 *
 * Write the flags WITHOUT a `--` separator. pnpm 9 forwards the literal `--`
 * token to the script (`pnpm run eval:intent -- --smoke` arrives here as
 * `['--', '--smoke']`), and `node:util`'s {@link parseArgs} stops option parsing
 * at `--`, so `--smoke` lands as a positional and the run aborts with
 * "Unexpected argument '--smoke'. This command does not take positional
 * arguments" before the first paid call.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAgent } from './agent.js';
import { assertCodexAvailable, runCodexAgent } from './agent-codex.js';
import { parsePositiveIntegerFlag } from './cli-integers.js';
import { isTransientError, withRetry } from './run-planning.js';
import {
  INTENT_MCP_TOOL,
  IntentAc10Verdict,
  IntentViolationSeverity,
  analyzeIntentRun,
  noTranscriptAnalysis,
  type IntentRunAnalysis,
} from './analyze-intent.js';
import {
  INTENT_DEGRADE_THRESHOLD,
  IntentJudgeStatus,
  SEEDED_CONTROL_ARM,
  aggregateIntentJudgements,
  createSdkJudgeCall,
  judgeIntentArtifact,
  judgeSeededControl,
  synthesizeSeededControlArtifact,
  type IntentJudgementAggregate,
  type IntentJudgementRecord,
} from './judge-intent.js';
import { AgentProvider, parseProvider, type Usage } from './types.js';
import { INTENT_TASKS, IntentPromptShape, intentTaskById, type IntentTask } from '../cases-intent/tasks.js';
import {
  assertOverlayCanonical,
  assertStagedTraps,
  parseIntentStatusReport,
  readSetupResult,
  type IntentStatusReport,
  type SetupResult,
} from '../cases-intent/setup.js';
import { CLI_ENTRY, intentEvalTarget, type IntentEvalTarget } from '../cases-intent/target.js';

/** Agent model for both arms; overridable for a cheap smoke (`--model`). */
const INTENT_MODEL = 'claude-sonnet-5';
/**
 * Codex agent model (`--provider codex`). Pinned separately because the two
 * providers have disjoint model vocabularies and `codex exec` never reports the
 * model it resolved — an unpinned codex run would be unreproducible.
 */
const CODEX_INTENT_MODEL = 'gpt-6-sol';
/** Judge model, pinned separately from the arms (`--judge-model`). */
const INTENT_JUDGE_MODEL = 'claude-opus-5-5';
const ARM_TIMEOUT_MS = 12 * 60 * 1000;
const ARM_MAX_TURNS = 40;
const JUDGE_TIMEOUT_MS = 5 * 60 * 1000;

/** Canonical OSS distribution beside the coredoc checkout. */
export function defaultWorkflowsPluginDir(coredocRepoRoot: string): string {
  return resolve(coredocRepoRoot, '..', 'coredoc-workflows', 'plugins', 'coredoc-workflows');
}

export type IntentArmId = 'baseline' | 'intent';

export interface IntentArmSpec {
  id: IntentArmId;
  /** Whether `get_intent_context` is in the allowlist and the methodology staged. */
  intent: boolean;
}

export const INTENT_ARMS: readonly IntentArmSpec[] = [
  { id: 'baseline', intent: false },
  { id: 'intent', intent: true },
];

const BASE_SYSTEM_CORE = `You are a senior engineer working in a single-repository TypeScript service, read-only:
you cannot modify files. Investigate the code as far as the task needs, then produce the artifact the
task asks for. Your FINAL message MUST be that artifact, in markdown, and nothing else. Cite concrete
file paths in backticks. You are running autonomously: do NOT ask questions — state assumptions inline.`;

const MCP_SYSTEM_PARAGRAPH = `The coredoc MCP tools (mcp__coredoc-eval__*) are available for querying the parsed code graph of this
repository.`;

/** Byte-identical to the prompt every claude arm has always received. */
const BASE_SYSTEM = `${BASE_SYSTEM_CORE}\n\n${MCP_SYSTEM_PARAGRAPH}`;

/**
 * The one intent-arm paragraph, identical on both hosts. The canonical
 * methodology is INLINED after it rather than merely named, on claude too.
 *
 * Codex never had a choice (it cannot load a claude skill plugin). Claude did,
 * and the 2026-08-27 pair of full runs measured what the choice cost: the
 * inline-methodology codex arm scored AC-10 10/12 against the skill-loaded
 * claude arm's 7/12, one of those a session where the skill never triggered at
 * all. Delivery is now the same on both providers, so an arm difference is a
 * host difference; the skill stays staged for production parity and is recorded
 * as a caveat (`caveatsFor`).
 */
const INTENT_SYSTEM_SUFFIX = `

This session also has the coredoc product-intent capability: the mcp__coredoc-eval__get_intent_context
tool over the project's reviewed product intent. The methodology for using it follows verbatim; treat it
as operating instructions.`;

/** Header separating the operating instructions from the verbatim methodology. */
const METHODOLOGY_HEADER = '--- intent-context methodology ---';

/**
 * Whether an arm is given the spawned `coredoc-eval` MCP server at all.
 *
 * The providers differ here and the difference is deliberate. Claude has a
 * per-tool allowlist, so BOTH arms get the server and the control simply lacks
 * `get_intent_context` in its allowlist. `codex exec` has no per-tool
 * allowlist — its only lever is which servers exist — so the codex control gets
 * NO server. That is a structurally cleaner denial (the tool is not merely
 * refused, it is absent) and simultaneously a WIDER arm difference: the codex
 * control also loses the code-graph tools. Reported as a caveat, never hidden.
 */
export function armUsesMcp(arm: IntentArmSpec, provider: AgentProvider): boolean {
  if (provider === AgentProvider.Codex) return arm.intent;
  return true;
}

export function systemPromptFor(
  arm: IntentArmSpec,
  provider: AgentProvider = AgentProvider.Claude,
  methodology?: string,
): string {
  const base = armUsesMcp(arm, provider) ? BASE_SYSTEM : BASE_SYSTEM_CORE;
  if (!arm.intent) return base;
  if (!methodology || methodology.trim() === '') {
    throw new Error(
      `The ${provider} intent arm carries the intent-context methodology inline; no methodology text was supplied.`,
    );
  }
  return `${base}${INTENT_SYSTEM_SUFFIX}\n\n${METHODOLOGY_HEADER}\n${methodology.trim()}`;
}

/** The default agent model for a provider; `--model` overrides either. */
export function defaultAgentModelFor(provider: AgentProvider): string {
  return provider === AgentProvider.Codex ? CODEX_INTENT_MODEL : INTENT_MODEL;
}

/**
 * Run-directory name. A codex run is marked on disk so two providers' runs are
 * never mistaken for reps of one another when reading `runs-intent/` later; the
 * claude name stays the bare timestamp it has always been.
 */
export function intentRunId(timestamp: string, provider: AgentProvider): string {
  return provider === AgentProvider.Codex ? `${timestamp}-codex` : timestamp;
}

/**
 * The canonical methodology BODY, read back out of the staged skill plugin.
 *
 * Same bytes the claude arm loads as a skill — the codex arm just receives them
 * as instructions text. Only the eval-authored frontmatter (claude plugin
 * packaging, meaningless to codex) is stripped.
 */
export function readIntentMethodology(pluginDir: string): string {
  const skillPath = join(pluginDir, 'skills', 'intent-context', 'SKILL.md');
  if (!existsSync(skillPath)) {
    throw new Error(`staged intent-context SKILL.md not found at ${skillPath} — stage the skill plugin first.`);
  }
  const raw = readFileSync(skillPath, 'utf8');
  const match = /^---\n[\s\S]*?\n---\n/.exec(raw);
  return (match ? raw.slice(match[0].length) : raw).trim();
}

/**
 * Where an arm runs.
 *
 * The control does not merely lack the intent tool — it runs in a checkout that
 * does not contain `.coredoc/` at all, staged by `setup.ts` in a temp directory
 * OUTSIDE this repository and passed in from the recorded `SetupResult`.
 *
 * Two rounds of leakage produced that shape. Denying the capability was not
 * enough (most claude baselines read the overlay out of the then-shared cwd),
 * and neither was a sibling `cases-intent/workspace-control/`: 9 of 12 codex
 * baselines, which run under a read-only sandbox that permits arbitrary reads,
 * walked up to `../../workspace/fixture-repo/.coredoc/intent.json`.
 */
export function cwdForArm(arm: IntentArmSpec, target: IntentEvalTarget, controlRepoRoot: string): string {
  return arm.intent ? target.repoRoot : controlRepoRoot;
}

/**
 * The control checkout recorded by setup, proven to still exist.
 *
 * It is temp state: a reboot or a tmp reaper can take it away between setup and
 * the run, and a baseline arm whose cwd does not exist would burn a paid run on
 * empty artifacts.
 */
export function resolveControlRepoRoot(setup: SetupResult): string {
  if (!existsSync(setup.controlRepoRoot)) {
    throw new Error(
      `The control checkout recorded by setup is missing at ${setup.controlRepoRoot}. It is staged in a temp ` +
        'directory, so a reboot or a tmp cleaner removes it — re-run `pnpm --dir evals eval:intent:setup`.',
    );
  }
  return setup.controlRepoRoot;
}

/**
 * Stage the CANONICAL intent-context methodology as a skill.
 *
 * The body is copied from the `coredoc-workflows` distribution at run time
 * (issue 05 keeps it there, not here), so the eval measures the shipped
 * guidance rather than a fork of it. Only the frontmatter — which the
 * methodology file, being a resource rather than a skill, does not carry — is
 * authored here.
 */
export function stageIntentSkillPlugin(evalsRoot: string, workflowsPluginDir: string): string {
  const source = join(workflowsPluginDir, 'resources', 'methodology', 'intent-context.md');
  if (!existsSync(source)) {
    throw new Error(
      `intent-context methodology not found at ${source} — set COREDOC_WORKFLOWS_PLUGIN_DIR to the ` +
        'coredoc-workflows plugin directory.',
    );
  }
  const pluginDir = join(evalsRoot, '_intent-skill-plugin');
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: 'coredoc-intent-eval-skills',
        description:
          "Eval-side plugin carrying the canonical coredoc-workflows intent-context methodology as a skill. Synced from the coredoc-workflows distribution by evals/harness/run-intent.ts at startup.",
      },
      null,
      2,
    )}\n`,
  );
  const skillDir = join(pluginDir, 'skills', 'intent-context');
  mkdirSync(skillDir, { recursive: true });
  const frontmatter = [
    '---',
    'name: intent-context',
    'description: Use the coredoc product-intent capability (the get_intent_context MCP tool or the `coredoc intent context` CLI) to ground planning, implementation, review and investigation in reviewed product intent — exact routed ids first, at most one broad lookup per stage, and authority/anchor/freshness reported independently.',
    '---',
    '',
  ].join('\n');
  writeFileSync(join(skillDir, 'SKILL.md'), frontmatter + readFileSync(source, 'utf8'));
  return pluginDir;
}

/** Copy the canonical intent-capture skill for reference beside the methodology. */
export function stageCaptureSkillReference(repoRoot: string, pluginDir: string): void {
  const source = join(repoRoot, 'skills', 'intent-capture');
  if (!existsSync(source)) return;
  const destination = join(pluginDir, 'skills', 'intent-capture');
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

export interface IntentPreflight {
  /** The baseline arm's cwd: setup's temp control copy, or — for a diagnostic
   * target, which setup refuses to stage — the shared checkout. */
  controlRepoRoot: string;
  overlaySha256: string;
  graphCommit: string | null;
  headCommit: string | null;
  statusReport: IntentStatusReport;
  diagnostic: boolean;
}

/**
 * Preconditions every run (pilot amendment): the overlay under test must be
 * VALID and in canonical form before a single paid call is made, and — for the
 * checked-in fixture — its freshness traps must be observable.
 */
export function preflightIntentEval(target: IntentEvalTarget = intentEvalTarget): IntentPreflight {
  for (const [label, path] of [
    ['MCP server dist', target.mcpServerCommand],
    ['coredoc CLI dist', CLI_ENTRY],
    ['eval config', target.configPath],
    ['repo checkout', target.repoRoot],
    ['intent overlay', target.intentPath],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${label} missing at ${path}`);
  }
  const cli = (args: string[]): string =>
    execFileSync('node', [CLI_ENTRY, ...args, '-c', target.configPath], {
      cwd: dirname(target.configPath),
      encoding: 'utf8',
      env: { ...process.env, COREDOC_DB_BACKEND: 'sqlite' },
      maxBuffer: 32 * 1024 * 1024,
    });

  cli(['intent', 'validate', '-p', target.projectId]);
  const statusReport = parseIntentStatusReport(cli(['intent', 'status', '-p', target.projectId]));
  const overlaySha256 = assertOverlayCanonical(target.intentPath, target.projectId);

  if (target.diagnostic) {
    // D5: the local `cd` overlay is not staged by this repository, so its traps
    // are unverifiable here. It runs as a diagnostic arm and never gates.
    return {
      controlRepoRoot: target.repoRoot,
      overlaySha256,
      graphCommit: null,
      headCommit: null,
      statusReport,
      diagnostic: true,
    };
  }
  assertStagedTraps(statusReport);
  const setup = readSetupResult(target);
  if (setup.overlaySha256 !== overlaySha256) {
    throw new Error('The overlay changed since setup ran — re-run setup so the report fingerprints are honest.');
  }
  return {
    controlRepoRoot: resolveControlRepoRoot(setup),
    overlaySha256,
    graphCommit: setup.graphCommit,
    headCommit: setup.headCommit,
    statusReport,
    diagnostic: false,
  };
}

export interface IntentRunRecord {
  taskId: string;
  stage: string;
  shape: IntentPromptShape;
  arm: IntentArmId;
  rep: number;
  artifactPath: string;
  artifactChars: number;
  /** Summed across retry attempts — a retried run cost what every attempt cost. */
  usage: Usage;
  attempts: number;
  latencyMs: number;
  analysis: IntentRunAnalysis;
  error: string | null;
}

/* ------------------------------------------------------------------ *
 * Invocation resolution and the gate decision — pure, so both are unit
 * tested without a paid run.
 * ------------------------------------------------------------------ */

export interface IntentInvocationFlags {
  task?: string | undefined;
  arm?: string | undefined;
  reps?: string | undefined;
  smoke?: boolean | undefined;
}

export interface IntentInvocation {
  tasks: IntentTask[];
  arms: IntentArmSpec[];
  reps: number;
  smoke: boolean;
  /**
   * True when the matrix this run executed is NARROWER than the gate corpus.
   * A partial run is reported and never announced as a gate result: an
   * `--arm intent` run has no control to compare against, and a `--task` run
   * has not exercised the traps the other tasks carry.
   */
  partial: boolean;
}

/**
 * Fail closed on filters that select nothing.
 *
 * An unrecognised `--task`/`--arm` used to filter the matrix down to zero jobs
 * and then walk every 0/0 branch straight to "GATE PASSED" with no session run
 * at all — the most expensive kind of misleading green.
 */
export function resolveIntentInvocation(
  flags: IntentInvocationFlags,
  allTasks: readonly IntentTask[] = INTENT_TASKS,
  allArms: readonly IntentArmSpec[] = INTENT_ARMS,
): IntentInvocation {
  const tasks = [...allTasks];
  const arms = [...allArms];
  let selectedTasks = tasks;
  let selectedArms = arms;
  if (flags.task !== undefined) {
    selectedTasks = tasks.filter((task) => task.id === flags.task);
    if (selectedTasks.length === 0) {
      throw new Error(
        `Unknown --task "${flags.task}". Valid task ids: ${tasks.map((task) => task.id).join(', ')}`,
      );
    }
  }
  if (flags.arm !== undefined) {
    selectedArms = arms.filter((arm) => arm.id === flags.arm);
    if (selectedArms.length === 0) {
      throw new Error(`Unknown --arm "${flags.arm}". Valid arm ids: ${arms.map((arm) => arm.id).join(', ')}`);
    }
  }
  let reps = parsePositiveIntegerFlag(flags.reps, '--reps', 3);
  if (flags.smoke) {
    selectedTasks = selectedTasks.slice(0, 1);
    reps = 1;
  }
  return {
    tasks: selectedTasks,
    arms: selectedArms,
    reps,
    smoke: flags.smoke === true,
    partial: selectedTasks.length !== tasks.length || selectedArms.length !== arms.length,
  };
}

/** The record a job that THREW leaves behind, so it stays in the denominators. */
export function degradedRecordForFailedJob(
  task: IntentTask,
  arm: IntentArmSpec,
  rep: number,
  error: unknown,
): IntentRunRecord {
  const message = error instanceof Error ? error.message : String(error);
  return {
    taskId: task.id,
    stage: task.stage,
    shape: task.shape,
    arm: arm.id,
    rep,
    artifactPath: '',
    artifactChars: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    attempts: 0,
    latencyMs: 0,
    analysis: noTranscriptAnalysis(arm.id, message),
    error: message,
  };
}

export enum IntentGateStatus {
  Pass = 'pass',
  Fail = 'fail',
  /** Narrower than the corpus (smoke/`--task`/`--arm`) — reported, never a gate. */
  Partial = 'partial',
  /** Non-gating evidence: a D5 target or a provider without a comparable control. */
  Diagnostic = 'diagnostic',
}

export function intentGateNonGatingReason(provider: AgentProvider, targetDiagnostic: boolean): string | null {
  if (targetDiagnostic) {
    return 'D5 target: the run points at a local overlay outside this repository.';
  }
  if (provider === AgentProvider.Codex) {
    return (
      'Codex control is not causally comparable: it lacks the code-graph MCP server as well as intent context, ' +
      'so an arm difference cannot be attributed to the overlay alone.'
    );
  }
  return null;
}

export interface IntentGateInput {
  provider: AgentProvider;
  diagnostic: boolean;
  partial: boolean;
  degraded: boolean;
  records: readonly IntentRunRecord[];
  judgements: readonly IntentJudgementRecord[];
}

export interface IntentGateResult {
  status: IntentGateStatus;
  gatePassed: boolean;
  ac10Failures: IntentRunRecord[];
  /** AC-10 failures carrying at least one HARD finding — any one fails the gate. */
  ac10HardFailures: IntentRunRecord[];
  /** Intent-arm sessions whose only AC-10 findings are SOFT — budgeted, not fatal. */
  ac10SoftSessions: IntentRunRecord[];
  /** True when {@link ac10SoftSessions} exceeded {@link SOFT_VIOLATION_SESSION_BUDGET}. */
  softBudgetExceeded: boolean;
  ac12Failures: IntentJudgementRecord[];
  reasons: string[];
  /**
   * Findings that were REPORTED and did not gate — today, soft-violating
   * sessions inside the budget. Never empty-by-omission: a soft slip that the
   * gate tolerated still prints.
   */
  reportedNotGating: string[];
  nonGatingReason: string | null;
}

/**
 * Soft-violating INTENT-arm sessions a passing run may contain.
 *
 * Maintainer decision, 2026-08-28 (see {@link IntentViolationSeverity}): one
 * broad-lookup budget overrun in 12 stochastic intent sessions is the observed
 * background rate of an otherwise-compliant model, not evidence that the
 * guidance failed. Two is a pattern and fails.
 */
export const SOFT_VIOLATION_SESSION_BUDGET = 1;

/** The failing AC-10 verdicts — a session the gate must weigh. */
function isAc10Failure(record: IntentRunRecord): boolean {
  return (
    record.analysis.verdict === IntentAc10Verdict.Violation ||
    record.analysis.verdict === IntentAc10Verdict.NoAdoption ||
    record.analysis.verdict === IntentAc10Verdict.ContaminatedControl
  );
}

/**
 * The gate weight of one record, fail-closed.
 *
 * A record carrying any hard finding is hard even when it also slipped a
 * budget. A FAILING record that carries no classified finding at all — a
 * verdict written by a path that predates the split, or a future violation
 * shape nobody mapped — is treated as HARD rather than waved through: an
 * unclassified failure must never be spent out of the soft budget.
 */
export function intentRecordSeverity(record: IntentRunRecord): IntentViolationSeverity | null {
  if (record.analysis.hardViolations.length > 0) return IntentViolationSeverity.Hard;
  if (record.analysis.softViolations.length > 0) {
    return isAc10Failure(record) ? IntentViolationSeverity.Soft : null;
  }
  return isAc10Failure(record) ? IntentViolationSeverity.Hard : null;
}

function recordLabel(record: IntentRunRecord): string {
  return `${record.taskId}/${record.arm}/rep-${record.rep}`;
}

/**
 * The gate verdict, fail-closed by construction.
 *
 * "No failures" is NOT enough: a run with no sessions, or with one arm missing,
 * has no failures either. A pass therefore requires an actually-executed,
 * two-armed, unfiltered, non-degraded matrix.
 *
 * AC-10 is aggregated by SEVERITY (maintainer decision 2026-08-28): any hard
 * finding fails, soft findings fail once more than
 * {@link SOFT_VIOLATION_SESSION_BUDGET} intent session carries one. Per-session
 * AC-10 verdicts are untouched — every failing session still appears in
 * {@link IntentGateResult.ac10Failures} and in the report.
 */
export function computeIntentGate(input: IntentGateInput): IntentGateResult {
  // `no-transcript` records (a crashed session) are deliberately NOT AC-10
  // failures — there is no observed protocol to judge. They stay in
  // `records`, so they raise the arm error rate and degrade the run instead.
  const ac10Failures = input.records.filter(isAc10Failure);
  // Hard findings are gating wherever they appear — including on a record whose
  // per-session verdict is `pass` (one selector-less lookup inside the
  // open-stage budget), which is why this scans every record, not just failures.
  const ac10HardFailures = input.records.filter(
    (record) => intentRecordSeverity(record) === IntentViolationSeverity.Hard,
  );
  const ac10SoftSessions = input.records.filter(
    (record) => record.arm === 'intent' && intentRecordSeverity(record) === IntentViolationSeverity.Soft,
  );
  const softBudgetExceeded = ac10SoftSessions.length > SOFT_VIOLATION_SESSION_BUDGET;
  const ac12Failures = input.judgements.filter(
    (judgement) => judgement.arm === 'intent' && !judgement.passed && judgement.excluded !== true,
  );
  const reasons: string[] = [];
  if (input.records.length === 0) reasons.push('no run records: the matrix executed zero sessions');
  if (!input.records.some((record) => record.arm === 'intent')) reasons.push('no intent-arm record in this run');
  if (!input.records.some((record) => record.arm === 'baseline')) {
    reasons.push('no baseline-arm record in this run — there is no control to compare against');
  }
  if (input.degraded) reasons.push('the run is degraded');
  for (const record of ac10HardFailures) {
    const findings = record.analysis.hardViolations.join('; ');
    reasons.push(
      `AC-10 HARD violation (zero tolerance) — ${record.analysis.verdict}: ${recordLabel(record)}` +
        `${findings === '' ? '' : `: ${findings}`}`,
    );
  }
  if (softBudgetExceeded) {
    reasons.push(
      `AC-10 SOFT budget exceeded: ${ac10SoftSessions.length} intent session(s) overran the broad-lookup budget ` +
        `(at most ${SOFT_VIOLATION_SESSION_BUDGET} per run) — ${ac10SoftSessions.map(recordLabel).join(', ')}`,
    );
  }
  for (const judgement of ac12Failures) {
    reasons.push(`AC-12 failure: ${judgement.taskId}/${judgement.arm}/rep-${judgement.rep}`);
  }

  // Soft slips inside the budget never disappear: they are stated as tolerated.
  const reportedNotGating = softBudgetExceeded
    ? []
    : ac10SoftSessions.map(
        (record) =>
          `AC-10 SOFT violation (reported, not gating — within the ${SOFT_VIOLATION_SESSION_BUDGET}-session ` +
          `budget): ${recordLabel(record)}: ${record.analysis.softViolations.join('; ')}`,
      );

  const nonGatingReason = intentGateNonGatingReason(input.provider, input.diagnostic);
  const common = {
    ac10Failures,
    ac10HardFailures,
    ac10SoftSessions,
    softBudgetExceeded,
    ac12Failures,
    reasons,
    reportedNotGating,
  };
  if (nonGatingReason) {
    return { status: IntentGateStatus.Diagnostic, gatePassed: false, ...common, nonGatingReason };
  }
  if (input.partial) {
    return { status: IntentGateStatus.Partial, gatePassed: false, ...common, nonGatingReason: null };
  }
  const gatePassed = reasons.length === 0;
  return {
    status: gatePassed ? IntentGateStatus.Pass : IntentGateStatus.Fail,
    gatePassed,
    ...common,
    nonGatingReason: null,
  };
}

export interface IntentReportInvocation {
  taskIds: readonly string[];
  armIds: readonly IntentArmId[];
  reps: number;
  smoke: boolean;
  partial: boolean;
}

export interface IntentReportInput {
  runId: string;
  /** Which agent host ran the arms. The judge is always claude (deliberate). */
  provider: AgentProvider;
  target: IntentEvalTarget;
  preflight: IntentPreflight;
  agentModel: string;
  judgeModel: string;
  invocation: IntentReportInvocation;
  records: readonly IntentRunRecord[];
  judgements: readonly IntentJudgementRecord[];
  aggregate: IntentJudgementAggregate;
  /** Summed judge usage — the second half of what the run actually cost. */
  judgeUsage: Usage;
  degradedRuns: number;
  wallClockMs: number;
  gate: IntentGateResult;
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(0)}%`;
}

function headline(input: IntentReportInput): string {
  if (input.gate.status === IntentGateStatus.Diagnostic) {
    return `**DIAGNOSTIC RUN — not a gate result.** ${input.gate.nonGatingReason ?? 'Reported, never gating.'}`;
  }
  if (input.gate.status === IntentGateStatus.Partial) {
    return (
      '**SMOKE / PARTIAL RUN — not a full gate result.** ' +
      `This run executed ${input.invocation.taskIds.length} of the corpus tasks and ` +
      `${input.invocation.armIds.length} of the arms; the findings below are observations, not a gate verdict.`
    );
  }
  return `**Gate result: ${input.gate.gatePassed ? 'PASS' : 'FAIL'}**`;
}

/**
 * The recorded arm differences, per provider.
 *
 * Every entry is something the harness CANNOT enforce away; the codex list is
 * not a shorter version of the claude one but a different one, because the two
 * hosts deny capabilities by different mechanisms.
 */
export function caveatsFor(provider: AgentProvider): string[] {
  const codex = provider === AgentProvider.Codex;
  const caveats: string[] = [];
  caveats.push(
    codex
      ? '**Arm isolation is partial.** Both codex arms run `codex exec --ignore-user-config --strict-config` with ' +
          '`project_doc_max_bytes=1`, so no personal config, MCP server or AGENTS.md reaches either of them; whatever ' +
          'account and CLI state remains is a shared constant, not a per-arm variable.'
      : '**Arm isolation is partial.** The two arms differ by the intent tool and the staged methodology skill, but ' +
          'they share the host: `runAgent` only zeroes `settingSources` in the isolated `historyless` mode, which forbids ' +
          'plugins and skills and therefore cannot host the intent arm. Host settings, user memory and account ' +
          'state reach both arms identically; they are a shared constant, not a per-arm variable.',
  );
  if (codex) {
    caveats.push(
      '**The codex control is given no MCP server at all.** `codex exec` has no per-tool allowlist — the only lever ' +
        'is which servers exist — so the control runs with no `coredoc-eval` server rather than with the server minus ' +
        'one tool. The denial is structurally cleaner (nothing to refuse, no "refused calls" to count, so a zero-' +
        'interaction control is a clean control and not a no-adoption failure, which applies to the intent arm only) ' +
        'and the arm difference is WIDER than on claude: the codex control also loses the code-graph tools, so a ' +
        'difference between the arms is attributable to the overlay PLUS the graph tools, not to the overlay alone.',
    );
    caveats.push(
      '**Read-only is enforced by a read-only sandbox, not by a tool allowlist.** The claude arms are restricted to ' +
        '`Read`/`Grep`/`Glob`; codex ships a fixed toolset and runs under its read-only sandbox (`--sandbox ' +
        'read-only`), so it investigates ' +
        'through one shell tool it can read (but not write) the checkout with. Both arms are equally unable to mutate ' +
        'the fixture, but the codex arms have a broader read surface (arbitrary shell) than the claude arms.',
    );
  }
  caveats.push(
    '**The methodology is always in context, on both providers.** The intent arm receives the canonical ' +
      '`intent-context` methodology bytes appended verbatim to its operating instructions on claude as well as on ' +
      'codex, so the measured behavior is "agent with the methodology", not "agent that may load the methodology". ' +
      'The claude arm ALSO has it staged as a skill (production parity: that is how the capability ships), which the ' +
      'codex host cannot load at all — so on claude the guidance is present twice, in context and as a loadable ' +
      'skill. Earlier runs delivered it to claude by skill only, and it did not reliably trigger.',
  );
  caveats.push(
    '**The control has no filesystem access to the overlay.** The baseline arm runs in a temp directory OUTSIDE ' +
      'this repository, holding a copy of the same staged checkout with `.coredoc/` removed (setup asserts that is ' +
      'the ONLY difference). A sibling `workspace-control/` was not enough — codex baselines reached the treatment ' +
      'overlay by walking `../..` — so there is no longer any relative path from the control to it. The ' +
      'overlay-read tripwire still runs on BOTH arms: a positive count on the control now means the isolation ' +
      'itself broke.',
  );
  caveats.push(
    '**Ids derived from earlier responses are exact-ID navigation (D9).** On a routed task, fetching an id that a ' +
      'PRIOR tool response returned (an item id or a relation endpoint) is reported as `ids derived` and is not a ' +
      'violation; only an id that was never routed and never returned counts as unrouted. Derivation is judged ' +
      'against strictly earlier responses, and it never buys an extra broad lookup.',
  );
  if (!codex) {
    caveats.push(
      '**The control sees the tool in the server tool list.** `get_intent_context` is absent from the baseline ' +
        "allowlist, not from the spawned server, so the baseline arm can attempt it. Attempts are refused by the host " +
        'and counted separately as "refused calls"; an ANSWERED interaction marks the record `contaminated-control` and ' +
        'excludes it from the AC-12 populations.',
    );
  }
  caveats.push(
    '**Overlay-read detection is a lower bound.** Direct reads of `.coredoc/intent.json` are detected by substring ' +
      'matching over tool inputs, so an obfuscated path or an indirect read would not be seen. A positive count is ' +
      'evidence of contamination; a zero count is not evidence of its absence.',
  );
  caveats.push(
    codex
      ? '**Codex cost not provider-reported.** `codex exec` reports token ' +
          'counts on `turn.completed` but no dollar figure, so every codex arm row reads $0.0000 by construction — ' +
          'that is a missing number, not a free run, and no price table is invented here. The judge is claude and its ' +
          'cost IS provider-reported. Token and latency numbers are diagnostic and never gate (epic rollout step 4).'
      : '**Cost is provider-reported.** Retried attempts are summed into the record they belong to, and the judge cost ' +
          'is reported separately; token and latency numbers are diagnostic and never gate (epic rollout step 4).',
  );
  if (codex) {
    caveats.push(
      '**The judge is claude on a codex run.** Arms and judge deliberately run on different providers: the fact ' +
        'scoring is about the artifact, and holding the judge fixed across providers is what makes two runs comparable.',
    );
  }
  return caveats;
}

export function renderIntentReport(input: IntentReportInput): string {
  const lines: string[] = [];
  const armCost = input.records.reduce((sum, record) => sum + record.usage.costUsd, 0);
  const judgeCost = input.judgeUsage.costUsd;
  lines.push(`# Intent gate run ${input.runId}`);
  lines.push('');
  lines.push(headline(input));
  if (input.gate.reasons.length > 0) {
    lines.push('');
    for (const reason of input.gate.reasons) lines.push(`- ${reason}`);
  }
  if (input.gate.reportedNotGating.length > 0) {
    lines.push('');
    for (const reported of input.gate.reportedNotGating) lines.push(`- ${reported}`);
  }
  lines.push('');
  lines.push('## Reproduction fingerprints');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| project | \`${input.target.projectId}\` |`);
  lines.push(`| agent model (both arms) | \`${input.agentModel}\` |`);
  lines.push(`| judge model | \`${input.judgeModel}\` |`);
  lines.push(`| tasks in this run | ${input.invocation.taskIds.join(', ')} |`);
  lines.push(`| arms in this run | ${input.invocation.armIds.join(', ')} |`);
  lines.push(`| reps per task-arm | ${input.invocation.reps} |`);
  lines.push(`| smoke | ${input.invocation.smoke ? 'yes' : 'no'} |`);
  lines.push(`| full gate matrix | ${input.invocation.partial ? 'NO — filtered/smoke run' : 'yes'} |`);
  lines.push(`| overlay sha256 | \`${input.preflight.overlaySha256}\` |`);
  lines.push(`| graph commit (parsed checkout) | \`${input.preflight.graphCommit ?? 'unknown'}\` |`);
  lines.push(`| HEAD commit during the run | \`${input.preflight.headCommit ?? 'unknown'}\` |`);
  lines.push(`| anchor status at run time | ${JSON.stringify(input.preflight.statusReport.anchorCounts)} |`);
  lines.push(`| snapshot freshness | ${JSON.stringify(input.preflight.statusReport.snapshotFreshness)} |`);
  lines.push(`| provider-reported cost (arms) | $${armCost.toFixed(4)} |`);
  lines.push(`| provider-reported cost (judge) | $${judgeCost.toFixed(4)} |`);
  lines.push(`| provider-reported cost (run total) | $${(armCost + judgeCost).toFixed(4)} |`);
  lines.push(`| judge tokens | ${input.judgeUsage.totalTokens} |`);
  lines.push(`| degraded runs (counted, not dropped) | ${input.degradedRuns} |`);
  lines.push(`| wall clock | ${(input.wallClockMs / 1000).toFixed(0)}s |`);
  // Both arms always run on ONE provider; the judge is claude on every run.
  lines.push(`| provider | ${input.provider} |`);
  lines.push('');

  lines.push('## AC-10 — observed tool protocol (deterministic, no judge)');
  lines.push('');
  lines.push(
    'Per-session verdicts are unchanged. The RUN-LEVEL gate reads severities (maintainer decision 2026-08-28): a ' +
      'HARD finding — overlay file read, selector-less call, an id neither routed nor returned, or an ignored routed ' +
      'id — fails the run on its own; SOFT findings (broad-lookup budget overruns) are rate-bounded at ' +
      `${SOFT_VIOLATION_SESSION_BUDGET} intent session per run and are reported either way.`,
  );
  lines.push('');
  lines.push(
    '| task | shape | arm | rep | verdict | severity | answered calls | refused calls | broad lookups | index calls | ids fetched | ids derived | ids unrouted | overlay file reads | attempts |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const record of input.records) {
    lines.push(
      `| ${record.taskId} | ${record.shape} | ${record.arm} | ${record.rep} | ${record.analysis.verdict} | ` +
        `${intentRecordSeverity(record) ?? '—'} | ` +
        `${record.analysis.interactions} | ${record.analysis.deniedInteractions} | ${record.analysis.broadLookups} | ` +
        `${record.analysis.indexCalls} | ${record.analysis.fetchedIds.join(', ') || '—'} | ${record.analysis.derivedIds.join(', ') || '—'} | ` +
        `${record.analysis.unroutedIds.join(', ') || '—'} | ${record.analysis.overlayFileReads} | ${record.attempts} |`,
    );
  }
  const reasons = input.records.filter((record) => record.analysis.reasons.length > 0);
  if (reasons.length > 0) {
    lines.push('');
    for (const record of reasons) {
      lines.push(`- \`${record.taskId}/${record.arm}/rep-${record.rep}\`: ${record.analysis.reasons.join('; ')}`);
    }
  }
  lines.push('');
  lines.push(
    `- hard violations (zero tolerance): ${input.gate.ac10HardFailures.length}` +
      (input.gate.ac10HardFailures.length === 0
        ? ''
        : ` — ${input.gate.ac10HardFailures.map((r) => `\`${r.taskId}/${r.arm}/rep-${r.rep}\``).join(', ')}`),
  );
  lines.push(
    `- soft-violating intent sessions: ${input.gate.ac10SoftSessions.length}/${SOFT_VIOLATION_SESSION_BUDGET} allowed` +
      (input.gate.ac10SoftSessions.length === 0
        ? ''
        : ` — ${input.gate.ac10SoftSessions.map((r) => `\`${r.taskId}/${r.arm}/rep-${r.rep}\``).join(', ')}` +
          `${input.gate.softBudgetExceeded ? ' (OVER BUDGET — gating)' : ' (within budget — reported, not gating)'}`),
  );
  const failed = input.records.filter((record) => record.error);
  if (failed.length > 0) {
    lines.push('');
    lines.push('Degraded sessions (counted in every denominator):');
    for (const record of failed) {
      lines.push(`- \`${record.taskId}/${record.arm}/rep-${record.rep}\`: ${record.error}`);
    }
  }
  lines.push('');

  lines.push('## AC-12 — blind per-artifact fact scoring');
  lines.push('');
  lines.push('| task | arm | rep | status | passed | required absent | forbidden tripped | counted |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const judgement of input.judgements.filter((j) => j.arm !== SEEDED_CONTROL_ARM)) {
    const absent = judgement.requiredFacts.filter((fact) => fact.verdict === 'absent').map((fact) => fact.id);
    const tripped = judgement.forbiddenFacts.filter((fact) => fact.verdict === 'tripped').map((fact) => fact.id);
    lines.push(
      `| ${judgement.taskId} | ${judgement.arm} | ${judgement.rep} | ${judgement.status} | ` +
        `${judgement.passed ? 'yes' : 'no'} | ${absent.join(', ') || '—'} | ${tripped.join(', ') || '—'} | ` +
        `${judgement.excluded ? `excluded (${judgement.exclusionReason ?? 'excluded'})` : 'yes'} |`,
    );
  }
  lines.push('');
  for (const [arm, bucket] of Object.entries(input.aggregate.passRateByArm)) {
    lines.push(`- ${arm}: ${bucket.passed}/${bucket.scored} artifacts passed (${pct(bucket.passed, bucket.scored)})`);
  }
  lines.push(`- invalid judge verdicts: ${input.aggregate.invalidCount}/${input.aggregate.total}`);
  lines.push(`- excluded from every population (contaminated controls): ${input.aggregate.excludedCount}`);
  lines.push(
    `- live baseline tripped its own trap: ${input.aggregate.liveBaselineTrippedOwnTrap ? 'yes' : 'no'} ` +
      '(INFORMATIONAL — a well-behaved control rep is not a judge fault and does not degrade the run)',
  );
  if (input.aggregate.missingBaselinePopulation) {
    lines.push('- **no scored live control artifact** — the arm comparison has no anchor, so the run is degraded');
  }
  lines.push(`- degrade threshold: ${INTENT_DEGRADE_THRESHOLD}`);
  lines.push('');

  // Judge health, measured on artifacts the harness wrote rather than on
  // whatever the paid control arm happened to produce this rep.
  lines.push('### Judge sensitivity — seeded controls (outside every population)');
  lines.push('');
  lines.push(
    'Each row is a deterministic artifact synthesized from the task\'s forbidden facts: it commits every ' +
      'prohibition on purpose, and is graded through the same blind prompt as a real artifact. It is counted in no ' +
      'pass rate and in no invalid rate — it exists only to prove the judge can still see a violation.',
  );
  lines.push('');
  lines.push('| task | status | forbidden tripped | expected trap tripped |');
  lines.push('| --- | --- | --- | --- |');
  const seededJudgements = input.judgements.filter((judgement) => judgement.arm === SEEDED_CONTROL_ARM);
  for (const judgement of seededJudgements) {
    const expected = (intentTaskById(judgement.taskId)?.forbiddenFacts ?? [])
      .filter((fact) => fact.baselineExpected)
      .map((fact) => fact.id);
    const tripped = judgement.forbiddenFacts.filter((fact) => fact.verdict === 'tripped').map((fact) => fact.id);
    const hitTrap = tripped.some((id) => expected.length === 0 || expected.includes(id));
    lines.push(
      `| ${judgement.taskId} | ${judgement.status} | ${tripped.join(', ') || '—'} | ${hitTrap ? 'yes' : 'NO'} |`,
    );
  }
  if (seededJudgements.length === 0) lines.push('| — | none judged | — | NO |');
  lines.push('');
  lines.push(
    `- seeded controls: ${input.aggregate.seededControls.tripped}/${input.aggregate.seededControls.judged} tripped ` +
      `their expected prohibition (${input.aggregate.seededControls.invalid} invalid)`,
  );
  lines.push(
    `- judge-insensitive: ${
      input.aggregate.judgeInsensitive
        ? 'YES — a seeded control did not trip the prohibition it was written to commit, so the judge showed no teeth'
        : 'no'
    }`,
  );
  lines.push('');

  lines.push('## Token and latency diagnostics (NOT a gate)');
  lines.push('');
  lines.push('| task | arm | rep | total tokens | cost usd | latency s | artifact chars | attempts |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const record of input.records) {
    lines.push(
      `| ${record.taskId} | ${record.arm} | ${record.rep} | ${record.usage.totalTokens} | ` +
        `${record.usage.costUsd.toFixed(4)} | ${(record.latencyMs / 1000).toFixed(0)} | ${record.artifactChars} | ` +
        `${record.attempts} |`,
    );
  }
  lines.push('');

  lines.push('## Caveats');
  lines.push('');
  for (const caveat of caveatsFor(input.provider)) lines.push(`- ${caveat}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      task: { type: 'string' },
      arm: { type: 'string' },
      reps: { type: 'string' },
      concurrency: { type: 'string' },
      smoke: { type: 'boolean' },
      model: { type: 'string' },
      'judge-model': { type: 'string' },
      provider: { type: 'string' },
    },
  });

  // Applies to BOTH arms: mixing hosts inside one matrix would make the
  // baseline/intent delta a provider delta as well.
  const provider = parseProvider(values.provider, process.env.COREDOC_EVAL_PROVIDER);
  // Fail before the first paid call rather than mid-matrix.
  if (provider === AgentProvider.Codex) assertCodexAvailable();

  const here = dirname(fileURLToPath(import.meta.url));
  const evalsRoot = resolve(here, '..');
  const repoRoot = resolve(evalsRoot, '..');
  const target = intentEvalTarget;

  process.env.COREDOC_SQLITE_URL = target.dbUrl;
  const preflight = preflightIntentEval(target);

  const workflowsPluginDir = process.env.COREDOC_WORKFLOWS_PLUGIN_DIR ?? defaultWorkflowsPluginDir(repoRoot);
  const intentPluginDir = stageIntentSkillPlugin(evalsRoot, workflowsPluginDir);
  stageCaptureSkillReference(repoRoot, intentPluginDir);

  const invocation = resolveIntentInvocation(values);
  const { tasks, arms, reps } = invocation;
  const concurrency = parsePositiveIntegerFlag(values.concurrency, '--concurrency', 2);
  const agentModel = values.model ?? defaultAgentModelFor(provider);
  // Read back out of the plugin the line above staged, so both providers get
  // the SAME canonical bytes: codex cannot load the skill at all, and on claude
  // a lazily-triggered skill is not reliably in context (2026-08-27 runs).
  const methodology = readIntentMethodology(intentPluginDir);
  const judgeModel = values['judge-model'] ?? INTENT_JUDGE_MODEL;

  const runId = intentRunId(new Date().toISOString().replace(/[:.]/g, '-'), provider);
  const runDir = join(evalsRoot, 'runs-intent', runId);
  mkdirSync(runDir, { recursive: true });
  const startedAt = Date.now();

  console.log(
    `Intent gate: ${tasks.length} tasks × ${arms.length} arms × ${reps} reps = ` +
      `${tasks.length * arms.length * reps} sessions ` +
      `(provider=${provider}, concurrency=${concurrency}, model=${agentModel})`,
  );
  if (invocation.partial) {
    console.warn(
      'PARTIAL RUN: the matrix is narrower than the gate corpus ' +
        `(tasks: ${tasks.map((task) => task.id).join(', ')}; arms: ${arms.map((arm) => arm.id).join(', ')}). ` +
        'This run is reported, never announced as a gate result.',
    );
  }

  type Job = { task: IntentTask; arm: IntentArmSpec; rep: number };
  const jobs: Job[] = [];
  for (const task of tasks) for (const arm of arms) for (let rep = 0; rep < reps; rep++) jobs.push({ task, arm, rep });

  const records: IntentRunRecord[] = [];
  async function runJob(job: Job): Promise<void> {
    const { task, arm, rep } = job;
    const artifactDir = join(runDir, task.id, arm.id, `rep-${rep}`);
    mkdirSync(artifactDir, { recursive: true });
    const transcriptPath = join(artifactDir, 'transcript.json');

    // Retries are not free: withRetry returns the LAST attempt, so the earlier
    // attempts' provider-reported cost would vanish from the report unless it is
    // captured here, per attempt.
    const attemptUsages: Usage[] = [];
    const result = await withRetry(
      `artifact ${task.id}/${arm.id}`,
      async () => {
        const withMcp = armUsesMcp(arm, provider);
        const agentOpts = {
          prompt: task.prompt,
          systemPrompt: systemPromptFor(arm, provider, methodology),
          model: agentModel,
          cwd: cwdForArm(arm, target, preflight.controlRepoRoot),
          arm: withMcp ? ('withMcp' as const) : ('withoutMcp' as const),
          // Read-only: an arm may investigate the checkout but never mutate the
          // staged fixture, whose content IS the freshness trap. (Claude only —
          // codex has a fixed toolset and enforces this with its sandbox.)
          baseTools: ['Read', 'Grep', 'Glob'],
          // The one intent-arm difference. MCP_TOOL_NAMES in agent.ts stays the
          // closed pre-intent list; this parallel entry rides the existing
          // extraTools seam.
          extraTools: arm.intent ? [INTENT_MCP_TOOL] : [],
          ...(withMcp
            ? {
                mcpServerCommand: target.mcpServerCommand,
                mcpServerEnv: {
                  MCP_CONFIG_PATH: target.configPath,
                  COREDOC_SCOPE: target.scope,
                  COREDOC_SQLITE_URL: target.dbUrl,
                  COREDOC_DB_BACKEND: 'sqlite',
                },
              }
            : {}),
          ...(arm.intent && provider !== AgentProvider.Codex
            ? { pluginPaths: [intentPluginDir], skills: ['coredoc-intent-eval-skills:intent-context'] }
            : {}),
          maxTurns: ARM_MAX_TURNS,
          timeoutMs: ARM_TIMEOUT_MS,
          transcriptPath,
        };
        const attempt =
          provider === AgentProvider.Codex
            ? await runCodexAgent({ ...agentOpts, codexModel: agentModel })
            : await runAgent(agentOpts);
        attemptUsages.push(attempt.usage);
        return attempt;
      },
      (r) => (isTransientError(r.error) ? r.error : null),
    );
    const usage = attemptUsages.reduce<Usage>(
      (sum, attempt) => ({
        inputTokens: sum.inputTokens + attempt.inputTokens,
        outputTokens: sum.outputTokens + attempt.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + attempt.cacheReadTokens,
        cacheCreationTokens: sum.cacheCreationTokens + attempt.cacheCreationTokens,
        totalTokens: sum.totalTokens + attempt.totalTokens,
        costUsd: sum.costUsd + attempt.costUsd,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0 },
    );

    const artifactPath = join(artifactDir, 'artifact.md');
    writeFileSync(artifactPath, result.responseText);
    writeFileSync(
      join(artifactDir, 'usage.json'),
      JSON.stringify({ usage, attempts: attemptUsages.length, attemptUsages }, null, 2),
    );
    const analysis = analyzeIntentRun({
      arm: arm.id,
      task,
      transcript: JSON.parse(readFileSync(transcriptPath, 'utf8')) as unknown[],
    });
    writeFileSync(join(artifactDir, 'analysis.json'), JSON.stringify(analysis, null, 2));

    records.push({
      taskId: task.id,
      stage: task.stage,
      shape: task.shape,
      arm: arm.id,
      rep,
      artifactPath,
      artifactChars: result.responseText.length,
      usage,
      attempts: attemptUsages.length,
      latencyMs: result.latencyMs,
      analysis,
      error: result.error,
    });
    console.log(
      `[artifact] ${task.id}/${arm.id}/rep-${rep} → chars=${result.responseText.length} ` +
        `ac10=${analysis.verdict} intentCalls=${analysis.interactions} tokens=${usage.totalTokens}` +
        `${result.error ? ` ERROR=${result.error}` : ''}`,
    );
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= jobs.length) return;
        const job = jobs[index]!;
        await runJob(job).catch((error) => {
          console.error(`[artifact-error] ${job.task.id}/${job.arm.id}/rep-${job.rep}`, error);
          // A thrown job used to disappear from every denominator, so a run
          // where half the sessions crashed reported a clean, complete matrix.
          records.push(degradedRecordForFailedJob(job.task, job.arm, job.rep, error));
        });
      }
    }),
  );
  writeFileSync(join(runDir, 'records.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

  // ---- Judging: one blind fact-scoring call per artifact (D8), plus one
  // seeded sensitivity control per task. The seeded controls share the worker
  // pool with the real artifacts (same judge, same concurrency budget) and their
  // judge calls are summed into the same cost rollup — they are a real, paid
  // part of the run, just not an observation of any arm. ----
  const judgements: IntentJudgementRecord[] = [];
  const judgeUsage: Usage[] = [];
  const judgeable = records.filter((record) => !record.error && record.artifactChars > 0);
  type JudgeJob = { seeded: false; record: IntentRunRecord } | { seeded: true; task: IntentTask };
  const judgeJobs: JudgeJob[] = [
    ...judgeable.map((record) => ({ seeded: false as const, record })),
    ...tasks.map((task) => ({ seeded: true as const, task })),
  ];

  const runSeededControl = async (task: IntentTask): Promise<void> => {
    const dir = join(runDir, 'seeded-controls', task.id);
    mkdirSync(dir, { recursive: true });
    // Written before the call and from the same generator, so the graded bytes
    // are on disk even when the judge call itself fails.
    writeFileSync(join(dir, 'artifact.md'), synthesizeSeededControlArtifact(task));
    const call = createSdkJudgeCall({
      cwd: target.repoRoot,
      model: judgeModel,
      timeoutMs: JUDGE_TIMEOUT_MS,
      transcriptPath: join(dir, 'judge-transcript.json'),
    });
    const outcome = await withRetry(
      `seeded-control ${task.id}`,
      () => judgeSeededControl(task, call),
      (result) => (result.record.status === IntentJudgeStatus.Invalid ? 'invalid seeded-control verdict' : null),
    ).catch((error) => {
      console.error('[seeded-control-error]', task.id, error);
      return null;
    });
    judgeUsage.push(call.usage);
    // A seeded control that could not be graded leaves the run with no evidence
    // that the judge has teeth, so it is recorded as invalid and degrades.
    judgements.push(
      outcome?.record ?? {
        taskId: task.id,
        arm: SEEDED_CONTROL_ARM,
        rep: 0,
        status: IntentJudgeStatus.Invalid,
        passed: false,
        requiredFacts: [],
        forbiddenFacts: [],
      },
    );
    const tripped = (outcome?.record.forbiddenFacts ?? [])
      .filter((fact) => fact.verdict === 'tripped')
      .map((fact) => fact.id);
    console.log(
      `[seeded-control] ${task.id} → ${outcome?.record.status ?? 'invalid'} tripped=${tripped.join(', ') || 'none'}`,
    );
  };

  let judgeNext = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, judgeJobs.length) }, async () => {
      while (true) {
        const index = judgeNext++;
        if (index >= judgeJobs.length) return;
        const job = judgeJobs[index]!;
        if (job.seeded) {
          await runSeededControl(job.task);
          continue;
        }
        const record = job.record;
        const task = tasks.find((candidate) => candidate.id === record.taskId)!;
        const call = createSdkJudgeCall({
          cwd: target.repoRoot,
          model: judgeModel,
          timeoutMs: JUDGE_TIMEOUT_MS,
          transcriptPath: join(dirname(record.artifactPath), 'judge-transcript.json'),
        });
        const result = await withRetry(
          `judge ${record.taskId}/${record.arm}/rep-${record.rep}`,
          () =>
            judgeIntentArtifact(
              {
                taskPrompt: task.prompt,
                artifact: readFileSync(record.artifactPath, 'utf8'),
                requiredFacts: task.requiredFacts,
                forbiddenFacts: task.forbiddenFacts,
              },
              call,
            ),
          (r) => (r.status === IntentJudgeStatus.Invalid ? (r.reason ?? 'invalid verdict') : null),
        ).catch((error) => {
          console.error('[judge-error]', record.taskId, record.arm, error);
          return null;
        });
        judgeUsage.push(call.usage);
        // A control the overlay reached is scored and reported, but it cannot
        // be part of the comparison it was collected to anchor (P1-5).
        const contaminated = record.analysis.verdict === IntentAc10Verdict.ContaminatedControl;
        judgements.push({
          taskId: record.taskId,
          arm: record.arm,
          rep: record.rep,
          status: result?.status ?? IntentJudgeStatus.Invalid,
          passed: result?.passed ?? false,
          requiredFacts: result?.requiredFacts ?? [],
          forbiddenFacts: result?.forbiddenFacts ?? [],
          ...(contaminated
            ? { excluded: true, exclusionReason: 'contaminated control: intent reached the no-context arm' }
            : {}),
        });
        console.log(
          `[judge] ${record.taskId}/${record.arm}/rep-${record.rep} → ` +
            `${result?.status ?? 'invalid'} passed=${result?.passed ?? false}`,
        );
      }
    }),
  );
  writeFileSync(join(runDir, 'judgements.jsonl'), `${judgements.map((j) => JSON.stringify(j)).join('\n')}\n`);

  const aggregate = aggregateIntentJudgements(judgements, {
    // Sensitivity is measured against the trap the task was BUILT around, not
    // against any prohibition of any task (P3-10) — and against the seeded
    // control, which commits that trap by construction, not against whatever the
    // paid baseline arm happened to write this rep.
    baselineExpectedFacts: (taskId) =>
      (intentTaskById(taskId)?.forbiddenFacts ?? [])
        .filter((fact) => fact.baselineExpected)
        .map((fact) => fact.id),
    // A deliberately control-less partial run must not degrade; a gate run with
    // no scored control must (P1-4c).
    expectBaselinePopulation: !invocation.partial && !preflight.diagnostic,
  });
  const degradedRuns = records.filter((record) => record.error || record.artifactChars === 0).length;
  const armErrorRate = records.length > 0 ? degradedRuns / records.length : 0;
  const degraded = aggregate.degraded || armErrorRate > INTENT_DEGRADE_THRESHOLD;
  const judgeTotals = judgeUsage.reduce<Usage>(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + usage.cacheReadTokens,
      cacheCreationTokens: sum.cacheCreationTokens + usage.cacheCreationTokens,
      totalTokens: sum.totalTokens + usage.totalTokens,
      costUsd: sum.costUsd + usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0 },
  );
  const gate = computeIntentGate({
    provider,
    diagnostic: preflight.diagnostic,
    partial: invocation.partial,
    degraded,
    records,
    judgements,
  });

  const report = renderIntentReport({
    provider,
    runId,
    target,
    preflight,
    agentModel,
    judgeModel,
    invocation: {
      taskIds: tasks.map((task) => task.id),
      armIds: arms.map((arm) => arm.id),
      reps,
      smoke: invocation.smoke,
      partial: invocation.partial,
    },
    records,
    judgements,
    aggregate,
    judgeUsage: judgeTotals,
    degradedRuns,
    wallClockMs: Date.now() - startedAt,
    gate,
  });
  const reportPath = join(runDir, 'REPORT.md');
  writeFileSync(reportPath, report);
  console.log(`\nReport: ${reportPath}`);

  if (degraded) {
    console.error(
      `\n⚠️  DEGRADED RUN — verdicts are NOT trustworthy.\n` +
        `   arm errors: ${degradedRuns}/${records.length}\n` +
        `   invalid judge verdicts: ${aggregate.invalidCount}/${aggregate.total}\n` +
        (aggregate.judgeInsensitive
          ? `   judge-insensitive: yes — no seeded control tripped its expected prohibition, ` +
            `the judge showed no teeth (${aggregate.seededControls.tripped}/${aggregate.seededControls.judged} ` +
            `tripped, ${aggregate.seededControls.invalid} invalid)\n`
          : '   judge-insensitive: no\n') +
        (aggregate.missingBaselinePopulation ? '   no scored live control artifact in a gating run\n' : '') +
        `   threshold: ${INTENT_DEGRADE_THRESHOLD}. Fix the cause and re-run.`,
    );
    process.exitCode = 1;
  }
  if (gate.status === IntentGateStatus.Diagnostic) {
    console.log(`Diagnostic run: ${gate.nonGatingReason ?? 'results are reported and do not gate.'}`);
    return;
  }
  if (gate.status === IntentGateStatus.Partial) {
    console.log(
      `\nPARTIAL RUN — not a gate result.${
        gate.reasons.length > 0 ? `\n   observations: ${gate.reasons.join('; ')}` : ''
      }`,
    );
    if (gate.ac10Failures.length > 0 || gate.ac12Failures.length > 0) process.exitCode = 1;
    return;
  }
  if (!gate.gatePassed) {
    console.error(
      `\n✗ GATE FAILED — AC-10 hard violations: ${gate.ac10HardFailures.length} (zero tolerance), ` +
        `soft-violating intent sessions: ${gate.ac10SoftSessions.length}/${SOFT_VIOLATION_SESSION_BUDGET} allowed, ` +
        `AC-12 failures (intent arm): ${gate.ac12Failures.length}.\n   ${gate.reasons.join('\n   ')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('\n✓ GATE PASSED');
  for (const reported of gate.reportedNotGating) console.log(`   ${reported}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
