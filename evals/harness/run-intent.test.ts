import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INTENT_ARMS,
  armUsesMcp,
  cwdForArm,
  defaultAgentModelFor,
  defaultWorkflowsPluginDir,
  intentRunId,
  intentGateNonGatingReason,
  readIntentMethodology,
  systemPromptFor,
  IntentGateStatus,
  SOFT_VIOLATION_SESSION_BUDGET,
  computeIntentGate,
  degradedRecordForFailedJob,
  intentRecordSeverity,
  renderIntentReport,
  resolveControlRepoRoot,
  resolveIntentInvocation,
  type IntentRunRecord,
} from './run-intent.js';
import { IntentAc10Verdict, IntentViolationSeverity, analyzeIntentRun, noTranscriptAnalysis } from './analyze-intent.js';
import type { SetupResult } from '../cases-intent/setup.js';
import {
  IntentForbiddenVerdict,
  IntentJudgeStatus,
  SEEDED_CONTROL_ARM,
  aggregateIntentJudgements,
  type IntentJudgementRecord,
} from './judge-intent.js';
import { INTENT_TASKS, IntentPromptShape, IntentTaskStage } from '../cases-intent/tasks.js';
import { AgentProvider } from './types.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

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

/**
 * A record whose AC-10 analysis is DERIVED from a transcript rather than
 * hand-written, so the gate tests below are wired to the real detections
 * (`analyzeIntentRun`) and cannot drift from them.
 */
function analyzedRecord(
  arm: 'baseline' | 'intent',
  calls: Array<{ name: string; input: unknown }>,
  overrides: { taskId?: string; rep?: number; routedIntentIds?: string[] } = {},
): IntentRunRecord {
  const messages: unknown[] = [];
  calls.forEach((call, index) => {
    messages.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: call.name, input: call.input, id: `tu_${index}` }] },
    });
    messages.push({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: `tu_${index}`, content: [{ type: 'text', text: 'ok' }] }],
      },
    });
  });
  const routedIntentIds = overrides.routedIntentIds ?? [];
  return {
    ...record(arm, IntentAc10Verdict.Pass),
    ...(overrides.taskId ? { taskId: overrides.taskId } : {}),
    rep: overrides.rep ?? 0,
    shape: routedIntentIds.length > 0 ? IntentPromptShape.Routed : IntentPromptShape.Open,
    analysis: analyzeIntentRun({
      arm,
      task: {
        shape: routedIntentIds.length > 0 ? IntentPromptShape.Routed : IntentPromptShape.Open,
        routedIntentIds,
      },
      transcript: messages,
    }),
  };
}

const INTENT_TOOL = 'mcp__coredoc-eval__get_intent_context';

/** Two broad lookups in one open stage: the observed SOFT slip (runs 1 and 3). */
function softViolatingIntentRecord(taskId: string, rep = 0): IntentRunRecord {
  return analyzedRecord(
    'intent',
    [
      { name: INTENT_TOOL, input: { query: 'bulk discount' } },
      { name: INTENT_TOOL, input: { query: 'rounding' } },
    ],
    { taskId, rep },
  );
}

/** A direct read of the overlay file: the observed HARD slip (run 2). */
function hardViolatingIntentRecord(taskId: string, rep = 0): IntentRunRecord {
  return analyzedRecord(
    'intent',
    [
      { name: INTENT_TOOL, input: { query: 'bulk discount' } },
      { name: 'Read', input: { file_path: '/repo/fixture-repo/.coredoc/intent.json' } },
    ],
    { taskId, rep },
  );
}

/**
 * The harness-owned sensitivity control every run now judges. It is in the
 * report input because judge health must be visible even on a run whose live
 * baseline behaved perfectly — the failure mode the seeded control replaced.
 */
function seededJudgement(
  tripped: readonly string[] = ['cross-warehouse-as-sanctioned'],
  status = IntentJudgeStatus.Ok,
): IntentJudgementRecord {
  return {
    taskId: 'plan-stock-shortfall',
    arm: SEEDED_CONTROL_ARM,
    rep: 0,
    status,
    passed: false,
    requiredFacts: [],
    forbiddenFacts: tripped.map((id) => ({ id, verdict: IntentForbiddenVerdict.Tripped })),
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

describe('resolveIntentInvocation (review P1-4a)', () => {
  it('refuses an unknown --task and lists the valid ids', () => {
    expect(() => resolveIntentInvocation({ task: 'plan-stock' }, INTENT_TASKS, INTENT_ARMS)).toThrow(
      /unknown --task "plan-stock"[\s\S]*plan-stock-shortfall/i,
    );
  });

  it('refuses an unknown --arm and lists the valid ids', () => {
    expect(() => resolveIntentInvocation({ arm: 'control' }, INTENT_TASKS, INTENT_ARMS)).toThrow(
      /unknown --arm "control"[\s\S]*baseline[\s\S]*intent/i,
    );
  });

  it('marks a filtered or smoke invocation as partial and a full one as not', () => {
    const full = resolveIntentInvocation({}, INTENT_TASKS, INTENT_ARMS);
    expect(full.partial).toBe(false);
    expect(full.tasks).toHaveLength(INTENT_TASKS.length);
    expect(full.arms).toHaveLength(INTENT_ARMS.length);

    expect(resolveIntentInvocation({ smoke: true }, INTENT_TASKS, INTENT_ARMS).partial).toBe(true);
    expect(resolveIntentInvocation({ task: INTENT_TASKS[0]!.id }, INTENT_TASKS, INTENT_ARMS).partial).toBe(true);
    const armOnly = resolveIntentInvocation({ arm: 'intent' }, INTENT_TASKS, INTENT_ARMS);
    expect(armOnly.partial).toBe(true);
    expect(armOnly.arms.map((arm) => arm.id)).toEqual(['intent']);
  });

  it('truncates a smoke run to one task and one rep', () => {
    const smoke = resolveIntentInvocation({ smoke: true, reps: '3' }, INTENT_TASKS, INTENT_ARMS);
    expect(smoke.tasks).toHaveLength(1);
    expect(smoke.reps).toBe(1);
  });
});

/**
 * The hard/soft run-level aggregation (maintainer decision 2026-08-28). Three
 * consecutive full runs each failed on ONE session — twice a broad-lookup
 * budget overrun, once an overlay file read — while AC-12 held 12/12 twice.
 * Hard findings stay zero-tolerance; soft findings are budgeted at
 * {@link SOFT_VIOLATION_SESSION_BUDGET} intent session per run and are always
 * reported.
 */
describe('computeIntentGate — hard/soft aggregation', () => {
  const gateFor = (records: IntentRunRecord[]) =>
    computeIntentGate({
      provider: AgentProvider.Claude,
      diagnostic: false,
      partial: false,
      degraded: false,
      records,
      judgements: [judgement('baseline', false), judgement('intent', true)],
    });
  const cleanPair = () => [
    analyzedRecord('baseline', [{ name: 'Read', input: { file_path: '/repo/src/pricing/discount.ts' } }]),
    analyzedRecord('intent', [{ name: INTENT_TOOL, input: { query: 'bulk discount' } }]),
  ];

  it('fails on a single hard violation, alone in an otherwise clean run', () => {
    const gate = gateFor([...cleanPair(), hardViolatingIntentRecord('investigate-cent-shortfall')]);
    expect(gate.gatePassed).toBe(false);
    expect(gate.status).toBe(IntentGateStatus.Fail);
    expect(gate.ac10HardFailures).toHaveLength(1);
    expect(gate.ac10SoftSessions).toHaveLength(0);
    expect(gate.reasons.join(' ')).toMatch(/HARD violation \(zero tolerance\)[\s\S]*overlay contamination/i);
  });

  it('passes a run with one soft-violating intent session and reports it as not gating', () => {
    const gate = gateFor([...cleanPair(), softViolatingIntentRecord('review-bulk-discount')]);
    expect(gate.gatePassed).toBe(true);
    expect(gate.status).toBe(IntentGateStatus.Pass);
    expect(gate.ac10Failures).toHaveLength(1);
    expect(gate.ac10SoftSessions).toHaveLength(1);
    expect(gate.softBudgetExceeded).toBe(false);
    expect(gate.reasons).toEqual([]);
    expect(gate.reportedNotGating.join(' ')).toMatch(/SOFT violation \(reported, not gating[\s\S]*review-bulk-discount/);
  });

  it('fails a run with two soft-violating intent sessions', () => {
    const gate = gateFor([
      ...cleanPair(),
      softViolatingIntentRecord('review-bulk-discount'),
      softViolatingIntentRecord('plan-stock-shortfall'),
    ]);
    expect(gate.gatePassed).toBe(false);
    expect(gate.softBudgetExceeded).toBe(true);
    expect(gate.ac10SoftSessions).toHaveLength(2);
    expect(gate.reasons.join(' ')).toMatch(/SOFT budget exceeded: 2 intent session/);
    expect(gate.reportedNotGating).toEqual([]);
  });

  it('fails on the hard finding when a run mixes one hard and one soft session', () => {
    const gate = gateFor([
      ...cleanPair(),
      hardViolatingIntentRecord('investigate-cent-shortfall'),
      softViolatingIntentRecord('review-bulk-discount'),
    ]);
    expect(gate.gatePassed).toBe(false);
    expect(gate.ac10HardFailures).toHaveLength(1);
    expect(gate.softBudgetExceeded).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/HARD violation/);
    expect(gate.reasons.join(' ')).not.toMatch(/SOFT budget exceeded/);
  });

  it('gates a hard finding carried by a session whose own verdict is pass', () => {
    // One selector-less lookup fits the open-stage budget, so AC-10 passes the
    // session — but the broadest request the engine serves still fails the run.
    const selectorLess = analyzedRecord('intent', [{ name: INTENT_TOOL, input: {} }], {
      taskId: 'plan-stock-shortfall',
    });
    expect(selectorLess.analysis.verdict).toBe(IntentAc10Verdict.Pass);
    const gate = gateFor([...cleanPair(), selectorLess]);
    expect(gate.gatePassed).toBe(false);
    expect(gate.ac10HardFailures).toHaveLength(1);
    expect(gate.reasons.join(' ')).toMatch(/selector-less/);
  });

  it('treats a failing verdict carrying no classified finding as hard, never as soft budget', () => {
    // Fail-closed: an unclassified failure must not be spent out of the soft budget.
    const unclassified = record('intent', IntentAc10Verdict.Violation);
    expect(unclassified.analysis.hardViolations).toEqual([]);
    expect(unclassified.analysis.softViolations).toEqual([]);
    expect(intentRecordSeverity(unclassified)).toBe(IntentViolationSeverity.Hard);
    expect(gateFor([...cleanPair(), unclassified]).gatePassed).toBe(false);
  });

  it('leaves a clean session unweighted', () => {
    for (const clean of cleanPair()) expect(intentRecordSeverity(clean)).toBeNull();
  });
});

describe('computeIntentGate (review P1-4b)', () => {
  const clean = () => ({
    records: [record('baseline', IntentAc10Verdict.NotApplicable), record('intent', IntentAc10Verdict.Pass)],
    judgements: [judgement('baseline', false), judgement('intent', true)],
  });

  it('passes a full, clean, two-armed run', () => {
    const gate = computeIntentGate({
      provider: AgentProvider.Claude,
      diagnostic: false,
      partial: false,
      degraded: false,
      ...clean(),
    });
    expect(gate.status).toBe(IntentGateStatus.Pass);
    expect(gate.gatePassed).toBe(true);
  });

  it('never passes an empty run', () => {
    const gate = computeIntentGate({
      provider: AgentProvider.Claude,
      diagnostic: false,
      partial: false,
      degraded: false,
      records: [],
      judgements: [],
    });
    expect(gate.gatePassed).toBe(false);
    expect(gate.status).toBe(IntentGateStatus.Fail);
    expect(gate.reasons.join(' ')).toMatch(/no run records/i);
  });

  it('never passes a run missing one of the two arms', () => {
    const onlyIntent = computeIntentGate({
      provider: AgentProvider.Claude,
      diagnostic: false,
      partial: false,
      degraded: false,
      records: [record('intent', IntentAc10Verdict.Pass)],
      judgements: [judgement('intent', true)],
    });
    expect(onlyIntent.gatePassed).toBe(false);
    expect(onlyIntent.reasons.join(' ')).toMatch(/baseline/i);
  });

  it('reports a filtered run as PARTIAL rather than pass or fail', () => {
    const gate = computeIntentGate({
      provider: AgentProvider.Claude,
      diagnostic: false,
      partial: true,
      degraded: false,
      ...clean(),
    });
    expect(gate.status).toBe(IntentGateStatus.Partial);
    expect(gate.gatePassed).toBe(false);
  });

  it('fails on an AC-10 violation, on no-adoption and on a contaminated control', () => {
    for (const [arm, verdict] of [
      ['intent', IntentAc10Verdict.Violation],
      ['intent', IntentAc10Verdict.NoAdoption],
      ['baseline', IntentAc10Verdict.ContaminatedControl],
    ] as const) {
      const base = clean();
      const records = base.records.map((r) => (r.arm === arm ? { ...r, analysis: { ...r.analysis, verdict } } : r));
      const gate = computeIntentGate({
        provider: AgentProvider.Claude,
        diagnostic: false,
        partial: false,
        degraded: false,
        ...base,
        records,
      });
      expect(gate.gatePassed, `${arm}/${verdict}`).toBe(false);
      expect(gate.status).toBe(IntentGateStatus.Fail);
    }
  });

  it('ignores an excluded judgement when counting AC-12 failures but still fails the run', () => {
    const base = clean();
    const gate = computeIntentGate({
      provider: AgentProvider.Claude,
      diagnostic: false,
      partial: false,
      degraded: false,
      records: base.records,
      judgements: [judgement('baseline', false, true), judgement('intent', true)],
    });
    expect(gate.ac12Failures).toHaveLength(0);
    expect(gate.gatePassed).toBe(true);
  });

  it('does not pass a degraded run and reports the diagnostic target separately', () => {
    expect(
      computeIntentGate({
        provider: AgentProvider.Claude,
        diagnostic: false,
        partial: false,
        degraded: true,
        ...clean(),
      }).gatePassed,
    ).toBe(false);
    const diagnostic = computeIntentGate({
      provider: AgentProvider.Claude,
      diagnostic: true,
      partial: false,
      degraded: false,
      ...clean(),
    });
    expect(diagnostic.status).toBe(IntentGateStatus.Diagnostic);
    expect(diagnostic.gatePassed).toBe(false);
  });

  it('never passes a provider run whose control is not causally comparable', () => {
    const reason = intentGateNonGatingReason(AgentProvider.Codex, false);
    expect(reason).toMatch(/control.*code-graph/i);

    const gate = computeIntentGate({
      provider: AgentProvider.Codex,
      diagnostic: false,
      partial: false,
      degraded: false,
      ...clean(),
    });
    expect(gate.status).toBe(IntentGateStatus.Diagnostic);
    expect(gate.gatePassed).toBe(false);
    expect(gate.nonGatingReason).toBe(reason);
  });
});

describe('degradedRecordForFailedJob (review P2-7)', () => {
  it('turns a thrown job into a counted, zero-usage record', () => {
    const task = INTENT_TASKS[0]!;
    const failed = degradedRecordForFailedJob(task, INTENT_ARMS[1]!, 2, new Error('boom'));
    expect(failed.error).toMatch(/boom/);
    expect(failed.usage.totalTokens).toBe(0);
    expect(failed.usage.costUsd).toBe(0);
    expect(failed.artifactChars).toBe(0);
    expect(failed.rep).toBe(2);
    expect(failed.analysis.verdict).toBe(IntentAc10Verdict.NoTranscript);
  });
});

const baseInput = () => ({
    provider: AgentProvider.Claude,
    runId: 'run-1',
    target: {
      projectId: 'intent-eval',
      repoName: 'fixture-repo',
      workspaceRoot: '/w',
      repoRoot: '/w/fixture-repo',
      intentPath: '/w/fixture-repo/.coredoc/intent.json',
      configPath: '/c/coredoc.config.json',
      dbUrl: 'file:/c/coredoc.db.d/intent-eval.db',
      mcpServerCommand: '/m/index.js',
      scope: 'project:intent-eval',
      diagnostic: false,
    },
    preflight: {
      overlaySha256: 'abc',
      graphCommit: 'c1',
      headCommit: 'c2',
      statusReport: {
        overlayStatus: 'ready',
        items: 10,
        relations: 8,
        codeAnchors: 4,
        byAuthority: { accepted: 7, candidate: 2 },
        anchorCounts: { matched: 3, changed: 1 },
        unanchoredItems: 6,
        snapshotFreshness: { 'fixture-repo': 'stale' },
      },
      diagnostic: false,
    },
    agentModel: 'claude-sonnet-5',
    judgeModel: 'claude-opus-5-5',
    invocation: {
      taskIds: ['plan-stock-shortfall'],
      armIds: ['baseline', 'intent'] as const,
      reps: 1,
      smoke: true,
      partial: true,
    },
    records: [record('baseline', IntentAc10Verdict.NotApplicable), record('intent', IntentAc10Verdict.Pass)],
    judgements: [judgement('baseline', false), judgement('intent', true), seededJudgement()],
    aggregate: aggregateIntentJudgements(
      [judgement('baseline', false), judgement('intent', true), seededJudgement()],
      { baselineExpectedFacts: () => ['cross-warehouse-as-sanctioned'] },
    ),
    judgeUsage: { ...ZERO_USAGE, totalTokens: 1_234, costUsd: 0.5 },
    degradedRuns: 0,
    wallClockMs: 1_000,
    gate: computeIntentGate({
      provider: AgentProvider.Claude,
      diagnostic: false,
      partial: true,
      degraded: false,
      records: [record('baseline', IntentAc10Verdict.NotApplicable), record('intent', IntentAc10Verdict.Pass)],
      judgements: [judgement('baseline', false), judgement('intent', true)],
    }),
});

const baseCodexInput = (provider: AgentProvider) => ({ ...baseInput(), provider });

describe('renderIntentReport (review P2-6, P3-9, P3-14)', () => {
  it('headlines a smoke/filtered run as not a gate result and records the invocation', () => {
    const report = renderIntentReport(baseInput());
    expect(report).toMatch(/SMOKE \/ PARTIAL[^\n]*not a full gate result/i);
    expect(report).not.toMatch(/\*\*Gate result: PASS\*\*/);
    expect(report).toContain('plan-stock-shortfall');
    expect(report).toMatch(/tasks in this run/i);
    expect(report).toMatch(/arms in this run/i);
    expect(report).toMatch(/smoke.*\|\s*yes/i);
  });

  it('headlines an unfiltered clean run as a gate PASS', () => {
    const input = baseInput();
    const full = {
      ...input,
      invocation: { ...input.invocation, smoke: false, partial: false },
      gate: computeIntentGate({
        provider: AgentProvider.Claude,
        diagnostic: false,
        partial: false,
        degraded: false,
        records: input.records,
        judgements: input.judgements,
      }),
    };
    expect(renderIntentReport(full)).toContain('**Gate result: PASS**');
  });

  it('reports the seeded sensitivity controls in their own section, outside every population', () => {
    const report = renderIntentReport(baseInput());
    expect(report).toMatch(/### Judge sensitivity — seeded controls \(outside every population\)/);
    expect(report).toMatch(/seeded controls: 1\/1 tripped their expected prohibition/);
    expect(report).toMatch(/- judge-insensitive: no/);
    // Judge health is reported even though the live baseline tripped nothing —
    // the 2026-08-27 smoke shape that used to degrade a working run.
    expect(report).toMatch(/live baseline tripped its own trap: no \(INFORMATIONAL/);
    // The seeded row must not appear in the AC-12 population table.
    const ac12Table = report.slice(report.indexOf('## AC-12'), report.indexOf('### Judge sensitivity'));
    expect(ac12Table).not.toContain(SEEDED_CONTROL_ARM);
  });

  it('names the seeded control as the reason a judge-insensitive run degraded', () => {
    const judgements = [judgement('baseline', true), judgement('intent', true), seededJudgement([])];
    const report = renderIntentReport({
      ...baseInput(),
      judgements,
      aggregate: aggregateIntentJudgements(judgements, {
        baselineExpectedFacts: () => ['cross-warehouse-as-sanctioned'],
      }),
    });
    expect(report).toMatch(/judge-insensitive: YES — a seeded control did not trip the prohibition/);
    expect(report).toMatch(/\| plan-stock-shortfall \| ok \| — \| NO \|/);
  });

  it('reports judge cost and a run total beside the arm cost', () => {
    const report = renderIntentReport(baseInput());
    expect(report).toMatch(/provider-reported cost \(judge\)/i);
    expect(report).toMatch(/provider-reported cost \(run total\)/i);
  });

  it('states the arm-isolation caveats it cannot enforce', () => {
    const report = renderIntentReport(baseInput());
    expect(report).toMatch(/## Caveats/);
    expect(report).toMatch(/host settings/i);
    expect(report).toMatch(/tool list/i);
  });

  it('states that the control has no filesystem access to the overlay and that the tripwire still runs', () => {
    const report = renderIntentReport(baseInput());
    expect(report).toMatch(/outside (this|the) repository/i);
    expect(report).toMatch(/tripwire/i);
  });

  it('reports derived and unrouted ids as separate AC-10 columns (D9)', () => {
    const input = baseInput();
    const derived = {
      ...input,
      records: [
        input.records[0]!,
        {
          ...input.records[1]!,
          analysis: {
            ...input.records[1]!.analysis,
            fetchedIds: ['BR-2', 'LIM-1'],
            derivedIds: ['LIM-1'],
            unroutedIds: [],
          },
        },
      ],
    };
    const report = renderIntentReport(derived);
    expect(report).toMatch(/\| ids derived \|/);
    expect(report).toMatch(/\| ids unrouted \|/);
    expect(report).toMatch(/BR-2, LIM-1 \| LIM-1 \| — \|/);
  });
});

/**
 * The control arm's isolation is a CWD decision, so it is decided by a pure
 * function and tested without a paid run: in the first full gate run the
 * baseline sessions read the overlay straight out of the shared checkout.
 */
describe('cwdForArm (control workspace isolation)', () => {
  const target = { repoRoot: '/w/fixture-repo' } as Parameters<typeof cwdForArm>[1];
  // Not a sibling of the treatment any more: the control lives in a temp dir
  // outside the repository tree, because the codex baselines walked `../..`.
  const control = '/tmp/coredoc-intent-control-abc123/fixture-repo';

  it('runs the baseline arm in the overlay-free control checkout setup recorded', () => {
    const baseline = INTENT_ARMS.find((arm) => arm.id === 'baseline')!;
    expect(cwdForArm(baseline, target, control)).toBe(control);
  });

  it('runs the intent arm in the checkout that carries the overlay', () => {
    const intent = INTENT_ARMS.find((arm) => arm.id === 'intent')!;
    expect(cwdForArm(intent, target, control)).toBe('/w/fixture-repo');
  });
});

/**
 * The control checkout is temp state: a reboot, a tmp reaper or a setup that
 * never completed leaves the recorded path gone, and the baseline arm would
 * then run in a directory that does not exist — a cheap way to spend a paid
 * run on twelve empty artifacts.
 */
describe('resolveControlRepoRoot', () => {
  it('returns the recorded control checkout when it is still there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-control-present-'));
    expect(resolveControlRepoRoot({ controlRepoRoot: dir } as SetupResult)).toBe(dir);
  });

  it('refuses a recorded control checkout that is gone, and says to re-run setup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-control-gone-'));
    rmSync(dir, { recursive: true, force: true });
    expect(() => resolveControlRepoRoot({ controlRepoRoot: dir } as SetupResult)).toThrow(/setup/i);
  });
});

/* ------------------------------------------------------------------ *
 * Codex provider (reverses D7): the gate runs on a second agent host, so
 * every ARM MECHANIC that codex cannot reproduce is decided by a pure
 * function here rather than discovered mid-matrix.
 * ------------------------------------------------------------------ */

describe('defaultAgentModelFor', () => {
  it('keeps the pinned claude model as the default', () => {
    expect(defaultAgentModelFor(AgentProvider.Claude)).toBe('claude-sonnet-5');
  });

  it('defaults the codex provider to gpt-6-sol', () => {
    expect(defaultAgentModelFor(AgentProvider.Codex)).toBe('gpt-6-sol');
  });
});

describe('defaultWorkflowsPluginDir', () => {
  it('resolves the distribution from the coredoc checkout instead of one developer\'s home path', () => {
    expect(defaultWorkflowsPluginDir('/work/coredoc-parser')).toBe(
      '/work/coredoc-workflows/plugins/coredoc-workflows',
    );
  });
});

describe('intentRunId', () => {
  it('leaves the claude run directory name as the bare timestamp', () => {
    expect(intentRunId('2026-08-27T10-00-00-000Z', AgentProvider.Claude)).toBe('2026-08-27T10-00-00-000Z');
  });

  it('marks a codex run directory so two providers never look alike on disk', () => {
    expect(intentRunId('2026-08-27T10-00-00-000Z', AgentProvider.Codex)).toBe('2026-08-27T10-00-00-000Z-codex');
  });
});

describe('armUsesMcp (arm mechanics per provider)', () => {
  const baseline = INTENT_ARMS.find((arm) => arm.id === 'baseline')!;
  const intent = INTENT_ARMS.find((arm) => arm.id === 'intent')!;

  it('keeps the code-graph server on BOTH claude arms (the tool allowlist is the variable)', () => {
    expect(armUsesMcp(baseline, AgentProvider.Claude)).toBe(true);
    expect(armUsesMcp(intent, AgentProvider.Claude)).toBe(true);
  });

  it('drops the server entirely from the codex control, which has no per-tool allowlist', () => {
    expect(armUsesMcp(baseline, AgentProvider.Codex)).toBe(false);
    expect(armUsesMcp(intent, AgentProvider.Codex)).toBe(true);
  });
});

describe('systemPromptFor across providers', () => {
  const baseline = INTENT_ARMS.find((arm) => arm.id === 'baseline')!;
  const intent = INTENT_ARMS.find((arm) => arm.id === 'intent')!;
  const METHODOLOGY = 'ROUTED IDS FIRST: at most one broad lookup per stage.';

  it('tells only the intent arm about the capability, on either provider', () => {
    expect(systemPromptFor(baseline, AgentProvider.Claude, METHODOLOGY)).not.toContain('get_intent_context');
    expect(systemPromptFor(intent, AgentProvider.Claude, METHODOLOGY)).toContain('get_intent_context');
    expect(systemPromptFor(baseline, AgentProvider.Codex, METHODOLOGY)).not.toContain('get_intent_context');
    expect(systemPromptFor(intent, AgentProvider.Codex, METHODOLOGY)).toContain('get_intent_context');
  });

  // The 2026-08-27 pair of full runs: the codex arm, which carries the
  // methodology inline, scored AC-10 10/12; the claude arm, which relied on a
  // lazily-triggered skill, 7/12 — one of those a session where the skill never
  // fired at all. The delivery is now identical on both hosts (the skill stays
  // staged for production parity, but the bytes are also in context).
  it('inlines the methodology for the intent arm on EITHER provider', () => {
    expect(systemPromptFor(intent, AgentProvider.Codex, METHODOLOGY)).toContain(METHODOLOGY);
    expect(systemPromptFor(intent, AgentProvider.Claude, METHODOLOGY)).toContain(METHODOLOGY);
  });

  it('gives both providers the same methodology framing, so the arms differ by host only', () => {
    const claude = systemPromptFor(intent, AgentProvider.Claude, METHODOLOGY);
    const codex = systemPromptFor(intent, AgentProvider.Codex, METHODOLOGY);
    for (const prompt of [claude, codex]) {
      expect(prompt).toContain('--- intent-context methodology ---');
      expect(prompt.indexOf(METHODOLOGY)).toBeGreaterThan(prompt.indexOf('get_intent_context'));
    }
  });

  it('never inlines the methodology into a control arm, whatever the provider', () => {
    expect(systemPromptFor(baseline, AgentProvider.Codex, METHODOLOGY)).not.toContain(METHODOLOGY);
    expect(systemPromptFor(baseline, AgentProvider.Claude, METHODOLOGY)).not.toContain(METHODOLOGY);
  });

  it('omits the MCP-tools paragraph from the codex control, which is given no server', () => {
    expect(systemPromptFor(baseline, AgentProvider.Codex, METHODOLOGY)).not.toContain('mcp__coredoc-eval__');
    expect(systemPromptFor(baseline, AgentProvider.Claude)).toContain('mcp__coredoc-eval__');
    expect(systemPromptFor(intent, AgentProvider.Codex, METHODOLOGY)).toContain('mcp__coredoc-eval__');
  });

  it('refuses to run an intent arm with no methodology to inline, on either provider', () => {
    expect(() => systemPromptFor(intent, AgentProvider.Codex)).toThrow(/methodology/i);
    expect(() => systemPromptFor(intent, AgentProvider.Claude)).toThrow(/methodology/i);
    expect(() => systemPromptFor(intent, AgentProvider.Claude, '   ')).toThrow(/methodology/i);
  });
});

describe('readIntentMethodology', () => {
  it('returns the canonical body of the staged skill without the eval-authored frontmatter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-methodology-'));
    const skillDir = join(dir, 'skills', 'intent-context');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: intent-context\ndescription: eval-side packaging\n---\n\n# Intent context\n\nExact ids first.\n',
    );
    const body = readIntentMethodology(dir);
    expect(body).toContain('Exact ids first.');
    expect(body).not.toContain('description: eval-side packaging');
  });

  it('fails loudly rather than running a codex intent arm with no methodology', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-methodology-'));
    expect(() => readIntentMethodology(dir)).toThrow(/SKILL\.md/);
  });
});

describe('renderIntentReport — provider provenance and codex caveats', () => {
  it('records the claude provider without claiming codex is out of scope any more', () => {
    const report = renderIntentReport(baseCodexInput(AgentProvider.Claude));
    expect(report).toMatch(/\| provider \| claude \|/);
  });

  it('names codex in the fingerprints of a codex run', () => {
    const report = renderIntentReport(baseCodexInput(AgentProvider.Codex));
    expect(report).toMatch(/\| provider \| codex \|/);
  });

  it('records the codex arm differences as caveats instead of hiding them', () => {
    const report = renderIntentReport(baseCodexInput(AgentProvider.Codex));
    // control has no server at all
    // control has no server at all, not a denied tool
    expect(report).toMatch(/no MCP server/i);
    // read-only sandbox instead of a Read\/Grep\/Glob allowlist
    expect(report).toMatch(/read-only sandbox/i);
    // no invented price table
    expect(report).toMatch(/codex cost not provider-reported/i);
  });

  it('headlines a full codex matrix as diagnostic while its control lacks the code graph', () => {
    const input = baseCodexInput(AgentProvider.Codex);
    const reason = intentGateNonGatingReason(AgentProvider.Codex, false);
    const diagnostic = {
      ...input,
      invocation: { ...input.invocation, smoke: false, partial: false },
      gate: computeIntentGate({
        provider: AgentProvider.Codex,
        diagnostic: false,
        partial: false,
        degraded: false,
        records: input.records,
        judgements: input.judgements,
      }),
    };
    const report = renderIntentReport(diagnostic);
    expect(report).toMatch(/DIAGNOSTIC RUN/i);
    expect(report).toMatch(/control.*code-graph/i);
    expect(report).not.toContain('**Gate result: PASS**');
  });

  it('keeps the claude-specific caveats off a codex report', () => {
    const report = renderIntentReport(baseCodexInput(AgentProvider.Codex));
    expect(report).not.toMatch(/settingSources/);
  });

  // FIX 1: the claude arm no longer relies on a skill trigger, and a reader of
  // the report must be told that the methodology was in context on both hosts.
  it('records the always-in-context methodology as a caveat on BOTH providers', () => {
    for (const provider of [AgentProvider.Claude, AgentProvider.Codex]) {
      const report = renderIntentReport(baseCodexInput(provider));
      expect(report).toMatch(/always in context, on both providers/i);
    }
  });
});
