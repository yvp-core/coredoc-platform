import { describe, expect, it } from 'vitest';
import { mergeTimeline, pollInterval, spendText, waitingForRunnerSince } from './agent-run-presentation.js';
import type { AgentRun, AgentRunEvent } from './types.js';

function event(seq: number, type: string, payload: Record<string, unknown> = {}): AgentRunEvent {
  return { seq, type, payload, truncated: false, createdAt: '2026-10-10T09:00:00.000Z' };
}

describe('pollInterval', () => {
  it('polls until the run is terminal, including before it has loaded', () => {
    expect(pollInterval(undefined)).toBeTruthy();
    expect(pollInterval('awaiting_answer')).toBeTruthy();
    expect(pollInterval('done')).toBe(false);
    expect(pollInterval('cancelled')).toBe(false);
  });
});

describe('mergeTimeline', () => {
  it('appends forwards by sequence and drops events it already has', () => {
    const merged = mergeTimeline(
      [event(1, 'status_changed'), event(2, 'turn_started')],
      [event(4, 'raw'), event(2, 'turn_started'), event(3, 'phase')],
    );
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe('spendText', () => {
  it('shows spend against the budget', () => {
    expect(spendText({ usd: 0.25, maxUsd: 25, unknownTurns: 0 })).toBe('$0.25 of $25.00');
  });

  it('marks the total as partial when turns did not report spend, never as complete', () => {
    expect(spendText({ usd: 0, maxUsd: 25, unknownTurns: 2 })).toBe(
      '$0.00 of $25.00 (partial: 2 turns did not report spend)',
    );
  });
});

describe('waitingForRunnerSince', () => {
  const run = (currentTurn: AgentRun['currentTurn']) => ({ currentTurn }) as AgentRun;

  it('is the queue time while a turn waits for a runner', () => {
    const queuedAt = '2026-10-10T09:00:00.000Z';
    expect(
      waitingForRunnerSince(
        run({ id: 't', kind: 'scope', state: 'queued', ordinal: 1, attempt: 0, queuedAt, claimedAt: null }),
      ),
    ).toBe(queuedAt);
  });

  it('is null once a runner holds the turn, or when no turn is pending', () => {
    expect(
      waitingForRunnerSince(
        run({
          id: 't',
          kind: 'scope',
          state: 'claimed',
          ordinal: 1,
          attempt: 1,
          queuedAt: '2026-10-10T09:00:00.000Z',
          claimedAt: '2026-10-10T09:00:05.000Z',
        }),
      ),
    ).toBeNull();
    expect(waitingForRunnerSince(run(null))).toBeNull();
  });
});
