import { describe, expect, it } from 'vitest';
import { parseCoredocDeepLink } from './deep-link.js';

describe('parseCoredocDeepLink', () => {
  it('recognizes the explicit login action', () => {
    expect(parseCoredocDeepLink('coredoc://login')).toEqual({ type: 'login' });
    expect(parseCoredocDeepLink('coredoc://login/')).toEqual({ type: 'login' });
  });

  it('preserves an OAuth callback for the auth manager', () => {
    const url = 'coredoc://auth/callback?code=CODE&state=STATE';

    expect(parseCoredocDeepLink(url)).toEqual({ type: 'auth-callback', url });
  });

  it.each([
    'https://login',
    'coredoc://login?server=https://attacker.example',
    'coredoc://auth/other?code=CODE&state=STATE',
    'coredoc://unknown',
  ])('rejects unsupported or expanded protocol input: %s', (url) => {
    expect(() => parseCoredocDeepLink(url)).toThrow();
  });
});
