/**
 * Export end to end against real PostgreSQL and real guards (spec §9, §12, §14),
 * seeded through the workspace import, plus the import refusals that hold for
 * any document: content safety, the user-session fence, and emptiness.
 *
 * Only `AuthGuard` is stubbed — the token→principal step, which has no issuer
 * in this process. `WorkspaceRoleGuard`, `PermissionsGuard` and, crucially,
 * `UserSessionGuard` are REAL, so "no machine-only path to an authority change"
 * is proven through the production code path.
 *
 * Each workspace is created fresh per describe: import refuses a non-empty
 * workspace by design, so sharing one between the happy path and the refusal
 * cases would couple them to test order.
 */
import '../../config/load-env.js';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { canonicalIntentJson } from '@coredoc/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { IntentErrorCode } from './contract/index.js';
import {
  hashExportContent,
  type CloudIntentExportContent,
  type CloudIntentExportV1,
} from './intent-export.operations.js';
import { IntentExportController } from './intent-export.controller.js';
import { IntentExportService } from './intent-export.service.js';
import { IntentImportController } from './intent-import.controller.js';
import { CLOUD_INTENT_WORKSPACE_FORMAT_VERSION, IntentWorkspaceImportService } from './intent-workspace-import.js';

const TEST_DATABASE_URL = process.env.INTENT_TRANSFER_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };

/** Registered in the workspace, so anchors may name it. */
const REGISTERED_REPO = 'github.com/acme/widgets';

/**
 * A workspace document: three domains (one declared-but-unused), five accepted
 * items and one candidate, and a source carrying `revision` and `locator`.
 */
const DOCUMENT = {
  formatVersion: CLOUD_INTENT_WORKSPACE_FORMAT_VERSION,
  source: { ref: 'widget-shop@main', revision: 'c'.repeat(64) },
  domains: [
    { id: 'ordering', title: 'Ordering', statement: 'Placing, accepting and refusing widget orders.' },
    { id: 'stock', title: 'Stock and warehouses' },
    { id: 'returns', title: 'Returns', statement: 'Declared for structure; no reviewed item lives here yet.' },
  ],
  features: [],
  items: [
    {
      id: 'cap-widget-ordering',
      kind: 'capability',
      domainId: 'ordering',
      title: 'Widget ordering',
      statement: 'The product lets a store operator order widgets for one warehouse.',
      authority: 'accepted',
      sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
      payload: {
        outcome: 'A store operator can place a widget order and see its state',
        beneficiary: 'Store operator',
        boundary: 'Single warehouse; no cross-warehouse transfers',
      },
    },
    {
      id: 'uc-place-widget-order',
      kind: 'use_case',
      domainId: 'ordering',
      title: 'Place a widget order',
      statement: 'A store operator submits a widget order and receives its identifier.',
      authority: 'accepted',
      sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'UC-1', revision: '2', locator: 'section-2' }],
      payload: {
        primaryActor: 'Store operator',
        trigger: 'The operator submits an order form',
        preconditions: ['The operator is signed in'],
        successOutcome: 'An order exists in state accepted',
        failureOutcomes: ['Stock is insufficient and the order is refused'],
      },
    },
    {
      id: 'flow-order-submission',
      kind: 'flow',
      domainId: 'ordering',
      title: 'Order submission flow',
      statement: 'Ordering runs from form submission to an accepted or refused order.',
      authority: 'accepted',
      sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'FLOW-1' }],
      payload: {
        trigger: 'The operator submits the order form',
        terminationCondition: 'The order is accepted or refused',
        steps: [
          { id: 's1', actor: 'Store operator', action: 'Submits the order form', outcome: 'The request arrives' },
          { id: 's2', actor: 'Ordering service', action: 'Stores the order', outcome: 'The order is accepted' },
        ],
      },
    },
    {
      id: 'br-orders-never-exceed-stock',
      kind: 'business_rule',
      domainId: 'stock',
      title: 'Orders never exceed stock',
      statement: 'An order beyond available stock is refused.',
      authority: 'accepted',
      sources: [{ kind: 'issue', ref: 'tracker/WID-14', localId: 'BR-3' }],
      payload: {
        condition: 'An order requests more units than the warehouse holds',
        requiredOutcome: 'The order is refused and no stock is reserved',
        observer: 'Store operator',
      },
    },
    {
      id: 'lim-single-warehouse-orders',
      kind: 'limitation',
      domainId: 'ordering',
      title: 'Single-warehouse orders',
      statement: 'An order cannot span two warehouses.',
      authority: 'accepted',
      sources: [{ kind: 'manual', ref: 'maintainer/notes', localId: 'LIM-1' }],
      payload: {
        constraint: 'Orders cover one warehouse only',
        reason: 'Cross-warehouse transfer has no reviewed product decision',
        affects: 'Widget ordering',
      },
    },
    {
      id: 'dec-refuse-over-stock-orders',
      kind: 'decision',
      domainId: 'stock',
      title: 'Refuse over-stock orders at submission',
      statement: 'Orders beyond stock are refused at submission rather than reconciled later.',
      // The one candidate: import must preserve it as a candidate, never promote.
      authority: 'candidate',
      sources: [{ kind: 'adr', ref: 'docs/adr/0002-stock-refusal', localId: 'ADR-2' }],
      payload: {
        question: 'How should the product handle an order that exceeds stock?',
        choice: 'Refuse the order at submission time',
        choiceStatus: 'accepted',
        rationale: 'Refusing early keeps stock and order state consistent',
        alternatives: ['Reserve stock optimistically and reconcile later'],
        consequences: ['Operators retry after restock'],
      },
    },
  ],
};

/** Two anchors on the registered repo, written as rows: the workspace document carries none. */
const ANCHORS = [
  {
    itemId: 'cap-widget-ordering',
    nodeId: 'aaaa:function:src/widgets/order.ts:placeOrder',
    nodeType: 'function',
    capturedVersionedId: 'aaaa:function:src/widgets/order.ts:placeOrder@1111',
    rationale: 'Entry point that performs the ordering outcome',
  },
  {
    itemId: 'br-orders-never-exceed-stock',
    nodeId: 'aaaa:class:src/widgets/stock.ts:StockGuard',
    nodeType: 'class',
    capturedVersionedId: 'aaaa:class:src/widgets/stock.ts:StockGuard@2222',
    rationale: 'Holds the stock check that enforces the rule',
  },
];

interface Principal {
  user: { id: string; email: string };
  serviceToken?: { permissions: string[] };
}

interface ErrorBody {
  code: string;
  message: string;
  path: string[];
  details?: Array<{ code: string; message: string; path: string[] }>;
}

describe.skipIf(!TEST_DATABASE_URL)('intent workspace import refusals and export (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let principal: Principal;
  const workspaces: string[] = [];

  /** A fresh, EMPTY workspace with one registered repo identity. */
  async function freshWorkspace(label: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name: `intent-xfer-${label}-${RUN}`, slug: `intent-xfer-${label}-${RUN}`, intentEnabled: true },
    });
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: OWNER.id, email: OWNER.email, role: 'owner' },
        { workspaceId: workspace.id, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    await prisma.workspaceRepo.create({
      data: {
        workspaceId: workspace.id,
        // The check constraint requires the hash to be the one the durable key produces.
        repoKey: graphRepoHashOf(REGISTERED_REPO),
        repoName: 'widgets',
        intentRepoKey: REGISTERED_REPO,
      },
    });
    workspaces.push(workspace.id);
    return workspace.id;
  }

  const importBody = (idempotencyKey: string, document: unknown = DOCUMENT) => ({ idempotencyKey, document });

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    principal = { user: OWNER };

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentImportController, IntentExportController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        // The REAL `WorkspaceRoleGuard` reads membership through this.
        ControlPlaneService,
        IntentWorkspaceImportService,
        IntentExportService,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const httpRequest = context.switchToHttp().getRequest();
          httpRequest.user = principal.user;
          if (principal.serviceToken) {
            httpRequest.serviceTokenWorkspaceId = httpRequest.params.workspaceId;
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
    for (const workspaceId of workspaces) {
      await prisma.intentReleaseEvent.deleteMany({ where: { workspaceId } });
      await prisma.intentAuthorityTransition.deleteMany({ where: { workspaceId } });
      await prisma.intentAnchor.deleteMany({ where: { workspaceId } });
      await prisma.intentItemSource.deleteMany({ where: { workspaceId } });
      await prisma.intentItem.deleteMany({ where: { workspaceId } });
      await prisma.intentDomain.deleteMany({ where: { workspaceId } });
      await prisma.intentDimension.deleteMany({ where: { workspaceId } });
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  /* ----------------------------------------------------------- refusals --- */

  describe('import refusals', () => {
    let workspaceId: string;

    beforeAll(async () => {
      workspaceId = await freshWorkspace('refusals');
    });

    it('refuses an email-shaped string anywhere in the document, naming the exact path', async () => {
      principal = { user: OWNER };
      const poisoned = structuredClone(DOCUMENT) as typeof DOCUMENT;
      poisoned.items[1].payload = {
        ...poisoned.items[1].payload,
        primaryActor: 'Store operator (ops@widget-shop.example.com)',
      } as never;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import/workspace`)
        .send(importBody('key-pii', poisoned))
        .expect(400);

      const body = response.body as ErrorBody;
      expect(body.code).toBe(IntentErrorCode.ContentEmailShaped);
      expect(body.path).toEqual(['document', 'items', '1', 'payload', 'primaryActor']);
      // Refused before anything was written.
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(0);
    });

    it('refuses a service token: import lands accepted items, so it needs a user session', async () => {
      principal = { user: OWNER, serviceToken: { permissions: [TokenPermission.IntentRead] } };
      await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import/workspace`)
        .send(importBody('key-service-token'))
        .expect(403);
      principal = { user: OWNER };
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(0);
    });
  });

  it('refuses import into a workspace that holds only dimensions', async () => {
    principal = { user: OWNER };
    const workspaceId = await freshWorkspace('dimensions-only');
    await prisma.intentDimension.create({
      data: {
        workspaceId,
        id: 'country',
        title: 'Country',
        values: [{ id: 'de', title: 'Germany' }],
        createdBy: OWNER.id,
        updatedBy: OWNER.id,
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/intent/import/workspace`)
      .send(importBody('key-dimensions-only'))
      .expect(409);
    const body = response.body as ErrorBody;
    expect(body.code).toBe(IntentErrorCode.WorkspaceNotEmpty);
    expect(body.message).toContain('dimensions: 1');
    expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(0);
  });

  /* ------------------------------------------------------------- export --- */

  describe('export', () => {
    let workspaceId: string;

    async function fetchExport(): Promise<CloudIntentExportV1> {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/workspaces/${workspaceId}/intent/export`)
        .expect(200);
      return response.body as CloudIntentExportV1;
    }

    beforeAll(async () => {
      workspaceId = await freshWorkspace('export');
      principal = { user: OWNER };
      await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import/workspace`)
        .send(importBody('key-export-seed'))
        .expect(201);
      await prisma.intentAnchor.createMany({
        data: ANCHORS.map((anchor) => ({
          ...anchor,
          workspaceId,
          repoKey: REGISTERED_REPO,
          createdBy: OWNER.id,
        })),
      });
    });

    it('represents every imported fact (spec §15 round-trip criterion)', async () => {
      principal = { user: OWNER };
      const exported = await fetchExport();

      expect(exported.formatVersion).toBe(1);
      expect(exported.content.workspaceId).toBe(workspaceId);
      expect(exported.content.tree.domains.map((domain) => domain.id)).toEqual(['ordering', 'returns', 'stock']);
      expect(exported.content.items.map((item) => item.id)).toEqual(DOCUMENT.items.map((item) => item.id).sort());
      expect(exported.content.items.find((item) => item.id === 'dec-refuse-over-stock-orders')?.authority).toBe(
        'candidate',
      );
      expect(exported.content.sources).toHaveLength(DOCUMENT.items.length);
      expect(exported.content.sources.find((source) => source.itemId === 'uc-place-widget-order')).toMatchObject({
        locator: 'section-2',
        revision: '2',
      });
      expect(exported.content.anchors).toHaveLength(2);
      expect(exported.content.transitions).toHaveLength(DOCUMENT.items.length);
      expect(exported.content.transitions.every((transition) => transition.fromAuthority === null)).toBe(true);
      // The tree has no features yet, and seeds cannot exist without one.
      expect(exported.content.tree.features).toEqual([]);
      expect(exported.content.tree.seeds).toEqual([]);
    });

    it('is deterministic: two exports with no intervening write agree byte for byte', async () => {
      principal = { user: OWNER };
      const first = await fetchExport();
      const second = await fetchExport();
      expect(canonicalIntentJson(second.content)).toBe(canonicalIntentJson(first.content));
      expect(second.contentHash).toBe(first.contentHash);
      // `generatedAt` is the ONE volatile field, and it is outside the hash.
      expect(second.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('carries no dimensions or appliesWhen keys for an unconditioned workspace (BR-8)', async () => {
      principal = { user: OWNER };
      const exported = await fetchExport();
      expect(exported.content).not.toHaveProperty('dimensions');
      expect(exported.content.items.some((item) => 'appliesWhen' in item)).toBe(false);
      const bytes = canonicalIntentJson(exported.content);
      expect(bytes).not.toContain('"dimensions"');
      expect(bytes).not.toContain('"appliesWhen"');
    });

    it('changes the hash exactly when committed intent state changes', async () => {
      principal = { user: OWNER };
      const before = await fetchExport();

      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId, id: 'lim-single-warehouse-orders' } },
        data: { title: 'Single-warehouse orders (revised)', version: { increment: 1 } },
      });

      const after = await fetchExport();
      expect(after.contentHash).not.toBe(before.contentHash);
      expect(after.content.items.find((item) => item.id === 'lim-single-warehouse-orders')?.title).toBe(
        'Single-warehouse orders (revised)',
      );
    });

    it('exports the dimension registry and item conditions once they exist, under a new hash', async () => {
      principal = { user: OWNER };
      const before = await fetchExport();
      await prisma.intentDimension.create({
        data: {
          workspaceId,
          id: 'country',
          title: 'Country',
          values: [{ id: 'de', title: 'Germany' }],
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      });
      const appliesWhen = [{ dimension: 'country', in: ['de'] }];
      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId, id: 'lim-single-warehouse-orders' } },
        data: { appliesWhen },
      });

      const after = await fetchExport();
      expect(after.contentHash).not.toBe(before.contentHash);
      expect(after.content.dimensions).toMatchObject([
        { id: 'country', values: [{ id: 'de', title: 'Germany' }], multi: false, archived: false },
      ]);
      expect(after.content.items.find((item) => item.id === 'lim-single-warehouse-orders')?.appliesWhen).toEqual(
        appliesWhen,
      );
    });

    it('exports a domain condition on that node only, leaving item versions alone', async () => {
      principal = { user: OWNER };
      const before = await fetchExport();
      const [domain] = before.content.tree.domains;
      const appliesWhen = [{ dimension: 'country', in: ['de'] }];
      await prisma.intentDomain.update({
        where: { workspaceId_id: { workspaceId, id: domain!.id } },
        data: { appliesWhen },
      });

      const after = await fetchExport();
      expect(after.contentHash).not.toBe(before.contentHash);
      expect(after.content.tree.domains[0]?.appliesWhen).toEqual(appliesWhen);
      expect(after.content.tree.domains.slice(1).some((node) => 'appliesWhen' in node)).toBe(false);
      expect(after.content.tree.features.some((node) => 'appliesWhen' in node)).toBe(false);
      expect(after.content.items.map((item) => [item.id, item.version])).toEqual(
        before.content.items.map((item) => [item.id, item.version]),
      );
    });

    it('is readable by a plain member with the intent read permission', async () => {
      principal = { user: MEMBER, serviceToken: { permissions: [TokenPermission.IntentRead] } };
      const exported = await fetchExport();
      expect(exported.content.items.length).toBeGreaterThan(0);
      principal = { user: OWNER };
    });
  });
});

/**
 * AC-7 / BR-8, no database: an unconditioned workspace's export hash is pinned
 * to the literal origin/main's `hashExportContent` produced for this content
 * before dimensions existed. The branch's row mapping emits `dimensions` and
 * `appliesWhen` as `undefined` when empty; the canonical bytes must omit them.
 */
describe('intent export content hash (pre-dimensions regression)', () => {
  it('hashes an unconditioned export exactly as before the dimensions change', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const content: CloudIntentExportContent = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      tree: {
        domains: [
          {
            id: 'billing',
            title: 'Billing',
            statement: 'Invoices.',
            appliesWhen: undefined,
            archived: false,
            createdAt: at,
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
        features: [
          {
            id: 'invoices',
            domainId: 'billing',
            title: 'Invoices',
            statement: 'Issue invoices.',
            appliesWhen: undefined,
            archived: false,
            createdAt: at,
            updatedAt: at,
          },
        ],
        seeds: [{ featureId: 'invoices', repoKey: 'acme/api', nodeId: 'n1', note: null, createdAt: at }],
      },
      dimensions: undefined,
      items: [
        {
          id: 'br-invoice-total',
          kind: 'business_rule',
          domainId: 'billing',
          featureId: 'invoices',
          title: 'Invoice total',
          statement: 'An invoice total equals the sum of its lines.',
          payload: { condition: 'c', requiredOutcome: 'o', observer: 'obs' },
          appliesWhen: undefined,
          rationale: null,
          authority: 'accepted',
          proposedSuccessorOfId: null,
          supersededById: null,
          version: 2,
          createdAt: at,
          updatedAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      sources: [
        {
          itemId: 'br-invoice-total',
          kind: 'spec',
          ref: 'spec/billing',
          localId: 'BR-1',
          revision: null,
          locator: null,
          title: null,
          url: null,
        },
      ],
      anchors: [
        {
          source: 'manual',
          disabledAt: null,
          disabledBy: null,
          itemId: 'br-invoice-total',
          repoKey: 'acme/api',
          nodeId: 'n1',
          nodeType: 'Function',
          capturedVersionedId: 'v1',
          rationale: null,
          createdAt: at,
        },
      ],
      transitions: [
        {
          itemId: 'br-invoice-total',
          fromAuthority: 'candidate',
          toAuthority: 'accepted',
          actorId: 'u1',
          actorRole: 'owner',
          reason: 'approved',
          sourceKind: 'spec',
          sourceRef: 'spec/billing',
          sourceLocalId: 'BR-1',
          sourceRevision: null,
          workItem: null,
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ],
    };
    // Computed with origin/main's intent-export.operations.ts + core canonicalIntentJson.
    expect(hashExportContent(content)).toBe('b2994b3e9c69defbc49033b0cd9634714aaa65554a8c80d8dbbd5ffa0fe24d13');
  });
});
