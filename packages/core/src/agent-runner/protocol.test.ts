import { describe, expect, it } from 'vitest';
import { EventBatchSchema } from './protocol.js';

describe('runner event batches', () => {
  it('accept the agent events a runner reports', () => {
    const batch = EventBatchSchema.parse({
      events: [
        { type: 'phase', phase: 'scoping' },
        { type: 'todos', items: [{ text: 'Read the PRD', status: 'in_progress' }] },
        { type: 'raw', text: '[tool] Read' },
        { type: 'message', text: 'Reading the PRD.' },
        { type: 'skill', name: 'coredoc-workflows:coredoc-spec' },
        { type: 'tool', name: 'Bash', target: 'pnpm test', summary: '2 failed', isError: true, errorOutput: 'FAIL' },
        { type: 'result', summary: 'Added CSV exports.', points: ['orders-api: New endpoint'] },
        { type: 'done', ok: true, costUsd: 0.12 },
      ],
    });
    expect(batch.events.map((event) => event.type)).toEqual([
      'phase',
      'todos',
      'raw',
      'message',
      'skill',
      'tool',
      'result',
      'done',
    ]);
  });

  it.each([
    'status_changed',
    'turn_started',
    'turn_ended',
    'run_event',
  ])('refuse the server-owned %s event, so a runner cannot forge the timeline', (type) => {
    expect(EventBatchSchema.safeParse({ events: [{ type, to: 'done' }] }).success).toBe(false);
  });
});
