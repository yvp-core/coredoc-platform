/**
 * Reconcile pending workspace invites for a verified identity. Members invited
 * by email are created with a placeholder userId; the first eligible sighting
 * of the real account re-keys those rows to its OAuth profile_id (or drops the
 * placeholder if the user is already a member).
 *
 * Runs from two places: the OAuth login callback (PrismaOAuthStore) and the
 * app-load endpoints (/me, GET /workspaces). The second hook exists because a
 * user invited while already holding a live session never logs in again —
 * refresh keeps the session alive — so a login-only hook left them pending
 * until some other client (e.g. an MCP authorization) forced a fresh login.
 *
 * `email` must be a provider-verified address: the login gate enforces that,
 * and the session token's `user_data.email` is a copy of that same value.
 */

import type { PrismaClient } from '../../generated/prisma/client.js';
import { isInvitationLive } from './invitation-eligibility.js';

export async function linkPendingMemberships(
  prisma: PrismaClient,
  profileId: string,
  email: string | undefined,
  displayName?: string,
): Promise<void> {
  if (!email) return;
  // Emails are stored lowercase on every write path (ControlPlaneService
  // .addMember / .createPendingInvitation), so a lowercased exact match is
  // the correct comparison. Never use `{ equals, mode: 'insensitive' }` here:
  // on Prisma + PostgreSQL it compiles to an UNESCAPED ILIKE, so `%` / `_` in
  // a verified IdP address would act as wildcards and join this user into
  // workspaces they were never invited to. Recorded bug-class in this repo —
  // see modules/delivery/status-map.service.ts for the same reasoning.
  const normalizedEmail = email.toLowerCase();
  // Run the reconcile in one transaction, and use updateMany/deleteMany so a
  // row another concurrent login already re-keyed or removed is a no-op
  // rather than a P2025 ("record not found") that would fail this login.
  await prisma.$transaction(async (tx) => {
    // Drive off membership, not the invitation row. Membership is the
    // authorization record; the invitation is optional delivery metadata that
    // operator-seeded and mid-rollout rows never have. Eligibility (including
    // expiry) is decided in isInvitationLive().
    const pendings = await tx.workspaceMember.findMany({
      where: { pending: true, email: normalizedEmail },
      include: { invitation: true },
    });
    const now = new Date();
    for (const p of pendings) {
      if (!isInvitationLive(p.invitation, now)) continue;
      const alreadyMember = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: p.workspaceId, userId: profileId } },
      });
      // Remove lifecycle metadata before re-keying/deleting the placeholder;
      // the pending member is the authorization record, while the invitation
      // row exists only until the first eligible login.
      if (p.invitation) {
        await tx.workspaceInvitation.deleteMany({ where: { id: p.invitation.id } });
      }
      if (alreadyMember) {
        // Already joined this workspace — drop the stale placeholder.
        await tx.workspaceMember.deleteMany({
          where: { workspaceId: p.workspaceId, userId: p.userId },
        });
      } else {
        // Re-key the placeholder invite to the real profile_id, and backfill
        // the display name from the OAuth profile (the invite had none).
        await tx.workspaceMember.updateMany({
          where: { workspaceId: p.workspaceId, userId: p.userId },
          data: { userId: profileId, pending: false, ...(displayName ? { displayName } : {}) },
        });
      }
    }
  });
}
