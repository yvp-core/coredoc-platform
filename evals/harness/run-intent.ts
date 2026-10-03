// evals/harness/run-intent.ts
/**
 * The intent quality and token gate: two arms over the fixed behavior corpus,
 * AC-10 judged deterministically from tool events and AC-12 by a blind
 * per-artifact fact judge. Intent is served by a cloud workspace that
 * `cases-intent/setup.ts` seeded.
 *
 *   baseline — Read/Grep/Glob over the fixture checkout and no MCP server.
 *   intent   — the same, plus the workspace MCP server with exactly
 *              `get_intent_context` and `intent_read` allowlisted, and the
 *              canonical `coredoc-workflows` intent-context methodology inlined
 *              in the operating instructions.
 *
 * Claude only: the arm difference rests on a per-tool allowlist over a remote
 * MCP server, which the codex runner does not offer.
 *
 * Quality is the gate; tokens, cost and latency are diagnostic only. The run is
 * manual and PAID — there is no CI wiring, in line with the rest of `evals/`.
 *
 * Invocation:
 *
 *   pnpm --dir evals run eval:intent:setup
 *   pnpm --dir evals run eval:intent --smoke
 *
 * Write the flags WITHOUT a `--` separator: pnpm forwards a literal `--` to the
 * script and `node:util`'s {@link parseArgs} stops option parsing there, so
 * `--smoke` would land as a positional and abort the run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAgent } from './agent.js';
import { parsePositiveIntegerFlag } from './cli-integers.js';
import { isTransientError, withRetry } from './run-planning.js';
import {
  INTENT_MCP_TOOLS,
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
import type { Usage } from './types.js';
import { INTENT_TASKS, IntentPromptShape, intentTaskById, type IntentTask } from '../cases-intent/tasks.js';
import {
  probeIntentContext,
  readMcpToken,
  readRunConfig,
  RUN_CONFIG_PATH,
  type IntentEvalRunConfig,
} from '../cases-intent/setup.js';

/** Agent model for both arms; overridable for a cheap smoke (`--model`). */
const INTENT_MODEL = 'claude-sonnet-5';
/** Judge model, pinned separately from the arms (`--judge-model`). */
const INTENT_JUDGE_MODEL = 'claude-opus-5-5';
const ARM_TIMEOUT_MS = 12 * 60 * 1000;
const ARM_MAX_TURNS = 40;
const JUDGE_TIMEOUT_MS = 5 * 60 * 1000;

/** Canonical OSS distribution beside the coredoc checkout. */
export function defaultWorkflowsPluginDir(coredocRepoRoot: string): string {
  return resolve(coredocRepoRoot, '..', 'coredoc-workflows', 'plugins', 'coredoc-workflows');
}

/** The canonical methodology bytes, read from the distribution so the eval measures the shipped guidance. */
export function readIntentMethodology(workflowsPluginDir: string): string {
  const path = join(workflowsPluginDir, 'resources', 'methodology', 'intent-context.md');
  if (!existsSync(path)) {
    throw new Error(
      `intent-context methodology not found at ${path} — set COREDOC_WORKFLOWS_PLUGIN_DIR to the coredoc-workflows plugin directory.`,
    );
  }
  return readFileSync(path, 'utf8').trim();
}

export type IntentArmId = 'baseline' | 'intent';

export interface IntentArmSpec {
  id: IntentArmId;
  /** Whether the workspace MCP intent tools are attached and allowlisted, and the methodology inlined. */
  intent: boolean;
}

export const INTENT_ARMS: readonly IntentArmSpec[] = [
  { id: 'baseline', intent: false },
  { id: 'intent', intent: true },
];

const BASE_SYSTEM = `You are a senior engineer working in a single-repository TypeScript service, read-only:
you cannot modify files. Investigate the code as far as the task needs, then produce the artifact the
task asks for. Your FINAL message MUST be that artifact, in markdown, and nothing else. Cite concrete
file paths in backticks. You are running autonomously: do NOT ask questions — state assumptions inline.`;

const INTENT_SYSTEM_SUFFIX = `

This session also has the coredoc product-intent capability: the workspace MCP tools
mcp__coredoc-eval__get_intent_context and mcp__coredoc-eval__intent_read over the workspace's reviewed
product intent. The methodology for using it follows verbatim; treat it as operating instructions.`;

/** Header separating the operating instructions from the verbatim methodology. */
const METHODOLOGY_HEADER = '--- intent-context methodology ---';

export function systemPromptFor(arm: IntentArmSpec, methodology?: string): string {
  if (!arm.intent) return BASE_SYSTEM;
  if (!methodology || methodology.trim() === '') {
    throw new Error('The intent arm carries the intent-context methodology inline; no methodology text was supplied.');
  }
  return `${BASE_SYSTEM}${INTENT_SYSTEM_SUFFIX}\n\n${METHODOLOGY_HEADER}\n${methodology.trim()}`;
}

/**
 * The one arm difference in agent options. The control gets no MCP server at
 * all (`runAgent` then passes `{}` under strict MCP config), so it has nothing
 * to refuse; the intent arm gets the workspace server with only its two intent
 * tools allowlisted — the cloud server's graph tools reach neither arm.
 */
export function armMcpOptions(
  arm: IntentArmSpec,
  config: Pick<IntentEvalRunConfig, 'mcpUrl'>,
  mcpToken: string,
): { extraTools: string[]; mcpServerHttp?: { url: string; headers: Record<string, string> } } {
  if (!arm.intent) return { extraTools: [] };
  return {
    extraTools: [...INTENT_MCP_TOOLS],
    mcpServerHttp: { url: config.mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } },
  };
}

export interface IntentPreflight {
  config: IntentEvalRunConfig;
  mcpToken: string;
}

/**
 * Every precondition before the first paid call: setup ran, its checkout is
 * still on disk (it lives in a temp directory a reboot can clear), and the
 * workspace answers the agents' token with the seeded content.
 */
export async function preflightIntentEval(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = RUN_CONFIG_PATH,
): Promise<IntentPreflight> {
  const config = readRunConfig(configPath);
  if (!config) {
    throw new Error(`No run config at ${configPath} — run \`pnpm --dir evals run eval:intent:setup\` first.`);
  }
  if (!existsSync(config.checkoutRoot)) {
    throw new Error(
      `The fixture checkout recorded by setup is missing at ${config.checkoutRoot}. It is staged in a temp ` +
        'directory, so a reboot or a tmp cleaner removes it — re-run `pnpm --dir evals run eval:intent:setup`.',
    );
  }
  const mcpToken = readMcpToken(config, env);
  await probeIntentContext(config.serverUrl, config.workspaceId, mcpToken);
  return { config, mcpToken };
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
  /** True when the matrix is NARROWER than the gate corpus; such a run is reported, never a gate result. */
  partial: boolean;
}

/** Fail closed on filters that select nothing — a zero-job matrix must never read as a pass. */
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
      throw new Error(`Unknown --task "${flags.task}". Valid task ids: ${tasks.map((task) => task.id).join(', ')}`);
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
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0 },
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
  /** Non-gating evidence: the corpus traps are not all staged. */
  Diagnostic = 'diagnostic',
}

/** Why a run cannot gate, or null when it can. */
export function intentGateNonGatingReason(config: Pick<IntentEvalRunConfig, 'anchorsStaged'>): string | null {
  if (!config.anchorsStaged) {
    return (
      'Code anchors are not staged in the cloud workspace (it has no published graph), so the anchor-freshness ' +
      'facts of implement-service-fee and investigate-cent-shortfall cannot be met by either arm.'
    );
  }
  return null;
}

export interface IntentGateInput {
  nonGatingReason: string | null;
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
  softBudgetExceeded: boolean;
  ac12Failures: IntentJudgementRecord[];
  reasons: string[];
  /** Soft findings the gate tolerated; always printed. */
  reportedNotGating: string[];
  nonGatingReason: string | null;
}

/**
 * Soft-violating INTENT-arm sessions a passing run may contain (maintainer
 * decision 2026-08-28, see {@link IntentViolationSeverity}).
 */
export const SOFT_VIOLATION_SESSION_BUDGET = 1;

function isAc10Failure(record: IntentRunRecord): boolean {
  return (
    record.analysis.verdict === IntentAc10Verdict.Violation ||
    record.analysis.verdict === IntentAc10Verdict.NoAdoption ||
    record.analysis.verdict === IntentAc10Verdict.ContaminatedControl
  );
}

/**
 * The gate weight of one record, fail-closed: a failing record that carries no
 * classified finding is HARD, never spent out of the soft budget.
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
 * The gate verdict, fail-closed: a pass requires an executed, two-armed,
 * unfiltered, non-degraded matrix with no hard finding, soft findings within
 * budget and no intent-arm AC-12 failure.
 */
export function computeIntentGate(input: IntentGateInput): IntentGateResult {
  // `no-transcript` records are not AC-10 failures; they degrade the run instead.
  const ac10Failures = input.records.filter(isAc10Failure);
  const ac10HardFailures = input.records.filter((record) => intentRecordSeverity(record) === IntentViolationSeverity.Hard);
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
  const reportedNotGating = softBudgetExceeded
    ? []
    : ac10SoftSessions.map(
        (record) =>
          `AC-10 SOFT violation (reported, not gating — within the ${SOFT_VIOLATION_SESSION_BUDGET}-session ` +
          `budget): ${recordLabel(record)}: ${record.analysis.softViolations.join('; ')}`,
      );

  const common = { ac10Failures, ac10HardFailures, ac10SoftSessions, softBudgetExceeded, ac12Failures, reasons, reportedNotGating };
  if (input.nonGatingReason) {
    return { status: IntentGateStatus.Diagnostic, gatePassed: false, ...common, nonGatingReason: input.nonGatingReason };
  }
  if (input.partial) {
    return { status: IntentGateStatus.Partial, gatePassed: false, ...common, nonGatingReason: null };
  }
  const gatePassed = reasons.length === 0;
  return { status: gatePassed ? IntentGateStatus.Pass : IntentGateStatus.Fail, gatePassed, ...common, nonGatingReason: null };
}

export interface IntentReportInput {
  runId: string;
  config: Pick<IntentEvalRunConfig, 'serverUrl' | 'workspaceId' | 'seedRevision' | 'importCounts' | 'anchorsStaged'>;
  agentModel: string;
  judgeModel: string;
  invocation: {
    taskIds: readonly string[];
    armIds: readonly IntentArmId[];
    reps: number;
    smoke: boolean;
    partial: boolean;
  };
  records: readonly IntentRunRecord[];
  judgements: readonly IntentJudgementRecord[];
  aggregate: IntentJudgementAggregate;
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

/** Arm differences and limits the harness cannot enforce away. */
export const INTENT_CAVEATS: readonly string[] = [
  '**Arm isolation is partial.** The arms differ by the workspace MCP intent tools and the inlined methodology; ' +
    'host settings, user memory and account state reach both arms identically.',
  '**The control is given no MCP server at all.** It cannot attempt an intent call, so a zero-interaction control ' +
    'is clean. The intent arm gets the workspace server with only `get_intent_context` and `intent_read` ' +
    'allowlisted; the cloud graph tools are part of neither arm.',
  '**The methodology is always in context.** The intent arm receives the canonical `intent-context` methodology ' +
    'appended verbatim to its operating instructions, so the measured behavior is "agent with the methodology".',
  '**The control has no filesystem path to the seed.** Both arms run in a copy of the fixture repo in a temp ' +
    'directory outside this repository; the intent-file read tripwire still runs on both arms.',
  '**The seed loses code anchors and item relations on import.** A workspace document carries neither: anchors ' +
    'need a published graph and the cloud model relates tree nodes, not items.',
  '**Ids derived from earlier responses are exact-ID navigation (D9).** Only ids never routed and never returned ' +
    'by an earlier intent response count as unrouted.',
  '**Intent-file read detection is a lower bound.** It matches substrings of tool inputs; a zero count is not ' +
    'evidence of absence.',
  '**Cost is provider-reported.** Retried attempts are summed into their record and the judge cost is reported ' +
    'separately; token and latency numbers never gate.',
];

export function renderIntentReport(input: IntentReportInput): string {
  const lines: string[] = [];
  const armCost = input.records.reduce((sum, record) => sum + record.usage.costUsd, 0);
  const judgeCost = input.judgeUsage.costUsd;
  lines.push(`# Intent gate run ${input.runId}`, '', headline(input));
  if (input.gate.reasons.length > 0) {
    lines.push('');
    for (const reason of input.gate.reasons) lines.push(`- ${reason}`);
  }
  if (input.gate.reportedNotGating.length > 0) {
    lines.push('');
    for (const reported of input.gate.reportedNotGating) lines.push(`- ${reported}`);
  }
  lines.push('', '## Reproduction fingerprints', '', '| Field | Value |', '| --- | --- |');
  lines.push(`| server | \`${input.config.serverUrl}\` |`);
  lines.push(`| workspace | \`${input.config.workspaceId}\` |`);
  lines.push(`| seed revision | \`${input.config.seedRevision}\` |`);
  lines.push(`| import counts | ${JSON.stringify(input.config.importCounts)} |`);
  lines.push(`| code anchors staged | ${input.config.anchorsStaged ? 'yes' : 'no'} |`);
  lines.push(`| agent model (both arms) | \`${input.agentModel}\` |`);
  lines.push(`| judge model | \`${input.judgeModel}\` |`);
  lines.push(`| tasks in this run | ${input.invocation.taskIds.join(', ')} |`);
  lines.push(`| arms in this run | ${input.invocation.armIds.join(', ')} |`);
  lines.push(`| reps per task-arm | ${input.invocation.reps} |`);
  lines.push(`| smoke | ${input.invocation.smoke ? 'yes' : 'no'} |`);
  lines.push(`| full gate matrix | ${input.invocation.partial ? 'NO — filtered/smoke run' : 'yes'} |`);
  lines.push(`| provider-reported cost (arms) | $${armCost.toFixed(4)} |`);
  lines.push(`| provider-reported cost (judge) | $${judgeCost.toFixed(4)} |`);
  lines.push(`| provider-reported cost (run total) | $${(armCost + judgeCost).toFixed(4)} |`);
  lines.push(`| judge tokens | ${input.judgeUsage.totalTokens} |`);
  lines.push(`| degraded runs (counted, not dropped) | ${input.degradedRuns} |`);
  lines.push(`| wall clock | ${(input.wallClockMs / 1000).toFixed(0)}s |`);
  lines.push('');

  lines.push('## AC-10 — observed tool protocol (deterministic, no judge)', '');
  lines.push(
    '| task | shape | arm | rep | verdict | severity | answered calls | refused calls | broad lookups | index calls | ids fetched | ids derived | ids unrouted | intent file reads | attempts |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const record of input.records) {
    const a = record.analysis;
    lines.push(
      `| ${record.taskId} | ${record.shape} | ${record.arm} | ${record.rep} | ${a.verdict} | ` +
        `${intentRecordSeverity(record) ?? '—'} | ${a.interactions} | ${a.deniedInteractions} | ${a.broadLookups} | ` +
        `${a.indexCalls} | ${a.fetchedIds.join(', ') || '—'} | ${a.derivedIds.join(', ') || '—'} | ` +
        `${a.unroutedIds.join(', ') || '—'} | ${a.overlayFileReads} | ${record.attempts} |`,
    );
  }
  const withReasons = input.records.filter((record) => record.analysis.reasons.length > 0);
  if (withReasons.length > 0) {
    lines.push('');
    for (const record of withReasons) lines.push(`- \`${recordLabel(record)}\`: ${record.analysis.reasons.join('; ')}`);
  }
  lines.push('');
  lines.push(`- hard violations (zero tolerance): ${input.gate.ac10HardFailures.length}`);
  lines.push(
    `- soft-violating intent sessions: ${input.gate.ac10SoftSessions.length}/${SOFT_VIOLATION_SESSION_BUDGET} allowed` +
      `${input.gate.softBudgetExceeded ? ' (OVER BUDGET — gating)' : ''}`,
  );
  const failed = input.records.filter((record) => record.error);
  if (failed.length > 0) {
    lines.push('', 'Degraded sessions (counted in every denominator):');
    for (const record of failed) lines.push(`- \`${recordLabel(record)}\`: ${record.error}`);
  }
  lines.push('');

  lines.push('## AC-12 — blind per-artifact fact scoring', '');
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
  if (input.aggregate.missingBaselinePopulation) {
    lines.push('- **no scored live control artifact** — the arm comparison has no anchor, so the run is degraded');
  }
  lines.push(`- degrade threshold: ${INTENT_DEGRADE_THRESHOLD}`, '');

  lines.push('### Judge sensitivity — seeded controls (outside every population)', '');
  lines.push('| task | status | forbidden tripped | expected trap tripped |', '| --- | --- | --- | --- |');
  const seededJudgements = input.judgements.filter((judgement) => judgement.arm === SEEDED_CONTROL_ARM);
  for (const judgement of seededJudgements) {
    const expected = (intentTaskById(judgement.taskId)?.forbiddenFacts ?? [])
      .filter((fact) => fact.baselineExpected)
      .map((fact) => fact.id);
    const tripped = judgement.forbiddenFacts.filter((fact) => fact.verdict === 'tripped').map((fact) => fact.id);
    const hitTrap = tripped.some((id) => expected.length === 0 || expected.includes(id));
    lines.push(`| ${judgement.taskId} | ${judgement.status} | ${tripped.join(', ') || '—'} | ${hitTrap ? 'yes' : 'NO'} |`);
  }
  if (seededJudgements.length === 0) lines.push('| — | none judged | — | NO |');
  lines.push('');
  lines.push(
    `- seeded controls: ${input.aggregate.seededControls.tripped}/${input.aggregate.seededControls.judged} tripped ` +
      `their expected prohibition (${input.aggregate.seededControls.invalid} invalid)`,
  );
  lines.push(`- judge-insensitive: ${input.aggregate.judgeInsensitive ? 'YES — the judge showed no teeth' : 'no'}`, '');

  lines.push('## Token and latency diagnostics (NOT a gate)', '');
  lines.push('| task | arm | rep | total tokens | cost usd | latency s | artifact chars | attempts |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const record of input.records) {
    lines.push(
      `| ${record.taskId} | ${record.arm} | ${record.rep} | ${record.usage.totalTokens} | ` +
        `${record.usage.costUsd.toFixed(4)} | ${(record.latencyMs / 1000).toFixed(0)} | ${record.artifactChars} | ` +
        `${record.attempts} |`,
    );
  }
  lines.push('', '## Caveats', '');
  for (const caveat of INTENT_CAVEATS) lines.push(`- ${caveat}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function sumUsage(usages: readonly Usage[]): Usage {
  return usages.reduce<Usage>(
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
}

async function runPool<T>(jobs: readonly T[], concurrency: number, run: (job: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) await run(jobs[next++]!);
    }),
  );
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
    },
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const evalsRoot = resolve(here, '..');
  const repoRoot = resolve(evalsRoot, '..');

  const { config, mcpToken } = await preflightIntentEval();
  const methodology = readIntentMethodology(
    process.env.COREDOC_WORKFLOWS_PLUGIN_DIR ?? defaultWorkflowsPluginDir(repoRoot),
  );

  const invocation = resolveIntentInvocation(values);
  const { tasks, arms, reps } = invocation;
  const concurrency = parsePositiveIntegerFlag(values.concurrency, '--concurrency', 2);
  const agentModel = values.model ?? INTENT_MODEL;
  const judgeModel = values['judge-model'] ?? INTENT_JUDGE_MODEL;
  const nonGatingReason = intentGateNonGatingReason(config);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(evalsRoot, 'runs-intent', runId);
  mkdirSync(runDir, { recursive: true });
  const startedAt = Date.now();

  console.log(
    `Intent gate: ${tasks.length} tasks × ${arms.length} arms × ${reps} reps = ${tasks.length * arms.length * reps} ` +
      `sessions (workspace=${config.workspaceId} on ${config.serverUrl}, concurrency=${concurrency}, model=${agentModel})`,
  );
  if (invocation.partial) console.warn('PARTIAL RUN: the matrix is narrower than the gate corpus; reported, never a gate.');
  if (nonGatingReason) console.warn(`DIAGNOSTIC RUN: ${nonGatingReason}`);

  type Job = { task: IntentTask; arm: IntentArmSpec; rep: number };
  const jobs: Job[] = [];
  for (const task of tasks) for (const arm of arms) for (let rep = 0; rep < reps; rep++) jobs.push({ task, arm, rep });

  const records: IntentRunRecord[] = [];
  async function runJob({ task, arm, rep }: Job): Promise<void> {
    const artifactDir = join(runDir, task.id, arm.id, `rep-${rep}`);
    mkdirSync(artifactDir, { recursive: true });
    const transcriptPath = join(artifactDir, 'transcript.json');
    // withRetry returns the LAST attempt; earlier attempts' cost is captured here.
    const attemptUsages: Usage[] = [];
    const result = await withRetry(
      `artifact ${task.id}/${arm.id}`,
      async () => {
        const attempt = await runAgent({
          prompt: task.prompt,
          systemPrompt: systemPromptFor(arm, methodology),
          model: agentModel,
          cwd: config.checkoutRoot,
          // `withoutMcp` keeps the local graph tool names out of the allowlist;
          // the intent arm's server and tools come from armMcpOptions.
          arm: 'withoutMcp',
          baseTools: ['Read', 'Grep', 'Glob'],
          ...armMcpOptions(arm, config, mcpToken),
          maxTurns: ARM_MAX_TURNS,
          timeoutMs: ARM_TIMEOUT_MS,
          transcriptPath,
        });
        attemptUsages.push(attempt.usage);
        return attempt;
      },
      (r) => (isTransientError(r.error) ? r.error : null),
    );
    const usage = sumUsage(attemptUsages);
    const artifactPath = join(artifactDir, 'artifact.md');
    writeFileSync(artifactPath, result.responseText);
    writeFileSync(join(artifactDir, 'usage.json'), JSON.stringify({ usage, attempts: attemptUsages.length, attemptUsages }, null, 2));
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
      `[artifact] ${task.id}/${arm.id}/rep-${rep} → chars=${result.responseText.length} ac10=${analysis.verdict} ` +
        `intentCalls=${analysis.interactions} tokens=${usage.totalTokens}${result.error ? ` ERROR=${result.error}` : ''}`,
    );
  }

  await runPool(jobs, concurrency, (job) =>
    runJob(job).catch((error) => {
      console.error(`[artifact-error] ${job.task.id}/${job.arm.id}/rep-${job.rep}`, error);
      records.push(degradedRecordForFailedJob(job.task, job.arm, job.rep, error));
    }),
  );
  writeFileSync(join(runDir, 'records.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

  // One blind fact-scoring call per artifact, plus one seeded sensitivity
  // control per task, sharing the pool and the cost rollup.
  const judgements: IntentJudgementRecord[] = [];
  const judgeUsage: Usage[] = [];
  type JudgeJob = { seeded: false; record: IntentRunRecord } | { seeded: true; task: IntentTask };
  const judgeJobs: JudgeJob[] = [
    ...records.filter((record) => !record.error && record.artifactChars > 0).map((record) => ({ seeded: false as const, record })),
    ...tasks.map((task) => ({ seeded: true as const, task })),
  ];

  await runPool(judgeJobs, concurrency, async (job) => {
    if (job.seeded) {
      const { task } = job;
      const dir = join(runDir, 'seeded-controls', task.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'artifact.md'), synthesizeSeededControlArtifact(task));
      const call = createSdkJudgeCall({
        cwd: config.checkoutRoot,
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
      // An ungraded seeded control leaves no evidence the judge has teeth: invalid, and the run degrades.
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
      return;
    }
    const { record } = job;
    const task = tasks.find((candidate) => candidate.id === record.taskId)!;
    const call = createSdkJudgeCall({
      cwd: config.checkoutRoot,
      model: judgeModel,
      timeoutMs: JUDGE_TIMEOUT_MS,
      transcriptPath: join(dirname(record.artifactPath), 'judge-transcript.json'),
    });
    const result = await withRetry(
      `judge ${recordLabel(record)}`,
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
      console.error('[judge-error]', recordLabel(record), error);
      return null;
    });
    judgeUsage.push(call.usage);
    // A control intent reached is scored and reported but cannot anchor the comparison.
    const contaminated = record.analysis.verdict === IntentAc10Verdict.ContaminatedControl;
    judgements.push({
      taskId: record.taskId,
      arm: record.arm,
      rep: record.rep,
      status: result?.status ?? IntentJudgeStatus.Invalid,
      passed: result?.passed ?? false,
      requiredFacts: result?.requiredFacts ?? [],
      forbiddenFacts: result?.forbiddenFacts ?? [],
      ...(contaminated ? { excluded: true, exclusionReason: 'contaminated control: intent reached the no-context arm' } : {}),
    });
    console.log(`[judge] ${recordLabel(record)} → ${result?.status ?? 'invalid'} passed=${result?.passed ?? false}`);
  });
  writeFileSync(join(runDir, 'judgements.jsonl'), `${judgements.map((j) => JSON.stringify(j)).join('\n')}\n`);

  const aggregate = aggregateIntentJudgements(judgements, {
    baselineExpectedFacts: (taskId) =>
      (intentTaskById(taskId)?.forbiddenFacts ?? []).filter((fact) => fact.baselineExpected).map((fact) => fact.id),
    expectBaselinePopulation: !invocation.partial,
  });
  const degradedRuns = records.filter((record) => record.error || record.artifactChars === 0).length;
  const armErrorRate = records.length > 0 ? degradedRuns / records.length : 0;
  const degraded = aggregate.degraded || armErrorRate > INTENT_DEGRADE_THRESHOLD;
  const gate = computeIntentGate({ nonGatingReason, partial: invocation.partial, degraded, records, judgements });

  const reportPath = join(runDir, 'REPORT.md');
  writeFileSync(
    reportPath,
    renderIntentReport({
      runId,
      config,
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
      judgeUsage: sumUsage(judgeUsage),
      degradedRuns,
      wallClockMs: Date.now() - startedAt,
      gate,
    }),
  );
  console.log(`\nReport: ${reportPath}`);

  if (degraded) {
    console.error(
      `\nDEGRADED RUN — verdicts are NOT trustworthy. arm errors: ${degradedRuns}/${records.length}, ` +
        `invalid judge verdicts: ${aggregate.invalidCount}/${aggregate.total}, ` +
        `judge-insensitive: ${aggregate.judgeInsensitive ? 'yes' : 'no'}. Fix the cause and re-run.`,
    );
    process.exitCode = 1;
  }
  if (gate.status === IntentGateStatus.Diagnostic || gate.status === IntentGateStatus.Partial) {
    console.log(`\n${gate.status.toUpperCase()} RUN — not a gate result.${gate.reasons.length > 0 ? `\n   observations: ${gate.reasons.join('; ')}` : ''}`);
    if (gate.ac10Failures.length > 0 || gate.ac12Failures.length > 0) process.exitCode = 1;
    return;
  }
  if (!gate.gatePassed) {
    console.error(`\nGATE FAILED\n   ${gate.reasons.join('\n   ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nGATE PASSED');
  for (const reported of gate.reportedNotGating) console.log(`   ${reported}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
