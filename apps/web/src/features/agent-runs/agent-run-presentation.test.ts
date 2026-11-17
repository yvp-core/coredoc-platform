import { describe, expect, it } from 'vitest';
import {
  mergeTimeline,
  pollInterval,
  runnerVersionsText,
  spendText,
  subscriptionKeyText,
  waitingForRunnerSince,
} from './agent-run-presentation.js';
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

describe('runnerVersionsText', () => {
  it('names the manifest’s workflows, their models and the plugins after the tool versions', () => {
    expect(
      runnerVersionsText({
        runner: '1.9.0',
        claudeCode: '2.1.285',
        plugin: '0.14.0',
        manifest: {
          digest: 'sha256:abc',
          plugins: [{ name: 'coredoc-workflows', version: '0.14.0' }, { name: 'day-agent-run' }],
          workflows: [
            {
              id: 'default',
              title: 'Jira issue to pull requests',
              phases: [
                { id: 'scope', gate: 'acceptance', model: 'claude-opus-5-5' },
                { id: 'implement', gate: 'none' },
              ],
            },
            { id: 'contract-review', title: 'Contract review', phases: [{ id: 'report', gate: 'none' }] },
          ],
        },
      }),
    ).toBe(
      'runner 1.9.0 · claude code 2.1.285 · plugin 0.14.0 · workflows: default (scope claude-opus-5-5), contract-review · plugins: coredoc-workflows 0.14.0, day-agent-run',
    );
  });

  it('still reads a row a runner reported before workflows', () => {
    expect(runnerVersionsText({ runner: '1.8.0', manifest: { plugins: [{ name: 'day-agent-run' }] } })).toBe(
      'runner 1.8.0 · plugins: day-agent-run',
    );
  });

  it('leaves the subscription keys to their own lines', () => {
    const key = { label: 'a', active: true, exhaustedUntil: null, fiveHour: null, sevenDay: null, checkedAt: null };
    expect(runnerVersionsText({ runner: '1.9.0', subscriptionKeys: [key] })).toBe('runner 1.9.0');
  });
});

describe('subscriptionKeyText', () => {
  const now = new Date('2026-11-17T12:00:00.000Z');

  it('shows the key in use with both windows and when each resets', () => {
    expect(
      subscriptionKeyText(
        {
          label: 'alice',
          active: true,
          exhaustedUntil: null,
          fiveHour: { utilization: 41.6, resetsAt: '2026-11-17T14:00:00.000Z' },
          sevenDay: { utilization: 17, resetsAt: '2026-11-20T12:00:00.000Z' },
          checkedAt: '2026-11-17T11:55:00.000Z',
        },
        now,
      ),
    ).toBe('alice · in use · 5 h 42% (resets in 2 hours) · week 17% (resets in 3 days) · read 5 minutes ago');
  });

  it('shows a key at its limit with the time it comes back, and windows the runner has not read', () => {
    expect(
      subscriptionKeyText(
        {
          label: 'bob',
          active: false,
          exhaustedUntil: '2026-11-17T15:00:00.000Z',
          fiveHour: { utilization: 100, resetsAt: '2026-11-17T15:00:00.000Z' },
          sevenDay: null,
          checkedAt: null,
        },
        now,
      ),
    ).toBe('bob · at its limit, back in 3 hours · 5 h 100% (resets in 3 hours) · week — · not read yet');
  });
});
