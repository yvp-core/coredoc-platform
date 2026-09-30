import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildGitHubProvider, chooseVerifiedEmail } from './github-allowlist.provider.js';

describe('chooseVerifiedEmail', () => {
  it('prefers the verified primary email', () => {
    expect(
      chooseVerifiedEmail([
        { email: 'secondary@example.com', primary: false, verified: true },
        { email: 'primary@example.com', primary: true, verified: true },
      ]),
    ).toBe('primary@example.com');
  });

  it('falls back to any verified email when no verified primary exists', () => {
    expect(
      chooseVerifiedEmail([
        { email: 'unverified@example.com', primary: true, verified: false },
        { email: 'verified@example.com', primary: false, verified: true },
      ]),
    ).toBe('verified@example.com');
  });

  // The security fix: an unverified address (which an attacker can add to their
  // GitHub account) must never be chosen, even as a last resort.
  it('returns undefined when no email is verified — never trusts an unverified address', () => {
    expect(
      chooseVerifiedEmail([
        { email: 'victim@example.com', primary: true, verified: false },
        { email: 'attacker@gmail.com', primary: false, verified: false },
      ]),
    ).toBeUndefined();
  });

  it('returns undefined for empty or missing input', () => {
    expect(chooseVerifiedEmail([])).toBeUndefined();
    expect(chooseVerifiedEmail(null)).toBeUndefined();
    expect(chooseVerifiedEmail(undefined)).toBeUndefined();
  });
});

const ENV_KEYS = ['ALLOWED_EMAIL_DOMAINS', 'ALLOWED_GITHUB_ORG'] as const;

describe('buildGitHubProvider login gate', () => {
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

  function runMapper(profileExtra: Record<string, unknown>) {
    const provider = buildGitHubProvider();
    return provider.profileMapper({ id: '42', username: 'octocat', ...profileExtra });
  }

  it('throws at build time when no email domain is configured (fail closed)', () => {
    expect(() => buildGitHubProvider()).toThrow(/Login gate is empty/);
  });

  it('allows a matching email domain (case-insensitive)', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
    const result = runMapper({ emails: [{ value: 'Alice@Example.com' }] });
    expect(result.id).toBe('42');
    expect(result.email).toBe('Alice@Example.com');
  });

  it('rejects a non-matching email domain', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
    expect(() => runMapper({ emails: [{ value: 'eve@gmail.com' }] })).toThrow(/not in an allowed email domain/);
  });

  it('rejects when no verified email is present', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
    expect(() => runMapper({ emails: [] })).toThrow(/not in an allowed email domain/);
  });

  it('requests only user:email scope (org path disabled, ALLOWED_GITHUB_ORG ignored)', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
    expect(buildGitHubProvider().scope).toEqual(['user:email']);

    process.env.ALLOWED_GITHUB_ORG = 'example-org';
    expect(buildGitHubProvider().scope).toEqual(['user:email']);
  });
});
