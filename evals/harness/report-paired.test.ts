import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The published registry is empty (every primary is rejected); register one
// synthetic verifier so admitted-primary report rendering stays covered.
vi.mock('./primary-registry.js', () => ({
  isRegisteredPrimaryVerifier: (verifierId: string) => verifierId === 'acme-api-v1',
}));
import {
  MCP_TOOL_COMPARISON,
  PRODUCT_GUIDE_COMPARISON,
  buildPairedSummary,
  summarizeOperability,
  writeReport,
} from './report.js';
import {
  AccessMode,
  AgentProvider,
  GraphBackend,
  TreatmentAdherence,
  type AgentStatus,
  type JudgeStatus,
  type RunRecord,
} from './types.js';
import {
  createRunManifest,
  recordPermissionCanaryEvidence,
  sha256,
  type RunManifest,
} from './provenance.js';
import {
  buildPermissionCanaryContract,
  createPermissionCanaryConfig,
  PERMISSION_CANARY_CONTRACT_VERSION,
  type PermissionCanaryEvidence,
} from './permission-canary.js';

const roots: string[] = [];

function run(opts: {
  target?: string;
  arm: 'withMcp' | 'mcpOnly' | 'withoutMcp';
  runIndex: number;
  score: number | null;
  judge?: number | null;
  agentStatus?: AgentStatus;
  judgeStatus?: JudgeStatus;
  lifecycle?: 'primary' | 'smoke' | 'diagnostic';
  tokens?: number;
  latencyMs?: number;
  costUsd?: number;
  accessMode?: AccessMode;
  caseId?: RunRecord['case'];
  cohortId?: string;
  treatmentAdherence?: TreatmentAdherence;
}): RunRecord {
  const agentStatus = opts.agentStatus ?? 'completed';
  const judgeStatus = opts.judgeStatus ?? 'completed';
  return {
    target: opts.target ?? 'demo',
    case: opts.caseId ?? 'blast-radius',
    arm: opts.arm,
    runIndex: opts.runIndex,
    lifecycle: opts.lifecycle ?? 'primary',
    armFactors:
      opts.arm === 'withMcp'
        ? { mcp: true, productGuide: true }
        : opts.arm === 'mcpOnly'
          ? { mcp: true, productGuide: false }
          : { mcp: false, productGuide: false },
    cohortId: opts.cohortId ?? 'cohort',
    agentStatus,
    judgeStatus,
    ...(opts.treatmentAdherence ? { treatmentAdherence: opts.treatmentAdherence } : {}),
    accessMode: opts.accessMode,
    provider: 'claude' as RunRecord['provider'],
    backend: 'ladybug' as RunRecord['backend'],
    programmatic: opts.score === null ? null : { score: opts.score, details: {} },
    judge: {
      score: opts.judge ?? opts.score,
      judgeStatus,
      dimensions: [],
      raw: '{}',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: opts.tokens ?? 0,
        costUsd: opts.costUsd ?? 0,
      },
    },
    final: null,
    agent: {
      agentStatus,
      responseText: 'ok',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: opts.tokens ?? 0,
        costUsd: opts.costUsd ?? 0,
      },
      latencyMs: opts.latencyMs ?? 1,
      toolCalls: [],
      transcriptPath: 'x',
      error: agentStatus === 'completed' ? null : agentStatus,
    },
  };
}

function admittedPrimaryManifest(runDir: string): RunManifest {
  const config = createPermissionCanaryConfig({
    harnessHead: 'h'.repeat(40),
    harnessDirtyFingerprint: 'dirty',
    mcpSchemaHash: 'schema',
    mcpBuildHash: 'build',
    sdkRuntimeHash: 'sdk-runtime',
    model: 'claude-sonnet-5',
  });
  const manifest = createRunManifest({
    createdAt: '2026-08-23T00:00:00.000Z',
    harness: { head: 'h'.repeat(40), dirtyFingerprint: 'dirty' },
    targets: [{
      manifestPath: '/evals/targets/acme-api.json',
      manifestHash: 'manifest',
      repoKey: 'acme-api',
      requestedGitSha: 'a'.repeat(40),
      actualVerifierGitSha: 'a'.repeat(40),
      actualAgentGitSha: 'a'.repeat(40),
    }],
    graph: {
      backend: GraphBackend.Ladybug,
      path: '/graph.lbdb',
      fingerprint: 'graph',
      repositories: [{
        repoKey: 'acme-api',
        parsedGitSha: 'a'.repeat(40),
        parsedAt: null,
        parserVersion: null,
      }],
    },
    cells: [{
      target: 'acme-api',
      case: 'feature-implementation-plan',
      lifecycle: 'primary',
      primaryVerifierId: 'acme-api-v1',
      promptHash: 'prompt',
      caseHash: 'case',
      verifierHash: 'verifier',
      repoRevisions: {},
    }],
    arms: [{
      arm: 'withMcp',
      factors: { mcp: true, productGuide: true },
      systemPromptHash: 'system',
      skillHash: 'skill',
    }],
    mcp: { mcpSchemaHash: 'schema', mcpBuildHash: 'build' },
    models: {
      provider: AgentProvider.Claude,
      agentModel: 'claude-sonnet-5',
      agentSdkVersion: '0.2.77',
      judgeProvider: 'codex',
      judgeModel: 'gpt-6-sol',
      judgeSdkVersion: null,
    },
    permissionCanary: { config, evidence: null },
  });
  const transcript = '[]';
  mkdirSync(join(runDir, 'permission-canary'), { recursive: true });
  writeFileSync(join(runDir, 'permission-canary', 'transcript.json'), transcript);
  const contract = buildPermissionCanaryContract({
    snapshotRoot: '/snapshot',
    insideFile: '/snapshot/inside',
    outsideFile: '/outside/secret',
    traversalFile: '../outside/secret',
    symlinkFile: '/snapshot/escape',
    originalGitPath: '/target/.git/logs/HEAD',
    harnessManifestPath: '/coredoc/evals/targets/acme-api.json',
    harnessTruthPath: '/coredoc/evals/harness/primary-registry.ts',
  });
  const evidence = {
    contractVersion: PERMISSION_CANARY_CONTRACT_VERSION,
    contractHash: config.queryPolicyHash,
    promptHash: '1'.repeat(64),
    transcriptHash: sha256(transcript),
    transcriptRelativePath: 'permission-canary/transcript.json',
    materialFingerprint: config.materialFingerprint,
    model: config.model,
    passed: true,
    failureCodes: [],
    status: 'completed',
    costUsd: 0.01,
    init: {
      builtInTools: ['Glob', 'Grep', 'Read'],
      mcpTools: ['mcp__coredoc-eval__describe_repository'],
      mcpServers: [{ name: 'coredoc-eval', status: 'connected' }],
    },
    probes: contract.probes.map((probe) => ({
      id: probe.id,
      toolName: probe.toolName,
      hookDecision: probe.expected,
      callbackDecision: probe.id === 'coredoc-mcp' ? 'allow' as const : null,
      result: probe.expected === 'deny' ? 'denied' as const : 'success' as const,
    })),
  } satisfies PermissionCanaryEvidence;
  recordPermissionCanaryEvidence(manifest, evidence);
  return manifest;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('paired report statistics', () => {
  it('pairs by target/case/runIndex before equal-weight macro aggregation', () => {
    const deltas = [-10, 17, -5, -19, -7, 8];
    const records = deltas.flatMap((delta, index) => [
      run({ target: `cell-${index}`, arm: 'withoutMcp', runIndex: 0, score: 50 }),
      run({ target: `cell-${index}`, arm: 'withMcp', runIndex: 0, score: 50 + delta }),
    ]);
    const summary = buildPairedSummary(records, 'programmatic', 'primary');
    expect(summary.perProtocol.deltas.map((cell) => cell.delta)).toEqual(deltas);
    expect(summary.perProtocol).toMatchObject({
      comparable: 6,
      missing: 0,
      mean: -2.7,
      median: -6,
      wins: 2,
      ties: 0,
      losses: 4,
      range: [-19, 17],
    });
  });

  it('excludes noncompliant treatment from both headline estimands and reports it descriptively', () => {
    const records = [
      run({ target: 'clean', arm: 'withoutMcp', runIndex: 0, score: 50 }),
      run({ target: 'clean', arm: 'withMcp', runIndex: 0, score: 60 }),
      run({ target: 'dosed', arm: 'withoutMcp', runIndex: 0, score: 50 }),
      run({
        target: 'dosed',
        arm: 'withMcp',
        runIndex: 0,
        score: 90,
        treatmentAdherence: TreatmentAdherence.Noncompliant,
      }),
    ];
    const summary = buildPairedSummary(records, 'programmatic', 'primary');
    // The noncompliant cell is dropped like an infrastructure error, not
    // scored 0 — the headline mean stays the compliant cell's +10.
    expect(summary.perProtocol.deltas.map((cell) => cell.target)).toEqual(['clean']);
    expect(summary.perProtocol.mean).toBe(10);
    expect(summary.completedOnly.deltas.map((cell) => cell.target)).toEqual(['clean']);
    expect(summary.perProtocol.missing).toBe(1);
    // The descriptive companion keeps the real answer's score.
    expect(summary.intentionToTreat.deltas.map((cell) => cell.delta)).toEqual([10, 40]);
    expect(summary.noncompliantCells).toEqual(['dosed/blast-radius']);
  });

  it('treats records without an adherence field as not_applicable', () => {
    const records = [
      run({ arm: 'withoutMcp', runIndex: 0, score: 50 }),
      run({ arm: 'withMcp', runIndex: 0, score: 60 }),
    ];
    const summary = buildPairedSummary(records, 'programmatic', 'primary');
    expect(summary.noncompliantCells).toEqual([]);
    expect(summary.perProtocol.mean).toBe(10);
    expect(summary.intentionToTreat.mean).toBe(10);
  });

  it('weights target×case cells equally when their paired run counts differ', () => {
    const many = Array.from({ length: 10 }, (_, runIndex) => [
      run({ target: 'many-runs', arm: 'withoutMcp', runIndex, score: 50 }),
      run({ target: 'many-runs', arm: 'withMcp', runIndex, score: 60 }),
    ]).flat();
    const records = [
      ...many,
      run({ target: 'one-run', arm: 'withoutMcp', runIndex: 0, score: 50 }),
      run({ target: 'one-run', arm: 'withMcp', runIndex: 0, score: 40 }),
    ];
    const summary = buildPairedSummary(records, 'programmatic', 'primary');
    expect(summary.perProtocol.deltas.map((cell) => cell.delta)).toEqual([10, -10]);
    expect(summary.perProtocol.mean).toBe(0);
    expect(summary.perProtocol.comparable).toBe(2);
  });

  it('uses task_failed=0 in the per-protocol estimand but excludes infrastructure and missing judge outcomes', () => {
    const records = [
      run({ arm: 'withoutMcp', runIndex: 0, score: 50 }),
      run({ arm: 'withMcp', runIndex: 0, score: null, agentStatus: 'task_failed', judgeStatus: 'not_run' }),
      run({ arm: 'withoutMcp', runIndex: 1, score: 50 }),
      run({ arm: 'withMcp', runIndex: 1, score: null, agentStatus: 'infrastructure_error', judgeStatus: 'not_run' }),
      run({ arm: 'withoutMcp', runIndex: 2, score: 50, judge: 50 }),
      run({ arm: 'withMcp', runIndex: 2, score: 50, judge: null, judgeStatus: 'missing' }),
    ];
    expect(buildPairedSummary(records, 'programmatic', 'primary').perProtocol).toMatchObject({
      comparable: 1,
      missing: 0,
      deltas: [{ pairedRuns: 2, missingRuns: 1, delta: -25 }],
    });
    expect(buildPairedSummary(records, 'programmatic', 'primary').completedOnly).toMatchObject({
      comparable: 1,
      missing: 0,
      deltas: [{ pairedRuns: 1, missingRuns: 2, delta: 0 }],
    });
    expect(buildPairedSummary(records, 'judge', 'primary').perProtocol).toMatchObject({
      comparable: 1,
      missing: 0,
      deltas: [{ pairedRuns: 1, missingRuns: 2, delta: -50 }],
    });
  });

  it('refuses to aggregate primary records across cohort IDs', () => {
    const records = [
      run({ arm: 'withMcp', runIndex: 0, score: 60 }),
      { ...run({ arm: 'withoutMcp', runIndex: 0, score: 50 }), cohortId: 'other-cohort' },
    ];
    expect(() => buildPairedSummary(records, 'programmatic', 'primary')).toThrow(
      /multiple cohort IDs/,
    );
  });

  it('refuses a report that would combine current records from different wave cohorts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-cohorts-'));
    roots.push(dir);
    const records = [
      run({ arm: 'withMcp', runIndex: 0, score: 60, lifecycle: 'smoke' }),
      {
        ...run({ arm: 'withMcp', runIndex: 0, score: 60, lifecycle: 'diagnostic' }),
        cohortId: 'other-cohort',
      },
    ];
    expect(() =>
      writeReport({
        reportPath: join(dir, 'REPORT.md'),
        records,
        meta: {
          runId: 'mixed',
          wallClockMs: 1,
          agentModel: 'claude-sonnet-5',
          judgeModel: 'claude:claude-opus-5-5',
          commit: 'head',
        },
      }),
    ).toThrow(/multiple cohort IDs/);
  });

  it('renders zero-primary runs honestly without a fabricated zero delta or blended headline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-'));
    roots.push(dir);
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records: [run({ arm: 'withMcp', runIndex: 0, score: 80, lifecycle: 'diagnostic' })],
      meta: {
        runId: 'run',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: 'head',
        actualTargetSha: 'actual',
        graphParsedSha: 'graph',
        cohortId: 'cohort',
      },
    });
    const markdown = readFileSync(reportPath, 'utf8');
    expect(markdown).toContain('No admitted primary cells');
    expect(markdown).not.toMatch(/Final|60%|40%|temperature 0|±/i);
    expect(markdown).toContain('diagnostic: 1');
    expect(markdown).toContain('quarantine: not runnable');
  });

  it('refuses current primary product-effect reporting from worktree records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-primary-worktree-'));
    roots.push(dir);
    expect(() =>
      writeReport({
        reportPath: join(dir, 'REPORT.md'),
        records: [
          run({
            arm: 'withMcp',
            runIndex: 0,
            score: 80,
            lifecycle: 'primary',
            accessMode: AccessMode.Worktree,
          }),
        ],
        meta: {
          runId: 'primary-worktree',
          wallClockMs: 1,
          agentModel: 'claude-sonnet-5',
          judgeModel: 'codex:gpt-6-sol',
          commit: 'head',
          accessMode: AccessMode.Worktree,
        },
      }),
    ).toThrow(/primary product-effect reporting.*permission canary.*not admitted/i);
  });

  it('refuses current primary product-effect reporting from no-checkout records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-primary-no-checkout-'));
    roots.push(dir);
    expect(() =>
      writeReport({
        reportPath: join(dir, 'REPORT.md'),
        records: [
          run({
            arm: 'withMcp',
            runIndex: 0,
            score: 80,
            lifecycle: 'primary',
            accessMode: AccessMode.NoCheckout,
          }),
        ],
        meta: {
          runId: 'primary-no-checkout',
          wallClockMs: 1,
          agentModel: 'claude-sonnet-5',
          judgeModel: 'codex:gpt-6-sol',
          commit: 'head',
          accessMode: AccessMode.NoCheckout,
        },
      }),
    ).toThrow(/primary product-effect reporting.*permission canary.*not admitted/i);
  });

  it('refuses explicit primary historyless records until the permission canary is proven', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-primary-historyless-'));
    roots.push(dir);
    expect(() =>
      writeReport({
        reportPath: join(dir, 'REPORT.md'),
        records: [
          run({
            arm: 'withMcp',
            runIndex: 0,
            score: 80,
            lifecycle: 'primary',
            accessMode: AccessMode.HistorylessSnapshot,
          }),
        ],
        meta: {
          runId: 'primary-historyless',
          wallClockMs: 1,
          agentModel: 'claude-sonnet-5',
          judgeModel: 'codex:gpt-6-sol',
          commit: 'head',
          accessMode: AccessMode.HistorylessSnapshot,
        },
      }),
    ).toThrow(/primary product-effect reporting.*permission canary.*not admitted/i);
  });

  it('admits only historyless Claude primary records with matching passed same-run evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-primary-admitted-'));
    roots.push(dir);
    const manifest = admittedPrimaryManifest(dir);
    const reportPath = join(dir, 'REPORT.md');
    const records = [run({
      target: 'acme-api',
      arm: 'withMcp',
      runIndex: 0,
      score: 100,
      lifecycle: 'primary',
      accessMode: AccessMode.HistorylessSnapshot,
      caseId: 'feature-implementation-plan',
      cohortId: manifest.cohortId,
    })];

    expect(() => writeReport({
      reportPath,
      records,
      runManifest: manifest,
      meta: {
        runId: 'primary-admitted',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: manifest.harness.head,
        provider: AgentProvider.Claude,
        backend: GraphBackend.Ladybug,
        accessMode: AccessMode.HistorylessSnapshot,
        cohortId: manifest.cohortId,
      },
    })).not.toThrow();
    expect(readFileSync(reportPath, 'utf8')).toContain('## Primary product effect');

    manifest.cells[0]!.primaryVerifierId = 'acme-unregistered-v1';
    expect(() => writeReport({
      reportPath,
      records,
      runManifest: manifest,
      meta: {
        runId: 'primary-unregistered',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: manifest.harness.head,
        provider: AgentProvider.Claude,
        backend: GraphBackend.Ladybug,
        accessMode: AccessMode.HistorylessSnapshot,
        cohortId: manifest.cohortId,
      },
    })).toThrow(/unregistered primary record/i);
    manifest.cells[0]!.primaryVerifierId = 'acme-api-v1';

    manifest.permissionCanary.evidence = {
      ...manifest.permissionCanary.evidence!,
      passed: false,
      failureCodes: ['hook-mismatch'],
    };
    expect(() => writeReport({
      reportPath,
      records,
      runManifest: manifest,
      meta: {
        runId: 'primary-rejected',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: manifest.harness.head,
        provider: AgentProvider.Claude,
        backend: GraphBackend.Ladybug,
        accessMode: AccessMode.HistorylessSnapshot,
        cohortId: manifest.cohortId,
      },
    })).toThrow(/passed permission canary evidence/i);
  });

  it('starts an admitted primary report with a plain-language decision summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-primary-summary-'));
    roots.push(dir);
    const manifest = admittedPrimaryManifest(dir);
    const reportPath = join(dir, 'REPORT.md');
    const records = [
      run({
        target: 'acme-api',
        arm: 'withoutMcp',
        runIndex: 0,
        score: 60,
        judge: 70,
        tokens: 10,
        latencyMs: 1_000,
        costUsd: 1,
        accessMode: AccessMode.HistorylessSnapshot,
        caseId: 'feature-implementation-plan',
        cohortId: manifest.cohortId,
      }),
      run({
        target: 'acme-api',
        arm: 'withMcp',
        runIndex: 0,
        score: 80,
        judge: 90,
        tokens: 20,
        latencyMs: 2_000,
        costUsd: 2,
        accessMode: AccessMode.HistorylessSnapshot,
        caseId: 'feature-implementation-plan',
        cohortId: manifest.cohortId,
      }),
    ];

    writeReport({
      reportPath,
      records,
      runManifest: manifest,
      meta: {
        runId: 'primary-summary',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: manifest.harness.head,
        provider: AgentProvider.Claude,
        backend: GraphBackend.Ladybug,
        accessMode: AccessMode.HistorylessSnapshot,
        cohortId: manifest.cohortId,
      },
    });

    const markdown = readFileSync(reportPath, 'utf8');
    const summary = markdown.slice(0, markdown.indexOf('## Lifecycle partitions'));
    expect(summary).toContain('## Decision summary');
    expect(summary).toContain('Compared: MCP + product guide vs source-only');
    expect(summary).toContain('Rubric judge (ungrounded) (per-protocol; task failures = 0, noncompliant excluded): +20.0 points');
    expect(summary).toContain('Rubric judge (ungrounded) (completed pairs only): +20.0 points');
    expect(summary).toContain('Programmatic (per-protocol; task failures = 0, noncompliant excluded): +20.0 points');
    expect(summary).toContain('Programmatic (completed pairs only): +20.0 points');
    expect(summary).toContain(
      'Reliability: MCP + guide completed 1/1 agents and 1/1 rubric judges (ungrounded); source-only completed 1/1 agents and 1/1 rubric judges (ungrounded).',
    );
    expect(summary).toContain('Cost: MCP + guide used +100.0% tokens, +100.0% median latency, and +100.0% reported cost');
    expect(summary).toContain('This measures the MCP + guide bundle, not MCP alone');
    expect(markdown).toContain('— rubric judge (ungrounded)');
  });

  it('does not hide task-failure penalties inside the quality headline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-primary-failures-'));
    roots.push(dir);
    const manifest = admittedPrimaryManifest(dir);
    const common = {
      target: 'acme-api',
      accessMode: AccessMode.HistorylessSnapshot,
      caseId: 'feature-implementation-plan' as const,
      cohortId: manifest.cohortId,
    };
    const records = [
      run({ ...common, arm: 'withoutMcp', runIndex: 0, score: 30, judge: 98 }),
      run({ ...common, arm: 'withoutMcp', runIndex: 1, score: 10, judge: 98 }),
      run({ ...common, arm: 'withoutMcp', runIndex: 2, score: 30, judge: 95 }),
      run({ ...common, arm: 'withMcp', runIndex: 0, score: 10, judge: 90 }),
      run({
        ...common,
        arm: 'withMcp',
        runIndex: 1,
        score: null,
        judge: null,
        agentStatus: 'task_failed',
        judgeStatus: 'not_run',
      }),
      run({
        ...common,
        arm: 'withMcp',
        runIndex: 2,
        score: null,
        judge: null,
        agentStatus: 'task_failed',
        judgeStatus: 'not_run',
      }),
    ];
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records,
      runManifest: manifest,
      meta: {
        runId: 'primary-failures',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: manifest.harness.head,
        provider: AgentProvider.Claude,
        backend: GraphBackend.Ladybug,
        accessMode: AccessMode.HistorylessSnapshot,
        cohortId: manifest.cohortId,
      },
    });

    const summary = readFileSync(reportPath, 'utf8').split('## Lifecycle partitions')[0]!;
    expect(summary).toContain('Rubric judge (ungrounded) (per-protocol; task failures = 0, noncompliant excluded): -67.0 points');
    expect(summary).toContain('Rubric judge (ungrounded) (completed pairs only): -8.0 points');
    expect(summary).toContain('Programmatic (per-protocol; task failures = 0, noncompliant excluded): -20.0 points');
    expect(summary).toContain('Programmatic (completed pairs only): -20.0 points');
    expect(summary).toContain(
      'Reliability: MCP + guide completed 1/3 agents and 1/3 rubric judges (ungrounded); source-only completed 3/3 agents and 3/3 rubric judges (ungrounded).',
    );
  });

  it('reports mcpOnly tool and guide comparisons with explicit factor labels', () => {
    const records = [
      run({ arm: 'withoutMcp', runIndex: 0, score: 40, lifecycle: 'diagnostic' }),
      run({ arm: 'mcpOnly', runIndex: 0, score: 55, lifecycle: 'diagnostic' }),
      run({ arm: 'withMcp', runIndex: 0, score: 60, lifecycle: 'diagnostic' }),
    ];
    expect(
      buildPairedSummary(records, 'programmatic', 'diagnostic', MCP_TOOL_COMPARISON).perProtocol
        .deltas[0]?.delta,
    ).toBe(15);
    expect(
      buildPairedSummary(records, 'programmatic', 'diagnostic', PRODUCT_GUIDE_COMPARISON).perProtocol
        .deltas[0]?.delta,
    ).toBe(5);

    const dir = mkdtempSync(join(tmpdir(), 'eval-report-factors-'));
    roots.push(dir);
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records,
      meta: {
        runId: 'factors',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude:claude-opus-5-5',
        commit: 'head',
      },
    });
    const markdown = readFileSync(reportPath, 'utf8');
    expect(markdown).toContain('Diagnostic tool effect: mcpOnly (MCP, no guide)');
    expect(markdown).toContain('Diagnostic guide increment: withMcp (MCP + guide)');
    expect(markdown).toContain('not blended with the primary product-effect headline');
  });

  it('refuses to label a current arm whose persisted factors are absent or inconsistent', () => {
    const missing = run({ arm: 'withMcp', runIndex: 0, score: 60, lifecycle: 'diagnostic' });
    delete missing.armFactors;
    expect(() => buildPairedSummary([missing], 'programmatic', 'diagnostic')).toThrow(
      /armFactors/,
    );
    const inconsistent = {
      ...run({ arm: 'mcpOnly', runIndex: 0, score: 60, lifecycle: 'diagnostic' }),
      armFactors: { mcp: false, productGuide: false },
    };
    expect(() => buildPairedSummary([inconsistent], 'programmatic', 'diagnostic')).toThrow(
      /armFactors/,
    );
  });

  it('partitions completion, failures, judge missingness, tokens, latency, and reported cost', () => {
    const records = [
      run({ arm: 'withMcp', runIndex: 0, score: 80, lifecycle: 'diagnostic', tokens: 10, latencyMs: 1000, costUsd: 0.01 }),
      run({ arm: 'withMcp', runIndex: 1, score: null, lifecycle: 'diagnostic', agentStatus: 'task_failed', judgeStatus: 'not_run', tokens: 20, latencyMs: 3000 }),
      run({ arm: 'withMcp', runIndex: 2, score: null, lifecycle: 'diagnostic', agentStatus: 'infrastructure_error', judgeStatus: 'not_run', tokens: 30, latencyMs: 5000 }),
      run({ arm: 'withoutMcp', runIndex: 0, score: 70, lifecycle: 'diagnostic', judge: null, judgeStatus: 'missing', tokens: 5, latencyMs: 2000 }),
    ];
    expect(summarizeOperability(records)).toContainEqual(
      expect.objectContaining({
        lifecycle: 'diagnostic',
        arm: 'withMcp',
        runs: 3,
        completed: 1,
        taskFailed: 1,
        infrastructureError: 1,
        judgeMissing: 0,
        totalTokens: 120,
        medianLatencyMs: 3000,
        reportedCostUsd: 0.02,
      }),
    );

    const dir = mkdtempSync(join(tmpdir(), 'eval-report-ops-'));
    roots.push(dir);
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records,
      meta: {
        runId: 'ops',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude:claude-opus-5-5',
        commit: 'head',
      },
    });
    const markdown = readFileSync(reportPath, 'utf8');
    expect(markdown).toContain('Operability and resource outcomes');
    expect(markdown).toContain('1/3 (33.3%)');
    // Total (agent + judge) first, then the agent-only token decomposition and
    // the MCP / base tool-call counts.
    expect(markdown).toContain('| 120 | 0 | 0 | 0 | 0 | 0 | 0 | 3.0s | $0.0200 (reported) |');
    expect(markdown).toContain('infrastructure_error');
    expect(markdown).toContain('Rubric judge missing (ungrounded)');
  });
});
