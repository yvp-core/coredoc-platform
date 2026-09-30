import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  AccessMode,
  AgentProvider,
  GraphBackend,
  JudgeMode,
  TreatmentAdherence,
  type RunRecord,
  type RunnableLifecycle,
} from './types.js';
import { normalizeRunRecord, normalizeRunRecords, type NormalizedRunRecord } from './run-record.js';
import { armFactorsFor } from './arms.js';
import { sha256, type RunManifest } from './provenance.js';
import {
  createPermissionCanaryConfig,
  isPermissionCanaryEvidenceAdmissible,
} from './permission-canary.js';
import { compareCodeUnits } from './deterministic-order.js';
import { isRegisteredPrimaryVerifier } from './primary-registry.js';

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Kept for historical analysis callers; paired reports render honest min/max instead. */
export function spread(xs: number[]): number {
  return xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
}

export function appendRunRecord(jsonlPath: string, record: RunRecord): void {
  mkdirSync(dirname(jsonlPath), { recursive: true });
  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
}

/** Compatibility name: completion now comes only from explicit/normalized status. */
export function isDnf(record: RunRecord): boolean {
  return normalizeRunRecord(record).agentStatus !== 'completed';
}

export type ReportEndpoint = 'programmatic' | 'judge';
export type ReportLifecycle = RunnableLifecycle | 'legacy';

export interface ArmComparison {
  id: 'product-bundle' | 'mcp-tool' | 'product-guide';
  label: string;
  numerator: 'withMcp' | 'mcpOnly';
  denominator: 'mcpOnly' | 'withoutMcp';
}

export const PRODUCT_BUNDLE_COMPARISON: ArmComparison = {
  id: 'product-bundle',
  label: 'Product bundle: withMcp (MCP + guide) − withoutMcp (no MCP, no guide)',
  numerator: 'withMcp',
  denominator: 'withoutMcp',
};

export const MCP_TOOL_COMPARISON: ArmComparison = {
  id: 'mcp-tool',
  label: 'Diagnostic tool effect: mcpOnly (MCP, no guide) − withoutMcp (no MCP, no guide)',
  numerator: 'mcpOnly',
  denominator: 'withoutMcp',
};

export const PRODUCT_GUIDE_COMPARISON: ArmComparison = {
  id: 'product-guide',
  label: 'Diagnostic guide increment: withMcp (MCP + guide) − mcpOnly (MCP, no guide)',
  numerator: 'withMcp',
  denominator: 'mcpOnly',
};

export interface PairedDelta {
  target: string;
  case: string;
  pairedRuns: number;
  missingRuns: number;
  numeratorMean: number;
  denominatorMean: number;
  medianRunDelta: number;
  /** Mean eligible paired-run delta for this one target × case cell. */
  delta: number;
}

export interface PairedStats {
  deltas: PairedDelta[];
  comparable: number;
  missing: number;
  mean: number | null;
  median: number | null;
  wins: number;
  ties: number;
  losses: number;
  range: [number, number] | null;
}

/**
 * `perProtocol` and `completedOnly` are the headline estimands: both DROP runs
 * whose assigned treatment was never taken (the agent answered without calling
 * the required MCP tools), exactly as they drop infrastructure_error. Dropping
 * noncompliant runs is what makes them per-protocol, not intention-to-treat —
 * they answer "what does the tooling do when it is actually used".
 *
 * `intentionToTreat` is the true ITT: every ASSIGNED run counts, noncompliant
 * ones scored on the answer they really produced. It is reported as the
 * descriptive companion, because compliance is the dose this eval is trying to
 * measure the effect of, not a nuisance.
 *
 * All three assign 0 to task_failed and leave infrastructure_error missing.
 */
export type PairedEstimand = 'perProtocol' | 'completedOnly' | 'intentionToTreat';

export interface PairedSummary {
  endpoint: ReportEndpoint;
  lifecycle: ReportLifecycle;
  comparison: ArmComparison;
  /** Headline: noncompliant treatment runs excluded (per-protocol, NOT ITT). */
  perProtocol: PairedStats;
  completedOnly: PairedStats;
  /** True ITT — every assigned run, noncompliant included. Descriptive companion. */
  intentionToTreat: PairedStats;
  /** `target/case` cells holding at least one noncompliant treatment run. */
  noncompliantCells: string[];
}

function pairValue(
  record: NormalizedRunRecord,
  endpoint: ReportEndpoint,
  estimand: PairedEstimand,
): number | null {
  if (record.agentStatus === 'infrastructure_error') return null;
  if (record.agentStatus === 'task_failed') return estimand === 'completedOnly' ? null : 0;
  if (
    record.treatmentAdherence === TreatmentAdherence.Noncompliant &&
    estimand !== 'intentionToTreat'
  ) {
    return null;
  }
  if (endpoint === 'programmatic') return record.programmatic?.score ?? null;
  if (record.judgeStatus !== 'completed') return null;
  return record.judge.score;
}

function assertCurrentArmFactors(records: readonly NormalizedRunRecord[]): void {
  for (const record of records) {
    if (record.lifecycle === 'legacy') continue;
    const expected = armFactorsFor(record.arm);
    if (
      !record.armFactors ||
      record.armFactors.mcp !== expected.mcp ||
      record.armFactors.productGuide !== expected.productGuide
    ) {
      throw new Error(
        `${record.target}/${record.case}/${record.arm}/run-${record.runIndex} has absent or inconsistent armFactors.`,
      );
    }
  }
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

type ArmPair = Partial<Record<'withMcp' | 'mcpOnly' | 'withoutMcp', NormalizedRunRecord>>;

function summarizePairs(
  cells: Map<string, Map<number, ArmPair>>,
  endpoint: ReportEndpoint,
  estimand: PairedEstimand,
  comparison: ArmComparison,
): PairedStats {
  const deltas: PairedDelta[] = [];
  let missing = 0;
  for (const [key, runs] of [...cells.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const runDeltas: number[] = [];
    const numeratorValues: number[] = [];
    const denominatorValues: number[] = [];
    let missingRuns = 0;
    for (const pair of [...runs.values()]) {
      const numeratorRecord = pair[comparison.numerator];
      const denominatorRecord = pair[comparison.denominator];
      const numerator = numeratorRecord ? pairValue(numeratorRecord, endpoint, estimand) : null;
      const denominator = denominatorRecord ? pairValue(denominatorRecord, endpoint, estimand) : null;
      if (numerator === null || denominator === null) {
        missingRuns += 1;
        continue;
      }
      numeratorValues.push(numerator);
      denominatorValues.push(denominator);
      runDeltas.push(numerator - denominator);
    }
    if (runDeltas.length === 0) {
      missing += 1;
      continue;
    }
    const [target = '', caseId = ''] = key.split('|');
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    deltas.push({
      target,
      case: caseId,
      pairedRuns: runDeltas.length,
      missingRuns,
      numeratorMean: mean(numeratorValues),
      denominatorMean: mean(denominatorValues),
      medianRunDelta: median(runDeltas),
      delta: mean(runDeltas),
    });
  }
  const values = deltas.map((item) => item.delta);
  return {
    deltas,
    comparable: deltas.length,
    missing,
    mean: values.length === 0
      ? null
      : rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: values.length === 0 ? null : rounded(median(values)),
    wins: values.filter((value) => value > 0).length,
    ties: values.filter((value) => value === 0).length,
    losses: values.filter((value) => value < 0).length,
    range: values.length === 0 ? null : [Math.min(...values), Math.max(...values)],
  };
}

export function buildPairedSummary(
  records: readonly RunRecord[],
  endpoint: ReportEndpoint,
  lifecycle: ReportLifecycle = 'primary',
  comparison: ArmComparison = PRODUCT_BUNDLE_COMPARISON,
): PairedSummary {
  const normalized = normalizeRunRecords(records);
  assertCurrentArmFactors(normalized);
  const cohorts = new Set(
    normalized
      .filter((record) => record.lifecycle === lifecycle)
      .map((record) => record.cohortId ?? '<legacy-unknown>'),
  );
  if (cohorts.size > 1) {
    throw new Error(
      `Cannot aggregate ${lifecycle} records across multiple cohort IDs: ${[...cohorts].join(', ')}.`,
    );
  }
  const cells = new Map<string, Map<number, ArmPair>>();
  for (const record of normalized) {
    if (record.lifecycle !== lifecycle) continue;
    const cellKey = `${record.target}|${record.case}`;
    const runs = cells.get(cellKey) ?? new Map<number, ArmPair>();
    const pair = runs.get(record.runIndex) ?? {};
    if (pair[record.arm]) {
      throw new Error(
        `Duplicate paired record for ${cellKey}|${record.runIndex}/${record.arm}.`,
      );
    }
    pair[record.arm] = record;
    runs.set(record.runIndex, pair);
    cells.set(cellKey, runs);
  }
  const noncompliantCells = new Set<string>();
  for (const [cellKey, runs] of cells) {
    for (const pair of runs.values()) {
      for (const arm of [comparison.numerator, comparison.denominator] as const) {
        if (pair[arm]?.treatmentAdherence === TreatmentAdherence.Noncompliant) {
          noncompliantCells.add(cellKey.replace('|', '/'));
        }
      }
    }
  }
  return {
    endpoint,
    lifecycle,
    comparison,
    perProtocol: summarizePairs(cells, endpoint, 'perProtocol', comparison),
    completedOnly: summarizePairs(cells, endpoint, 'completedOnly', comparison),
    intentionToTreat: summarizePairs(cells, endpoint, 'intentionToTreat', comparison),
    noncompliantCells: [...noncompliantCells].sort(compareCodeUnits),
  };
}

export interface OperabilitySummary {
  lifecycle: ReportLifecycle;
  arm: RunRecord['arm'];
  runs: number;
  completed: number;
  taskFailed: number;
  infrastructureError: number;
  judgeMissing: number;
  compliant: number;
  noncompliant: number;
  adherenceNotApplicable: number;
  /** Agent + judge, unchanged for continuity with historical reports. */
  totalTokens: number;
  /**
   * Agent-only decomposition. `uncachedInputTokens` is `Usage.inputTokens`
   * verbatim: the Claude runner records the API's `input_tokens` (already
   * exclusive of cache reads/creation) and the codex runner subtracts
   * `cached_input_tokens` from codex's inclusive `input_tokens` before storing
   * it. Both therefore mean the same thing here.
   */
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  mcpToolCalls: number;
  baseToolCalls: number;
  /** Treatment dose per run: mean MCP tool calls across the group's runs. */
  meanMcpDose: number;
  /** Every record in the group came from codex, which reports no cache creation. */
  allCodex: boolean;
  medianLatencyMs: number;
  reportedCostUsd: number;
}

/** Namespace prefix the Claude SDK and the codex runner both use for MCP tools. */
const MCP_TOOL_PREFIX = 'mcp__';

function sumUsage(
  group: readonly NormalizedRunRecord[],
  field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens',
): number {
  return group.reduce((sum, record) => sum + (record.agent.usage?.[field] ?? 0), 0);
}

function countToolCalls(group: readonly NormalizedRunRecord[], mcp: boolean): number {
  return group.reduce(
    (sum, record) =>
      sum +
      (record.agent.toolCalls ?? [])
        .filter(({ name }) => name.startsWith(MCP_TOOL_PREFIX) === mcp)
        .reduce((calls, { count }) => calls + count, 0),
    0,
  );
}

function meanDose(group: readonly NormalizedRunRecord[]): number {
  if (group.length === 0) return 0;
  return group.reduce((sum, record) => sum + record.mcpDose, 0) / group.length;
}

/**
 * Mean MCP calls per run strictly below this flags an MCP-treated cell as
 * low-dose. Two is the smallest dose that can represent a lookup plus a
 * follow-up, so cells under it are worth a human look — a 2026-08-29 matrix
 * cell averaging 1.0 ran its usual search-and-read volume and tracked its
 * baseline. This is a SCREENING HEURISTIC, not a validity verdict: dose counts
 * calls, not content, and a mean hides mixtures, so one high-quality explain
 * call can still be a full treatment. Flagged cells stay in every estimand.
 */
export const LOW_DOSE_MCP_FLOOR = 2;

export interface LowDoseMcpCell {
  lifecycle: ReportLifecycle;
  target: string;
  case: string;
  arm: RunRecord['arm'];
  meanDose: number;
  completedRuns: number;
  /** Per-run doses, so the reader sees the mixture the mean hides. */
  doses: number[];
}

/**
 * MCP-treated cells whose completed runs average less than the dose floor.
 * Treatment membership comes from `armFactors.mcp`, so the factor stays the
 * source of truth instead of a second hand-listed set of arm names.
 */
export function findLowDoseMcpCells(records: readonly RunRecord[]): LowDoseMcpCell[] {
  const cells = new Map<string, NormalizedRunRecord[]>();
  for (const record of normalizeRunRecords(records)) {
    if (record.armFactors?.mcp !== true) continue;
    if (record.agentStatus !== 'completed') continue;
    const key = `${record.lifecycle}|${record.target}|${record.case}|${record.arm}`;
    const group = cells.get(key) ?? [];
    group.push(record);
    cells.set(key, group);
  }
  return [...cells.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([, group]) => ({
      lifecycle: group[0]!.lifecycle,
      target: group[0]!.target,
      case: group[0]!.case as string,
      arm: group[0]!.arm,
      meanDose: meanDose(group),
      completedRuns: group.length,
      doses: [...group].sort((a, b) => a.runIndex - b.runIndex).map((record) => record.mcpDose),
    }))
    .filter((cell) => cell.meanDose < LOW_DOSE_MCP_FLOOR);
}

export function summarizeOperability(records: readonly RunRecord[]): OperabilitySummary[] {
  const groups = new Map<string, NormalizedRunRecord[]>();
  for (const record of normalizeRunRecords(records)) {
    const key = `${record.lifecycle}|${record.arm}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      lifecycle: group[0]!.lifecycle,
      arm: group[0]!.arm,
      runs: group.length,
      completed: group.filter((record) => record.agentStatus === 'completed').length,
      taskFailed: group.filter((record) => record.agentStatus === 'task_failed').length,
      infrastructureError: group.filter((record) => record.agentStatus === 'infrastructure_error').length,
      judgeMissing: group.filter(
        (record) => record.agentStatus === 'completed' && record.judgeStatus === 'missing',
      ).length,
      compliant: group.filter(
        (record) => record.treatmentAdherence === TreatmentAdherence.Compliant,
      ).length,
      noncompliant: group.filter(
        (record) => record.treatmentAdherence === TreatmentAdherence.Noncompliant,
      ).length,
      adherenceNotApplicable: group.filter(
        (record) => record.treatmentAdherence === TreatmentAdherence.NotApplicable,
      ).length,
      uncachedInputTokens: sumUsage(group, 'inputTokens'),
      outputTokens: sumUsage(group, 'outputTokens'),
      cacheReadTokens: sumUsage(group, 'cacheReadTokens'),
      cacheCreationTokens: sumUsage(group, 'cacheCreationTokens'),
      mcpToolCalls: countToolCalls(group, true),
      baseToolCalls: countToolCalls(group, false),
      meanMcpDose: meanDose(group),
      allCodex: group.every((record) => record.provider === AgentProvider.Codex),
      totalTokens: group.reduce(
        (sum, record) =>
          sum + (record.agent.usage?.totalTokens ?? 0) + (record.judge.usage?.totalTokens ?? 0),
        0,
      ),
      medianLatencyMs: median(group.map((record) => record.agent.latencyMs ?? 0)),
      reportedCostUsd: group.reduce(
        (sum, record) => sum + (record.agent.usage?.costUsd ?? 0) + (record.judge.usage?.costUsd ?? 0),
        0,
      ),
    }))
    .sort(
      (a, b) =>
        compareCodeUnits(a.lifecycle, b.lifecycle) || compareCodeUnits(a.arm, b.arm),
    );
}

export interface ReportMeta {
  runId: string;
  wallClockMs: number;
  agentModel: string;
  judgeModel: string;
  judgeMode?: JudgeMode;
  oracleJudgeUsage?: { calls: number; totalTokens: number; costUsd: number };
  commit: string;
  provider?: AgentProvider;
  backend?: GraphBackend;
  accessMode?: AccessMode;
  actualTargetSha?: string;
  graphParsedSha?: string;
  /** Whether the MCP server exposed includeSource/source bodies this run. */
  sourceInGraph?: boolean;
  cohortId?: string;
}

export interface WriteReportOpts {
  reportPath: string;
  records: RunRecord[];
  meta: ReportMeta;
  runManifest?: RunManifest | null;
  /** Diagnostic-only output; product-effect admission and comparisons are suppressed. */
  invalidatedReason?: string;
}

function score(value: number | null | undefined): string {
  return value === null || value === undefined ? 'missing' : value.toFixed(1);
}

function signed(value: number | null): string {
  if (value === null) return 'missing';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function percentChange(numerator: number, denominator: number): string {
  if (denominator === 0) return 'unavailable';
  const value = ((numerator - denominator) / denominator) * 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function renderStats(lines: string[], label: string, stats: PairedStats): void {
  lines.push(
    `| ${label} | ${stats.comparable} | ${stats.missing} | ${signed(stats.mean)} | ${signed(stats.median)} | ${stats.wins}-${stats.ties}-${stats.losses} | ${stats.range ? `[${stats.range[0]}, ${stats.range[1]}]` : 'missing'} |`,
  );
}

function renderPairedSummary(
  lines: string[],
  summary: PairedSummary,
  judgeLabel = 'rubric judge (ungrounded)',
): void {
  const endpointLabel = summary.endpoint === 'judge'
    ? judgeLabel
    : summary.endpoint;
  lines.push(`### ${summary.comparison.label} — ${endpointLabel}`, '');
  lines.push('| Estimand | Comparable cells | Missing cells | Macro mean Δ | Macro median Δ | W-T-L | [min, max] |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  renderStats(lines, 'PP (noncompliant excluded, task_failed = 0)', summary.perProtocol);
  renderStats(lines, 'Completed-only', summary.completedOnly);
  if (summary.noncompliantCells.length > 0) {
    renderStats(
      lines,
      'Descriptive: ITT (all assigned, noncompliant included)',
      summary.intentionToTreat,
    );
  }
  lines.push('');
  if (summary.noncompliantCells.length > 0) {
    lines.push(
      `Noncompliant treatment (agent answered without calling the required MCP tools) in: ${summary.noncompliantCells.join(', ')}. Those runs are excluded from the two headline rows — which is what makes those rows per-protocol rather than intention-to-treat — and are included only in the descriptive ITT row.`,
      '',
    );
  }
  if (summary.perProtocol.deltas.length === 0) return;
  lines.push('| Target | Case | Paired runs | Missing runs | Numerator mean | Denominator mean | Cell mean Δ | Within-cell median Δ |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const delta of summary.perProtocol.deltas) {
    lines.push(
      `| ${delta.target} | ${delta.case} | ${delta.pairedRuns} | ${delta.missingRuns} | ${score(delta.numeratorMean)} | ${score(delta.denominatorMean)} | ${signed(delta.delta)} | ${signed(delta.medianRunDelta)} |`,
    );
  }
  lines.push('');
}

function countRate(value: number, total: number): string {
  return `${value}/${total} (${total === 0 ? '0.0' : ((value / total) * 100).toFixed(1)}%)`;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  );
}

function assertPrimaryReportAdmission(
  opts: WriteReportOpts,
  records: readonly NormalizedRunRecord[],
): void {
  const primary = records.filter((record) => record.lifecycle === 'primary');
  if (primary.length === 0) return;
  const reject = (detail: string): never => {
    throw new Error(
      `Primary product-effect reporting requires passed permission canary evidence from the same historyless Claude run; explicit primary records are not admitted (${detail}).`,
    );
  };
  const manifest = opts.runManifest;
  if (!manifest) return reject('run manifest missing');
  if (
    manifest.models.provider !== AgentProvider.Claude ||
    (opts.meta.provider !== undefined && opts.meta.provider !== AgentProvider.Claude) ||
    primary.some((record) => record.provider !== AgentProvider.Claude)
  ) {
    reject('provider is not Claude');
  }
  if (
    opts.meta.accessMode !== AccessMode.HistorylessSnapshot ||
    primary.some((record) => record.accessMode !== AccessMode.HistorylessSnapshot)
  ) {
    reject('repository access is not historyless-snapshot');
  }
  const config = manifest.permissionCanary?.config;
  const evidence = manifest.permissionCanary?.evidence;
  if (!config || !evidence) return reject('canary config/evidence missing');
  const rebound = createPermissionCanaryConfig({
    harnessHead: manifest.harness.head,
    harnessDirtyFingerprint: manifest.harness.dirtyFingerprint,
    mcpSchemaHash: manifest.mcp.mcpSchemaHash,
    mcpBuildHash: manifest.mcp.mcpBuildHash,
    sdkRuntimeHash: config.sdkRuntimeHash,
    model: manifest.models.agentModel,
  });
  if (
    rebound.materialFingerprint !== config.materialFingerprint ||
    !isPermissionCanaryEvidenceAdmissible(config, evidence)
  ) {
    reject('canary evidence is failed, stale, or malformed');
  }
  const reportRoot = realpathSync(dirname(opts.reportPath));
  const transcriptPath = resolve(reportRoot, evidence.transcriptRelativePath);
  if (
    !isWithin(reportRoot, transcriptPath) ||
    !existsSync(transcriptPath) ||
    lstatSync(transcriptPath).isSymbolicLink() ||
    !lstatSync(transcriptPath).isFile() ||
    !isWithin(reportRoot, realpathSync(transcriptPath)) ||
    sha256(readFileSync(transcriptPath)) !== evidence.transcriptHash
  ) {
    reject('canary transcript is missing, escaped, or does not match its hash');
  }
  for (const record of primary) {
    const cell = manifest.cells.find(
      (candidate) => candidate.target === record.target && candidate.case === record.case,
    );
    if (
      !cell ||
      cell.lifecycle !== 'primary' ||
      cell.case !== 'feature-implementation-plan' ||
      !cell.primaryVerifierId ||
      !isRegisteredPrimaryVerifier(cell.primaryVerifierId)
    ) {
      reject(`unregistered primary record ${record.target}/${record.case}`);
    }
    if (record.cohortId !== manifest.cohortId) reject('record cohort does not match manifest');
  }
  if (opts.meta.cohortId !== manifest.cohortId) reject('report cohort does not match manifest');
}

export function writeReport(opts: WriteReportOpts): void {
  const records = normalizeRunRecords(opts.records);
  const manifestInvalidation = opts.runManifest?.graphChangedDuringRun
    ? `Graph backend changed during the eval: ${opts.runManifest.graph.fingerprint} -> ${opts.runManifest.graphFingerprintAfter ?? 'unknown'}.`
    : null;
  const invalidatedReason = opts.invalidatedReason?.trim() || manifestInvalidation;
  if (invalidatedReason === null) {
    assertPrimaryReportAdmission(opts, records);
    assertCurrentArmFactors(records);
    const waveCohorts = new Set(
      records
        .filter((record) => record.lifecycle !== 'legacy')
        .map((record) => record.cohortId ?? '<unknown-current-cohort>'),
    );
    if (waveCohorts.size > 1) {
      throw new Error(
        `Cannot write one report across multiple cohort IDs: ${[...waveCohorts].join(', ')}.`,
      );
    }
  }
  const provider = opts.meta.provider ?? records[0]?.provider ?? AgentProvider.Claude;
  const backend = opts.meta.backend ?? records[0]?.backend ?? GraphBackend.Ladybug;
  const accessMode = opts.meta.accessMode ?? records[0]?.accessMode ?? AccessMode.Worktree;
  const judgeMode =
    opts.meta.judgeMode ??
    opts.runManifest?.models?.judgeMode ??
    JudgeMode.LegacyUngrounded;
  const judgeLabel = judgeMode === JudgeMode.OracleBatch
    ? 'oracle grader (prebuilt truth, blind batch)'
    : 'rubric judge (ungrounded)';
  const judgeTitle = judgeMode === JudgeMode.OracleBatch
    ? 'Oracle grader (prebuilt truth, blind batch)'
    : 'Rubric judge (ungrounded)';
  const judgeStatusLabel = judgeMode === JudgeMode.OracleBatch
    ? 'Oracle grader status (prebuilt truth, blind batch)'
    : 'Rubric judge status (ungrounded)';
  const judgeMissingLabel = judgeMode === JudgeMode.OracleBatch
    ? 'Oracle grader missing (prebuilt truth, blind batch)'
    : 'Rubric judge missing (ungrounded)';
  const lifecycleCounts = new Map<string, number>();
  for (const record of records) {
    lifecycleCounts.set(record.lifecycle, (lifecycleCounts.get(record.lifecycle) ?? 0) + 1);
  }
  const lifecycleOrder = ['primary', 'smoke', 'diagnostic', 'quarantine', 'legacy'] as const;
  for (const lifecycle of lifecycleOrder) {
    if (!lifecycleCounts.has(lifecycle)) lifecycleCounts.set(lifecycle, 0);
  }

  const invalidatedHeader = invalidatedReason === null
    ? []
    : [
        '**Evaluation status:** INVALIDATED',
        `**Invalidation reason:** ${invalidatedReason.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`,
        '',
      ];
  const primaryCount = lifecycleCounts.get('primary') ?? 0;
  const decisionSummary: string[] = ['## Decision summary', ''];
  if (invalidatedReason !== null) {
    decisionSummary.push(
      'Status: invalidated. This report is diagnostic only; no product comparison is admitted.',
      '',
    );
  } else if (primaryCount === 0) {
    decisionSummary.push('No admitted primary result; this report is diagnostic only.', '');
  } else {
    const judge = buildPairedSummary(
      opts.records,
      'judge',
      'primary',
      PRODUCT_BUNDLE_COMPARISON,
    );
    const programmatic = buildPairedSummary(
      opts.records,
      'programmatic',
      'primary',
      PRODUCT_BUNDLE_COMPARISON,
    );
    const primaryRecords = records.filter((record) => record.lifecycle === 'primary');
    const reliability = (arm: 'withMcp' | 'withoutMcp') => {
      const armRecords = primaryRecords.filter((record) => record.arm === arm);
      return {
        runs: armRecords.length,
        agents: armRecords.filter((record) => record.agentStatus === 'completed').length,
        judges: armRecords.filter((record) => record.judgeStatus === 'completed').length,
      };
    };
    const withMcpReliability = reliability('withMcp');
    const withoutMcpReliability = reliability('withoutMcp');
    const operability = summarizeOperability(opts.records).filter(
      (row) => row.lifecycle === 'primary',
    );
    const withMcp = operability.find((row) => row.arm === 'withMcp');
    const withoutMcp = operability.find((row) => row.arm === 'withoutMcp');

    decisionSummary.push(
      '- Compared: MCP + product guide vs source-only.',
      `- ${judgeTitle} (per-protocol; task failures = 0, noncompliant excluded): ${signed(judge.perProtocol.mean)} points across ${judge.perProtocol.comparable} comparable cell(s).`,
      `- ${judgeTitle} (completed pairs only): ${signed(judge.completedOnly.mean)} points across ${judge.completedOnly.comparable} comparable cell(s).`,
      `- Programmatic (per-protocol; task failures = 0, noncompliant excluded): ${signed(programmatic.perProtocol.mean)} points across ${programmatic.perProtocol.comparable} comparable cell(s).`,
      `- Programmatic (completed pairs only): ${signed(programmatic.completedOnly.mean)} points across ${programmatic.completedOnly.comparable} comparable cell(s).`,
      judgeMode === JudgeMode.LegacyUngrounded
        ? `- Reliability: MCP + guide completed ${withMcpReliability.agents}/${withMcpReliability.runs} agents and ${withMcpReliability.judges}/${withMcpReliability.runs} rubric judges (ungrounded); source-only completed ${withoutMcpReliability.agents}/${withoutMcpReliability.runs} agents and ${withoutMcpReliability.judges}/${withoutMcpReliability.runs} rubric judges (ungrounded).`
        : `- Reliability: MCP + guide completed ${withMcpReliability.agents}/${withMcpReliability.runs} agents and ${withMcpReliability.judges}/${withMcpReliability.runs} ${judgeLabel} results; source-only completed ${withoutMcpReliability.agents}/${withoutMcpReliability.runs} agents and ${withoutMcpReliability.judges}/${withoutMcpReliability.runs} ${judgeLabel} results.`,
    );
    if (withMcp && withoutMcp) {
      decisionSummary.push(
        `- Cost: MCP + guide used ${percentChange(withMcp.totalTokens, withoutMcp.totalTokens)} tokens, ${percentChange(withMcp.medianLatencyMs, withoutMcp.medianLatencyMs)} median latency, and ${percentChange(withMcp.reportedCostUsd, withoutMcp.reportedCostUsd)} reported cost.`,
      );
    }
    decisionSummary.push(
      '- Caveat: This measures the MCP + guide bundle, not MCP alone.',
      '',
    );
  }
  const runTable = [
    '## Runs at a glance',
    '',
    `| Case | Run | w/wo MCP | Score (programmatic / ${judgeLabel}) | Tokens | Latency |`,
    '|---|---:|---|---:|---:|---:|',
  ];
  const armOrder = { withoutMcp: 0, withMcp: 1, mcpOnly: 2 } as const;
  for (const record of [...records].sort(
    (left, right) =>
      compareCodeUnits(left.case, right.case) ||
      left.runIndex - right.runIndex ||
      armOrder[left.arm] - armOrder[right.arm],
  )) {
    const arm = record.arm === 'withMcp'
      ? 'w/ MCP'
      : record.arm === 'withoutMcp'
        ? 'w/o MCP'
        : 'MCP only';
    const tokens = (record.agent.usage?.totalTokens ?? 0).toLocaleString('en-US');
    const latency = record.agent.latencyMs === null || record.agent.latencyMs === undefined
      ? 'missing'
      : `${(record.agent.latencyMs / 1000).toFixed(1)}s`;
    runTable.push(
      `| ${record.case} | ${record.runIndex} | ${arm} | ${score(record.programmatic?.score)} / ${score(record.judge.score)} | ${tokens} | ${latency} |`,
    );
  }
  runTable.push('');
  const lines: string[] = [
    `# Coredoc MCP Eval — ${opts.meta.runId}`,
    '',
    ...invalidatedHeader,
    ...decisionSummary,
    `**Agent provider:** ${provider}`,
    `**Graph backend:** ${backend}${opts.meta.sourceInGraph === undefined ? '' : ` (source-in-graph: ${opts.meta.sourceInGraph ? 'on' : 'off'})`}`,
    `**Repository access:** ${accessMode}`,
    `**Models:** ${opts.meta.agentModel} (agent), ${opts.meta.judgeModel} (${judgeLabel})`,
    `**Judge mode:** ${judgeMode}`,
    `**Runs:** ${records.length}; **wall-clock:** ${(opts.meta.wallClockMs / 60000).toFixed(1)}m`,
    `**Harness HEAD:** \`${opts.meta.commit}\``,
    `**Target HEAD:** \`${opts.meta.actualTargetSha ?? 'unknown'}\``,
    `**Graph parsed SHA:** \`${opts.meta.graphParsedSha ?? 'unknown'}\``,
    `**Cohort:** \`${opts.meta.cohortId ?? 'unknown'}\``,
    '',
    ...runTable,
    '## Lifecycle partitions',
    '',
    lifecycleOrder
      .map((name) =>
        name === 'quarantine'
          ? 'quarantine: not runnable'
          : `${name}: ${lifecycleCounts.get(name) ?? 0}`,
      )
      .join(' · '),
    '',
    '## Interpretation',
    '',
  ];

  if (invalidatedReason !== null) {
    lines.push(
      'This run is retained for operability and raw-outcome diagnosis only. No cell is admitted and no product-effect comparison is reported.',
      '',
    );
  } else if ((lifecycleCounts.get('primary') ?? 0) === 0) {
    lines.push('No admitted primary cells; no primary product-effect delta is estimable.', '');
  } else {
    lines.push(
      'Primary comparisons are paired by target × case × runIndex. Positive delta means withMcp outscored withoutMcp.',
      '',
    );
  }

  if (invalidatedReason === null && (lifecycleCounts.get('primary') ?? 0) > 0) {
    lines.push('## Primary product effect', '');
    for (const endpoint of ['programmatic', 'judge'] as const) {
      renderPairedSummary(
        lines,
        buildPairedSummary(opts.records, endpoint, 'primary', PRODUCT_BUNDLE_COMPARISON),
        judgeLabel,
      );
    }
  }

  const diagnosticComparisons: ArmComparison[] = [PRODUCT_BUNDLE_COMPARISON];
  if (records.some((record) => record.arm === 'mcpOnly')) {
    diagnosticComparisons.push(MCP_TOOL_COMPARISON, PRODUCT_GUIDE_COMPARISON);
  }
  const diagnosticLifecycles = (['primary', 'smoke', 'diagnostic'] as const).filter(
    (lifecycle) =>
      records.some((record) => record.lifecycle === lifecycle) &&
      (lifecycle !== 'primary' || diagnosticComparisons.length > 1),
  );
  if (invalidatedReason === null && diagnosticLifecycles.length > 0) {
    lines.push('## Lifecycle-specific diagnostic comparisons', '');
    lines.push(
      'These are descriptive factor checks, partitioned by lifecycle. They are not blended with the primary product-effect headline.',
      '',
    );
    for (const lifecycle of diagnosticLifecycles) {
      lines.push(`### Lifecycle: ${lifecycle}`, '');
      const comparisons = lifecycle === 'primary'
        ? diagnosticComparisons.filter((comparison) => comparison !== PRODUCT_BUNDLE_COMPARISON)
        : diagnosticComparisons;
      for (const comparison of comparisons) {
        for (const endpoint of ['programmatic', 'judge'] as const) {
          renderPairedSummary(
            lines,
            buildPairedSummary(opts.records, endpoint, lifecycle, comparison),
            judgeLabel,
          );
        }
      }
    }
  }

  lines.push('## Operability and resource outcomes', '');
  lines.push(
    `| Lifecycle | Arm | Runs | Completed | Task failed | Infrastructure error | ${judgeMissingLabel} | Total tokens | Agent uncached input | Agent output | Agent cache read | Agent cache creation | MCP tool calls | Base tool calls | Median latency | Actual costUsd |`,
  );
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const costUnavailable =
    records.some((record) => record.provider === AgentProvider.Codex) ||
    (judgeMode === JudgeMode.LegacyUngrounded && /^codex:/i.test(opts.meta.judgeModel));
  const operabilityRows = summarizeOperability(opts.records);
  for (const row of operabilityRows) {
    const cost = costUnavailable
      ? row.reportedCostUsd === 0
        ? 'unavailable (reported 0)'
        : `$${row.reportedCostUsd.toFixed(4)} (partial)`
      : `$${row.reportedCostUsd.toFixed(4)} (reported)`;
    // codex 0.148/0.150 emits no cache_write_input_tokens at all, so a 0 there
    // is "not reported", not "no cache was written".
    const cacheCreation =
      row.allCodex && row.cacheCreationTokens === 0
        ? 'unavailable (not reported)'
        : `${row.cacheCreationTokens}`;
    lines.push(
      `| ${row.lifecycle} | ${row.arm} | ${row.runs} | ${countRate(row.completed, row.runs)} | ${countRate(row.taskFailed, row.runs)} | ${countRate(row.infrastructureError, row.runs)} | ${countRate(row.judgeMissing, row.runs)} | ${row.totalTokens} | ${row.uncachedInputTokens} | ${row.outputTokens} | ${row.cacheReadTokens} | ${cacheCreation} | ${row.mcpToolCalls} | ${row.baseToolCalls} | ${(row.medianLatencyMs / 1000).toFixed(1)}s | ${cost} |`,
    );
  }
  lines.push('');

  lines.push('## Treatment adherence', '');
  lines.push(
    'Adherence is the treatment *dose*, reported separately from answer quality: a run that completed with a real answer but never called the required MCP tools is noncompliant, not failed.',
    '',
  );
  lines.push('| Lifecycle | Arm | Runs | Compliant | Noncompliant | Not applicable | Mean MCP dose/run |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  for (const row of operabilityRows) {
    lines.push(
      `| ${row.lifecycle} | ${row.arm} | ${row.runs} | ${countRate(row.compliant, row.runs)} | ${countRate(row.noncompliant, row.runs)} | ${countRate(row.adherenceNotApplicable, row.runs)} | ${row.meanMcpDose.toFixed(1)} |`,
    );
  }
  lines.push('');

  const lowDose = findLowDoseMcpCells(opts.records);
  lines.push('### Low-dose MCP cells (descriptive)', '');
  if (lowDose.length === 0) {
    lines.push(
      `None: every MCP-treated cell's mean dose clears the floor (${LOW_DOSE_MCP_FLOOR}).`,
      '',
    );
  } else {
    for (const cell of lowDose) {
      lines.push(
        `- ${cell.target}/${cell.case}/${cell.arm}: mean dose ${cell.meanDose.toFixed(1)} over ${cell.completedRuns} completed run(s) (per-run: ${cell.doses.join(', ')}) — low dose; dose alone does not prove or disprove treatment content, so read this cell's delta with caution.`,
      );
    }
    lines.push('');
  }

  if (judgeMode === JudgeMode.OracleBatch) {
    const usage =
      opts.meta.oracleJudgeUsage ??
      opts.runManifest?.oracleJudgeUsage ??
      { calls: 0, totalTokens: 0, costUsd: 0 };
    const cost = /^codex:/i.test(opts.meta.judgeModel)
      ? usage.costUsd === 0
        ? 'unavailable (reported 0)'
        : `$${usage.costUsd.toFixed(4)} (partial)`
      : `$${usage.costUsd.toFixed(4)} (reported)`;
    lines.push('## Oracle batch judge usage', '');
    lines.push('| Calls | Tokens | Actual costUsd |');
    lines.push('|---:|---:|---:|');
    lines.push(`| ${usage.calls} | ${usage.totalTokens} | ${cost} |`, '');
  }

  lines.push('## Run outcomes', '');
  lines.push(
    judgeMode === JudgeMode.OracleBatch
      ? `| Target | Case | Arm | Run | Lifecycle | Agent status | Adherence | ${judgeStatusLabel} | Programmatic | ${judgeTitle} | Factual verdict |`
      : `| Target | Case | Arm | Run | Lifecycle | Agent status | Adherence | ${judgeStatusLabel} | Programmatic | ${judgeTitle} |`,
  );
  lines.push(
    judgeMode === JudgeMode.OracleBatch
      ? '|---|---|---|---:|---|---|---|---|---:|---:|---|'
      : '|---|---|---|---:|---|---|---|---|---:|---:|',
  );
  for (const record of records) {
    lines.push(
      judgeMode === JudgeMode.OracleBatch
        ? `| ${record.target} | ${record.case} | ${record.arm} | ${record.runIndex} | ${record.lifecycle} | ${record.agentStatus} | ${record.treatmentAdherence} | ${record.judgeStatus} | ${score(record.programmatic?.score)} | ${score(record.judge.score)} | ${record.judge.factualVerdict ?? 'missing'} |`
        : `| ${record.target} | ${record.case} | ${record.arm} | ${record.runIndex} | ${record.lifecycle} | ${record.agentStatus} | ${record.treatmentAdherence} | ${record.judgeStatus} | ${score(record.programmatic?.score)} | ${score(record.judge.score)} |`,
    );
  }
  lines.push('');

  const incomplete = records.filter(
    (record) =>
      record.agentStatus !== 'completed' ||
      (record.judgeStatus !== 'completed' &&
        !(judgeMode === JudgeMode.OracleBatch && record.lifecycle === 'smoke' && record.judgeStatus === 'not_run')),
  );
  lines.push('## Failures and incomplete runs', '');
  if (incomplete.length === 0) lines.push('None.', '');
  else {
    lines.push(`| Run | Agent | ${judgeTitle} | Reason |`);
    lines.push('|---|---|---|---|');
    for (const record of incomplete) {
      lines.push(
        `| ${record.target}/${record.case}/${record.arm}/run-${record.runIndex} | ${record.agentStatus} | ${record.judgeStatus} | ${record.agent.error ?? record.judge.raw ?? 'missing'} |`,
      );
    }
    lines.push('');
  }

  const breached = records.filter((record) => (record.confinement?.breaches.length ?? 0) > 0);
  if (breached.length > 0) {
    lines.push('### Confinement breaches (review required)', '');
    lines.push(
      'Explicit out-of-root path arguments and Bash command-string tokens whose call returned successfully. Paths formed at runtime (variable expansion, command substitution, child-process access) are not visible in a transcript and are not covered here.',
      '',
    );
    lines.push('| Run | Tool | Path |');
    lines.push('|---|---|---|');
    for (const record of breached) {
      for (const breach of record.confinement!.breaches) {
        lines.push(
          `| ${record.target}/${record.case}/${record.arm}/run-${record.runIndex} | ${breach.toolName} | ${breach.path} |`,
        );
      }
    }
    lines.push('');
  }

  const legacy = records.filter((record) => Object.values(record.legacyInference).some(Boolean)).length;
  lines.push('## Methodology', '');
  lines.push('- Runs pair first by target × case × runIndex. Each target × case then contributes one mean paired-run delta to the equal-weight macro summary.');
  lines.push(
    judgeMode === JudgeMode.LegacyUngrounded
      ? '- Endpoints are reported separately: programmatic verifier and independent rubric judge (ungrounded).'
      : `- Endpoints are reported separately: programmatic verifier and ${judgeLabel}.`,
  );
  lines.push(`- Every estimand assigns 0 only to task_failed; infrastructure_error and missing ${judgeLabel} outcomes remain missing.`);
  lines.push('- The headline estimands are PER-PROTOCOL, not intention-to-treat: treatment adherence is separate from quality, so a completed run that never called the required MCP tools is scored normally but dropped from both headline rows. The true ITT — every assigned run, noncompliant included — is the descriptive "ITT (all assigned, noncompliant included)" row.');
  lines.push('- Adherence is measured only where an MCP availability probe distinguishes agent choice from a server that never registered: the codex runner probes with a post-run stdio initialize + tools/list, and the Claude runner reads the SDK init record captured before the answer turn. Runs without probe evidence — including records written before this field existed — stay not_applicable.');
  lines.push(`- Dose is the count of MCP tool calls per run, recorded per record and reported as a mean per arm. An MCP-treated cell whose completed runs average below ${LOW_DOSE_MCP_FLOOR} calls is listed as low-dose, with its per-run doses: a screening heuristic for a human look, not a validity verdict — dose counts calls rather than content, and those runs stay in every estimand.`);
  lines.push('- Token columns decompose agent usage only (uncached input, output, cache read, cache creation); "Total tokens" keeps its historical agent + judge meaning. Providers that do not report a component are marked unavailable rather than 0.');
  if (judgeMode === JudgeMode.OracleBatch) {
    lines.push('- Oracle grading uses one blind, no-tools batch call per target × case; smoke cells without curated truth are not judge-graded.');
    lines.push('- A contradicted required fact or present forbidden fact is a completed major-error score of 0; otherwise the score is required-fact coverage.');
    lines.push('- Oracle batch judge usage is reported once at run level and is never attributed to either eval arm.');
  }
  lines.push('- Completed-only requires both paired arms to have completed with that endpoint present.');
  lines.push('- Macro summaries equally weight cells and report mean, median, W-T-L, missing cells, and the honest [min, max] of cell deltas.');
  lines.push('- Arm factors: withMcp = MCP + product guide; mcpOnly = MCP without guide; withoutMcp = neither. mcpOnly comparisons are diagnostic.');
  lines.push('- Actual costUsd comes only from provider-reported usage. Codex does not expose per-run price, so affected rows are marked unavailable or partial rather than priced by the harness.');
  lines.push(`- Legacy records inferred at the compatibility boundary: ${legacy}; legacy lifecycle is excluded from primary.`);
  lines.push('- Legacy records may lack armFactors; their historical arm labels are retained but factor identity is unknown.');
  lines.push(`- Repository access mode: ${accessMode}.`);
  lines.push('- Every run records the filesystem confinement mode it actually ran under and the roots it declared; worktree Claude runs are additionally re-scanned after the fact, and every explicit out-of-root path argument or Bash command-string token that returned successfully is listed under "Confinement breaches (review required)". Runtime-expanded paths are not detectable from a transcript, so that list is a breach record, not a proof of confinement.');
  if (invalidatedReason !== null) {
    lines.push('- Product-effect admission and comparisons were suppressed because the run was invalidated.');
  }

  mkdirSync(dirname(opts.reportPath), { recursive: true });
  writeFileSync(opts.reportPath, `${lines.join('\n')}\n`);
}
