import { describe, expect, it, vi } from 'vitest';
import {
  assertOracleBatchReady,
  applyOracleBatchFailure,
  canonicalJson,
  createOracleBatchJob,
  createOracleBinding,
  executeOracleBatchJob,
  MAX_EVIDENCE_QUOTE_CHARS,
  oracleBatchArtifact,
  oracleBatchTimeoutMs,
  ORACLE_BATCH_BASE_TIMEOUT_MS,
  ORACLE_BATCH_PER_RESPONSE_TIMEOUT_MS,
  parseJudgeMode,
  parseOracleBatchResponse,
  stripJsonFence,
  ForbiddenVerdict,
  OracleBatchExecutionError,
  RequiredVerdict,
} from './oracle-batch.js';
import { parseJudgeSpec } from './judge-codex.js';
import {
  AgentProvider,
  GraphBackend,
  JudgeMode,
  type CurrentRunRecord,
  type StructuredTruth,
} from './types.js';
import type { SelectedCell } from './target-loader.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const truth: StructuredTruth = {
  required: [
    { repoKey: 'repo', gitSha: SHA, file: 'src/a.ts', relation: 'A calls B' },
    { repoKey: 'repo', gitSha: SHA, file: 'src/b.ts', effect: 'writes the result' },
  ],
  accepted: [
    { repoKey: 'repo', gitSha: SHA, file: 'src/c.ts', useKind: 'optional helper' },
  ],
  forbidden: [
    { repoKey: 'repo', gitSha: SHA, file: 'src/a.ts', relation: 'B calls A' },
  ],
};

function record(
  arm: CurrentRunRecord['arm'],
  runIndex: number,
  responseText: string,
  agentStatus: CurrentRunRecord['agentStatus'] = 'completed',
): CurrentRunRecord {
  return {
    target: 'target',
    case: 'data-flow-trace',
    arm,
    lifecycle: 'diagnostic',
    armFactors: arm === 'withMcp'
      ? { mcp: true, productGuide: true }
      : { mcp: false, productGuide: false },
    cohortId: 'cohort',
    agentStatus,
    judgeStatus: 'not_run',
    provider: AgentProvider.Claude,
    backend: GraphBackend.Ladybug,
    runIndex,
    programmatic: { score: 75, details: {} },
    judge: {
      score: null,
      judgeStatus: 'not_run',
      dimensions: [],
      raw: '',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
    },
    final: null,
    agent: {
      agentStatus,
      responseText,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 2,
        costUsd: 0,
      },
      latencyMs: 1,
      toolCalls: [],
      transcriptPath: '/hidden/transcript.json',
      error: agentStatus === 'completed' ? null : 'max turns',
    },
  };
}

function job(records: CurrentRunRecord[]) {
  return createOracleBatchJob({
    target: 'target',
    caseId: 'data-flow-trace',
    prompt: 'Trace the value through the service.',
    oracleHash: 'oracle-hash',
    truth,
    records,
    cohortId: 'cohort',
  })!;
}

/**
 * Every `present` required fact is quote-gated too, so the canonical "all
 * present" grade quotes each response's own text (a response is trivially a
 * verbatim substring of itself).
 */
function validRaw(batch = job([record('withMcp', 0, 'answer')])): string {
  return JSON.stringify({
    grades: batch.members.map(({ responseId, response }) => ({
      responseId,
      required: Object.fromEntries(
        batch.required.map(({ id }) => [id, RequiredVerdict.Present]),
      ),
      forbidden: Object.fromEntries(
        batch.forbidden.map(({ id }) => [id, ForbiddenVerdict.Absent]),
      ),
      evidence: Object.fromEntries(batch.required.map(({ id }) => [id, response])),
    })),
  });
}

describe('oracle batch mode and binding', () => {
  it('defaults to legacy and accepts only the explicit oracle mode', () => {
    expect(parseJudgeMode(undefined)).toBe(JudgeMode.LegacyUngrounded);
    expect(parseJudgeMode('oracle-batch')).toBe(JudgeMode.OracleBatch);
    expect(() => parseJudgeMode('grounded')).toThrow(/Unknown --judge-mode/);
  });

  it('binds the oracle hash to prompt, target SHA, sibling SHAs, and truth canonically', () => {
    const input = {
      target: 'target',
      caseId: 'data-flow-trace',
      promptHash: 'prompt-a',
      targetRepoKey: 'repo',
      targetGitSha: SHA,
      siblingRevisions: {
        z: { gitSha: OTHER_SHA },
        a: { gitSha: SHA },
      },
      provenance: {
        kind: 'historical-diff' as const,
        snapshotCommit: SHA,
        artifactBaseCommit: SHA,
        sourceCommit: OTHER_SHA,
        evidence: ['artifact'],
      },
      truth,
    };
    const base = createOracleBinding(input);
    expect(createOracleBinding({
      ...input,
      siblingRevisions: { a: { gitSha: SHA }, z: { gitSha: OTHER_SHA } },
    }).oracleHash).toBe(base.oracleHash);
    expect(createOracleBinding({ ...input, promptHash: 'prompt-b' }).oracleHash).not.toBe(base.oracleHash);
    expect(createOracleBinding({ ...input, targetGitSha: OTHER_SHA }).oracleHash).not.toBe(base.oracleHash);
    expect(createOracleBinding({
      ...input,
      provenance: { ...input.provenance, sourceCommit: SHA },
    }).oracleHash).not.toBe(base.oracleHash);
    expect(createOracleBinding({
      ...input,
      truth: { ...truth, forbidden: [] },
    }).oracleHash).not.toBe(base.oracleHash);
    expect(canonicalJson(base.binding)).toContain('"promptHash":"prompt-a"');
  });

  it('rejects a selected non-smoke cell without required truth', () => {
    const selected = {
      caseId: 'data-flow-trace',
      paramsKey: 'dataFlowTrace',
      cell: {
        lifecycle: 'diagnostic',
        provenance: { kind: 'source-audit', snapshotCommit: SHA, evidence: ['evidence'] },
        params: { path: '/x' },
      },
    } as SelectedCell;
    expect(() => assertOracleBatchReady([{ target: 'target', selected }])).toThrow(
      /requires non-empty cell\.truth\.required/,
    );
    selected.cell.lifecycle = 'smoke';
    expect(() => assertOracleBatchReady([{ target: 'target', selected }])).not.toThrow();
  });
});

describe('oracle batch prompt and parser', () => {
  it('groups only completed answers and exposes no arm/run/programmatic/transcript/tool metadata', () => {
    const batch = job([
      record('withoutMcp', 1, 'Used mcp__coredoc-eval__explain to inspect it.'),
      record('withMcp', 0, 'Second answer.'),
      record('withMcp', 2, 'failed', 'task_failed'),
    ]);
    expect(batch.members).toHaveLength(2);
    expect(batch.judgePrompt.match(/Trace the value through the service\./g)).toHaveLength(1);
    expect(batch.judgePrompt).not.toMatch(/withMcp|withoutMcp|runIndex|programmatic|transcript/i);
    expect(batch.judgePrompt).not.toContain('mcp__coredoc-eval__explain');
    expect(batch.members.map(({ responseId }) => responseId)).toEqual(
      [...batch.members.map(({ responseId }) => responseId)].sort(),
    );
  });

  it('requires the exact response and fact ID sets', () => {
    const batch = job([record('withMcp', 0, 'answer')]);
    expect(parseOracleBatchResponse(validRaw(batch), batch)).toHaveLength(1);
    const parsed = JSON.parse(validRaw(batch));
    delete parsed.grades[0].required['required-002'];
    expect(() => parseOracleBatchResponse(JSON.stringify(parsed), batch)).toThrow(/exactly/);
    parsed.grades[0].required['required-002'] = RequiredVerdict.Present;
    parsed.grades[0].responseId = 'unknown';
    expect(() => parseOracleBatchResponse(JSON.stringify(parsed), batch)).toThrow(/unknown/);
  });

  it('accepts wrong_location as a required classification and rejects any other value', () => {
    const batch = job([record('withMcp', 0, 'answer')]);
    const parsed = JSON.parse(validRaw(batch));
    parsed.grades[0].required['required-001'] = RequiredVerdict.WrongLocation;
    expect(parseOracleBatchResponse(JSON.stringify(parsed), batch)[0].required).toMatchObject({
      'required-001': RequiredVerdict.WrongLocation,
    });
    parsed.grades[0].required['required-001'] = 'partially_present';
    expect(() => parseOracleBatchResponse(JSON.stringify(parsed), batch)).toThrow(
      /invalid required classification/,
    );
  });

  it('does not retry malformed output and applies no partial grades', async () => {
    const batch = job([
      record('withMcp', 0, 'one'),
      record('withoutMcp', 0, 'two'),
    ]);
    const runner = vi.fn().mockResolvedValue({
      raw: '{bad json',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 12,
        costUsd: 0.01,
      },
    });
    await expect(
      executeOracleBatchJob(batch, parseJudgeSpec('claude:judge'), '/tmp/last', { runner }),
    ).rejects.toThrow(/valid JSON/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('marks every completed member missing atomically on batch failure', () => {
    const completedA = record('withMcp', 0, 'one');
    const completedB = record('withoutMcp', 0, 'two');
    const failed = record('withMcp', 1, 'failed', 'task_failed');
    const batch = job([completedA, completedB, failed]);
    applyOracleBatchFailure(batch, 'bad batch');
    expect([completedA, completedB].map(({ judgeStatus }) => judgeStatus)).toEqual([
      'missing',
      'missing',
    ]);
    expect([completedA, completedB].map(({ judge }) => judge.score)).toEqual([null, null]);
    expect(failed.judgeStatus).toBe('not_run');
  });

  it('computes verdicts and keeps batch usage off every arm record', async () => {
    const batch = job([
      record('withMcp', 0, 'one'),
      record('withoutMcp', 0, 'two'),
    ]);
    const raw = JSON.parse(validRaw(batch));
    raw.grades[1].required['required-001'] = RequiredVerdict.Contradicted;
    raw.grades[1].evidence = {
      ...raw.grades[1].evidence,
      'required-001': batch.members[1].response,
    };
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 120,
      costUsd: 0.25,
    };
    const execution = await executeOracleBatchJob(
      batch,
      parseJudgeSpec('claude:judge'),
      '/tmp/last',
      { runner: async () => ({ raw: JSON.stringify(raw), usage }) },
    );
    const scores = [...execution.scores.values()];
    expect(scores.map(({ score }) => score).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 100]);
    expect(scores.find(({ score }) => score === 0)?.factualVerdict).toBe('major_error');
    expect(scores.reduce((sum, score) => sum + score.usage.totalTokens, 0)).toBe(0);
    expect(scores.reduce((sum, score) => sum + score.usage.costUsd, 0)).toBe(0);
    expect(execution.usage).toEqual(usage);
  });

  it('labels missing required facts as a scored minor error', async () => {
    const batch = job([record('withMcp', 0, 'one')]);
    const raw = JSON.parse(validRaw(batch));
    raw.grades[0].required['required-002'] = RequiredVerdict.Missing;
    const execution = await executeOracleBatchJob(
      batch,
      parseJudgeSpec('claude:judge'),
      '/tmp/last',
      {
        runner: async () => ({
          raw: JSON.stringify(raw),
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        }),
      },
    );
    expect([...execution.scores.values()][0]).toMatchObject({
      score: 50,
      factualVerdict: 'minor_error',
    });
  });
});

describe('oracle batch evidence-quote gating', () => {
  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const RESPONSE = 'A never calls B here.\nAll data flow terminates in browser localStorage.';

  /**
   * Starts from the canonical all-present grade (every required fact quoted with
   * the response's own text) so a test only has to disturb the verdict it is
   * about; `mutate` may drop or rewrite individual `evidence` entries.
   */
  async function grade(
    responseText: string,
    mutate: (grade: Record<string, Record<string, string>>) => void,
  ) {
    const batch = job([record('withMcp', 0, responseText)]);
    const raw = JSON.parse(validRaw(batch));
    mutate(raw.grades[0]);
    const execution = await executeOracleBatchJob(
      batch,
      parseJudgeSpec('claude:judge'),
      '/tmp/last',
      { runner: async () => ({ raw: JSON.stringify(raw), usage: ZERO_USAGE }) },
    );
    return { batch, execution, score: [...execution.scores.values()][0] };
  }

  it('keeps the hard zero when the contradiction quote is found verbatim in the response', async () => {
    const { execution, score } = await grade(RESPONSE, (g) => {
      g.required['required-001'] = RequiredVerdict.Contradicted;
      g.evidence['required-001'] = 'A never calls B here.';
    });
    expect(score).toMatchObject({ score: 0, factualVerdict: 'major_error' });
    expect(execution.downgradedVerdicts).toEqual([]);
    expect(JSON.parse(score.raw).contradictedRequired).toEqual(['required-001']);
  });

  it('downgrades a contradiction with no quote to missing and scores proportionally', async () => {
    const { execution, score } = await grade(RESPONSE, (g) => {
      g.required['required-001'] = RequiredVerdict.Contradicted;
      delete g.evidence['required-001'];
    });
    expect(score).toMatchObject({ score: 50, factualVerdict: 'minor_error' });
    expect(execution.downgradedVerdicts).toEqual([
      {
        responseId: expect.stringMatching(/^response-/),
        factId: 'required-001',
        from: 'contradicted',
        to: 'missing',
        reason: 'missing_quote',
      },
    ]);
    const raw = JSON.parse(score.raw);
    expect(raw.contradictedRequired).toEqual([]);
    expect(raw.missingRequired).toEqual(['required-001']);
    expect(raw.downgradedVerdicts).toHaveLength(1);
  });

  it('downgrades a contradiction whose quote is empty or absent from the graded response', async () => {
    const empty = await grade(RESPONSE, (g) => {
      g.required['required-001'] = RequiredVerdict.Contradicted;
      g.evidence['required-001'] = '   ';
    });
    expect(empty.execution.downgradedVerdicts[0]?.reason).toBe('missing_quote');
    expect(empty.score.score).toBe(50);

    const fabricated = await grade(RESPONSE, (g) => {
      g.required['required-001'] = RequiredVerdict.Contradicted;
      g.evidence['required-001'] = 'The response says B calls A repeatedly.';
    });
    expect(fabricated.execution.downgradedVerdicts[0]).toMatchObject({
      factId: 'required-001',
      from: 'contradicted',
      to: 'missing',
      reason: 'quote_not_found',
    });
    expect(fabricated.score).toMatchObject({ score: 50, factualVerdict: 'minor_error' });
  });

  it('gates a present forbidden fact on the same quote rule', async () => {
    const quoted = await grade(RESPONSE, (g) => {
      g.forbidden['forbidden-001'] = ForbiddenVerdict.Present;
      g.evidence['forbidden-001'] = 'A never calls B here.';
    });
    expect(quoted.score).toMatchObject({ score: 0, factualVerdict: 'major_error' });
    expect(quoted.execution.downgradedVerdicts).toEqual([]);

    const unquoted = await grade(RESPONSE, (g) => {
      g.forbidden['forbidden-001'] = ForbiddenVerdict.Present;
      g.evidence['forbidden-001'] = 'nothing like this appears';
    });
    expect(unquoted.score).toMatchObject({ score: 100, factualVerdict: 'pass' });
    expect(unquoted.execution.downgradedVerdicts).toEqual([
      {
        responseId: expect.stringMatching(/^response-/),
        factId: 'forbidden-001',
        from: 'present',
        to: 'absent',
        reason: 'quote_not_found',
      },
    ]);
    expect(JSON.parse(unquoted.score.raw).matchedForbidden).toEqual([]);
  });

  it('matches the quote after whitespace normalization on both sides', async () => {
    const { execution, score } = await grade(
      'A never\n   calls B\there.\nAll data flow terminates in browser localStorage.',
      (g) => {
        g.required['required-001'] = RequiredVerdict.Contradicted;
        g.evidence['required-001'] = '  A never calls B here.\n';
      },
    );
    expect(execution.downgradedVerdicts).toEqual([]);
    expect(score).toMatchObject({ score: 0, factualVerdict: 'major_error' });
  });

  it('keeps a present required fact whose minimal quote is found verbatim', async () => {
    const { execution, score } = await grade(RESPONSE, (g) => {
      g.evidence = {
        'required-001': 'A never calls B here.',
        'required-002': 'terminates in browser localStorage',
      };
    });
    expect(score).toMatchObject({ score: 100, factualVerdict: 'pass' });
    expect(execution.downgradedVerdicts).toEqual([]);
  });

  it('downgrades a present required fact carrying no quote to missing', async () => {
    const { execution, score } = await grade(RESPONSE, (g) => {
      g.evidence = { 'required-001': 'A never calls B here.' };
    });
    expect(score).toMatchObject({ score: 50, factualVerdict: 'minor_error' });
    expect(execution.downgradedVerdicts).toEqual([
      {
        responseId: expect.stringMatching(/^response-/),
        factId: 'required-002',
        from: 'present',
        to: 'missing',
        reason: 'missing_quote',
      },
    ]);
    expect(JSON.parse(score.raw).missingRequired).toEqual(['required-002']);
  });

  it('downgrades a present required fact whose quote was fabricated', async () => {
    const { execution, score } = await grade(RESPONSE, (g) => {
      g.evidence = {
        'required-001': 'A never calls B here.',
        'required-002': 'The result is written to the audit table.',
      };
    });
    expect(score).toMatchObject({ score: 50, factualVerdict: 'minor_error' });
    expect(execution.downgradedVerdicts).toEqual([
      {
        responseId: expect.stringMatching(/^response-/),
        factId: 'required-002',
        from: 'present',
        to: 'missing',
        reason: 'quote_not_found',
      },
    ]);
  });

  it('never gates a missing required fact or an absent forbidden fact on a quote', async () => {
    const { execution, score } = await grade(RESPONSE, (g) => {
      g.required['required-001'] = RequiredVerdict.Missing;
      g.required['required-002'] = RequiredVerdict.Missing;
      g.evidence = {};
    });
    expect(execution.downgradedVerdicts).toEqual([]);
    expect(score).toMatchObject({ score: 0, factualVerdict: 'minor_error' });
    expect(JSON.parse(score.raw).matchedForbidden).toEqual([]);
  });

  it('quotes another response rather than its own and loses the present credit', async () => {
    const batch = job([
      record('withMcp', 0, 'Ingestion writes into the events table.'),
      record('withoutMcp', 0, 'Ingestion drops every event on the floor.'),
    ]);
    const raw = JSON.parse(validRaw(batch));
    // The judge copies member[0]'s sentence into member[1]'s evidence.
    raw.grades[1].evidence['required-001'] = batch.members[0].response;
    const execution = await executeOracleBatchJob(
      batch,
      parseJudgeSpec('claude:judge'),
      '/tmp/last',
      { runner: async () => ({ raw: JSON.stringify(raw), usage: ZERO_USAGE }) },
    );
    expect(execution.downgradedVerdicts).toEqual([
      {
        responseId: batch.members[1].responseId,
        factId: 'required-001',
        from: 'present',
        to: 'missing',
        reason: 'quote_not_found',
      },
    ]);
    expect(execution.scores.get(batch.members[0].record)).toMatchObject({ score: 100 });
    expect(execution.scores.get(batch.members[1].record)).toMatchObject({ score: 50 });
  });

  it('records the downgrades on the stored artifact while keeping raw verbatim', async () => {
    const { batch, execution } = await grade(RESPONSE, (g) => {
      g.required['required-001'] = RequiredVerdict.Contradicted;
      delete g.evidence['required-001'];
    });
    const artifact = oracleBatchArtifact({
      job: batch,
      raw: execution.raw,
      usage: execution.usage,
      error: null,
      downgradedVerdicts: execution.downgradedVerdicts,
    });
    expect(artifact.downgradedVerdicts).toEqual(execution.downgradedVerdicts);
    expect(JSON.parse(artifact.raw).grades[0].required['required-001']).toBe('contradicted');
    expect(artifact.schemaVersion).toBe(1);
  });

  it('accepts an optional evidence object and rejects malformed evidence entries', () => {
    const batch = job([record('withMcp', 0, RESPONSE)]);
    const base = JSON.parse(validRaw(batch));
    delete base.grades[0].evidence;
    expect(parseOracleBatchResponse(JSON.stringify(base), batch)[0].evidence).toEqual({});
    base.grades[0].evidence = { 'required-001': 'A never calls B here.' };
    expect(parseOracleBatchResponse(JSON.stringify(base), batch)[0].evidence).toEqual({
      'required-001': 'A never calls B here.',
    });
    base.grades[0].evidence = { 'required-999': 'x' };
    expect(() => parseOracleBatchResponse(JSON.stringify(base), batch)).toThrow(/unknown fact ID/);
    base.grades[0].evidence = { 'required-001': 7 };
    expect(() => parseOracleBatchResponse(JSON.stringify(base), batch)).toThrow(/string quote/);
  });

  it('demands a minimal verbatim quote for present and hard-zeroing verdicts in the judge prompt', () => {
    const batch = job([record('withMcp', 0, RESPONSE)]);
    expect(batch.judgePrompt).toContain('verbatim quote');
    expect(batch.judgePrompt).toContain('"evidence"');
    expect(batch.judgePrompt).toContain('Every "present" required fact');
    expect(batch.judgePrompt).toContain('Keep every quote minimal');
    expect(batch.judgePrompt).toContain(
      '"missing" required facts and "absent" forbidden facts need no quote',
    );
  });

  it('requires affirmation for a forbidden "present" — a disclaimed or negated mention is absent', () => {
    // A2 authgate regression 2026-08-30: the agent explicitly held the negative
    // ("I cannot name a genuine UI caller ... from the parsed graph") while §4
    // restated the prompt's own premise as the request shape; the judge counted
    // the restatement as a present forbidden claim and hard-zeroed a
    // substantively correct answer. The rule below is what prevents that.
    const batch = job([record('withMcp', 0, RESPONSE)]);
    expect(batch.judgePrompt).toContain('AFFIRMS the claim as established fact');
    expect(batch.judgePrompt).toContain('the disclaimer wins');
    expect(batch.judgePrompt).toMatch(/restates the question's own premise/);
  });

  it('states the quote truncation cap in the judge prompt', () => {
    const batch = job([record('withMcp', 0, RESPONSE)]);
    expect(batch.judgePrompt).toContain(
      `Quotes are truncated to ${MAX_EVIDENCE_QUOTE_CHARS} characters before validation`,
    );
  });
});

describe('oracle batch wrong-location verdict', () => {
  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const RESPONSE = 'A calls B, wired up in src/wrong/place.ts.\nThe result is written downstream.';

  async function grade(mutate: (grade: Record<string, Record<string, string>>) => void) {
    const batch = job([record('withMcp', 0, RESPONSE)]);
    const raw = JSON.parse(validRaw(batch));
    mutate(raw.grades[0]);
    const execution = await executeOracleBatchJob(
      batch,
      parseJudgeSpec('claude:judge'),
      '/tmp/last',
      { runner: async () => ({ raw: JSON.stringify(raw), usage: ZERO_USAGE }) },
    );
    return { batch, execution, score: [...execution.scores.values()][0] };
  }

  it('scores a quoted wrong_location fact as no credit and no hard zero', async () => {
    const { execution, score } = await grade((g) => {
      g.required['required-001'] = RequiredVerdict.WrongLocation;
      g.evidence['required-001'] = 'A calls B, wired up in src/wrong/place.ts.';
    });
    expect(score).toMatchObject({ score: 50, factualVerdict: 'minor_error' });
    expect(execution.downgradedVerdicts).toEqual([]);
    const raw = JSON.parse(score.raw);
    expect(raw.wrongLocationRequired).toEqual(['required-001']);
    expect(raw.contradictedRequired).toEqual([]);
    expect(raw.missingRequired).toEqual([]);
  });

  it('zeroes a mixed batch only for contradicted, never for wrong_location', async () => {
    const wrongLocation = await grade((g) => {
      g.required['required-001'] = RequiredVerdict.WrongLocation;
    });
    expect(wrongLocation.score).toMatchObject({ score: 50, factualVerdict: 'minor_error' });

    const contradicted = await grade((g) => {
      g.required['required-001'] = RequiredVerdict.Contradicted;
    });
    expect(contradicted.score).toMatchObject({ score: 0, factualVerdict: 'major_error' });
  });

  it('downgrades an unquoted or fabricated wrong_location verdict to missing', async () => {
    const unquoted = await grade((g) => {
      g.required['required-001'] = RequiredVerdict.WrongLocation;
      delete g.evidence['required-001'];
    });
    expect(unquoted.execution.downgradedVerdicts).toEqual([
      {
        responseId: expect.stringMatching(/^response-/),
        factId: 'required-001',
        from: RequiredVerdict.WrongLocation,
        to: 'missing',
        reason: 'missing_quote',
      },
    ]);
    expect(JSON.parse(unquoted.score.raw).wrongLocationRequired).toEqual([]);
    expect(JSON.parse(unquoted.score.raw).missingRequired).toEqual(['required-001']);
    expect(unquoted.score).toMatchObject({ score: 50, factualVerdict: 'minor_error' });

    const fabricated = await grade((g) => {
      g.required['required-001'] = RequiredVerdict.WrongLocation;
      g.evidence['required-001'] = 'B calls A from src/other.ts.';
    });
    expect(fabricated.execution.downgradedVerdicts[0]).toMatchObject({
      factId: 'required-001',
      from: RequiredVerdict.WrongLocation,
      reason: 'quote_not_found',
    });
  });

  it('tallies post-downgrade verdicts on the execution and carries them onto the artifact', async () => {
    const { batch, execution } = await grade((g) => {
      g.required['required-001'] = RequiredVerdict.WrongLocation;
      g.required['required-002'] = RequiredVerdict.WrongLocation;
      g.evidence['required-002'] = 'a quote this response never contained';
    });
    expect(execution.verdictCounts).toEqual({
      required: { present: 0, missing: 1, contradicted: 0, wrong_location: 1 },
      forbidden: { present: 0, absent: 1 },
    });
    const artifact = oracleBatchArtifact({
      job: batch,
      raw: execution.raw,
      usage: execution.usage,
      error: null,
      downgradedVerdicts: execution.downgradedVerdicts,
      verdictCounts: execution.verdictCounts,
    });
    expect(artifact.verdictCounts).toEqual(execution.verdictCounts);
    expect(
      oracleBatchArtifact({ job: batch, raw: '', usage: execution.usage, error: 'boom' })
        .verdictCounts,
    ).toBeNull();
  });

  it('names all four required verdicts and the wrong_location boundary in the judge prompt', () => {
    const batch = job([record('withMcp', 0, RESPONSE)]);
    expect(batch.judgePrompt).toContain(
      'For every required fact classify exactly one of: present, missing, contradicted, wrong_location.',
    );
    expect(batch.judgePrompt).toContain(
      'Use "wrong_location" when the response states the required fact correctly in substance but cites the wrong file path, directory, or line for it; a claim about behaviour that the pinned source refutes is "contradicted", not "wrong_location"; a fact the response never mentions at all is "missing".',
    );
    expect(batch.judgePrompt).toContain('every "wrong_location" required fact');
  });
});

describe('oracle batch fence-tolerant parsing', () => {
  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  it('strips only a whole-reply fence and reports whether one was present', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toEqual({ text: '{"a":1}', wasFenced: true });
    expect(stripJsonFence('  ```\n{"a":1}\n```  ')).toEqual({ text: '{"a":1}', wasFenced: true });
    expect(stripJsonFence('{"a":1}')).toEqual({ text: '{"a":1}', wasFenced: false });
    expect(stripJsonFence('here is it:\n```json\n{"a":1}\n```')).toEqual({
      text: 'here is it:\n```json\n{"a":1}\n```',
      wasFenced: false,
    });
  });

  it('grades a fenced, an unlabelled-fence, and a bare reply identically', async () => {
    const batch = job([record('withMcp', 0, 'one'), record('withoutMcp', 0, 'two')]);
    const bare = validRaw(batch);
    const run = async (raw: string) => {
      const execution = await executeOracleBatchJob(
        batch,
        parseJudgeSpec('claude:judge'),
        '/tmp/last',
        { runner: async () => ({ raw, usage: ZERO_USAGE }) },
      );
      return [...execution.scores.values()].map(({ score, raw: gradeRaw }) => ({
        score,
        grade: JSON.parse(gradeRaw),
      }));
    };
    const expected = await run(bare);
    expect(await run(`\`\`\`json\n${bare}\n\`\`\``)).toEqual(expected);
    expect(await run(`\`\`\`\n${bare}\n\`\`\``)).toEqual(expected);
  });

  it('distinguishes malformed JSON with and without a fence and keeps raw verbatim', async () => {
    const batch = job([record('withMcp', 0, 'one')]);
    const attempt = async (raw: string) => {
      try {
        await executeOracleBatchJob(batch, parseJudgeSpec('claude:judge'), '/tmp/last', {
          runner: async () => ({ raw, usage: ZERO_USAGE }),
        });
        throw new Error('expected a parse failure');
      } catch (error) {
        expect(error).toBeInstanceOf(OracleBatchExecutionError);
        return error as OracleBatchExecutionError;
      }
    };
    const bare = await attempt('{bad json');
    expect(bare.message).toContain('no code fence detected');
    expect(bare.raw).toBe('{bad json');

    const fenced = await attempt('```json\n{bad json\n```');
    expect(fenced.message).toContain('after stripping the code fence');
    expect(fenced.raw).toBe('```json\n{bad json\n```');
  });
});

describe('oracle batch evidence-quote truncation', () => {
  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const LONG_RESPONSE = `Ingestion writes every row into the events table. ${'The pipeline then fans the rows out to the downstream consumers. '.repeat(
    10,
  )}`;

  async function gradeWithQuote(quote: string) {
    const batch = job([record('withMcp', 0, LONG_RESPONSE)]);
    const raw = JSON.parse(validRaw(batch));
    raw.grades[0].evidence['required-002'] = quote;
    const execution = await executeOracleBatchJob(
      batch,
      parseJudgeSpec('claude:judge'),
      '/tmp/last',
      { runner: async () => ({ raw: JSON.stringify(raw), usage: ZERO_USAGE }) },
    );
    return { execution, score: [...execution.scores.values()][0] };
  }

  it('keeps the verdict for an over-long quote whose truncated prefix is verbatim', async () => {
    const quote = LONG_RESPONSE.slice(0, MAX_EVIDENCE_QUOTE_CHARS + 200);
    expect(quote.length).toBeGreaterThan(MAX_EVIDENCE_QUOTE_CHARS);
    const { execution, score } = await gradeWithQuote(quote);
    expect(execution.downgradedVerdicts).toEqual([]);
    expect(score).toMatchObject({ score: 100, factualVerdict: 'pass' });
  });

  it('still downgrades an over-long fabricated quote', async () => {
    const quote = 'The result lands in the audit ledger instead. '.repeat(12);
    expect(quote.length).toBeGreaterThan(MAX_EVIDENCE_QUOTE_CHARS);
    const { execution, score } = await gradeWithQuote(quote);
    expect(execution.downgradedVerdicts).toEqual([
      {
        responseId: expect.stringMatching(/^response-/),
        factId: 'required-002',
        from: 'present',
        to: 'missing',
        reason: 'quote_not_found',
      },
    ]);
    expect(score).toMatchObject({ score: 50, factualVerdict: 'minor_error' });
  });
});

describe('oracle batch judge timeout', () => {
  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  it('scales the timeout with the number of graded responses', () => {
    expect(oracleBatchTimeoutMs(0)).toBe(ORACLE_BATCH_BASE_TIMEOUT_MS);
    expect(oracleBatchTimeoutMs(3)).toBe(
      ORACLE_BATCH_BASE_TIMEOUT_MS + 3 * ORACLE_BATCH_PER_RESPONSE_TIMEOUT_MS,
    );
    expect(oracleBatchTimeoutMs(2, 1_000)).toBe(1_000 + 2 * ORACLE_BATCH_PER_RESPONSE_TIMEOUT_MS);
  });

  it('passes the scaled timeout to the runner and honours a base override', async () => {
    const batch = job([record('withMcp', 0, 'one'), record('withoutMcp', 0, 'two')]);
    const runner = vi.fn().mockResolvedValue({ raw: validRaw(batch), usage: ZERO_USAGE });
    await executeOracleBatchJob(batch, parseJudgeSpec('claude:judge'), '/tmp/last', { runner });
    expect(runner.mock.calls[0][3]).toBe(oracleBatchTimeoutMs(batch.members.length));

    await executeOracleBatchJob(batch, parseJudgeSpec('claude:judge'), '/tmp/last', {
      runner,
      baseTimeoutMs: 1_000,
    });
    expect(runner.mock.calls[1][3]).toBe(oracleBatchTimeoutMs(batch.members.length, 1_000));
  });

  it('reports the batch cost when the runner itself fails', async () => {
    const batch = job([record('withMcp', 0, 'one'), record('withoutMcp', 0, 'two')]);
    await expect(
      executeOracleBatchJob(batch, parseJudgeSpec('claude:judge'), '/tmp/last', {
        runner: async () => {
          throw new Error('Claude judge timed out after 300000ms');
        },
      }),
    ).rejects.toThrow('Claude judge timed out after 300000ms (batch carried 2 response(s))');
  });
});
