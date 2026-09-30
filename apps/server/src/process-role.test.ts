import { describe, expect, it } from 'vitest';
import { parseProcessRole } from './process-role.js';

describe('parseProcessRole', () => {
  it.each([
    [undefined, 'all'],
    ['', 'all'],
    ['api', 'api'],
    ['worker', 'worker'],
    ['all', 'all'],
  ] as const)('maps %s to %s', (raw, expected) => {
    expect(parseProcessRole(raw)).toBe(expected);
  });

  it.each(['API', 'workers', 'web', ' api ', '0'])('rejects unsupported role %s', (raw) => {
    expect(() => parseProcessRole(raw)).toThrow(`Invalid PROCESS_ROLE="${raw}"`);
  });
});
