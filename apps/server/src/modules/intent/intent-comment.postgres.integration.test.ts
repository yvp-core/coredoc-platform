import '../../config/load-env.js';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { IntentCommentController } from './intent-comment.controller.js';
import { IntentCommentService } from './intent-comment.service.js';
import { IntentItemService } from './intent-item.service.js';
import { IntentReadService } from './intent-read.service.js';
import { IntentTreeService } from './intent-tree.service.js';
import { IntentController } from './intent.controller.js';

/** Only `AuthGuard` is stubbed; the role, permission and user-session guards are real. */
const TEST_DATABASE_URL = process.env.INTENT_COMMENT_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };

interface Principal {
  user: { id: string; email: string };
  serviceToken?: { permissions: string[] };
}

let keySeed = 0;
const nextKey = () => `comment-${RUN}-${++keySeed}`;

describe.skipIf(!TEST_DATABASE_URL)('intent comments (PostgreSQL integration)', () => {
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
      data: { name: `intent-comment-${RUN}`, slug: `intent-comment-${RUN}`, intentEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: OWNER.id, email: OWNER.email, role: 'owner' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    const audit = { createdBy: OWNER.id, updatedBy: OWNER.id };
    await prisma.intentDomain.create({
      data: { workspaceId, id: 'billing', title: 'Billing', statement: '', ...audit },
    });
    await prisma.intentFeature.createMany({
      data: [
        { workspaceId, id: 'refunds', domainId: 'billing', title: 'Refunds', statement: '', ...audit },
        { workspaceId, id: 'invoices', domainId: 'billing', title: 'Invoices', statement: '', ...audit },
      ],
    });
    await prisma.intentItem.create({
      data: {
        workspaceId,
        id: 'br-refund-window',
        domainId: 'billing',
        featureId: 'refunds',
        kind: 'business_rule',
        title: 'Refund window',
        statement: 'Refunds are accepted within 30 days.',
        ...audit,
      },
    });
    await prisma.intentItem.create({
      data: {
        workspaceId,
        id: 'br-refund-method',
        domainId: 'billing',
        featureId: 'refunds',
        kind: 'business_rule',
        title: 'Refund method',
        statement: 'Refunds go back to the original payment method.',
        authority: 'accepted',
        ...audit,
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentCommentController, IntentController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        IntentCommentService,
        IntentItemService,
        IntentReadService,
        IntentTreeService,
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
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    if (workspaceId) {
      await prisma.intentComment.deleteMany({ where: { workspaceId } });
      await prisma.intentItem.deleteMany({ where: { workspaceId } });
      await prisma.intentFeature.deleteMany({ where: { workspaceId } });
      await prisma.intentDomain.deleteMany({ where: { workspaceId } });
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
    principal = { user: MEMBER };
  });

  const base = () => `/api/v1/workspaces/${workspaceId}/intent/comments`;
  const api = () => request(app.getHttpServer());
  const comment = (body: Record<string, unknown>) =>
    api()
      .post(base())
      .send({ idempotencyKey: nextKey(), ...body });
  const setStatus = (id: string, status: string) =>
    api().post(`${base()}/${id}/status`).send({ idempotencyKey: nextKey(), id, status });

  it('threads a feature discussion: the root is open, replies carry no status and come back under it', async () => {
    const root = await comment({ target: { kind: 'feature', id: 'refunds' }, body: 'Should partial refunds count?' });
    expect(root.status).toBe(201);
    expect(root.body.comment).toMatchObject({
      target: { kind: 'feature', id: 'refunds' },
      parentId: null,
      status: 'open',
      createdBy: MEMBER.id,
    });

    principal = { user: OWNER };
    const reply = await comment({ parentId: root.body.comment.id, body: 'Yes, pro rata.' });
    expect(reply.status).toBe(201);
    expect(reply.body.comment).toMatchObject({
      target: { kind: 'feature', id: 'refunds' },
      parentId: root.body.comment.id,
      status: null,
      createdBy: OWNER.id,
    });

    const list = await api().get(base()).query({ featureId: 'refunds' });
    expect(list.status).toBe(200);
    expect(list.body.threads).toHaveLength(1);
    expect(list.body.threads[0].id).toBe(root.body.comment.id);
    expect(list.body.threads[0].replies.map((entry: { body: string }) => entry.body)).toEqual(['Yes, pro rata.']);
    // The item under the feature has its own, separate discussion.
    const itemList = await api().get(base()).query({ itemId: 'br-refund-window' });
    expect(itemList.body.threads).toEqual([]);
  });

  it('resolves and reopens a thread, and filters threads by status', async () => {
    const root = await comment({ target: { kind: 'item', id: 'br-refund-window' }, body: 'Is 30 days calendar days?' });
    const id = root.body.comment.id as string;

    const resolved = await setStatus(id, 'resolved');
    expect(resolved.status).toBe(201);
    expect(resolved.body.comment).toMatchObject({ status: 'resolved', resolvedBy: MEMBER.id });
    expect(resolved.body.comment.resolvedAt).toEqual(expect.any(String));

    const open = await api().get(base()).query({ itemId: 'br-refund-window', status: 'open' });
    expect(open.body.threads).toEqual([]);
    const done = await api().get(base()).query({ itemId: 'br-refund-window', status: 'resolved' });
    expect(done.body.threads.map((thread: { id: string }) => thread.id)).toEqual([id]);

    const reopened = await setStatus(id, 'open');
    expect(reopened.body.comment).toMatchObject({ status: 'open', resolvedBy: null, resolvedAt: null });

    const audits = await prisma.intentAuditEvent.findMany({
      where: { workspaceId, entityKind: 'comment', entityId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((row) => row.operation)).toEqual(['create', 'update', 'update']);
  });

  it('keeps threads one level deep and the status on the root', async () => {
    const root = await comment({ target: { kind: 'feature', id: 'invoices' }, body: 'Numbering per country?' });
    const reply = await comment({ parentId: root.body.comment.id, body: 'Per legal entity.' });

    const nested = await comment({ parentId: reply.body.comment.id, body: 'Agreed.' });
    expect(nested.status).toBe(400);
    expect(nested.body.code).toBe('comment_reply_to_reply');

    const replyStatus = await setStatus(reply.body.comment.id, 'resolved');
    expect(replyStatus.status).toBe(400);
    expect(replyStatus.body.code).toBe('comment_status_on_reply');
  });

  it('refuses a missing target, an ambiguous request and a service token', async () => {
    const missing = await comment({ target: { kind: 'item', id: 'no-such-item' }, body: 'Hello?' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('item_not_found');

    const both = await comment({
      target: { kind: 'feature', id: 'refunds' },
      parentId: '11111111-1111-4111-8111-111111111111',
      body: 'Both?',
    });
    expect(both.status).toBe(400);

    principal = { user: OWNER, serviceToken: { permissions: [TokenPermission.IntentRead] } };
    const byToken = await comment({ target: { kind: 'feature', id: 'refunds' }, body: 'From CI' });
    expect(byToken.status).toBe(403);
    const read = await api().get(base()).query({ featureId: 'refunds' });
    expect(read.status).toBe(200);
  });

  it('pages threads oldest first', async () => {
    const created: string[] = [];
    for (const body of ['first', 'second', 'third']) {
      const response = await comment({ target: { kind: 'feature', id: 'invoices' }, body });
      created.push(response.body.comment.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await api()
        .get(base())
        .query({ featureId: 'invoices', limit: '2', ...(cursor ? { cursor } : {}) });
      expect(page.status).toBe(200);
      seen.push(...page.body.threads.map((thread: { id: string }) => thread.id));
      cursor = page.body.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.slice(-3)).toEqual(created);
  });

  it('counts open threads per item and filters the item index to items with open threads', async () => {
    const intent = `/api/v1/workspaces/${workspaceId}/intent`;
    await prisma.intentComment.deleteMany({ where: { workspaceId, itemId: { not: null } } });
    const first = await comment({
      target: { kind: 'item', id: 'br-refund-window' },
      body: 'Calendar or business days?',
    });
    await comment({ parentId: first.body.comment.id, body: 'Calendar.' });
    const second = await comment({ target: { kind: 'item', id: 'br-refund-window' }, body: 'Does it apply to sales?' });
    const settled = await comment({ target: { kind: 'item', id: 'br-refund-method' }, body: 'And gift cards?' });
    await setStatus(settled.body.comment.id, 'resolved');

    const all = await api().get(`${intent}/items`).query({ featureId: 'refunds' });
    expect(all.status).toBe(200);
    const counts = Object.fromEntries(
      all.body.items.map((item: { id: string; openCommentCount: number }) => [item.id, item.openCommentCount]),
    );
    // Two open threads; the reply is not a thread and the resolved thread is not open.
    expect(counts).toEqual({ 'br-refund-method': 0, 'br-refund-window': 2 });

    const open = await api().get(`${intent}/items`).query({ featureId: 'refunds', openComments: 'true' });
    expect(open.body.items.map((item: { id: string }) => item.id)).toEqual(['br-refund-window']);

    await setStatus(second.body.comment.id, 'resolved');
    await setStatus(first.body.comment.id, 'resolved');
    const none = await api().get(`${intent}/items`).query({ featureId: 'refunds', openComments: 'true' });
    expect(none.body.items).toEqual([]);

    await setStatus(first.body.comment.id, 'open');
    const document = await api().get(`${intent}/document`).query({ featureId: 'refunds', includeCandidates: 'true' });
    expect(document.status).toBe(200);
    const items = document.body.sections.flatMap((section: { blocks: { type: string; item?: unknown }[] }) =>
      section.blocks.flatMap((block) => (block.type === 'item' ? [block.item] : [])),
    );
    expect(
      Object.fromEntries(
        items.map((item: { id: string; openCommentCount: number }) => [item.id, item.openCommentCount]),
      ),
    ).toEqual({ 'br-refund-method': 0, 'br-refund-window': 1 });
  });

  it('counts open threads on tree nodes: a feature’s own and its items’, summed into the domain', async () => {
    const tree = async () => {
      const response = await api().get(`/api/v1/workspaces/${workspaceId}/intent/tree`);
      expect(response.status).toBe(200);
      const domain = response.body.domains.find((entry: { id: string }) => entry.id === 'billing');
      const refunds = domain.features.find((entry: { id: string }) => entry.id === 'refunds');
      return { feature: refunds.openCommentCount as number, domain: domain.subtreeOpenCommentCount as number };
    };
    const before = await tree();

    await comment({ target: { kind: 'feature', id: 'refunds' }, body: 'Who owns refunds?' });
    const onItem = await comment({ target: { kind: 'item', id: 'br-refund-method' }, body: 'Cash refunds?' });
    await comment({ parentId: onItem.body.comment.id, body: 'No.' });
    expect(await tree()).toEqual({ feature: before.feature + 2, domain: before.domain + 2 });

    await setStatus(onItem.body.comment.id, 'resolved');
    expect(await tree()).toEqual({ feature: before.feature + 1, domain: before.domain + 1 });
  });

  it('accepts a long multi-paragraph comment and still refuses an email address', async () => {
    const paragraph = 'Partial refunds should count toward the window, but only for the refunded lines.';
    const long = await comment({
      target: { kind: 'feature', id: 'refunds' },
      body: Array.from({ length: 12 }, () => paragraph).join('\n\n'),
    });
    expect(long.status).toBe(201);

    const email = await comment({ target: { kind: 'feature', id: 'refunds' }, body: 'Ask ana@example.com' });
    expect(email.status).toBe(400);
    expect(email.body.code).toBe('content_email_shaped');
  });

  it('counts an open thread on a rejected item in the tree', async () => {
    await prisma.intentItem.create({
      data: {
        workspaceId,
        id: 'br-refund-cash',
        domainId: 'billing',
        featureId: 'refunds',
        kind: 'business_rule',
        title: 'Cash refunds',
        statement: 'Refunds may be paid in cash.',
        authority: 'rejected',
        createdBy: OWNER.id,
        updatedBy: OWNER.id,
      },
    });
    const featureCount = async () => {
      const response = await api().get(`/api/v1/workspaces/${workspaceId}/intent/tree`);
      const domain = response.body.domains.find((entry: { id: string }) => entry.id === 'billing');
      return domain.features.find((entry: { id: string }) => entry.id === 'refunds').openCommentCount as number;
    };
    const before = await featureCount();
    await comment({ target: { kind: 'item', id: 'br-refund-cash' }, body: 'Why was this rejected?' });
    expect(await featureCount()).toBe(before + 1);
  });

  it('drops a feature’s threads with the feature', async () => {
    await comment({ target: { kind: 'feature', id: 'invoices' }, body: 'Will this go?' });
    await prisma.intentFeature.delete({ where: { workspaceId_id: { workspaceId, id: 'invoices' } } });
    expect(await prisma.intentComment.count({ where: { workspaceId, featureId: 'invoices' } })).toBe(0);
  });
});
