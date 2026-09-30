import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CASE_RUBRICS,
  CODEX_JUDGE_RETRY_REMINDER,
  JudgeBackend,
  applyJudgeRepair,
  createGroundedWorkspace,
  extractJudgeJsonObject,
  makeVerdict,
  originalJudgeLabel,
  parseCodexJudgeResponse,
  parseJudgeSpec,
  parseRejudgeArgs,
  planJobs,
  renderRejudgeReport,
  summarizeRejudge,
  type RejudgeVerdict,
} from './rejudge-cases.js';
import { type Arm, type CaseId, type RunRecord } from './types.js';
import { sha256 } from './provenance.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeSourceRepo(root: string, name: string): { path: string; sha: string } {
  const path = join(root, name);
  mkdirSync(path);
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.email', 'test@example.com');
  git(path, 'config', 'user.name', 'Test');
  writeFileSync(join(path, 'source.ts'), `${name} pinned\n`);
  mkdirSync(join(path, 'evals'));
  mkdirSync(join(path, '.scratch'));
  writeFileSync(join(path, 'evals', 'oracle.json'), 'secret\n');
  writeFileSync(join(path, '.scratch', 'truth.md'), 'secret\n');
  symlinkSync('source.ts', join(path, 'source-link.ts'));
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'pinned');
  const sha = git(path, 'rev-parse', 'HEAD');
  writeFileSync(join(path, 'source.ts'), `${name} future\n`);
  git(path, 'add', 'source.ts');
  git(path, 'commit', '-m', 'future');
  return { path, sha };
}

function verdict(
  caseId: CaseId,
  arm: Arm,
  runIndex: number,
  origJudge: number,
  newJudge: number,
): RejudgeVerdict {
  return {
    target: 'demo',
    case: caseId,
    arm,
    runIndex,
    origJudge,
    newJudge,
  };
}

describe('parseJudgeSpec', () => {
  it('splits backend and model and derives a filesystem-safe slug', () => {
    expect(parseJudgeSpec('codex:gpt-6-sol')).toEqual({
      backend: JudgeBackend.Codex,
      model: 'gpt-6-sol',
      slug: 'codex-gpt-6-sol',
    });
    expect(parseJudgeSpec('claude:claude-sonnet-5')).toEqual({
      backend: JudgeBackend.Claude,
      model: 'claude-sonnet-5',
      slug: 'claude-claude-sonnet-5',
    });
  });

  it('rejects an unknown backend or a malformed spec', () => {
    expect(() => parseJudgeSpec('gemini:pro')).toThrow(/Unknown judge backend/);
    expect(() => parseJudgeSpec('claude')).toThrow(/Expected "<backend>:<model>"/);
    expect(() => parseJudgeSpec('claude:')).toThrow(/Expected "<backend>:<model>"/);
  });
});

describe('parseRejudgeArgs', () => {
  it('parses the full flag set', () => {
    const opts = parseRejudgeArgs([
      '--from',
      'runs/x',
      '--judge',
      'codex:gpt-6-sol',
      '--case=explain-function,blast-radius',
      '--arm=withMcp',
      '--concurrency=3',
      '--dry',
      '--grounded-historyless',
    ]);
    expect(opts.from).toBe('runs/x');
    expect(opts.judge.backend).toBe(JudgeBackend.Codex);
    expect([...(opts.cases ?? [])]).toEqual(['explain-function', 'blast-radius']);
    expect(opts.arms).toEqual(['withMcp']);
    expect(opts.concurrency).toBe(3);
    expect(opts.dry).toBe(true);
    expect(opts.groundedHistoryless).toBe(true);
  });

  it('defaults concurrency to 6 and leaves case/arm unfiltered', () => {
    const opts = parseRejudgeArgs(['--from', 'runs/x', '--judge', 'claude:claude-opus-5-5']);
    expect(opts.concurrency).toBe(6);
    expect(opts.cases).toBeNull();
    expect(opts.arms).toBeNull();
    expect(opts.dry).toBe(false);
    expect(opts.missingOnly).toBe(false);
    expect(opts.groundedHistoryless).toBe(false);
  });

  it('supports an explicit missing-only repair sweep', () => {
    const opts = parseRejudgeArgs([
      '--from=runs/x',
      '--judge=codex:gpt-6-sol',
      '--missing-only',
    ]);
    expect(opts.missingOnly).toBe(true);
  });

  it('requires --from and --judge, and rejects unknown case/arm ids', () => {
    expect(() => parseRejudgeArgs(['--judge', 'claude:x'])).toThrow(/--from is required/);
    expect(() => parseRejudgeArgs(['--from', 'runs/x'])).toThrow(/--judge is required/);
    expect(() =>
      parseRejudgeArgs(['--from', 'r', '--judge', 'claude:x', '--case=not-a-case']),
    ).toThrow(/Unknown --case/);
    expect(() => parseRejudgeArgs(['--from', 'r', '--judge', 'claude:x', '--arm=withMCP'])).toThrow(
      /Unknown --arm/,
    );
    expect(() =>
      parseRejudgeArgs([
        '--from=r',
        '--judge=claude:claude-opus-5-5',
        '--grounded-historyless',
      ]),
    ).toThrow(/Codex judge/i);
  });
});

describe('grounded historyless workspace', () => {
  it('materializes only exact target and cell-pinned source while stripping self-eval oracles', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-grounded-'));
    try {
      const target = makeSourceRepo(root, 'target');
      const sibling = makeSourceRepo(root, 'sibling');
      const manifestPath = join(root, 'target.json');
      const targetManifest = `${JSON.stringify({
        schemaVersion: 2,
        name: 'demo',
        path: target.path,
        repoKey: 'target',
        gitSha: target.sha,
        cells: {
          'cross-repo-trace': {
            lifecycle: 'diagnostic',
            repoRevisions: {
              sibling: { path: sibling.path, gitSha: sibling.sha },
            },
          },
        },
      })}\n`;
      writeFileSync(manifestPath, targetManifest);

      const runDir = join(root, 'run');
      const artifactDir = join(
        runDir,
        'runs',
        'demo',
        'cross-repo-trace',
        'withMcp',
        'run-0',
      );
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'prompt.txt'), 'trace it');
      writeFileSync(join(artifactDir, 'response.md'), 'answer');
      writeFileSync(
        join(runDir, 'run-manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          models: {
            judgeProvider: 'codex',
            judgeModel: 'gpt-6-sol',
          },
          targets: [
            {
              manifestPath,
              manifestHash: sha256(targetManifest),
              repoKey: 'target',
              requestedGitSha: target.sha,
              actualVerifierGitSha: target.sha,
              actualAgentGitSha: target.sha,
            },
          ],
          cells: [
            {
              target: 'demo',
              case: 'cross-repo-trace',
              promptHash: sha256('trace it'),
              repoRevisions: {
                sibling: { requestedGitSha: sibling.sha },
              },
            },
          ],
        }),
      );
      const record = {
        target: 'demo',
        case: 'cross-repo-trace',
        arm: 'withMcp',
        runIndex: 0,
        agent: { responseText: 'answer' },
      } as unknown as RunRecord;

      const workspace = createGroundedWorkspace({
        runDir,
        record,
        harnessRepoRoot: target.path,
      });
      try {
        expect(workspace.repositories.map(({ repoKey }) => repoKey)).toEqual([
          'target',
          'sibling',
        ]);
        const targetDir = join(workspace.root, workspace.repositories[0]!.directory);
        const siblingDir = join(workspace.root, workspace.repositories[1]!.directory);
        expect(readFileSync(join(targetDir, 'source.ts'), 'utf8')).toBe('target pinned\n');
        expect(readFileSync(join(siblingDir, 'source.ts'), 'utf8')).toBe('sibling pinned\n');
        expect(existsSync(join(targetDir, 'evals'))).toBe(false);
        expect(existsSync(join(targetDir, '.scratch'))).toBe(false);
        expect(existsSync(join(siblingDir, 'evals', 'oracle.json'))).toBe(true);
        expect(existsSync(join(targetDir, '.git'))).toBe(false);
        expect(existsSync(join(targetDir, 'source-link.ts'))).toBe(false);
        expect(existsSync(join(workspace.root, 'run-manifest.json'))).toBe(false);
      } finally {
        workspace.cleanup();
      }
      expect(originalJudgeLabel(runDir)).toBe('codex:gpt-6-sol');
      writeFileSync(manifestPath, `${targetManifest} `);
      expect(() =>
        createGroundedWorkspace({ runDir, record, harnessRepoRoot: target.path }),
      ).toThrow(/recorded manifest hash/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('missing-only repair', () => {
  it('preserves agent/programmatic data and changes only judge fields', () => {
    const record = {
      target: 'demo',
      case: 'blast-radius',
      arm: 'withMcp',
      runIndex: 0,
      agentStatus: 'completed',
      judgeStatus: 'missing',
      programmatic: { score: 75, details: { hit: true } },
      judge: { score: null, dimensions: [], raw: 'judge failed', usage: {} },
      agent: { responseText: 'answer', error: null },
      final: null,
    } as unknown as RunRecord;
    const replacement = {
      score: 80,
      judgeStatus: 'completed' as const,
      dimensions: [{ name: 'accuracy', value: 8 }],
      raw: '{"accuracy":8}',
      usage: {} as RunRecord['judge']['usage'],
    };
    const repaired = applyJudgeRepair(record, replacement);
    expect(repaired.agent).toEqual(record.agent);
    expect(repaired.programmatic).toEqual(record.programmatic);
    expect(repaired.judge).toEqual(replacement);
    expect(repaired.judgeStatus).toBe('completed');
    expect(repaired.final).toBeNull();
  });

  it('skips a missing-only record whose saved prompt is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-rejudge-'));
    try {
      const record = {
        target: 'demo',
        case: 'blast-radius',
        arm: 'withMcp',
        runIndex: 0,
        agentStatus: 'completed',
        judgeStatus: 'missing',
        programmatic: { score: 75, details: {} },
        judge: { score: null, dimensions: [], raw: '', usage: {} },
        agent: { responseText: 'answer', error: null },
      } as unknown as RunRecord;
      const artifact = join(root, 'runs', 'demo', 'blast-radius', 'withMcp', 'run-0');
      mkdirSync(artifact, { recursive: true });
      writeFileSync(join(artifact, 'response.md'), 'answer');
      const plan = planJobs(root, [record], {
        cases: null,
        arms: null,
        missingOnly: true,
      });
      expect(plan.jobs).toEqual([]);
      expect(plan.skipped[0]?.reason).toMatch(/prompt\.txt missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs a completed empty terminal answer instead of inferring DNF from length', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-rejudge-empty-'));
    try {
      const record = {
        target: 'demo',
        case: 'blast-radius',
        arm: 'withMcp',
        runIndex: 0,
        agentStatus: 'completed',
        judgeStatus: 'missing',
        programmatic: { score: 0, details: {} },
        judge: { score: null, dimensions: [], raw: '', usage: {} },
        agent: { responseText: '', error: null },
      } as unknown as RunRecord;
      const artifact = join(root, 'runs', 'demo', 'blast-radius', 'withMcp', 'run-0');
      mkdirSync(artifact, { recursive: true });
      writeFileSync(join(artifact, 'prompt.txt'), 'prompt');
      writeFileSync(join(artifact, 'response.md'), '');
      const plan = planJobs(root, [record], {
        cases: null,
        arms: null,
        missingOnly: true,
      });
      expect(plan.jobs).toHaveLength(1);
      expect(plan.skipped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CASE_RUBRICS', () => {
  it('covers every case id the harness can produce', () => {
    for (const [id, rubric] of Object.entries(CASE_RUBRICS)) {
      expect(rubric.dimensions.length, id).toBeGreaterThan(0);
      expect(rubric.description.length, id).toBeGreaterThan(0);
    }
  });
});

describe('makeVerdict', () => {
  it('compares only the judge endpoint and ignores historical blended final data', () => {
    const record = {
      target: 'demo',
      case: 'explain-function',
      arm: 'withMcp',
      runIndex: 1,
      programmatic: { score: 80, details: {} },
      judge: { score: 90, dimensions: [], raw: '', usage: {} },
      final: 999,
    } as unknown as RunRecord;
    expect(makeVerdict(record, 60)).toEqual({
      target: 'demo',
      case: 'explain-function',
      arm: 'withMcp',
      runIndex: 1,
      origJudge: 90,
      newJudge: 60,
    });
  });
});

describe('summarizeRejudge', () => {
  const verdicts = [
    // withMcp: judge 90 → 60 (new judge much harsher)
    verdict('explain-function', 'withMcp', 0, 90, 60),
    verdict('explain-function', 'withMcp', 1, 90, 60),
    // withoutMcp: judge 80 → 78 (barely moved)
    verdict('explain-function', 'withoutMcp', 0, 80, 78),
    verdict('explain-function', 'withoutMcp', 1, 80, 78),
  ];

  it('reports per-cell medians and the judge delta', () => {
    const { cells } = summarizeRejudge(verdicts);
    expect(cells).toHaveLength(2);
    const withMcp = cells.find((c) => c.arm === 'withMcp')!;
    expect(withMcp.n).toBe(2);
    expect(withMcp.origJudgeMedian).toBe(90);
    expect(withMcp.newJudgeMedian).toBe(60);
    expect(withMcp.judgeDelta).toBe(-30);
  });

  it('means the per-run shift per arm — the asymmetry is the bias signal', () => {
    const { armShifts } = summarizeRejudge(verdicts);
    expect(armShifts.find((s) => s.arm === 'withMcp')).toEqual({
      arm: 'withMcp',
      n: 2,
      meanJudgeDelta: -30,
    });
    expect(armShifts.find((s) => s.arm === 'withoutMcp')).toEqual({
      arm: 'withoutMcp',
      n: 2,
      meanJudgeDelta: -2,
    });
  });

  it('flags a case whose arm winner flips under the new judge', () => {
    const { ranks, flipped } = summarizeRejudge(verdicts);
    expect(ranks).toHaveLength(1);
    expect(ranks[0]!.origWinner).toBe('withMcp'); // 90 vs 80
    expect(ranks[0]!.newWinner).toBe('withoutMcp'); // 60 vs 78
    expect(flipped.map((r) => r.case)).toEqual(['explain-function']);
  });

  it('does not flip when the ranking survives the new judge', () => {
    const stable = [
      verdict('blast-radius', 'withMcp', 0, 90, 70),
      verdict('blast-radius', 'withoutMcp', 0, 80, 60),
    ];
    const { flipped, ranks } = summarizeRejudge(stable);
    expect(ranks[0]!.origWinner).toBe('withMcp');
    expect(ranks[0]!.newWinner).toBe('withMcp');
    expect(flipped).toEqual([]);
  });

  it('skips the rank comparison when only one arm was re-judged', () => {
    const oneArm = [verdict('type-impact', 'withMcp', 0, 90, 70)];
    const summary = summarizeRejudge(oneArm);
    expect(summary.ranks).toEqual([]);
    expect(summary.armShifts.map((s) => s.arm)).toEqual(['withMcp']);
  });
});

describe('renderRejudgeReport', () => {
  const summary = summarizeRejudge([
    verdict('explain-function', 'withMcp', 0, 90, 60),
    verdict('explain-function', 'withoutMcp', 0, 80, 78),
  ]);
  const report = renderRejudgeReport({
    runDir: '/runs/demo',
    judge: parseJudgeSpec('codex:gpt-6-sol'),
    origJudgeModel: 'claude-opus-5-5',
    summary,
    skipped: [
      { target: 'demo', case: 'blast-radius', arm: 'withMcp', runIndex: 2, reason: 'prompt.txt missing' },
    ],
    generatedAt: '2026-08-21T00:00:00.000Z',
  });

  it('renders the three required sections', () => {
    expect(report).toContain('## Per-cell scores');
    expect(report).toContain('## Aggregate shift per arm (the bias signal)');
    expect(report).toContain('## Rank stability (withMcp vs withoutMcp winner)');
    expect(report).not.toMatch(/Final|60\/40|mean Δ final/i);
  });

  it('states the arm gap with numbers and names the favoured arm', () => {
    expect(report).toContain('withMcp by -30.0');
    expect(report).toContain('withoutMcp by -2.0');
    expect(report).toContain('gap -28.0');
    expect(report).toContain('more generous to **withMcp**');
  });

  it('lists flipped cells explicitly and counts skipped runs', () => {
    expect(report).toContain('Flipped cells: demo/explain-function (withMcp → withoutMcp)');
    expect(report).toContain('skipped: 1');
    expect(report).toContain('prompt.txt missing');
  });
});

describe('codex judge parsing', () => {
  it('accepts a bare JSON object', () => {
    const r = parseCodexJudgeResponse('{"accuracy": 7, "completeness": 9}', [
      'accuracy',
      'completeness',
    ]);
    expect(r.ok).toBe(true);
    expect(r.dimensions).toEqual([
      { name: 'accuracy', value: 7 },
      { name: 'completeness', value: 9 },
    ]);
    expect(r.score).toBe(80);
  });

  it('accepts a fenced object and one wrapped in prose', () => {
    expect(parseCodexJudgeResponse('```json\n{"accuracy":5}\n```', ['accuracy']).ok).toBe(true);
    expect(
      parseCodexJudgeResponse('Here are my scores:\n{"accuracy":5}\nHope that helps.', ['accuracy'])
        .ok,
    ).toBe(true);
  });

  it('flags a reply that is prose, or that omits a dimension, as not ok', () => {
    // parseJudgeJson would silently return 0 for both — indistinguishable from
    // a genuine zero, which is exactly why `ok` exists.
    const prose = parseCodexJudgeResponse('I think the answer was quite good overall.', [
      'accuracy',
    ]);
    expect(prose.ok).toBe(false);
    expect(prose.score).toBe(0);

    const partial = parseCodexJudgeResponse('{"accuracy": 8}', ['accuracy', 'completeness']);
    expect(partial.ok).toBe(false);

    const nonNumeric = parseCodexJudgeResponse('{"accuracy": "high"}', ['accuracy']);
    expect(nonNumeric.ok).toBe(false);
  });

  it('requires real workspace-relative source citations only for grounded scoring', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-evidence-'));
    mkdirSync(join(root, 'repo-0', 'src'), { recursive: true });
    writeFileSync(join(root, 'repo-0', 'src', 'a.ts'), 'one\ntwo\n');
    const withoutEvidence = '{"accuracy":8}';
    expect(parseCodexJudgeResponse(withoutEvidence, ['accuracy']).ok).toBe(true);
    expect(parseCodexJudgeResponse(withoutEvidence, ['accuracy'], true, root).ok).toBe(false);
    expect(
      parseCodexJudgeResponse(
        '{"accuracy":8,"_evidence":["repo-0/src/a.ts:2"]}',
        ['accuracy'],
        true,
        root,
      ).ok,
    ).toBe(true);
    expect(
      parseCodexJudgeResponse(
        '{"accuracy":8,"_evidence":["repo-0/src/a.ts:3"]}',
        ['accuracy'],
        true,
        root,
      ).ok,
    ).toBe(false);
    expect(
      parseCodexJudgeResponse(
        '{"accuracy":8,"_evidence":["repo-0/../outside.ts:1"]}',
        ['accuracy'],
        true,
        root,
      ).ok,
    ).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('extractJudgeJsonObject returns null for arrays and unparseable text', () => {
    expect(extractJudgeJsonObject('[1,2,3]')).toBeNull();
    expect(extractJudgeJsonObject('not json at all')).toBeNull();
    expect(extractJudgeJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('the retry reminder demands verbatim JSON and is appended, not substituted', () => {
    const prompt = 'RUBRIC PROMPT';
    const retryPrompt = `${prompt}\n\n${CODEX_JUDGE_RETRY_REMINDER}`;
    expect(retryPrompt.startsWith(prompt)).toBe(true);
    expect(CODEX_JUDGE_RETRY_REMINDER).toMatch(/verbatim JSON only/);
  });
});
