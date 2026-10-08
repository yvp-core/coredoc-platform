import { describe, expect, it } from 'vitest';
import {
  mergeTimeline,
  pollInterval,
  spendText,
  timelineItems,
  waitingForRunnerSince,
} from './agent-run-presentation.js';
import type { AgentRun, AgentRunEvent } from './types.js';

function event(seq: number, type: string, payload: Record<string, unknown> = {}): AgentRunEvent {
  return { seq, type, payload, truncated: false, createdAt: '2026-10-10T09:00:00.000Z' };
}

describe('pollInterval', () => {
  it.each([
    ['queued', 3000],
    ['scoping', 3000],
    ['awaiting_answer', 3000],
    ['delivering', 3000],
    ['done', false],
    ['failed', false],
    ['cancelled', false],
  ] as const)('%s polls every %s', (status, expected) => {
    expect(pollInterval(status)).toBe(expected);
  });

  it('polls while the run has not loaded yet', () => {
    expect(pollInterval(undefined)).toBe(3000);
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

describe('timelineItems', () => {
  it('collapses consecutive raw activity into one group and describes the rest', () => {
    const items = timelineItems([
      event(1, 'status_changed', { from: 'queued', to: 'scoping' }),
      event(2, 'turn_started', { kind: 'scope', attempt: 1 }),
      event(3, 'raw', { text: '[init] model=default' }),
      event(4, 'raw', { text: '[tool] Read' }),
      event(5, 'phase', { phase: 'scoping' }),
      event(6, 'raw', { text: '[result]' }),
      event(7, 'turn_ended', { outcome: 'no_outcome', spendUsd: null }),
    ]);

    expect(items).toEqual([
      { kind: 'entry', seq: 1, text: 'Status: Scoping' },
      { kind: 'entry', seq: 2, text: 'Scope turn started (attempt 1)' },
      { kind: 'raw', seq: 3, lines: ['[init] model=default', '[tool] Read'] },
      { kind: 'entry', seq: 5, text: 'Phase: scoping' },
      { kind: 'raw', seq: 6, lines: ['[result]'] },
      { kind: 'entry', seq: 7, text: 'Turn ended without an outcome (spend not reported)' },
    ]);
  });

  it('describes questions: parked, answered at once, answered and cancelled', () => {
    const items = timelineItems([
      event(1, 'question', { state: 'open', headers: ['Colour', 'Formats'] }),
      event(2, 'turn_ended', { outcome: 'question_asked', spendUsd: 0.5 }),
      event(3, 'question_resolved', { state: 'answered' }),
      event(4, 'question', { state: 'auto_answered', headers: ['Colour'] }),
      event(5, 'question_resolved', { state: 'cancelled' }),
    ]);

    expect(items.map((item) => item.kind === 'entry' && item.text)).toEqual([
      'The agent asked a question: Colour, Formats',
      'Turn ended with a question for a person ($0.50)',
      'Question answered',
      'The agent asked: Colour; answered automatically (assume policy)',
      'Question cancelled: the run ended',
    ]);
  });

  it('shows run events by their text, and a withheld workflow diff with its paths, diff or note', () => {
    const withheld = {
      code: 'workflow_diff_withheld',
      text: 'Workflow changes withheld',
      paths: ['.github/workflows/ci.yml'],
    };
    expect(
      timelineItems([
        event(1, 'run_event', { code: 'branch_pushed', text: 'Pushed coredoc/PROJ-7 in orders-api' }),
        event(2, 'run_event', { ...withheld, diff: '+ on: push', note: null }),
        event(3, 'run_event', { ...withheld, diff: null, note: 'The diff is larger than 64 KiB.' }),
        event(4, 'run_event', {}),
      ]),
    ).toEqual([
      { kind: 'entry', seq: 1, text: 'Pushed coredoc/PROJ-7 in orders-api' },
      {
        kind: 'diff',
        seq: 2,
        text: 'Workflow changes withheld',
        paths: ['.github/workflows/ci.yml'],
        diff: '+ on: push',
        note: null,
      },
      {
        kind: 'diff',
        seq: 3,
        text: 'Workflow changes withheld',
        paths: ['.github/workflows/ci.yml'],
        diff: null,
        note: 'The diff is larger than 64 KiB.',
      },
      { kind: 'entry', seq: 4, text: 'Run event' },
    ]);
  });

  it('never throws on an event type or payload it does not know', () => {
    expect(timelineItems([event(1, 'something_new', { odd: [1, 2] })])).toEqual([
      { kind: 'entry', seq: 1, text: 'something_new' },
    ]);
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
