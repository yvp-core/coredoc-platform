// evals/cases-planning/tasks.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNING_TASKS, scopedTaskPrompt } from './tasks.js';
import { planningTarget } from './target.js';

describe('planning tasks', () => {
  // On-disk check only applies when a real workspace is configured — the
  // committed tasks reference example repos that don't ship with this repo.
  it.runIf(Boolean(process.env.COREDOC_EVAL_WORKSPACE_ROOT))('every task names repos that exist on disk', () => {
    for (const t of PLANNING_TASKS) {
      for (const repo of t.repos) {
        expect(existsSync(join(planningTarget.workspaceRoot, repo)), `${t.id}: ${repo}`).toBe(true);
      }
    }
  });

  it('prompts contain no MCP/tool hints (fair to the baseline)', () => {
    for (const t of PLANNING_TASKS) {
      expect(t.prompt).not.toMatch(/mcp__|coredoc|trace_cross_repo/i);
    }
  });

  it('scopedTaskPrompt includes Scope: and each repo for a multi-repo task', () => {
    const task = PLANNING_TASKS[0]!;
    const result = scopedTaskPrompt(task);
    expect(result).toContain('Scope:');
    for (const repo of task.repos) {
      expect(result).toContain(repo);
    }
  });
});
