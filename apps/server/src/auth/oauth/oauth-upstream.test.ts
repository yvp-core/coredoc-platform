import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveUpstream } from './oauth-upstream.js';

const ENV_KEYS = [
  'OAUTH_UPSTREAM',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'WORKOS_AUTHKIT_DOMAIN',
  'WORKOS_CLIENT_ID',
  'WORKOS_CLIENT_SECRET',
  'ALLOWED_EMAIL_DOMAINS',
] as const;

describe('resolveUpstream', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to the GitHub upstream with GITHUB_* credentials', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com'; // GitHub gate must be non-empty
    process.env.GITHUB_CLIENT_ID = 'gh_id';
    process.env.GITHUB_CLIENT_SECRET = 'gh_secret';

    const selection = resolveUpstream();
    expect(selection.provider.name).toBe('github');
    expect(selection.clientId).toBe('gh_id');
    expect(selection.clientSecret).toBe('gh_secret');
  });

  it('treats a blank OAUTH_UPSTREAM as unset (github default)', () => {
    process.env.OAUTH_UPSTREAM = '  '; // dotenv/compose yield '' for `OAUTH_UPSTREAM=`
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';

    expect(resolveUpstream().provider.name).toBe('github');
  });

  it('selects WorkOS with WORKOS_* credentials (case-insensitive value)', () => {
    process.env.OAUTH_UPSTREAM = 'WorkOS';
    process.env.WORKOS_AUTHKIT_DOMAIN = 'https://acme.authkit.app';
    process.env.WORKOS_CLIENT_ID = 'wos_id';
    process.env.WORKOS_CLIENT_SECRET = 'wos_secret';

    const selection = resolveUpstream();
    expect(selection.provider.name).toBe('workos');
    expect(selection.clientId).toBe('wos_id');
    expect(selection.clientSecret).toBe('wos_secret');
  });

  it('trims surrounding whitespace on WORKOS_* credentials and rejects whitespace-only values', () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_AUTHKIT_DOMAIN = 'https://acme.authkit.app';
    process.env.WORKOS_CLIENT_ID = '  client_padded  ';
    process.env.WORKOS_CLIENT_SECRET = '  wos_secret  ';

    const selection = resolveUpstream();
    expect(selection.clientId).toBe('client_padded');
    expect(selection.clientSecret).toBe('wos_secret');

    // A whitespace-only value must fail the required-env check, not survive boot.
    process.env.WORKOS_CLIENT_ID = '   ';
    expect(() => resolveUpstream()).toThrow(/requires: WORKOS_CLIENT_ID/);
  });

  it('fails fast listing every missing WORKOS_* env', () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    expect(() => resolveUpstream()).toThrow(
      /OAUTH_UPSTREAM=workos requires: WORKOS_AUTHKIT_DOMAIN, WORKOS_CLIENT_ID, WORKOS_CLIENT_SECRET/,
    );

    process.env.WORKOS_AUTHKIT_DOMAIN = 'https://acme.authkit.app';
    process.env.WORKOS_CLIENT_ID = 'wos_id';
    expect(() => resolveUpstream()).toThrow(/requires: WORKOS_CLIENT_SECRET/);
  });

  it('throws on an unknown OAUTH_UPSTREAM value (never a silent fallback)', () => {
    process.env.OAUTH_UPSTREAM = 'okta';
    expect(() => resolveUpstream()).toThrow(/Unknown OAUTH_UPSTREAM "okta"/);
  });
});
