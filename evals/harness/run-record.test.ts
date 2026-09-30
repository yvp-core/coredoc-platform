import { describe, expect, it } from 'vitest';
import { mcpDoseOf, normalizeRunRecord } from './run-record.js';
import { TreatmentAdherence } from './types.js';

function legacy(overrides: Record<string, unknown> = {}) {
  return {
    target: 'demo',
    case: 'blast-radius',
    arm: 'withMcp',
    runIndex: 0,
    provider: 'claude',
    backend: 'ladybug',
    programmatic: { score: 80, details: {} },
    judge: { score: 70, dimensions: [{ name: 'accuracy', value: 7 }], raw: '{}', usage: {} },
    final: 76,
    agent: { responseText: 'ok', usage: {}, latencyMs: 1, toolCalls: [], transcriptPath: 'x', error: null },
    ...overrides,
  };
}

describe('legacy RunRecord normalization', () => {
  it('infers statuses once and marks legacy lifecycle outside the primary cohort', () => {
    const record = normalizeRunRecord(legacy());
    expect(record.agentStatus).toBe('completed');
    expect(record.judgeStatus).toBe('completed');
    expect(record.lifecycle).toBe('legacy');
    expect(record.legacyInference).toEqual({ agentStatus: true, judgeStatus: true, lifecycle: true });
  });

  it('distinguishes task exhaustion, infrastructure error, and missing historical judge sentinels', () => {
    const task = normalizeRunRecord(
      legacy({
        agent: { ...legacy().agent as object, error: 'harness timeout after 10ms' },
        judge: { score: 0, dimensions: [], raw: '', usage: {} },
      }),
    );
    expect(task.agentStatus).toBe('task_failed');
    expect(task.judgeStatus).toBe('not_run');
    expect(
      normalizeRunRecord(
        legacy({ agent: { ...legacy().agent as object, error: 'codex exec timed out after 10ms' } }),
      ).agentStatus,
    ).toBe('task_failed');

    const infra = normalizeRunRecord(
      legacy({
        agent: { ...legacy().agent as object, error: 'spawn ENOENT' },
        judge: { score: 0, dimensions: [], raw: 'judge failed: timeout', usage: {} },
      }),
    );
    expect(infra.agentStatus).toBe('infrastructure_error');
    expect(infra.judgeStatus).toBe('not_run');

    const missing = normalizeRunRecord(
      legacy({ judge: { score: 0, dimensions: [], raw: 'judge failed: timeout', usage: {} } }),
    );
    expect(missing.agentStatus).toBe('completed');
    expect(missing.judgeStatus).toBe('missing');
    expect(missing.judge.score).toBeNull();
  });

  it('reads a record without an adherence field as not_applicable on both record and agent', () => {
    const record = normalizeRunRecord(legacy());
    expect(record.treatmentAdherence).toBe(TreatmentAdherence.NotApplicable);
    expect(record.agent.treatmentAdherence).toBe(TreatmentAdherence.NotApplicable);
  });

  it('keeps an explicit adherence value and mirrors an agent-level one onto the record', () => {
    expect(
      normalizeRunRecord(legacy({ treatmentAdherence: 'noncompliant' })).treatmentAdherence,
    ).toBe(TreatmentAdherence.Noncompliant);
    const fromAgent = normalizeRunRecord(
      legacy({ agent: { ...(legacy().agent as object), treatmentAdherence: 'compliant' } }),
    );
    expect(fromAgent.treatmentAdherence).toBe(TreatmentAdherence.Compliant);
  });

  it('counts MCP dose from mcp__-prefixed tool calls only', () => {
    expect(
      mcpDoseOf([
        { name: 'mcp__coredoc-eval__explain', count: 3 },
        { name: 'mcp__coredoc-eval__find_callers', count: 2 },
        { name: 'Read', count: 40 },
        { name: 'Bash', count: 7 },
      ]),
    ).toBe(5);
    expect(mcpDoseOf([])).toBe(0);
    expect(mcpDoseOf(undefined)).toBe(0);
  });

  it('derives MCP dose for a record written before the field existed', () => {
    const record = normalizeRunRecord(
      legacy({
        agent: {
          ...(legacy().agent as object),
          toolCalls: [
            { name: 'mcp__coredoc-eval__explain', count: 4 },
            { name: 'Grep', count: 12 },
          ],
        },
      }),
    );
    expect(record.mcpDose).toBe(4);
    // Dose is arithmetic on data the record already carries, so it is not a guess.
    expect(record.legacyInference).toEqual({ agentStatus: true, judgeStatus: true, lifecycle: true });
  });

  it('keeps an explicitly recorded MCP dose', () => {
    const record = normalizeRunRecord(
      legacy({
        mcpDose: 9,
        agent: { ...(legacy().agent as object), toolCalls: [{ name: 'mcp__x__y', count: 1 }] },
      }),
    );
    expect(record.mcpDose).toBe(9);
  });

  it('preserves an explicit valid all-zero completed judge score', () => {
    const record = normalizeRunRecord(
      legacy({
        agentStatus: 'completed',
        judgeStatus: 'completed',
        lifecycle: 'primary',
        judge: { score: 0, dimensions: [{ name: 'accuracy', value: 0 }], raw: '{"accuracy":0}', usage: {} },
      }),
    );
    expect(record.judgeStatus).toBe('completed');
    expect(record.judge.score).toBe(0);
    expect(record.legacyInference).toEqual({ agentStatus: false, judgeStatus: false, lifecycle: false });
  });
});
