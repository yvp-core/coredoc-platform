import { describe, expect, it } from 'vitest';
import { traceTurns } from './agent-run-trace.js';
import type { AgentRunEvent, AgentRunQuestion } from './types.js';

function raw(lines: string[]): AgentRunEvent[] {
  return lines.map((text, index) => ({
    seq: index + 1,
    turnId: 't1',
    type: 'raw',
    payload: { text },
    truncated: false,
    createdAt: '2026-10-10T16:11:00.000Z',
  }));
}

const rowsOf = (events: AgentRunEvent[], questions: AgentRunQuestion[] = []) =>
  traceTurns(events, [], questions)[0]!.rows.map((row) =>
    row.kind === 'call'
      ? [row.label, row.target, row.result ?? null, row.failed ? row.output : null]
      : row.kind === 'question'
        ? ['question', row.question.requestId]
        : [row.kind, row.text],
  );

describe('traceTurns with an older runner’s lines', () => {
  it('reads tool lines as calls and gives each result to the oldest call still waiting', () => {
    expect(
      rowsOf(
        raw([
          '[init] model=claude-sonnet-5-5',
          '[tool] Read {"file_path":"/scratch/runs/971c8d18/work/PRD.md"}',
          '[result] 1 # SCRUM-23: Fix mcp issues',
          '[tool] mcp__coredoc__get_intent_context {"sourceRefs":["jira:SCRUM-23"]}',
          '[tool] mcp__coredoc__search_symbols {"query":"staleness","limit":15}',
          '[result] { "mode": "context", "matches": [] …',
          '[result:error] Graph not found',
          '[tool] Skill {"skill":"coredoc-workflows:coredoc-spec"}',
          '[tool] Bash {"command":"cd /scratch/runs/971c8d18/work/coredoc-parser && pnpm test","description":"Run the te…',
          '[text] The status command prints a table today.',
          '[tool] mcp__agent_run__propose_scope {"specPath":"/scratch/runs/971c8d18/work/spec.md"}',
        ]),
      ),
    ).toEqual([
      ['line', '[init] model=claude-sonnet-5-5'],
      ['Read', 'PRD.md', '1 # SCRUM-23: Fix mcp issues', null],
      ['MCP', 'get_intent_context', '{ "mode": "context", "matches": [] …', null],
      ['MCP', 'search_symbols staleness 15', null, 'Graph not found'],
      ['Skill', 'coredoc-spec', null, null],
      ['Bash', 'cd coredoc-parser && pnpm test', null, null],
      ['message', 'The status command prints a table today.'],
      ['Run', 'propose_scope spec.md', null, null],
    ]);
  });

  it('pairs results streamed after the next call, and shows a result with no call waiting on its own', () => {
    expect(
      rowsOf(
        raw([
          '[tool] mcp__coredoc__explain {"name":"formatStalenessHeader"}',
          '[tool] mcp__coredoc__explain {"name":"searchSymbols"}',
          '[result] header docs',
          '[tool] mcp__coredoc__find_callers {"name":"formatStalenessHeader"}',
          '[result] search docs',
          '[result] 3 callers',
          '[result] stray',
          '[init] model=claude-sonnet-5-5',
          '[tool] Read {"file_path":"b.ts"}',
        ]),
      ),
    ).toEqual([
      ['MCP', 'explain formatStalenessHeader', 'header docs', null],
      ['MCP', 'explain searchSymbols', 'search docs', null],
      ['MCP', 'find_callers formatStalenessHeader', '3 callers', null],
      ['Result', 'stray', null, null],
      ['line', '[init] model=claude-sonnet-5-5'],
      ['Read', 'b.ts', null, null],
    ]);
  });

  it('keeps any other raw line as it is', () => {
    expect(rowsOf(raw(['[runner] no agent configured']))).toEqual([['line', '[runner] no agent configured']]);
  });
});

describe('traceTurns with questions', () => {
  const at = (minute: number) => `2026-10-10T16:${String(minute).padStart(2, '0')}:00.000Z`;
  const event = (seq: number, minute: number, type: string, payload: Record<string, unknown>): AgentRunEvent => ({
    seq,
    turnId: 't1',
    type,
    payload,
    truncated: false,
    createdAt: at(minute),
  });
  const question = (requestId: string, minute: number, askedInTurnId?: string): AgentRunQuestion => ({
    requestId,
    kind: 'clarification',
    phase: 'implement',
    state: 'answered',
    questions: [],
    answers: [],
    askedAt: at(minute),
    answeredAt: at(minute + 5),
    answeredBy: 'u1',
    ...(askedInTurnId === undefined ? {} : { askedInTurnId }),
  });

  it('puts each question in the turn that asked it, after what the turn did before asking', () => {
    const events = [
      event(1, 10, 'tool', { name: 'Read', target: 'a.ts', isError: false }),
      event(2, 12, 'question', { requestId: 'from-event' }),
      event(3, 14, 'tool', { name: 'Edit', target: 'a.ts', isError: false }),
    ];
    expect(
      rowsOf(events, [question('from-event', 12), question('from-column', 13, 't1'), question('elsewhere', 11, 't9')]),
    ).toEqual([
      ['Read', 'a.ts', null, null],
      ['question', 'from-event'],
      ['question', 'from-column'],
      ['Edit', 'a.ts', null, null],
    ]);
  });
});
