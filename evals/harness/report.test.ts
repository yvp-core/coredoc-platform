import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRunRecord,
  buildPairedSummary,
  isDnf,
  writeReport,
  median,
  spread,
  summarizeOperability,
  findLowDoseMcpCells,
  LOW_DOSE_MCP_FLOOR,
} from './report.js';
import {
  AccessMode,
  AgentProvider,
  ConfinementMode,
  GraphBackend,
  JudgeMode,
  TreatmentAdherence,
  type RunRecord,
} from './types.js';

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    target: 'coredoc-parser',
    case: 'explain-repo',
    arm: 'withMcp',
    provider: AgentProvider.Claude,
    backend: GraphBackend.Ladybug,
    runIndex: 0,
    programmatic: { score: 80, details: {} },
    judge: {
      score: 70,
      dimensions: [],
      raw: '{}',
      usage: {
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 550,
        costUsd: 0.01,
      },
    },
    final: 76,
    agent: {
      // Non-DNF by default (>=500 bytes, at least one tool call) — tests that
      // want a DNF row override `agent` explicitly.
      responseText: 'x'.repeat(500),
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 1200,
        costUsd: 0.005,
      },
      latencyMs: 5000,
      toolCalls: [{ name: 'Read', count: 1 }],
      transcriptPath: '/tmp/x.json',
      error: null,
    },
    ...overrides,
  };
}

describe('report', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evals-rep-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('median works on odd and even arrays', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('spread is max minus min', () => {
    expect(spread([1, 5, 3])).toBe(4);
    expect(spread([])).toBe(0);
  });

  it('appendRunRecord writes one JSONL line per call', () => {
    const path = join(dir, 'results.jsonl');
    appendRunRecord(path, makeRun({}));
    appendRunRecord(path, makeRun({ runIndex: 1 }));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).runIndex).toBe(0);
    expect(JSON.parse(lines[1]!).runIndex).toBe(1);
  });

  it('writeReport produces a REPORT.md with explicit endpoint and outcome tables', () => {
    const records = [
      makeRun({ arm: 'withMcp', runIndex: 0, final: 80 }),
      makeRun({ arm: 'withMcp', runIndex: 1, final: 82 }),
      makeRun({ arm: 'withMcp', runIndex: 2, final: 78 }),
      makeRun({ arm: 'withoutMcp', runIndex: 0, final: 60 }),
      makeRun({ arm: 'withoutMcp', runIndex: 1, final: 62 }),
      makeRun({ arm: 'withoutMcp', runIndex: 2, final: 58 }),
    ];
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records,
      meta: {
        runId: '2026-05-09T00-00-00Z',
        wallClockMs: 60_000,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('# Coredoc MCP Eval');
    expect(md).toContain('Decision summary');
    expect(md).toContain(
      '**Models:** claude-sonnet-5 (agent), claude-opus-5-5 (rubric judge (ungrounded))',
    );
    expect(md).toContain(
      '| Case | Run | w/wo MCP | Score (programmatic / rubric judge (ungrounded)) | Tokens | Latency |',
    );
    expect(md).toContain(
      '| Target | Case | Arm | Run | Lifecycle | Agent status | Adherence | Rubric judge status (ungrounded) | Programmatic | Rubric judge (ungrounded) |',
    );
    expect(md).toContain('Rubric judge missing (ungrounded)');
    expect(md).toContain('programmatic verifier and independent rubric judge (ungrounded)');
    expect(md).not.toContain('| Final |');
    expect(md).toContain('explain-repo');
    expect(existsSync(reportPath)).toBe(true);
  });

  it('renders a confinement review block only when a run breached its declared roots', () => {
    const clean = join(dir, 'CLEAN.md');
    writeReport({
      reportPath: clean,
      records: [
        makeRun({
          confinement: {
            mode: ConfinementMode.WorktreeEnvelope,
            declaredRoots: ['/wt'],
            breaches: [],
          },
        }),
      ],
      meta: { runId: 'clean', wallClockMs: 1, agentModel: 'a', judgeModel: 'j', commit: 'abc' },
    });
    expect(readFileSync(clean, 'utf8')).not.toContain('### Confinement breaches');

    const breached = join(dir, 'BREACHED.md');
    writeReport({
      reportPath: breached,
      records: [
        makeRun({
          confinement: {
            mode: ConfinementMode.WorktreeEnvelope,
            declaredRoots: ['/wt'],
            breaches: [
              { toolName: 'Bash', path: '/live-checkout/src/index.ts', toolUseId: 'u1' },
            ],
          },
        }),
      ],
      meta: { runId: 'breached', wallClockMs: 1, agentModel: 'a', judgeModel: 'j', commit: 'abc' },
    });
    const md = readFileSync(breached, 'utf8');
    expect(md).toContain('### Confinement breaches (review required)');
    expect(md).toContain(
      '| coredoc-parser/explain-repo/withMcp/run-0 | Bash | /live-checkout/src/index.ts |',
    );
  });

  it('labels oracle batch grading and reports its usage once outside arm totals', () => {
    const reportPath = join(dir, 'REPORT.md');
    const run = makeRun({
      lifecycle: 'diagnostic',
      armFactors: { mcp: true, productGuide: true },
      cohortId: 'oracle-cohort',
      final: null,
      judgeStatus: 'completed',
      judge: {
        score: 100,
        judgeStatus: 'completed',
        factualVerdict: 'pass',
        dimensions: [{ name: 'required_coverage', value: 10 }],
        raw: '{}',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      },
    });
    writeReport({
      reportPath,
      records: [run],
      meta: {
        runId: 'oracle',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude:claude-opus-5-5',
        judgeMode: JudgeMode.OracleBatch,
        oracleJudgeUsage: { calls: 1, totalTokens: 345, costUsd: 0.02 },
        commit: 'abc1234',
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('oracle grader (prebuilt truth, blind batch)');
    expect(md).toContain('| Factual verdict |');
    expect(md).toContain('| pass |');
    expect(md).toContain('## Oracle batch judge usage');
    expect(md).toContain('| 1 | 345 | $0.0200 (reported) |');
    expect(md).toContain('| diagnostic | withMcp | 1 |');
    // Total (agent + judge) is kept for continuity, followed by the agent-only
    // decomposition: uncached input, output, cache read, cache creation, then
    // MCP and base tool calls.
    expect(md).toContain('| 1200 | 1000 | 200 | 0 | 0 | 0 | 1 | 5.0s | $0.0050 (reported) |');
  });

  it('reports adherence per arm and grades a noncompliant run instead of failing it', () => {
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records: [
        makeRun({
          arm: 'withMcp',
          lifecycle: 'diagnostic',
          armFactors: { mcp: true, productGuide: true },
          cohortId: 'adherence-cohort',
          agentStatus: 'completed',
          judgeStatus: 'completed',
          treatmentAdherence: TreatmentAdherence.Noncompliant,
          final: null,
        }),
        makeRun({
          arm: 'withoutMcp',
          lifecycle: 'diagnostic',
          armFactors: { mcp: false, productGuide: false },
          cohortId: 'adherence-cohort',
          agentStatus: 'completed',
          judgeStatus: 'completed',
          final: null,
        }),
      ],
      meta: {
        runId: 'adherence',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('## Treatment adherence');
    expect(md).toContain('| diagnostic | withMcp | 1 | 0/1 (0.0%) | 1/1 (100.0%) | 0/1 (0.0%) |');
    // Adherence never converts into a task failure or a suppressed score.
    expect(md).toContain('| completed | noncompliant | completed | 80.0 | 70.0 |');
    expect(md).toContain('| diagnostic | withMcp | 1 | 1/1 (100.0%) | 0/1 (0.0%) |');
    // The headline row DROPS noncompliant runs, which makes it per-protocol; the
    // estimand that keeps every assigned run is the one named ITT.
    expect(md).toContain('| PP (noncompliant excluded, task_failed = 0) |');
    expect(md).toContain('| Descriptive: ITT (all assigned, noncompliant included) |');
    expect(md).not.toContain('| ITT (task_failed = 0) |');
  });

  it('marks codex cache-creation tokens unavailable and counts MCP vs base tool calls', () => {
    const reportPath = join(dir, 'REPORT.md');
    const agent = makeRun({}).agent;
    writeReport({
      reportPath,
      records: [
        makeRun({
          arm: 'withMcp',
          lifecycle: 'diagnostic',
          armFactors: { mcp: true, productGuide: true },
          cohortId: 'codex-cohort',
          provider: AgentProvider.Codex,
          agentStatus: 'completed',
          judgeStatus: 'completed',
          treatmentAdherence: TreatmentAdherence.Compliant,
          final: null,
          agent: {
            ...agent,
            usage: {
              inputTokens: 4000,
              outputTokens: 300,
              cacheReadTokens: 60_000,
              cacheCreationTokens: 0,
              totalTokens: 64_300,
              costUsd: 0,
            },
            toolCalls: [
              { name: 'mcp__coredoc-eval__explain', count: 3 },
              { name: 'Bash', count: 2 },
            ],
          },
        }),
      ],
      meta: {
        runId: 'codex-tokens',
        wallClockMs: 1,
        agentModel: 'codex:gpt-6-sol',
        judgeModel: 'claude-opus-5-5',
        provider: AgentProvider.Codex,
        commit: 'abc1234',
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('| Agent uncached input | Agent output | Agent cache read | Agent cache creation | MCP tool calls | Base tool calls |');
    expect(md).toContain('| 4000 | 300 | 60000 | unavailable (not reported) | 3 | 2 |');
  });

  it('writes an explicit invalidated diagnostic without product-effect comparisons', () => {
    const reportPath = join(dir, 'REPORT.md');
    const records = [
      makeRun({
        arm: 'withoutMcp',
        lifecycle: 'primary',
        armFactors: { mcp: false, productGuide: false },
        cohortId: 'drifted-cohort',
        accessMode: AccessMode.HistorylessSnapshot,
      }),
      makeRun({
        arm: 'withMcp',
        lifecycle: 'primary',
        armFactors: { mcp: true, productGuide: true },
        cohortId: 'drifted-cohort',
        accessMode: AccessMode.HistorylessSnapshot,
      }),
    ];

    writeReport({
      reportPath,
      records,
      invalidatedReason: 'Graph backend changed during the eval: before -> after.',
      meta: {
        runId: 'drifted-run',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: 'abc1234',
        accessMode: AccessMode.HistorylessSnapshot,
      },
    });

    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('**Evaluation status:** INVALIDATED');
    expect(report).toContain('Graph backend changed during the eval: before -&gt; after.');
    expect(report).not.toContain('## Primary product effect');
    expect(report).not.toContain('## Lifecycle-specific diagnostic comparisons');
    expect(report).toContain('## Operability and resource outcomes');
    expect(report).toContain('## Run outcomes');
  });

  it('preserves graph invalidation when a stored run manifest is re-reported', () => {
    const reportPath = join(dir, 'REPORT.md');

    writeReport({
      reportPath,
      records: [makeRun({ lifecycle: 'diagnostic' })],
      runManifest: {
        graph: { fingerprint: 'before' },
        graphFingerprintAfter: 'after',
        graphChangedDuringRun: true,
      } as RunManifest,
      meta: {
        runId: 're-reported-drifted-run',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: 'abc1234',
      },
    });

    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('**Evaluation status:** INVALIDATED');
    expect(report).toContain('Graph backend changed during the eval: before -&gt; after.');
    expect(report).not.toContain('## Lifecycle-specific diagnostic comparisons');
  });

  it('surfaces the agent provider in the header', () => {
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records: [makeRun({ provider: AgentProvider.Codex })],
      meta: {
        runId: '2026-08-21T00-00-00Z-codex',
        wallClockMs: 60_000,
        agentModel: 'codex:default',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
        provider: AgentProvider.Codex,
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('**Agent provider:** codex');
    expect(md).toContain('Actual costUsd');
  });

  it('falls back to claude for reports regenerated from pre-provider records', () => {
    const reportPath = join(dir, 'REPORT.md');
    const legacy = makeRun({});
    delete (legacy as Partial<RunRecord>).provider;
    writeReport({
      reportPath,
      records: [legacy],
      meta: {
        runId: '2026-05-09T00-00-00Z',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    expect(readFileSync(reportPath, 'utf8')).toContain('**Agent provider:** claude');
  });

  it('surfaces the graph backend in the header', () => {
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records: [makeRun({ backend: GraphBackend.Sqlite })],
      meta: {
        runId: '2026-08-21T00-00-00Z-claude-sqlite',
        wallClockMs: 60_000,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
        backend: GraphBackend.Sqlite,
      },
    });
    expect(readFileSync(reportPath, 'utf8')).toContain('**Graph backend:** sqlite');
  });

  it('records no-checkout access in the header and methodology', () => {
    const reportPath = join(dir, 'REPORT.md');
    const record = makeRun({
      arm: 'withoutMcp',
      accessMode: AccessMode.NoCheckout,
    });
    writeReport({
      reportPath,
      records: [record],
      meta: {
        runId: '2026-08-23T00-00-00Z-claude-ladybug-no-checkout',
        wallClockMs: 60_000,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'codex:gpt-6-sol',
        commit: 'abc1234',
        accessMode: AccessMode.NoCheckout,
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('**Repository access:** no-checkout');
    expect(md).toContain('- Repository access mode: no-checkout');
    expect(md).toContain('| completed | not_applicable | completed |');
  });

  it('defaults legacy records and report metadata to worktree access', () => {
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records: [makeRun({})],
      meta: {
        runId: '2026-05-09T00-00-00Z',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    expect(readFileSync(reportPath, 'utf8')).toContain('**Repository access:** worktree');
  });

  it('uses terminal status rather than response length or tool count', () => {
    const record = makeRun({
      arm: 'withoutMcp',
      accessMode: AccessMode.NoCheckout,
      agent: {
        ...makeRun({}).agent,
        responseText: 'No repository evidence was available.',
        toolCalls: [],
      },
    });
    expect(isDnf(record)).toBe(false);

    record.agent.responseText = '   ';
    expect(isDnf(record)).toBe(false);
    record.agentStatus = 'task_failed';
    expect(isDnf(record)).toBe(true);
  });

  it('accepts short completed answers in every arm and access mode', () => {
    const noCheckoutWithMcp = makeRun({
      arm: 'withMcp',
      accessMode: AccessMode.NoCheckout,
      agent: {
        ...makeRun({}).agent,
        responseText: 'short but non-empty',
        toolCalls: [],
      },
    });
    expect(isDnf(noCheckoutWithMcp)).toBe(false);

    const worktreeWithoutMcp = makeRun({
      arm: 'withoutMcp',
      agent: {
        ...makeRun({}).agent,
        responseText: 'short but non-empty',
        toolCalls: [],
      },
    });
    expect(isDnf(worktreeWithoutMcp)).toBe(false);
    worktreeWithoutMcp.agentStatus = 'infrastructure_error';
    expect(isDnf(worktreeWithoutMcp)).toBe(true);
  });

  it('surfaces per-lifecycle and arm completion rate in the operability table', () => {
    const reportPath = join(dir, 'REPORT.md');
    const records = [
      makeRun({ arm: 'withMcp', runIndex: 0, final: 80 }),
      makeRun({ arm: 'withMcp', runIndex: 1, final: 82 }),
      makeRun({ arm: 'withMcp', runIndex: 2, final: 78 }),
    ];
    writeReport({
      reportPath,
      records,
      meta: {
        runId: '2026-08-21T00-00-00Z',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('| Lifecycle | Arm | Runs | Completed | Task failed |');
    expect(md).toContain('3/3 (100.0%)');
  });

  it('reports explicit task failures without inventing a score penalty', () => {
    const reportPath = join(dir, 'REPORT.md');
    // One completed run scoring 90, two DNFs (empty response / no tool calls).
    const records = [
      makeRun({ arm: 'withMcp', runIndex: 0, final: 90 }),
      makeRun({
        arm: 'withMcp',
        runIndex: 1,
        agentStatus: 'task_failed',
        judgeStatus: 'not_run',
        agent: {
          responseText: '',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
          latencyMs: 1000,
          toolCalls: [],
          transcriptPath: '/tmp/x.json',
          error: 'timed out',
        },
      }),
      makeRun({
        arm: 'withMcp',
        runIndex: 2,
        agentStatus: 'task_failed',
        judgeStatus: 'not_run',
        agent: {
          responseText: '',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
          latencyMs: 1000,
          toolCalls: [],
          transcriptPath: '/tmp/x.json',
          error: 'timed out',
        },
      }),
    ];
    writeReport({
      reportPath,
      records,
      meta: {
        runId: '2026-08-21T00-00-00Z',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('1/3 (33.3%)');
    expect(md).toContain('2/3 (66.7%)');
    expect(md).toContain('task_failed');
    expect(md).toContain('| Run | Agent | Rubric judge (ungrounded) | Reason |');
    expect(md).not.toContain('⚠');
  });

  it('reports mean MCP dose per arm and flags only low-dose MCP-treated cells, with per-run doses', () => {
    // One withMcp cell averages a single MCP call per run (the 2026-08-29
    // pattern: treated on paper, behaving like its baseline); the other is
    // genuinely dosed. Neither is excluded from anything.
    const dosed = (arm: 'withMcp' | 'withoutMcp', caseId: 'explain-repo' | 'blast-radius', runIndex: number, mcpCalls: number) =>
      makeRun({
        arm,
        case: caseId,
        runIndex,
        lifecycle: 'diagnostic',
        armFactors: arm === 'withMcp' ? { mcp: true, productGuide: true } : { mcp: false, productGuide: false },
        cohortId: 'dose-cohort',
        agentStatus: 'completed',
        judgeStatus: 'completed',
        final: null,
        agent: {
          ...makeRun({}).agent,
          toolCalls: [
            { name: 'Read', count: 20 },
            ...(mcpCalls > 0 ? [{ name: 'mcp__coredoc-eval__explain', count: mcpCalls }] : []),
          ],
        },
      });
    const records = [
      // A mixture the mean hides: one run made no MCP call, the other two.
      dosed('withMcp', 'explain-repo', 0, 0),
      dosed('withMcp', 'explain-repo', 1, 2),
      dosed('withoutMcp', 'explain-repo', 0, 0),
      dosed('withoutMcp', 'explain-repo', 1, 0),
      dosed('withMcp', 'blast-radius', 0, 6),
      dosed('withoutMcp', 'blast-radius', 0, 0),
    ];

    const withMcpRow = summarizeOperability(records).find(
      (row) => row.lifecycle === 'diagnostic' && row.arm === 'withMcp',
    );
    expect(withMcpRow?.meanMcpDose).toBeCloseTo(8 / 3);

    const flagged = findLowDoseMcpCells(records);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      target: 'coredoc-parser',
      case: 'explain-repo',
      arm: 'withMcp',
      meanDose: 1,
      completedRuns: 2,
      doses: [0, 2],
    });

    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records,
      meta: {
        runId: 'dose',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('| Not applicable | Mean MCP dose/run |');
    expect(md).toContain('### Low-dose MCP cells (descriptive)');
    expect(md).toContain(
      "- coredoc-parser/explain-repo/withMcp: mean dose 1.0 over 2 completed run(s) (per-run: 0, 2) — low dose; dose alone does not prove or disprove treatment content, so read this cell's delta with caution.",
    );
    expect(md).not.toContain('coredoc-parser/blast-radius/withMcp: mean dose');
    // A zero-dose control arm is never low-dose — that is its job.
    expect(md).not.toContain('/withoutMcp: mean dose');

    // The flag is a reading instruction, not a filter: both cells still pair.
    const paired = buildPairedSummary(records, 'judge', 'diagnostic');
    expect(paired.perProtocol.comparable).toBe(2);
    expect(paired.perProtocol.deltas.map((delta) => delta.case).sort()).toEqual([
      'blast-radius',
      'explain-repo',
    ]);
  });

  it('says so explicitly when every MCP-treated cell clears the dose floor', () => {
    const reportPath = join(dir, 'REPORT.md');
    writeReport({
      reportPath,
      records: [
        makeRun({
          arm: 'withMcp',
          lifecycle: 'diagnostic',
          armFactors: { mcp: true, productGuide: true },
          cohortId: 'dosed-cohort',
          agentStatus: 'completed',
          judgeStatus: 'completed',
          final: null,
          agent: {
            ...makeRun({}).agent,
            toolCalls: [{ name: 'mcp__coredoc-eval__explain', count: 5 }],
          },
        }),
      ],
      meta: {
        runId: 'dosed',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain(
      `None: every MCP-treated cell's mean dose clears the floor (${LOW_DOSE_MCP_FLOOR}).`,
    );
  });

  it('falls back to ladybug for reports regenerated from pre-backend records', () => {
    const reportPath = join(dir, 'REPORT.md');
    const legacy = makeRun({});
    delete (legacy as Partial<RunRecord>).backend;
    writeReport({
      reportPath,
      records: [legacy],
      meta: {
        runId: '2026-05-09T00-00-00Z',
        wallClockMs: 1,
        agentModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        commit: 'abc1234',
      },
    });
    expect(readFileSync(reportPath, 'utf8')).toContain('**Graph backend:** ladybug');
  });
});
