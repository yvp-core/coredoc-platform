import { existsSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  buildCodexJudgeArgs,
  buildCodexRawJudgeArgs,
  DEFAULT_JUDGE_SPEC,
  JudgeBackend,
  formatJudgeSpec,
  hasGroundedSourceInspection,
  judgeWithSpec,
  parseJudgeSpec,
  withIsolatedCodexJudgeCwd,
  type CodexJudgeOpts,
  type JudgeRunners,
} from './judge-codex.js';
import { JUDGE_MODEL, buildJudgePrompt, type JudgeOpts } from './judge.js';
import { emptyUsage } from './judge.js';
import type { JudgeScore } from './types.js';

function score(raw: string): JudgeScore {
  return { score: 0, judgeStatus: 'completed', dimensions: [], raw, usage: emptyUsage() };
}

/** Records which backend was called with what; never spawns anything. */
function spyRunners(): {
  runners: JudgeRunners;
  claudeCalls: JudgeOpts[];
  codexCalls: CodexJudgeOpts[];
} {
  const claudeCalls: JudgeOpts[] = [];
  const codexCalls: CodexJudgeOpts[] = [];
  return {
    claudeCalls,
    codexCalls,
    runners: {
      claude: async (opts) => {
        claudeCalls.push(opts);
        return score('claude');
      },
      codex: async (opts) => {
        codexCalls.push(opts);
        return score('codex');
      },
    },
  };
}

const JUDGE_INPUT: JudgeOpts = {
  prompt: 'Explain `src/a.ts`.',
  responseText: 'It calls mcp__coredoc__explain and returns a summary.',
  dimensions: ['accuracy', 'grounding'],
  rubricDescription: 'Score accuracy and grounding.',
};

describe('parseJudgeSpec', () => {
  it('parses backend:model and derives a filesystem-safe slug', () => {
    expect(parseJudgeSpec('codex:gpt-6-sol')).toEqual({
      backend: JudgeBackend.Codex,
      model: 'gpt-6-sol',
      slug: 'codex-gpt-6-sol',
    });
  });

  it('rejects an unknown backend and a missing model', () => {
    expect(() => parseJudgeSpec('gemini:pro')).toThrow(/Unknown judge backend/);
    expect(() => parseJudgeSpec('codex:')).toThrow(/Expected "<backend>:<model>"/);
  });
});

describe('DEFAULT_JUDGE_SPEC', () => {
  it('is the pinned claude judge, so an unflagged run is unchanged', () => {
    expect(DEFAULT_JUDGE_SPEC.backend).toBe(JudgeBackend.Claude);
    expect(DEFAULT_JUDGE_SPEC.model).toBe(JUDGE_MODEL);
    expect(formatJudgeSpec(DEFAULT_JUDGE_SPEC)).toBe(`claude:${JUDGE_MODEL}`);
  });
});

describe('judgeWithSpec', () => {
  it('routes a claude spec to the claude backend with the spec model', async () => {
    const { runners, claudeCalls, codexCalls } = spyRunners();
    const result = await judgeWithSpec(
      {
        spec: parseJudgeSpec('claude:claude-sonnet-5'),
        judge: JUDGE_INPUT,
        codexLastMessagePath: '/evals/last.txt',
      },
      runners,
    );
    expect(result.raw).toBe('claude');
    expect(codexCalls).toHaveLength(0);
    expect(claudeCalls[0]).toMatchObject({ ...JUDGE_INPUT, model: 'claude-sonnet-5' });
  });

  it('routes a codex spec to the codex backend with the claude-identical rubric prompt', async () => {
    const { runners, claudeCalls, codexCalls } = spyRunners();
    const result = await judgeWithSpec(
      {
        spec: parseJudgeSpec('codex:gpt-6-sol'),
        judge: JUDGE_INPUT,
        codexLastMessagePath: '/evals/run-0/codex-judge-last-message.txt',
      },
      runners,
    );
    expect(result.raw).toBe('codex');
    expect(claudeCalls).toHaveLength(0);
    expect(codexCalls[0]).toEqual({
      // Byte-identical to what judgeRun builds for the claude backend — the
      // model must be the only variable between judges.
      prompt: buildJudgePrompt(JUDGE_INPUT),
      dimensions: JUDGE_INPUT.dimensions,
      model: 'gpt-6-sol',
      lastMessagePath: '/evals/run-0/codex-judge-last-message.txt',
    });
  });
});

describe('Codex judge filesystem isolation', () => {
  it('pins the raw oracle batch judge to its empty cwd with no MCP', () => {
    const args = buildCodexRawJudgeArgs(
      {
        prompt: 'grade the batch',
        model: 'gpt-6-sol',
        lastMessagePath: '/out/last.txt',
      },
      '/empty-judge-cwd',
    );
    expect(args).toEqual(expect.arrayContaining(['-C', '/empty-judge-cwd']));
    expect(args).toContain('default_permissions="coredoc-eval-historyless"');
    expect(args.some((arg) => arg.startsWith('mcp_servers.'))).toBe(false);
  });

  it('runs from a harness-owned empty temp cwd and removes it afterward', async () => {
    let observed = '';
    await withIsolatedCodexJudgeCwd(async (cwd) => {
      observed = cwd;
      expect(readdirSync(cwd)).toEqual([]);
      expect(existsSync(cwd)).toBe(true);
    });
    expect(observed).not.toBe('');
    expect(existsSync(observed)).toBe(false);
  });

  it('uses cwd-only historyless permissions and no MCP for a grounded workspace', () => {
    const args = buildCodexJudgeArgs(
      {
        prompt: 'judge',
        dimensions: ['accuracy'],
        model: 'gpt-6-sol',
        lastMessagePath: '/out/last.txt',
        historylessWorkspaceRoot: '/source-only',
      },
      '/source-only',
      'judge',
    );
    expect(args).toEqual(expect.arrayContaining(['-C', '/source-only']));
    expect(args).toContain('default_permissions="coredoc-eval-historyless"');
    expect(args.some((arg) => arg.startsWith('mcp_servers.'))).toBe(false);
  });

  it('counts only a successful completed shell command as grounded source inspection', () => {
    const completed = {
      type: 'item.completed',
      item: { type: 'command_execution', status: 'completed', exit_code: 0 },
    };
    expect(hasGroundedSourceInspection([completed])).toBe(true);
    expect(
      hasGroundedSourceInspection([
        { ...completed, item: { ...completed.item, exit_code: 1 } },
      ]),
    ).toBe(false);
    expect(
      hasGroundedSourceInspection([
        { type: 'item.completed', item: { type: 'agent_message', status: 'completed' } },
      ]),
    ).toBe(false);
    expect(
      hasGroundedSourceInspection([
        completed,
        { type: 'item.completed', item: { type: 'mcp_tool_call', status: 'completed' } },
      ]),
    ).toBe(false);
  });
});
