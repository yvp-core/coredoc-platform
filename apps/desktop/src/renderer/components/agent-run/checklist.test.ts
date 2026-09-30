import { describe, it, expect } from 'vitest';
import { buildChecklist, currentActivityLabel, AUTHORING_PHASES } from './checklist';
import { AgentTodoStatus } from '../../../shared/agent-run-types';

describe('buildChecklist', () => {
  it('seeds all five phases as pending when there are no todos', () => {
    const rows = buildChecklist([]);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.text)).toEqual(AUTHORING_PHASES);
    expect(rows.every((r) => r.status === AgentTodoStatus.Pending && r.kind === 'phase')).toBe(true);
  });

  it('applies exact-match statuses from the agent todos', () => {
    const rows = buildChecklist([
      { text: 'Ground in repo shape', status: AgentTodoStatus.Completed },
      { text: 'Scout conventions', status: AgentTodoStatus.InProgress },
    ]);
    expect(rows[0].status).toBe(AgentTodoStatus.Completed);
    expect(rows[1].status).toBe(AgentTodoStatus.InProgress);
    expect(rows[2].status).toBe(AgentTodoStatus.Pending);
  });

  it('matches phases fuzzily (case / punctuation / minor wording)', () => {
    const rows = buildChecklist([
      { text: 'score & iterate on the draft', status: AgentTodoStatus.InProgress },
      { text: 'DRAFT PROFILE', status: AgentTodoStatus.Completed },
    ]);
    expect(rows.find((r) => r.text === 'Draft profile')?.status).toBe(AgentTodoStatus.Completed);
    expect(rows.find((r) => r.text === 'Score & iterate')?.status).toBe(AgentTodoStatus.InProgress);
  });

  it('inserts unmatched todos as sub-tasks under the in-progress phase', () => {
    const rows = buildChecklist([
      { text: 'Draft profile', status: AgentTodoStatus.InProgress },
      { text: 'Handle the GraphQL resolvers', status: AgentTodoStatus.Pending },
    ]);
    const draftIdx = rows.findIndex((r) => r.text === 'Draft profile');
    expect(rows[draftIdx + 1]).toMatchObject({ text: 'Handle the GraphQL resolvers', kind: 'subtask' });
  });

  it('does not let a trivial todo hijack a phase', () => {
    const rows = buildChecklist([{ text: 'go', status: AgentTodoStatus.Completed }]);
    // 'go' is too short to match any phase → all phases pending, 'go' a subtask.
    expect(rows.filter((r) => r.kind === 'phase').every((r) => r.status === AgentTodoStatus.Pending)).toBe(true);
    expect(rows.some((r) => r.kind === 'subtask' && r.text === 'go')).toBe(true);
  });
});

describe('currentActivityLabel', () => {
  it('returns the in-progress phase text', () => {
    const rows = buildChecklist([{ text: 'Scout conventions', status: AgentTodoStatus.InProgress }]);
    expect(currentActivityLabel(rows)).toBe('Scout conventions');
  });

  it('falls back to a start label before anything begins', () => {
    expect(currentActivityLabel(buildChecklist([]))).toBe('Starting authoring agent…');
  });

  it('falls back to a wrap-up label when work has completed but nothing is active', () => {
    const rows = buildChecklist([{ text: 'Finalize profile', status: AgentTodoStatus.Completed }]);
    expect(currentActivityLabel(rows)).toBe('Wrapping up…');
  });
});
