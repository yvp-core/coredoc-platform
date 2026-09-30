import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/** Hints extracted from a Jira author/assignee payload when resolving an actor. */
export interface JiraActorHints {
  accountId: string;
  displayName?: string;
  email?: string;
  kind: 'human' | 'bot';
}

/** An unmatched (non-member, non-bot) actor plus its identities for the admin queue. */
export interface UnmatchedActor {
  id: string;
  displayName: string | null;
  kind: string;
  createdAt: Date;
  identities: { provider: string; externalId: string; method: string }[];
}

/**
 * Owns the workspace's DeliveryActor identity graph: seeds member actors, resolves
 * Jira authors to actors (auto-matching on verified email), surfaces the unmatched
 * queue for admins, and merges duplicate actors.
 *
 * Reads are batched at pilot scale — each method loads with a bounded number of
 * `findMany`s and joins in memory, never a per-row query (no N+1).
 */
@Injectable()
export class ActorRegistryService {
  private readonly logger = new Logger(ActorRegistryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent seed of the actor graph from workspace membership:
   *  - each WorkspaceMember (including pending invites — they carry a real email) →
   *    a `human` DeliveryActor with an `email` identity (lowercased, `exact_email`);
   *  - each OAuthUserProfile github login on a member → a `github` identity
   *    (`provider_link`) attached to that member's actor.
   *
   * A row is created only when its identity is absent, so a second run creates
   * nothing and returns `{ actors: 0, identities: 0 }`.
   */
  async seedWorkspace(workspaceId: string): Promise<{ actors: number; identities: number }> {
    // ── Batch loads: members + existing email/github identities, joined in memory. ──
    const [members, emailIdentities, githubIdentities] = await Promise.all([
      this.prisma.workspaceMember.findMany({ where: { workspaceId } }),
      this.prisma.deliveryActorIdentity.findMany({ where: { workspaceId, provider: 'email' } }),
      this.prisma.deliveryActorIdentity.findMany({ where: { workspaceId, provider: 'github' } }),
    ]);

    const actorByEmail = new Map<string, string>(); // lowercased email → actorId
    for (const id of emailIdentities) actorByEmail.set(id.externalId, id.actorId);
    const existingGithub = new Set<string>(); // github usernames already attached
    for (const id of githubIdentities) existingGithub.add(id.externalId);

    let actorsCreated = 0;
    let identitiesCreated = 0;
    const actorIdByMemberUserId = new Map<string, string>();

    // ── Members → human actors with an email identity. Idempotent AND concurrent-safe:
    //    this check-then-create can race parallel Jira connector syncs or two instances
    //    sharing one Postgres. On a losing insert the unique key (workspaceId,'email',email)
    //    throws P2002 — adopt the winner's actor and delete the actor we speculatively
    //    created so no orphan member actor lingers. Mirrors attachJiraIdentity below. ──
    for (const m of members) {
      const email = m.email.toLowerCase();
      let actorId = actorByEmail.get(email);
      if (!actorId) {
        const actor = await this.prisma.deliveryActor.create({
          data: { workspaceId, displayName: m.displayName ?? m.email, kind: 'human', memberUserId: m.userId },
        });
        try {
          await this.prisma.deliveryActorIdentity.create({
            data: {
              workspaceId,
              actorId: actor.id,
              provider: 'email',
              externalId: email,
              method: 'exact_email',
              confidence: 1.0,
            },
          });
          actorId = actor.id;
          actorsCreated++;
          identitiesCreated++;
        } catch (err) {
          const winner = await this.prisma.deliveryActorIdentity.findUnique({
            where: { workspaceId_provider_externalId: { workspaceId, provider: 'email', externalId: email } },
          });
          if (!winner) throw err; // a genuine, non-duplicate failure — do not swallow
          await this.prisma.deliveryActor.delete({ where: { id: actor.id } }).catch(() => {
            // Best-effort cleanup: a concurrent delete or a stray FK is harmless — worst
            // case the speculative actor lingers exactly as it did before this fix.
          });
          actorId = winner.actorId;
        }
        actorByEmail.set(email, actorId);
      }
      actorIdByMemberUserId.set(m.userId, actorId);
    }

    // ── GitHub logins → provider_link identities on the member actor (skip when
    //    already attached). Batch-loaded once, scoped to the member userIds. ──
    const memberUserIds = members.map((m) => m.userId);
    if (memberUserIds.length > 0) {
      const profiles = await this.prisma.oAuthUserProfile.findMany({
        where: { profile_id: { in: memberUserIds }, provider: 'github' },
      });
      for (const p of profiles) {
        if (existingGithub.has(p.username)) continue;
        const actorId = actorIdByMemberUserId.get(p.profile_id);
        if (!actorId) continue; // member has no actor (defensive — should not happen)
        try {
          await this.prisma.deliveryActorIdentity.create({
            data: {
              workspaceId,
              actorId,
              provider: 'github',
              externalId: p.username,
              method: 'provider_link',
              confidence: 1.0,
            },
          });
          identitiesCreated++;
        } catch (err) {
          // Concurrent-safe, same as the email loop above: a parallel Jira sync can attach this same
          // (workspaceId,'github',username) identity first — the unique key throws P2002 on
          // the loser. Benign: the identity now exists, so treat it as attached. A genuine,
          // non-duplicate failure (no such identity on re-read) is rethrown, not swallowed.
          const winner = await this.prisma.deliveryActorIdentity.findUnique({
            where: { workspaceId_provider_externalId: { workspaceId, provider: 'github', externalId: p.username } },
          });
          if (!winner) throw err;
        }
        existingGithub.add(p.username);
      }
    }

    this.logger.debug(`seeded workspace ${workspaceId}: ${actorsCreated} actors, ${identitiesCreated} identities`);
    return { actors: actorsCreated, identities: identitiesCreated };
  }

  /**
   * Resolve a Jira author/assignee to an actorId:
   *  (a) an existing `(workspaceId, 'jira', accountId)` identity → its actorId;
   *  (b) else a verified-email match onto an existing member actor → attach the jira
   *      identity there (`exact_email`);
   *  (c) else a fresh unmatched actor (kind from hints) + jira identity
   *      (`provider_link`).
   */
  async resolveJiraActor(workspaceId: string, hints: JiraActorHints): Promise<string> {
    const { accountId } = hints;

    // (a) already resolved.
    const existing = await this.prisma.deliveryActorIdentity.findUnique({
      where: { workspaceId_provider_externalId: { workspaceId, provider: 'jira', externalId: accountId } },
    });
    if (existing) return existing.actorId;

    // (b) auto-match on a verified email to an existing actor.
    const email = hints.email?.toLowerCase();
    if (email) {
      const emailIdentity = await this.prisma.deliveryActorIdentity.findUnique({
        where: { workspaceId_provider_externalId: { workspaceId, provider: 'email', externalId: email } },
      });
      if (emailIdentity) {
        return this.attachJiraIdentity(workspaceId, emailIdentity.actorId, accountId, 'exact_email');
      }
    }

    // (c) unmatched — create a fresh actor and link the jira identity to it.
    const actor = await this.prisma.deliveryActor.create({
      data: {
        workspaceId,
        displayName: hints.displayName ?? accountId,
        kind: hints.kind,
        memberUserId: null,
      },
    });
    return this.attachJiraIdentity(workspaceId, actor.id, accountId, 'provider_link');
  }

  /**
   * Create the `(workspaceId, 'jira', accountId)` identity on `actorId` and return it.
   *
   * Concurrent-sync tolerance: two importer runs can race to create the same jira
   * identity. The loser's insert hits the unique constraint — catch it, re-read the
   * winning row, and honor whichever actor it points at. Only rethrow if the re-read
   * finds nothing (a genuine, non-duplicate failure).
   */
  private async attachJiraIdentity(
    workspaceId: string,
    actorId: string,
    accountId: string,
    method: 'exact_email' | 'provider_link',
  ): Promise<string> {
    try {
      await this.prisma.deliveryActorIdentity.create({
        data: { workspaceId, actorId, provider: 'jira', externalId: accountId, method, confidence: 1.0 },
      });
      return actorId;
    } catch (err) {
      const winner = await this.prisma.deliveryActorIdentity.findUnique({
        where: { workspaceId_provider_externalId: { workspaceId, provider: 'jira', externalId: accountId } },
      });
      if (winner) return winner.actorId;
      throw err;
    }
  }

  /**
   * The admin unmatched-identities queue: actors with no linked member, excluding
   * bots (design §5.4 — bots are out of human metrics and not worth admin triage),
   * newest first, capped at 200, each with its identities. Identities are
   * batch-loaded in one query and joined in memory (no N+1).
   */
  async listUnmatched(workspaceId: string): Promise<{ actors: UnmatchedActor[] }> {
    const actors = await this.prisma.deliveryActor.findMany({
      where: { workspaceId, memberUserId: null, kind: { not: 'bot' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    if (actors.length === 0) return { actors: [] };

    const actorIds = actors.map((a) => a.id);
    const identities = await this.prisma.deliveryActorIdentity.findMany({
      where: { workspaceId, actorId: { in: actorIds } },
    });
    const byActor = new Map<string, { provider: string; externalId: string; method: string }[]>();
    for (const id of identities) {
      const entry = { provider: id.provider, externalId: id.externalId, method: id.method };
      const bucket = byActor.get(id.actorId);
      if (bucket) bucket.push(entry);
      else byActor.set(id.actorId, [entry]);
    }

    return {
      actors: actors.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        kind: a.kind,
        createdAt: a.createdAt,
        identities: byActor.get(a.id) ?? [],
      })),
    };
  }

  /**
   * Merge `fromActorId` into `intoActorId`: move its identities and repoint every
   * canonical fact attributed to it, then delete it. Both actors must exist in the workspace
   * (`NotFoundException` otherwise); a self-merge is a `BadRequestException`.
   */
  async mergeActors(
    workspaceId: string,
    fromActorId: string,
    intoActorId: string,
  ): Promise<{ movedIdentities: number }> {
    if (fromActorId === intoActorId) {
      throw new BadRequestException('Cannot merge an actor into itself');
    }

    const [from, into] = await Promise.all([
      this.prisma.deliveryActor.findFirst({ where: { id: fromActorId, workspaceId } }),
      this.prisma.deliveryActor.findFirst({ where: { id: intoActorId, workspaceId } }),
    ]);
    if (!from) throw new NotFoundException(`Actor ${fromActorId} not found in workspace ${workspaceId}`);
    if (!into) throw new NotFoundException(`Actor ${intoActorId} not found in workspace ${workspaceId}`);

    // Sequential updates, no transaction: every step is an idempotent updateMany, so
    // a re-run of the merge (e.g. after a mid-way failure) simply finds the from-actor's
    // rows already empty and converges. The from-actor is deleted last, after every FK
    // has been repointed, so any interruption leaves a re-runnable state.
    const moved = await this.prisma.deliveryActorIdentity.updateMany({
      where: { workspaceId, actorId: fromActorId },
      data: { actorId: intoActorId },
    });
    await this.prisma.taskExternalRefStateFact.updateMany({
      where: { workspaceId, actorId: fromActorId },
      data: { actorId: intoActorId },
    });
    // Coredoc ship evidence stores a user principal in actorId, not a
    // DeliveryActor. Only Jira evidence participates in this registry merge.
    await this.prisma.deliveryShipEvidence.updateMany({
      where: { workspaceId, actorId: fromActorId, provider: 'jira' },
      data: { actorId: intoActorId },
    });
    await this.prisma.deliveryActor.delete({ where: { id: fromActorId } });

    this.logger.debug(`merged actor ${fromActorId} into ${intoActorId} (${moved.count} identities moved)`);
    return { movedIdentities: moved.count };
  }
}
