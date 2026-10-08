import { describe, expect, it } from 'vitest';
import { evaluateToolUse } from './tool-policy.js';

describe('runner tool policy', () => {
  it.each([
    ['WebSearch', { query: 'x' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['EnterWorktree', {}],
    ['CronCreate', { schedule: '* * * * *' }],
    ['ScheduleWakeup', {}],
  ])('denies %s', (tool, input) => {
    expect(evaluateToolUse(tool, input)).toMatchObject({ decision: 'deny' });
  });

  it.each([
    'git commit -m "wip"',
    'git push origin HEAD',
    'cd repo && git checkout -b feature',
    'git fetch origin',
    'gh pr create --draft',
  ])('denies the git write or pull request command `%s`: the runner commits, pushes and opens pull requests', (command) => {
    const verdict = evaluateToolUse('Bash', { command });
    expect(verdict).toMatchObject({ decision: 'deny' });
    expect(verdict.decision === 'deny' && verdict.reason).toMatch(/runner/i);
  });

  it('answers AskUserQuestion with the assume-style instruction until questions are bridged', () => {
    const verdict = evaluateToolUse('AskUserQuestion', { questions: [] });
    expect(verdict).toMatchObject({ decision: 'deny' });
    expect(verdict.decision === 'deny' && verdict.reason).toMatch(/assumptions/);
  });

  it.each([
    ['Bash', { command: 'git status && git diff --stat' }],
    ['Bash', { command: 'git log --oneline -5' }],
    ['Read', { file_path: '/scratch/work/PRD.md' }],
    ['Skill', { skill: 'coredoc-workflows:spec' }],
    ['mcp__coredoc__search_symbols', { query: 'Order' }],
    ['mcp__agent_run__propose_scope', { title: 'x' }],
  ])('allows %s, leaving its input unchanged', (tool, input) => {
    expect(evaluateToolUse(tool, input)).toEqual({ decision: 'allow' });
  });
});
