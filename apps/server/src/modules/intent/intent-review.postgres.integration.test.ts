import '../../config/load-env.js';
import { createHash } from 'node:crypto';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentItemAuthority, PrismaClient } from '../../generated/prisma/client.js';
import { IntentReviewController } from './intent-review.controller.js';
import { IntentReviewService } from './intent-review.service.js';

import { IntentTransitionsService } from './intent-transitions.service.js';
import { IntentErrorCode } from './contract/index.js';

/**
 * The review lifecycle against real PostgreSQL (spec §5, §14).
 *
 * A separate file from `intent-module.postgres.integration.test.ts` because it
 * exercises a different property: that one HTTP request can be half-applied on
 * purpose (item-by-item results) while a replacement pair inside it is still
 * all-or-nothing. Proving that needs concurrent connections, an induced
 * mid-transaction failure, and a lot of row-state assertions — a suite of its
 * own rather than a fifth of the module suite.
 *
 * Only `AuthGuard` is stubbed, as in the module suite: `WorkspaceRoleGuard`,
 * `PermissionsGuard`, and `UserSessionGuard` are the real ones, so "a service
 * token can never change authority" is proven through the production path.
 */
const TEST_DATABASE_URL = process.env.INTENT_REVIEW_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const REPO_KEY = 'coredoc/intent-review-fixture';

const AUTHORIZING_SOURCE = { kind: 'spec', ref: 'spec/refunds', localId: 'REV-1', revision: 'rev-9' };
const WORK_ITEM = { provider: 'jira', id: 'ENG-42', displayKey: 'ENG-42' };

function graphHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

let keySeed = 0;
function nextKey(prefix: string): string {
  keySeed += 1;
  return `${prefix}-${RUN}-${keySeed}`;
}

interface Principal {
  user: { id: string; email: string };
  serviceToken?: { permissions: string[] };
}

interface DecisionResult {
  decisionIndex: number;
  itemId: string;
  outcome: string;
  authority: string | null;
  version: number | null;
  replacement?: { itemId: string; authority: string; version: number };
  error?: { code: string; message: string; path: string[] };
}

describe.skipIf(!TEST_DATABASE_URL)('intent review lifecycle (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let principal: Principal;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `intent-review-${RUN}`, slug: `intent-review-${RUN}`, intentEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: OWNER.id, email: OWNER.email, role: 'owner' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    await prisma.workspaceRepo.create({
      data: { workspaceId, repoKey: graphHash(REPO_KEY), repoName: REPO_KEY, intentRepoKey: REPO_KEY },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentReviewController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        IntentReviewService,
        IntentTransitionsService,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const httpRequest = context.switchToHttp().getRequest();
          httpRequest.user = principal.user;
          if (principal.serviceToken) {
            httpRequest.serviceTokenWorkspaceId = workspaceId;
            httpRequest.serviceTokenPermissions = principal.serviceToken.permissions;
          }
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    if (workspaceId) {
      await prisma.intentAuthorityTransition.deleteMany({ where: { workspaceId } });
      await prisma.intentItemSource.deleteMany({ where: { workspaceId } });
      await prisma.intentItem.updateMany({ where: { workspaceId }, data: { supersededById: null } });
      await prisma.intentItem.updateMany({ where: { workspaceId }, data: { proposedSuccessorOfId: null } });
      await prisma.intentItem.deleteMany({ where: { workspaceId } });
      await prisma.intentAuditEvent.deleteMany({ where: { workspaceId } });
      await prisma.intentMutationRequest.deleteMany({ where: { workspaceId } });
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(() => {
    principal = { user: OWNER };
  });

  function api() {
    return request(app.getHttpServer());
  }

  function base() {
    return `/api/v1/workspaces/${workspaceId}/intent`;
  }

  /**
   * Seed one candidate directly.
   *
   * Rows rather than a propose call: this suite is about what
   * REVIEW does to an item, and propose has its own suite. Going through the
   * propose service here would drag its whole dependency graph — and every
   * future change to it — into a file that has nothing to say about proposing.
   */
  async function seedCandidate(id: string, overrides: Record<string, unknown> = {}) {
    await prisma.intentItem.create({
      data: {
        workspaceId,
        id,
        kind: 'business_rule',
        title: `Rule ${id}`,
        statement: `The rule ${id} states something bounded.`,
        createdBy: OWNER.id,
        updatedBy: OWNER.id,
        ...overrides,
      },
    });
    return itemRow(id);
  }

  function reviewBody(decisions: unknown[], overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: nextKey('review'),
      authorizingSource: AUTHORIZING_SOURCE,
      workItem: WORK_ITEM,
      decisions,
      ...overrides,
    };
  }

  async function review(decisions: unknown[], overrides: Record<string, unknown> = {}) {
    const response = await api().post(`${base()}/items/review`).send(reviewBody(decisions, overrides)).expect(201);
    return response.body.decisions as DecisionResult[];
  }

  function itemRow(id: string) {
    return prisma.intentItem.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id } } });
  }

  function transitionsOf(itemId: string) {
    return prisma.intentAuthorityTransition.findMany({
      where: { workspaceId, itemId },
      orderBy: { id: 'asc' },
    });
  }

  /** Accept a candidate outright so it can later be superseded. */
  async function acceptedItem(id: string) {
    const candidate = await seedCandidate(id);
    const [result] = await review([
      { itemId: id, expectedVersion: candidate.version, action: 'accept', reason: 'Accepted for the fixture.' },
    ]);
    expect(result?.outcome).toBe('accepted');
    return itemRow(id);
  }

  /* ------------------------------------------------------- decisions --- */

  describe('decisions', () => {
    it('refuses spec approval without a revision before changing authority', async () => {
      const candidate = await seedCandidate('br-unversioned-spec');
      const { revision: _revision, ...authorizingSource } = AUTHORIZING_SOURCE;
      const response = await api()
        .post(`${base()}/items/review`)
        .send(
          reviewBody(
            [
              {
                itemId: candidate.id,
                expectedVersion: candidate.version,
                action: 'accept',
                reason: 'Approved specification.',
              },
            ],
            { authorizingSource },
          ),
        )
        .expect(400);
      expect(response.body.path).toEqual(['authorizingSource', 'revision']);
      expect((await itemRow(candidate.id)).authority).toBe('candidate');
      expect(await transitionsOf(candidate.id)).toEqual([]);
    });

    it('accepts and rejects in one batch, writing one transition per authority change', async () => {
      const accepted = await seedCandidate('br-accepted-in-batch');
      const rejected = await seedCandidate('br-rejected-in-batch');

      const decisions = await review([
        {
          itemId: accepted.id,
          expectedVersion: accepted.version,
          action: 'accept',
          reason: 'The spec mandates this rule.',
        },
        {
          itemId: rejected.id,
          expectedVersion: rejected.version,
          action: 'reject',
          reason: 'Superseded by a product decision.',
        },
      ]);

      expect(decisions).toMatchObject([
        { itemId: accepted.id, outcome: 'accepted', authority: 'accepted', version: accepted.version + 1 },
        { itemId: rejected.id, outcome: 'rejected', authority: 'rejected', version: rejected.version + 1 },
      ]);
      expect((await itemRow(accepted.id)).authority).toBe(IntentItemAuthority.accepted);
      expect((await itemRow(rejected.id)).authority).toBe(IntentItemAuthority.rejected);

      const [transition] = await transitionsOf(accepted.id);
      expect(transition).toMatchObject({
        fromAuthority: IntentItemAuthority.candidate,
        toAuthority: IntentItemAuthority.accepted,
        // Identity is the token's, never the payload's (spec §4.7).
        actorId: OWNER.id,
        actorRole: 'owner',
        reason: 'The spec mandates this rule.',
        sourceKind: 'spec',
        sourceRef: AUTHORIZING_SOURCE.ref,
        sourceLocalId: AUTHORIZING_SOURCE.localId,
        sourceRevision: AUTHORIZING_SOURCE.revision,
        workItem: WORK_ITEM,
      });
      expect(await transitionsOf(rejected.id)).toHaveLength(1);
    });

    it('reports defer and needs_edit without a transition row or a version bump', async () => {
      const deferred = await seedCandidate('br-deferred');
      const edited = await seedCandidate('br-needs-edit');

      const decisions = await review([
        { itemId: deferred.id, expectedVersion: deferred.version, action: 'defer', reason: 'Waiting on legal.' },
        { itemId: edited.id, expectedVersion: edited.version, action: 'needs_edit', reason: 'The statement is vague.' },
      ]);

      expect(decisions).toMatchObject([
        { itemId: deferred.id, outcome: 'deferred', authority: 'candidate', version: deferred.version },
        { itemId: edited.id, outcome: 'needs_edit', authority: 'candidate', version: edited.version },
      ]);
      expect(await transitionsOf(deferred.id)).toHaveLength(0);
      expect(await transitionsOf(edited.id)).toHaveLength(0);
      expect(await itemRow(deferred.id)).toMatchObject({ version: deferred.version, authority: 'candidate' });
    });

    it('applies the sound decisions of a batch and refuses only the unsound one', async () => {
      const sound = await seedCandidate('br-sound-decision');
      const ghostId = 'br-no-such-item';

      const decisions = await review([
        { itemId: ghostId, expectedVersion: 1, action: 'accept', reason: 'This item does not exist.' },
        { itemId: sound.id, expectedVersion: sound.version, action: 'accept', reason: 'This one is fine.' },
      ]);

      expect(decisions[0]).toMatchObject({
        itemId: ghostId,
        outcome: 'refused',
        authority: null,
        version: null,
        error: { code: IntentErrorCode.ItemNotFound, path: ['decisions', '0', 'itemId'] },
      });
      expect(decisions[1]?.outcome).toBe('accepted');
      // The refusal did NOT roll back its sibling — that is the whole point.
      expect((await itemRow(sound.id)).authority).toBe(IntentItemAuthority.accepted);
    });
  });

  /* --------------------------------------------------- invalid states --- */

  describe('invalid state changes', () => {
    it('refuses accepting or rejecting an item that is no longer a candidate', async () => {
      const item = await acceptedItem('br-already-accepted');

      const [reAccept] = await review([
        { itemId: item.id, expectedVersion: item.version, action: 'accept', reason: 'Accept it twice.' },
      ]);
      expect(reAccept).toMatchObject({
        outcome: 'refused',
        authority: 'accepted',
        version: item.version,
        error: { code: IntentErrorCode.ItemNotCandidate },
      });

      const [reReject] = await review([
        { itemId: item.id, expectedVersion: item.version, action: 'reject', reason: 'Reject what was accepted.' },
      ]);
      expect(reReject?.error?.code).toBe(IntentErrorCode.ItemNotCandidate);
      expect(await itemRow(item.id)).toMatchObject({ authority: 'accepted', version: item.version });
      expect(await transitionsOf(item.id)).toHaveLength(1);
    });

    it('refuses superseding a candidate — only an accepted item has authority to lose', async () => {
      const predecessor = await seedCandidate('br-candidate-predecessor');
      const successor = await seedCandidate('br-candidate-successor');

      const [result] = await review([
        {
          itemId: predecessor.id,
          expectedVersion: predecessor.version,
          action: 'supersede',
          replacementItemId: successor.id,
          replacementExpectedVersion: successor.version,
          reason: 'Supersede a candidate.',
        },
      ]);
      expect(result?.error?.code).toBe(IntentErrorCode.ItemNotAccepted);
      expect((await itemRow(predecessor.id)).version).toBe(predecessor.version);
    });

    it('refuses a supersession whose replacement never proposed to replace the predecessor', async () => {
      const predecessor = await acceptedItem('br-unrelated-predecessor');
      const stranger = await seedCandidate('br-unrelated-successor');

      const [result] = await review([
        {
          itemId: predecessor.id,
          expectedVersion: predecessor.version,
          action: 'supersede',
          replacementItemId: stranger.id,
          replacementExpectedVersion: stranger.version,
          reason: 'Pair two unrelated items.',
        },
      ]);
      expect(result?.error).toMatchObject({
        code: IntentErrorCode.ReplacementNotProposed,
        path: ['decisions', '0', 'replacementItemId'],
      });
      expect(await itemRow(predecessor.id)).toMatchObject({ authority: 'accepted', supersededById: null });
    });

    it('refuses a plain accept of a candidate that proposes a replacement', async () => {
      const predecessor = await acceptedItem('br-guarded-predecessor');
      const successor = await seedCandidate('br-guarded-successor', { proposedSuccessorOfId: predecessor.id });

      const [result] = await review([
        {
          itemId: successor.id,
          expectedVersion: successor.version,
          action: 'accept',
          reason: 'Accept without checking the predecessor.',
        },
      ]);
      expect(result?.error).toMatchObject({
        code: IntentErrorCode.ReplacementDecisionRequired,
        path: ['decisions', '0', 'action'],
      });
      expect((await itemRow(successor.id)).authority).toBe(IntentItemAuthority.candidate);
      expect((await itemRow(predecessor.id)).authority).toBe(IntentItemAuthority.accepted);
    });

    it('refuses the whole batch when it decides one item twice, counting the replacement', async () => {
      const predecessor = await acceptedItem('br-twice-predecessor');
      const successor = await seedCandidate('br-twice-successor', { proposedSuccessorOfId: predecessor.id });

      const response = await api()
        .post(`${base()}/items/review`)
        .send(
          reviewBody([
            {
              itemId: predecessor.id,
              expectedVersion: predecessor.version,
              action: 'supersede',
              replacementItemId: successor.id,
              replacementExpectedVersion: successor.version,
              reason: 'Replace it.',
            },
            {
              itemId: successor.id,
              expectedVersion: successor.version,
              action: 'accept',
              reason: 'And accept it again.',
            },
          ]),
        )
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.ReviewSubjectRepeated);
      expect((await itemRow(predecessor.id)).authority).toBe(IntentItemAuthority.accepted);
    });

    it("refuses 'import' as a review's authorizing source — that kind belongs to the import flow", async () => {
      const item = await seedCandidate('br-import-authorized');
      const response = await api()
        .post(`${base()}/items/review`)
        .send(
          reviewBody(
            [{ itemId: item.id, expectedVersion: item.version, action: 'accept', reason: 'Arrived from a file.' }],
            { authorizingSource: { kind: 'import', ref: 'local/.coredoc/intent.json', localId: 'IMP-1' } },
          ),
        )
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.AuthorizingSourceKindNotAllowed);
      expect(response.body.path).toEqual(['authorizingSource', 'kind']);
      expect((await itemRow(item.id)).authority).toBe(IntentItemAuthority.candidate);
    });
  });

  /* ------------------------------------------------------- gate (§5) --- */

  describe('permission gate', () => {
    it('refuses ANY service token whatever its permissions, and lets a plain member review (BR-1)', async () => {
      const item = await seedCandidate('br-gated-rule');
      const body = reviewBody([
        { itemId: item.id, expectedVersion: item.version, action: 'accept', reason: 'Accepted by a member.' },
      ]);

      principal = {
        user: OWNER,
        serviceToken: { permissions: [TokenPermission.IntentRead, TokenPermission.IntentPropose, '*'] },
      };
      await api().post(`${base()}/items/review`).send(body).expect(403);
      expect(await itemRow(item.id)).toMatchObject({ authority: 'candidate', version: item.version });
      expect(await transitionsOf(item.id)).toHaveLength(0);

      principal = { user: MEMBER };
      await api().post(`${base()}/items/review`).send(body).expect(201);
      expect(await itemRow(item.id)).toMatchObject({ authority: 'accepted' });
      expect(await transitionsOf(item.id)).toHaveLength(1);
    });
  });

  /* ----------------------------------------------------- concurrency --- */

  describe('concurrent review (spec §14)', () => {
    it('lets two reviewers decide DIFFERENT items at once, both without a retry', async () => {
      const left = await seedCandidate('br-concurrent-left');
      const right = await seedCandidate('br-concurrent-right');

      const [first, second] = await Promise.all([
        api()
          .post(`${base()}/items/review`)
          .send(
            reviewBody([
              { itemId: left.id, expectedVersion: left.version, action: 'accept', reason: 'Left reviewer.' },
            ]),
          ),
        api()
          .post(`${base()}/items/review`)
          .send(
            reviewBody([
              { itemId: right.id, expectedVersion: right.version, action: 'accept', reason: 'Right reviewer.' },
            ]),
          ),
      ]);

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(first.body.decisions[0].outcome).toBe('accepted');
      expect(second.body.decisions[0].outcome).toBe('accepted');
      expect((await itemRow(left.id)).authority).toBe(IntentItemAuthority.accepted);
      expect((await itemRow(right.id)).authority).toBe(IntentItemAuthority.accepted);
    });

    it('leaves exactly one decision applied when two reviewers decide the SAME item', async () => {
      const item = await seedCandidate('br-contended-rule');
      const decision = (reason: string) => ({
        itemId: item.id,
        expectedVersion: item.version,
        action: 'accept',
        reason,
      });

      const [first, second] = await Promise.all([
        api()
          .post(`${base()}/items/review`)
          .send(reviewBody([decision('First reviewer.')])),
        api()
          .post(`${base()}/items/review`)
          .send(reviewBody([decision('Second reviewer.')])),
      ]);

      const outcomes = [first.body.decisions[0], second.body.decisions[0]] as DecisionResult[];
      const applied = outcomes.filter((result) => result.outcome === 'accepted');
      const conflicted = outcomes.filter((result) => result.outcome === 'refused');
      expect(applied).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      expect(conflicted[0]?.error?.code).toBe(IntentErrorCode.VersionConflict);
      // The conflict names the version that is actually there, so a re-read is exact.
      expect(conflicted[0]?.error?.message).toContain(`current version is ${item.version + 1}`);
      expect(conflicted[0]?.version).toBe(item.version + 1);

      expect(await itemRow(item.id)).toMatchObject({ authority: 'accepted', version: item.version + 1 });
      expect(await transitionsOf(item.id)).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------- replacement --- */

  describe('atomic replacement (spec §5)', () => {
    it('supersedes the predecessor and accepts its replacement in one transaction', async () => {
      const predecessor = await acceptedItem('br-replaced-rule');
      const successor = await seedCandidate('br-replacing-rule', { proposedSuccessorOfId: predecessor.id });

      const [result] = await review([
        {
          itemId: predecessor.id,
          expectedVersion: predecessor.version,
          action: 'supersede',
          replacementItemId: successor.id,
          replacementExpectedVersion: successor.version,
          reason: 'The refund window changed.',
        },
      ]);

      expect(result).toMatchObject({
        itemId: predecessor.id,
        outcome: 'superseded',
        authority: 'superseded',
        version: predecessor.version + 1,
        replacement: { itemId: successor.id, authority: 'accepted', version: successor.version + 1 },
      });
      expect(await itemRow(predecessor.id)).toMatchObject({
        authority: IntentItemAuthority.superseded,
        supersededById: successor.id,
      });
      expect(await itemRow(successor.id)).toMatchObject({ authority: IntentItemAuthority.accepted });

      const predecessorHistory = await transitionsOf(predecessor.id);
      expect(predecessorHistory.map((row) => [row.fromAuthority, row.toAuthority])).toEqual([
        [IntentItemAuthority.candidate, IntentItemAuthority.accepted],
        [IntentItemAuthority.accepted, IntentItemAuthority.superseded],
      ]);
      const successorHistory = await transitionsOf(successor.id);
      expect(successorHistory).toHaveLength(1);
      expect(successorHistory[0]).toMatchObject({
        fromAuthority: IntentItemAuthority.candidate,
        toAuthority: IntentItemAuthority.accepted,
        reason: 'The refund window changed.',
        actorId: OWNER.id,
      });
    });

    it('lets the first competing replacement win and leaves the second a candidate', async () => {
      const predecessor = await acceptedItem('br-contested-predecessor');
      const winner = await seedCandidate('br-contested-winner', { proposedSuccessorOfId: predecessor.id });
      const loser = await seedCandidate('br-contested-loser', { proposedSuccessorOfId: predecessor.id });

      const attempt = (replacement: { id: string; version: number }, reason: string) =>
        api()
          .post(`${base()}/items/review`)
          .send(
            reviewBody([
              {
                itemId: predecessor.id,
                expectedVersion: predecessor.version,
                action: 'supersede',
                replacementItemId: replacement.id,
                replacementExpectedVersion: replacement.version,
                reason,
              },
            ]),
          );

      const responses = await Promise.all([
        attempt(winner, 'First replacement.'),
        attempt(loser, 'Second replacement.'),
      ]);
      const results = responses.map((response) => response.body.decisions[0] as DecisionResult);
      const applied = results.filter((result) => result.outcome === 'superseded');
      const conflicted = results.filter((result) => result.outcome === 'refused');

      expect(applied).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      expect(conflicted[0]?.error?.code).toBe(IntentErrorCode.VersionConflict);

      const winnerId = applied[0]?.replacement?.itemId as string;
      const loserId = winnerId === winner.id ? loser.id : winner.id;
      expect(await itemRow(predecessor.id)).toMatchObject({
        authority: IntentItemAuthority.superseded,
        supersededById: winnerId,
      });
      // The competing proposal is untouched: still a candidate, re-targetable.
      expect(await itemRow(loserId)).toMatchObject({ authority: IntentItemAuthority.candidate, version: 1 });
      expect(await transitionsOf(loserId)).toHaveLength(0);
    });

    it('rolls the pair back entirely when the transaction fails between its two updates', async () => {
      const predecessor = await acceptedItem('br-rollback-predecessor');
      const successor = await seedCandidate('br-rollback-successor', { proposedSuccessorOfId: predecessor.id });
      const idempotencyKey = nextKey('rollback');

      // A PrismaService whose transaction fails on the SECOND item update: the
      // first half of the pair has already been written when it throws.
      const failing = {
        $transaction: (run: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => run(failAfterFirstItemUpdate(tx))),
      } as unknown as PrismaService;

      await expect(
        new IntentReviewService(failing).review(workspaceId, { id: OWNER.id, role: 'owner' }, {
          idempotencyKey,
          authorizingSource: AUTHORIZING_SOURCE,
          workItem: WORK_ITEM,
          decisions: [
            {
              itemId: predecessor.id,
              expectedVersion: predecessor.version,
              action: 'supersede' as never,
              replacementItemId: successor.id,
              replacementExpectedVersion: successor.version,
              reason: 'This replacement never commits.',
            },
          ],
        } as never),
      ).rejects.toThrow(INDUCED_FAILURE);

      expect(await itemRow(predecessor.id)).toMatchObject({
        authority: IntentItemAuthority.accepted,
        version: predecessor.version,
        supersededById: null,
      });
      expect(await itemRow(successor.id)).toMatchObject({
        authority: IntentItemAuthority.candidate,
        version: successor.version,
      });
      expect(await transitionsOf(successor.id)).toHaveLength(0);
      expect(await transitionsOf(predecessor.id)).toHaveLength(1);
      expect(
        await prisma.intentMutationRequest.findUnique({
          where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
        }),
      ).toBe(null);
    });
  });

  /* ---------------------------------------------------- transitions --- */

  describe('transitions read API', () => {
    it('returns one item history newest-first with full provenance, and 404s an unknown item', async () => {
      const predecessor = await acceptedItem('br-history-predecessor');
      const successor = await seedCandidate('br-history-successor', { proposedSuccessorOfId: predecessor.id });
      await review([
        {
          itemId: predecessor.id,
          expectedVersion: predecessor.version,
          action: 'supersede',
          replacementItemId: successor.id,
          replacementExpectedVersion: successor.version,
          reason: 'History fixture.',
        },
      ]);

      const response = await api().get(`${base()}/items/${predecessor.id}/transitions`).expect(200);
      expect(response.body.transitions.map((row: { to: string }) => row.to)).toEqual(['superseded', 'accepted']);
      expect(response.body.transitions[0]).toMatchObject({
        itemId: predecessor.id,
        from: 'accepted',
        to: 'superseded',
        actorId: OWNER.id,
        actorRole: 'owner',
        reason: 'History fixture.',
        authorizingSource: { kind: 'spec', ref: AUTHORIZING_SOURCE.ref, revision: AUTHORIZING_SOURCE.revision },
        workItem: WORK_ITEM,
      });
      expect(typeof response.body.transitions[0].id).toBe('string');
      expect(response.body.nextCursor).toBe(null);

      const missing = await api().get(`${base()}/items/br-no-history-here/transitions`).expect(404);
      expect(missing.body.code).toBe(IntentErrorCode.ItemNotFound);
    });

    it('pages the workspace history with a stable cursor and refuses a cursor from another list', async () => {
      const first = await api().get(`${base()}/transitions?limit=1`).expect(200);
      expect(first.body.transitions).toHaveLength(1);
      expect(first.body.nextCursor).toBeTypeOf('string');

      const second = await api().get(`${base()}/transitions?limit=1&cursor=${first.body.nextCursor}`).expect(200);
      expect(second.body.transitions[0].id).not.toBe(first.body.transitions[0].id);

      const foreign = await api()
        .get(`${base()}/items/br-history-predecessor/transitions?cursor=${first.body.nextCursor}`)
        .expect(400);
      expect(foreign.body.code).toBe(IntentErrorCode.InvalidCursor);
    });

    it('lets a read-scoped service token read the history it may not write', async () => {
      principal = { user: MEMBER, serviceToken: { permissions: [TokenPermission.IntentRead] } };
      await api().get(`${base()}/transitions`).expect(200);
    });
  });

  /* ---------------------------------------------------- idempotency --- */

  describe('idempotency', () => {
    it('replays a review batch without deciding anything twice', async () => {
      const item = await seedCandidate('br-replayed-review');
      const body = reviewBody([
        { itemId: item.id, expectedVersion: item.version, action: 'accept', reason: 'Decided once.' },
      ]);

      const first = await api().post(`${base()}/items/review`).send(body).expect(201);
      const second = await api().post(`${base()}/items/review`).send(body).expect(201);

      expect(second.body).toEqual(first.body);
      expect(await transitionsOf(item.id)).toHaveLength(1);
      expect((await itemRow(item.id)).version).toBe(item.version + 1);
    });
  });
});

const INDUCED_FAILURE = 'induced failure between the two item updates';

/**
 * A transaction client that throws on the SECOND `intentItem.updateMany` — the
 * only seam that can put a failure between a replacement pair's two writes
 * without a production-side hook for tests to pull.
 */
function failAfterFirstItemUpdate(tx: unknown): unknown {
  let updates = 0;
  return wrap(tx as Record<string, unknown>, (property, target) => {
    if (property !== 'intentItem') return undefined;
    const model = target.intentItem as Record<string, unknown>;
    return wrap(model, (modelProperty) => {
      if (modelProperty !== 'updateMany') return undefined;
      return async (args: unknown) => {
        updates += 1;
        if (updates === 2) throw new Error(INDUCED_FAILURE);
        return (model.updateMany as (input: unknown) => Promise<unknown>)(args);
      };
    });
  });
}

/** Proxy that overrides named members and passes everything else through, bound to its owner. */
function wrap(
  target: Record<string, unknown>,
  override: (property: string, owner: Record<string, unknown>) => unknown,
): unknown {
  return new Proxy(target, {
    get(owner, property) {
      if (typeof property === 'string') {
        const replacement = override(property, owner as Record<string, unknown>);
        if (replacement !== undefined) return replacement;
      }
      const value = Reflect.get(owner, property);
      return typeof value === 'function' ? value.bind(owner) : value;
    },
  });
}
