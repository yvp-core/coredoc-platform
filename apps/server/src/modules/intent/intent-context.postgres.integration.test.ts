/**
 * The context read end to end: real PostgreSQL (trigram indexes included), real
 * guards, a real Ladybug snapshot (spec §7, §6.2, §6.3, issue 07 acceptance).
 *
 * WHY THIS SUITE EXISTS. `intent-context.select.test.ts` proves what the ported
 * semantics ARE; this one proves the SQL implements them over rows — which is a
 * different claim, and the one that can regress silently when a predicate moves.
 * The selector matrix here is the one `packages/core/src/intent/query.test.ts`
 * holds for the local overlay: authority filtering, exact-id precedence and its
 * exclusive path to rejected/superseded, conjunctive-then-disjunctive lexical
 * matching, the enclosing-anchor rule, present-but-empty selectors, and
 * error-not-empty for an undeclared filter value.
 *
 * Only `AuthGuard` is stubbed — the token→principal step, which has no issuer in
 * this process. `WorkspaceRoleGuard` and `PermissionsGuard` are REAL, so "a
 * service token with intent:read may read" is proven through the production code
 * path. The snapshot LEASE is stubbed (there is no R2 here); the repository
 * behind it is a real graph file.
 *
 * Pool `forks` + `--no-file-parallelism` (see `scripts/test-postgres-integration.sh`):
 * the Ladybug native module.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import { Test } from '@nestjs/testing';
import { IntentKind, NodeType } from '@coredoc/core';
import { AnchorStatus, SnapshotFreshness } from '@coredoc/db';
import {
  buildIntentGraphFixture,
  openIntentGraphFixture,
  type IntentGraphFixture,
  type OpenedIntentGraphFixture,
} from '@coredoc/db/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { ControlPlaneService, type WorkspaceRepo } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { McpAuthKind } from '../../mcp/mcp-auth-context.js';
import { IntentTools } from '../../mcp/tools/intent.tools.js';
import { WorkspaceGraphContextError, WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { IntentMatchReason } from './derivation/derivation-contract.js';
import { IntentDerivationService } from './derivation/intent-derivation.service.js';
import { IntentContextController } from './intent-context.controller.js';
import {
  INTENT_CONTEXT_READ_LIMITS,
  IntentContextMatchReason,
  IntentContextMode,
} from './intent-context.operations.js';
import { IntentContextService } from './intent-context.service.js';
import { IntentItemService } from './intent-item.service.js';
import { IntentProposeService } from './intent-propose.service.js';
import type { ListIntentItemsQuery } from './intent-module-operations.js';
import { IntentErrorCode, IntentPublicException, parseContract, ProposeIntentItemsSchema } from './contract/index.js';

const TEST_DATABASE_URL = process.env.INTENT_CONTEXT_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };

const REPO_KEY_A = 'github.com/acme/orders-api';
const REPO_KEY_B = 'github.com/acme/reports-web';
const HASH_A = graphRepoHashOf(REPO_KEY_A);
const HASH_B = graphRepoHashOf(REPO_KEY_B);
const PUSHED_AT = new Date('2026-08-30T10:00:00.000Z');
const VERSION_ID = 'v-context-suite';

interface Principal {
  user: { id: string; email: string };
  serviceToken?: { permissions: string[] };
}

interface ContextMatch {
  id: string;
  matchReason: IntentContextMatchReason;
  derivedReasons?: IntentMatchReason[];
  version: number;
  statement?: string;
  anchors?: Array<{ nodeId: string; status?: AnchorStatus; snapshotFreshness?: SnapshotFreshness }>;
}

describe.skipIf(!TEST_DATABASE_URL)('intent context read (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let principal: Principal;
  let directory: string;
  let fixture: IntentGraphFixture;
  let opened: OpenedIntentGraphFixture;
  let repos: WorkspaceRepo[];
  let derivation: IntentDerivationService;
  let contextService: IntentContextService;
  /** Set to make the stubbed lease fail, for the §6.3 degradation case. */
  let leaseError: unknown;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    directory = mkdtempSync(join(tmpdir(), 'coredoc-context-pg-'));
    // The hashes must be the ones the durable keys produce: `workspace_repos`
    // refuses any other pairing, and the graph filter reads the same column.
    fixture = await buildIntentGraphFixture(join(directory, 'graph.ladybug'), {
      repoKeys: { a: REPO_KEY_A, b: REPO_KEY_B },
    });
    opened = await openIntentGraphFixture(fixture.path, { readOnly: true });

    const workspace = await prisma.workspace.create({
      data: { name: `intent-ctx-${RUN}`, slug: `intent-ctx-${RUN}`, intentEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: OWNER.id, email: OWNER.email, role: 'owner' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    await prisma.workspaceRepo.createMany({
      data: [
        { workspaceId, repoKey: HASH_A, repoName: 'orders-api', intentRepoKey: REPO_KEY_A, lastPushedAt: PUSHED_AT },
        { workspaceId, repoKey: HASH_B, repoName: 'reports-web', intentRepoKey: REPO_KEY_B },
      ],
    });
    repos = (await prisma.workspaceRepo.findMany({ where: { workspaceId } })) as unknown as WorkspaceRepo[];

    await prisma.intentDomain.createMany({
      data: [
        {
          workspaceId,
          id: 'ordering',
          title: 'Ordering',
          statement: 'Baskets, checkout and refunds.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
        {
          workspaceId,
          id: 'security',
          title: 'Security',
          statement: 'Who may do what.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      ],
    });
    await prisma.intentFeature.createMany({
      data: [
        {
          workspaceId,
          id: 'checkout',
          domainId: 'ordering',
          title: 'Checkout',
          statement: 'Paying for a basket.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
        {
          workspaceId,
          id: 'reporting',
          domainId: 'ordering',
          title: 'Reporting',
          statement: 'Order reports.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      ],
    });
    // The seeded area: everything the app package contains, plus its one-hop
    // callees. It is what makes a node query reach the feature's own items.
    await prisma.intentFeatureSeed.create({
      data: {
        workspaceId,
        featureId: 'checkout',
        repoKey: REPO_KEY_A,
        nodeId: fixture.repoA.appPackage,
        createdBy: OWNER.id,
      },
    });

    const author = { createdBy: OWNER.id, updatedBy: OWNER.id };
    await prisma.intentItem.createMany({
      data: [
        {
          workspaceId,
          id: 'cap-checkout',
          kind: IntentKind.Capability,
          domainId: 'ordering',
          featureId: 'checkout',
          title: 'Checkout',
          statement: 'A customer can pay for a basket of goods.',
          authority: 'accepted',
          ...author,
        },
        {
          workspaceId,
          id: 'br-refund-window',
          kind: IntentKind.BusinessRule,
          domainId: 'ordering',
          featureId: 'checkout',
          title: 'Refund window',
          statement: 'Refunds are accepted within thirty days of delivery.',
          rationale: 'Finance sets the window.',
          authority: 'accepted',
          ...author,
        },
        {
          workspaceId,
          id: 'br-admin-only',
          kind: IntentKind.BusinessRule,
          domainId: 'security',
          title: 'Admin only',
          statement: 'Only an administrator may override a refund.',
          authority: 'accepted',
          ...author,
        },
        {
          // Product root: attached to neither a domain nor a feature.
          workspaceId,
          id: 'uc-warehouse-limit',
          kind: IntentKind.UseCase,
          title: 'Warehouse capacity',
          statement: 'An operator sees the warehouse stock limit for a product.',
          authority: 'accepted',
          ...author,
        },
        {
          workspaceId,
          id: 'lim-legacy-export',
          kind: IntentKind.Limitation,
          domainId: 'ordering',
          title: 'Legacy export',
          statement: 'The legacy stock export is not supported.',
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
          ...author,
        },
      ],
    });
    // Superseded LAST: the pointer target has to exist first.
    await prisma.intentItem.create({
      data: {
        workspaceId,
        id: 'br-old-refund',
        kind: IntentKind.BusinessRule,
        domainId: 'ordering',
        title: 'Old refund rule',
        statement: 'Refunds were accepted within seven days of delivery.',
        authority: 'superseded',
        supersededById: 'br-refund-window',
        ...author,
      },
    });
    await prisma.intentAnchor.createMany({
      data: [
        {
          workspaceId,
          itemId: 'br-admin-only',
          repoKey: REPO_KEY_A,
          nodeId: fixture.repoA.guard,
          nodeType: NodeType.Function,
          capturedVersionedId: fixture.versionedIds[fixture.repoA.guard] as string,
          createdBy: OWNER.id,
        },
        {
          workspaceId,
          itemId: 'br-refund-window',
          repoKey: REPO_KEY_A,
          nodeId: fixture.repoA.handler,
          nodeType: NodeType.Function,
          capturedVersionedId: fixture.versionedIds[fixture.repoA.handler] as string,
          createdBy: OWNER.id,
        },
        {
          workspaceId,
          itemId: 'uc-warehouse-limit',
          repoKey: REPO_KEY_A,
          nodeId: fixture.repoA.guardsFile,
          nodeType: NodeType.File,
          capturedVersionedId: fixture.versionedIds[fixture.repoA.guardsFile] as string,
          createdBy: OWNER.id,
        },
      ],
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentContextController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        IntentDerivationService,
        IntentContextService,
        {
          provide: WorkspaceMcpContextService,
          useValue: {
            async withContextByWorkspaceId(_workspaceId: string, callback: (context: never) => Promise<unknown>) {
              if (leaseError) throw leaseError;
              return callback({
                repository: opened.repository,
                scope: {},
                repos,
                versionId: VERSION_ID,
                graphBackend: 'file_snapshot',
              } as never);
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

    derivation = moduleRef.get(IntentDerivationService);
    contextService = moduleRef.get(IntentContextService);
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await opened?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    if (workspaceId) {
      await prisma.intentAnchor.deleteMany({ where: { workspaceId } });
      await prisma.intentItem.updateMany({ where: { workspaceId }, data: { supersededById: null } });
      await prisma.intentItem.deleteMany({ where: { workspaceId } });
      await prisma.intentFeatureSeed.deleteMany({ where: { workspaceId } });
      await prisma.intentFeature.deleteMany({ where: { workspaceId } });
      await prisma.intentDomain.deleteMany({ where: { workspaceId } });
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(() => {
    principal = { user: OWNER };
    leaseError = undefined;
  });

  function contextUrl() {
    return `/api/v1/workspaces/${workspaceId}/intent/context`;
  }

  async function read(query: Record<string, unknown>, status = 200) {
    const response = await request(app.getHttpServer()).get(contextUrl()).query(query);
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return response.body;
  }

  const idsOf = (body: { matches: ContextMatch[] }) => body.matches.map((match) => match.id);
  const reasonOf = (body: { matches: ContextMatch[] }, id: string) =>
    body.matches.find((match) => match.id === id)?.matchReason;

  describe('task context fusion', () => {
    it('keeps exact and anchored rules while excluding weak task-only matches', async () => {
      const rows = [
        { id: 'br-precision-title', title: 'Settlement exports', statement: 'Exports require approval.' },
        { id: 'br-precision-statement', title: 'Ledger rule', statement: 'Settlement exports require approval.' },
        { id: 'br-precision-weak', title: 'Inventory rotation', statement: 'Exports run every night.' },
        {
          id: 'br-precision-rationale',
          title: 'Account creation',
          statement: 'Accounts require an email.',
          rationale: 'Settlement exports motivated this decision.',
        },
      ];
      await prisma.intentItem.createMany({
        data: rows.map((row) => ({
          ...row,
          workspaceId,
          domainId: 'security',
          kind: 'business_rule' as const,
          authority: 'accepted' as const,
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        })),
      });
      try {
        const body = await read({
          task: 'Optimize settlement exports',
          intentIds: ['br-precision-rationale', 'br-old-refund'],
          nodeIds: [fixture.repoA.guard],
          limit: '20',
        });
        expect(idsOf(body).slice(0, 2)).toEqual(['br-precision-rationale', 'br-old-refund']);
        expect(idsOf(body)).toEqual(
          expect.arrayContaining(['br-admin-only', 'br-precision-title', 'br-precision-statement']),
        );
        expect(idsOf(body)).not.toContain('br-precision-weak');
        const lexical = await read({ task: 'Optimize settlement exports', limit: '20' });
        expect(idsOf(lexical)).not.toContain('br-precision-rationale');
        const single = await read({ task: 'exporting', limit: '20' });
        expect(idsOf(single)).toContain('br-precision-weak');
      } finally {
        await prisma.intentItem.deleteMany({ where: { workspaceId, id: { in: rows.map((row) => row.id) } } });
      }
    });

    it('counts shared statement lexemes without stemming them twice', async () => {
      const rows = [
        { id: 'br-precision-license', title: 'Spend rules', statement: 'License expenses above budget need approval.' },
        { id: 'br-precision-license-weak', title: 'Key rotation', statement: 'License keys rotate yearly.' },
      ];
      await prisma.intentItem.createMany({
        data: rows.map((row) => ({
          ...row,
          workspaceId,
          domainId: 'security',
          kind: 'business_rule' as const,
          authority: 'accepted' as const,
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        })),
      });
      try {
        const body = await read({ task: 'change license expense policy', limit: '20' });
        expect(idsOf(body)).toContain('br-precision-license');
        expect(idsOf(body)).not.toContain('br-precision-license-weak');
      } finally {
        await prisma.intentItem.deleteMany({ where: { workspaceId, id: { in: rows.map((row) => row.id) } } });
      }
    });

    it('finds an unanchored rule from a code identifier in the task', async () => {
      const id = 'br-settlement-amount';
      await prisma.intentItem.create({
        data: {
          workspaceId,
          id,
          kind: IntentKind.BusinessRule,
          authority: 'accepted',
          title: 'Settlement amount',
          statement: 'Settlement amount excludes cancelled shipments.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      });
      try {
        const body = await read({ task: 'Optimize calculateSettlementAmount without changing behavior.', limit: '10' });
        expect(idsOf(body)).toContain(id);
        expect(body.matches.find((item: ContextMatch) => item.id === id).anchors).toEqual([]);
      } finally {
        await prisma.intentItem.delete({ where: { workspaceId_id: { workspaceId, id } } });
      }
    });

    it('uses a changed filename to discover an unanchored rule before that file is in the graph', async () => {
      const id = 'br-charge-authorization';
      await prisma.intentItem.create({
        data: {
          workspaceId,
          id,
          kind: IntentKind.BusinessRule,
          authority: 'accepted',
          title: 'Charge authorization',
          statement: 'Charge authorization requires an operator review.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      });
      try {
        const body = await read({
          task: 'Optimize the new helper without changing behavior.',
          files: JSON.stringify({ repoKey: REPO_KEY_A, path: 'src/billing/charge-authorization.ts' }),
          limit: '10',
        });
        expect(idsOf(body)).toContain(id);
        expect(body.matches.find((item: ContextMatch) => item.id === id).anchors).toEqual([]);
        // unresolvedNodeIds reports unregistered repo hashes, not absent nodes in a registered repo.
        expect(Object.values(fixture.repoA)).not.toContain(`${HASH_A}:file:src/billing/charge-authorization.ts`);
      } finally {
        await prisma.intentItem.delete({ where: { workspaceId_id: { workspaceId, id } } });
      }
    });

    it('returns code constraints and an unanchored text rule in one call, without an index walk', async () => {
      await prisma.intentItem.create({
        data: {
          workspaceId,
          id: 'br-warehouse-visibility',
          kind: 'business_rule',
          authority: 'accepted',
          domainId: 'security',
          title: 'Warehouse visibility',
          statement: 'An operator sees warehouse capacity.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      });
      try {
        const body = await read({
          task: 'Show warehouse visibility to the operator while updating the guard.',
          nodeIds: [fixture.repoA.guard],
          intentIds: ['br-old-refund'],
          limit: '10',
        });
        expect(idsOf(body)[0]).toBe('br-old-refund');
        expect(idsOf(body)).toEqual(expect.arrayContaining(['br-admin-only', 'br-warehouse-visibility']));
        expect(new Set(idsOf(body)).size).toBe(body.matches.length);
        expect(idsOf(body)).not.toContain('br-rejected-idea');
        expect(reasonOf(body, 'br-warehouse-visibility')).toBe(IntentContextMatchReason.Text);
      } finally {
        await prisma.intentItem.delete({ where: { workspaceId_id: { workspaceId, id: 'br-warehouse-visibility' } } });
      }
    });

    it('accepts files from the diff without locally constructed graph ids', async () => {
      const body = await read({
        task: 'Change refund handling',
        files: JSON.stringify({ repoKey: REPO_KEY_A, path: fixture.repoA.handler.split(':')[2] }),
        limit: '10',
      });
      expect(idsOf(body)).toContain('br-refund-window');
      expect(body.unresolvedFiles).toEqual([]);
    });

    it('keeps lexical rules when the repository or graph is unavailable', async () => {
      leaseError = new WorkspaceGraphContextError('ACTIVE_VERSION_MISSING', 'no active graph version');
      const file = { repoKey: 'github.com/acme/unpublished', path: 'src/new.ts' };
      const body = await read({ task: 'warehouse capacity', files: JSON.stringify(file) });
      expect(idsOf(body)).toContain('uc-warehouse-limit');
      expect(body.unresolvedFiles).toEqual([file]);
      expect(body.evidence.available).toBe(false);
    });

    it('keeps predeclared rules under 3300 irrelevant and similar out-of-domain items', async () => {
      const input = {
        task: 'Change refund window without bypassing the administrator guard',
        domain: 'ordering',
        nodeIds: [fixture.repoA.handler],
        limit: '10',
      };
      const critical = ['br-refund-window', 'cap-checkout', 'br-admin-only'];
      const baseline = await read(input);
      expect(idsOf(baseline)).toEqual(expect.arrayContaining(critical));
      await prisma.intentItem.createMany({
        data: Array.from({ length: 3300 }, (_, n) => ({
          workspaceId,
          id: `br-task-noise-${n}`,
          kind: 'business_rule' as const,
          authority: 'accepted' as const,
          domainId: 'security',
          title: n < 300 ? 'Refund window for unrelated billing' : 'Unrelated inventory rotation',
          statement: n < 300 ? 'Billing refund window administrator guard.' : 'Inventory rotates every week.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        })),
      });
      try {
        const start = performance.now();
        const scaled = await read(input);
        expect(idsOf(scaled)).toEqual(idsOf(baseline));
        expect(idsOf(scaled)).toEqual(expect.arrayContaining(critical));
        expect(JSON.stringify(scaled).length).toBeLessThan(24000);
        expect(performance.now() - start).toBeLessThan(2000);
      } finally {
        await prisma.intentItem.deleteMany({ where: { workspaceId, id: { startsWith: 'br-task-noise-' } } });
      }
    });
  });

  /* ------------------------------------------------------- authority --- */

  describe('authority filtering', () => {
    it('returns the accepted set with no selector, and never a candidate', async () => {
      const body = await read({ limit: '20' });
      expect(idsOf(body).sort()).toEqual(['br-admin-only', 'br-refund-window', 'cap-checkout', 'uc-warehouse-limit']);
      expect(body.matches.every((match: ContextMatch) => match.matchReason === IntentContextMatchReason.Default)).toBe(
        true,
      );
    });

    it('includes candidates only on explicit opt-in, after the accepted ones', async () => {
      const body = await read({ limit: '20', includeCandidates: 'true' });
      expect(idsOf(body)).toContain('lim-legacy-export');
      expect(idsOf(body).indexOf('lim-legacy-export')).toBe(body.matches.length - 1);
    });

    it('never surfaces a rejected or superseded item through text or node matching', async () => {
      const text = await read({ query: 'refunds', limit: '20', includeCandidates: 'true' });
      expect(idsOf(text)).not.toContain('br-old-refund');
      expect(idsOf(text)).not.toContain('br-rejected-idea');
    });
  });

  /* --------------------------------------------------------- exact ids --- */

  describe('exact ids', () => {
    it('is the only path to a rejected or superseded item, in the order asked for', async () => {
      const body = await read({ intentIds: 'br-rejected-idea,br-old-refund' });
      expect(idsOf(body)).toEqual(['br-rejected-idea', 'br-old-refund']);
      expect(body.matches.every((match: ContextMatch) => match.matchReason === IntentContextMatchReason.ExactId)).toBe(
        true,
      );
    });

    it('reports an id this workspace does not hold as a miss, not an error', async () => {
      const body = await read({ intentIds: ['br-admin-only', 'ghost-item'] });
      expect(idsOf(body)).toEqual(['br-admin-only']);
      expect(body.unknownIntentIds).toEqual(['ghost-item']);
    });

    it('is exempt from the tree scope and the kind filter — a routed lookup stays authoritative', async () => {
      const body = await read({ intentIds: 'br-admin-only', domain: 'ordering', kind: IntentKind.Capability });
      expect(idsOf(body)).toContain('br-admin-only');
    });

    it('orders exact ids before discovered matches', async () => {
      const body = await read({ intentIds: 'uc-warehouse-limit', query: 'refund', limit: '20' });
      expect(idsOf(body)[0]).toBe('uc-warehouse-limit');
      expect(reasonOf(body, 'br-refund-window')).toBe(IntentContextMatchReason.Text);
    });

    it('returns nothing for a present-but-empty id selector', async () => {
      const body = await read({ intentIds: '' });
      expect(body.matches).toEqual([]);
    });
  });

  describe('kind filter', () => {
    it('narrows discovery to any of several kinds, repeated or comma-separated, in both modes', async () => {
      const kinds = [IntentKind.Capability, IntentKind.UseCase];
      for (const kind of [kinds, kinds.join(',')]) {
        const context = await read({ kind });
        const list = await read({ mode: IntentContextMode.List, kind });
        for (const rows of [context.matches, list.entries] as { id: string; kind: IntentKind }[][]) {
          expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(['cap-checkout', 'uc-warehouse-limit']));
          expect(rows.every((row) => kinds.includes(row.kind))).toBe(true);
        }
      }
    });
  });

  describe('source refs', () => {
    beforeAll(async () => {
      await prisma.intentItemSource.createMany({
        data: [
          { workspaceId, itemId: 'cap-checkout', kind: 'issue', ref: 'jira:DAY-1', localId: 'UC-1' },
          { workspaceId, itemId: 'lim-legacy-export', kind: 'issue', ref: 'jira:DAY-1', localId: 'LIM-1' },
          { workspaceId, itemId: 'br-admin-only', kind: 'issue', ref: 'jira:DAY-2', localId: 'BR-1' },
          { workspaceId, itemId: 'br-rejected-idea', kind: 'issue', ref: 'jira:DAY-1', localId: 'BR-9' },
          { workspaceId, itemId: 'br-refund-window', kind: 'spec', ref: 'spec/Ordering.md', localId: 'BR-2' },
          // A non-issue source whose ref merely looks like a Jira key never folds case.
          { workspaceId, itemId: 'br-refund-window', kind: 'spec', ref: 'jira:DAY-3', localId: 'BR-3' },
        ],
      });
    });

    afterAll(async () => {
      // Only the rows this block added: the fixture's own sources stay for later tests.
      await prisma.intentItemSource.deleteMany({
        where: { workspaceId, ref: { in: ['jira:DAY-1', 'jira:DAY-2', 'jira:DAY-3', 'spec/Ordering.md'] } },
      });
    });

    it('folds case only for issue-kind sources', async () => {
      expect(idsOf(await read({ sourceRefs: 'jira:day-3' }))).toEqual([]);
    });

    it('returns only the accepted items sourced at the ref by default, with reason source (AC-1)', async () => {
      const body = await read({ sourceRefs: 'jira:DAY-1' });
      expect(idsOf(body)).toEqual(['cap-checkout']);
      expect(reasonOf(body, 'cap-checkout')).toBe(IntentContextMatchReason.Source);
    });

    it('adds the candidate on includeCandidates and never reaches a rejected item (AC-1)', async () => {
      const body = await read({ sourceRefs: 'jira:DAY-1', includeCandidates: 'true' });
      expect(idsOf(body)).toEqual(['cap-checkout', 'lim-legacy-export']);
      const list = await read({ mode: 'list', sourceRefs: 'jira:DAY-1', includeCandidates: 'true' });
      expect(list.entries.map((entry: { id: string }) => entry.id)).toEqual(['cap-checkout', 'lim-legacy-export']);
      expect(list.entries.every((entry: ContextMatch) => entry.matchReason === IntentContextMatchReason.Source)).toBe(
        true,
      );
    });

    it('compares a jira key case-insensitively and any other ref exactly (AC-2)', async () => {
      expect(idsOf(await read({ sourceRefs: 'jira:day-1' }))).toEqual(['cap-checkout']);
      expect(idsOf(await read({ sourceRefs: 'JIRA:DAY-2' }))).toEqual(['br-admin-only']);
      expect(idsOf(await read({ sourceRefs: ['jira:DAY-2', 'spec/Ordering.md'] })).sort()).toEqual([
        'br-admin-only',
        'br-refund-window',
      ]);
      expect(idsOf(await read({ sourceRefs: 'spec/ordering.md' }))).toEqual([]);
    });

    it('adds the sourced items beside other selectors, and a present-but-empty value selects nothing', async () => {
      // A union, like exact ids: the whole story's intent plus what the query finds.
      const both = await read({ sourceRefs: 'jira:DAY-1', query: 'administrator' });
      expect(idsOf(both)).toEqual(expect.arrayContaining(['cap-checkout', 'br-admin-only']));
      expect(reasonOf(both, 'cap-checkout')).toBe(IntentContextMatchReason.Source);
      expect(idsOf(await read({ sourceRefs: 'jira:DAY-2', intentIds: 'uc-warehouse-limit' }))).toEqual([
        'uc-warehouse-limit',
        'br-admin-only',
      ]);
      expect((await read({ sourceRefs: '' })).matches).toEqual([]);
    });
  });

  /* ----------------------------------------------------------- lexical --- */

  describe('lexical selection (pg_trgm)', () => {
    it('matches case-insensitively across title, statement and rationale', async () => {
      expect(idsOf(await read({ query: 'REFUND', limit: '20' })).sort()).toEqual(['br-admin-only', 'br-refund-window']);
      expect(idsOf(await read({ query: 'finance', limit: '20' }))).toEqual(['br-refund-window']);
    });

    it('matches a partial word — the trigram index, not a stemmer', async () => {
      expect(idsOf(await read({ query: 'refun', limit: '20' })).sort()).toEqual(['br-admin-only', 'br-refund-window']);
    });

    it('requires every token while the conjunction matches something', async () => {
      // Both items carry "refund"; only one carries the second token, and the
      // conjunction is not diluted by the other.
      expect(idsOf(await read({ query: 'refund thirty', limit: '20' }))).toEqual(['br-refund-window']);
      expect(idsOf(await read({ query: 'refund administrator', limit: '20' }))).toEqual(['br-admin-only']);
    });

    it('falls back to any-token matching, ranked by hit count, only from an EMPTY conjunction', async () => {
      const body = await read({ query: 'warehouse stock shortfall', limit: '20', includeCandidates: 'true' });
      // `uc-warehouse-limit` hits two tokens, the candidate hits one.
      expect(idsOf(body)).toEqual(['uc-warehouse-limit', 'lim-legacy-export']);
      expect(body.matches.every((match: ContextMatch) => match.matchReason === IntentContextMatchReason.Text)).toBe(
        true,
      );
    });

    it('leaves a single-word query untouched: there is nothing to fall back to', async () => {
      expect(idsOf(await read({ query: 'shortfall', limit: '20' }))).toEqual([]);
    });

    it('does not let a wildcard in the token widen the query', async () => {
      expect(idsOf(await read({ query: '%', limit: '20' }))).toEqual([]);
    });

    it('composes conjunctively with the tree scope and the kind filter', async () => {
      expect(idsOf(await read({ query: 'refund', domain: 'security', limit: '20' }))).toEqual(['br-admin-only']);
      expect(idsOf(await read({ query: 'refund', kind: IntentKind.Capability, limit: '20' }))).toEqual([]);
    });
  });

  /* -------------------------------------------------------- tree scope --- */

  describe('tree scope', () => {
    it('reaches a feature s own items, its domain s, and the product root s', async () => {
      const body = await read({ feature: 'checkout', limit: '20' });
      expect(idsOf(body).sort()).toEqual(['br-refund-window', 'cap-checkout', 'uc-warehouse-limit']);
      expect(reasonOf(body, 'cap-checkout')).toBe(IntentContextMatchReason.Attached);
      expect(reasonOf(body, 'uc-warehouse-limit')).toBe(IntentContextMatchReason.Inherited);
      // Another domain's branch never leaks sideways.
      expect(idsOf(body)).not.toContain('br-admin-only');
    });

    it('reaches a domain s own branch plus the product root', async () => {
      const body = await read({ domain: 'security', limit: '20' });
      expect(idsOf(body).sort()).toEqual(['br-admin-only', 'uc-warehouse-limit']);
      expect(reasonOf(body, 'br-admin-only')).toBe(IntentContextMatchReason.Attached);
      expect(reasonOf(body, 'uc-warehouse-limit')).toBe(IntentContextMatchReason.Inherited);
    });

    it('filters by kind conjunctively', async () => {
      expect(idsOf(await read({ kind: IntentKind.BusinessRule, limit: '20' })).sort()).toEqual([
        'br-admin-only',
        'br-refund-window',
      ]);
    });
  });

  /* --------------------------------------------------- error-not-empty --- */

  describe('a filter naming a value this workspace does not declare is an ERROR', () => {
    it('refuses an undeclared domain, naming the declared ones', async () => {
      const body = await read({ domain: 'payments' }, 400);
      expect(body.code).toBe(IntentErrorCode.DomainNotFound);
      expect(body.message).toContain('ordering');
      expect(body.message).toContain('security');
    });

    it('refuses an undeclared feature, naming the declared ones', async () => {
      const body = await read({ feature: 'invoicing' }, 400);
      expect(body.code).toBe(IntentErrorCode.FeatureNotFound);
      expect(body.message).toContain('checkout');
    });

    it('refuses a feature that is not in the domain the same request names', async () => {
      const body = await read({ feature: 'checkout', domain: 'security' }, 400);
      expect(body.code).toBe(IntentErrorCode.FeatureNotFound);
    });

    it('refuses an unknown kind, naming the six valid ones', async () => {
      const body = await read({ kind: 'rules' }, 400);
      expect(body.code).toBe(IntentErrorCode.UnknownKind);
      expect(body.message).toContain(IntentKind.BusinessRule);
    });

    it('returns an empty answer — not an error — for a declared value nobody used', async () => {
      const body = await read({ feature: 'reporting', kind: IntentKind.Flow, limit: '20' });
      expect(body.matches).toEqual([]);
    });
  });

  /* ---------------------------------------------------------- node ids --- */

  describe('node id selection', () => {
    it('bounds the UNION of anchored and attached candidates and reports the cut', async () => {
      const anchored = Array.from({ length: 120 }, (_, n) => `br-bound-anchor-${n}`);
      const attached = Array.from({ length: 120 }, (_, n) => `br-bound-attached-${n}`);
      const ids = [...anchored, ...attached];
      const spy = vi.spyOn(derivation, 'deriveNodeContext');
      try {
        await prisma.intentItem.createMany({
          data: ids.map((id, n) => ({
            workspaceId,
            id,
            kind: 'business_rule',
            authority: 'accepted',
            title: id,
            statement: 'Bound fixture.',
            domainId: n < 120 ? 'security' : 'ordering',
            featureId: n < 120 ? null : 'checkout',
            createdBy: OWNER.id,
            updatedBy: OWNER.id,
          })),
        });
        await prisma.intentAnchor.createMany({
          data: anchored.map((itemId) => ({
            workspaceId,
            itemId,
            repoKey: REPO_KEY_A,
            nodeId: fixture.repoA.guard,
            nodeType: NodeType.Function,
            capturedVersionedId: fixture.versionedIds[fixture.repoA.guard],
            createdBy: OWNER.id,
          })),
        });
        const body = await read({ nodeIds: fixture.repoA.handler, limit: '10' });
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0][1].items).toHaveLength(200);
        expect(body.scanTruncated).toBe(true);
      } finally {
        spy.mockRestore();
        await prisma.intentAnchor.deleteMany({ where: { workspaceId, itemId: { in: ids } } });
        await prisma.intentItem.deleteMany({ where: { workspaceId, id: { in: ids } } });
      }
    });

    it('matches a stored anchor, and an anchor on the ENCLOSING file', async () => {
      const body = await read({ nodeIds: fixture.repoA.guard, limit: '20' });
      expect(reasonOf(body, 'br-admin-only')).toBe(IntentContextMatchReason.NodeAnchor);
      // Anchored on `guards.ts`, reached from a function inside it.
      expect(reasonOf(body, 'uc-warehouse-limit')).toBe(IntentContextMatchReason.NodeAnchor);
    });

    it('bounds distinct eligible items after matching file members', async () => {
      const file = 'unknownrepo:file:src/noise.ts';
      const ids = ['br-member-superseded', 'br-member-many', 'br-member-valid', 'br-member-malformed'];
      await prisma.intentItem.createMany({
        data: ids.map((id, index) => ({
          workspaceId,
          id,
          kind: IntentKind.BusinessRule,
          title: id,
          statement: id,
          authority: index === 0 ? ('superseded' as const) : ('accepted' as const),
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        })),
      });
      const anchor = (itemId: string, name: string) => ({
        workspaceId,
        itemId,
        repoKey: REPO_KEY_A,
        nodeId: `unknownrepo:method:src/noise.ts:${name}`,
        nodeType: NodeType.Function,
        capturedVersionedId: 'v1',
        createdBy: OWNER.id,
      });
      try {
        await prisma.intentAnchor.createMany({
          data: [
            ...Array.from({ length: 600 }, (_, index) => anchor(ids[0] as string, `Old.m${index}`)),
            ...Array.from({ length: 600 }, (_, index) => anchor(ids[1] as string, `Many.m${index}`)),
            anchor(ids[2] as string, 'Valid.method'),
            anchor(ids[3] as string, 'Invalid:name'),
            anchor(ids[3] as string, ''),
            { ...anchor(ids[3] as string, 'hashed'), nodeId: 'unknownrepo:entrypoint:src/noise.ts:123abc' },
          ],
        });
        const body = await read({ nodeIds: file, limit: '20' });
        expect(body.matches.map((match: ContextMatch) => match.id)).toEqual(['br-member-many', 'br-member-valid']);
        expect(
          body.matches.every((match: ContextMatch) => match.matchReason === IntentContextMatchReason.NodeAnchor),
        ).toBe(true);
        expect(body.scanTruncated).toBe(false);
      } finally {
        await prisma.intentItem.deleteMany({ where: { workspaceId, id: { in: ids } } });
      }
    });

    it('adds graph-DERIVED hits with their §6.2 reasons', async () => {
      const body = await read({ nodeIds: fixture.repoA.handler, limit: '20' });
      // The handler is its own anchor's node.
      expect(reasonOf(body, 'br-refund-window')).toBe(IntentContextMatchReason.NodeAnchor);
      // The admin guard is CALLED by the queried handler — the guard case.
      const guardRule = body.matches.find((match: ContextMatch) => match.id === 'br-admin-only');
      expect(guardRule.matchReason).toBe(IntentContextMatchReason.NodeDerived);
      expect(guardRule.derivedReasons).toContain(IntentMatchReason.AnchorCalledByArea);
      // The handler lies in `checkout`'s seeded area, so that feature's own
      // items are applicable too.
      expect(body.matchedFeatureIds).toContain('checkout');
      const capability = body.matches.find((match: ContextMatch) => match.id === 'cap-checkout');
      expect(capability.matchReason).toBe(IntentContextMatchReason.NodeDerived);
      expect(capability.derivedReasons).toContain(IntentMatchReason.Attached);
    });

    it('derives on the anchored set, not on whatever unrelated rows fill a window', async () => {
      // The scale case: a workspace far larger than the derivation bound. The
      // candidate set used to be a flat alphabetical scan of every accepted
      // item, so unrelated rows filled it and the item that IS anchored on a
      // caller of the queried node was never handed to derivation — a miss
      // reported as `scanTruncated`, which said nothing about the anchored set.
      const filler = Array.from({ length: 600 }, (_, index) => ({
        workspaceId,
        id: `br-aa${String(index).padStart(4, '0')}-scale`,
        kind: IntentKind.BusinessRule,
        domainId: 'security',
        title: `Scale filler ${index}`,
        statement: 'A rule that exists only to crowd the candidate scan.',
        authority: 'accepted' as const,
        createdBy: OWNER.id,
        updatedBy: OWNER.id,
      }));
      await prisma.intentItem.createMany({ data: filler });
      try {
        const body = await read({ nodeIds: fixture.repoA.handler, limit: '20' });
        const guardRule = body.matches.find((match: ContextMatch) => match.id === 'br-admin-only');
        expect(guardRule?.matchReason).toBe(IntentContextMatchReason.NodeDerived);
        expect(guardRule?.derivedReasons).toContain(IntentMatchReason.AnchorCalledByArea);
        // Unrelated domains consume neither anchored nor feature-attachment slots.
        expect(idsOf(body)).toContain('cap-checkout');
        expect(body.scanTruncated).toBe(false);
      } finally {
        await prisma.intentItem.deleteMany({ where: { workspaceId, id: { startsWith: 'br-aa' } } });
      }
    });

    it('returns nothing for a present-but-empty node selector', async () => {
      expect((await read({ nodeIds: '' })).matches).toEqual([]);
    });

    it('reports a node id whose repository this workspace has not registered', async () => {
      const body = await read({ nodeIds: 'ffff9999ffff:function:src/a.ts:orphan', limit: '20' });
      expect(body.unresolvedNodeIds).toEqual(['ffff9999ffff:function:src/a.ts:orphan']);
      expect(body.matches).toEqual([]);
    });

    it('never matches a node id by substring', async () => {
      expect((await read({ nodeIds: 'assertAdmin', limit: '20' })).matches).toEqual([]);
    });
  });

  /* ------------------------------------------------- versions and trust --- */

  describe('handoff markers', () => {
    it('carries every item s version, the snapshot provenance, and the anchor caveat', async () => {
      const body = await read({ intentIds: 'br-admin-only' });
      expect(body.matches[0].version).toBe(1);
      expect(body.anchorWarning).toContain('not conformance proof');
      expect(body.evidence.available).toBe(true);
      const provenance = body.graph.repos.find((repo: { repoKey: string }) => repo.repoKey === REPO_KEY_A);
      expect(provenance).toMatchObject({
        graphVersionId: VERSION_ID,
        pushedAt: PUSHED_AT.toISOString(),
        // Nothing observed was supplied, so freshness is NOT claimed.
        snapshotFreshness: SnapshotFreshness.Unverified,
      });
      expect(body.matches[0].anchors[0]).toMatchObject({
        nodeId: fixture.repoA.guard,
        status: AnchorStatus.Matched,
      });
    });

    it('gives every RETURNED anchor its trust fields, even past the derivation subset', async () => {
      // The node selector hands derivation a bounded slice of the candidate set
      // (`INTENT_CONTEXT_READ_LIMITS.derivationItems`, 200) while its ANCHOR half
      // scans further. These fillers sort before `br-admin-only`, so they fill
      // that slice and push the anchored item out of it — the item is still
      // matched and returned, and its anchor used to come back with no `status`
      // and no `snapshotFreshness` while `evidence.available` said `true`.
      // Absent trust fields must mean one thing only: an unreadable graph (§6.3).
      const filler = Array.from({ length: 200 }, (_, index) => ({
        workspaceId,
        id: `br-aa${String(index).padStart(4, '0')}-filler`,
        kind: IntentKind.BusinessRule,
        domainId: 'security',
        title: `Filler ${index}`,
        statement: 'A rule that exists only to fill the derivation bound.',
        authority: 'accepted' as const,
        createdBy: OWNER.id,
        updatedBy: OWNER.id,
      }));
      await prisma.intentItem.createMany({ data: filler });
      try {
        const body = await read({ nodeIds: fixture.repoA.guard, limit: '20' });
        const match = body.matches.find((entry: ContextMatch) => entry.id === 'br-admin-only');
        expect(match?.matchReason).toBe(IntentContextMatchReason.NodeAnchor);
        expect(body.evidence.available).toBe(true);
        expect(match?.anchors?.[0]).toMatchObject({
          nodeId: fixture.repoA.guard,
          status: AnchorStatus.Matched,
          snapshotFreshness: SnapshotFreshness.Unverified,
        });
      } finally {
        await prisma.intentItem.deleteMany({ where: { workspaceId, id: { startsWith: 'br-aa' } } });
      }
    });

    it('detects a version change between handoff and re-fetch', async () => {
      // Its OWN item, created and dropped here: the review flow this models
      // mutates the row it hands off, and mutating one the rest of the file
      // reads would make every later expectation depend on this test's cleanup.
      const id = 'br-version-probe';
      await prisma.intentItem.create({
        data: {
          workspaceId,
          id,
          kind: IntentKind.BusinessRule,
          domainId: 'ordering',
          title: 'Version probe',
          statement: 'A rule that exists to be re-fetched.',
          authority: 'accepted',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      });
      try {
        const before = await read({ intentIds: id });
        expect(before.matches[0].version).toBe(1);
        await prisma.intentItem.update({
          where: { workspaceId_id: { workspaceId, id } },
          data: { version: { increment: 1 }, updatedBy: OWNER.id },
        });
        const after = await read({ intentIds: id });
        expect(after.matches[0].version).toBe(before.matches[0].version + 1);
      } finally {
        await prisma.intentItem.delete({ where: { workspaceId_id: { workspaceId, id } } });
      }
    });

    it('reports current only against an observed checkout the caller supplied', async () => {
      const body = await read({
        intentIds: 'br-admin-only',
        observed: `${REPO_KEY_A}@${fixture.repoA.gitCommitHash}`,
      });
      const provenance = body.graph.repos.find((repo: { repoKey: string }) => repo.repoKey === REPO_KEY_A);
      expect(provenance.snapshotFreshness).toBe(SnapshotFreshness.Current);

      const stale = await read({ intentIds: 'br-admin-only', observed: `${REPO_KEY_A}@${'c'.repeat(40)}` });
      expect(stale.graph.repos.find((repo: { repoKey: string }) => repo.repoKey === REPO_KEY_A).snapshotFreshness).toBe(
        SnapshotFreshness.Stale,
      );
    });

    it('accepts an abbreviated observed commit that prefixes the snapshot commit', async () => {
      const abbreviated = await read({
        intentIds: 'br-admin-only',
        observed: `${REPO_KEY_A}@${fixture.repoA.gitCommitHash.slice(0, 12)}`,
      });
      expect(
        abbreviated.graph.repos.find((repo: { repoKey: string }) => repo.repoKey === REPO_KEY_A).snapshotFreshness,
      ).toBe(SnapshotFreshness.Current);

      const stale = await read({ intentIds: 'br-admin-only', observed: `${REPO_KEY_A}@${'c'.repeat(12)}` });
      expect(stale.graph.repos.find((repo: { repoKey: string }) => repo.repoKey === REPO_KEY_A).snapshotFreshness).toBe(
        SnapshotFreshness.Stale,
      );
    });

    it('bounds the response and says so, rather than shrinking silently', async () => {
      const body = await read({ limit: '1' });
      expect(body.matches).toHaveLength(1);
      expect(body.truncated).toBe(true);
      expect(body.omittedCount).toBe(body.totalMatched - 1);
    });
  });

  /* ------------------------------------------------------- degradation --- */

  describe('graph unavailability degrades, never errors (§6.3)', () => {
    it('still answers by attachment, and says the evidence is gone', async () => {
      leaseError = new WorkspaceGraphContextError('ACTIVE_VERSION_MISSING', 'no active graph version');
      const body = await read({ feature: 'checkout', limit: '20' });
      expect(idsOf(body).sort()).toEqual(['br-refund-window', 'cap-checkout', 'uc-warehouse-limit']);
      expect(body.evidence.available).toBe(false);
      expect(body.graph.degradation.code).toBe('active_version_missing');
      expect(body.graph.degradation.remediation).toBeTruthy();
      // An anchor without a readable graph carries no status rather than a guess.
      const rule = body.matches.find((match: ContextMatch) => match.id === 'br-refund-window');
      expect(rule.anchors[0].status).toBeUndefined();
    });

    it('leaves the node selector with its anchor half, and no derived half', async () => {
      leaseError = new WorkspaceGraphContextError('ACTIVE_VERSION_MISSING', 'no active graph version');
      const body = await read({ nodeIds: fixture.repoA.handler, limit: '20' });
      expect(idsOf(body)).toEqual(['br-refund-window']);
      expect(body.evidence.available).toBe(false);
    });
  });

  /* --------------------------------------------------------- list mode --- */

  describe('list mode', () => {
    it('is payload-free and pages with a stable cursor', async () => {
      const first = await read({ mode: IntentContextMode.List, limit: '2' });
      expect(first.mode).toBe(IntentContextMode.List);
      expect(first.entries).toHaveLength(2);
      expect(first.entries[0].statement).toBeUndefined();
      expect(first.entries[0].payload).toBeUndefined();
      expect(first.entries[0].version).toBe(1);
      expect(first.nextCursor).toBeTruthy();
      // A page with another page after it is not the whole answer, and says how big the whole is.
      expect(first.truncated).toBe(true);
      expect(first.totalMatched).toBeGreaterThan(2);
      expect(first.omittedCount).toBe(first.totalMatched - 2);
      expect(first.remedy).toContain('nextCursor');
      const all = await read({ mode: IntentContextMode.List, limit: '50' });
      expect(all.entries).toHaveLength(first.totalMatched);
      expect(all.truncated).toBe(false);
      expect(all.omittedCount).toBe(0);

      const second = await read({ mode: IntentContextMode.List, limit: '2', cursor: first.nextCursor });
      const seen = [...first.entries, ...second.entries].map((entry: { id: string }) => entry.id);
      expect(new Set(seen).size).toBe(seen.length);
      // Ordering is total, so paging never re-serves or skips a row.
      expect(seen).toEqual([...seen].sort());
    });

    it('counts the other matches even when exact ids fill the page', async () => {
      const body = await read({
        mode: IntentContextMode.List,
        feature: 'checkout',
        intentIds: 'br-refund-window',
        limit: '1',
      });
      expect(body.entries.map((entry: { id: string }) => entry.id)).toEqual(['br-refund-window']);
      expect(body.totalMatched).toBe(3);
      expect(body.omittedCount).toBe(2);
      expect(body.truncated).toBe(true);
      expect(body.remedy).toContain('raise limit');
    });

    it('carries no graph lease when the selector does not need one', async () => {
      const body = await read({ mode: IntentContextMode.List, feature: 'checkout', limit: '20' });
      expect(body.graph).toBeUndefined();
      expect(body.entries.map((entry: { id: string }) => entry.id).sort()).toEqual([
        'br-refund-window',
        'cap-checkout',
        'uc-warehouse-limit',
      ]);
    });

    it('answers the node selector as ONE bounded page and refuses a cursor for it', async () => {
      const body = await read({ mode: IntentContextMode.List, nodeIds: fixture.repoA.guard, limit: '20' });
      expect(body.nextCursor).toBeNull();
      expect(body.graph.repos.length).toBeGreaterThan(0);

      // A cursor this endpoint really issued, on a selection that cannot page.
      const paged = await read({ mode: IntentContextMode.List, limit: '2' });
      const refused = await read(
        { mode: IntentContextMode.List, nodeIds: fixture.repoA.guard, cursor: paged.nextCursor },
        400,
      );
      expect(refused.code).toBe(IntentErrorCode.CursorNotSupported);
    });

    it('refuses a cursor from another list', async () => {
      const body = await read({ mode: IntentContextMode.List, cursor: 'not-a-cursor' }, 400);
      expect(body.code).toBe(IntentErrorCode.InvalidCursor);
    });

    it('applies the present-but-empty rule here too: a selector never falls through to the default set', async () => {
      const exact = await read({ mode: IntentContextMode.List, intentIds: 'br-admin-only', limit: '20' });
      expect(exact.entries.map((entry: { id: string }) => entry.id)).toEqual(['br-admin-only']);
      expect((await read({ mode: IntentContextMode.List, intentIds: '', limit: '20' })).entries).toEqual([]);
    });
  });

  /* ------------------------------------------------- pending review --- */

  describe('pendingReview (issue v1.1-01)', () => {
    /**
     * The candidate-discovery half of the read: a proposal is invisible until
     * someone opens the review tab, so EVERY answer carries what is waiting.
     * `lim-legacy-export` is this fixture's only candidate.
     */
    it('rides on a context answer', async () => {
      const body = await read({ limit: '20' });
      expect(body.pendingReview).toEqual({
        waiting: 1,
        oldestWaitingAt: expect.any(String),
        hasReplacementCandidate: false,
        byDomain: [{ domainId: 'ordering', waiting: 1, oldestWaitingAt: expect.any(String) }],
        byDomainTruncated: false,
      });
    });

    it('rides on a list answer too, and on a paged one', async () => {
      const first = await read({ mode: IntentContextMode.List, limit: '2' });
      expect(first.pendingReview.waiting).toBe(1);
      expect(first.pendingReview.byDomain).toBeUndefined();
      expect(first.handoffFreshness).toEqual({ pending: expect.any(Number), needsAttention: expect.any(Number) });
      const next = await read({ mode: IntentContextMode.List, limit: '2', cursor: first.nextCursor });
      expect(next.pendingReview.waiting).toBe(1);
    });

    it('returns full list diagnostics only when requested', async () => {
      const body = await read({ mode: IntentContextMode.List, limit: '1', includeDiagnostics: 'true' });
      expect(body.entries).toHaveLength(1);
      expect(body.pendingReview.byDomain).toEqual([
        { domainId: 'ordering', waiting: 1, oldestWaitingAt: expect.any(String) },
      ]);
      expect(body.handoffFreshness).toEqual({ operations: expect.any(Array), truncated: expect.any(Boolean) });
    });

    it('counts pending or attention handoffs once and excludes finished operations', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      try {
        await prisma.intentHandoff.createMany({
          data: ids.map((id, index) => ({
            id,
            workspaceId,
            repoKey: REPO_KEY_A,
            headSha: 'a'.repeat(40),
            payload: {},
            createdBy: OWNER.id,
            updatedBy: OWNER.id,
            // row0 pending+needs_attention, row1 needs_attention, row2 finished, row3 pending only.
            mappingState: index === 0 || index === 3 ? 'pending' : 'complete',
            deliveryState: index < 2 ? 'needs_attention' : 'complete',
          })),
        });
        const body = await read({ mode: IntentContextMode.List, limit: '1' });
        expect(body.handoffFreshness).toEqual({ pending: 1, needsAttention: 2 });
        const detailed = await read({ mode: IntentContextMode.List, limit: '1', includeDiagnostics: 'true' });
        expect(detailed.handoffFreshness.operations.map((operation: { id: string }) => operation.id).sort()).toEqual(
          [ids[0], ids[1], ids[3]].sort(),
        );
        // Context mode is compact by default too; the operation ids need includeDiagnostics.
        const context = await read({ limit: '20' });
        expect(context.handoffFreshness).toEqual({ pending: 1, needsAttention: 2 });
        const contextDetailed = await read({ limit: '20', includeDiagnostics: 'true' });
        expect(contextDetailed.handoffFreshness.operations).toHaveLength(3);
      } finally {
        await prisma.intentHandoff.deleteMany({ where: { id: { in: ids } } });
      }
    });

    it('is unaffected by the selectors — it describes the workspace, not the answer', async () => {
      const scoped = await read({ domain: 'security', limit: '20' });
      expect(scoped.pendingReview.waiting).toBe(1);
      expect(scoped.pendingReview.byDomain).toEqual([
        { domainId: 'ordering', waiting: 1, oldestWaitingAt: expect.any(String) },
      ]);
    });

    it('survives graph unavailability: a degraded read still reports what is waiting', async () => {
      leaseError = new WorkspaceGraphContextError('ACTIVE_VERSION_MISSING', 'No active snapshot');
      const body = await read({ limit: '20' });
      expect(body.evidence.available).toBe(false);
      expect(body.pendingReview.waiting).toBe(1);
    });
  });

  /* --------------------------------------------- context conditions --- */

  describe('context conditions (intent-dimensions UC-4)', () => {
    let dimsWorkspace: string;
    let tools: IntentTools;
    /** Excluded for `country: de`, and ahead of the pilot rule in every rank order. */
    const EXCLUDED = Array.from({ length: 25 }, (_, i) => `br-a-excluded-${String(i).padStart(2, '0')}`);
    const PILOT_VARIANTS = [
      { when: { country: 'de' }, outcome: '40h' },
      { outcome: 'contractHoursPerWeek × 1.1, capped at 48h', inputs: ['contractHoursPerWeek'] },
    ];

    beforeAll(async () => {
      const workspace = await prisma.workspace.create({
        data: { name: `intent-ctx-dims-${RUN}`, slug: `intent-ctx-dims-${RUN}`, intentEnabled: true },
      });
      dimsWorkspace = workspace.id;
      await prisma.workspaceMember.create({
        data: { workspaceId: dimsWorkspace, userId: OWNER.id, email: OWNER.email, role: 'owner' },
      });
      const author = { createdBy: OWNER.id, updatedBy: OWNER.id };
      const values = (...ids: string[]) => ids.map((id) => ({ id, title: id.toUpperCase() }));
      await prisma.intentDimension.createMany({
        data: [
          { workspaceId: dimsWorkspace, id: 'country', title: 'Country', values: values('de', 'pl', 'ua'), ...author },
          { workspaceId: dimsWorkspace, id: 'plan', title: 'Plan', values: values('free', 'pro'), ...author },
          {
            workspaceId: dimsWorkspace,
            id: 'product',
            title: 'Product',
            values: values('ta', 'project', 'shifts'),
            multi: true,
            ...author,
          },
        ],
      });
      const item = (id: string, extra: Record<string, unknown>) => ({
        workspaceId: dimsWorkspace,
        id,
        kind: IntentKind.BusinessRule,
        title: `Rule ${id}`,
        statement: 'A rule that stands on its own.',
        authority: 'accepted' as const,
        ...author,
        ...extra,
      });
      await prisma.intentItem.createMany({
        data: [
          item('br-weekly-overtime-threshold', {
            title: 'Weekly overtime threshold',
            statement: 'Hours above the threshold count as overtime.',
            appliesWhen: [{ dimension: 'country', notIn: ['ua'] }],
            payload: {
              condition: 'Weekly worked hours exceed the threshold',
              requiredOutcome: 'Hours above the threshold count as overtime',
              observer: 'Payroll export',
              variants: PILOT_VARIANTS,
            },
          }),
          ...EXCLUDED.map((id) =>
            item(id, {
              title: `Overtime exception ${id}`,
              appliesWhen: [{ dimension: 'country', in: ['ua'] }],
            }),
          ),
          item('cap-pro-reports', { kind: IntentKind.Capability, appliesWhen: [{ dimension: 'plan', in: ['pro'] }] }),
          item('cap-shift-planning', {
            kind: IntentKind.Capability,
            appliesWhen: [{ dimension: 'product', in: ['shifts'] }],
          }),
          item('br-product-outcome', {
            payload: {
              condition: 'A product is subscribed',
              requiredOutcome: 'Per product',
              observer: 'Billing',
              variants: [
                { when: { product: 'ta' }, outcome: 'time tracking' },
                { when: { product: 'shifts' }, outcome: 'shift planning' },
              ],
            },
          }),
          item('br-text-condition', { appliesWhen: [{ text: 'Only during a public holiday' }] }),
          item('br-unconditioned', {}),
        ],
      });
      await prisma.intentItem.create({
        data: item('br-old-base', { authority: 'superseded', supersededById: 'br-unconditioned' }),
      });
      await prisma.intentItem.create({ data: item('br-follows-old', { appliesWhen: [{ item: 'br-old-base' }] }) });

      tools = new IntentTools(
        contextService,
        {} as never,
        {} as never,
        { hasIntentContent: async () => true } as never,
        {} as never,
        { recordMcpQuery: async () => undefined } as never,
        {} as never,
        {} as never,
        {} as never,
      );
    });

    afterAll(async () => {
      if (!dimsWorkspace) return;
      await prisma.intentItem.updateMany({ where: { workspaceId: dimsWorkspace }, data: { supersededById: null } });
      await prisma.intentItem.deleteMany({ where: { workspaceId: dimsWorkspace } });
      await prisma.intentDimension.deleteMany({ where: { workspaceId: dimsWorkspace } });
      await prisma.workspace.delete({ where: { id: dimsWorkspace } }).catch(() => undefined);
    });

    async function rest(query: Record<string, unknown>, status = 200) {
      const { context, ...rest } = query;
      const response = await request(app.getHttpServer())
        .get(`/api/v1/workspaces/${dimsWorkspace}/intent/context`)
        .query({ ...rest, ...(context === undefined ? {} : { context: JSON.stringify(context) }) });
      expect(response.status, JSON.stringify(response.body)).toBe(status);
      return response.body;
    }

    async function mcp(args: Record<string, unknown>) {
      const req = {
        workspaceId: dimsWorkspace,
        user: { id: OWNER.id },
        userWorkspaceRole: 'owner',
        mcpAuthKind: McpAuthKind.Jwt,
      } as unknown as Request;
      const result = await tools.getIntentContext(args, {} as never, req);
      return JSON.parse(result.content[0]?.text ?? 'null');
    }

    /** The same read over REST (query strings) and MCP (native values); both answers are returned. */
    async function both(args: Record<string, unknown>) {
      const restQuery = Object.fromEntries(
        Object.entries(args).map(([key, value]) =>
          key === 'context' ? [key, value] : [key, Array.isArray(value) ? value.join(',') : String(value)],
        ),
      );
      return [await rest(restQuery), await mcp(args)];
    }

    type Match = { id: string; payload?: unknown; appliesWhen?: unknown; contextMatch?: Record<string, unknown> };
    const find = (body: { matches: Match[] }, id: string) => body.matches.find((match) => match.id === id);

    it('AC-2: the pilot rule resolves per country, and is absent where its condition is false', async () => {
      for (const body of await both({ query: 'overtime', context: { country: 'de' } })) {
        expect(find(body, 'br-weekly-overtime-threshold')?.contextMatch).toEqual({
          state: 'match',
          open: [],
          variant: { state: 'resolved', variants: [PILOT_VARIANTS[0]], open: [] },
        });
        // The registry rides only the `{}` call, not every narrowed read.
        expect(body).not.toHaveProperty('dimensions');
      }
      for (const body of await both({ query: 'overtime', context: {} })) {
        expect(body.dimensions.map((d: { id: string }) => d.id)).toEqual(['country', 'plan', 'product']);
      }
      for (const body of await both({ query: 'overtime', context: { country: 'pl' } })) {
        expect(find(body, 'br-weekly-overtime-threshold')?.contextMatch?.variant).toEqual({
          state: 'default',
          variants: [PILOT_VARIANTS[1]],
          open: [],
        });
      }
      for (const body of await both({ intentIds: ['br-weekly-overtime-threshold'], context: { country: 'ua' } })) {
        // Exact ids pass through the context filter too: only items that apply are returned.
        expect(body.matches).toEqual([]);
        expect(body.unknownIntentIds).toEqual([]);
      }
    });

    it('names the exact-id and source-ref items the context excluded, in both modes', async () => {
      await prisma.intentItemSource.create({
        data: {
          workspaceId: dimsWorkspace,
          itemId: 'br-a-excluded-01',
          kind: 'issue',
          ref: 'jira:DIM-1',
          localId: 'BR-1',
        },
      });
      try {
        const args = {
          intentIds: ['br-weekly-overtime-threshold', 'br-a-excluded-00'],
          sourceRefs: ['jira:DIM-1'],
          context: { country: 'de' },
        };
        for (const mode of [IntentContextMode.Context, IntentContextMode.List]) {
          for (const body of await both({ ...args, mode })) {
            // One exact id and one source-ref hit are false for `de`; the discovered rest only counts.
            expect(body.excludedIntentIds).toEqual(['br-a-excluded-00', 'br-a-excluded-01']);
          }
        }
        for (const body of await both({ ...args, context: { country: 'ua' } })) {
          expect(body.excludedIntentIds).toEqual(['br-weekly-overtime-threshold']);
        }
        for (const body of await both({ intentIds: ['br-unconditioned'], context: { country: 'de' } })) {
          expect(body).not.toHaveProperty('excludedIntentIds');
        }
      } finally {
        await prisma.intentItemSource.deleteMany({ where: { workspaceId: dimsWorkspace, ref: 'jira:DIM-1' } });
      }
    });

    it('AC-2: without a context the answer carries every variant and no contextMatch', async () => {
      for (const body of await both({ intentIds: ['br-weekly-overtime-threshold', 'br-a-excluded-00'] })) {
        const rule = find(body, 'br-weekly-overtime-threshold');
        expect((rule?.payload as { variants: unknown[] }).variants).toEqual(PILOT_VARIANTS);
        expect(rule?.appliesWhen).toEqual([{ dimension: 'country', notIn: ['ua'] }]);
        expect(body.matches.some((match: Match) => 'contextMatch' in match)).toBe(false);
        expect(body).not.toHaveProperty('dimensions');
        // Only the dimensions these items' conditions use (both are country-only), not every declared one:
        // naming `plan`/`product` would nudge a reader toward dimensions that change nothing here.
        expect(body.contextNotSupplied).toEqual({ conditionedItems: 2, dimensions: ['country'] });
      }
      const list = await rest({ mode: IntentContextMode.List, intentIds: 'br-product-outcome,br-a-excluded-00' });
      // A rule whose only context dependence is its variants counts in list mode too.
      expect(list.contextNotSupplied).toEqual({ conditionedItems: 2, dimensions: ['country', 'product'] });
      // A context read of the variant rule names the variant dimension.
      const variant = await rest({ intentIds: 'br-product-outcome' });
      expect(variant.contextNotSupplied).toEqual({ conditionedItems: 1, dimensions: ['product'] });
      const plain = await rest({ intentIds: 'br-unconditioned' });
      expect(plain.matches[0]).not.toHaveProperty('appliesWhen');
      expect(plain).not.toHaveProperty('contextNotSupplied');
    });

    it('filters over the candidate window BEFORE the limit, in both modes', async () => {
      const unfiltered = await rest({ query: 'overtime', limit: '5' });
      expect(unfiltered.matches.map((match: Match) => match.id)).toEqual(EXCLUDED.slice(0, 5));

      for (const body of await both({ query: 'overtime', limit: 5, context: { country: 'de' } })) {
        expect(body.matches.map((match: Match) => match.id)).toEqual(['br-weekly-overtime-threshold']);
      }
      const list = await rest({
        mode: IntentContextMode.List,
        query: 'overtime',
        limit: '5',
        context: { country: 'de' },
      });
      expect(list.entries).toEqual([
        expect.objectContaining({ id: 'br-weekly-overtime-threshold', contextMatch: { state: 'match', open: [] } }),
      ]);
      expect(list.entries[0]).not.toHaveProperty('payload');
      expect(list.nextCursor).toBeNull();
    });

    it('widens the filtered window past candidateScan and counts what the context dropped', async () => {
      const fillers = Array.from({ length: INTENT_CONTEXT_READ_LIMITS.candidateScan }, (_, i) => ({
        workspaceId: dimsWorkspace,
        id: `br-a-scan-${String(i).padStart(4, '0')}`,
        kind: IntentKind.BusinessRule,
        title: `Overtime filler ${i}`,
        statement: 'A rule that exists only to fill the candidate window.',
        authority: 'accepted' as const,
        appliesWhen: [{ dimension: 'country', in: ['ua'] }],
        createdBy: OWNER.id,
        updatedBy: OWNER.id,
      }));
      await prisma.intentItem.createMany({ data: fillers });
      try {
        const excluded = fillers.length + EXCLUDED.length;
        for (const body of await both({ query: 'overtime', limit: 5, context: { country: 'de' } })) {
          expect(body.matches.map((match: Match) => match.id)).toEqual(['br-weekly-overtime-threshold']);
          expect(body.contextExcluded).toBe(excluded);
          expect(body.scanTruncated).toBe(false);
        }
        const list = await rest({
          mode: IntentContextMode.List,
          query: 'overtime',
          limit: '5',
          context: { country: 'de' },
        });
        expect(list.entries.map((entry: Match) => entry.id)).toEqual(['br-weekly-overtime-threshold']);
        expect(list.contextExcluded).toBe(excluded);
      } finally {
        await prisma.intentItem.deleteMany({ where: { workspaceId: dimsWorkspace, id: { startsWith: 'br-a-scan-' } } });
      }
    });

    it('reports the source-ref cap as truncated even when the context drops every row it reached', async () => {
      const capped = Array.from(
        { length: INTENT_CONTEXT_READ_LIMITS.sourceItems + 1 },
        (_, i) => `br-a-src-${String(i).padStart(4, '0')}`,
      );
      // Sorts after every capped row, so the source scan's bound cuts it off.
      const ids = [...capped, 'br-z-src-applies'];
      await prisma.intentItem.createMany({
        data: ids.map((id) => ({
          workspaceId: dimsWorkspace,
          id,
          kind: IntentKind.BusinessRule,
          title: `Sourced ${id}`,
          statement: 'A rule recorded from one large ticket.',
          authority: 'accepted' as const,
          ...(id.startsWith('br-a-src-') ? { appliesWhen: [{ dimension: 'country', in: ['ua'] }] } : {}),
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        })),
      });
      await prisma.intentItemSource.createMany({
        data: ids.map((itemId) => ({
          workspaceId: dimsWorkspace,
          itemId,
          kind: 'issue' as const,
          ref: 'jira:DIM-CAP',
          localId: itemId,
        })),
      });
      try {
        for (const mode of [IntentContextMode.Context, IntentContextMode.List]) {
          for (const body of await both({ mode, sourceRefs: ['jira:DIM-CAP'], context: { country: 'de' } })) {
            expect(body.matches ?? body.entries).toEqual([]);
            expect(body.truncated).toBe(true);
          }
          const unfiltered = await rest({ mode, sourceRefs: 'jira:DIM-CAP', limit: '5' });
          expect(unfiltered.truncated).toBe(true);
        }
      } finally {
        await prisma.intentItem.deleteMany({ where: { workspaceId: dimsWorkspace, id: { in: ids } } });
      }
    });

    it('binds a filtered list cursor to its context', async () => {
      const page = (context?: Record<string, unknown>, cursor?: string, status = 200) =>
        rest(
          {
            mode: IntentContextMode.List,
            query: 'overtime',
            limit: '2',
            ...(context ? { context } : {}),
            ...(cursor ? { cursor } : {}),
          },
          status,
        );
      const first = await page({ country: 'ua' });
      expect(first.entries.map((entry: Match) => entry.id)).toEqual(EXCLUDED.slice(0, 2));
      expect(first.nextCursor).toBeTruthy();

      for (const other of [{ country: 'de' }, {}, undefined]) {
        expect((await page(other, first.nextCursor, 400)).code).toBe(IntentErrorCode.InvalidCursor);
      }
      const second = await page({ country: 'ua' }, first.nextCursor);
      expect(second.entries.map((entry: Match) => entry.id)).toEqual(EXCLUDED.slice(2, 4));

      // An unfiltered cursor keeps its unbound envelope, and is refused under a context.
      const plain = await page();
      expect(Object.keys(JSON.parse(Buffer.from(plain.nextCursor, 'base64url').toString('utf8')))).toEqual([
        'v',
        'scope',
        'key',
      ]);
      expect((await page(undefined, plain.nextCursor)).entries.length).toBeGreaterThan(0);
      expect((await page({ country: 'ua' }, plain.nextCursor, 400)).code).toBe(IntentErrorCode.InvalidCursor);
    });

    it('AC-3: a clause on a dimension the context leaves out is open, not false', async () => {
      for (const body of await both({ intentIds: ['cap-pro-reports'], context: { country: 'de' } })) {
        expect(find(body, 'cap-pro-reports')?.contextMatch).toEqual({ state: 'open', open: ['plan'] });
      }
    });

    it('AC-4: item and text clauses are unevaluated, with the reason', async () => {
      const [body] = await both({ intentIds: ['br-follows-old', 'br-text-condition'], context: { country: 'de' } });
      expect(find(body, 'br-follows-old')?.contextMatch).toEqual({
        state: 'unevaluated',
        open: [],
        reasons: [{ clause: 0, code: 'item-superseded', item: 'br-old-base' }],
      });
      expect(find(body, 'br-text-condition')?.contextMatch).toEqual({
        state: 'unevaluated',
        open: [],
        reasons: [{ clause: 0, code: 'text-condition' }],
      });
    });

    it('AC-10: a multi dimension matches on intersection, and two top variants are ambiguous', async () => {
      const ids = ['cap-shift-planning', 'br-product-outcome'];
      for (const body of await both({ intentIds: ids, context: { product: ['ta', 'shifts'] } })) {
        expect(find(body, 'cap-shift-planning')?.contextMatch).toMatchObject({ state: 'match' });
        expect(find(body, 'br-product-outcome')?.contextMatch?.variant).toMatchObject({ state: 'ambiguous' });
        expect(
          (find(body, 'br-product-outcome')?.contextMatch?.variant as { variants: unknown[] }).variants,
        ).toHaveLength(2);
      }
      for (const body of await both({ intentIds: ids, context: { product: ['ta'] } })) {
        expect(body.matches.map((match: Match) => match.id)).toEqual(['br-product-outcome']);
      }
      for (const body of await both({ intentIds: ['br-product-outcome'], context: { product: ['project'] } })) {
        // No variant matches and none is a default: the rule's requiredOutcome applies.
        expect(find(body, 'br-product-outcome')?.contextMatch?.variant).toEqual({
          state: 'base',
          variants: [],
          open: [],
        });
      }
    });

    describe('tree conditions (intent-dimensions-inheritance UC-4, BR-1)', () => {
      const DOMAIN_CONDITIONS = [{ dimension: 'product', in: ['shifts'] }];
      const FEATURE_CONDITIONS = [{ dimension: 'country', in: ['pl'] }];

      beforeAll(async () => {
        const author = { createdBy: OWNER.id, updatedBy: OWNER.id };
        await prisma.intentDomain.create({
          data: {
            workspaceId: dimsWorkspace,
            id: 'shifts',
            title: 'Shifts',
            statement: '',
            appliesWhen: DOMAIN_CONDITIONS,
            ...author,
          },
        });
        await prisma.intentFeature.create({
          data: {
            workspaceId: dimsWorkspace,
            id: 'swap-pl',
            domainId: 'shifts',
            title: 'Swaps in Poland',
            statement: '',
            appliesWhen: FEATURE_CONDITIONS,
            ...author,
          },
        });
        const accepted = { kind: IntentKind.BusinessRule, authority: 'accepted' as const, ...author };
        await prisma.intentItem.createMany({
          data: [
            {
              workspaceId: dimsWorkspace,
              id: 'br-shift-swap',
              domainId: 'shifts',
              title: 'Shift swap window',
              statement: 'A swap closes a day before the shift.',
              ...accepted,
            },
            {
              workspaceId: dimsWorkspace,
              id: 'br-shift-swap-pl',
              domainId: 'shifts',
              featureId: 'swap-pl',
              title: 'Shift swap approval',
              statement: 'A swap needs a manager approval.',
              ...accepted,
            },
          ],
        });
      });

      afterAll(async () => {
        await prisma.intentItem.deleteMany({
          where: {
            workspaceId: dimsWorkspace,
            id: { in: ['br-shift-swap', 'br-shift-swap-pl', 'br-follows-payroll-pl', 'cap-payroll-pl'] },
          },
        });
        await prisma.intentFeature.deleteMany({ where: { workspaceId: dimsWorkspace } });
        await prisma.intentDomain.deleteMany({ where: { workspaceId: dimsWorkspace } });
      });

      const listRead = (context: Record<string, unknown>) =>
        rest({ mode: IntentContextMode.List, query: 'swap', context });

      it('AC-1: an unconditioned item inherits its domain condition, in both modes', async () => {
        for (const body of await both({ intentIds: ['br-shift-swap'], context: { product: ['ta'] } })) {
          expect(body.matches).toEqual([]);
        }
        for (const body of await both({ query: 'swap', context: { product: ['ta'] } })) {
          expect(body.matches.map((match: Match) => match.id)).toEqual([]);
        }
        expect((await listRead({ product: ['ta'] })).entries).toEqual([]);

        for (const body of await both({ intentIds: ['br-shift-swap'], context: { product: ['ta', 'shifts'] } })) {
          expect(find(body, 'br-shift-swap')?.contextMatch).toEqual({ state: 'match', open: [] });
        }
        // The domain level leaves `product` open when the reader does not say.
        for (const body of await both({ intentIds: ['br-shift-swap'], context: { country: 'de' } })) {
          expect(find(body, 'br-shift-swap')?.contextMatch).toEqual({
            state: 'open',
            open: ['product'],
            openBy: ['domain'],
          });
        }
      });

      it('AC-1: without a context the item carries its inheritedConditions and no contextMatch', async () => {
        for (const body of await both({ intentIds: ['br-shift-swap', 'br-shift-swap-pl'] })) {
          const plain = find(body, 'br-shift-swap') as Match & { inheritedConditions?: unknown };
          expect(plain.inheritedConditions).toEqual({ domain: DOMAIN_CONDITIONS });
          expect(plain).not.toHaveProperty('appliesWhen');
          expect(plain).not.toHaveProperty('contextMatch');
          const nested = find(body, 'br-shift-swap-pl') as Match & { inheritedConditions?: unknown };
          expect(nested.inheritedConditions).toEqual({ domain: DOMAIN_CONDITIONS, feature: FEATURE_CONDITIONS });
        }
        // An item outside any conditioned node has no key at all.
        expect((await rest({ intentIds: 'br-unconditioned' })).matches[0]).not.toHaveProperty('inheritedConditions');
      });

      it('list entries and the items index carry a condition summary only when conditioned', async () => {
        type Entry = { id: string; conditions?: unknown };
        const ids = ['br-weekly-overtime-threshold', 'br-shift-swap', 'br-product-outcome', 'br-unconditioned'];
        const list = await rest({ mode: IntentContextMode.List, intentIds: ids.join(','), limit: '20' });
        const index = new IntentItemService(prisma as unknown as PrismaService);
        const indexed = (
          await Promise.all(
            ids.map((id) => index.listItems(dimsWorkspace, { search: id } as ListIntentItemsQuery, 200)),
          )
        ).flatMap((page) => page.items);
        for (const entries of [list.entries as Entry[], indexed as Entry[]]) {
          const byId = new Map(entries.map((entry) => [entry.id, entry]));
          expect(byId.get('br-weekly-overtime-threshold')?.conditions).toEqual({
            own: [{ dimension: 'country', notIn: ['ua'] }],
            variants: 2,
          });
          expect(byId.get('br-shift-swap')?.conditions).toEqual({ inherited: true });
          expect(byId.get('br-product-outcome')?.conditions).toEqual({ variants: 2 });
          // Unconditioned: no key at all, so a dimension-free workspace reads the same bytes.
          expect(byId.get('br-unconditioned')).toBeDefined();
          expect(byId.get('br-unconditioned')).not.toHaveProperty('conditions');
        }
      });

      it('AC-1: a feature condition ANDs with its domain and is named as the open level', async () => {
        for (const body of await both({
          intentIds: ['br-shift-swap-pl'],
          context: { product: ['shifts'], country: 'de' },
        })) {
          expect(body.matches).toEqual([]);
        }
        for (const body of await both({ intentIds: ['br-shift-swap-pl'], context: { product: ['shifts'] } })) {
          expect(find(body, 'br-shift-swap-pl')?.contextMatch).toEqual({
            state: 'open',
            open: ['country'],
            openBy: ['feature'],
          });
        }
        const list = await listRead({ product: ['shifts'] });
        expect(list.entries).toEqual([
          expect.objectContaining({ id: 'br-shift-swap', contextMatch: { state: 'match', open: [] } }),
          expect.objectContaining({
            id: 'br-shift-swap-pl',
            contextMatch: { state: 'open', open: ['country'], openBy: ['feature'] },
          }),
        ]);
        expect(list.entries[0]).not.toHaveProperty('inheritedConditions');
      });

      it('an item clause follows the referenced item s inherited tree conditions, one level deep', async () => {
        const author = { createdBy: OWNER.id, updatedBy: OWNER.id };
        await prisma.intentDomain.create({
          data: { workspaceId: dimsWorkspace, id: 'payroll', title: 'Payroll', statement: '', ...author },
        });
        await prisma.intentFeature.create({
          data: {
            workspaceId: dimsWorkspace,
            id: 'payroll-pl',
            domainId: 'payroll',
            title: 'Payroll in Poland',
            statement: '',
            appliesWhen: [{ dimension: 'country', in: ['pl'] }],
            ...author,
          },
        });
        const accepted = { authority: 'accepted' as const, statement: 'Stands alone.', ...author };
        await prisma.intentItem.createMany({
          data: [
            {
              workspaceId: dimsWorkspace,
              id: 'cap-payroll-pl',
              kind: IntentKind.Capability,
              domainId: 'payroll',
              featureId: 'payroll-pl',
              title: 'Polish payroll',
              ...accepted,
            },
            {
              workspaceId: dimsWorkspace,
              id: 'br-follows-payroll-pl',
              kind: IntentKind.BusinessRule,
              title: 'Follows Polish payroll',
              appliesWhen: [{ item: 'cap-payroll-pl' }],
              ...accepted,
            },
          ],
        });
        for (const body of await both({ intentIds: ['br-follows-payroll-pl'], context: { country: 'de' } })) {
          expect(body.matches).toEqual([]);
        }
        for (const body of await both({ intentIds: ['br-follows-payroll-pl'], context: { country: 'pl' } })) {
          expect(find(body, 'br-follows-payroll-pl')?.contextMatch).toEqual({ state: 'match', open: [] });
        }
      });
    });

    it('refuses an undeclared dimension, an undeclared value, or a list for a single-value dimension, by name', async () => {
      const cases: Array<[Record<string, unknown>, IntentErrorCode, string]> = [
        [{ region: 'eu' }, IntentErrorCode.DimensionNotFound, 'declared dimensions: country, plan, product'],
        [{ plan: 'gold' }, IntentErrorCode.DimensionValueNotFound, 'declared values: free, pro'],
        [{ country: ['de', 'pl'] }, IntentErrorCode.DimensionNotMulti, "'country'"],
      ];
      for (const [context, code, named] of cases) {
        const body = await rest({ context }, 400);
        expect(body.code).toBe(code);
        expect(body.message).toContain(named);
        const answer = await mcp({ context });
        expect(answer.error.code).toBe(code);
        expect(answer.error.message).toContain(named);
      }
    });
  });

  /* ------------------------------------------- item-condition cycles --- */

  describe('item-condition cycles on propose (intent-dimensions BR-6)', () => {
    let cycleWorkspace: string;
    let propose: IntentProposeService;
    let keySeq = 0;

    beforeAll(async () => {
      const workspace = await prisma.workspace.create({
        data: { name: `intent-ctx-cycle-${RUN}`, slug: `intent-ctx-cycle-${RUN}`, intentEnabled: true },
      });
      cycleWorkspace = workspace.id;
      propose = new IntentProposeService(prisma as unknown as PrismaService, {} as never);
    });

    afterAll(async () => {
      if (cycleWorkspace) await prisma.workspace.delete({ where: { id: cycleWorkspace } }).catch(() => undefined);
    });

    const candidate = (id: string, next?: string) => ({
      workspaceId: cycleWorkspace,
      id,
      kind: IntentKind.BusinessRule,
      title: `Rule ${id}`,
      statement: 'A rule that stands on its own.',
      authority: 'candidate' as const,
      createdBy: OWNER.id,
      updatedBy: OWNER.id,
      ...(next === undefined ? {} : { appliesWhen: [{ item: next }] }),
    });

    function proposeClause(id: string, item: string) {
      const input = parseContract(ProposeIntentItemsSchema, {
        idempotencyKey: `cycle-${RUN}-${keySeq++}`,
        items: [
          {
            id,
            kind: IntentKind.BusinessRule,
            title: `Rule ${id}`,
            statement: 'A rule that stands on its own.',
            sources: [{ kind: 'spec', ref: 'spec/cycles', localId: id }],
            appliesWhen: [{ item }],
          },
        ],
      });
      return propose.propose(cycleWorkspace, { id: OWNER.id, role: 'owner' }, input);
    }

    const codeOf = (reason: unknown) => (reason as IntentPublicException).publicError?.code;

    it('refuses a cycle longer than the walk can load instead of assuming it acyclic', async () => {
      // chain-000 → … → chain-599 is stored; closing chain-599 → chain-000 is a 600-item cycle.
      const ids = Array.from({ length: 600 }, (_, i) => `br-chain-${String(i).padStart(3, '0')}`);
      await prisma.intentItem.createMany({ data: ids.map((id, i) => candidate(id, ids[i + 1])) });

      const refused = await proposeClause(ids.at(-1)!, ids[0]!).catch((error: unknown) => error);
      expect(codeOf(refused)).toBe(IntentErrorCode.ConditionCycle);
      const stored = await prisma.intentItem.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId: cycleWorkspace, id: ids.at(-1)! } },
      });
      expect(stored.appliesWhen).toBeNull();
    });

    it('refuses an id-less proposal that source identity resolves to an earlier item of the same batch', async () => {
      // Proposal 1 omits its id, so validation cannot key it; application lands it on br-same-a
      // (created by proposal 0 with the same source) and its clause would name itself.
      const rule = { kind: IntentKind.BusinessRule, statement: 'A rule that stands on its own.' };
      const sources = [{ kind: 'spec', ref: 'spec/cycles', localId: 'same-source' }];
      const input = parseContract(ProposeIntentItemsSchema, {
        idempotencyKey: `cycle-${RUN}-${keySeq++}`,
        items: [
          { ...rule, id: 'br-same-a', title: 'Rule same a', sources },
          { ...rule, title: 'Rule same a', sources, appliesWhen: [{ item: 'br-same-a' }] },
        ],
      });

      const refused = await propose
        .propose(cycleWorkspace, { id: OWNER.id, role: 'owner' }, input)
        .catch((error: unknown) => error);
      expect(codeOf(refused)).toBe(IntentErrorCode.ConditionCycle);
      expect(await prisma.intentItem.count({ where: { workspaceId: cycleWorkspace, id: 'br-same-a' } })).toBe(0);
    });

    it('lets only one of two concurrent proposals that would close a cycle commit', async () => {
      for (let round = 0; round < 5; round++) {
        const [a, b] = [`br-race-${round}-a`, `br-race-${round}-b`];
        await prisma.intentItem.createMany({ data: [candidate(a), candidate(b)] });

        const settled = await Promise.allSettled([proposeClause(a, b), proposeClause(b, a)]);
        expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const [rejected] = settled.filter((result) => result.status === 'rejected');
        expect(codeOf(rejected?.reason)).toBe(IntentErrorCode.ConditionCycle);
      }
    });
  });

  /* -------------------------------------------------------------- gates --- */

  describe('authorization', () => {
    it('lets a plain member read', async () => {
      principal = { user: MEMBER };
      await request(app.getHttpServer()).get(contextUrl()).expect(200);
    });

    it('lets a service token with intent:read read — this is the agent path', async () => {
      principal = { user: MEMBER, serviceToken: { permissions: [TokenPermission.IntentRead] } };
      await request(app.getHttpServer()).get(contextUrl()).expect(200);
    });

    it('refuses a service token without intent:read', async () => {
      principal = { user: OWNER, serviceToken: { permissions: [TokenPermission.IntentPropose] } };
      await request(app.getHttpServer()).get(contextUrl()).expect(403);
    });
  });
});
