import { describe, expect, it } from 'vitest';
import { MAX_REDACTED_CHARS, redactPayload, redactSecrets } from './redact-secrets.js';

describe('redactSecrets', () => {
  it.each([
    [
      'a GitHub classic token',
      'pushing with ghp_0123456789abcdefghijABCDEFGHIJ012345 now',
      'pushing with [REDACTED] now',
    ],
    [
      'a fine-grained GitHub token',
      'token github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'token [REDACTED]',
    ],
    ['a model key', 'ANTHROPIC key sk-ant-api03-AbCdEf0123456789_xyz-QRS', 'ANTHROPIC key [REDACTED]'],
    ['a Coredoc token', 'cdt_' + 'ab'.repeat(32), '[REDACTED]'],
    ['an AWS access key id', 'aws AKIAIOSFODNN7EXAMPLE configured', 'aws [REDACTED] configured'],
    ['a Slack token', 'xoxb-1234567890-abcdefghijkl', '[REDACTED]'],
    [
      'a JSON web token',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'jwt [REDACTED]',
    ],
    ['a bearer header', 'Authorization: Bearer abc.def-123_456', 'Authorization: Bearer [REDACTED]'],
    ['a password assignment', 'DB_PASSWORD=hunter2 and more', 'DB_PASSWORD=[REDACTED] and more'],
    ['a quoted secret in JSON', '{"client_secret": "s3cr3t-value"}', '{"client_secret": "[REDACTED]"}'],
    ['an api key in YAML', 'api_key: abc123def456', 'api_key: [REDACTED]'],
    [
      'credentials in a URL',
      'cloning https://bot:ghs_secret@github.com/acme/app.git',
      'cloning https://[REDACTED]@github.com/acme/app.git',
    ],
    [
      'a private key block',
      'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\ndone',
      'key:\n[REDACTED]\ndone',
    ],
  ])('masks %s', (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    ['plain prose', 'Added a CSV export to the orders service.'],
    ['a commit sha', 'pushed 3f786850e387550fdab836ed7e6dc881de23001b to coredoc/PROJ-1'],
    ['a uuid', 'turn 0b6f6d3c-58a5-4bb7-9d0b-1f6c2b9b6a10 started'],
    ['a word that only mentions a secret', 'The secret scan passed; no password was found.'],
    ['a plain URL', 'see https://github.com/acme/app/pull/12'],
  ])('leaves %s alone', (_name, input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});

describe('redactSecrets on long secrets', () => {
  const tail = (alphabet: string) => alphabet.repeat(Math.ceil(2_000 / alphabet.length)).slice(0, 2_000);
  const jwtPart = tail('AbC9_-');

  it.each([
    ['a model key', `sk-${tail('AbC9_-')}`, '[REDACTED]'],
    ['a GitHub token', `ghp_${tail('AbC9')}`, '[REDACTED]'],
    ['a fine-grained GitHub token', `github_pat_${tail('AbC9_')}`, '[REDACTED]'],
    ['a Coredoc token', `cdt_${tail('ab09')}`, '[REDACTED]'],
    ['a Slack token', `xoxb-${tail('AbC9-')}`, '[REDACTED]'],
    ['a bearer token', `Bearer ${tail('AbC9._~+/-')}==`, 'Bearer [REDACTED]'],
    ['a password value', `password=${tail('AbC9!#')}`, 'password=[REDACTED]'],
    ['a secret under a long name', `${'X'.repeat(200)}_SECRET=${tail('ab')}`, `${'X'.repeat(200)}_SECRET=[REDACTED]`],
    ['URL credentials', `https://${tail('u')}:${tail('p')}@example.com`, 'https://[REDACTED]@example.com'],
    ['a JSON web token', `t eyJ${jwtPart}.${jwtPart}.${jwtPart} end`, 't [REDACTED] end'],
  ])('masks all of %s', (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('drops text beyond the scan cap, and a secret cut by it, instead of storing it unredacted', () => {
    const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ012345';
    const straddling = `${'word '.repeat(MAX_REDACTED_CHARS / 5 - 2)}${secret} after the cap`;
    const redacted = redactSecrets(straddling);
    expect(redacted.length).toBeLessThanOrEqual(MAX_REDACTED_CHARS);
    expect(redacted).not.toContain('ghp_');
    expect(redacted).not.toContain('after the cap');
    expect(redacted.endsWith('word')).toBe(true);
  });
});

describe('redactSecrets on hostile input', () => {
  /** The most the redactor scans of one string (the largest event payload, a withheld workflow diff). */
  const CAP = MAX_REDACTED_CHARS;
  const fill = (unit: string) => unit.repeat(Math.ceil(CAP / unit.length)).slice(0, CAP);

  it.each([
    ['a long alphanumeric run', fill('a')],
    ['dotted runs', fill('a.')],
    ['dashed runs', fill('a-')],
    ['repeated private-key markers', fill('-----BEGIN ')],
    ['repeated private-key headers without an end', fill('-----BEGIN RSA PRIVATE KEY-----\n')],
    ['repeated end markers', fill('-----END ')],
    ['repeated URL prefixes', fill('a://x:')],
    ['a URL prefix before a long run', `a://x:${fill('y')}`],
    ['repeated secret names', fill('password')],
    ['dotted secret names', fill('password.')],
    ['secret names with separators', fill('api_key: ')],
    ['repeated JWT prefixes', fill('eyJ-')],
    ['a JWT prefix before a long run', `eyJ${fill('a')}`],
    ['repeated bearer words', fill('Bearer ')],
    ['repeated model-key prefixes', fill('sk-')],
    ['repeated GitHub prefixes', fill('ghp_')],
    ['repeated user-info parts', fill('x:y@')],
    ['repeated JWT segments', fill('eyJa.')],
    ['JWT-shaped segments', fill('eyJabcdefgh.abcdefgh.')],
    ['repeated assignments', fill('password=')],
    ['a URL user without a password', `a://${fill('u')}`],
    ['URL user-info runs', fill('a://u:p')],
    ['repeated bearer tokens', fill('Bearer x ')],
    ['one unbroken token run', `sk-${fill('a')}`],
  ])('masks %s in linear time', (_name, input) => {
    const started = performance.now();
    redactSecrets(input);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('scans a bounded length of each string', () => {
    const huge = `${'x'.repeat(1024 * 1024)} ghp_0123456789abcdefghijABCDEFGHIJ012345`;
    const started = performance.now();
    const redacted = redactSecrets(huge);
    expect(performance.now() - started).toBeLessThan(100);
    expect(redacted).not.toContain('ghp_0123456789');
  });
});

describe('redactPayload', () => {
  it('masks every string in a nested payload and keeps its shape', () => {
    expect(
      redactPayload({
        text: 'token ghp_0123456789abcdefghijABCDEFGHIJ012345',
        items: [{ text: 'password: hunter2', status: 'pending' }],
        ok: true,
        costUsd: 1.5,
      }),
    ).toEqual({
      text: 'token [REDACTED]',
      items: [{ text: 'password: [REDACTED]', status: 'pending' }],
      ok: true,
      costUsd: 1.5,
    });
  });
});
