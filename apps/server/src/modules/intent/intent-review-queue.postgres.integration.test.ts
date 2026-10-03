/**
 * The review-queue read against real PostgreSQL (spec §7, issue v1.1-04).
 *
 * WHAT IT PROVES that no unit test can: the aggregate and the page agree with
 * the ROWS. The queue exists because the desktop used to learn its size by
 * paging every candidate to a client-side ceiling, so the two claims that
 * matter here are arithmetic over real rows — the summary counts exactly the
 * candidates (never an accepted, rejected, or superseded item), and one bounded
 * page plus a keyset cursor walks the same set the total names, in the queue's
 * own oldest-first order.
 *
 * The `(createdAt, id)` keyset is exercised with rows that SHARE a `createdAt`,
 * because a batch of proposals lands in one transaction and that is exactly
 * where a createdAt-only cursor drops or repeats a row.
 *
 * Only `AuthGuard` is stubbed, as in the sibling suites: `WorkspaceRoleGuard`
 * and `PermissionsGuard` are the real ones, so "a read-scoped service token may
 * see the queue, and a token without intent:read may not" is proven through the
 * production path. No graph is involved — the queue reads rows and nothing else.
 */
import 'dotenv/config';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IntentKind } from '@coredoc/core';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { IntentCursorScope, encodeIntentCursor } from './intent-cursor.js';
import { IntentReviewQueueController } from './intent-review-queue.controller.js';
import { IntentReviewQueueService } from './intent-review-queue.service.js';
import { IntentErrorCode } from './contract/index.js';

const TEST_DATABASE_URL = process.env.INTENT_REVIEW_QUEUE_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };

/** Proposal instants, oldest first. The last two SHARE one, on purpose. */
const T1 = new Date('2026-08-01T09:00:00.000Z');
const T2 = new Date('2026-08-02T09:00:00.000Z');
const T3 = new Date('2026-08-03T09:00:00.000Z');
const BATCH = new Date('2026-08-04T09:00:00.000Z');

interface Principal {
  user: { id: string; email: string };
  serviceToken?: { permissions: string[] };
}

interface QueueEntry {
  id: string;
  kind: string;
  authority: string;
  domainId: string | null;
  featureId: string | null;
  proposedSuccessorOfId: string | null;
  createdAt: string;
}

interface QueueBody {
  summary: {
    waiting: number;
    oldestWaitingAt: string | null;
    hasReplacementCandidate: boolean;
    byDomain: Array<{ domainId: string | null; waiting: number; oldestWaitingAt: string }>;
    byDomainTruncated: boolean;
  };
  total: number;
  items: QueueEntry[];
  nextCursor: string | null;
}

describe.skipIf(!TEST_DATABASE_URL)('intent review queue (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  /** A second workspace, member-visible and deliberately empty (§11 zero-not-absent). */
  let emptyWorkspaceId: string;
  let principal: Principal;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `intent-queue-${RUN}`, slug: `intent-queue-${RUN}`, intentEnabled: true },
    });
    workspaceId = workspace.id;
    const empty = await prisma.workspace.create({
      data: { name: `intent-queue-empty-${RUN}`, slug: `intent-queue-empty-${RUN}`, intentEnabled: true },
    });
    emptyWorkspaceId = empty.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: OWNER.id, email: OWNER.email, role: 'owner' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
        { workspaceId: emptyWorkspaceId, userId: OWNER.id, email: OWNER.email, role: 'owner' },
      ],
    });

    const author = { createdBy: OWNER.id, updatedBy: OWNER.id };
    await prisma.intentDomain.createMany({
      data: [
        { workspaceId, id: 'ordering', title: 'Ordering', statement: 'Baskets, checkout and refunds.', ...author },
        { workspaceId, id: 'security', title: 'Security', statement: 'Who may do what.', ...author },
      ],
    });
    await prisma.intentFeature.create({
      data: {
        workspaceId,
        id: 'checkout',
        domainId: 'ordering',
        title: 'Checkout',
        statement: 'Paying for a basket.',
        ...author,
      },
    });

    await prisma.intentItem.create({
      data: {
        workspaceId,
        id: 'cap-checkout',
        kind: IntentKind.Capability,
        domainId: 'ordering',
        featureId: 'checkout',
        title: 'Checkout',
        statement: 'A customer can pay for a basket of goods.',
        authority: 'accepted',
        createdAt: T1,
        ...author,
      },
    });
    await prisma.intentItem.createMany({
      data: [
        {
          // Product root: attached to neither a domain nor a feature.
          workspaceId,
          id: 'uc-root-waiting',
          kind: IntentKind.UseCase,
          title: 'Warehouse capacity',
          statement: 'An operator sees the warehouse stock limit for a product.',
          createdAt: T1,
          ...author,
        },
        {
          workspaceId,
          id: 'br-ordering-waiting',
          kind: IntentKind.BusinessRule,
          domainId: 'ordering',
          title: 'Refund window',
          statement: 'Refunds are accepted within thirty days of delivery.',
          createdAt: T2,
          ...author,
        },
        {
          workspaceId,
          id: 'lim-security-waiting',
          kind: IntentKind.Limitation,
          domainId: 'security',
          title: 'No SSO',
          statement: 'Single sign-on is not supported for the admin console.',
          createdAt: T3,
          ...author,
        },
        {
          workspaceId,
          id: 'br-checkout-waiting',
          kind: IntentKind.BusinessRule,
          domainId: 'ordering',
          featureId: 'checkout',
          title: 'Basket cap',
          statement: 'A basket holds at most fifty lines.',
          createdAt: BATCH,
          ...author,
        },
        {
          workspaceId,
          id: 'br-rejected-idea',
          kind: IntentKind.BusinessRule,
          domainId: 'ordering',
          title: 'Unlimited refunds',
          statement: 'Refunds would be accepted forever.',
          authority: 'rejected',
          createdAt: T1,
          ...author,
        },
      ],
    });
    // The replacement candidate lands LAST: its predecessor must exist first.
    // It shares `BATCH` with `br-checkout-waiting`, which is what makes the
    // cursor's id tiebreak load-bearing.
    await prisma.intentItem.create({
      data: {
        workspaceId,
        id: 'cap-checkout-v2',
        kind: IntentKind.Capability,
        domainId: 'ordering',
        featureId: 'checkout',
        title: 'Checkout, revised',
        statement: 'A customer can pay for a basket of goods with a saved card.',
        proposedSuccessorOfId: 'cap-checkout',
        createdAt: BATCH,
        ...author,
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentReviewQueueController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        IntentReviewQueueService,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const httpRequest = context.switchToHttp().getRequest();
          httpRequest.user = principal.user;
          if (principal.serviceToken) {
            httpRequest.serviceTokenWorkspaceId = httpRequest.params?.workspaceId ?? workspaceId;
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
      await prisma.intentItem.updateMany({ where: { workspaceId }, data: { proposedSuccessorOfId: null } });
      await prisma.intentItem.deleteMany({ where: { workspaceId } });
      await prisma.intentFeature.deleteMany({ where: { workspaceId } });
      await prisma.intentDomain.deleteMany({ where: { workspaceId } });
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    if (emptyWorkspaceId) {
      await prisma.workspace.delete({ where: { id: emptyWorkspaceId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(() => {
    principal = { user: OWNER };
  });

  function url(id = workspaceId) {
    return `/api/v1/workspaces/${id}/intent/review-queue`;
  }

  async function read(query: Record<string, unknown> = {}, id = workspaceId): Promise<QueueBody> {
    const response = await request(app.getHttpServer()).get(url(id)).query(query).expect(200);
    return response.body as QueueBody;
  }

  const idsOf = (body: QueueBody) => body.items.map((item) => item.id);

  /* ------------------------------------------------------------ summary --- */

  describe('summary', () => {
    it('counts every waiting candidate and nothing else', async () => {
      const body = await read();
      expect(body.summary.waiting).toBe(5);
      expect(body.summary.oldestWaitingAt).toBe(T1.toISOString());
      expect(body.summary.byDomainTruncated).toBe(false);
    });

    it('breaks the queue down by domain, widest bucket first, with the product root as null', async () => {
      const body = await read();
      expect(body.summary.byDomain).toEqual([
        { domainId: 'ordering', waiting: 3, oldestWaitingAt: T2.toISOString() },
        { domainId: null, waiting: 1, oldestWaitingAt: T1.toISOString() },
        { domainId: 'security', waiting: 1, oldestWaitingAt: T3.toISOString() },
      ]);
    });

    it('counts waiting candidates per tree node, summing to the domain breakdown', async () => {
      const { nodes } = (
        await request(app.getHttpServer())
          .get(`${url(workspaceId)}/nodes`)
          .expect(200)
      ).body as { nodes: { domainId: string | null; featureId: string | null; waiting: number }[] };
      expect(nodes.find((node) => node.featureId === 'checkout')).toMatchObject({ domainId: 'ordering' });
      const body = await read();
      for (const bucket of body.summary.byDomain) {
        const summed = nodes
          .filter((node) => node.domainId === bucket.domainId)
          .reduce((total, node) => total + node.waiting, 0);
        expect(summed).toBe(bucket.waiting);
      }
    });

    it('reports that a replacement is waiting, which is the decision a reviewer cannot defer blind', async () => {
      const body = await read();
      expect(body.summary.hasReplacementCandidate).toBe(true);
    });

    it('describes the WHOLE workspace even when the page is filtered', async () => {
      const body = await read({ domainId: 'security' });
      expect(body.total).toBe(1);
      expect(body.summary.waiting).toBe(5);
    });

    it('answers a workspace with no intent at all with zeros, never with an absent field', async () => {
      const body = await read({}, emptyWorkspaceId);
      expect(body.summary).toEqual({
        waiting: 0,
        oldestWaitingAt: null,
        hasReplacementCandidate: false,
        byDomain: [],
        byDomainTruncated: false,
      });
      expect(body.total).toBe(0);
      expect(body.items).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });
  });

  /* --------------------------------------------------------------- page --- */

  describe('page', () => {
    it('returns candidates only, oldest first', async () => {
      const body = await read({ limit: '10' });
      expect(idsOf(body)).toEqual([
        'uc-root-waiting',
        'br-ordering-waiting',
        'lim-security-waiting',
        'br-checkout-waiting',
        'cap-checkout-v2',
      ]);
      expect(body.items.every((item) => item.authority === 'candidate')).toBe(true);
      expect(body.total).toBe(5);
      expect(body.nextCursor).toBeNull();
    });

    it('walks the whole queue through its cursor, including two candidates proposed at one instant', async () => {
      const walked: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const body: QueueBody = await read({ limit: '2', ...(cursor ? { cursor } : {}) });
        walked.push(...idsOf(body));
        cursor = body.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(6);
      } while (cursor);

      expect(walked).toEqual([
        'uc-root-waiting',
        'br-ordering-waiting',
        'lim-security-waiting',
        'br-checkout-waiting',
        'cap-checkout-v2',
      ]);
      expect(new Set(walked).size).toBe(walked.length);
    });

    it('refuses a cursor issued for a different list rather than mis-paging it', async () => {
      const foreign = encodeIntentCursor(IntentCursorScope.Items, ['br-ordering-waiting']);
      const response = await request(app.getHttpServer()).get(url()).query({ cursor: foreign }).expect(400);
      expect(response.body.code).toBe(IntentErrorCode.InvalidCursor);
    });
  });

  /* ------------------------------------------------------------ filters --- */

  describe('filters', () => {
    it('reaches feature-attached candidates through their domain', async () => {
      const body = await read({ domainId: 'ordering' });
      expect(idsOf(body)).toEqual(['br-ordering-waiting', 'br-checkout-waiting', 'cap-checkout-v2']);
      expect(body.total).toBe(3);
    });

    it('narrows to one feature', async () => {
      const body = await read({ featureId: 'checkout' });
      expect(idsOf(body)).toEqual(['br-checkout-waiting', 'cap-checkout-v2']);
      expect(body.total).toBe(2);
    });

    it('narrows by kind', async () => {
      const body = await read({ kind: IntentKind.Limitation });
      expect(idsOf(body)).toEqual(['lim-security-waiting']);
      expect(body.total).toBe(1);
    });

    it('refuses an unknown query parameter instead of silently ignoring it', async () => {
      await request(app.getHttpServer()).get(url()).query({ authority: 'accepted' }).expect(400);
    });
  });

  /* --------------------------------------------------------------- gate --- */

  describe('gate', () => {
    it('lets a read-scoped service token see the queue it may not decide on', async () => {
      principal = { user: MEMBER, serviceToken: { permissions: [TokenPermission.IntentRead] } };
      await request(app.getHttpServer()).get(url()).expect(200);
    });

    it('refuses a service token that carries no intent:read, wildcard included', async () => {
      principal = { user: OWNER, serviceToken: { permissions: ['*'] } };
      await request(app.getHttpServer()).get(url()).expect(403);
    });

    it('refuses a user who is not a member of the workspace', async () => {
      principal = { user: { id: `${RUN}-stranger`, email: 'stranger@example.com' } };
      await request(app.getHttpServer()).get(url()).expect(403);
    });
  });

  /* -------------------------------------------------------------- hints --- */

  describe('authoring hints (intent-dimensions-inheritance BR-3, BR-5)', () => {
    let hintsWorkspace: string;

    beforeAll(async () => {
      const workspace = await prisma.workspace.create({
        data: { name: `intent-queue-hints-${RUN}`, slug: `intent-queue-hints-${RUN}`, intentEnabled: true },
      });
      hintsWorkspace = workspace.id;
      await prisma.workspaceMember.create({
        data: { workspaceId: hintsWorkspace, userId: OWNER.id, email: OWNER.email, role: 'owner' },
      });
      const author = { createdBy: OWNER.id, updatedBy: OWNER.id };
      await prisma.intentDimension.create({
        data: {
          workspaceId: hintsWorkspace,
          id: 'country',
          title: 'Country',
          values: [
            { id: 'br', title: 'Brazil', aliases: ['Brazilian'] },
            { id: 'ua', title: 'Ukraine' },
          ],
          ...author,
        },
      });
      await prisma.intentDomain.create({
        data: { workspaceId: hintsWorkspace, id: 'payroll', title: 'Payroll', statement: '', ...author },
      });
      await prisma.intentFeature.create({
        data: {
          workspaceId: hintsWorkspace,
          id: 'br-payroll',
          domainId: 'payroll',
          title: 'Brazil payroll',
          statement: '',
          appliesWhen: [{ dimension: 'country', in: ['br'] }],
          ...author,
        },
      });
      const candidate = (id: string, createdAt: Date, extra: Record<string, unknown> = {}) => ({
        workspaceId: hintsWorkspace,
        id,
        kind: IntentKind.BusinessRule,
        title: `Rule ${id}`,
        statement: 'Brazilian companies get overtime at 50%.',
        createdAt,
        ...author,
        ...extra,
      });
      await prisma.intentItem.createMany({
        data: [
          candidate('br-unplaced', T1),
          candidate('br-in-feature', T2, { domainId: 'payroll', featureId: 'br-payroll' }),
        ],
      });
    });

    afterAll(async () => {
      if (!hintsWorkspace) return;
      await prisma.intentItem.deleteMany({ where: { workspaceId: hintsWorkspace } });
      await prisma.intentFeature.deleteMany({ where: { workspaceId: hintsWorkspace } });
      await prisma.intentDomain.deleteMany({ where: { workspaceId: hintsWorkspace } });
      await prisma.intentDimension.deleteMany({ where: { workspaceId: hintsWorkspace } });
      await prisma.workspace.delete({ where: { id: hintsWorkspace } }).catch(() => undefined);
    });

    it('computes hints per candidate at read time, and omits the key where there are none', async () => {
      const body = (await read({}, hintsWorkspace)) as QueueBody & {
        items: Array<QueueEntry & { hints?: unknown }>;
      };
      const byId = new Map(body.items.map((item) => [item.id, item]));
      expect(byId.get('br-unplaced')?.hints).toEqual([
        { kind: 'missing-condition', dimension: 'country', value: 'br', matched: 'Brazilian' },
      ]);
      // The feature's `country in [br]` constrains the dimension, so the same text raises nothing.
      expect(byId.get('br-in-feature')).not.toHaveProperty('hints');
    });
  });
});
