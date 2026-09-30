import { describe, it, expect } from 'vitest';
import { applyAgentRunEvent, initialAgentRun } from './agent-run-store';
import { AgentRunEventType, AgentRunPhase, AgentTodoStatus, type AgentRunQuestion } from '../../shared/agent-run-types';

const QUESTION: AgentRunQuestion = {
  question: 'What coverage scope?',
  header: 'Coverage',
  multiSelect: false,
  options: [
    { label: 'Full repo', description: 'all packages' },
    { label: 'One app', description: 'single app' },
  ],
};

describe('applyAgentRunEvent', () => {
  it('sets phase', () => {
    const run = applyAgentRunEvent(initialAgentRun(), { type: AgentRunEventType.Phase, phase: AgentRunPhase.Running });
    expect(run.phase).toBe(AgentRunPhase.Running);
  });

  it('replaces todos wholesale', () => {
    const run = applyAgentRunEvent(initialAgentRun(), {
      type: AgentRunEventType.Todos,
      items: [{ text: 'Draft profile', status: AgentTodoStatus.InProgress }],
    });
    expect(run.todos).toEqual([{ text: 'Draft profile', status: AgentTodoStatus.InProgress }]);
  });

  it('sets and clears a pending question', () => {
    let run = applyAgentRunEvent(initialAgentRun(), {
      type: AgentRunEventType.Question,
      requestId: 'q1',
      questions: [QUESTION],
    });
    expect(run.pendingQuestion?.requestId).toBe('q1');

    run = applyAgentRunEvent(run, { type: AgentRunEventType.QuestionResolved, requestId: 'q1' });
    expect(run.pendingQuestion).toBeNull();
  });

  it('ignores QuestionResolved for a stale requestId', () => {
    const run = applyAgentRunEvent(
      { ...initialAgentRun(), pendingQuestion: { requestId: 'q2', questions: [QUESTION] } },
      { type: AgentRunEventType.QuestionResolved, requestId: 'q1' },
    );
    expect(run.pendingQuestion?.requestId).toBe('q2');
  });

  it('appends raw log lines with newlines', () => {
    let run = applyAgentRunEvent(initialAgentRun(), { type: AgentRunEventType.Raw, text: '[tool] Read a.ts' });
    run = applyAgentRunEvent(run, { type: AgentRunEventType.Raw, text: '[denied] Bash: curl' });
    expect(run.rawLog).toBe('[tool] Read a.ts\n[denied] Bash: curl\n');
  });

  it('marks done (success) and records cost, clearing any pending question', () => {
    const run = applyAgentRunEvent(
      { ...initialAgentRun(), pendingQuestion: { requestId: 'q1', questions: [QUESTION] } },
      { type: AgentRunEventType.Done, ok: true, costUsd: 0.12, sessionId: 's1' },
    );
    expect(run.phase).toBe(AgentRunPhase.Done);
    expect(run.costUsd).toBe(0.12);
    expect(run.pendingQuestion).toBeNull();
  });

  it('marks error phase and captures the message on failure', () => {
    const run = applyAgentRunEvent(initialAgentRun(), {
      type: AgentRunEventType.Done,
      ok: false,
      error: 'boom',
    });
    expect(run.phase).toBe(AgentRunPhase.Error);
    expect(run.error).toBe('boom');
  });
});
