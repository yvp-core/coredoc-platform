/**
 * Import and export end to end against real PostgreSQL and real guards
 * (spec §8.1, §9, §12, §14; issue 09 acceptance).
 *
 * WHY THIS SUITE EXISTS. Import's claims are all claims about ROWS — authority
 * preserved, a NULL-`from` transition per item, items on their domains, anchors
 * with their captured baseline, the ledger returning the stored result on a
 * retry. None of those can be proven against a mock. The export half is the
 * other side of the same claim: the round-trip criterion (§15) is that the
 * export REPRESENTS every imported fact, not that it round-trips byte-for-byte
 * into the local format, which it deliberately does not.
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
import 'dotenv/config';
import { createHash } from 'node:crypto';
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
import { IntentImportService } from './intent-import.service.js';
import { IntentWorkspaceImportService } from './intent-workspace-import.js';
import { IntentImportSkipReason, type CloudIntentImportResultV1 } from './intent-import.operations.js';

const TEST_DATABASE_URL = process.env.INTENT_TRANSFER_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };

/** Registered in the workspace, so anchors naming it import. */
const REGISTERED_REPO = 'github.com/acme/widgets';
/** Never registered, so anchors naming it are skipped and reported. */
const UNREGISTERED_REPO = 'github.com/acme/legacy-billing';

/**
 * A real `IntentFileV2`: three domains (one declared-but-unused, BR-19), five
 * accepted items and one candidate, anchors on both a registered and an
 * unregistered repository, a source carrying `revision` and `locator`, and six
 * generic relations that import must drop by name.
 */
const OVERLAY = {
  schemaVersion: 2,
  projectId: 'widget-shop',
  domains: [
    { id: 'ordering', title: 'Ordering', statement: 'Placing, accepting and refusing widget orders.' },
    { id: 'stock', title: 'Stock and warehouses' },
    { id: 'returns', title: 'Returns', statement: 'Declared for structure; no reviewed item lives here yet.' },
  ],
  items: [
    {
      id: 'cap-widget-ordering',
      kind: 'capability',
      domain: 'ordering',
      title: 'Widget ordering',
      statement: 'The product lets a store operator order widgets for one warehouse.',
      authority: 'accepted',
      sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
      payload: {
        outcome: 'A store operator can place a widget order and see its state',
        beneficiary: 'Store operator',
        boundary: 'Single warehouse; no cross-warehouse transfers',
      },
      codeAnchors: [
        {
          repo: REGISTERED_REPO,
          nodeId: 'aaaa:function:src/widgets/order.ts:placeOrder',
          nodeType: 'function',
          capturedVersionedId: 'aaaa:function:src/widgets/order.ts:placeOrder@1111',
          rationale: 'Entry point that performs the ordering outcome',
        },
      ],
    },
    {
      id: 'uc-place-widget-order',
      kind: 'use_case',
      domain: 'ordering',
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
      domain: 'ordering',
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
      domain: 'stock',
      title: 'Orders never exceed stock',
      statement: 'An order beyond available stock is refused.',
      authority: 'accepted',
      sources: [{ kind: 'issue', ref: 'tracker/WID-14', localId: 'BR-3' }],
      payload: {
        condition: 'An order requests more units than the warehouse holds',
        requiredOutcome: 'The order is refused and no stock is reserved',
        observer: 'Store operator',
      },
      codeAnchors: [
        {
          repo: REGISTERED_REPO,
          nodeId: 'aaaa:class:src/widgets/stock.ts:StockGuard',
          nodeType: 'class',
          capturedVersionedId: 'aaaa:class:src/widgets/stock.ts:StockGuard@2222',
          rationale: 'Holds the stock check that enforces the rule',
        },
        {
          repo: UNREGISTERED_REPO,
          nodeId: 'bbbb:function:src/billing/charge.ts:charge',
          nodeType: 'function',
          capturedVersionedId: 'bbbb:function:src/billing/charge.ts:charge@3333',
          rationale: 'Refund path that must not run for a refused order',
        },
      ],
    },
    {
      id: 'lim-single-warehouse-orders',
      kind: 'limitation',
      domain: 'ordering',
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
      domain: 'stock',
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
      codeAnchors: [
        {
          repo: UNREGISTERED_REPO,
          nodeId: 'bbbb:function:src/billing/reconcile.ts:reconcile',
          nodeType: 'function',
          capturedVersionedId: 'bbbb:function:src/billing/reconcile.ts:reconcile@4444',
          rationale: 'The path this decision chose against',
        },
      ],
    },
  ],
  relations: [
    { from: 'cap-widget-ordering', type: 'contains', to: 'uc-place-widget-order' },
    { from: 'uc-place-widget-order', type: 'contains', to: 'flow-order-submission' },
    { from: 'br-orders-never-exceed-stock', type: 'governs', to: 'flow-order-submission' },
    { from: 'lim-single-warehouse-orders', type: 'constrains', to: 'cap-widget-ordering' },
    { from: 'dec-refuse-over-stock-orders', type: 'decides', to: 'br-orders-never-exceed-stock' },
    { from: 'uc-place-widget-order', type: 'depends_on', to: 'cap-widget-ordering' },
  ],
};

const LOCAL_REVISION = createHash('sha256').update(canonicalIntentJson(OVERLAY)).digest('hex');

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

describe.skipIf(!TEST_DATABASE_URL)('intent import and export (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let principal: Principal;
  const workspaces: string[] = [];

  /** A fresh, EMPTY workspace with the registered repo identity import resolves anchors against. */
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

  const importBody = (idempotencyKey: string, overlay: unknown = OVERLAY, localRevision = LOCAL_REVISION) => ({
    idempotencyKey,
    localRevision,
    overlay,
  });

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
        IntentImportService,
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

  /* ------------------------------------------------------------- import --- */

  describe('import round trip', () => {
    let workspaceId: string;
    let result: CloudIntentImportResultV1;

    beforeAll(async () => {
      workspaceId = await freshWorkspace('roundtrip');
      principal = { user: OWNER };
      const response = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-roundtrip'))
        .expect(201);
      result = response.body as CloudIntentImportResultV1;
    });

    it('creates every declared domain, unused ones included (BR-19)', async () => {
      expect(result.createdDomains.map((domain) => domain.id)).toEqual(['ordering', 'stock', 'returns']);
      const rows = await prisma.intentDomain.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } });
      expect(rows.map((row) => row.id)).toEqual(['ordering', 'returns', 'stock']);
      // The overlay's optional statement becomes the empty string, not NULL and
      // not an invented sentence.
      expect(rows.find((row) => row.id === 'stock')?.statement).toBe('');
    });

    it("preserves each item's authority — the candidate stays a candidate", async () => {
      const rows = await prisma.intentItem.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } });
      expect(Object.fromEntries(rows.map((row) => [row.id, row.authority]))).toEqual({
        'br-orders-never-exceed-stock': 'accepted',
        'cap-widget-ordering': 'accepted',
        'dec-refuse-over-stock-orders': 'candidate',
        'flow-order-submission': 'accepted',
        'lim-single-warehouse-orders': 'accepted',
        'uc-place-widget-order': 'accepted',
      });
    });

    it('lands items on their domains, attached to no feature', async () => {
      const rows = await prisma.intentItem.findMany({ where: { workspaceId } });
      expect(rows.every((row) => row.featureId === null)).toBe(true);
      expect(rows.find((row) => row.id === 'br-orders-never-exceed-stock')?.domainId).toBe('stock');
      expect(rows.find((row) => row.id === 'cap-widget-ordering')?.domainId).toBe('ordering');
    });

    it('writes one NULL-from `import` transition per item, with the local revision and the token actor', async () => {
      const rows = await prisma.intentAuthorityTransition.findMany({
        where: { workspaceId },
        orderBy: { itemId: 'asc' },
      });
      expect(rows).toHaveLength(OVERLAY.items.length);
      for (const row of rows) {
        // NULL-from is the whole point: an import records arrival, it does not
        // fabricate a candidate→accepted decision nobody made (spec §4.7).
        expect(row.fromAuthority).toBeNull();
        expect(row.sourceKind).toBe('import');
        expect(row.sourceRevision).toBe(LOCAL_REVISION);
        expect(row.sourceRef).toBe('local-overlay/widget-shop');
        expect(row.actorId).toBe(OWNER.id);
        expect(row.actorRole).toBe('owner');
      }
      expect(rows.find((row) => row.itemId === 'dec-refuse-over-stock-orders')?.toAuthority).toBe('candidate');
      expect(rows.find((row) => row.itemId === 'cap-widget-ordering')?.toAuthority).toBe('accepted');
    });

    it('imports sources as-is, `locator` and `revision` preserved', async () => {
      const rows = await prisma.intentItemSource.findMany({ where: { workspaceId, itemId: 'uc-place-widget-order' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'spec',
        ref: 'spec/widget-ordering',
        localId: 'UC-1',
        revision: '2',
        locator: 'section-2',
      });
      expect(result.importedSourceCount).toBe(OVERLAY.items.length);
    });

    it('imports anchors verbatim for registered repo identities, baseline included', async () => {
      const rows = await prisma.intentAnchor.findMany({ where: { workspaceId }, orderBy: { itemId: 'asc' } });
      expect(rows.map((row) => row.itemId)).toEqual(['br-orders-never-exceed-stock', 'cap-widget-ordering']);
      expect(rows.every((row) => row.repoKey === REGISTERED_REPO)).toBe(true);
      expect(rows.find((row) => row.itemId === 'cap-widget-ordering')).toMatchObject({
        nodeType: 'function',
        capturedVersionedId: 'aaaa:function:src/widgets/order.ts:placeOrder@1111',
      });
      expect(result.importedAnchorCount).toBe(2);
    });

    it('reports skipped anchors by repo identity rather than dropping them silently', () => {
      expect(result.skippedAnchors).toEqual([
        {
          repo: UNREGISTERED_REPO,
          reason: IntentImportSkipReason.UnknownRepoKey,
          anchorCount: 2,
          itemIds: ['br-orders-never-exceed-stock', 'dec-refuse-over-stock-orders'],
        },
      ]);
      // And it says what WOULD have matched, so the fix is one round trip away.
      expect(result.registeredRepoIdentities).toEqual([`${REGISTERED_REPO} (widgets)`]);
    });

    it('names every dropped relation — the cloud model has none, so all of them', () => {
      expect(result.droppedRelations).toEqual(OVERLAY.relations);
    });

    it('returns the stored result on a retry with the same key, changing nothing', async () => {
      const before = {
        items: await prisma.intentItem.count({ where: { workspaceId } }),
        transitions: await prisma.intentAuthorityTransition.count({ where: { workspaceId } }),
        anchors: await prisma.intentAnchor.count({ where: { workspaceId } }),
        sources: await prisma.intentItemSource.count({ where: { workspaceId } }),
      };

      const replay = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-roundtrip'))
        .expect(201);

      // Byte-identical stored response, and no second import behind it. This is
      // what makes "rerun the same command" the cutover recovery.
      expect(canonicalIntentJson(replay.body)).toBe(canonicalIntentJson(result));
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(before.items);
      expect(await prisma.intentAuthorityTransition.count({ where: { workspaceId } })).toBe(before.transitions);
      expect(await prisma.intentAnchor.count({ where: { workspaceId } })).toBe(before.anchors);
      expect(await prisma.intentItemSource.count({ where: { workspaceId } })).toBe(before.sources);
    });

    it('refuses a SECOND import under a new key: the workspace is no longer empty', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-second-attempt'))
        .expect(409);
      const body = response.body as ErrorBody;
      expect(body.code).toBe(IntentErrorCode.WorkspaceNotEmpty);
      // The refusal lists what is in the way rather than just saying "no".
      expect(body.message).toContain('domains: 3');
      expect(body.message).toContain('items: 6');
    });
  });

  /* ------------------------------------------------------ large overlay --- */

  /**
   * A LEGAL overlay that is not small.
   *
   * The defect this proves fixed: every row was written with its own `await`
   * inside one `$transaction` carrying Prisma's DEFAULT 5s timeout. An overlay
   * of a few hundred items is thousands of round trips, so it aborted with
   * P2028 — and because the abort rolls back the LEDGER row too, the documented
   * recovery ("rerun the same request with the same idempotency key") replayed
   * into the identical timeout forever. Nothing about this overlay is near
   * core's ceiling (500 items); it simply is not tiny.
   *
   * The assertion is deliberately about COMMITTED ROWS rather than elapsed time:
   * a wall-clock bound would be flaky on a loaded machine, while "did every row
   * land" is exactly the claim that used to be false.
   */
  describe('a large but legal overlay commits in one transaction', () => {
    // Sized to sit just under the 100 KB body limit below: at roughly 520 bytes
    // of JSON per item, this is about 90 KB — the largest import that can
    // physically reach the service.
    const ITEMS = 175;
    const SOURCES_PER_ITEM = 1;
    const ANCHORS_PER_ITEM = 1;
    const DOMAINS = 5;

    /**
     * The REAL ceiling on an import is not core's 500-item limit — it is the
     * express body-parser default of 100 KB, which this endpoint does not
     * raise. An overlay bigger than that never reaches the service at all; it is
     * a 413. So the largest import that can actually run is a few hundred
     * modest items, which is what this fixture is, and the assertion below keeps
     * it that way rather than letting it drift into testing a 413.
     */
    const MAX_REQUEST_BYTES = 100 * 1024;

    const largeOverlay = {
      schemaVersion: 2,
      projectId: 'bulk-import',
      domains: Array.from({ length: DOMAINS }, (_, index) => ({
        id: `bulk-domain-${index}`,
        title: `Bulk domain ${index}`,
      })),
      items: Array.from({ length: ITEMS }, (_, index) => ({
        id: `cap-bulk-${index}`,
        kind: 'capability',
        domain: `bulk-domain-${index % DOMAINS}`,
        title: `Bulk capability ${index}`,
        statement: `Supports bulk capability ${index}.`,
        authority: index % 7 === 0 ? 'candidate' : 'accepted',
        sources: Array.from({ length: SOURCES_PER_ITEM }, (_, source) => ({
          kind: 'spec',
          ref: `spec/bulk-${index}`,
          localId: `CAP-${index}-${source}`,
        })),
        payload: { outcome: `Outcome ${index}`, beneficiary: 'An operator', boundary: 'One warehouse' },
        codeAnchors: Array.from({ length: ANCHORS_PER_ITEM }, (_, anchor) => ({
          repo: REGISTERED_REPO,
          nodeId: `a:function:src/bulk-${index}.ts:h${anchor}`,
          nodeType: 'function',
          capturedVersionedId: `a:function:src/bulk-${index}.ts:h${anchor}@1`,
          rationale: `Implements ${index}`,
        })),
      })),
      relations: [],
    };

    let workspaceId: string;
    let result: CloudIntentImportResultV1;

    beforeAll(async () => {
      workspaceId = await freshWorkspace('bulk');
      principal = { user: OWNER };
      const revision = createHash('sha256').update(canonicalIntentJson(largeOverlay)).digest('hex');
      const response = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-bulk', largeOverlay, revision))
        .expect(201);
      result = response.body as CloudIntentImportResultV1;
    }, 180_000);

    it('is a genuinely large request that still fits the body limit', () => {
      const bytes = Buffer.byteLength(JSON.stringify(importBody('key-bulk', largeOverlay)), 'utf8');
      expect(bytes).toBeLessThan(MAX_REQUEST_BYTES);
      // Big enough that the OLD per-row shape (four awaits per item plus an
      // audit insert — over a thousand round trips) could not finish inside
      // Prisma's default 5s transaction timeout.
      expect(bytes).toBeGreaterThan(50 * 1024);
      expect(largeOverlay.items).toHaveLength(ITEMS);
    });

    it('reports every item, source, and anchor as imported', () => {
      expect(result.importedItems).toHaveLength(ITEMS);
      expect(result.importedSourceCount).toBe(ITEMS * SOURCES_PER_ITEM);
      expect(result.importedAnchorCount).toBe(ITEMS * ANCHORS_PER_ITEM);
      expect(result.createdDomains).toHaveLength(DOMAINS);
      expect(result.skippedAnchors).toEqual([]);
    });

    it('COMMITTED every row — the transaction did not abort part-way', async () => {
      const [domains, items, sources, anchors, transitions] = await Promise.all([
        prisma.intentDomain.count({ where: { workspaceId } }),
        prisma.intentItem.count({ where: { workspaceId } }),
        prisma.intentItemSource.count({ where: { workspaceId } }),
        prisma.intentAnchor.count({ where: { workspaceId } }),
        prisma.intentAuthorityTransition.count({ where: { workspaceId } }),
      ]);
      expect({ domains, items, sources, anchors, transitions }).toEqual({
        domains: DOMAINS,
        items: ITEMS,
        sources: ITEMS * SOURCES_PER_ITEM,
        anchors: ITEMS * ANCHORS_PER_ITEM,
        // One NULL-`from` arrival transition per item (spec §4.7).
        transitions: ITEMS,
      });
    });

    it('wrote the ledger row, so the same key replays instead of re-importing', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-bulk', largeOverlay, result.localRevision))
        .expect(201);
      // The stored response, not a second import — and NOT the
      // `workspace_not_empty` refusal a missing ledger row would have produced.
      expect((response.body as CloudIntentImportResultV1).importedItems).toHaveLength(ITEMS);
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(ITEMS);
    }, 180_000);

    it('preserved authority per item rather than flattening the batch', async () => {
      const candidates = await prisma.intentItem.count({ where: { workspaceId, authority: 'candidate' } });
      expect(candidates).toBe(largeOverlay.items.filter((item) => item.authority === 'candidate').length);
      expect(candidates).toBeGreaterThan(0);
    });
  });

  /* ----------------------------------------------------------- refusals --- */

  describe('refusals', () => {
    let workspaceId: string;

    beforeAll(async () => {
      workspaceId = await freshWorkspace('refusals');
    });

    it('refuses an email-shaped string anywhere in the overlay, naming the exact path', async () => {
      principal = { user: OWNER };
      const poisoned = structuredClone(OVERLAY) as typeof OVERLAY;
      poisoned.items[1].payload = {
        ...poisoned.items[1].payload,
        primaryActor: 'Store operator (ops@widget-shop.example.com)',
      } as never;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-pii', poisoned))
        .expect(400);

      const body = response.body as ErrorBody;
      expect(body.code).toBe(IntentErrorCode.ContentEmailShaped);
      expect(body.path).toEqual(['overlay', 'items', '1', 'payload', 'primaryActor']);
      // Refused before anything was written.
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(0);
    });

    it('refuses an overlay core would reject, with overlay-relative paths', async () => {
      principal = { user: OWNER };
      const broken = structuredClone(OVERLAY) as typeof OVERLAY;
      broken.items[0].domain = 'not-a-declared-domain';

      const response = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-invalid-overlay', broken))
        .expect(400);

      const body = response.body as ErrorBody;
      expect(body.code).toBe(IntentErrorCode.ImportOverlayInvalid);
      expect(body.path[0]).toBe('overlay');
      expect(body.path).toContain('domain');
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(0);
    });

    it('refuses a rule variant conditioned on a dimension: an empty workspace declares none (LIM-1)', async () => {
      principal = { user: OWNER };
      const conditioned = structuredClone(OVERLAY) as typeof OVERLAY;
      conditioned.items[3].payload = {
        ...conditioned.items[3].payload,
        variants: [{ when: { country: 'de' }, outcome: '40h' }, { outcome: 'contract hours' }],
      } as never;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-variant-when', conditioned))
        .expect(400);

      const body = response.body as ErrorBody;
      expect(body.code).toBe(IntentErrorCode.DimensionNotFound);
      expect(body.message).toContain(conditioned.items[3].id);
      expect(body.path).toEqual(['overlay', 'items', '3', 'payload', 'variants', '0', 'when']);
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(0);
    });

    it('refuses a service token: import lands accepted items, so it needs a user session', async () => {
      principal = { user: OWNER, serviceToken: { permissions: [TokenPermission.IntentRead] } };
      await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-service-token'))
        .expect(403);
      principal = { user: OWNER };
      expect(await prisma.intentItem.count({ where: { workspaceId } })).toBe(0);
    });
  });

  it('refuses import into a workspace that holds only dimensions, and the preflight agrees', async () => {
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

    const preflight = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspaceId}/intent/import/preflight`)
      .expect(200);
    expect(preflight.body).toMatchObject({ empty: false, content: { dimensions: 1 } });
    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
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
        .post(`/api/v1/workspaces/${workspaceId}/intent/import`)
        .send(importBody('key-export-seed'))
        .expect(201);
    });

    it('represents every imported fact (spec §15 round-trip criterion)', async () => {
      principal = { user: OWNER };
      const exported = await fetchExport();

      expect(exported.formatVersion).toBe(1);
      expect(exported.content.workspaceId).toBe(workspaceId);
      expect(exported.content.tree.domains.map((domain) => domain.id)).toEqual(['ordering', 'returns', 'stock']);
      expect(exported.content.items.map((item) => item.id)).toEqual(OVERLAY.items.map((item) => item.id).sort());
      expect(exported.content.items.find((item) => item.id === 'dec-refuse-over-stock-orders')?.authority).toBe(
        'candidate',
      );
      expect(exported.content.sources).toHaveLength(OVERLAY.items.length);
      expect(exported.content.sources.find((source) => source.itemId === 'uc-place-widget-order')).toMatchObject({
        locator: 'section-2',
        revision: '2',
      });
      expect(exported.content.anchors).toHaveLength(2);
      expect(exported.content.transitions).toHaveLength(OVERLAY.items.length);
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
