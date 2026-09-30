import { describe, expect, it } from 'vitest';
import { externalHttpsUrl } from './external-url';

describe('externalHttpsUrl', () => {
  it.each([
    'https://github.com/acme/backend/pull/42',
    // An ordinary documentation link: query and fragment are not a threat.
    'https://coredoc.ai/docs?tab=1#section',
  ])('accepts %s', (value) => {
    expect(externalHttpsUrl(value)).toBe(value);
  });

  it.each([
    ['http://example.com', 'not https'],
    ['javascript:alert(1)', 'not a url scheme we open'],
    ['file:///etc/passwd', 'local file'],
    ['https://user:pw@example.com', 'credentials'],
    ['https://exam\nple.com/p', 'control character the parser would strip'],
    ['https://example.com/a b', 'whitespace the parser would encode'],
    [`https://example.com/${'a'.repeat(2_048)}`, 'over the length cap'],
    [undefined, 'absent'],
  ])('refuses %s (%s)', (value: string | undefined, _reason: string) => {
    expect(externalHttpsUrl(value)).toBeNull();
  });
});
