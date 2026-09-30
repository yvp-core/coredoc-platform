// evals/harness/report-planning.test.ts
import { describe, it, expect } from 'vitest';
import { renderPlanningReport } from './report-planning.js';
import type { PlanningRunRecord } from './planning-types.js';

const rec = (arm: 'A'|'B'|'C'|'D', precision: number): PlanningRunRecord => ({
  taskId: 't1', arm, rep: 0, specPath: `/x/${arm}.md`, specChars: 2000,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1000, costUsd: 0.5 },
  grounding: { pathRefs: 10, pathsExisting: Math.round(10 * precision), symbolRefs: 0, symbolsExisting: 0, precision, missing: [] },
  mcpCalls: arm === 'C' || arm === 'D' ? 5 : 0, mcpEmpty: 0, toolCalls: 8, error: null,
});

describe('renderPlanningReport', () => {
  it('includes the arm ranking, win-rate matrix, and hallucination table', () => {
    const md = renderPlanningReport({
      runId: '2026-06-24', model: 'claude-opus-5-5', wallClockMs: 60000,
      records: [rec('C', 1.0), rec('A', 0.6)],
      standings: [
        { arm: 'C', wins: 1, losses: 0, ties: 0, invalid: 0, comparisons: 1, winRate: 1 },
        { arm: 'A', wins: 0, losses: 1, ties: 0, invalid: 0, comparisons: 1, winRate: 0 },
      ],
      matrix: { A: { A: 0, B: 0, C: 0, D: 0 }, B: { A: 0, B: 0, C: 0, D: 0 }, C: { A: 1, B: 0, C: 0, D: 0 }, D: { A: 0, B: 0, C: 0, D: 0 } },
    });
    expect(md).toMatch(/Arm ranking/i);
    expect(md).toMatch(/Win-rate matrix/i);
    expect(md).toMatch(/Hallucination/i);
    expect(md).toMatch(/\bC\b/);
    // arm C win-rate = 100%
    expect(md).toMatch(/100%/);
    // arm A grounding precision = 60%
    expect(md).toMatch(/60%/);
    // win-rate matrix: C row vs A column shows C beating A (100%)
    expect(md).toMatch(/\*\*C\*\*.*100%/);
  });

  it('withholds standings and warns when the run is degraded', () => {
    const md = renderPlanningReport({
      runId: '2026-06-24', model: 'claude-opus-5-5', wallClockMs: 60000,
      records: [rec('C', 1.0), { ...rec('A', 0), error: 'timeout' }],
      standings: [
        { arm: 'C', wins: 1, losses: 0, ties: 0, invalid: 0, comparisons: 1, winRate: 1 },
        { arm: 'A', wins: 0, losses: 1, ties: 0, invalid: 0, comparisons: 1, winRate: 0 },
      ],
      matrix: { A: { A: 0, B: 0, C: 0, D: 0 }, B: { A: 0, B: 0, C: 0, D: 0 }, C: { A: 1, B: 0, C: 0, D: 0 }, D: { A: 0, B: 0, C: 0, D: 0 } },
      degradation: { errorCount: 1, invalidCount: 2, totalSpecs: 2, totalVerdicts: 4, threshold: 0.2, degraded: true },
    });
    expect(md).toMatch(/DEGRADED RUN/i);
    expect(md).toMatch(/STANDINGS WITHHELD/i);
    // the misleading ranking + matrix tables must NOT be rendered
    expect(md).not.toMatch(/Arm ranking/i);
    expect(md).not.toMatch(/Win-rate matrix/i);
    // failures are still surfaced so the cause is debuggable
    expect(md).toMatch(/Failures/i);
  });
});
