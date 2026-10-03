/**
 * The anchor surface end to end: real PostgreSQL, real guards, a real Ladybug
 * snapshot (spec §4.6, §6.5, issue 05 acceptance).
 *
 * WHY BOTH PLANES. An anchor row is the join of two systems — the control plane
 * says which repositories this workspace may address, and the graph plane says
 * what the addressed node IS. A test that faked either half could not catch the
 * failure this surface exists to prevent: a `capturedVersionedId` that was never
 * observed, so that a later `matched` anchorStatus means nothing.
 *
 * Only `AuthGuard` is stubbed — it is the token→principal step and there is no
 * token issuer in this process. `WorkspaceRoleGuard`, `PermissionsGuard`, and
 * `UserSessionGuard` are REAL, resolving membership from real rows, so "a member
 * is refused" and "a service token is refused" are proven through the same code
 * path production uses. The snapshot LEASE is stubbed (there is no R2 here); the
 * repository behind it is a real graph file.
 *
 * Pool `forks` + `--no-file-parallelism` (see `scripts/test-postgres-integration.sh`):
 * the Ladybug native module.
 *
 * Only the refresh still has a REST route; add, remove and preview call
 * `IntentAnchorService` directly (the service the MCP tool shares). The last
 * block runs the SAME service through the `intent_anchor` MCP tool itself. It is here rather than in a suite of its own
 * because the fact worth proving is cross-surface: the tool has no route path
 * to assert ids against and no Nest guard stack, so only an end-to-end call
 * shows that its own gate and its shared operation schema land the identical
 * row against real Postgres and a real snapshot.
 */
import 'dotenv/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import { Test } from '@nestjs/testing';
import { NodeType } from '@coredoc/core';
import {
  buildIntentGraphFixture,
  openIntentGraphFixture,
  type IntentGraphFixture,
  type OpenedIntentGraphFixture,
} from '@coredoc/db/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { McpAuthKind } from '../../mcp/mcp-auth-context.js';
import { IntentAnchorAction, IntentToolStatus, IntentTools } from '../../mcp/tools/intent.tools.js';
import { WorkspaceGraphContextError, WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { bindRepoIntentIdentity, graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { IntentAnchorTargetService } from './intent-anchor-target.js';
import { IntentAnchorController } from './intent-anchor.controller.js';
import { IntentAnchorService } from './intent-anchor.service.js';

import { IntentTreeService } from './intent-tree.service.js';
import {
  AddIntentAnchorSchema,
  IntentErrorCode,
  IntentPublicException,
  PreviewIntentAnchorQuerySchema,
  RemoveIntentAnchorSchema,
  parseContract,
  renderIntentPublicError,
} from './contract/index.js';

const TEST_DATABASE_URL = process.env.INTENT_ANCHOR_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };

/** Durable keys, and the graph hashes they provably produce (the SQL CHECK's rule). */
const REPO_KEY_A = 'github.com/acme/orders-api';
const REPO_KEY_B = 'github.com/acme/reports-web';
const HASH_A = graphRepoHashOf(REPO_KEY_A);
const HASH_B = graphRepoHashOf(REPO_KEY_B);

const VERSION_ID = 'v-anchor-suite';
const ACCEPTED_ITEM = 'br-admin-only';
const CANDIDATE_ITEM = 'br-draft-rule';

let keySeed = 0;
function nextKey(prefix: string): string {
  keySeed += 1;
  return `${prefix}-${RUN}-${keySeed}`;
}

interface Principal {
  user: { id: string; email: string };
  serviceToken?: { permissions: string[] };
}

describe.skipIf(!TEST_DATABASE_URL)('intent anchors (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let principal: Principal;
  let directory: string;
  let fixture: IntentGraphFixture;
  let opened: OpenedIntentGraphFixture;
  let anchors: IntentAnchorService;
  /** Set to make the stubbed lease fail, for the "a write never degrades" case. */
  let leaseError: unknown;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    directory = mkdtempSync(join(tmpdir(), 'coredoc-anchor-pg-'));
    // The hashes must be the ones the durable keys produce: `workspace_repos`
    // refuses any other pairing, and the graph filter reads the same column.
    fixture = await buildIntentGraphFixture(join(directory, 'graph.ladybug'), {
      repoKeys: { a: REPO_KEY_A, b: REPO_KEY_B },
    });
    opened = await openIntentGraphFixture(fixture.path, { readOnly: true });

    const workspace = await prisma.workspace.create({
      data: { name: `intent-anchor-${RUN}`, slug: `intent-anchor-${RUN}`, intentEnabled: true },
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
        { workspaceId, repoKey: HASH_A, repoName: 'orders-api', intentRepoKey: REPO_KEY_A },
        // Registered, but with NO durable identity: the "unbound" arm of the gate.
        { workspaceId, repoKey: HASH_B, repoName: 'reports-web' },
      ],
    });
    await prisma.intentItem.createMany({
      data: [
        {
          workspaceId,
          id: ACCEPTED_ITEM,
          kind: 'business_rule',
          title: 'Admin only',
          statement: 'Only an admin may do this.',
          authority: 'accepted',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
        {
          workspaceId,
          id: CANDIDATE_ITEM,
          kind: 'business_rule',
          title: 'Draft rule',
          statement: 'A rule nobody has reviewed yet.',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      ],
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentAnchorController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        IntentAnchorTargetService,
        IntentAnchorService,
        // The MCP tool's `not_configured` probe is a real EXISTS query, so the
        // tool block below reads this workspace's real content rather than a
        // stub that always says "configured".
        IntentTreeService,
        {
          provide: WorkspaceMcpContextService,
          useValue: {
            async withContextByWorkspaceId(_workspaceId: string, callback: (context: never) => Promise<unknown>) {
              if (leaseError) throw leaseError;
              return callback({
                repository: opened.repository,
                scope: {},
                repos: [],
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

    anchors = moduleRef.get(IntentAnchorService);
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
    leaseError = undefined;
  });

  function api() {
    return request(app.getHttpServer());
  }

  function base() {
    return `/api/v1/workspaces/${workspaceId}/intent/items`;
  }

  function anchorBody(extra: Record<string, unknown> = {}) {
    return {
      idempotencyKey: nextKey('anchor'),
      itemId: ACCEPTED_ITEM,
      repoKey: REPO_KEY_A,
      nodeId: fixture.repoA.guard,
      ...extra,
    };
  }

  /**
   * Add, remove and preview have no REST route; they run through the service the
   * `intent_anchor` MCP tool calls, after the same contract parse. A refusal is
   * rendered as the public error body, so assertions read `{ status, body }`.
   */
  async function viaService(call: () => Promise<unknown>, expected?: number): Promise<{ status: number; body: any }> {
    let result: { status: number; body: any };
    try {
      result = { status: 201, body: JSON.parse(JSON.stringify(await call())) };
    } catch (error) {
      if (!(error instanceof IntentPublicException)) throw error;
      const { status, error: rendered } = renderIntentPublicError(error);
      result = { status, body: { statusCode: status, ...rendered } };
    }
    if (expected !== undefined) expect(result.status, JSON.stringify(result.body)).toBe(expected);
    return result;
  }

  function actor() {
    return { id: principal.user.id, role: principal.user.id === MEMBER.id ? 'member' : 'owner' };
  }

  function addAnchor(input: unknown, expected?: number) {
    return viaService(() => anchors.add(workspaceId, actor(), parseContract(AddIntentAnchorSchema, input)), expected);
  }

  function removeAnchor(input: unknown, expected?: number) {
    return viaService(
      () => anchors.remove(workspaceId, actor(), parseContract(RemoveIntentAnchorSchema, input)),
      expected,
    );
  }

  /** A read: answers 200 on success, as the route did. */
  async function previewAnchor(query: unknown, expected?: number) {
    const result = await viaService(() =>
      anchors.preview(workspaceId, parseContract(PreviewIntentAnchorQuerySchema, query)),
    );
    if (result.status === 201) result.status = 200;
    if (expected !== undefined) expect(result.status, JSON.stringify(result.body)).toBe(expected);
    return result;
  }

  async function anchorsOf(itemId: string) {
    return prisma.intentAnchor.findMany({ where: { workspaceId, itemId }, orderBy: { nodeId: 'asc' } });
  }

  /* ------------------------------------------------------------- CRUD --- */

  describe('add / refresh / remove', () => {
    it('stores the SERVER-resolved node type and baseline, and audits the write', async () => {
      const response = await addAnchor(anchorBody({ rationale: 'the guard this rule is about' }), 201);

      expect(response.body.created).toBe(true);
      expect(response.body.graphVersionId).toBe(VERSION_ID);
      const expected = fixture.versionedIds[fixture.repoA.guard];
      expect(response.body.anchor).toMatchObject({
        repoKey: REPO_KEY_A,
        nodeId: fixture.repoA.guard,
        nodeType: NodeType.Function,
        capturedVersionedId: expected,
      });

      const [stored] = await anchorsOf(ACCEPTED_ITEM);
      expect(stored).toMatchObject({
        nodeType: NodeType.Function,
        capturedVersionedId: expected,
        createdBy: OWNER.id,
      });

      const audits = await prisma.intentAuditEvent.findMany({
        where: { workspaceId, entityKind: 'anchor', entityId: String(stored?.id) },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ operation: 'create', actorId: OWNER.id, actorRole: 'owner' });
    });

    it('previews the same resolution without writing anything', async () => {
      const before = await anchorsOf(CANDIDATE_ITEM);
      const preview = await previewAnchor(
        { itemId: ACCEPTED_ITEM, repoKey: REPO_KEY_A, nodeId: fixture.repoA.handler },
        200,
      );

      expect(preview.body.wouldCreate).toBe(true);
      expect(preview.body.target).toEqual({
        repoKey: REPO_KEY_A,
        nodeId: fixture.repoA.handler,
        nodeType: NodeType.Function,
        capturedVersionedId: fixture.versionedIds[fixture.repoA.handler],
      });
      // Nothing was written, and no idempotency key was spent.
      expect(await anchorsOf(CANDIDATE_ITEM)).toEqual(before);
      expect(await prisma.intentAnchor.count({ where: { workspaceId, nodeId: fixture.repoA.handler } })).toBe(0);
    });

    it('refresh re-observes the baseline; remove deletes the row and audits it', async () => {
      const identity = { workspaceId, itemId: ACCEPTED_ITEM, repoKey: REPO_KEY_A, nodeId: fixture.repoA.guard };
      await prisma.intentAnchor.update({
        where: { workspaceId_itemId_repoKey_nodeId: identity },
        data: { capturedVersionedId: 'stale@000000' },
      });

      const refreshed = await api()
        .post(`${base()}/${ACCEPTED_ITEM}/anchors/refresh`)
        .send({
          idempotencyKey: nextKey('anchor'),
          itemId: ACCEPTED_ITEM,
          repoKey: REPO_KEY_A,
          nodeId: identity.nodeId,
        })
        .expect(201);
      expect(refreshed.body.changed).toBe(true);
      expect(refreshed.body.previousCapturedVersionedId).toBe('stale@000000');
      expect(refreshed.body.anchor.capturedVersionedId).toBe(fixture.versionedIds[fixture.repoA.guard]);

      await removeAnchor(
        {
          idempotencyKey: nextKey('anchor'),
          itemId: ACCEPTED_ITEM,
          repoKey: REPO_KEY_A,
          nodeId: identity.nodeId,
        },
        201,
      );
      expect(await anchorsOf(ACCEPTED_ITEM)).toHaveLength(0);
      const operations =
        // `id` is a random uuid; the trail's order is its timestamps.
        (
          await prisma.intentAuditEvent.findMany({
            where: { workspaceId, entityKind: 'anchor' },
            orderBy: { createdAt: 'asc' },
          })
        ).map((row) => row.operation);
      expect(operations).toEqual(['create', 'update', 'delete']);
    });

    it('replays a spent idempotency key without writing twice', async () => {
      const body = anchorBody({ nodeId: fixture.repoA.handler });
      const first = await addAnchor(body, 201);
      const replay = await addAnchor(body, 201);
      expect(replay.body).toEqual(first.body);
      expect(await prisma.intentAnchor.count({ where: { workspaceId, nodeId: fixture.repoA.handler } })).toBe(1);
    });

    it('refuses a body whose item id disagrees with the route path', async () => {
      const response = await api()
        .post(`${base()}/${ACCEPTED_ITEM}/anchors/refresh`)
        .send(anchorBody({ itemId: CANDIDATE_ITEM }))
        .expect(400);
      expect(response.body.code).toBe(IntentErrorCode.PathBodyMismatch);
    });
  });

  /* --------------------------------------------------------- identity --- */

  describe('repo identity gate', () => {
    it('refuses an unregistered repo key, enumerating what IS registered', async () => {
      const response = await addAnchor(anchorBody({ repoKey: 'github.com/acme/ghost' }), 400);
      expect(response.body.code).toBe(IntentErrorCode.UnknownRepoKey);
      expect(response.body.message).toContain(REPO_KEY_A);
      expect(response.body.message).toContain('unbound (reports-web');
      expect(response.body.path).toEqual(['repoKey']);
    });

    it('refuses a repo that is connected but carries no durable identity', async () => {
      const response = await addAnchor(anchorBody({ repoKey: 'reports-web', nodeId: fixture.repoB.guard }), 400);
      expect(response.body.code).toBe(IntentErrorCode.UnknownRepoKey);
    });

    it('refuses a node that lives in a DIFFERENT registered repository', async () => {
      const response = await addAnchor(anchorBody({ nodeId: fixture.repoB.guard }), 404);
      expect(response.body.code).toBe(IntentErrorCode.AnchorNodeMissing);
    });
  });

  /* -------------------------------------------------------- allowlist --- */

  describe('covered node types', () => {
    it('refuses a Route and names the covered list — seeds admit routes, anchors do not', async () => {
      const response = await addAnchor(anchorBody({ nodeId: fixture.repoA.route }), 400);
      expect(response.body.code).toBe(IntentErrorCode.AnchorNodeTypeUnsupported);
      expect(response.body.message).toContain(NodeType.Function);
      expect(await anchorsOf(ACCEPTED_ITEM)).not.toContainEqual(
        expect.objectContaining({ nodeId: fixture.repoA.route }),
      );
    });

    it('refuses a Package for the same reason', async () => {
      const response = await addAnchor(anchorBody({ nodeId: fixture.repoA.appPackage }), 400);
      expect(response.body.code).toBe(IntentErrorCode.AnchorNodeTypeUnsupported);
    });

    it('anchors a File, which the versioned-anchor contract does cover', async () => {
      const response = await addAnchor(anchorBody({ nodeId: fixture.repoA.guardsFile }), 201);
      expect(response.body.anchor.nodeType).toBe(NodeType.File);
    });
  });

  /* ------------------------------------------------------- preconditions --- */

  describe('preconditions', () => {
    it('refuses every anchor operation on a candidate', async () => {
      const refresh = await api()
        .post(`${base()}/${CANDIDATE_ITEM}/anchors/refresh`)
        .send(anchorBody({ itemId: CANDIDATE_ITEM }))
        .expect(400);
      expect(refresh.body.code).toBe(IntentErrorCode.ItemNotAccepted);
      for (const write of [addAnchor, removeAnchor]) {
        const response = await write(anchorBody({ itemId: CANDIDATE_ITEM }), 400);
        expect(response.body.code).toBe(IntentErrorCode.ItemNotAccepted);
      }
      expect(await anchorsOf(CANDIDATE_ITEM)).toHaveLength(0);
    });

    it('refuses an item this workspace does not hold', async () => {
      const response = await addAnchor(anchorBody({ itemId: 'ghost-item' }), 404);
      expect(response.body.code).toBe(IntentErrorCode.ItemNotFound);
    });

    it('refuses the write, rather than degrading, when no snapshot can be read', async () => {
      leaseError = new WorkspaceGraphContextError('ACTIVE_VERSION_MISSING', 'no active graph version');
      const response = await addAnchor(anchorBody(), 503);
      expect(response.body.code).toBe(IntentErrorCode.AnchorGraphUnavailable);
      expect(response.body.message).toContain('Retry once a snapshot is available');
    });
  });

  /* ------------------------------------------------------- concurrency --- */

  describe('concurrent supersede', () => {
    /**
     * The race the in-transaction `SELECT … FOR UPDATE` exists to close: the
     * pre-check reads `accepted`, a reviewer supersedes the item, and the anchor
     * lands on an item that is no longer accepted.
     *
     * The competing transaction takes the item's row lock FIRST and holds it, so
     * the ordering is fixed rather than hopeful: the anchor write cannot reach
     * its authority re-check until the supersede has committed.
     */
    it('never lands an anchor on an item a concurrent supersede retired', async () => {
      const itemId = `br-race-${RUN}`;
      await prisma.intentItem.create({
        data: {
          workspaceId,
          id: itemId,
          kind: 'business_rule',
          title: 'Race rule',
          statement: 'A rule a reviewer retires mid-flight.',
          authority: 'accepted',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      });

      let lockTaken: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });
      const supersede = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT 1 FROM intent_items
            WHERE workspace_id = ${workspaceId}::uuid AND id = ${itemId}
            FOR UPDATE
          `;
          lockTaken();
          // Long enough for the anchor write to reach its own FOR UPDATE and block.
          await new Promise((resolve) => setTimeout(resolve, 250));
          await tx.intentItem.update({
            where: { workspaceId_id: { workspaceId, id: itemId } },
            data: { authority: 'superseded' },
          });
        },
        { timeout: 15_000 },
      );

      await locked;
      const response = await addAnchor({
        idempotencyKey: nextKey('race'),
        itemId,
        repoKey: REPO_KEY_A,
        nodeId: fixture.repoA.guard,
      });
      await supersede;

      expect(response.status).toBe(400);
      expect(response.body.code).toBe(IntentErrorCode.ItemNotAccepted);
      expect(await anchorsOf(itemId)).toHaveLength(0);
      expect(
        (await prisma.intentItem.findUnique({ where: { workspaceId_id: { workspaceId, id: itemId } } }))?.authority,
      ).toBe('superseded');
    });
  });

  /* -------------------------------------------------------------- gates --- */

  describe('authorization', () => {
    it('admits an anchor refresh by a plain member (BR-1)', async () => {
      principal = { user: MEMBER };
      // The gate is the claim; whether the anchor exists by now is not, so any non-403 answer passes.
      const response = await api().post(`${base()}/${ACCEPTED_ITEM}/anchors/refresh`).send(anchorBody());
      expect(response.status).not.toBe(403);
    });

    it('refuses an anchor refresh by ANY service token, whatever its permissions', async () => {
      principal = {
        user: OWNER,
        serviceToken: { permissions: [TokenPermission.WorkspaceManage, TokenPermission.IntentPropose] },
      };
      await api().post(`${base()}/${ACCEPTED_ITEM}/anchors/refresh`).send(anchorBody()).expect(403);
    });
  });

  /* ------------------------------------------------------- MCP surface --- */

  describe('intent_anchor MCP tool', () => {
    const ITEM = `br-mcp-${RUN}`;
    let tools: IntentTools;

    beforeAll(async () => {
      await prisma.intentItem.create({
        data: {
          workspaceId,
          id: ITEM,
          kind: 'business_rule',
          title: 'Anchored through MCP',
          statement: 'A rule an agent anchors in the maintainer session.',
          authority: 'accepted',
          createdBy: OWNER.id,
          updatedBy: OWNER.id,
        },
      });
      tools = new IntentTools(
        // The context/propose/review services belong to other tools; this
        // block exercises the anchor path only.
        {} as never,
        {} as never,
        {} as never,
        app.get(IntentTreeService),
        app.get(IntentAnchorService),
        { recordMcpQuery: async () => undefined } as never,
        {} as never,
      );
    });

    /** The trusted context `McpRewriteMiddleware` attaches; there is no route path here. */
    function mcpRequest(overrides: Partial<Record<string, unknown>> = {}): Request {
      return {
        workspaceId,
        user: { id: OWNER.id },
        userWorkspaceRole: 'owner',
        mcpAuthKind: McpAuthKind.Jwt,
        ...overrides,
      } as unknown as Request;
    }

    function answerOf(result: { content: { type: 'text'; text: string }[] }): Record<string, unknown> {
      return JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown>;
    }

    it('previews and then adds, storing what a REST write would store', async () => {
      const identity = { itemId: ITEM, repoKey: REPO_KEY_A, nodeId: fixture.repoA.guard };
      const preview = answerOf(
        await tools.intentAnchor({ action: IntentAnchorAction.Preview, request: identity }, {} as never, mcpRequest()),
      );
      expect(preview.status).toBeUndefined();
      expect(preview.wouldCreate).toBe(true);
      expect(preview.target).toEqual({
        repoKey: REPO_KEY_A,
        nodeId: fixture.repoA.guard,
        nodeType: NodeType.Function,
        capturedVersionedId: fixture.versionedIds[fixture.repoA.guard],
      });
      expect(await anchorsOf(ITEM)).toHaveLength(0);

      const added = answerOf(
        await tools.intentAnchor(
          { action: IntentAnchorAction.Add, request: { idempotencyKey: nextKey('mcp'), ...identity } },
          {} as never,
          mcpRequest(),
        ),
      );
      expect(added.status).toBeUndefined();
      expect(added.created).toBe(true);

      const [stored] = await anchorsOf(ITEM);
      expect(stored).toMatchObject({
        nodeType: NodeType.Function,
        capturedVersionedId: fixture.versionedIds[fixture.repoA.guard],
        createdBy: OWNER.id,
      });
      const audits = await prisma.intentAuditEvent.findMany({
        where: { workspaceId, entityKind: 'anchor', entityId: String(stored?.id) },
      });
      expect(audits[0]).toMatchObject({ operation: 'create', actorId: OWNER.id, actorRole: 'owner' });
    });

    it('refuses a service-token write as a typed RESULT, writing nothing', async () => {
      const nodeId = fixture.repoA.handler;
      const before = await prisma.intentAnchor.count({ where: { workspaceId, itemId: ITEM, nodeId } });
      const answer = answerOf(
        await tools.intentAnchor(
          {
            action: IntentAnchorAction.Add,
            request: { idempotencyKey: nextKey('mcp'), itemId: ITEM, repoKey: REPO_KEY_A, nodeId },
          },
          {} as never,
          mcpRequest({
            mcpAuthKind: McpAuthKind.ServiceToken,
            serviceTokenPermissions: [TokenPermission.WorkspaceManage, TokenPermission.IntentPropose],
          }),
        ),
      );
      expect(answer.status).toBe(IntentToolStatus.PermissionDenied);
      expect(answer.requires).toEqual({ userSession: true, roles: ['owner', 'admin', 'product', 'member'] });
      expect(await prisma.intentAnchor.count({ where: { workspaceId, itemId: ITEM, nodeId } })).toBe(before);
    });

    it('refuses an anchor on a candidate with the REST refusal, untruncated', async () => {
      const answer = answerOf(
        await tools.intentAnchor(
          {
            action: IntentAnchorAction.Add,
            request: {
              idempotencyKey: nextKey('mcp'),
              itemId: CANDIDATE_ITEM,
              repoKey: REPO_KEY_A,
              nodeId: fixture.repoA.guard,
            },
          },
          {} as never,
          mcpRequest(),
        ),
      );
      expect(answer.status).toBe(IntentToolStatus.Error);
      expect((answer.error as { code: string }).code).toBe(IntentErrorCode.ItemNotAccepted);
      expect(await anchorsOf(CANDIDATE_ITEM)).toHaveLength(0);
    });
  });

  /* ----------------------------------------------------- repo identity --- */

  describe('durable identity registration (TOFU)', () => {
    it('binds on first use and is a no-op on the same identity', async () => {
      const repoKey = graphRepoHashOf(`tofu-${RUN}`);
      await prisma.workspaceRepo.create({ data: { workspaceId, repoKey, repoName: `tofu-${RUN}` } });
      const repo = { repoKey, repoName: `tofu-${RUN}` };

      await bindRepoIntentIdentity(prisma as unknown as PrismaService, workspaceId, repo, {
        gitUrl: 'git@github.com:acme/tofu.git',
      });
      const bound = await prisma.workspaceRepo.findUnique({ where: { workspaceId_repoKey: { workspaceId, repoKey } } });
      expect(bound?.intentRepoKey).toBe(`tofu-${RUN}`);
      expect(bound?.normalizedGitRemote).toBe('github.com/acme/tofu');

      await expect(
        bindRepoIntentIdentity(prisma as unknown as PrismaService, workspaceId, repo, {}),
      ).resolves.toBeUndefined();
      expect(
        (await prisma.workspaceRepo.findUnique({ where: { workspaceId_repoKey: { workspaceId, repoKey } } }))
          ?.intentRepoKey,
      ).toBe(`tofu-${RUN}`);
    });

    it('lets the database refuse an unprovable identity even when the service is bypassed', async () => {
      const repoKey = graphRepoHashOf(`check-${RUN}`);
      await prisma.workspaceRepo.create({ data: { workspaceId, repoKey, repoName: `check-${RUN}` } });
      // The CHECK is the backstop for any write that did not go through
      // `resolveIntentRepoKey` — a migration, a console, a future code path.
      await expect(
        prisma.workspaceRepo.update({
          where: { workspaceId_repoKey: { workspaceId, repoKey } },
          data: { intentRepoKey: 'a-key-that-hashes-to-something-else' },
        }),
      ).rejects.toThrow(/workspace_repos_intent_repo_key_graph_hash_check/);
    });

    it('refuses a rebind: only one durable key can ever reproduce a row s graph key', async () => {
      const repoName = `rebind-${RUN}`;
      const repoKey = graphRepoHashOf(repoName);
      await prisma.workspaceRepo.create({ data: { workspaceId, repoKey, repoName, intentRepoKey: repoName } });

      // This is what "rebind refused" actually means here, and why it is airtight
      // rather than a policy check: a second durable key would have to hash to
      // the same graph key, so the proof itself refuses the attempt.
      await expect(
        bindRepoIntentIdentity(
          prisma as unknown as PrismaService,
          workspaceId,
          { repoKey, repoName },
          {
            intentRepoKey: `${repoName}-renamed`,
          },
        ),
      ).rejects.toThrow(/does not reproduce/);

      // And a rename that no longer proves the key leaves the binding alone
      // rather than clearing or replacing it.
      await bindRepoIntentIdentity(
        prisma as unknown as PrismaService,
        workspaceId,
        { repoKey, repoName: `${repoName}-renamed` },
        {},
      );
      expect(
        (await prisma.workspaceRepo.findUnique({ where: { workspaceId_repoKey: { workspaceId, repoKey } } }))
          ?.intentRepoKey,
      ).toBe(repoName);
    });

    it('refuses a normalized remote the storage CHECK would not accept', async () => {
      const repoName = `remote-${RUN}`;
      const repoKey = graphRepoHashOf(repoName);
      await prisma.workspaceRepo.create({ data: { workspaceId, repoKey, repoName } });
      await expect(
        prisma.workspaceRepo.update({
          where: { workspaceId_repoKey: { workspaceId, repoKey } },
          data: { normalizedGitRemote: 'git@github.com:acme/orders.git' },
        }),
      ).rejects.toThrow(/workspace_repos_normalized_git_remote_check/);
    });
  });
});
