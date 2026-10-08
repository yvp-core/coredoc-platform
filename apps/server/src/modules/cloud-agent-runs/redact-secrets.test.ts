import { describe, expect, it } from 'vitest';
import { redactPayload, redactSecrets } from './redact-secrets.js';

describe('redactSecrets', () => {
  it.each([
    ['a GitHub classic token', 'pushing with ghp_0123456789abcdefghijABCDEFGHIJ012345 now', 'pushing with [REDACTED] now'],
    ['a fine-grained GitHub token', 'token github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'token [REDACTED]'],
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
    ['credentials in a URL', 'cloning https://bot:ghs_secret@github.com/acme/app.git', 'cloning https://[REDACTED]@github.com/acme/app.git'],
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
