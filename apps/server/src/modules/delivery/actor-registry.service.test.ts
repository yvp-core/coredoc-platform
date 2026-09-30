import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service.js';
import { ActorRegistryService } from './actor-registry.service.js';

const WS = 'ws-1';

/**
 * Mock Prisma in the house style: one `vi.fn()` per accessor method used by the
 * service, resolved values wired per test, call args asserted. Identity `findMany`
 * dispatches on `where.provider` so `seedWorkspace`'s email/github batch loads each
 * get the right subset without call-order coupling.
 */
function mockPrisma(opts?: {
  members?: unknown[];
  emailIdentities?: Array<{ externalId: string; actorId: string }>;
  githubIdentities?: Array<{ externalId: string; actorId: string }>;
  oauthProfiles?: unknown[];
  actorCreateIds?: string[];
  unmatchedActors?: unknown[];
  unmatchedIdentities?: unknown[];
  identityFindUnique?: unknown[];
  actorsById?: Record<string, unknown>;
}) {
  const actorCreateIds = [...(opts?.actorCreateIds ?? [])];
  const identityFindUnique = [...(opts?.identityFindUnique ?? [])];

  const prisma = {
    workspaceMember: {
      findMany: vi.fn().mockResolvedValue(opts?.members ?? []),
    },
    oAuthUserProfile: {
      findMany: vi.fn().mockResolvedValue(opts?.oauthProfiles ?? []),
    },
    deliveryActor: {
      findMany: vi.fn().mockResolvedValue(opts?.unmatchedActors ?? []),
      findFirst: vi
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(opts?.actorsById?.[where.id] ?? null),
        ),
      create: vi.fn().mockImplementation(() => Promise.resolve({ id: actorCreateIds.shift() ?? 'actor-new' })),
      delete: vi.fn().mockResolvedValue({}),
    },
    deliveryActorIdentity: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { provider?: string } }) => {
        if (where.provider === 'email') return Promise.resolve(opts?.emailIdentities ?? []);
        if (where.provider === 'github') return Promise.resolve(opts?.githubIdentities ?? []);
        // listUnmatched batch-load (actorId `in`, no provider filter)
        return Promise.resolve(opts?.unmatchedIdentities ?? []);
      }),
      findUnique: vi.fn().mockImplementation(() => Promise.resolve(identityFindUnique.shift() ?? null)),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    taskExternalRefStateFact: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    deliveryShipEvidence: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

describe('ActorRegistryService.seedWorkspace', () => {
  it('is concurrent-safe: adopts the winner and deletes the orphan actor on a racing email-identity insert', async () => {
    const prisma = mockPrisma({
      members: [{ workspaceId: WS, userId: 'u1', email: 'Alice@X.com', displayName: 'Alice' }],
      emailIdentities: [], // absent at load time — a parallel seed creates it mid-run
      actorCreateIds: ['orphan-actor'], // the actor we speculatively create
      identityFindUnique: [{ actorId: 'winner-actor' }], // the re-read finds the winner
    });
    // The email-identity insert loses the race → unique-constraint violation.
    (prisma.deliveryActorIdentity.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('P2002'));
    const service = new ActorRegistryService(prisma);

    const res = await service.seedWorkspace(WS);

    // Net created nothing (the insert lost); the speculative actor is deleted, not orphaned.
    expect(res).toEqual({ actors: 0, identities: 0 });
    expect(prisma.deliveryActor.delete).toHaveBeenCalledWith({ where: { id: 'orphan-actor' } });
  });

  it('is concurrent-safe on the github identity: a racing P2002 loser is treated as attached, not thrown', async () => {
    const prisma = mockPrisma({
      // Email identity already attached → the email create is skipped; the github insert is
      // the only create, and it loses a concurrent race.
      members: [{ workspaceId: WS, userId: 'u1', email: 'alice@x.com', displayName: 'Alice' }],
      emailIdentities: [{ externalId: 'alice@x.com', actorId: 'a1' }],
      oauthProfiles: [{ profile_id: 'u1', provider: 'github', username: 'alice-gh' }],
      githubIdentities: [], // absent at load — a parallel seed attaches it mid-run
      identityFindUnique: [{ actorId: 'a1' }], // the re-read finds the winner's github identity
    });
    (prisma.deliveryActorIdentity.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('P2002'));
    const service = new ActorRegistryService(prisma);

    const res = await service.seedWorkspace(WS);

    // The github insert lost the race → nothing net created, and no throw escapes.
    expect(res).toEqual({ actors: 0, identities: 0 });
  });

  it('rethrows a genuine (non-duplicate) github identity insert failure instead of swallowing it', async () => {
    const prisma = mockPrisma({
      members: [{ workspaceId: WS, userId: 'u1', email: 'alice@x.com', displayName: 'Alice' }],
      emailIdentities: [{ externalId: 'alice@x.com', actorId: 'a1' }],
      oauthProfiles: [{ profile_id: 'u1', provider: 'github', username: 'alice-gh' }],
      githubIdentities: [],
      identityFindUnique: [], // re-read finds no identity → not a duplicate race → rethrow
    });
    (prisma.deliveryActorIdentity.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    const service = new ActorRegistryService(prisma);

    await expect(service.seedWorkspace(WS)).rejects.toThrow('db down');
  });

  it('happy path: 2 members (1 with a github profile) → 2 actors + 3 identities', async () => {
    const prisma = mockPrisma({
      members: [
        { workspaceId: WS, userId: 'u1', email: 'Alice@X.com', displayName: 'Alice' },
        { workspaceId: WS, userId: 'u2', email: 'bob@x.com', displayName: null },
      ],
      oauthProfiles: [{ profile_id: 'u1', provider: 'github', username: 'alice-gh' }],
      actorCreateIds: ['a1', 'a2'],
    });
    const service = new ActorRegistryService(prisma);

    const result = await service.seedWorkspace(WS);

    expect(result).toEqual({ actors: 2, identities: 3 });
    expect(prisma.deliveryActor.create).toHaveBeenCalledTimes(2);
    expect(prisma.deliveryActorIdentity.create).toHaveBeenCalledTimes(3);

    // member without a displayName falls back to the email
    expect(prisma.deliveryActor.create).toHaveBeenCalledWith({
      data: { workspaceId: WS, displayName: 'Alice', kind: 'human', memberUserId: 'u1' },
    });
    expect(prisma.deliveryActor.create).toHaveBeenCalledWith({
      data: { workspaceId: WS, displayName: 'bob@x.com', kind: 'human', memberUserId: 'u2' },
    });

    // email identity is lowercased with exact_email; github identity is provider_link on a1
    const idCreates = prisma.deliveryActorIdentity.create.mock.calls.map((c) => c[0].data);
    expect(idCreates).toContainEqual({
      workspaceId: WS,
      actorId: 'a1',
      provider: 'email',
      externalId: 'alice@x.com',
      method: 'exact_email',
      confidence: 1.0,
    });
    expect(idCreates).toContainEqual({
      workspaceId: WS,
      actorId: 'a1',
      provider: 'github',
      externalId: 'alice-gh',
      method: 'provider_link',
      confidence: 1.0,
    });

    // oauth profiles are batch-loaded once, scoped to the member userIds
    expect(prisma.oAuthUserProfile.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.oAuthUserProfile.findMany).toHaveBeenCalledWith({
      where: { profile_id: { in: ['u1', 'u2'] }, provider: 'github' },
    });
  });

  it('idempotency: pre-existing email + github identities → 0 creates', async () => {
    const prisma = mockPrisma({
      members: [
        { workspaceId: WS, userId: 'u1', email: 'alice@x.com', displayName: 'Alice' },
        { workspaceId: WS, userId: 'u2', email: 'bob@x.com', displayName: 'Bob' },
      ],
      emailIdentities: [
        { externalId: 'alice@x.com', actorId: 'a1' },
        { externalId: 'bob@x.com', actorId: 'a2' },
      ],
      githubIdentities: [{ externalId: 'alice-gh', actorId: 'a1' }],
      oauthProfiles: [{ profile_id: 'u1', provider: 'github', username: 'alice-gh' }],
    });
    const service = new ActorRegistryService(prisma);

    const result = await service.seedWorkspace(WS);

    expect(result).toEqual({ actors: 0, identities: 0 });
    expect(prisma.deliveryActor.create).not.toHaveBeenCalled();
    expect(prisma.deliveryActorIdentity.create).not.toHaveBeenCalled();
  });
});

describe('ActorRegistryService.resolveJiraActor', () => {
  it('(a) returns the actorId of an existing jira identity without creating anything', async () => {
    const prisma = mockPrisma({ identityFindUnique: [{ actorId: 'actor-X', provider: 'jira', externalId: 'acc-1' }] });
    const service = new ActorRegistryService(prisma);

    const actorId = await service.resolveJiraActor(WS, { accountId: 'acc-1', kind: 'human' });

    expect(actorId).toBe('actor-X');
    expect(prisma.deliveryActor.create).not.toHaveBeenCalled();
    expect(prisma.deliveryActorIdentity.create).not.toHaveBeenCalled();
  });

  it('(b) email auto-match attaches a jira identity to the member actor', async () => {
    const prisma = mockPrisma({
      // 1st findUnique (jira) → null; 2nd findUnique (email) → member actor
      identityFindUnique: [null, { actorId: 'actor-M', provider: 'email', externalId: 'dev@x.com' }],
    });
    const service = new ActorRegistryService(prisma);

    const actorId = await service.resolveJiraActor(WS, {
      accountId: 'acc-2',
      email: 'Dev@X.com',
      displayName: 'Dev',
      kind: 'human',
    });

    expect(actorId).toBe('actor-M');
    expect(prisma.deliveryActor.create).not.toHaveBeenCalled();
    expect(prisma.deliveryActorIdentity.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WS,
        actorId: 'actor-M',
        provider: 'jira',
        externalId: 'acc-2',
        method: 'exact_email',
        confidence: 1.0,
      },
    });
  });

  it('(c) unmatched: creates a fresh actor with kind from hints + a provider_link identity', async () => {
    const prisma = mockPrisma({
      identityFindUnique: [null], // no existing jira identity; no email hint → no email lookup
      actorCreateIds: ['bot-actor'],
    });
    const service = new ActorRegistryService(prisma);

    const actorId = await service.resolveJiraActor(WS, {
      accountId: 'acc-bot',
      displayName: 'Automation Bot',
      kind: 'bot',
    });

    expect(actorId).toBe('bot-actor');
    expect(prisma.deliveryActor.create).toHaveBeenCalledWith({
      data: { workspaceId: WS, displayName: 'Automation Bot', kind: 'bot', memberUserId: null },
    });
    expect(prisma.deliveryActorIdentity.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WS,
        actorId: 'bot-actor',
        provider: 'jira',
        externalId: 'acc-bot',
        method: 'provider_link',
        confidence: 1.0,
      },
    });
  });

  it('is concurrent-tolerant: a duplicate identity create is caught and the winning actorId re-read', async () => {
    const prisma = mockPrisma({
      // 1st findUnique (jira) → null; re-read after the create throws → winner
      identityFindUnique: [null, { actorId: 'winner-actor', provider: 'jira', externalId: 'acc-race' }],
      actorCreateIds: ['loser-actor'],
    });
    // the identity create loses the race → unique-constraint violation
    (prisma.deliveryActorIdentity.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unique constraint failed'),
    );
    const service = new ActorRegistryService(prisma);

    const actorId = await service.resolveJiraActor(WS, { accountId: 'acc-race', kind: 'human' });

    expect(actorId).toBe('winner-actor');
  });
});

describe('ActorRegistryService.listUnmatched', () => {
  it('excludes bots and matched actors, batch-loads identities (no N+1), newest first', async () => {
    const prisma = mockPrisma({
      unmatchedActors: [
        { id: 'u-2', displayName: 'Newer', kind: 'human', createdAt: new Date('2026-07-02') },
        { id: 'u-1', displayName: null, kind: 'agent', createdAt: new Date('2026-07-01') },
      ],
      unmatchedIdentities: [
        { actorId: 'u-2', provider: 'jira', externalId: 'acc-2', method: 'provider_link' },
        { actorId: 'u-1', provider: 'jira', externalId: 'acc-1', method: 'provider_link' },
        { actorId: 'u-1', provider: 'email', externalId: 'x@y.com', method: 'exact_email' },
      ],
    });
    const service = new ActorRegistryService(prisma);

    const { actors } = await service.listUnmatched(WS);

    // query excludes matched members and bots, newest-first, capped
    expect(prisma.deliveryActor.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, memberUserId: null, kind: { not: 'bot' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    // identities loaded in ONE query for all actor ids (no N+1)
    expect(prisma.deliveryActorIdentity.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.deliveryActorIdentity.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, actorId: { in: ['u-2', 'u-1'] } },
    });

    expect(actors).toEqual([
      {
        id: 'u-2',
        displayName: 'Newer',
        kind: 'human',
        createdAt: new Date('2026-07-02'),
        identities: [{ provider: 'jira', externalId: 'acc-2', method: 'provider_link' }],
      },
      {
        id: 'u-1',
        displayName: null,
        kind: 'agent',
        createdAt: new Date('2026-07-01'),
        identities: [
          { provider: 'jira', externalId: 'acc-1', method: 'provider_link' },
          { provider: 'email', externalId: 'x@y.com', method: 'exact_email' },
        ],
      },
    ]);
  });
});

describe('ActorRegistryService.mergeActors', () => {
  it('repoints canonical Jira actor facts before deleting the from-actor', async () => {
    const prisma = mockPrisma({
      actorsById: { 'a-from': { id: 'a-from', workspaceId: WS }, 'a-into': { id: 'a-into', workspaceId: WS } },
    });
    (prisma.deliveryActorIdentity.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });
    const service = new ActorRegistryService(prisma);

    const result = await service.mergeActors(WS, 'a-from', 'a-into');

    expect(result).toEqual({ movedIdentities: 3 });

    // 1: identities moved
    expect(prisma.deliveryActorIdentity.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, actorId: 'a-from' },
      data: { actorId: 'a-into' },
    });
    // Canonical Jira state/evidence remains attributed after the duplicate actor is removed.
    expect(prisma.taskExternalRefStateFact.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, actorId: 'a-from' },
      data: { actorId: 'a-into' },
    });
    expect(prisma.deliveryShipEvidence.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, actorId: 'a-from', provider: 'jira' },
      data: { actorId: 'a-into' },
    });

    // The source actor is deleted only after both newly added canonical surfaces move.
    expect(prisma.deliveryActor.delete).toHaveBeenCalledWith({ where: { id: 'a-from' } });
    const stateFacts = prisma.taskExternalRefStateFact.updateMany.mock.invocationCallOrder[0];
    const jiraEvidence = prisma.deliveryShipEvidence.updateMany.mock.invocationCallOrder[0];
    const actorDelete = prisma.deliveryActor.delete.mock.invocationCallOrder[0];
    expect(stateFacts).toBeLessThan(actorDelete);
    expect(jiraEvidence).toBeLessThan(actorDelete);
  });

  it('rejects merge-into-self with BadRequestException before touching the db', async () => {
    const prisma = mockPrisma();
    const service = new ActorRegistryService(prisma);

    await expect(service.mergeActors(WS, 'a-1', 'a-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.deliveryActor.findFirst).not.toHaveBeenCalled();
    expect(prisma.deliveryActor.delete).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when an actor is foreign to the workspace', async () => {
    const prisma = mockPrisma({
      // from-actor exists, into-actor belongs to another workspace → findFirst null
      actorsById: { 'a-from': { id: 'a-from', workspaceId: WS } },
    });
    const service = new ActorRegistryService(prisma);

    await expect(service.mergeActors(WS, 'a-from', 'a-foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.deliveryActor.delete).not.toHaveBeenCalled();
  });
});
