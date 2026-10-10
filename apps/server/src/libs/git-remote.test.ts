/**
 * `normalizeGitRemote` — the canonical, credential-free remote form.
 *
 * Every "normalized" case here must also satisfy
 * `workspace_repos_normalized_git_remote_check` (migration 20260901100000): no
 * whitespace/`@`/`?`/`#`, no `.git` suffix, and either a `protocol://host/path`
 * or a bare `provider.com/path`. The two are a pair, so a case added here that
 * the CHECK would reject is a bug in one of them.
 */

import { describe, expect, it } from 'vitest';
import { GitRemoteNormalizationErrorCode, normalizeGitRemote } from './git-remote.js';

function normalized(input: string): string | undefined {
  const result = normalizeGitRemote(input);
  return result.status === 'normalized' ? result.normalizedRemote : undefined;
}

/** The SQL CHECK, restated. Every accepted output must pass it. */
function satisfiesStorageCheck(value: string): boolean {
  if (/[\s@?#]/.test(value)) return false;
  if (/\.git$/i.test(value)) return false;
  return /^(https?|ssh|git):\/\/[^/]+\/.+$/.test(value) || /^(github\.com|gitlab\.com|bitbucket\.org)\/.+$/.test(value);
}

describe('normalizeGitRemote', () => {
  it('collapses the public providers across clone spellings', () => {
    for (const input of [
      'https://github.com/acme/orders-api.git',
      'git@github.com:acme/orders-api.git',
      'ssh://git@github.com/acme/orders-api',
      'github.com/acme/orders-api',
    ]) {
      expect(normalized(input)).toBe('github.com/acme/orders-api');
    }
  });

  it('keeps a self-hosted remote protocol-explicit, so ssh and https stay distinct', () => {
    expect(normalized('ssh://git@git.internal.example/acme/orders.git')).toBe('ssh://git.internal.example/acme/orders');
    expect(normalized('https://git.internal.example/acme/orders.git')).toBe('https://git.internal.example/acme/orders');
  });

  it('drops a default port and keeps a non-default one', () => {
    expect(normalized('https://git.internal.example:443/acme/orders')).toBe('https://git.internal.example/acme/orders');
    expect(normalized('https://git.internal.example:8443/acme/orders')).toBe(
      'https://git.internal.example:8443/acme/orders',
    );
  });

  it('never returns the raw input for a rejected origin, so credentials cannot be echoed', () => {
    const secret = 'https://user:token@github.com/acme/orders.git';
    const result = normalizeGitRemote(secret);
    expect(result.status).toBe('normalized');
    // The userinfo is dropped by URL parsing, not carried through.
    expect(result.status === 'normalized' && result.normalizedRemote).toBe('github.com/acme/orders');
  });

  it('refuses unsupported protocols and malformed input', () => {
    expect(normalizeGitRemote('file:///srv/git/orders')).toEqual({
      status: 'invalid',
      code: GitRemoteNormalizationErrorCode.UnsupportedProtocol,
    });
    for (const input of ['', '   ', 'https://github.com/', 'https://github.com/acme/orders\n', ' https://a/b']) {
      expect(normalizeGitRemote(input).status).toBe('invalid');
    }
  });

  it('strips a repeated .git suffix to a fixpoint, not once', () => {
    // One pass leaves `…orders.git`, which the storage CHECK rejects outright.
    expect(normalized('https://github.com/acme/orders.git.git')).toBe('github.com/acme/orders');
    expect(normalized('github.com/acme/orders.git.git.git')).toBe('github.com/acme/orders');
    expect(normalized('git@git.internal.example:acme/orders.GIT.git')).toBe('ssh://git.internal.example/acme/orders');
  });

  it('refuses an scp-form remote whose "host" is not a host', () => {
    // The scp pattern captures everything before the colon, which is not proof
    // of hostness: these used to normalize into values the CHECK rejects.
    for (const input of [
      'git@bad#host:acme/orders',
      'git@host?x:acme/orders',
      'a@b@c:acme/orders',
      '[abc:acme/orders',
    ]) {
      expect(normalizeGitRemote(input).status).toBe('invalid');
    }
  });

  it('refuses rather than emitting a value wider than the VARCHAR(2048) column', () => {
    // `git@h:` (6 chars in) becomes `ssh://h/` (8 chars out): an input inside
    // the input bound can still produce an over-wide normal form.
    const input = `git@h:${'a'.repeat(2_042)}`;
    expect(input.length).toBe(2_048);
    expect(normalizeGitRemote(input).status).toBe('invalid');
  });

  /**
   * The totality property, which is the whole point of the pairing: for ANY
   * input, `normalizeGitRemote` either refuses or returns a value the storage
   * CHECK accepts. A normalized value the CHECK would reject is a 500 in the
   * middle of a repo connect.
   */
  it('is TOTAL against the storage CHECK for hostile input', () => {
    const nasty = [
      '',
      '   ',
      '\t',
      'https://github.com/acme/orders.git.git.git',
      'github.com/acme/orders.git.git',
      'git@github.com:acme/orders.git.git',
      'git@bad#host:acme/orders',
      'git@host?x:acme/orders',
      'ssh://bad#host/acme/orders',
      'https://user:tok@github.com/acme/orders.git',
      'https://user:tok@git.internal.example:8443/acme/orders.git',
      'git@h:acme/orders',
      `git@h:${'a'.repeat(2_042)}`,
      `https://git.internal.example/${'b'.repeat(3_000)}`,
      'github.com/.git',
      'git@github.com:.git',
      'https://github.com/',
      'https://github.com/acme/orders\n',
      ' https://a/b',
      'file:///srv/git/orders',
      'ftp://git.internal.example/acme/orders',
      'ssh://git@ünï.example/acme/orders',
      'git@ünï.example:acme/orders',
      'git@[::1]:acme/orders',
      'ssh://git.internal.example:22/acme/orders.git',
      'git://git.internal.example:9418/acme/orders',
      'GitHub.com/Acme/Orders.GIT',
      'https://github.com/acme/orders?ref=main#frag',
      'a'.repeat(4_096),
      'git@host:acme/orders ',
      'git@host:acme/orders\u0000',
      // C1 controls (here 8-bit OSC) are refused, not carried into a stored remote:
      'git@host:acme/\u009dorders',
      'github.com/acme/\u009borders',
      'https://github.com/acme/orders/',
      'https://github.com/acme/orders///',
    ];
    for (const input of nasty) {
      const result = normalizeGitRemote(input);
      if (result.status === 'normalized') {
        expect(satisfiesStorageCheck(result.normalizedRemote), `${input} -> ${result.normalizedRemote}`).toBe(true);
        expect(result.normalizedRemote.length).toBeLessThanOrEqual(2_048);
        // And the idempotence the CHECK-as-shape-check relies on.
        expect(
          normalized(result.normalizedRemote),
          `idempotence: ${JSON.stringify(input)} -> ${JSON.stringify(result.normalizedRemote)}`,
        ).toBe(result.normalizedRemote);
      } else {
        expect(result.status).toBe('invalid');
      }
    }
  });

  it('is idempotent, which is what lets the SQL CHECK be a shape check', () => {
    for (const input of [
      'git@github.com:acme/orders-api.git',
      'https://git.internal.example:8443/acme/orders',
      'gitlab.com/acme/group/orders',
    ]) {
      const once = normalized(input) as string;
      expect(normalized(once)).toBe(once);
      expect(satisfiesStorageCheck(once)).toBe(true);
    }
  });
});
