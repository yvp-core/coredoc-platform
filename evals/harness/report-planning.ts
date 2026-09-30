// evals/harness/report-planning.ts
import { median } from './report.js';
import { ARMS, type ArmId, type PlanningRunRecord } from './planning-types.js';
import type { ArmStanding } from './pairwise-aggregate.js';

const ARM_LABEL: Record<ArmId, string> = {
  A: 'A · plan / no-MCP',
  B: 'B · superpowers / no-MCP',
  C: 'C · plan / +MCP',
  D: 'D · superpowers / +MCP',
};

/** Run-health summary; when `degraded`, standings are withheld as untrustworthy. */
export interface RunDegradation {
  errorCount: number;
  invalidCount: number;
  totalSpecs: number;
  totalVerdicts: number;
  threshold: number;
  degraded: boolean;
}

export function renderPlanningReport(opts: {
  runId: string;
  model: string;
  records: PlanningRunRecord[];
  standings: ArmStanding[];
  matrix: Record<ArmId, Record<ArmId, number>>;
  wallClockMs: number;
  degradation?: RunDegradation;
}): string {
  const { records, standings, matrix, degradation } = opts;
  const armIds = ARMS.map((a) => a.id);
  const L: string[] = [];

  L.push(`# coredoc MCP Planning Eval — ${opts.runId}`, '');
  L.push(`**Model:** ${opts.model} (arms + judge)`);
  L.push(`**Runs:** ${records.length}   **Wall-clock:** ${(opts.wallClockMs / 60000).toFixed(1)}m`);
  const cost = records.reduce((a, r) => a + r.usage.costUsd, 0);
  L.push(`**Spec-generation cost:** $${cost.toFixed(2)} (judge cost reported separately in logs)`, '');

  if (degradation?.degraded) {
    const errPct = degradation.totalSpecs ? (degradation.errorCount / degradation.totalSpecs) * 100 : 0;
    const invPct = degradation.totalVerdicts ? (degradation.invalidCount / degradation.totalVerdicts) * 100 : 0;
    L.push(`> ⚠️ **DEGRADED RUN — STANDINGS WITHHELD.**`);
    L.push('>');
    L.push(`> Arm spec errors: ${degradation.errorCount}/${degradation.totalSpecs} (${errPct.toFixed(0)}%). ` +
      `Invalid judge verdicts: ${degradation.invalidCount}/${degradation.totalVerdicts} (${invPct.toFixed(0)}%). ` +
      `Threshold: ${(degradation.threshold * 100).toFixed(0)}%.`);
    L.push('>');
    L.push('> Too many specs failed or verdicts were unusable for the win-rate to be trustworthy. ' +
      'See the Failures table below, fix the cause, and re-run.', '');
  } else {
    L.push('## Arm ranking (pairwise win-rate)', '');
    L.push('| Rank | Arm | Win-rate | W | L | T | Inv | Comparisons |');
    L.push('|---:|---|---:|---:|---:|---:|---:|---:|');
    standings.forEach((s, i) => {
      L.push(
        `| ${i + 1} | ${ARM_LABEL[s.arm] ?? s.arm} | ${(s.winRate * 100).toFixed(0)}% | ${s.wins} | ${s.losses} | ${s.ties} | ${s.invalid} | ${s.comparisons} |`,
      );
    });
    L.push('');

    L.push('## Win-rate matrix (row beats column)', '');
    L.push(`| | ${armIds.join(' | ')} |`);
    L.push(`|---|${armIds.map(() => '---:').join('|')}|`);
    for (const x of armIds) {
      const cells = armIds.map((y) => (x === y ? '—' : `${Math.round(matrix[x][y] * 100)}%`));
      L.push(`| **${x}** | ${cells.join(' | ')} |`);
    }
    L.push('');
  }

  L.push('## Hallucination / grounding (on-disk, never the graph)', '');
  L.push('| Arm | Median precision | Median refs | Median missing |');
  L.push('|---|---:|---:|---:|');
  for (const arm of armIds) {
    const rs = records.filter((r) => r.arm === arm);
    if (rs.length === 0) continue;
    const prec = median(rs.map((r) => r.grounding.precision));
    const refs = median(rs.map((r) => r.grounding.pathRefs + r.grounding.symbolRefs));
    const miss = median(rs.map((r) => r.grounding.missing.length));
    L.push(`| ${ARM_LABEL[arm] ?? arm} | ${(prec * 100).toFixed(0)}% | ${refs.toFixed(0)} | ${miss.toFixed(0)} |`);
  }
  L.push('');

  L.push('## MCP telemetry (C/D)', '');
  L.push('| Arm | Median MCP calls | Median empty | Median tool calls | Median tokens |');
  L.push('|---|---:|---:|---:|---:|');
  for (const arm of armIds) {
    const rs = records.filter((r) => r.arm === arm);
    if (rs.length === 0) continue;
    L.push(
      `| ${ARM_LABEL[arm] ?? arm} | ${median(rs.map((r) => r.mcpCalls)).toFixed(0)} | ${median(rs.map((r) => r.mcpEmpty)).toFixed(0)} | ${median(rs.map((r) => r.toolCalls)).toFixed(0)} | ${median(rs.map((r) => r.usage.totalTokens)).toFixed(0)} |`,
    );
  }
  L.push('');

  const failures = records.filter((r) => r.error);
  if (failures.length) {
    L.push('## Failures', '');
    L.push('| Run | Error |', '|---|---|');
    for (const f of failures) L.push(`| ${f.taskId}/${f.arm}/rep-${f.rep} | ${f.error} |`);
    L.push('');
  }

  L.push('## Methodology', '');
  L.push('- 2×2 arms: {plan-mode, superpowers} × {no-MCP, +coredoc-MCP}; Opus; autonomous; read-only.');
  L.push('- Pairwise blinded judge reads REAL source (never the graph); both orderings; ties allowed.');
  L.push('- Failed/empty arm specs score as a loss; unusable judge verdicts are counted as invalid (excluded from win-rate); a run over the degradation threshold withholds standings.');
  L.push('- Grounding precision = on-disk existence of cited paths/symbols (fs + ripgrep, not coredoc).');
  return `${L.join('\n')}\n`;
}
