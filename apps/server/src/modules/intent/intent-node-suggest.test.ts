import { describe, expect, it } from 'vitest';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { nearestNodes, unknownNodeError } from './intent-node-suggest.js';

const DOMAINS = [
  { id: 'time-tracking', title: 'Time tracking and attendance' },
  { id: 'schedules', title: 'Schedules' },
  { id: 'payroll', title: 'Payroll' },
  { id: 'auth', title: 'Sign-in and sessions' },
];

describe('nearestNodes', () => {
  it('finds a node by a word of its title, and by a near spelling of its id', () => {
    expect(nearestNodes('attendance', DOMAINS).map((node) => node.id)).toEqual(['time-tracking']);
    expect(nearestNodes('scheduling', DOMAINS).map((node) => node.id)[0]).toBe('schedules');
  });

  it('suggests nothing for a word unlike any node', () => {
    expect(nearestNodes('zzz', DOMAINS)).toEqual([]);
  });
});

describe('unknownNodeError', () => {
  it('names the declared ids when nothing is close', () => {
    const body = unknownNodeError('domain', 'zzz', DOMAINS, ['domain']).publicError;
    expect(body.message).toContain('declared: auth, payroll, schedules, time-tracking');
  });

  it('names the nearest ids in the message and in details, inside the message bound', () => {
    const error = unknownNodeError('domain', 'attendance', DOMAINS, ['domain']);
    expect(error).toBeInstanceOf(IntentPublicException);
    const body = error.getResponse() as { code: string; message: string; details: { message: string }[] };
    expect(body.code).toBe(IntentErrorCode.DomainNotFound);
    expect(body.message).toContain('time-tracking');
    expect(body.message.length).toBeLessThanOrEqual(200);
    expect(body.details.map((detail) => detail.message)).toEqual(['time-tracking: Time tracking and attendance']);
  });
});
