import 'dotenv/config';
import { createHash } from 'node:crypto';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentItemAuthority, PrismaClient } from '../../generated/prisma/client.js';
import { WorkspaceGraphContextError, WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { IntentExportService } from './intent-export.service.js';
import { IntentItemService } from './intent-item.service.js';
import { updateItemWithVersion } from './intent-optimistic.js';
import { IntentAnchorTargetService } from './intent-anchor-target.js';
import { IntentProposeService } from './intent-propose.service.js';
import { IntentReadService } from './intent-read.service.js';
import { releaseContentHash } from './intent-release.service.js';
import { IntentReviewService } from './intent-review.service.js';

import { IntentTreeService } from './intent-tree.service.js';
import { IntentController } from './intent.controller.js';
import { IntentErrorCode } from './contract/index.js';
import { INTENT_LIMITS } from '@coredoc/core';
import type { Request } from 'express';
import { McpAuthKind } from '../../mcp/mcp-auth-context.js';
import { IntentTools, IntentTreeAction } from '../../mcp/tools/intent.tools.js';

/**
 * End-to-end behaviour of the intent module against real PostgreSQL: tree CRUD
 * with its audit trail, the guard gates (including the service-token refusal
 * that no role check could express), the propose matrix, idempotency replay,
 * and the optimistic-concurrency helper.
 *
 * Only `AuthGuard` is stubbed — it is the token→principal step, and there is no
 * token issuer in this process. `WorkspaceRoleGuard`, `PermissionsGuard`, and
 * `UserSessionGuard` are the REAL ones, resolving membership from real rows, so
 * "a service token is refused" (and members admitted, BR-1) are proven through the
 * same code path production uses.
 */
const TEST_DATABASE_URL = process.env.INTENT_MODULE_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const REPO_KEY = 'coredoc/intent-fixture';
const NODE_ID = 'a1b2c3d4e5f6:route:src/routes/orders.ts:GET /orders';

/** The graph repo id: first 12 hex characters of the sha256 of the durable key. */
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

describe.skipIf(!TEST_DATABASE_URL)('intent module (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let principal: Principal;
  let tools: IntentTools;
  let tree: IntentTreeService;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `intent-mod-${RUN}`, slug: `intent-mod-${RUN}`, intentEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: OWNER.id, email: OWNER.email, role: 'owner' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: graphHash(REPO_KEY),
        repoName: REPO_KEY,
        intentRepoKey: REPO_KEY,
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        IntentTreeService,
        IntentItemService,
        IntentProposeService,
        IntentReadService,
        // Propose resolves anchor suggestions server-side (issue 05). The
        // resolver is REAL — its identity gate and its degradation mapping are
        // what these tests assert; only the snapshot lease is stubbed, standing
        // in for a workspace that has published no graph.
        IntentAnchorTargetService,
        {
          provide: WorkspaceMcpContextService,
          useValue: {
            withContextByWorkspaceId() {
              throw new WorkspaceGraphContextError('ACTIVE_VERSION_MISSING', 'no active graph version');
            },
          },
        },
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

    // The MCP surface over the SAME real services, for REST/MCP refusal parity.
    tree = moduleRef.get(IntentTreeService);
    tools = new IntentTools(
      {} as never,
      moduleRef.get(IntentProposeService),
      {} as never,
      moduleRef.get(IntentTreeService),
      {} as never,
      { recordMcpQuery: async () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(async () => {
    await app?.close();
    if (workspaceId) {
      await prisma.intentAuthorityTransition.deleteMany({ where: { workspaceId } });
      await prisma.intentItemSource.deleteMany({ where: { workspaceId } });
      await prisma.intentItem.deleteMany({ where: { workspaceId } });
      await prisma.intentFeatureSeed.deleteMany({ where: { workspaceId } });
      await prisma.intentFeature.deleteMany({ where: { workspaceId } });
      await prisma.intentDomain.deleteMany({ where: { workspaceId } });
      await prisma.intentDimension.deleteMany({ where: { workspaceId } });
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

  async function createDomain(id: string) {
    return api()
      .post(`${base()}/domains`)
      .send({ idempotencyKey: nextKey('domain'), id, title: `Domain ${id}`, statement: 'What this area is.' })
      .expect(201);
  }

  async function createFeature(id: string, domainId: string) {
    return api()
      .post(`${base()}/features`)
      .send({ idempotencyKey: nextKey('feature'), id, domainId, title: `Feature ${id}`, statement: 'What it is.' })
      .expect(201);
  }

  function proposeBody(items: unknown[], key = nextKey('propose')) {
    return { idempotencyKey: key, items };
  }

  async function auditFor(entityId: string) {
    return prisma.intentAuditEvent.findMany({ where: { workspaceId, entityId }, orderBy: { createdAt: 'asc' } });
  }

  /* ------------------------------------------------------------- tree --- */

  describe('tree CRUD', () => {
    it('creates, updates, and archives a domain, writing one audit row per change', async () => {
      const created = await createDomain('ordering');
      expect(created.body.domain).toMatchObject({ id: 'ordering', title: 'Domain ordering', archived: false });

      await api()
        .patch(`${base()}/domains/ordering`)
        .send({ idempotencyKey: nextKey('domain'), id: 'ordering', title: 'Order management' })
        .expect(200);

      await api()
        .post(`${base()}/domains/ordering/archive`)
        .send({ idempotencyKey: nextKey('domain'), id: 'ordering', archived: true })
        .expect(201);

      const audits = await auditFor('ordering');
      expect(audits.map((row) => row.operation)).toEqual(['create', 'update', 'archive']);
      expect(audits.every((row) => row.actorId === OWNER.id && row.actorRole === 'owner')).toBe(true);

      // Archived nodes stay readable, and are hidden from browse defaults.
      const hidden = await api().get(`${base()}/tree`).expect(200);
      expect(hidden.body.domains.map((domain: { id: string }) => domain.id)).not.toContain('ordering');
      const shown = await api().get(`${base()}/tree?includeArchived=true`).expect(200);
      expect(shown.body.domains.map((domain: { id: string }) => domain.id)).toContain('ordering');

      await api()
        .post(`${base()}/domains/ordering/archive`)
        .send({ idempotencyKey: nextKey('domain'), id: 'ordering', archived: false })
        .expect(201);
    });

    it('refuses a create for an id that already exists — create is never an upsert', async () => {
      await createDomain('billing');
      const response = await api()
        .post(`${base()}/domains`)
        .send({ idempotencyKey: nextKey('domain'), id: 'billing', title: 'Second billing' })
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.TreeNodeExists);
    });

    it('refuses an update or archive of a domain that does not exist', async () => {
      const response = await api()
        .patch(`${base()}/domains/ghost`)
        .send({ idempotencyKey: nextKey('domain'), id: 'ghost', title: 'Ghost' })
        .expect(404);
      expect(response.body.code).toBe(IntentErrorCode.DomainNotFound);
    });

    it('refuses a body whose id disagrees with the route path', async () => {
      await createDomain('shipping');
      const response = await api()
        .patch(`${base()}/domains/shipping`)
        .send({ idempotencyKey: nextKey('domain'), id: 'billing', title: 'Wrong target' })
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.PathBodyMismatch);
      expect(response.body.path).toEqual(['id']);
    });

    it('refuses deleting a domain that still holds a feature or an item, naming the blockers', async () => {
      await createDomain('payments');
      await createFeature('payments-refunds', 'payments');

      const blocked = await api()
        .post(`${base()}/domains/payments/delete`)
        .send({ idempotencyKey: nextKey('domain'), id: 'payments' })
        .expect(400);
      expect(blocked.body.code).toBe(IntentErrorCode.TreeNodeNotEmpty);
      expect(blocked.body.message).toContain('feature payments-refunds');

      await api()
        .post(`${base()}/features/payments-refunds/delete`)
        .send({ idempotencyKey: nextKey('feature'), id: 'payments-refunds' })
        .expect(201);
      await api()
        .post(`${base()}/domains/payments/delete`)
        .send({ idempotencyKey: nextKey('domain'), id: 'payments' })
        .expect(201);

      expect(await prisma.intentDomain.findUnique({ where: { workspaceId_id: { workspaceId, id: 'payments' } } })).toBe(
        null,
      );
      expect((await auditFor('payments')).map((row) => row.operation)).toContain('delete');
    });

    it('refuses deleting a feature that still holds an item', async () => {
      await createDomain('inventory');
      await createFeature('inventory-stock', 'inventory');
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'business_rule',
              title: 'Stock never goes negative',
              statement: 'A warehouse stock level is never negative.',
              featureId: 'inventory-stock',
              sources: [{ kind: 'spec', ref: 'spec/inventory', localId: 'BR-1' }],
            },
          ]),
        )
        .expect(201);

      const blocked = await api()
        .post(`${base()}/features/inventory-stock/delete`)
        .send({ idempotencyKey: nextKey('feature'), id: 'inventory-stock' })
        .expect(400);
      expect(blocked.body.code).toBe(IntentErrorCode.TreeNodeNotEmpty);
      expect(blocked.body.message).toContain('item br-stock-never-goes-negative');
    });
  });

  /* ------------------------------------------------------------ seeds --- */

  describe('feature seeds', () => {
    it('declares a seed, re-notes it, lists it, and deletes it', async () => {
      await createDomain('catalog');
      await createFeature('catalog-browse', 'catalog');

      const put = await api()
        .post(`${base()}/features/catalog-browse/seeds`)
        .send({ idempotencyKey: nextKey('seed'), featureId: 'catalog-browse', repoKey: REPO_KEY, nodeId: NODE_ID })
        .expect(201);
      expect(put.body).toMatchObject({ created: true, seed: { repoKey: REPO_KEY, nodeId: NODE_ID } });

      const renote = await api()
        .post(`${base()}/features/catalog-browse/seeds`)
        .send({
          idempotencyKey: nextKey('seed'),
          featureId: 'catalog-browse',
          repoKey: REPO_KEY,
          nodeId: NODE_ID,
          note: 'The browse entry point.',
        })
        .expect(201);
      expect(renote.body.created).toBe(false);
      expect(renote.body.seed.note).toBe('The browse entry point.');

      const listed = await api().get(`${base()}/features/catalog-browse/seeds`).expect(200);
      expect(listed.body.seeds).toHaveLength(1);

      await api()
        .post(`${base()}/features/catalog-browse/seeds/delete`)
        .send({ idempotencyKey: nextKey('seed'), featureId: 'catalog-browse', repoKey: REPO_KEY, nodeId: NODE_ID })
        .expect(201);
      expect(await prisma.intentFeatureSeed.count({ where: { workspaceId, featureId: 'catalog-browse' } })).toBe(0);
    });

    it('refuses a seed naming a repo key this workspace does not carry, enumerating the registered ones', async () => {
      await createDomain('search');
      await createFeature('search-index', 'search');
      const response = await api()
        .post(`${base()}/features/search-index/seeds`)
        .send({ idempotencyKey: nextKey('seed'), featureId: 'search-index', repoKey: 'someone/else', nodeId: NODE_ID })
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.UnknownRepoKey);
      expect(response.body.message).toContain(REPO_KEY);
    });

    it('refuses a seed whose node id is of an unseedable kind', async () => {
      const response = await api()
        .post(`${base()}/features/search-index/seeds`)
        .send({
          idempotencyKey: nextKey('seed'),
          featureId: 'search-index',
          repoKey: REPO_KEY,
          nodeId: 'a1b2c3d4e5f6:repository:.:coredoc',
        })
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.UnsupportedSeedNodeType);
    });
  });

  /* ------------------------------------------------------------ gates --- */

  describe('permission gates', () => {
    it('lets a plain member write the tree (BR-1)', async () => {
      principal = { user: MEMBER };
      await api()
        .post(`${base()}/domains`)
        .send({ idempotencyKey: nextKey('domain'), id: 'member-attempt', title: 'Member attempt' })
        .expect(201);
      expect(
        await prisma.intentDomain.findUnique({ where: { workspaceId_id: { workspaceId, id: 'member-attempt' } } }),
      ).not.toBe(null);
    });

    it('refuses a tree write by ANY service token, whatever its permissions or its creator role', async () => {
      principal = {
        user: OWNER,
        serviceToken: { permissions: [TokenPermission.IntentRead, TokenPermission.IntentPropose, '*'] },
      };
      await api()
        .post(`${base()}/domains`)
        .send({ idempotencyKey: nextKey('domain'), id: 'token-attempt', title: 'Token attempt' })
        .expect(403);
      expect(
        await prisma.intentDomain.findUnique({ where: { workspaceId_id: { workspaceId, id: 'token-attempt' } } }),
      ).toBe(null);
    });

    it('lets a service token read and propose only with the matching permission', async () => {
      principal = { user: OWNER, serviceToken: { permissions: [TokenPermission.IntentRead] } };
      await api().get(`${base()}/tree`).expect(200);
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'limitation',
              title: 'Token propose without permission',
              statement: 'This request must never reach the service.',
              sources: [{ kind: 'spec', ref: 'spec/tokens', localId: 'LIM-1' }],
            },
          ]),
        )
        .expect(403);

      principal = { user: OWNER, serviceToken: { permissions: [TokenPermission.IntentPropose] } };
      await api().get(`${base()}/tree`).expect(403);
    });

    it('does not let the legacy wildcard stand in for an intent permission', async () => {
      principal = { user: OWNER, serviceToken: { permissions: ['*'] } };
      await api().get(`${base()}/tree`).expect(403);
    });
  });

  /* ---------------------------------------------------------- propose --- */

  describe('propose', () => {
    const source = { kind: 'spec', ref: 'spec/refunds', localId: 'BR-1' };

    it('creates a candidate with a derived kind-prefixed slug', async () => {
      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'business_rule',
              title: 'Refund window is 30 days',
              statement: 'A refund is possible within 30 days of delivery.',
              sources: [source],
            },
          ]),
        )
        .expect(201);

      expect(response.body.items[0]).toMatchObject({
        itemId: 'br-refund-window-is-30-days',
        outcome: 'created_candidate',
        derivedId: true,
        version: 1,
      });
      const stored = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: 'br-refund-window-is-30-days' } },
      });
      expect(stored.authority).toBe(IntentItemAuthority.candidate);
      expect((await auditFor('br-refund-window-is-30-days')).map((row) => row.operation)).toEqual(['propose_create']);
    });

    it('persists a source title and url, which the contract accepts and the write used to drop', async () => {
      const titled = { kind: 'spec', ref: 'spec/provenance', localId: 'BR-9' };
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'business_rule',
              title: 'Sources keep their link',
              statement: 'A cited source keeps the label and link the capture read it under.',
              sources: [{ ...titled, title: 'Provenance spec, §4', url: 'https://specs.example.com/provenance#4' }],
            },
          ]),
        )
        .expect(201);

      const stored = await prisma.intentItemSource.findFirstOrThrow({
        where: { workspaceId, ref: titled.ref, localId: titled.localId },
      });
      expect(stored).toMatchObject({
        title: 'Provenance spec, §4',
        url: 'https://specs.example.com/provenance#4',
      });

      // Round trip: the export projection carries them back out.
      const exported = await new IntentExportService(prisma as unknown as PrismaService).export(workspaceId);
      expect(exported.content.sources).toContainEqual(
        expect.objectContaining({
          ref: titled.ref,
          localId: titled.localId,
          title: 'Provenance spec, §4',
          url: 'https://specs.example.com/provenance#4',
        }),
      );
    });

    it('re-describes a source on an accepted item without touching the rule', async () => {
      const cited = { kind: 'spec', ref: 'confluence:1234567890', localId: 'BR-1' };
      const proposed = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'business_rule',
              title: 'Overtime is paid weekly',
              statement: 'International overtime is paid in the weekly payroll run.',
              sources: [cited],
            },
          ]),
        )
        .expect(201);
      const itemId = proposed.body.items[0].itemId as string;
      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId, id: itemId } },
        data: { authority: IntentItemAuthority.accepted },
      });
      const before = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: itemId } },
      });

      const items = new IntentItemService(prisma as unknown as PrismaService);
      const actor = { id: OWNER.id, role: 'owner' };
      const input = {
        idempotencyKey: nextKey('source'),
        ref: cited.ref,
        title: 'Overtime – International',
        url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1234567890',
      };
      await expect(items.updateSource(workspaceId, actor, input)).resolves.toMatchObject({ items: [itemId] });

      expect(
        await prisma.intentItemSource.findFirstOrThrow({ where: { workspaceId, itemId, ref: cited.ref } }),
      ).toMatchObject({ title: input.title, url: input.url });
      const after = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: itemId } },
      });
      expect(after.version).toBe(before.version);
      expect(after.authority).toBe(IntentItemAuthority.accepted);
      expect((await auditFor(itemId)).at(-1)).toMatchObject({ entityKind: 'item_source', operation: 'update' });
      expect((await items.listSources(workspaceId, 'Overtime')).sources).toContainEqual({
        kind: 'spec',
        ref: cited.ref,
        title: input.title,
        url: input.url,
      });

      await expect(
        items.updateSource(workspaceId, actor, { ...input, idempotencyKey: nextKey('source'), ref: 'confluence:0' }),
      ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.SourceNotFound } });
    });

    it('updates the matching candidate for the same source identity instead of duplicating it', async () => {
      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'business_rule',
              title: 'Refund window is 30 days',
              statement: 'A refund is possible within 30 days of delivery, weekends included.',
              sources: [{ ...source, revision: 'rev-2' }],
            },
          ]),
        )
        .expect(201);

      expect(response.body.items[0]).toMatchObject({
        itemId: 'br-refund-window-is-30-days',
        outcome: 'updated_candidate',
        version: 2,
      });
      expect(
        await prisma.intentItemSource.count({ where: { workspaceId, itemId: 'br-refund-window-is-30-days' } }),
      ).toBe(1);
    });

    it('updates the named candidate when an explicit id is supplied', async () => {
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: 'lim-no-partial-refunds',
              kind: 'limitation',
              title: 'No partial refunds',
              statement: 'A refund is always for the full order value.',
              sources: [{ kind: 'spec', ref: 'spec/refunds', localId: 'LIM-1' }],
            },
          ]),
        )
        .expect(201);

      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: 'lim-no-partial-refunds',
              kind: 'limitation',
              title: 'No partial refunds',
              statement: 'A refund is always for the full order value, shipping included.',
              sources: [{ kind: 'spec', ref: 'spec/refunds', localId: 'LIM-1' }],
            },
          ]),
        )
        .expect(201);
      expect(response.body.items[0]).toMatchObject({ itemId: 'lim-no-partial-refunds', outcome: 'updated_candidate' });
    });

    it('keeps source identities the proposal did not repeat, and reports how many', async () => {
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: 'dec-single-currency',
              kind: 'decision',
              title: 'Single currency',
              statement: 'Orders are priced in one currency per workspace.',
              sources: [
                { kind: 'adr', ref: 'adr/currency', localId: 'D-1' },
                { kind: 'spec', ref: 'spec/pricing', localId: 'D-1' },
              ],
            },
          ]),
        )
        .expect(201);

      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: 'dec-single-currency',
              kind: 'decision',
              title: 'Single currency',
              statement: 'Orders are priced in one currency per workspace, chosen at creation.',
              sources: [{ kind: 'adr', ref: 'adr/currency', localId: 'D-1' }],
            },
          ]),
        )
        .expect(201);
      expect(response.body.items[0].retainedSourceCount).toBe(1);
      expect(await prisma.intentItemSource.count({ where: { workspaceId, itemId: 'dec-single-currency' } })).toBe(2);
    });

    it('never mutates an accepted item: the proposal becomes a separate candidate', async () => {
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: 'uc-place-an-order',
              kind: 'use_case',
              title: 'Place an order',
              statement: 'A customer places an order for available stock.',
              sources: [{ kind: 'spec', ref: 'spec/ordering', localId: 'UC-1' }],
            },
          ]),
        )
        .expect(201);
      // Only review may set this authority; the test writes it directly because
      // the review operation lands in issue 04.
      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId, id: 'uc-place-an-order' } },
        data: { authority: IntentItemAuthority.accepted },
      });
      const before = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: 'uc-place-an-order' } },
      });

      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'use_case',
              title: 'Place an order with a coupon',
              statement: 'A customer places an order and applies one coupon.',
              sources: [{ kind: 'spec', ref: 'spec/ordering', localId: 'UC-1' }],
            },
          ]),
        )
        .expect(201);

      expect(response.body.items[0]).toMatchObject({
        outcome: 'created_candidate',
        preservedAcceptedItemIds: ['uc-place-an-order'],
      });
      const after = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: 'uc-place-an-order' } },
      });
      expect(after).toEqual(before);
    });

    it('refuses an explicit id that names an accepted item', async () => {
      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: 'uc-place-an-order',
              kind: 'use_case',
              title: 'Place an order',
              statement: 'A rewritten statement that must never be applied.',
              sources: [{ kind: 'spec', ref: 'spec/ordering', localId: 'UC-9' }],
            },
          ]),
        )
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.ItemNotCandidate);
    });

    it("attaches to a feature and carries the feature's own domain", async () => {
      await createDomain('accounts');
      await createFeature('accounts-login', 'accounts');
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: 'br-login-throttle',
              kind: 'business_rule',
              title: 'Login throttle',
              statement: 'Five failed logins in a minute lock the account for ten minutes.',
              featureId: 'accounts-login',
              sources: [{ kind: 'spec', ref: 'spec/accounts', localId: 'BR-7' }],
            },
          ]),
        )
        .expect(201);

      const stored = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: 'br-login-throttle' } },
      });
      expect(stored).toMatchObject({ featureId: 'accounts-login', domainId: 'accounts' });
    });

    it('refuses a proposal attached to a feature that does not exist', async () => {
      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'flow',
              title: 'Ghost flow',
              statement: 'A flow attached to a feature nobody created.',
              featureId: 'no-such-feature',
              sources: [{ kind: 'spec', ref: 'spec/ghost', localId: 'F-1' }],
            },
          ]),
        )
        .expect(404);
      expect(response.body.code).toBe(IntentErrorCode.FeatureNotFound);
    });

    it('refuses anchor suggestions when no graph snapshot can be read — a write never degrades', async () => {
      // This workspace has no published graph, and an anchor carries a drift
      // baseline that only the graph can supply. The refusal is the point: a
      // fabricated baseline would make a later `matched` anchorStatus meaningless.
      // The resolvable path is exercised in `intent-anchor.postgres.integration.test.ts`.
      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'capability',
              title: 'Anchored capability',
              statement: 'A capability proposed with an anchor suggestion.',
              sources: [{ kind: 'spec', ref: 'spec/anchors', localId: 'CAP-1' }],
              anchorSuggestions: [{ repoKey: REPO_KEY, nodeId: NODE_ID }],
            },
          ]),
        )
        .expect(503);
      expect(response.body.code).toBe(IntentErrorCode.AnchorGraphUnavailable);
      expect(response.body.path).toEqual(['items', '0', 'anchorSuggestions', '0']);
      expect(await prisma.intentItem.count({ where: { workspaceId, id: 'cap-anchored-capability' } })).toBe(0);
    });

    it('refuses an anchor suggestion naming an unregistered repo, before touching the graph', async () => {
      const response = await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'capability',
              title: 'Suggestion on a ghost repo',
              statement: 'A capability whose anchor names a repo this workspace does not carry.',
              sources: [{ kind: 'spec', ref: 'spec/anchors', localId: 'CAP-2' }],
              anchorSuggestions: [{ repoKey: 'someone/else', nodeId: NODE_ID }],
            },
          ]),
        )
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.UnknownRepoKey);
      expect(response.body.path).toEqual(['items', '0', 'anchorSuggestions', '0', 'repoKey']);
    });

    it('rejects the whole batch, writing nothing, when one proposal is refused', async () => {
      const before = await prisma.intentItem.count({ where: { workspaceId } });
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              kind: 'business_rule',
              title: 'A rule that would be created',
              statement: 'This one is fine on its own.',
              sources: [{ kind: 'spec', ref: 'spec/batch', localId: 'BR-1' }],
            },
            {
              id: 'uc-wrong-prefix-for-kind',
              kind: 'business_rule',
              title: 'A rule with a use-case id',
              statement: 'This one is refused, and takes the batch with it.',
              sources: [{ kind: 'spec', ref: 'spec/batch', localId: 'BR-2' }],
            },
          ]),
        )
        .expect(400);
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(before);
    });
  });

  /* ------------------------------------------------------ idempotency --- */

  /* ----------------------------------------------------- context conditions --- */

  describe('context dimensions and conditions', () => {
    const source = { kind: 'spec', ref: 'spec/dimensions', localId: 'CTX' };
    let seq = 0;

    function mcpRequest(): Request {
      return {
        workspaceId,
        user: { id: OWNER.id },
        userWorkspaceRole: 'owner',
        mcpAuthKind: McpAuthKind.Jwt,
      } as unknown as Request;
    }

    function mcpError(result: unknown): { code: string; message: string; path: string[] } {
      const text = (result as { content: { text: string }[] }).content[0]?.text ?? 'null';
      return (JSON.parse(text) as { error: { code: string; message: string; path: string[] } }).error;
    }

    function rule(id: string, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
      seq += 1;
      return {
        id,
        kind: 'business_rule',
        title: `Rule ${id}`,
        statement: 'A statement that stands on its own.',
        payload: { condition: 'c', requiredOutcome: 'o', observer: 'obs', ...payload },
        sources: [{ ...source, localId: `CTX-${seq}` }],
        ...extra,
      };
    }

    /** One refusal through REST and through MCP: same code, message, and path. */
    async function refusedOnBoth(items: unknown[], status: number) {
      const rest = await api().post(`${base()}/items/propose`).send(proposeBody(items)).expect(status);
      const mcp = mcpError(await tools.intentPropose(proposeBody(items), {} as never, mcpRequest()));
      expect(mcp).toEqual({ code: rest.body.code, message: rest.body.message, path: rest.body.path });
      return rest.body as { code: string; path: string[]; details?: { message: string }[] };
    }

    beforeAll(async () => {
      principal = { user: OWNER };
      // A domain makes the workspace "configured" for the MCP calls regardless of test order.
      await createDomain('ctx-home');
      await api()
        .post(`${base()}/dimensions`)
        .send({
          idempotencyKey: nextKey('dim'),
          id: 'country',
          title: 'Country',
          values: [
            { id: 'de', title: 'Germany' },
            { id: 'pl', title: 'Poland' },
            { id: 'ua', title: 'Ukraine' },
            { id: 'fr', title: 'France' },
          ],
        })
        .expect(201);
      await api()
        .post(`${base()}/dimensions`)
        .send({
          idempotencyKey: nextKey('dim'),
          id: 'product',
          title: 'Product',
          multi: true,
          values: [
            { id: 'ta', title: 'Time & attendance' },
            { id: 'shifts', title: 'Shifts' },
          ],
        })
        .expect(201);
    });

    it('lists, updates, and archives a dimension through the tree actions, with audit rows', async () => {
      await api()
        .post(`${base()}/dimensions`)
        .send({ idempotencyKey: nextKey('dim'), id: 'plan', title: 'Plan', values: [{ id: 'pro', title: 'Pro' }] })
        .expect(201);
      const updated = await api()
        .patch(`${base()}/dimensions/plan`)
        .send({ idempotencyKey: nextKey('dim'), id: 'plan', title: 'Subscription plan', multi: false })
        .expect(200);
      expect(updated.body.dimension).toMatchObject({ id: 'plan', title: 'Subscription plan', multi: false });

      const archive = await tools.intentTree(
        {
          action: IntentTreeAction.DimensionArchive,
          request: { idempotencyKey: nextKey('dim'), id: 'plan', archived: true },
        },
        {} as never,
        mcpRequest(),
      );
      expect(JSON.parse((archive as { content: { text: string }[] }).content[0]!.text)).toMatchObject({
        dimension: { id: 'plan', archived: true },
      });

      const visible = await api().get(`${base()}/dimensions`).expect(200);
      expect(visible.body.dimensions.map((d: { id: string }) => d.id)).toEqual(['country', 'product']);
      const all = await api().get(`${base()}/dimensions?includeArchived=true`).expect(200);
      expect(all.body.dimensions.map((d: { id: string }) => d.id)).toEqual(['country', 'plan', 'product']);
      expect((await auditFor('plan')).map((row) => row.operation)).toEqual(['create', 'update', 'archive']);

      const duplicate = await api()
        .post(`${base()}/dimensions`)
        .send({ idempotencyKey: nextKey('dim'), id: 'plan', title: 'Again', values: [{ id: 'pro', title: 'Pro' }] })
        .expect(400);
      expect(duplicate.body.code).toBe(IntentErrorCode.TreeNodeExists);
    });

    it('stores appliesWhen on a proposal, and leaves the column NULL on one without it', async () => {
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            rule('br-ctx-conditioned', { appliesWhen: [{ dimension: 'product', in: ['shifts'] }] }),
            rule('br-ctx-plain'),
          ]),
        )
        .expect(201);
      const [conditioned, plain] = await Promise.all(
        ['br-ctx-conditioned', 'br-ctx-plain'].map((id) =>
          prisma.intentItem.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id } } }),
        ),
      );
      expect(conditioned!.appliesWhen).toEqual([{ dimension: 'product', in: ['shifts'] }]);
      const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
        SELECT applies_when IS NULL AS "isNull" FROM intent_items
        WHERE workspace_id = ${workspaceId}::uuid AND id = ${plain!.id}`;
      expect(row?.isNull).toBe(true);
    });

    it('refuses registry, item-reference, cycle, and variant violations identically over REST and MCP (AC-5)', async () => {
      const undeclared = await refusedOnBoth(
        [rule('br-ctx-a', { appliesWhen: [{ dimension: 'region', in: ['eu'] }] })],
        404,
      );
      expect(undeclared).toMatchObject({
        code: IntentErrorCode.DimensionNotFound,
        path: ['items', '0', 'appliesWhen', '0', 'in'],
      });

      const archived = await refusedOnBoth(
        [rule('br-ctx-a', { appliesWhen: [{ dimension: 'plan', in: ['pro'] }] })],
        404,
      );
      expect(archived.code).toBe(IntentErrorCode.DimensionNotFound);

      const value = await refusedOnBoth(
        [rule('br-ctx-a', {}, { variants: [{ when: { country: 'it' }, outcome: 'x' }] })],
        404,
      );
      expect(value).toMatchObject({
        code: IntentErrorCode.DimensionValueNotFound,
        path: ['items', '0', 'payload', 'variants', '0', 'when', 'country'],
      });

      const overlap = await refusedOnBoth(
        [
          rule(
            'br-ctx-a',
            {},
            {
              variants: [
                { when: { country: ['de', 'pl'] }, outcome: '40h' },
                { when: { country: 'pl' }, outcome: '42h' },
              ],
            },
          ),
        ],
        400,
      );
      expect(overlap).toMatchObject({
        code: IntentErrorCode.VariantOverlap,
        path: ['items', '0', 'payload', 'variants', '1'],
      });

      const secondDefault = await refusedOnBoth(
        [rule('br-ctx-a', {}, { variants: [{ outcome: 'a' }, { outcome: 'b' }] })],
        400,
      );
      expect(secondDefault.code).toBe(IntentErrorCode.VariantOverlap);

      const missing = await refusedOnBoth([rule('br-ctx-a', { appliesWhen: [{ item: 'cap-does-not-exist' }] })], 404);
      expect(missing).toMatchObject({
        code: IntentErrorCode.ConditionItemNotFound,
        path: ['items', '0', 'appliesWhen', '0', 'item'],
      });

      // A rejected or superseded target could never filter: refused, where a candidate reference is kept.
      await api()
        .post(`${base()}/items/propose`)
        .send(proposeBody([rule('br-ctx-rejected'), rule('br-ctx-superseded')]))
        .expect(201);
      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId, id: 'br-ctx-rejected' } },
        data: { authority: 'rejected' },
      });
      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId, id: 'br-ctx-superseded' } },
        data: { authority: 'superseded' },
      });
      for (const target of ['br-ctx-rejected', 'br-ctx-superseded']) {
        const inactive = await refusedOnBoth([rule('br-ctx-a', { appliesWhen: [{ item: target }] })], 400);
        expect(inactive).toMatchObject({
          code: IntentErrorCode.ConditionItemInactive,
          path: ['items', '0', 'appliesWhen', '0', 'item'],
        });
      }

      const batchCycle = await refusedOnBoth(
        [
          rule('br-ctx-x', { appliesWhen: [{ item: 'br-ctx-y' }] }),
          rule('br-ctx-y', { appliesWhen: [{ item: 'br-ctx-x' }] }),
        ],
        400,
      );
      expect(batchCycle.code).toBe(IntentErrorCode.ConditionCycle);

      // A cycle through a STORED reference: br-ctx-stored → br-ctx-conditioned is committed, and the
      // proposal closes it from the other side.
      await api()
        .post(`${base()}/items/propose`)
        .send(proposeBody([rule('br-ctx-stored', { appliesWhen: [{ item: 'br-ctx-conditioned' }] })]))
        .expect(201);
      const storedCycle = await refusedOnBoth(
        [rule('br-ctx-conditioned', { appliesWhen: [{ item: 'br-ctx-stored' }] })],
        400,
      );
      expect(storedCycle).toMatchObject({
        code: IntentErrorCode.ConditionCycle,
        path: ['items', '0', 'appliesWhen', '0', 'item'],
      });

      // Same-batch references to an id that does not exist yet are fine.
      await api()
        .post(`${base()}/items/propose`)
        .send(proposeBody([rule('br-ctx-p', { appliesWhen: [{ item: 'br-ctx-q' }] }), rule('br-ctx-q')]))
        .expect(201);
    });

    it('checks cycles on an id-less proposal that source identity matches to an existing candidate', async () => {
      const xSource = { ...source, localId: 'CTX-SOURCE-X' };
      await api()
        .post(`${base()}/items/propose`)
        .send(proposeBody([rule('br-ctx-src-x', { sources: [xSource] })]))
        .expect(201);
      await api()
        .post(`${base()}/items/propose`)
        .send(proposeBody([rule('br-ctx-src-y', { appliesWhen: [{ item: 'br-ctx-src-x' }] })]))
        .expect(201);
      const { id: _id, ...idless } = rule('br-ctx-src-x', {
        sources: [xSource],
        appliesWhen: [{ item: 'br-ctx-src-y' }],
      });
      const cycle = await refusedOnBoth([idless], 400);
      expect(cycle).toMatchObject({
        code: IntentErrorCode.ConditionCycle,
        path: ['items', '0', 'appliesWhen', '0', 'item'],
      });
    });

    it('clears stored conditions with appliesWhen: [] back to NULL and the unconditioned release hash', async () => {
      const conditioned = rule('br-ctx-cleared', { appliesWhen: [{ dimension: 'product', in: ['shifts'] }] });
      const twin = rule('br-ctx-cleared-twin', { title: conditioned.title });
      await api()
        .post(`${base()}/items/propose`)
        .send(proposeBody([conditioned, twin]))
        .expect(201);
      const read = (id: string) =>
        prisma.intentItem.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id } } });
      const before = await read('br-ctx-cleared');

      await api()
        .post(`${base()}/items/propose`)
        .send(proposeBody([{ ...conditioned, appliesWhen: [] }]))
        .expect(201);
      const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
        SELECT applies_when IS NULL AS "isNull" FROM intent_items
        WHERE workspace_id = ${workspaceId}::uuid AND id = 'br-ctx-cleared'`;
      expect(row?.isNull).toBe(true);
      const after = await read('br-ctx-cleared');
      expect(releaseContentHash(after)).not.toBe(releaseContentHash(before));
      expect(releaseContentHash(after)).toBe(releaseContentHash(await read('br-ctx-cleared-twin')));
    });

    it('refuses archiving, deleting, or dropping a value of a referenced dimension, naming the items (AC-6)', async () => {
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            rule(
              'br-ctx-overtime',
              { appliesWhen: [{ dimension: 'country', notIn: ['ua'] }] },
              {
                variants: [
                  { when: { country: 'de' }, outcome: '40h' },
                  { outcome: 'contract × 1.1', inputs: ['contractHours'] },
                ],
              },
            ),
          ]),
        )
        .expect(201);

      const deleted = await api()
        .post(`${base()}/dimensions/country/delete`)
        .send({ idempotencyKey: nextKey('dim'), id: 'country' })
        .expect(400);
      expect(deleted.body.code).toBe(IntentErrorCode.DimensionInUse);
      expect(deleted.body.details.map((d: { message: string }) => d.message)).toContain(
        'referenced by item br-ctx-overtime',
      );

      const archived = mcpError(
        await tools.intentTree(
          {
            action: IntentTreeAction.DimensionArchive,
            request: { idempotencyKey: nextKey('dim'), id: 'country', archived: true },
          },
          {} as never,
          mcpRequest(),
        ),
      );
      expect(archived.code).toBe(IntentErrorCode.DimensionInUse);
      expect(archived.message).toContain('br-ctx-overtime');

      const values = (ids: string[]) => ids.map((id) => ({ id, title: id.toUpperCase() }));
      // `ua` is referenced by a notIn clause, `de` by a variant.
      for (const kept of [
        ['de', 'pl', 'fr'],
        ['pl', 'ua', 'fr'],
      ]) {
        const dropped = await api()
          .patch(`${base()}/dimensions/country`)
          .send({ idempotencyKey: nextKey('dim'), id: 'country', values: values(kept) })
          .expect(400);
        expect(dropped.body.code).toBe(IntentErrorCode.DimensionInUse);
        expect(dropped.body.message).toContain('br-ctx-overtime');
      }
      // Flipping `multi` changes how the stored clause and variants read.
      const flipped = await api()
        .patch(`${base()}/dimensions/country`)
        .send({ idempotencyKey: nextKey('dim'), id: 'country', multi: true })
        .expect(400);
      expect(flipped.body.code).toBe(IntentErrorCode.DimensionInUse);
      expect(flipped.body.message).toContain('br-ctx-overtime');
      // A retitle keeps `multi` unchanged and is allowed.
      await api()
        .patch(`${base()}/dimensions/country`)
        .send({ idempotencyKey: nextKey('dim'), id: 'country', title: 'Country of employment' })
        .expect(200);

      // `fr` is referenced by nothing, so dropping it succeeds.
      await api()
        .patch(`${base()}/dimensions/country`)
        .send({ idempotencyKey: nextKey('dim'), id: 'country', values: values(['de', 'pl', 'ua']) })
        .expect(200);

      // A rejected item no longer blocks.
      await prisma.intentItem.updateMany({
        where: { workspaceId, id: { in: ['br-ctx-overtime'] } },
        data: { authority: IntentItemAuthority.rejected },
      });
      await api()
        .patch(`${base()}/dimensions/country`)
        .send({ idempotencyKey: nextKey('dim'), id: 'country', values: values(['pl', 'ua']) })
        .expect(200);
    });

    it('an ACCEPTED item blocks a value drop and a delete, named in the refusal (AC-6, BR-7)', async () => {
      await api()
        .post(`${base()}/dimensions`)
        .send({
          idempotencyKey: nextKey('dim'),
          id: 'shift-kind',
          title: 'Shift kind',
          values: [
            { id: 'day', title: 'Day' },
            { id: 'night', title: 'Night' },
          ],
        })
        .expect(201);
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            rule('br-ctx-night-pay', {}, { variants: [{ when: { 'shift-kind': 'night' }, outcome: '1.25×' }] }),
          ]),
        )
        .expect(201);
      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId, id: 'br-ctx-night-pay' } },
        data: { authority: IntentItemAuthority.accepted },
      });

      const dropped = await api()
        .patch(`${base()}/dimensions/shift-kind`)
        .send({ idempotencyKey: nextKey('dim'), id: 'shift-kind', values: [{ id: 'day', title: 'Day' }] })
        .expect(400);
      expect(dropped.body.code).toBe(IntentErrorCode.DimensionInUse);
      expect(dropped.body.message).toContain('br-ctx-night-pay');
      const deleted = await api()
        .post(`${base()}/dimensions/shift-kind/delete`)
        .send({ idempotencyKey: nextKey('dim'), id: 'shift-kind' })
        .expect(400);
      expect(deleted.body.code).toBe(IntentErrorCode.DimensionInUse);
      expect(deleted.body.details.map((d: { message: string }) => d.message)).toContain(
        'referenced by item br-ctx-night-pay',
      );
    });

    it('an update cannot drop a value added and referenced while it waited on the row (B3 lost update)', async () => {
      await api()
        .post(`${base()}/dimensions`)
        .send({ idempotencyKey: nextKey('dim'), id: 'tier', title: 'Tier', values: [{ id: 'basic', title: 'Basic' }] })
        .expect(201);

      // A concurrent writer: adds `gold` and commits an item referencing it, holding the row until
      // the update below is observed waiting on a lock. The update sends the stale list `[basic]`.
      let pending: Promise<request.Response> | undefined;
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM intent_dimensions WHERE workspace_id = ${workspaceId}::uuid AND id = 'tier' FOR UPDATE`;
          await tx.intentDimension.update({
            where: { workspaceId_id: { workspaceId, id: 'tier' } },
            data: {
              values: [
                { id: 'basic', title: 'Basic' },
                { id: 'gold', title: 'Gold' },
              ],
            },
          });
          await tx.intentItem.create({
            data: {
              workspaceId,
              id: 'br-ctx-gold',
              kind: 'business_rule',
              title: 'Gold rule',
              statement: 'A statement that stands on its own.',
              payload: { condition: 'c', requiredOutcome: 'o', observer: 'obs' },
              appliesWhen: [{ dimension: 'tier', in: ['gold'] }],
              authority: IntentItemAuthority.accepted,
              createdBy: OWNER.id,
              updatedBy: OWNER.id,
            },
          });
          pending = api()
            .patch(`${base()}/dimensions/tier`)
            .send({ idempotencyKey: nextKey('dim'), id: 'tier', values: [{ id: 'basic', title: 'Basic' }] })
            .then((response) => response);
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
              SELECT count(*)::int AS waiting FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`;
            if ((row?.waiting ?? 0) > 0) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error('the update never waited on the dimension row');
        },
        { timeout: 10_000 },
      );

      const response = await pending!;
      expect(response.status).toBe(400);
      expect(response.body.code).toBe(IntentErrorCode.DimensionInUse);
      expect(response.body.message).toContain('br-ctx-gold');
      const stored = await prisma.intentDimension.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: 'tier' } },
      });
      expect((stored.values as { id: string }[]).map((value) => value.id)).toEqual(['basic', 'gold']);
    });

    it('refuses a dimension beyond INTENT_LIMITS.dimensions, archived ones counted (B2)', async () => {
      const other = await prisma.workspace.create({
        data: { name: `intent-dim-cap-${RUN}`, slug: `intent-dim-cap-${RUN}`, intentEnabled: true },
      });
      try {
        await prisma.intentDimension.createMany({
          data: Array.from({ length: INTENT_LIMITS.dimensions }, (_, index) => ({
            workspaceId: other.id,
            id: `dim-${index}`,
            title: `Dim ${index}`,
            values: [{ id: 'v', title: 'V' }],
            archived: index === 0,
            createdBy: OWNER.id,
            updatedBy: OWNER.id,
          })),
        });
        const actor = { id: OWNER.id, role: 'owner' };
        const create = (id: string) =>
          tree.createDimension(other.id, actor, {
            idempotencyKey: nextKey('dim'),
            id,
            title: id,
            values: [{ id: 'v', title: 'V' }],
          });
        await expect(create('one-too-many')).rejects.toMatchObject({
          publicError: { code: IntentErrorCode.SchemaViolation },
        });
        await prisma.intentDimension.delete({ where: { workspaceId_id: { workspaceId: other.id, id: 'dim-0' } } });
        await expect(create('fits-again')).resolves.toMatchObject({ dimension: { id: 'fits-again' } });
      } finally {
        await prisma.intentAuditEvent.deleteMany({ where: { workspaceId: other.id } });
        await prisma.intentMutationRequest.deleteMany({ where: { workspaceId: other.id } });
        await prisma.intentDimension.deleteMany({ where: { workspaceId: other.id } });
        await prisma.workspace.delete({ where: { id: other.id } });
      }
    });

    describe('tree conditions and authoring hints (intent-dimensions-inheritance)', () => {
      const mcpData = (result: unknown) =>
        JSON.parse((result as { content: { text: string }[] }).content[0]?.text ?? 'null');
      const treeCall = (action: IntentTreeAction, body: Record<string, unknown>) =>
        tools.intentTree({ action, request: { idempotencyKey: nextKey('tree'), ...body } }, {} as never, mcpRequest());
      const propose = async (items: unknown[]) =>
        (await api().post(`${base()}/items/propose`).send(proposeBody(items)).expect(201)).body as {
          items: unknown[];
          hints?: unknown[];
        };

      beforeAll(async () => {
        principal = { user: OWNER };
        const updated = await api()
          .patch(`${base()}/dimensions/country`)
          .send({
            idempotencyKey: nextKey('dim'),
            id: 'country',
            values: [
              { id: 'de', title: 'Germany' },
              { id: 'pl', title: 'Poland' },
              { id: 'ua', title: 'Ukraine' },
              { id: 'br', title: 'Brazil', aliases: ['Brazilian', 'Brasil'] },
            ],
          })
          .expect(200);
        expect(updated.body.dimension.values[3]).toEqual({
          id: 'br',
          title: 'Brazil',
          aliases: ['Brazilian', 'Brasil'],
        });
        await api()
          .post(`${base()}/dimensions`)
          .send({
            idempotencyKey: nextKey('dim'),
            id: 'role',
            title: 'Role',
            values: [
              { id: 'admin', title: 'Administrator' },
              { id: 'manager', title: 'Line manager' },
            ],
          })
          .expect(201);
      });

      it('UC-1: sets, reads and clears node conditions over REST and MCP, validated like item conditions', async () => {
        const productShifts = [{ dimension: 'product', in: ['shifts'] }];
        const created = await api()
          .post(`${base()}/domains`)
          .send({ idempotencyKey: nextKey('domain'), id: 'shifts', title: 'Shifts', appliesWhen: productShifts })
          .expect(201);
        expect(created.body.domain.appliesWhen).toEqual(productShifts);
        const feature = mcpData(
          await treeCall(IntentTreeAction.FeatureCreate, {
            id: 'shift-swap-br',
            domainId: 'shifts',
            title: 'Shift swaps in Brazil',
            appliesWhen: [{ dimension: 'country', in: ['br'] }],
          }),
        );
        expect(feature.feature.appliesWhen).toEqual([{ dimension: 'country', in: ['br'] }]);

        const tree = await api().get(`${base()}/tree`).expect(200);
        const node = (id: string) => tree.body.domains.find((domain: { id: string }) => domain.id === id);
        expect(node('shifts').appliesWhen).toEqual(productShifts);
        expect(node('shifts').features[0].appliesWhen).toEqual([{ dimension: 'country', in: ['br'] }]);
        // AC-6: a node without conditions has no key at all.
        expect(node('ctx-home')).not.toHaveProperty('appliesWhen');

        const itemClause = await api()
          .patch(`${base()}/domains/shifts`)
          .send({ idempotencyKey: nextKey('domain'), id: 'shifts', appliesWhen: [{ item: 'br-ctx-plain' }] })
          .expect(400);
        expect(itemClause.body.code).toBe(IntentErrorCode.SchemaViolation);
        const textClause = mcpError(
          await treeCall(IntentTreeAction.FeatureUpdate, { id: 'shift-swap-br', appliesWhen: [{ text: 'weekends' }] }),
        );
        expect(textClause.code).toBe(IntentErrorCode.SchemaViolation);
        const undeclared = await api()
          .patch(`${base()}/domains/shifts`)
          .send({ idempotencyKey: nextKey('domain'), id: 'shifts', appliesWhen: [{ dimension: 'plan', in: ['pro'] }] })
          .expect(404);
        expect(undeclared.body).toMatchObject({
          code: IntentErrorCode.DimensionNotFound,
          path: ['appliesWhen', '0', 'in'],
        });
        const badValue = mcpError(
          await treeCall(IntentTreeAction.DomainUpdate, {
            id: 'shifts',
            appliesWhen: [{ dimension: 'product', notIn: ['nope'] }],
          }),
        );
        expect(badValue).toMatchObject({
          code: IntentErrorCode.DimensionValueNotFound,
          path: ['appliesWhen', '0', 'notIn'],
        });

        await api()
          .patch(`${base()}/features/shift-swap-br`)
          .send({ idempotencyKey: nextKey('feature'), id: 'shift-swap-br', appliesWhen: [] })
          .expect(200);
        const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
          SELECT applies_when IS NULL AS "isNull" FROM intent_features
          WHERE workspace_id = ${workspaceId}::uuid AND id = 'shift-swap-br'`;
        expect(row?.isNull).toBe(true);
        const cleared = await api().get(`${base()}/tree`).expect(200);
        expect(
          cleared.body.domains.find((domain: { id: string }) => domain.id === 'shifts').features[0],
        ).not.toHaveProperty('appliesWhen');
      });

      it("AC-2: a domain's conditions change no item version or release hash, and write one tree audit row", async () => {
        await createDomain('inherit-hash');
        await propose([rule('br-inherit-hash', { domainId: 'inherit-hash' })]);
        const read = () =>
          prisma.intentItem.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: 'br-inherit-hash' } } });
        const before = await read();
        const auditsBefore = await auditFor('inherit-hash');

        mcpData(
          await treeCall(IntentTreeAction.DomainUpdate, {
            id: 'inherit-hash',
            appliesWhen: [{ dimension: 'country', notIn: ['ua'] }],
          }),
        );
        const after = await read();
        expect(after.version).toBe(before.version);
        expect(releaseContentHash(after)).toBe(releaseContentHash(before));
        const auditsAfter = await auditFor('inherit-hash');
        expect(auditsAfter).toHaveLength(auditsBefore.length + 1);
        expect(auditsAfter.at(-1)).toMatchObject({
          operation: 'update',
          before: { appliesWhen: null },
          after: { appliesWhen: [{ dimension: 'country', notIn: ['ua'] }] },
        });
      });

      it('AC-4: a value or dimension used only by a feature condition cannot be dropped, deleted, or flipped', async () => {
        await createDomain('people');
        await api()
          .post(`${base()}/features`)
          .send({
            idempotencyKey: nextKey('feature'),
            id: 'manager-tools',
            domainId: 'people',
            title: 'Manager tools',
            appliesWhen: [{ dimension: 'role', in: ['manager'] }],
          })
          .expect(201);

        const dropped = await api()
          .patch(`${base()}/dimensions/role`)
          .send({ idempotencyKey: nextKey('dim'), id: 'role', values: [{ id: 'admin', title: 'Administrator' }] })
          .expect(400);
        expect(dropped.body.code).toBe(IntentErrorCode.DimensionInUse);
        expect(dropped.body.details.map((d: { message: string }) => d.message)).toEqual([
          'referenced by feature manager-tools',
        ]);
        const deleted = mcpError(await treeCall(IntentTreeAction.DimensionDelete, { id: 'role' }));
        expect(deleted.code).toBe(IntentErrorCode.DimensionInUse);
        expect(deleted.message).toContain('feature manager-tools');
        const flipped = await api()
          .patch(`${base()}/dimensions/role`)
          .send({ idempotencyKey: nextKey('dim'), id: 'role', multi: true })
          .expect(400);
        expect(flipped.body.message).toContain('feature manager-tools');
        // `admin` is referenced by nothing.
        await api()
          .patch(`${base()}/dimensions/role`)
          .send({ idempotencyKey: nextKey('dim'), id: 'role', values: [{ id: 'manager', title: 'Line manager' }] })
          .expect(200);
      });

      it('validates conditions on feature create like on every other tree write', async () => {
        await createDomain('create-validated');
        const undeclared = await api()
          .post(`${base()}/features`)
          .send({
            idempotencyKey: nextKey('feature'),
            id: 'create-validated-f',
            domainId: 'create-validated',
            title: 'Validated',
            appliesWhen: [{ dimension: 'plan', in: ['pro'] }],
          })
          .expect(404);
        expect(undeclared.body.code).toBe(IntentErrorCode.DimensionNotFound);
      });

      it('reports affectedAcceptedItems only when a node s conditions change', async () => {
        await createDomain('impact');
        await createFeature('impact-f', 'impact');
        await propose([
          rule('br-impact-domain', { domainId: 'impact' }),
          rule('br-impact-feature', { featureId: 'impact-f' }),
          rule('br-impact-candidate', { featureId: 'impact-f' }),
        ]);
        await prisma.intentItem.updateMany({
          where: { workspaceId, id: { in: ['br-impact-domain', 'br-impact-feature'] } },
          data: { authority: 'accepted' },
        });
        const countryNotUa = [{ dimension: 'country', notIn: ['ua'] }];
        const domain = await api()
          .patch(`${base()}/domains/impact`)
          .send({ idempotencyKey: nextKey('domain'), id: 'impact', appliesWhen: countryNotUa })
          .expect(200);
        expect(domain.body.affectedAcceptedItems).toBe(2);
        const feature = mcpData(
          await treeCall(IntentTreeAction.FeatureUpdate, { id: 'impact-f', appliesWhen: countryNotUa }),
        );
        expect(feature.affectedAcceptedItems).toBe(1);
        const same = await api()
          .patch(`${base()}/domains/impact`)
          .send({ idempotencyKey: nextKey('domain'), id: 'impact', title: 'Renamed', appliesWhen: countryNotUa })
          .expect(200);
        expect(same.body).not.toHaveProperty('affectedAcceptedItems');
        const created = await api()
          .post(`${base()}/features`)
          .send({
            idempotencyKey: nextKey('feature'),
            id: 'impact-g',
            domainId: 'impact',
            title: 'G',
            appliesWhen: countryNotUa,
          })
          .expect(201);
        expect(created.body.affectedAcceptedItems).toBe(0);
        expect((await createFeature('impact-h', 'impact')).body).not.toHaveProperty('affectedAcceptedItems');
      });

      it('AC-3: propose hints a named value the effective conditions leave open, over REST and MCP', async () => {
        const brazilian = {
          title: 'Overtime premium',
          statement: 'Brazilian companies get overtime at 50%.',
        };
        const items = [
          rule('br-hint-brazil', brazilian),
          // "break" holds "br" but names no value.
          rule('br-hint-break', { title: 'Paid breaks', statement: 'A break of 15 minutes counts as worked time.' }),
        ];
        const rest = await propose(items);
        const expected = [
          { proposalIndex: 0, kind: 'missing-condition', dimension: 'country', value: 'br', matched: 'Brazilian' },
        ];
        expect(rest.hints).toEqual(expected);
        const mcp = mcpData(await tools.intentPropose(proposeBody(items), {} as never, mcpRequest()));
        expect(mcp.hints).toEqual(expected);

        // The same text in a feature whose conditions constrain `country`.
        await api()
          .post(`${base()}/features`)
          .send({
            idempotencyKey: nextKey('feature'),
            id: 'payroll-br',
            domainId: 'ctx-home',
            title: 'Payroll',
            appliesWhen: [{ dimension: 'country', in: ['br'] }],
          })
          .expect(201);
        const placed = await propose([rule('br-hint-brazil-placed', { ...brazilian, featureId: 'payroll-br' })]);
        expect(placed).not.toHaveProperty('hints');
        expect(await propose([rule('br-hint-none')])).not.toHaveProperty('hints');

        // The same text constrained through an `item` clause's target.
        await propose([rule('br-hint-target', { appliesWhen: [{ dimension: 'country', in: ['br'] }] })]);
        const followed = await propose([
          rule('br-hint-brazil-followed', { ...brazilian, appliesWhen: [{ item: 'br-hint-target' }] }),
        ]);
        // The target's `country` clause silences the missing-condition hint, but the target is still a
        // candidate: the clause reads `unevaluated` and filters nothing, so the reviewer is told.
        expect(followed.hints).toEqual([
          { proposalIndex: 0, kind: 'unaccepted-condition-item', item: 'br-hint-target' },
        ]);
      });

      it('skips negated mentions, person fields and values without aliases', async () => {
        const negated = rule('br-hint-negated', {
          title: 'Weekly trigger',
          statement: 'Existing pay policies of non-Brazilian companies keep the old calculation.',
        });
        // "Administrator" is a role title without aliases; "Brazilian" sits in `observer` only.
        const people = rule('br-hint-people', {}, { observer: 'Brazilian payroll Administrator' });
        expect(await propose([negated, people])).not.toHaveProperty('hints');
        const inCondition = rule('br-hint-condition', {}, { condition: 'A Brazilian company closes the period' });
        expect((await propose([inCondition])).hints).toEqual([
          { proposalIndex: 0, kind: 'missing-condition', dimension: 'country', value: 'br', matched: 'Brazilian' },
        ]);
      });

      it("a domainId beside a featureId is a check: kept when it is the feature's domain, refused otherwise", async () => {
        await createDomain('packet-home');
        await createDomain('packet-other');
        await createFeature('packet-feature', 'packet-home');

        await propose([rule('br-packet-in-feature', { domainId: 'packet-home', featureId: 'packet-feature' })]);
        const stored = await prisma.intentItem.findUnique({
          where: { workspaceId_id: { workspaceId, id: 'br-packet-in-feature' } },
          select: { domainId: true, featureId: true },
        });
        expect(stored).toEqual({ domainId: 'packet-home', featureId: 'packet-feature' });

        const mismatched = [rule('br-packet-mismatch', { domainId: 'packet-other', featureId: 'packet-feature' })];
        const rest = await api().post(`${base()}/items/propose`).send(proposeBody(mismatched)).expect(400);
        expect(rest.body).toMatchObject({
          code: IntentErrorCode.FeatureDomainMismatch,
          path: ['items', '0', 'domainId'],
        });
        const mcp = mcpData(await tools.intentPropose(proposeBody(mismatched), {} as never, mcpRequest()));
        expect(mcp.error).toMatchObject({
          code: IntentErrorCode.FeatureDomainMismatch,
          path: ['items', '0', 'domainId'],
        });
        expect(
          await prisma.intentItem.findUnique({ where: { workspaceId_id: { workspaceId, id: 'br-packet-mismatch' } } }),
        ).toBeNull();
      });

      it('AC-7: propose hints ambiguous and dead variants', async () => {
        const ambiguous = [
          { when: { country: 'de' }, outcome: '40h' },
          { when: { product: 'shifts' }, outcome: '38h' },
          { outcome: 'contract hours' },
        ];
        expect((await propose([rule('br-hint-ambiguous', {}, { variants: ambiguous })])).hints).toEqual([
          {
            proposalIndex: 0,
            kind: 'ambiguous-variants',
            variants: [0, 1],
            context: { country: 'de', product: 'shifts' },
          },
        ]);
        const covered = [...ambiguous, { when: { country: 'de', product: 'shifts' }, outcome: '36h' }];
        expect(await propose([rule('br-hint-ambiguous', {}, { variants: covered })])).not.toHaveProperty('hints');

        const dead = await propose([
          rule(
            'br-hint-dead',
            { appliesWhen: [{ dimension: 'country', notIn: ['ua'] }] },
            { variants: [{ when: { country: 'ua' }, outcome: '42h' }, { outcome: '40h' }] },
          ),
        ]);
        expect(dead.hints).toEqual([{ proposalIndex: 0, kind: 'dead-variant', variant: 0 }]);
      });
    });
  });

  describe('idempotency', () => {
    it('returns the stored response on a replay and writes nothing twice', async () => {
      const body = {
        idempotencyKey: nextKey('replay'),
        id: 'replayed',
        title: 'Replayed domain',
        statement: 'Created once.',
      };
      const first = await api().post(`${base()}/domains`).send(body).expect(201);
      const second = await api().post(`${base()}/domains`).send(body).expect(201);

      expect(second.body).toEqual(first.body);
      expect(await auditFor('replayed')).toHaveLength(1);
    });

    it('refuses the same key used for a different request body', async () => {
      const key = nextKey('reuse');
      await api().post(`${base()}/domains`).send({ idempotencyKey: key, id: 'reused-key', title: 'First' }).expect(201);
      const response = await api()
        .post(`${base()}/domains`)
        .send({ idempotencyKey: key, id: 'reused-key-other', title: 'Second' })
        .expect(409);
      expect(response.body.code).toBe(IntentErrorCode.IdempotencyRequestConflict);
    });

    it('refuses the same key used for a different operation', async () => {
      const key = nextKey('cross');
      await api()
        .post(`${base()}/domains`)
        .send({ idempotencyKey: key, id: 'cross-op', title: 'Cross op' })
        .expect(201);
      const response = await api()
        .patch(`${base()}/domains/cross-op`)
        .send({ idempotencyKey: key, id: 'cross-op', title: 'Renamed' })
        .expect(409);
      expect(response.body.code).toBe(IntentErrorCode.IdempotencyOperationConflict);
    });

    it('leaves no ledger row behind when the mutation was refused', async () => {
      const key = nextKey('refused');
      await api()
        .post(`${base()}/domains`)
        .send({ idempotencyKey: key, id: 'replayed', title: 'Duplicate id' })
        .expect(400);
      expect(
        await prisma.intentMutationRequest.findUnique({
          where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: key } },
        }),
      ).toBe(null);
    });
  });

  /* ------------------------------------------------- version conflict --- */

  describe('optimistic concurrency', () => {
    it('applies a versioned update once and conflicts on the stale version', async () => {
      principal = { user: OWNER };
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: 'br-versioned-rule',
              kind: 'business_rule',
              title: 'Versioned rule',
              statement: 'A rule used to exercise the version guard.',
              sources: [{ kind: 'spec', ref: 'spec/versions', localId: 'BR-1' }],
            },
          ]),
        )
        .expect(201);

      const applied = await prisma.$transaction((tx) =>
        updateItemWithVersion(tx, {
          workspaceId,
          itemId: 'br-versioned-rule',
          expectedVersion: 1,
          updatedBy: OWNER.id,
          data: { title: 'Versioned rule, edited' },
        }),
      );
      expect(applied).toBe(2);

      await expect(
        prisma.$transaction((tx) =>
          updateItemWithVersion(tx, {
            workspaceId,
            itemId: 'br-versioned-rule',
            expectedVersion: 1,
            updatedBy: OWNER.id,
            data: { title: 'A second edit from a stale read' },
          }),
        ),
      ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.VersionConflict } });

      const stored = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: 'br-versioned-rule' } },
      });
      expect(stored).toMatchObject({ version: 2, title: 'Versioned rule, edited' });
    });

    it('refuses a propose whose candidate a concurrent review accepted, leaving the accepted item unchanged', async () => {
      const itemId = 'br-accepted-mid-propose';
      const source = { kind: 'spec', ref: 'spec/race', localId: 'BR-RACE' };
      const REVIEWED_PAYLOAD = {
        condition: 'A refund is requested',
        requiredOutcome: 'The refund is issued within the window',
        observer: 'Customer',
      };
      await api()
        .post(`${base()}/items/propose`)
        .send(
          proposeBody([
            {
              id: itemId,
              kind: 'business_rule',
              title: 'Race rule',
              statement: 'The reviewed statement.',
              payload: REVIEWED_PAYLOAD,
              sources: [source],
            },
          ]),
        )
        .expect(201);

      // Controlled pause: the propose transaction stops right after its plan
      // read saw a candidate, while the review runs on another pooled
      // connection and COMMITS before the propose is released.
      const propose = app.get(IntentProposeService);
      let markPlanned!: () => void;
      let releasePropose!: () => void;
      const planned = new Promise<void>((resolve) => {
        markPlanned = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releasePropose = resolve;
      });
      const facts = propose as unknown as { readItemFacts: (...args: unknown[]) => Promise<unknown> };
      const original = facts.readItemFacts.bind(propose);
      const spy = vi.spyOn(facts, 'readItemFacts').mockImplementation(async (...args) => {
        const result = await original(...args);
        markPlanned();
        await released;
        return result;
      });

      try {
        const inFlight = propose
          .propose(workspaceId, { id: OWNER.id, role: 'owner' }, {
            idempotencyKey: nextKey('propose-race'),
            items: [
              {
                id: itemId,
                kind: 'business_rule',
                title: 'Rewritten by capture',
                statement: 'A statement the review never saw.',
                payload: { ...REVIEWED_PAYLOAD, requiredOutcome: 'An outcome the review never saw' },
                sources: [source],
              },
            ],
          } as never)
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await planned;

        const reviewed = await new IntentReviewService(prisma as unknown as PrismaService).review(
          workspaceId,
          { id: OWNER.id, role: 'owner' },
          {
            idempotencyKey: nextKey('review-race'),
            authorizingSource: { kind: 'spec', ref: 'spec/race', localId: 'BR-RACE', revision: 'rev-1' },
            workItem: { provider: 'jira', id: 'ENG-7', displayKey: 'ENG-7' },
            decisions: [{ itemId, expectedVersion: 1, action: 'accept', reason: 'Accepted mid-propose.' }],
          } as never,
        );
        expect(reviewed.decisions[0]?.outcome).toBe('accepted');

        releasePropose();
        expect(await inFlight).toMatchObject({ publicError: { code: IntentErrorCode.ItemNoLongerCandidate } });
      } finally {
        releasePropose();
        spy.mockRestore();
      }

      const stored = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: itemId } },
      });
      expect(stored).toMatchObject({
        authority: IntentItemAuthority.accepted,
        version: 2,
        title: 'Race rule',
        statement: 'The reviewed statement.',
        payload: REVIEWED_PAYLOAD,
      });
    });
  });

  /* ------------------------------------------------------ list paging --- */

  describe('list pagination', () => {
    it('pages the item index with a stable cursor and refuses a cursor from another list', async () => {
      principal = { user: OWNER };
      const first = await api().get(`${base()}/items?limit=1`).expect(200);
      expect(first.body.items).toHaveLength(1);
      expect(first.body.nextCursor).toBeTypeOf('string');

      const second = await api().get(`${base()}/items?limit=1&cursor=${first.body.nextCursor}`).expect(200);
      expect(second.body.items[0].id > first.body.items[0].id).toBe(true);

      const foreign = await api().get(`${base()}/tree?cursor=${first.body.nextCursor}`).expect(400);
      expect(foreign.body.code).toBe(IntentErrorCode.InvalidCursor);
    });

    it('filters text and authority before pagination and treats search wildcards literally', async () => {
      principal = { user: OWNER };
      await prisma.intentItem.createMany({
        data: [
          { id: 'br-search-a', title: 'Search needle', statement: 'Literal 10%_limit', authority: 'accepted' as const },
          { id: 'br-search-b', title: 'Other title', statement: 'SEARCH NEEDLE', authority: 'accepted' as const },
          { id: 'br-search-c', title: 'Search needle', statement: 'Other', authority: 'candidate' as const },
        ].map((row) => ({
          ...row,
          workspaceId,
          kind: 'business_rule' as const,
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        })),
      });
      const query = { search: 'search needle', authorities: 'accepted,superseded', kinds: 'business_rule', limit: 1 };
      const first = await api().get(`${base()}/items`).query(query).expect(200);
      expect(first.body.items.map((item: { id: string }) => item.id)).toEqual(['br-search-a']);
      const second = await api()
        .get(`${base()}/items`)
        .query({ ...query, cursor: first.body.nextCursor })
        .expect(200);
      expect(second.body.items.map((item: { id: string }) => item.id)).toEqual(['br-search-b']);
      expect(second.body.nextCursor).toBeNull();
      const literal = await api().get(`${base()}/items`).query({ search: '%_' }).expect(200);
      expect(literal.body.items.map((item: { id: string }) => item.id)).toEqual(['br-search-a']);
      const byId = await api().get(`${base()}/items`).query({ search: 'BR-SEARCH-B' }).expect(200);
      expect(byId.body.items.map((item: { id: string }) => item.id)).toEqual(['br-search-b']);
      await api().get(`${base()}/items`).query({ authorities: 'accepted,invalid' }).expect(400);
    });

    it('keeps feature search scoped to its domain and inherited domain rules', async () => {
      const audit = { workspaceId, createdBy: OWNER.id, updatedBy: OWNER.id };
      await prisma.intentDomain.createMany({
        data: ['dom-search', 'dom-other'].map((id) => ({ ...audit, id, title: id, statement: 'Search scope' })),
      });
      await prisma.intentFeature.createMany({
        data: ['feat-search', 'feat-sibling'].map((id) => ({
          ...audit,
          id,
          domainId: 'dom-search',
          title: id,
          statement: 'Search scope',
        })),
      });
      await prisma.intentItem.createMany({
        data: [
          { id: 'br-scope-domain', domainId: 'dom-search', featureId: null },
          { id: 'br-scope-feature', domainId: 'dom-search', featureId: 'feat-search' },
          { id: 'br-scope-sibling', domainId: 'dom-search', featureId: 'feat-sibling' },
          { id: 'br-scope-other', domainId: 'dom-other', featureId: null },
        ].map((row) => ({
          ...audit,
          ...row,
          title: 'Scoped search',
          statement: 'Scope test',
          kind: 'business_rule' as const,
        })),
      });
      const result = await api()
        .get(`${base()}/items`)
        .query({ domainId: 'dom-search', scopeFeatureId: 'feat-search', search: 'scoped search' })
        .expect(200);
      expect(result.body.items.map((item: { id: string }) => item.id)).toEqual(['br-scope-domain', 'br-scope-feature']);
    });

    it('finds distinct sources and filters the catalogue by exact source identity', async () => {
      const data = { workspaceId, kind: 'spec' as const, ref: 'spec/search-source', title: 'Searchable uploads spec' };
      await prisma.intentItemSource.createMany({
        data: [
          { ...data, itemId: 'br-search-a', localId: 'BR-1' },
          { ...data, itemId: 'br-search-b', localId: 'BR-2' },
          { ...data, kind: 'issue' as const, itemId: 'br-search-c', localId: 'BR-3' },
        ],
      });
      const sources = await api().get(`${base()}/sources`).query({ search: 'UPLOADS SPEC' }).expect(200);
      expect(sources.body.sources).toHaveLength(2);
      expect(sources.body.truncated).toBe(false);
      const first = await api()
        .get(`${base()}/items`)
        .query({ sourceRef: data.ref, sourceKind: 'spec', limit: 1, production: 'true' })
        .expect(200);
      expect(first.body.items).toMatchObject([{ id: 'br-search-a', effectivity: 'unknown' }]);
      const next = await api()
        .get(`${base()}/items`)
        .query({ sourceRef: data.ref, sourceKind: 'spec', limit: 1, cursor: first.body.nextCursor })
        .expect(200);
      expect(next.body.items.map((row: { id: string }) => row.id)).toEqual(['br-search-b']);
      expect(next.body.nextCursor).toBeNull();
    });

    it('bounds the source picker while searching all sources and isolating workspaces', async () => {
      await prisma.intentItemSource.createMany({
        data: Array.from({ length: 52 }, (_, i) => ({
          workspaceId,
          itemId: 'br-search-a',
          kind: 'spec' as const,
          ref: `catalogsource/${String(i).padStart(2, '0')}`,
          localId: 'BR-1',
        })),
      });
      const page = await api().get(`${base()}/sources`).query({ search: 'catalogsource/' }).expect(200);
      expect(page.body.sources).toHaveLength(50);
      expect(page.body.truncated).toBe(true);
      const last = await api().get(`${base()}/sources`).query({ search: 'catalogsource/51' }).expect(200);
      expect(last.body.sources).toMatchObject([{ ref: 'catalogsource/51' }]);
      const foreign = await prisma.workspace.create({
        data: { name: 'Foreign source', slug: nextKey('foreign-source'), intentEnabled: true },
      });
      try {
        await prisma.intentItem.create({
          data: {
            workspaceId: foreign.id,
            id: 'br-foreign',
            kind: 'business_rule',
            title: 'Foreign',
            statement: 'Foreign',
            createdBy: OWNER.id,
            updatedBy: OWNER.id,
          },
        });
        await prisma.intentItemSource.create({
          data: {
            workspaceId: foreign.id,
            itemId: 'br-foreign',
            kind: 'spec',
            ref: 'catalogsource/private',
            localId: 'BR-1',
          },
        });
        expect(
          (await api().get(`${base()}/sources`).query({ search: 'catalogsource/private' }).expect(200)).body.sources,
        ).toEqual([]);
      } finally {
        await prisma.workspace.delete({ where: { id: foreign.id } });
      }
    });

    it('refuses an unknown query parameter rather than ignoring it', async () => {
      const response = await api().get(`${base()}/items?authorty=accepted`).expect(400);
      expect(response.body.code).toBe('schema_violation');
    });
  });
});
