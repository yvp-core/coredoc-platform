import { describe, expect, it } from 'vitest';
import { conversationItems, durationText, runSpan, runStages, stageTarget } from './agent-run-page.js';
import type { AgentRunDetail, AgentRunEvent, AgentRunSpec, AgentRunTurnActivity } from './types.js';

const at = (hour: number, minute: number) =>
  `2026-10-10T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;

function status(seq: number, to: string, time: string): AgentRunEvent {
  return { seq, type: 'status_changed', payload: { to }, truncated: false, createdAt: time };
}

function run(overrides: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return {
    id: 'r1',
    issueKey: 'PROJ-7',
    status: 'done',
    phase: 'delivery',
    trigger: 'manual',
    startedBy: 'u1',
    previousRunId: null,
    runOwner: { userId: 'u1', email: null },
    questionsPolicy: 'pause',
    scopeAcceptancePolicy: 'required',
    model: null,
    branch: 'coredoc/PROJ-7',
    seeds: [],
    failureCode: null,
    failureReason: null,
    spend: { usd: 0, maxUsd: 5, unknownTurns: 0 },
    currentTurn: null,
    createdAt: at(13, 58),
    startedAt: at(13, 58),
    finishedAt: at(15, 23),
    issueUrl: null,
    latestSpec: null,
    repositories: [],
    droppedSeeds: [],
    assumptions: [],
    openQuestion: null,
    questions: [],
    ...overrides,
  };
}

const LIFE = [
  status(1, 'queued', at(13, 58)),
  status(2, 'scoping', at(13, 58)),
  status(3, 'awaiting_scope_acceptance', at(14, 9)),
  status(4, 'scoping', at(14, 21)),
  status(5, 'awaiting_scope_acceptance', at(14, 26)),
  status(6, 'implementing', at(14, 28)),
  status(7, 'awaiting_answer', at(14, 47)),
  status(8, 'implementing', at(14, 55)),
  status(9, 'delivering', at(15, 21)),
  status(10, 'done', at(15, 23)),
];

describe('runStages', () => {
  it('folds the queue into the next stage and a question’s wait into the stage it interrupts, numbering repeats', () => {
    const stages = runStages(run(), LIFE, new Date(at(16, 0)));
    expect(
      stages.map((stage) => [stage.name, stage.startedAt, stage.durationSeconds / 60, stage.waitingSeconds / 60]),
    ).toEqual([
      ['Scope', at(13, 58), 11, 0],
      ['Review', at(14, 9), 12, 12],
      ['Scope v2', at(14, 21), 5, 0],
      ['Review v2', at(14, 26), 2, 2],
      ['Implement', at(14, 28), 53, 8],
      ['Delivery', at(15, 21), 2, 0],
    ]);
    expect(runSpan(run(), stages, new Date(at(16, 0)))).toEqual({
      startedAt: at(13, 58),
      endedAt: at(15, 23),
      durationSeconds: 85 * 60,
    });
  });

  it('keeps the last stage open and counting while the run is active, events in any order', () => {
    const active = run({ status: 'awaiting_answer', finishedAt: null });
    const stages = runStages(active, [...LIFE.slice(0, 7)].reverse(), new Date(at(14, 50)));
    const last = stages.at(-1)!;
    expect([last.name, last.endedAt, last.durationSeconds / 60, last.waitingSeconds / 60]).toEqual([
      'Implement',
      null,
      22,
      3,
    ]);
    expect(runSpan(active, stages, new Date(at(14, 50))).endedAt).toBeNull();
  });

  it('has no stages before the first status change, and ignores what it does not know', () => {
    expect(runStages(run({ status: 'queued', finishedAt: null }), [], new Date(at(14, 0)))).toEqual([]);
    expect(
      runStages(
        run(),
        [{ seq: 1, type: 'status_changed', payload: {}, truncated: false, createdAt: at(14, 0) }],
        new Date(),
      ),
    ).toEqual([]);
  });
});

describe('durationText', () => {
  it.each([
    [45, '45 s'],
    [11 * 60, '11 min'],
    [85 * 60, '1 h 25 min'],
    [120 * 60, '2 h'],
  ])('%s s reads %s', (seconds, text) => {
    expect(durationText(seconds)).toBe(text);
  });
});

function spec(version: number, specStatus: AgentRunSpec['status'], proposedAt: string, reviewedAt: string | null) {
  return {
    version,
    status: specStatus,
    title: `v${version}`,
    summary: '',
    markdown: '',
    repositories: [],
    risks: [],
    intentReferences: [],
    assumptions: [],
    droppedSeeds: [],
    candidates: [],
    proposedAt,
    reviewedBy: reviewedAt ? 'u1' : null,
    reviewedAt,
    reviewText: specStatus === 'changes_requested' ? 'Keep the table' : null,
    autoAccepted: false,
  } satisfies AgentRunSpec;
}

function turn(ordinal: number, kind: AgentRunTurnActivity['kind'], startedAt: string): AgentRunTurnActivity {
  return {
    id: `t${ordinal}`,
    ordinal,
    kind,
    state: 'completed',
    outcome: null,
    startedAt,
    endedAt: null,
    durationSeconds: 60,
    spendUsd: null,
    toolCalls: 1,
    failedToolCalls: 0,
  };
}

describe('conversationItems', () => {
  const finished = run({
    latestSpec: spec(2, 'accepted', at(14, 26), at(14, 27)),
    questions: [
      {
        requestId: 'q1',
        kind: 'clarification',
        phase: 'implement',
        state: 'answered',
        questions: [],
        answers: [],
        askedAt: at(14, 47),
        answeredAt: at(14, 55),
        answeredBy: 'u1',
      },
    ],
    result: { summary: 'Added --format json', repositories: [], notes: '' },
    pullRequests: [
      {
        repository: 'cli',
        number: 131,
        url: 'https://github.com/o/cli/pull/131',
        state: 'open',
        draft: true,
        created: true,
        verifiedAt: at(15, 23),
      },
    ],
  });
  const specs = [spec(1, 'changes_requested', at(14, 9), at(14, 21)), spec(2, 'proposed', at(14, 26), null)];
  const turns = [
    turn(1, 'scope', at(13, 58)),
    turn(2, 'scope', at(14, 21)),
    turn(3, 'implement', at(14, 28)),
    turn(4, 'implement', at(14, 55)),
    turn(5, 'delivery', at(15, 21)),
    { ...turn(6, 'implement', at(16, 0)), startedAt: null },
  ];
  const events: AgentRunEvent[] = [
    {
      seq: 9,
      type: 'result',
      payload: { summary: 'Added', points: ['cli: JSON mode'] },
      truncated: false,
      createdAt: at(15, 19),
    },
  ];

  it('orders proposals, reviews, questions, the result and delivery with one line per started turn', () => {
    const items = conversationItems(finished, specs, turns, events);
    expect(items.map((item) => item.id)).toEqual([
      'started',
      'turn-t1',
      'spec-1',
      'review-1',
      'turn-t2',
      'spec-2',
      'accepted-2',
      'turn-t3',
      'question-q1',
      'turn-t4',
      'result',
      'turn-t5',
      'delivery',
      'ended',
    ]);
    const result = items.find((item) => item.kind === 'result');
    expect(result?.kind === 'result' && result.points).toEqual(['cli: JSON mode']);
  });

  it('offers the review actions on the newest proposal only while the run waits for acceptance', () => {
    const waiting = run({ status: 'awaiting_scope_acceptance', finishedAt: null, latestSpec: specs[1]! });
    const reviewable = conversationItems(waiting, specs, [], [])
      .filter((item) => item.kind === 'proposal')
      .map((item) => item.kind === 'proposal' && item.reviewable);
    expect(reviewable).toEqual([false, true]);
  });

  it('jumps from a stage to the last thing that happened in it', () => {
    const items = conversationItems(finished, specs, turns, events);
    const stages = runStages(finished, LIFE, new Date(at(16, 0)));
    expect(stages.map((stage) => stageTarget(stage, items))).toEqual([
      'spec-1',
      'review-1',
      'spec-2',
      'accepted-2',
      'result',
      'ended',
    ]);
  });
});
