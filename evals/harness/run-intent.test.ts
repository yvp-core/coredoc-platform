import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INTENT_ARMS,
  IntentGateStatus,
  armMcpOptions,
  computeIntentGate,
  degradedRecordForFailedJob,
  intentGateNonGatingReason,
  intentRecordSeverity,
  preflightIntentEval,
  renderIntentReport,
  resolveIntentInvocation,
  systemPromptFor,
  type IntentRunRecord,
} from './run-intent.js';
import { IntentAc10Verdict, IntentViolationSeverity, analyzeIntentRun, noTranscriptAnalysis } from './analyze-intent.js';
import { IntentJudgeStatus, aggregateIntentJudgements, type IntentJudgementRecord } from './judge-intent.js';
import { INTENT_TASKS, IntentPromptShape, IntentTaskStage } from '../cases-intent/tasks.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0 };
const INTENT_TOOL = 'mcp__coredoc-eval__get_intent_context';
const BASELINE = INTENT_ARMS[0]!;
const INTENT = INTENT_ARMS[1]!;

function record(arm: 'baseline' | 'intent', verdict: IntentAc10Verdict, error: string | null = null): IntentRunRecord {
  return {
    taskId: 'plan-stock-shortfall',
    stage: IntentTaskStage.Plan,
    shape: IntentPromptShape.Open,
    arm,
    rep: 0,
    artifactPath: `/tmp/${arm}.md`,
    artifactChars: error ? 0 : 100,
    usage: ZERO_USAGE,
    attempts: 1,
    latencyMs: 1_000,
    analysis: { ...noTranscriptAnalysis(arm, 'x'), verdict },
    error,
  };
}

/** A record whose analysis is derived from a transcript, so the gate is wired to the real detections. */
function analyzedRecord(arm: 'baseline' | 'intent', calls: Array<{ name: string; input: unknown }>, taskId?: string): IntentRunRecord {
  const messages: unknown[] = [];
  calls.forEach((call, index) => {
    messages.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: call.name, input: call.input, id: `tu_${index}` }] } });
    messages.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: `tu_${index}`, content: [{ type: 'text', text: 'ok' }] }] },
    });
  });
  return {
    ...record(arm, IntentAc10Verdict.Pass),
    ...(taskId ? { taskId } : {}),
    analysis: analyzeIntentRun({ arm, task: { shape: IntentPromptShape.Open, routedIntentIds: [] }, transcript: messages }),
  };
}

function judgement(arm: 'baseline' | 'intent', passed: boolean, excluded = false): IntentJudgementRecord {
  return {
    taskId: 'plan-stock-shortfall',
    arm,
    rep: 0,
    status: IntentJudgeStatus.Ok,
    passed,
    requiredFacts: [],
    forbiddenFacts: [],
    ...(excluded ? { excluded: true, exclusionReason: 'contaminated control' } : {}),
  };
}

const gateInput = {
  nonGatingReason: null,
  partial: false,
  degraded: false,
  records: [record('baseline', IntentAc10Verdict.NotApplicable), record('intent', IntentAc10Verdict.Pass)],
  judgements: [judgement('baseline', false), judgement('intent', true)],
};

describe('resolveIntentInvocation', () => {
  it('refuses unknown --task and --arm values and lists the valid ids', () => {
    expect(() => resolveIntentInvocation({ task: 'plan-stock' })).toThrow(/unknown --task "plan-stock"[\s\S]*plan-stock-shortfall/i);
    expect(() => resolveIntentInvocation({ arm: 'control' })).toThrow(/unknown --arm "control"[\s\S]*baseline[\s\S]*intent/i);
  });

  it('truncates a smoke run to one task and one rep and marks it partial', () => {
    const smoke = resolveIntentInvocation({ smoke: true, reps: '3' });
    expect(smoke.tasks).toHaveLength(1);
    expect(smoke.reps).toBe(1);
    expect(smoke.partial).toBe(true);
    expect(resolveIntentInvocation({}).partial).toBe(false);
    expect(resolveIntentInvocation({}).tasks).toHaveLength(INTENT_TASKS.length);
  });
});

describe('arm configuration', () => {
  const config = { mcpUrl: 'http://localhost:3000/api/v1/workspaces/ws/mcp' };

  it('gives the control no MCP server and no intent tools', () => {
    expect(armMcpOptions(BASELINE, config, 'cdt_x')).toEqual({ extraTools: [] });
  });

  it('gives the intent arm the workspace server with exactly the two cloud intent tools', () => {
    expect(armMcpOptions(INTENT, config, 'cdt_x')).toEqual({
      extraTools: ['mcp__coredoc-eval__get_intent_context', 'mcp__coredoc-eval__intent_read'],
      mcpServerHttp: { url: config.mcpUrl, headers: { Authorization: 'Bearer cdt_x' } },
    });
  });

  it('tells only the intent arm about the capability, with the methodology inlined', () => {
    expect(systemPromptFor(BASELINE)).not.toMatch(/intent/i);
    const prompt = systemPromptFor(INTENT, 'METHODOLOGY BODY');
    expect(prompt).toContain('mcp__coredoc-eval__intent_read');
    expect(prompt).toContain('METHODOLOGY BODY');
    expect(() => systemPromptFor(INTENT, '  ')).toThrow(/methodology/);
  });
});

describe('preflightIntentEval', () => {
  it('refuses to start without a run config, before any paid call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-eval-preflight-'));
    try {
      await expect(preflightIntentEval({}, join(dir, 'cloud-run.json'))).rejects.toThrow(/eval:intent:setup/);
      writeFileSync(
        join(dir, 'cloud-run.json'),
        JSON.stringify({ checkoutRoot: join(dir, 'gone'), tokenFile: join(dir, 'mcp-token') }),
      );
      await expect(preflightIntentEval({}, join(dir, 'cloud-run.json'))).rejects.toThrow(/checkout recorded by setup is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('computeIntentGate', () => {
  it('passes a full, clean, two-armed run', () => {
    const gate = computeIntentGate(gateInput);
    expect(gate.status).toBe(IntentGateStatus.Pass);
    expect(gate.gatePassed).toBe(true);
  });

  it('never passes an empty run or one missing an arm', () => {
    expect(computeIntentGate({ ...gateInput, records: [], judgements: [] }).reasons.join(' ')).toMatch(/no run records/);
    const onlyIntent = computeIntentGate({ ...gateInput, records: [record('intent', IntentAc10Verdict.Pass)] });
    expect(onlyIntent.gatePassed).toBe(false);
    expect(onlyIntent.reasons.join(' ')).toMatch(/baseline/);
  });

  it('reports a run without staged anchors as diagnostic, never as a pass', () => {
    const reason = intentGateNonGatingReason({ anchorsStaged: false });
    expect(reason).toMatch(/anchors are not staged/);
    expect(intentGateNonGatingReason({ anchorsStaged: true })).toBeNull();
    const gate = computeIntentGate({ ...gateInput, nonGatingReason: reason });
    expect(gate.status).toBe(IntentGateStatus.Diagnostic);
    expect(gate.gatePassed).toBe(false);
  });

  it('reports a filtered run as partial and fails a degraded one', () => {
    expect(computeIntentGate({ ...gateInput, partial: true }).status).toBe(IntentGateStatus.Partial);
    expect(computeIntentGate({ ...gateInput, degraded: true }).gatePassed).toBe(false);
  });

  it('fails on a hard finding and on two soft-violating intent sessions, tolerates one soft session', () => {
    const clean = [
      analyzedRecord('baseline', [{ name: 'Read', input: { file_path: '/repo/src/pricing/discount.ts' } }]),
      analyzedRecord('intent', [{ name: INTENT_TOOL, input: { query: 'bulk discount' } }]),
    ];
    const soft = (taskId: string) =>
      analyzedRecord('intent', [{ name: INTENT_TOOL, input: { query: 'a' } }, { name: INTENT_TOOL, input: { query: 'b' } }], taskId);
    const hard = analyzedRecord('intent', [
      { name: INTENT_TOOL, input: { query: 'a' } },
      { name: 'Read', input: { file_path: '/repo/evals/cases-intent/seed-intent.json' } },
    ]);

    expect(computeIntentGate({ ...gateInput, records: [...clean, hard] }).ac10HardFailures).toHaveLength(1);
    const oneSoft = computeIntentGate({ ...gateInput, records: [...clean, soft('review-bulk-discount')] });
    expect(oneSoft.gatePassed).toBe(true);
    expect(oneSoft.reportedNotGating.join(' ')).toMatch(/SOFT violation \(reported, not gating/);
    const twoSoft = computeIntentGate({ ...gateInput, records: [...clean, soft('a'), soft('b')] });
    expect(twoSoft.softBudgetExceeded).toBe(true);
    expect(twoSoft.gatePassed).toBe(false);
  });

  it('treats a failing verdict with no classified finding as hard', () => {
    expect(intentRecordSeverity(record('intent', IntentAc10Verdict.Violation))).toBe(IntentViolationSeverity.Hard);
  });

  it('ignores an excluded control judgement when counting AC-12 failures', () => {
    const gate = computeIntentGate({ ...gateInput, judgements: [judgement('baseline', false, true), judgement('intent', true)] });
    expect(gate.ac12Failures).toHaveLength(0);
  });
});

describe('degradedRecordForFailedJob', () => {
  it('turns a thrown job into a counted, zero-usage record', () => {
    const failed = degradedRecordForFailedJob(INTENT_TASKS[0]!, INTENT, 2, new Error('boom'));
    expect(failed).toMatchObject({ error: 'boom', artifactChars: 0, rep: 2 });
    expect(failed.analysis.verdict).toBe(IntentAc10Verdict.NoTranscript);
  });
});

describe('renderIntentReport', () => {
  it('headlines a diagnostic run and records the workspace it ran against', () => {
    const judgements = [judgement('baseline', false), judgement('intent', true)];
    const report = renderIntentReport({
      runId: 'run-1',
      config: {
        serverUrl: 'http://localhost:3000',
        workspaceId: 'ws-1',
        seedRevision: 'a'.repeat(64),
        importCounts: { domains: 3 },
        anchorsStaged: false,
      },
      agentModel: 'claude-sonnet-5',
      judgeModel: 'claude-opus-5-5',
      invocation: { taskIds: ['plan-stock-shortfall'], armIds: ['baseline', 'intent'], reps: 1, smoke: true, partial: true },
      records: gateInput.records,
      judgements,
      aggregate: aggregateIntentJudgements(judgements, { baselineExpectedFacts: () => [] }),
      judgeUsage: ZERO_USAGE,
      degradedRuns: 0,
      wallClockMs: 1_000,
      gate: computeIntentGate({ ...gateInput, nonGatingReason: intentGateNonGatingReason({ anchorsStaged: false }) }),
    });
    expect(report).toMatch(/DIAGNOSTIC RUN — not a gate result/);
    expect(report).toContain('| workspace | `ws-1` |');
    expect(report).toContain('| code anchors staged | no |');
    expect(report).not.toMatch(/Gate result: PASS/);
  });
});
