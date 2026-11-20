/**
 * Control Plane Service
 *
 * Manages the PostgreSQL control plane database for workspace metadata,
 * members, repos, and service tokens.
 * Uses Prisma ORM for type-safe, parameterized database access.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { linkPendingMemberships } from '../auth/oauth/link-pending-memberships.js';
import type { IntentReleaseTrigger, Prisma } from '../generated/prisma/client.js';
import { can, roleAllows } from '../auth/iam.js';
import {
  lockWorkspaceRepositoryIdentity,
  WORKSPACE_REPOSITORY_TRANSACTION_OPTIONS,
} from './workspace-repository-lock.js';

type WorkspaceReader = {
  workspace: Pick<Prisma.TransactionClient['workspace'], 'findUnique'>;
};
type WorkspaceRepoReader = {
  workspaceRepo: Pick<Prisma.TransactionClient['workspaceRepo'], 'findMany'>;
};
type WorkspaceRepoWriter = {
  workspaceRepo: Pick<Prisma.TransactionClient['workspaceRepo'], 'updateMany'>;
};
type WorkspaceGraphVersionReader = {
  workspaceGraphVersion: Pick<Prisma.TransactionClient['workspaceGraphVersion'], 'findUnique'>;
};

// Re-export Prisma types for consumers
export type {
  Workspace,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceRepo,
  WorkspaceGraphVersion,
  ServiceToken,
} from '../generated/prisma/client.js';

/** Server-internal work with no human reader (push, derivation): reads every repo. */
export const SYSTEM_READER = 'system' as const;

/** Who a repo read is for. For a service token, the token's creator. */
export type RepoReader = { userId: string; role: string } | typeof SYSTEM_READER;

/**
 * The repos this reader may read — the one place repo read access is decided
 * (rules in auth/iam.ts). `withheld` are the repos kept from this reader: they
 * still live in the workspace graph, so graph reads must be filtered against them.
 */
export async function readableRepos(
  controlPlane: Pick<ControlPlaneService, 'listRepos' | 'listRepoGrants'>,
  workspaceId: string,
  reader: RepoReader,
) {
  const repos = await controlPlane.listRepos(workspaceId);
  if (reader === SYSTEM_READER || roleAllows(reader.role, 'workspace.manage')) return { repos, withheld: [] };
  const workspaceGrant = { role: reader.role, resourceType: 'workspace', resourceId: workspaceId };
  // Repo bindings matter only when something is out of the workspace role's reach.
  const needsRepoGrants = !roleAllows(reader.role, 'graph.read') || repos.some((repo) => repo.restricted);
  const grants = needsRepoGrants
    ? [workspaceGrant, ...(await controlPlane.listRepoGrants(workspaceId, reader.userId))]
    : [workspaceGrant];
  const readable = (repo: (typeof repos)[number]) =>
    can(grants, 'graph.read', { type: 'repo', id: repo.repoKey, restricted: repo.restricted });
  return { repos: repos.filter(readable), withheld: repos.filter((repo) => !readable(repo)) };
}

/** Selects a member's workspace role — its binding on the workspace itself. */
const WORKSPACE_ROLE = { bindings: { where: { resourceType: 'workspace' }, select: { role: true } } } as const;

/** No workspace binding = an empty role, which allows nothing. */
function withRole<T extends { bindings: { role: string }[] }>({ bindings, ...member }: T) {
  return { ...member, role: bindings[0]?.role ?? '' };
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class ControlPlaneService {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // Workspaces
  // ===========================================================================

  async createWorkspace(name: string, slug: string) {
    return this.prisma.workspace.create({ data: { name, slug } });
  }

  async getWorkspaceById(id: string, reader: WorkspaceReader = this.prisma) {
    return reader.workspace.findUnique({ where: { id } });
  }

  async getWorkspaceGraphVersion(
    workspaceId: string,
    versionId: string,
    reader: WorkspaceGraphVersionReader = this.prisma,
  ) {
    return reader.workspaceGraphVersion.findUnique({
      where: { workspaceId_versionId: { workspaceId, versionId } },
      select: {
        workspaceId: true,
        versionId: true,
        engine: true,
        r2Key: true,
        sha256: true,
        sizeBytes: true,
        storageFormatVersion: true,
        // The row has no `builderVersion` column — it lives inside the manifest
        // JSONB. Readers need it to tell a pre-`phase4-v1` snapshot apart from a
        // current one, because the MEANING of the persisted USES_TYPE `ambiguous`
        // flag changed at that boundary (see `heritageIdentityIsVerifiable` in
        // `@coredoc/db`). Selected here rather than derived at the call site so
        // there is one place that knows where the value lives.
        manifest: true,
      },
    });
  }

  async updateWorkspace(
    id: string,
    updates: {
      name?: string;
      slug?: string;
      dbUrl?: string;
      dbTokenEncrypted?: string;
      isCloud?: boolean;
      ciCdEnabled?: boolean;
      intentEnabled?: boolean;
      intentReleaseTrigger?: IntentReleaseTrigger;
    },
  ) {
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.slug !== undefined) data.slug = updates.slug;
    if (updates.dbUrl !== undefined) data.dbUrl = updates.dbUrl;
    if (updates.dbTokenEncrypted !== undefined) data.dbTokenEncrypted = updates.dbTokenEncrypted;
    if (updates.isCloud !== undefined) data.isCloud = updates.isCloud;
    if (updates.ciCdEnabled !== undefined) data.ciCdEnabled = updates.ciCdEnabled;
    if (updates.intentEnabled !== undefined) data.intentEnabled = updates.intentEnabled;
    if (updates.intentReleaseTrigger !== undefined) data.intentReleaseTrigger = updates.intentReleaseTrigger;

    if (Object.keys(data).length === 0) return this.getWorkspaceById(id);

    return this.prisma.workspace.update({ where: { id }, data });
  }

  async setWorkspaceWorkosOrganizationId(workspaceId: string, workosOrganizationId: string) {
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { workosOrganizationId },
    });
  }

  async deleteWorkspace(id: string) {
    await this.prisma.workspace.delete({ where: { id } });
  }

  /**
   * Activate pending invites for an already-authenticated user. Called from the
   * app-load endpoints so a user invited after their last login is activated
   * without a fresh OAuth round-trip (see link-pending-memberships.ts).
   */
  async linkPendingMemberships(user: { id: string; email: string; displayName?: string }) {
    await linkPendingMemberships(this.prisma, user.id, user.email, user.displayName);
  }

  async listWorkspacesForUser(userId: string) {
    const members = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        ...WORKSPACE_ROLE,
        workspace: {
          include: {
            agentRunSettings: { select: { enabled: true } },
            _count: { select: { cloudAgentRuns: true } },
          },
        },
      },
      orderBy: { workspace: { name: 'asc' } },
    });
    return members.map(({ workspace: { agentRunSettings, _count, ...workspace }, bindings }) => ({
      ...workspace,
      role: bindings[0]?.role ?? '',
      // Stable navigation flag: switching agent runs off keeps existing runs reachable.
      agentRunsEnabled: Boolean(agentRunSettings?.enabled) || _count.cloudAgentRuns > 0,
    }));
  }

  // ===========================================================================
  // Members
  // ===========================================================================

  async addMember(workspaceId: string, userId: string, email: string, role: string, displayName?: string) {
    // Emails are stored lowercase so the (workspaceId, email) unique constraint
    // and the case-insensitive invite reconciliation agree on one identity.
    return withRole(
      await this.prisma.workspaceMember.create({
        data: {
          workspaceId,
          userId,
          email: email.toLowerCase(),
          displayName: displayName ?? null,
          bindings: { create: { role, resourceType: 'workspace', resourceId: workspaceId } },
        },
        include: WORKSPACE_ROLE,
      }),
    );
  }

  async getMember(workspaceId: string, userId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: WORKSPACE_ROLE,
    });
    return member && withRole(member);
  }

  async listMembers(workspaceId: string) {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { joinedAt: 'asc' },
      include: WORKSPACE_ROLE,
    });
    return members.map(withRole);
  }

  /**
   * The intent domains kept from this reader — the one place intent read access
   * is decided (rules in auth/iam.ts). Every intent read excludes these ids;
   * system work (release, handoff, CI) passes SYSTEM_READER and gets none.
   */
  async withheldIntentDomains(workspaceId: string, reader: RepoReader): Promise<string[]> {
    if (reader === SYSTEM_READER || roleAllows(reader.role, 'workspace.manage')) return [];
    const restricted = await this.prisma.intentDomain.findMany({
      where: { workspaceId, restricted: true },
      select: { id: true },
    });
    if (restricted.length === 0) return [];
    const grants = [
      { role: reader.role, resourceType: 'workspace', resourceId: workspaceId },
      ...(await this.prisma.accessBinding.findMany({
        where: {
          workspaceId,
          resourceType: 'intent_domain',
          OR: [{ userId: reader.userId }, { group: { members: { some: { userId: reader.userId } } } }],
        },
        select: { role: true, resourceType: true, resourceId: true },
      })),
    ];
    return restricted
      .filter(({ id }) => !can(grants, 'intent.read', { type: 'intent_domain', id, restricted: true }))
      .map(({ id }) => id);
  }

  /** Bindings on single repos held by the user directly or through a group. */
  async listRepoGrants(workspaceId: string, userId: string) {
    return this.prisma.accessBinding.findMany({
      where: { workspaceId, resourceType: 'repo', OR: [{ userId }, { group: { members: { some: { userId } } } }] },
      select: { role: true, resourceType: true, resourceId: true },
    });
  }

  async getWorkspaceOwnerWorkosIdentity(workspaceId: string) {
    // A workspace can carry more than one owner. Select the oldest owner that
    // actually has a WorkOS profile, with userId as a stable timestamp tie-break.
    const owners = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, pending: false, bindings: { some: { resourceType: 'workspace', role: 'owner' } } },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
      select: { userId: true },
    });
    if (owners.length === 0) return null;
    const profiles = await this.prisma.oAuthUserProfile.findMany({
      where: { profile_id: { in: owners.map((owner) => owner.userId) }, provider: 'workos' },
      select: { profile_id: true, provider: true, provider_user_id: true },
    });
    const byProfileId = new Map(profiles.map((profile) => [profile.profile_id, profile]));
    for (const owner of owners) {
      const profile = byProfileId.get(owner.userId);
      if (profile) return { provider: profile.provider, provider_user_id: profile.provider_user_id };
    }
    return null;
  }

  async getWorkosIdentity(userId: string) {
    return this.prisma.oAuthUserProfile.findFirst({
      where: { profile_id: userId, provider: 'workos' },
      select: { provider_user_id: true },
    });
  }

  async updateMemberRole(workspaceId: string, userId: string, role: string) {
    return withRole(
      await this.prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { bindings: { updateMany: { where: { resourceType: 'workspace' }, data: { role } } } },
        include: WORKSPACE_ROLE,
      }),
    );
  }

  async removeMember(workspaceId: string, userId: string) {
    await this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
  }

  // ===========================================================================
  // Repos
  // ===========================================================================

  async addRepo(
    workspaceId: string,
    repoKey: string,
    repoName: string,
    gitUrl?: string | null,
    repoType?: string | null,
    httpPrefix?: string | null,
  ) {
    // Create-only. Re-connect of an existing repoKey throws via Prisma's
    // unique-constraint error; ReposService surfaces that as 409 Conflict so
    // POST stays idempotent in the "already connected" sense without silently
    // mutating fields. To update mutable connect-time fields (httpPrefix,
    // gitUrl, repoType) use `updateRepo` via PATCH /repos/:repoKey.
    return this.withRepositoryLock(workspaceId, (transaction) =>
      this.createRepoIn(transaction, workspaceId, { repoKey, repoName, gitUrl, repoType, httpPrefix }),
    );
  }

  /**
   * Run one workspace-repository mutation under the shared advisory lock.
   *
   * Exposed because a caller sometimes needs MORE than one row write inside that
   * scope: `ReposService.connectRepo` binds the durable intent identity in the
   * same transaction as the connect, so a refused identity cannot leave a
   * half-created, permanently unbound repo behind.
   */
  async withRepositoryLock<T>(workspaceId: string, work: (transaction: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async (transaction) => {
      await lockWorkspaceRepositoryIdentity(transaction, workspaceId);
      return work(transaction);
    }, WORKSPACE_REPOSITORY_TRANSACTION_OPTIONS);
  }

  /** The `addRepo` row write, on a caller-supplied transaction. Assumes the lock is held. */
  async createRepoIn(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    repo: {
      repoKey: string;
      repoName: string;
      gitUrl?: string | null;
      repoType?: string | null;
      httpPrefix?: string | null;
    },
  ) {
    return transaction.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: repo.repoKey,
        repoName: repo.repoName,
        gitUrl: repo.gitUrl ?? null,
        repoType: repo.repoType ?? null,
        httpPrefix: repo.httpPrefix ?? null,
      },
    });
  }

  /**
   * Partial update for an existing workspace repo.
   *
   * Tri-state semantics per field: `undefined` (omitted) means "leave alone";
   * explicit `null` means "clear it"; a string sets it. The desktop currently
   * omits the field (sends undefined) when local config has no value — it has
   * no UI distinguishing "user removed this" from "never set", so an explicit-
   * null on every sync would wipe values set via direct API calls or hand-
   * edited coredoc.config.json. Clearing a value requires sending null
   * explicitly (e.g. via the API).
   *
   * `repoName` and `repoKey` are intentionally NOT updatable here — they're
   * identity fields (repoKey is the node-id hash that prefixes the Turso graph
   * rows). Renaming a repo or changing its key should go through disconnect +
   * reconnect so stale graph rows in Turso are cleaned up.
   */
  async updateRepo(
    workspaceId: string,
    repoKey: string,
    updates: {
      gitUrl?: string | null;
      repoType?: string | null;
      httpPrefix?: string | null;
      productionBranch?: string | null;
      intentReleaseTrigger?: IntentReleaseTrigger | null;
    },
  ) {
    return this.withRepositoryLock(workspaceId, (transaction) =>
      this.updateRepoIn(transaction, workspaceId, repoKey, updates),
    );
  }

  /** The `updateRepo` row write, on a caller-supplied transaction. Assumes the lock is held. */
  async updateRepoIn(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    repoKey: string,
    updates: {
      gitUrl?: string | null;
      repoType?: string | null;
      httpPrefix?: string | null;
      productionBranch?: string | null;
      intentReleaseTrigger?: IntentReleaseTrigger | null;
    },
  ) {
    const updateData: Record<string, string | null> = {};
    if (updates.gitUrl !== undefined) updateData.gitUrl = updates.gitUrl;
    if (updates.repoType !== undefined) updateData.repoType = updates.repoType;
    if (updates.httpPrefix !== undefined) updateData.httpPrefix = updates.httpPrefix;
    // Tri-state like the fields above: null means "the connector's default
    // branch is production again", not "no production branch".
    if (updates.productionBranch !== undefined) updateData.productionBranch = updates.productionBranch;
    if (updates.intentReleaseTrigger !== undefined) updateData.intentReleaseTrigger = updates.intentReleaseTrigger;
    return transaction.workspaceRepo.update({
      where: { workspaceId_repoKey: { workspaceId, repoKey } },
      data: updateData,
    });
  }

  async listRepos(workspaceId: string, reader: WorkspaceRepoReader = this.prisma) {
    return reader.workspaceRepo.findMany({
      where: { workspaceId },
      orderBy: { repoName: 'asc' },
    });
  }

  async removeRepo(workspaceId: string, repoId: string) {
    await this.prisma.$transaction(async (transaction) => {
      await lockWorkspaceRepositoryIdentity(transaction, workspaceId);
      const repo = await transaction.workspaceRepo.delete({
        where: { id: repoId, workspaceId },
      });
      // Bindings name the repo by key, with no foreign key: a repo reconnected
      // under the same key must not inherit them.
      await transaction.accessBinding.deleteMany({
        where: { workspaceId, resourceType: 'repo', resourceId: repo.repoKey },
      });
    }, WORKSPACE_REPOSITORY_TRANSACTION_OPTIONS);
  }

  async updateRepoPushMetadata(
    workspaceId: string,
    repo: { id: string; repoKey: string; repoName: string },
    metadata: {
      lastParseHash: string;
      lastPushedByUserId: string;
      nodeCount: number;
      edgeCount: number;
      lastParsedVersion: string;
      lastSummaryVersion?: string | null;
      lastEmbedVersion?: string | null;
    },
    writer: WorkspaceRepoWriter = this.prisma,
  ): Promise<boolean> {
    // Fence an in-flight push against disconnect/reconnect ABA: repoKey is the
    // logical identity, while the row id proves this is still the connection
    // that was resolved before the graph write began.
    const changed = await writer.workspaceRepo.updateMany({
      where: { id: repo.id, workspaceId, repoKey: repo.repoKey, repoName: repo.repoName },
      data: {
        lastParseHash: metadata.lastParseHash,
        lastPushedAt: new Date(),
        lastPushedByUserId: metadata.lastPushedByUserId,
        nodeCount: metadata.nodeCount,
        edgeCount: metadata.edgeCount,
        lastParsedVersion: metadata.lastParsedVersion,
        ...(metadata.lastSummaryVersion !== undefined ? { lastSummaryVersion: metadata.lastSummaryVersion } : {}),
        ...(metadata.lastEmbedVersion !== undefined ? { lastEmbedVersion: metadata.lastEmbedVersion } : {}),
      },
    });
    return changed.count === 1;
  }

  // ===========================================================================
  // Service Tokens
  // ===========================================================================

  async createServiceToken(opts: {
    workspaceId: string;
    name: string;
    tokenHash: string;
    createdBy: string;
    permissions?: string[];
    expiresAt?: Date;
    tokenEncrypted?: string | null;
    tokenPrefix?: string | null;
  }) {
    return this.prisma.serviceToken.create({
      data: {
        workspaceId: opts.workspaceId,
        name: opts.name,
        tokenHash: opts.tokenHash,
        tokenEncrypted: opts.tokenEncrypted ?? null,
        tokenPrefix: opts.tokenPrefix ?? null,
        createdBy: opts.createdBy,
        permissions: opts.permissions ?? [],
        expiresAt: opts.expiresAt ?? null,
      },
    });
  }

  /**
   * Create or rotate the one telemetry credential owned by an installation.
   *
   * The name is unique per workspace. An existing row may be replaced only
   * when both its actor and exact permission set still match; this prevents an
   * installation UUID collision from taking over another principal's token.
   */
  async replaceInstallationTelemetryToken(opts: {
    workspaceId: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    tokenEncrypted: null;
    createdBy: string;
    permissions: string[];
    expiresAt: Date | null;
    lastUsedAt: null;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.serviceToken.findUnique({
        where: { workspaceId_name: { workspaceId: opts.workspaceId, name: opts.name } },
      });

      if (
        existing &&
        (existing.createdBy !== opts.createdBy ||
          existing.permissions.length !== opts.permissions.length ||
          existing.permissions.some((permission, index) => permission !== opts.permissions[index]))
      ) {
        return { kind: 'conflict' as const };
      }

      const credential = {
        tokenHash: opts.tokenHash,
        tokenPrefix: opts.tokenPrefix,
        tokenEncrypted: opts.tokenEncrypted,
        permissions: opts.permissions,
        expiresAt: opts.expiresAt,
        lastUsedAt: opts.lastUsedAt,
      };
      const token = existing
        ? await tx.serviceToken.update({ where: { id: existing.id }, data: credential })
        : await tx.serviceToken.create({
            data: {
              workspaceId: opts.workspaceId,
              name: opts.name,
              createdBy: opts.createdBy,
              ...credential,
            },
          });

      return { kind: 'replaced' as const, token };
    });
  }

  async getServiceTokenByHash(tokenHash: string) {
    const serviceToken = await this.prisma.serviceToken.findFirst({
      where: {
        tokenHash,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });

    if (serviceToken) {
      await this.prisma.serviceToken.update({
        where: { id: serviceToken.id },
        data: { lastUsedAt: new Date() },
      });
    }

    return serviceToken;
  }

  async getServiceToken(workspaceId: string, tokenId: string) {
    return this.prisma.serviceToken.findFirst({
      where: { id: tokenId, workspaceId },
      select: { id: true, tokenEncrypted: true, permissions: true },
    });
  }

  async listServiceTokens(workspaceId: string) {
    return this.prisma.serviceToken.findMany({
      // Per-turn MCP tokens belong to their run turn: never listed, never revealed.
      where: { workspaceId, owningTurnId: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        permissions: true,
        expiresAt: true,
        createdBy: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });
  }

  async deleteServiceToken(workspaceId: string, tokenId: string) {
    await this.prisma.serviceToken.deleteMany({
      where: { id: tokenId, workspaceId, owningTurnId: null },
    });
  }

  async deleteInstallationTelemetryToken(opts: {
    workspaceId: string;
    name: string;
    createdBy: string;
    permissions: string[];
  }): Promise<boolean> {
    const deleted = await this.prisma.serviceToken.deleteMany({
      where: {
        workspaceId: opts.workspaceId,
        name: opts.name,
        createdBy: opts.createdBy,
        permissions: { equals: opts.permissions },
      },
    });
    return deleted.count === 1;
  }

  async deleteOwnedTelemetryToken(opts: {
    workspaceId: string;
    tokenId: string;
    createdBy: string;
    permissions: string[];
  }): Promise<boolean> {
    const deleted = await this.prisma.serviceToken.deleteMany({
      where: {
        id: opts.tokenId,
        workspaceId: opts.workspaceId,
        createdBy: opts.createdBy,
        permissions: { equals: opts.permissions },
      },
    });
    return deleted.count === 1;
  }

  // ===========================================================================
  // Pending invitations
  // ===========================================================================

  /**
   * Create the authorization placeholder and invitation lifecycle row in one
   * transaction. External email delivery happens only after this commits; the
   * caller removes both rows if delivery fails.
   */
  async createPendingInvitation(workspaceId: string, email: string, role: string) {
    const normalizedEmail = email.toLowerCase();
    const placeholderUserId = `pending:${normalizedEmail}`;
    return this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.create({
        data: {
          workspaceId,
          userId: placeholderUserId,
          email: normalizedEmail,
          pending: true,
          bindings: { create: { role, resourceType: 'workspace', resourceId: workspaceId } },
        },
      });
      return tx.workspaceInvitation.create({
        data: { workspaceId, memberUserId: placeholderUserId },
        include: { member: true },
      });
    });
  }

  async getInvitationForMember(workspaceId: string, memberUserId: string) {
    return this.prisma.workspaceInvitation.findUnique({
      where: { workspaceId_memberUserId: { workspaceId, memberUserId } },
    });
  }

  async getPendingInvitation(workspaceId: string, invitationId: string) {
    return this.prisma.workspaceInvitation.findFirst({
      where: { id: invitationId, workspaceId, member: { pending: true } },
      include: { member: true },
    });
  }

  async listPendingInvitations(workspaceId: string) {
    const invitations = await this.prisma.workspaceInvitation.findMany({
      where: { workspaceId, member: { pending: true } },
      include: { member: { include: WORKSPACE_ROLE } },
      orderBy: { createdAt: 'asc' },
    });
    return invitations.map((invitation) => ({ ...invitation, member: withRole(invitation.member) }));
  }

  async markInvitationDelivered(invitationId: string, workosInvitationId: string, expiresAt: Date, sentAt: Date) {
    return this.prisma.workspaceInvitation.update({
      where: { id: invitationId },
      data: { workosInvitationId, expiresAt, lastSentAt: sentAt },
    });
  }

  async renewManualInvitation(workspaceId: string, invitationId: string, sentAt: Date) {
    return this.prisma.workspaceInvitation.updateMany({
      where: { id: invitationId, workspaceId, member: { pending: true } },
      data: { lastSentAt: sentAt },
    });
  }

  async countPendingInvitationsByWorkosId(workosInvitationId: string) {
    return this.prisma.workspaceInvitation.count({
      where: { workosInvitationId, member: { pending: true } },
    });
  }

  async removePendingInvitation(workspaceId: string, invitationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.workspaceInvitation.findFirst({
        where: { id: invitationId, workspaceId, member: { pending: true } },
      });
      if (!invitation) return false;
      await tx.workspaceMember.delete({
        where: {
          workspaceId_userId: { workspaceId: invitation.workspaceId, userId: invitation.memberUserId },
        },
      });
      return true;
    });
  }
}
