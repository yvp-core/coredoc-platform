import { describe, expect, it } from 'vitest';
import { AgentRunPhase } from '../../../../shared/agent-run-types';
import type { AgentRun } from '../../../stores/agent-run-store';
import type { RunningCommand } from '../../../stores/project-detail-store';
import { findAgentRunCommandId } from './agent-run';

function command(id: string, repoName: string, action: RunningCommand['action']): RunningCommand {
  return { id, repoName, action, startedAt: '2026-08-01T00:00:00Z', origin: 'single' };
}

const RUN: AgentRun = { phase: AgentRunPhase.Running, todos: [], pendingQuestion: null, rawLog: '' };

describe('findAgentRunCommandId', () => {
  it('selects the native agent run for the docked repository', () => {
    const generate = command('generate-api', 'api', 'generate');
    const parse = command('parse-api', 'api', 'parse');

    expect(
      findAgentRunCommandId(
        'api',
        new Map([
          [generate.id, generate],
          [parse.id, parse],
        ]),
        new Map([[generate.id, RUN]]),
      ),
    ).toBe(generate.id);
  });

  it('keeps the PTY terminal for a generate command without native agent events', () => {
    const generate = command('generate-api', 'api', 'generate');

    expect(findAgentRunCommandId('api', new Map([[generate.id, generate]]), new Map())).toBeNull();
  });

  it('does not show another repository agent run in this docked panel', () => {
    const generate = command('generate-web', 'web', 'generate');

    expect(findAgentRunCommandId('api', new Map([[generate.id, generate]]), new Map([[generate.id, RUN]]))).toBeNull();
  });
});
