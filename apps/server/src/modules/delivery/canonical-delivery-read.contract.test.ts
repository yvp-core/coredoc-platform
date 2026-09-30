import { Buffer } from 'node:buffer';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  decodeDeliveryCursor,
  deliveryCursorScope,
  encodeDeliveryCursor,
  InvalidDeliveryCursorError,
  parseDeliveryPageLimit,
  parseLifecycleFilter,
} from './canonical-delivery-read.contract.js';

const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TASK_ID = 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UPDATED_AT = '2026-08-17T12:34:56.789Z';

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('canonical delivery bounded read contract', () => {
  it('binds the task-summary cursor scope to the population filters while keeping the legacy scope', () => {
    expect(deliveryCursorScope.taskSummaries(null, 'all')).toBe('task-summaries');
    expect(deliveryCursorScope.taskSummaries({ days: 30 }, 'shipped')).toBe('task-summaries:30:shipped');
    // A custom calendar range and the member filter are part of the cursor identity too.
    expect(deliveryCursorScope.taskSummaries({ since: '2026-08-01', until: '2026-08-31' }, 'all')).toBe(
      'task-summaries:2026-08-01..2026-08-31:all',
    );
    expect(deliveryCursorScope.taskSummaries(null, 'all', 'user-1')).toBe('task-summaries:all:all:user:user-1');
    expect(deliveryCursorScope.taskSummaries({ days: 30 }, 'shipped', 'user-1')).toBe(
      'task-summaries:30:shipped:user:user-1',
    );
    // Two different members never share a cursor identity.
    expect(deliveryCursorScope.taskSummaries({ days: 30 }, 'all', 'user-1')).not.toBe(
      deliveryCursorScope.taskSummaries({ days: 30 }, 'all', 'user-2'),
    );

    const filtered = encodeDeliveryCursor(deliveryCursorScope.taskSummaries({ days: 30 }, 'shipped'), [
      UPDATED_AT,
      TASK_ID,
    ]);
    expect(
      decodeDeliveryCursor(filtered, deliveryCursorScope.taskSummaries({ days: 30 }, 'shipped'), [
        'timestamp',
        'task_id',
      ] as const),
    ).toEqual([new Date(UPDATED_AT), TASK_ID]);
    for (const otherScope of [
      deliveryCursorScope.taskSummaries({ days: 30 }, 'all'),
      deliveryCursorScope.taskSummaries({ days: 7 }, 'shipped'),
      deliveryCursorScope.taskSummaries(null, 'all'),
      deliveryCursorScope.taskSummaries({ days: 30 }, 'shipped', 'user-42'),
      deliveryCursorScope.taskSummaries({ since: '2026-08-01', until: '2026-08-31' }, 'shipped'),
    ]) {
      expect(() => decodeDeliveryCursor(filtered, otherScope, ['timestamp', 'task_id'] as const)).toThrow(
        InvalidDeliveryCursorError,
      );
    }
  });

  it('defaults the lifecycle filter to all and refuses any other value', () => {
    expect(parseLifecycleFilter(undefined)).toBe('all');
    for (const accepted of ['all', 'shipped', 'active', 'rework', 'runs'] as const) {
      expect(parseLifecycleFilter(accepted)).toBe(accepted);
    }
    for (const invalid of [null, '', 'ALL', 'done', 7, ['shipped']]) {
      expect(() => parseLifecycleFilter(invalid)).toThrow(BadRequestException);
    }
  });

  it('defaults to 50 and accepts only canonical decimal limits from 1 through 100', () => {
    expect(parseDeliveryPageLimit(undefined)).toBe(50);
    expect(parseDeliveryPageLimit('1')).toBe(1);
    expect(parseDeliveryPageLimit('100')).toBe(100);

    for (const invalid of [null, '', '0', '01', '1.0', ' 1', '101', 50]) {
      expect(() => parseDeliveryPageLimit(invalid)).toThrow();
    }
  });

  it('round-trips a canonical route-scoped summary cursor to typed values', () => {
    const scope = deliveryCursorScope.taskSummaries(null, 'all');
    const cursor = encodeDeliveryCursor(scope, [UPDATED_AT, TASK_ID]);

    expect(decodeDeliveryCursor(cursor, scope, ['timestamp', 'task_id'] as const)).toEqual([
      new Date(UPDATED_AT),
      TASK_ID,
    ]);
  });

  it.each([
    '2026-02-31T00:00:00.000Z',
    '2026-08-17T24:00:00.000Z',
  ])('rejects normalized ordinary timestamp %s before query construction', (timestamp) => {
    const scope = deliveryCursorScope.taskSummaries(null, 'all');
    const cursor = rawCursor({ v: 1, scope, key: [timestamp, TASK_ID] });

    expect(() => decodeDeliveryCursor(cursor, scope, ['timestamp', 'task_id'] as const)).toThrow(
      InvalidDeliveryCursorError,
    );
  });

  it.each([
    '2026-02-31T00:00:00.000Z',
    '2026-08-17T24:00:00.000Z',
  ])('rejects normalized non-null nullable timestamp %s before query construction', (timestamp) => {
    const scope = deliveryCursorScope.taskCodeChanges(TASK_ID);
    const cursor = rawCursor({
      v: 1,
      scope,
      key: [timestamp, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    });

    expect(() => decodeDeliveryCursor(cursor, scope, ['nullable_timestamp', 'uuid'] as const)).toThrow(
      InvalidDeliveryCursorError,
    );
  });

  it('accepts canonical server-issued UTC millisecond timestamps for ordinary and nullable keys', () => {
    const summaryScope = deliveryCursorScope.taskSummaries(null, 'all');
    const codeChangeScope = deliveryCursorScope.taskCodeChanges(TASK_ID);

    expect(
      decodeDeliveryCursor(encodeDeliveryCursor(summaryScope, [UPDATED_AT, TASK_ID]), summaryScope, [
        'timestamp',
        'task_id',
      ] as const),
    ).toEqual([new Date(UPDATED_AT), TASK_ID]);
    expect(
      decodeDeliveryCursor(
        encodeDeliveryCursor(codeChangeScope, [UPDATED_AT, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']),
        codeChangeScope,
        ['nullable_timestamp', 'uuid'] as const,
      ),
    ).toEqual([new Date(UPDATED_AT), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
  });

  it('preserves exact database timestamp precision for self-contained run and artifact keys', () => {
    const exactTimestamp = '2026-08-17T12:34:56.789123Z';
    const scope = deliveryCursorScope.taskRuns(TASK_ID);
    const cursor = encodeDeliveryCursor(scope, [exactTimestamp, 'cdr-20260817-a1b2c3']);

    expect(decodeDeliveryCursor(cursor, scope, ['exact_timestamp', 'run_id'] as const)).toEqual([
      exactTimestamp,
      'cdr-20260817-a1b2c3',
    ]);
  });

  it.each([
    '2026-02-31T00:00:00.000Z',
    '2026-08-17T12:34:56.789123+00:00',
    '0000-01-01T00:00:00.000Z',
  ])('rejects impossible or non-canonical exact database timestamp %s before SQL', (timestamp) => {
    const scope = deliveryCursorScope.taskRuns(TASK_ID);
    const cursor = rawCursor({ v: 1, scope, key: [timestamp, 'cdr-20260817-a1b2c3'] });

    expect(() => decodeDeliveryCursor(cursor, scope, ['exact_timestamp', 'run_id'] as const)).toThrow(
      InvalidDeliveryCursorError,
    );
  });

  it('keeps resource identity in a nested cursor scope', () => {
    const cursor = encodeDeliveryCursor(deliveryCursorScope.taskRuns(TASK_ID), [UPDATED_AT, 'cdr-20260817-a1b2c3']);

    expect(() =>
      decodeDeliveryCursor(cursor, deliveryCursorScope.taskRuns(OTHER_TASK_ID), ['timestamp', 'run_id'] as const),
    ).toThrow(InvalidDeliveryCursorError);
  });

  it('accepts the frozen nullable source time for code-change ordering', () => {
    const scope = deliveryCursorScope.taskCodeChanges(TASK_ID);
    const cursor = encodeDeliveryCursor(scope, [null, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']);

    expect(decodeDeliveryCursor(cursor, scope, ['nullable_timestamp', 'uuid'] as const)).toEqual([
      null,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
  });

  it.each([
    ['malformed base64url', 'not+base64'],
    ['non-canonical padded base64url', `${rawCursor({ v: 1, scope: 'task-summaries', key: [UPDATED_AT, TASK_ID] })}=`],
    ['wrong version', rawCursor({ v: 2, scope: 'task-summaries', key: [UPDATED_AT, TASK_ID] })],
    ['wrong shape', rawCursor({ v: 1, scope: 'task-summaries', key: [UPDATED_AT, TASK_ID], extra: true })],
    ['wrong tuple arity', rawCursor({ v: 1, scope: 'task-summaries', key: [UPDATED_AT] })],
    ['wrong tuple type', rawCursor({ v: 1, scope: 'task-summaries', key: [UPDATED_AT, 'not-a-task'] })],
    ['oversized encoded input', 'a'.repeat(2_049)],
    [
      'oversized decoded JSON',
      rawCursor({ v: 1, scope: 'task-summaries', key: [UPDATED_AT, `cdt_${'a'.repeat(1_100)}`] }),
    ],
  ])('rejects %s with the closed cursor error', (_label, cursor) => {
    expect(() =>
      decodeDeliveryCursor(cursor, deliveryCursorScope.taskSummaries(null, 'all'), ['timestamp', 'task_id'] as const),
    ).toThrow(InvalidDeliveryCursorError);
  });
});
