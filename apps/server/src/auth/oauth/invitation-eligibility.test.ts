import { describe, expect, it } from 'vitest';
import { DEFAULT_INVITATION_TTL_MS, isInvitationLive } from './invitation-eligibility.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');

function lifecycle(overrides: Partial<Parameters<typeof isInvitationLive>[0]> = {}) {
  return {
    expiresAt: null,
    lastSentAt: null,
    createdAt: new Date('2026-08-05T00:00:00.000Z'),
    ...overrides,
  };
}

describe('isInvitationLive', () => {
  it('activates a pending member that has no invitation row', () => {
    // The documented on-prem bootstrap seeds workspace_members directly, and
    // rows created mid-rollout by an older pod have no invitation either. Both
    // must still be re-keyed on first login.
    expect(isInvitationLive(null, NOW)).toBe(true);
    expect(isInvitationLive(undefined, NOW)).toBe(true);
  });

  it('honours a provider expiry that is still in the future', () => {
    expect(isInvitationLive(lifecycle({ expiresAt: new Date('2026-08-05T12:00:01.000Z') }), NOW)).toBe(true);
  });

  it('rejects a provider expiry that has passed', () => {
    expect(isInvitationLive(lifecycle({ expiresAt: new Date('2026-08-05T11:59:59.000Z') }), NOW)).toBe(false);
  });

  it('does not treat a null provider expiry as never-expiring', () => {
    const stale = new Date(NOW.getTime() - DEFAULT_INVITATION_TTL_MS - 1);
    expect(isInvitationLive(lifecycle({ createdAt: stale }), NOW)).toBe(false);
  });

  it('keeps a null-expiry invitation live inside the default TTL', () => {
    const recent = new Date(NOW.getTime() - DEFAULT_INVITATION_TTL_MS + 60_000);
    expect(isInvitationLive(lifecycle({ createdAt: recent }), NOW)).toBe(true);
  });

  it('measures the default TTL from the last send, so resending renews the grant', () => {
    // The non-WorkOS fallback shares a sign-in link manually and never records a
    // provider expiry; resending has to be able to push the window out.
    const staleCreate = new Date(NOW.getTime() - DEFAULT_INVITATION_TTL_MS * 2);
    const justResent = new Date(NOW.getTime() - 60_000);
    expect(isInvitationLive(lifecycle({ createdAt: staleCreate, lastSentAt: justResent }), NOW)).toBe(true);
  });

  it('lets a provider expiry override a recent send', () => {
    expect(
      isInvitationLive(
        lifecycle({ expiresAt: new Date('2026-08-05T11:00:00.000Z'), lastSentAt: new Date(NOW.getTime() - 60_000) }),
        NOW,
      ),
    ).toBe(false);
  });
});
