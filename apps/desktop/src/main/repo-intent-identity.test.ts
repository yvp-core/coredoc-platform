import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it, vi } from 'vitest';
import { buildRepoIntentIdentity } from './repo-intent-identity.js';

const hashOf = (key: string) => new StableIdGenerator('', key).getRepoHash();

describe('buildRepoIntentIdentity', () => {
  it('sends the explicit repos[].key when it reproduces the parsed repo id', () => {
    // The defect this closes: a repo whose key differs from its name can never
    // satisfy the server's hash(name) fallback, so without this field it stays
    // unbound and every anchor/seed/import fails unknown_repo_key.
    const durableKey = 'acme/payments-api';
    expect(buildRepoIntentIdentity({ repoKey: hashOf(durableKey), durableKey })).toEqual({
      intentRepoKey: durableKey,
    });
  });

  it('sends the name when the name is the durable key', () => {
    expect(buildRepoIntentIdentity({ repoKey: hashOf('payments'), durableKey: 'payments' })).toEqual({
      intentRepoKey: 'payments',
    });
  });

  it('omits and reports an identity that does not prove the parsed repo id', () => {
    // A parsed artifact minted before `repos[].key` changed: the key it would
    // register is wrong, and sending it would 400 every push.
    const log = vi.fn();
    expect(buildRepoIntentIdentity({ repoKey: hashOf('old-key'), durableKey: 'new-key' }, log)).toEqual({});
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('new-key');
    expect(log.mock.calls[0]?.[0]).toContain(hashOf('old-key'));
  });

  it('omits an empty durable key rather than hashing the empty string', () => {
    expect(buildRepoIntentIdentity({ repoKey: hashOf(''), durableKey: '' })).toEqual({});
  });

  it('never guesses: a repoKey that is not a repo hash at all yields no identity', () => {
    expect(buildRepoIntentIdentity({ repoKey: 'payments', durableKey: 'payments' })).toEqual({});
  });
});
