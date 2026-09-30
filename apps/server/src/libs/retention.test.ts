import { describe, it, expect } from 'vitest';
import { parseRetentionDays, parseRetentionFlag } from './retention.js';

/**
 * Both helpers now take the RAW configured value (`src/config/app-config.ts`
 * owns the environment read). The vocabulary they apply to that value is
 * unchanged, and this file is what pins it.
 */
describe('parseRetentionFlag', () => {
  // The vocabulary is exact on purpose — see the helper's docstring.
  it.each([
    undefined,
    '',
    '0',
    'off',
    'no',
    'FALSE',
    ' false ',
    'anything',
  ])('keeps a default-on sweep enabled for %j', (raw) => {
    expect(parseRetentionFlag(raw, { defaultEnabled: true })).toBe(true);
  });

  it('disables a default-on sweep only on the literal "false"', () => {
    expect(parseRetentionFlag('false', { defaultEnabled: true })).toBe(false);
  });

  it.each([
    undefined,
    '',
    '1',
    'on',
    'yes',
    'TRUE',
    ' true ',
    'anything',
  ])('keeps a default-off sweep disabled for %j', (raw) => {
    expect(parseRetentionFlag(raw, { defaultEnabled: false })).toBe(false);
  });

  it('enables a default-off sweep only on the literal "true"', () => {
    expect(parseRetentionFlag('true', { defaultEnabled: false })).toBe(true);
  });
});

describe('parseRetentionDays', () => {
  it('uses the fallback when unset and the explicit value otherwise', () => {
    expect(parseRetentionDays(undefined, { fallback: 180 })).toBe(180);
    expect(parseRetentionDays('30', { fallback: 180 })).toBe(30);
  });

  it('clamps a non-positive window to one day instead of purging everything', () => {
    expect(parseRetentionDays('0', { fallback: 180 })).toBe(1);
    expect(parseRetentionDays('-30', { fallback: 180 })).toBe(1);
  });

  it('refuses an unreadable window when the caller asked to fail closed', () => {
    for (const raw of ['', ' ', 'not-a-number', 'Infinity', '0', '-1']) {
      expect(parseRetentionDays(raw, { fallback: 90, onInvalid: 'refuse' })).toBeNull();
    }
    expect(parseRetentionDays(undefined, { fallback: 90, onInvalid: 'refuse' })).toBe(90);
  });
});
