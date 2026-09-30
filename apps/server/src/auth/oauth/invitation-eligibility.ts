/**
 * Eligibility rules for activating a pending workspace membership on login.
 *
 * Split out from PrismaOAuthStore so the policy is unit-testable without a
 * database — the store's own suite is `describe.skipIf(!hasDb)` and does not
 * run in CI, and this is an authorization boundary.
 */

/** Lifetime granted to an invitation that carries no provider expiry. */
export const DEFAULT_INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface InvitationLifecycle {
  expiresAt: Date | null;
  lastSentAt: Date | null;
  createdAt: Date;
}

/** Effective expiry, including the local fallback used without a provider expiry. */
export function invitationExpiresAt(invitation: InvitationLifecycle): Date {
  if (invitation.expiresAt) return invitation.expiresAt;
  const issuedAt = invitation.lastSentAt ?? invitation.createdAt;
  return new Date(issuedAt.getTime() + DEFAULT_INVITATION_TTL_MS);
}

/**
 * A pending member with NO invitation row is always eligible. Membership is the
 * authorization record; the invitation row is delivery metadata that only
 * `createPendingInvitation` writes. Operator-seeded owners (the documented
 * on-prem bootstrap in docs/onprem/INSTALL.md §10), rows created by an older
 * pod mid-rollout, and rows predating the invitation table all lack one, and
 * must still activate on first login.
 *
 * When an invitation row does exist it bounds the grant. A provider-supplied
 * expiry wins; otherwise the grant lives `DEFAULT_INVITATION_TTL_MS` past the
 * last time it was sent, so a NULL expiry can never mean "never expires".
 * Re-sending pushes the window out via `lastSentAt`, which keeps the non-WorkOS
 * manual sign-in-link flow recoverable.
 */
export function isInvitationLive(invitation: InvitationLifecycle | null | undefined, now: Date): boolean {
  if (!invitation) return true;
  return invitationExpiresAt(invitation).getTime() > now.getTime();
}
