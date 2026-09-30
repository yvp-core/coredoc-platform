import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './time.js';

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-04T12:00:00Z');

  it.each([
    ['null', null, 'never'],
    ['just now (< 1 minute)', '2026-07-04T11:59:30Z', 'just now'],
    ['minutes ago', '2026-07-04T11:45:00Z', '15 minutes ago'],
    ['singular minute', '2026-07-04T11:59:00Z', '1 minute ago'],
    ['hours ago', '2026-07-04T09:00:00Z', '3 hours ago'],
    ['singular hour', '2026-07-04T11:00:00Z', '1 hour ago'],
    ['days ago', '2026-07-01T12:00:00Z', '3 days ago'],
    ['singular day (auto -> yesterday)', '2026-07-03T12:00:00Z', 'yesterday'],
    ['future timestamp', '2026-07-04T12:05:00Z', 'in 5 minutes'],
  ])('%s', (_label, input, expected) => {
    expect(formatRelativeTime(input, now)).toBe(expected);
  });
});
