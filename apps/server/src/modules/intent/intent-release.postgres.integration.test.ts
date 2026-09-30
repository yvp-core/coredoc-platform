import { IntentErrorCode } from './contract/index.js';
import { IntentHandoffProcessor } from './intent-handoff-processor.service.js';
import { IntentHandoffService } from './intent-handoff.service.js';
import { SaveIntentHandoffSchema } from './intent-handoff.operations.js';
import { CI_TOKEN_PERMISSIONS } from '../../auth/token-permissions.js';
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { IntentDerivationService } from './derivation/intent-derivation.service.js';
import { IntentContextController } from './intent-context.controller.js';
import { IntentContextService } from './intent-context.service.js';
import { IntentReleaseController } from './intent-release.controller.js';
import { IntentItemService } from './intent-item.service.js';
import { IntentReleaseService } from './intent-release.service.js';

const databaseUrl = process.env.INTENT_RELEASE_TEST_DATABASE_URL ?? '';
describe.skipIf(!databaseUrl)('release effectivity — PostgreSQL and REST', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let app: INestApplication;
  let ws: string;
  let previousUrl: string | undefined;
  let principal: 'owner' | 'member' | 'outsider' | 'token';
  /** What the service token of `principal === 'token'` was minted with. */
  let tokenPermissions: string[];
  let head: number;
  const deployedPrs = new Map<string, { head: string; number: number; ref: string }>();
  const owner = `release-owner-${randomUUID()}`;
  // The automatic actor addresses a repository by its durable intent key;
  // `workspace_repos` refuses any pairing whose hash is not the graph key.
  const REPO_KEY = 'github.com/acme/orders-api';
  const REPO_KEY_B = 'github.com/acme/reports-web';
  const member = `release-member-${randomUUID()}`;
  beforeAll(async () => {
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      controllers: [IntentReleaseController, IntentContextController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        ControlPlaneService,
        IntentReleaseService,
        {
          provide: IntentHandoffProcessor,
          inject: [PrismaService, IntentReleaseService],
          useFactory: (db: PrismaService, ledger: IntentReleaseService) =>
            new IntentHandoffProcessor(
              db,
              {
                async source(workspaceId: string, repoKey: string) {
                  const repo = await db.workspaceRepo.findFirstOrThrow({
                    where: { workspaceId, intentRepoKey: repoKey },
                  });
                  return {
                    repo,
                    owner: 'acme',
                    name: 'orders-api',
                    client: {
                      pullsForCommit: async (_o: string, _r: string, sha: string) => [deployedPrs.get(sha)!.number],
                    },
                  };
                },
                async pull(workspaceId: string, repoKey: string, number: number) {
                  const repo = await db.workspaceRepo.findFirstOrThrow({
                    where: { workspaceId, intentRepoKey: repoKey },
                  });
                  const observed = [...deployedPrs.values()].find((p) => p.number === number)!;
                  return {
                    repo,
                    pull: {
                      merged: true,
                      merged_at: '2026-09-01T00:00:00Z',
                      merge_commit_sha: observed.ref,
                      head: { sha: observed.head },
                      base: { ref: 'main', repo: { default_branch: 'main' } },
                    },
                  };
                },
                includes: async () => true,
              } as never,
              {} as never,
              {} as never,
              ledger,
            ),
        },
        IntentContextService,
        {
          provide: IntentDerivationService,
          useValue: {
            deriveNodeContext: async () => ({
              applicable: [],
              evidence: { available: false, repos: [], items: [] },
              truncated: false,
              limits: [],
              queriesUsed: 0,
              matchedFeatureIds: [],
            }),
          },
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          req.user = { id: principal === 'member' ? member : principal === 'outsider' ? 'outsider' : owner };
          if (principal === 'token') {
            req.serviceTokenWorkspaceId = ws;
            req.serviceTokenPermissions = tokenPermissions;
          }
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(async () => {
    principal = 'owner';
    tokenPermissions = ['intent:read', 'intent:propose'];
    head = 0;
    const workspace = await prisma.workspace.create({
      data: {
        name: 'release-test',
        slug: `release-${randomUUID()}`,
        intentEnabled: true,
        intentReleaseTrigger: 'deploy',
      },
    });
    ws = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: ws, userId: owner, email: 'release-owner@example.test', role: 'owner' },
        { workspaceId: ws, userId: member, email: 'release-member@example.test', role: 'member' },
      ],
    });
    await prisma.workspaceRepo.createMany({
      data: [
        { workspaceId: ws, repoKey: graphRepoHashOf(REPO_KEY), repoName: 'orders-api', intentRepoKey: REPO_KEY },
        { workspaceId: ws, repoKey: graphRepoHashOf(REPO_KEY_B), repoName: 'reports-web', intentRepoKey: REPO_KEY_B },
      ],
    });
  });
  afterEach(async () => {
    await prisma.intentItem.updateMany({
      where: { workspaceId: ws },
      data: { proposedSuccessorOfId: null, supersededById: null },
    });
    await prisma.workspace.delete({ where: { id: ws } });
  });
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pool?.pool?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });
  const api = () => request(app.getHttpServer());
  const base = () => `/api/v1/workspaces/${ws}/intent`;
  async function item(id: string, authority: 'accepted' | 'candidate' = 'accepted') {
    return prisma.intentItem.create({
      data: {
        workspaceId: ws,
        id,
        kind: 'business_rule',
        authority,
        title: `Rule ${id}`,
        statement: `The rule ${id} applies.`,
        createdBy: owner,
        updatedBy: owner,
      },
    });
  }
  async function replace(oldId: string, newId: string) {
    await prisma.$transaction([
      prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId: ws, id: oldId } },
        data: { authority: 'superseded', supersededById: newId, version: { increment: 1 } },
      }),
      prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId: ws, id: newId } },
        data: { proposedSuccessorOfId: oldId },
      }),
    ]);
  }
  async function preview(id: string) {
    return (await api().get(`${base()}/items/${id}/release-preview`).expect(200)).body;
  }
  async function deliver(ids: string[], extra = {}) {
    const included = await Promise.all(
      ids.map(async (itemId) => ({ itemId, contentHash: (await preview(itemId)).contentHash })),
    );
    const body = {
      idempotencyKey: randomUUID(),
      expectedHeadSeq: head,
      deliveredRef: `deploy-${randomUUID()}`,
      included,
      reason: 'Verified user availability',
      ...extra,
    };
    const result = await api().post(`${base()}/releases`).send(body).expect(201);
    head = result.body.headSeq;
    return { body, response: result.body };
  }
  /** One CI step after a production deploy (amendment §3.2): trailers, a ref, and the deployment's own identity. */
  async function deploy(trailers: string, extra: Record<string, unknown> = {}) {
    const repoKey = typeof extra.repoKey === 'string' ? extra.repoKey : REPO_KEY;
    const refs = (key: string) =>
      (
        trailers
          .split('\n')
          .find((l) => l.startsWith(key))
          ?.split(':')
          .slice(1)
          .join(':')
          .trim() ?? ''
      )
        .split(',')
        .filter(Boolean)
        .map((v) => {
          const [itemId, version] = v.trim().split('@');
          return { itemId, version: Number(version) };
        });
    const id = randomUUID();
    const number = deployedPrs.size + 1;
    const deliveredRef =
      typeof extra.deliveredRef === 'string' ? extra.deliveredRef : randomUUID().replaceAll('-', '').padEnd(40, 'a');
    const input = SaveIntentHandoffSchema.parse({
      id,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      repoKey,
      headSha: 'b'.repeat(40),
      prNumber: number,
      bindings: [],
      delivers: refs('Coredoc-Intent-Delivers'),
      retires: refs('Coredoc-Intent-Retires'),
    });
    if (await prisma.workspaceRepo.count({ where: { workspaceId: ws, intentRepoKey: repoKey } })) {
      await new IntentHandoffService(prisma as unknown as PrismaService).save(ws, { id: owner, role: 'owner' }, input);
    }
    deployedPrs.set(deliveredRef, { head: input.headSha, number, ref: deliveredRef });
    const body = {
      kind: 'release',
      repoKey,
      deliveredRef,
      deployId: randomUUID(),
      deployedAt: new Date().toISOString(),
      handoffId: id,
      ...extra,
    };
    const response = await api().post(`${base()}/releases`).send(body);
    if (response.status === 201) head = response.body.headSeq;
    return { body, response };
  }
  const delivers = (...ids: string[]) => `Coredoc-Intent-Delivers: ${ids.map((id) => `${id}@1`).join(', ')}`;

  async function plan(id: string, action = '') {
    const body = {
      itemId: id,
      idempotencyKey: randomUUID(),
      expectedHeadSeq: head,
      reason: 'Reviewed task decision',
      ...(action ? {} : { expectedVersion: (await preview(id)).version }),
    };
    const result = await api().post(`${base()}/items/${id}/plan${action}`).send(body).expect(201);
    head = result.body.headSeq;
  }
  async function rollback(seq: number) {
    const result = await api()
      .post(`${base()}/releases/${seq}/rollback`)
      .send({ releaseSeq: seq, idempotencyKey: randomUUID(), expectedHeadSeq: head, reason: 'Production restored' })
      .expect(201);
    head = result.body.headSeq;
    return result.body;
  }

  it('passes the actual owner role through REST and records the owner identity', async () => {
    await item('br-owner');
    const spy = vi.spyOn(app.get(IntentReleaseService), 'record');
    try {
      await deliver(['br-owner']);
      // Fourth argument: a user session is the `maintainer` actor (amendment §3.2).
      expect(spy).toHaveBeenCalledWith(ws, { id: owner, role: 'owner' }, expect.any(Object), 'maintainer');
      expect((await prisma.intentReleaseEvent.findFirstOrThrow({ where: { workspaceId: ws } })).recordedBy).toBe(owner);
    } finally {
      spy.mockRestore();
    }
  });
  it('batch previews preserve transitive blockers, order and one shared head', async () => {
    for (const id of ['br-a', 'br-b', 'br-c']) await item(id);
    await replace('br-a', 'br-b');
    await replace('br-b', 'br-c');
    await deliver(['br-c']);
    const result = await api()
      .post(`${base()}/items/release-preview`)
      .send({ itemIds: ['br-c', 'br-a'] })
      .expect(201);
    expect(result.body.map((p: { itemId: string }) => p.itemId)).toEqual(['br-c', 'br-a']);
    expect(result.body.every((p: { headSeq: number }) => p.headSeq === head)).toBe(true);
    expect(result.body[1].deliveryImpact.blockingSuccessors).toEqual([{ itemId: 'br-c', title: 'Rule br-c' }]);
    expect(result.body[0].deliveryImpact.ancestors).toEqual(['br-a', 'br-b']);
    const listed = await api().get(`${base()}/releases`).expect(200);
    expect(listed.body.entries[0].titles['br-c']).toBe('Rule br-c');
    await api()
      .post(`${base()}/items/release-preview`)
      .send({ itemIds: ['br-missing'] })
      .expect(404);
    await api()
      .post(`${base()}/items/release-preview`)
      .send({ itemIds: Array(201).fill('br-c') })
      .expect(400);
  });
  it('serializes a sourced release preview using only public provenance fields', async () => {
    await item('br-sourced');
    await prisma.intentItemSource.create({
      data: {
        workspaceId: ws,
        itemId: 'br-sourced',
        kind: 'spec',
        ref: 'docs/approved.md',
        localId: 'BR-1',
        revision: 'rev-one',
        locator: 'Rules',
        title: 'Approved behaviour',
        url: 'https://example.test/spec',
      },
    });
    const result = await preview('br-sourced');
    expect(result.sources).toEqual([
      {
        kind: 'spec',
        ref: 'docs/approved.md',
        localId: 'BR-1',
        revision: 'rev-one',
        locator: 'Rules',
        title: 'Approved behaviour',
        url: 'https://example.test/spec',
      },
    ]);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.content).toEqual(
      expect.objectContaining({ title: expect.any(String), statement: expect.any(String), kind: 'business_rule' }),
    );
  });

  it('distinguishes approval from a plan; cancels and reinstates without authority changes', async () => {
    await item('br-a');
    await item('br-b');
    await deliver(['br-a']);
    await replace('br-a', 'br-b');
    expect((await preview('br-b')).effectivity).toBe('unknown');
    await plan('br-b');
    expect((await preview('br-b')).effectivity).toBe('planned');
    await plan('br-b', '/withdraw');
    expect((await preview('br-b')).effectivity).toBe('withdrawn');
    expect((await preview('br-a')).effectivity).toBe('effective');
    await plan('br-b', '/reinstate');
    expect((await preview('br-b')).effectivity).toBe('planned');
    expect((await preview('br-b')).authority).toBe('accepted');
  });

  it('delivers A to C through B, preserves X, and rolls back through intervening plan events', async () => {
    for (const id of ['br-a', 'br-b', 'br-c', 'br-x', 'br-y']) await item(id);
    const first = await deliver(['br-a', 'br-x']);
    await plan('br-b');
    await replace('br-a', 'br-b');
    await plan('br-c');
    await replace('br-b', 'br-c');
    await plan('br-y');
    expect((await preview('br-c')).deliveryImpact).toEqual({
      ancestors: ['br-a', 'br-b'],
      replaces: [{ itemId: 'br-a', title: 'Rule br-a' }],
      blockingSuccessors: [],
    });
    const second = await deliver(['br-c']);
    expect((await preview('br-a')).deliveryImpact.blockingSuccessors).toEqual([{ itemId: 'br-c', title: 'Rule br-c' }]);
    expect((await preview('br-a')).effectivity).toBe('not_effective');
    expect((await preview('br-b')).effectivity).toBe('not_effective');
    expect((await preview('br-c')).effectivity).toBe('effective');
    expect((await preview('br-x')).effectivity).toBe('effective');
    await plan('br-y', '/withdraw');
    await rollback(second.response.event.seq);
    expect((await preview('br-a')).effectivity).toBe('effective');
    expect((await preview('br-c')).effectivity).toBe('planned');
    expect((await preview('br-y')).effectivity).toBe('withdrawn');
    const last = await rollback(first.response.event.seq);
    expect(last.currentRelease).toBeNull();
    expect((await preview('br-a')).effectivity).toBe('unknown');
  });

  it('filters the browse index by recorded state before paging, including live superseded rules', async () => {
    for (const id of ['br-a', 'br-b', 'br-c', 'br-unknown']) await item(id);
    await deliver(['br-a']);
    await replace('br-a', 'br-b');
    await plan('br-b');
    await plan('br-c');
    const index = new IntentItemService(prisma as unknown as PrismaService);
    const live = await index.listItems(
      ws,
      { production: 'true', authorities: ['accepted'], effectivity: 'effective' },
      1,
    );
    expect(live.items).toMatchObject([{ id: 'br-a', authority: 'superseded', effectivity: 'effective' }]);
    const planned = await index.listItems(ws, { production: 'true', effectivity: 'planned' }, 1);
    expect(planned.items.map((row) => row.id)).toEqual(['br-b']);
    const next = await index.listItems(
      ws,
      { production: 'true', effectivity: 'planned', cursor: planned.nextCursor! },
      1,
    );
    expect(next.items.map((row) => row.id)).toEqual(['br-c']);
    expect(next.nextCursor).toBeNull();
    const unknown = await index.listItems(ws, { effectivity: 'unknown' }, 100);
    expect(unknown.items.map((row) => row.id)).toEqual(['br-unknown']);
    const legacy = await index.listItems(ws, { authorities: ['accepted'] }, 100);
    expect(legacy.items.some((row) => row.id === 'br-a')).toBe(false);
    expect(legacy.items[0]).not.toHaveProperty('effectivity');
    await plan('br-c', '/withdraw');
    expect((await index.listItems(ws, { effectivity: 'withdrawn' }, 100)).items.map((row) => row.id)).toEqual(['br-c']);
  });

  it('production-aware discovery includes a superseded effective predecessor before selection', async () => {
    await item('br-a');
    await item('br-b');
    await item('br-unrelated');
    await deliver(['br-a']);
    await replace('br-a', 'br-b');
    await plan('br-b');
    const ordinary = (await api().get(`${base()}/context`).query({ mode: 'list', limit: 20 }).expect(200)).body;
    expect(ordinary.entries.map((v: { id: string }) => v.id)).not.toContain('br-a');
    expect(ordinary.currentRelease).toBeUndefined();
    const result = (await api().get(`${base()}/context`).query({ effectivity: true, limit: 20 }).expect(200)).body;
    expect(result.matches.find((v: { id: string }) => v.id === 'br-a')).toMatchObject({
      authority: 'superseded',
      effectivity: 'effective',
      relation: { replacedBy: 'br-b' },
    });
    expect(result.matches.find((v: { id: string }) => v.id === 'br-b')).toMatchObject({
      effectivity: 'planned',
      relation: { replaces: 'br-a' },
    });
    expect(result.currentRelease.seq).toBe(1);
    const narrow = (
      await api().get(`${base()}/context`).query({ effectivity: true, query: 'br-unrelated' }).expect(200)
    ).body;
    expect(narrow.matches.map((v: { id: string }) => v.id)).toEqual(['br-unrelated']);
  });

  it('replays durably after replay-cache retention and refuses late or changed requests', async () => {
    await item('br-a');
    const first = await deliver(['br-a']);
    await item('br-b');
    await plan('br-b');
    await prisma.intentMutationRequest.deleteMany({ where: { workspaceId: ws } });
    const replay = await api().post(`${base()}/releases`).send(first.body).expect(201);
    expect(replay.body).toEqual(first.response);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(2);
    const changed = await api()
      .post(`${base()}/releases`)
      .send({ ...first.body, reason: 'Different request' })
      .expect(409);
    expect(changed.body.code).toBe('idempotency_request_conflict');
    const stale = await api()
      .post(`${base()}/releases`)
      .send({ ...first.body, idempotencyKey: randomUUID() })
      .expect(409);
    expect(stale.body.code).toBe('release_out_of_order');
    const duplicate = await api()
      .post(`${base()}/releases`)
      .send({ ...first.body, expectedHeadSeq: head, idempotencyKey: randomUUID() })
      .expect(409);
    expect(duplicate.body.code).toBe('release_ref_recorded');
  });

  it('serializes competing first events without losing either the head check or replay', async () => {
    await item('br-a');
    const contentHash = (await preview('br-a')).contentHash;
    const body = {
      idempotencyKey: randomUUID(),
      expectedHeadSeq: 0,
      deliveredRef: 'first',
      included: [{ itemId: 'br-a', contentHash }],
      reason: 'Verified delivery',
    };
    const bodies = [body, { ...body, idempotencyKey: randomUUID(), deliveredRef: 'second' }];
    const results = await Promise.all(bodies.map((b) => api().post(`${base()}/releases`).send(b)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(1);
    const winner = results.findIndex((r) => r.status === 201);
    expect((await api().post(`${base()}/releases`).send(bodies[winner]).expect(201)).body).toEqual(
      results[winner]?.body,
    );
  });

  it('refuses candidates, changed content, conflicting chains and include/retire overlap atomically', async () => {
    await item('br-a');
    await item('br-b');
    await item('br-candidate', 'candidate');
    await replace('br-a', 'br-b');
    const a = await preview('br-a'),
      b = await preview('br-b'),
      c = await preview('br-candidate');
    for (const [included, retired, code] of [
      [[{ itemId: 'br-candidate', contentHash: c.contentHash }], [], 'release_item_not_releasable'],
      [[{ itemId: 'br-b', contentHash: '0'.repeat(64) }], [], 'release_content_mismatch'],
      [
        [
          { itemId: 'br-a', contentHash: a.contentHash },
          { itemId: 'br-b', contentHash: b.contentHash },
        ],
        [],
        'release_conflicting_items',
      ],
      [[{ itemId: 'br-b', contentHash: b.contentHash }], ['br-b'], 'release_conflicting_items'],
    ] as const) {
      const res = await api().post(`${base()}/releases`).send({
        idempotencyKey: randomUUID(),
        expectedHeadSeq: 0,
        deliveredRef: 'refused',
        included,
        retired,
        reason: 'Reviewed release',
      });
      expect(res.body.code).toBe(code);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await prisma.intentMutationRequest.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('refuses reinstating a superseded plan even when its successor has no plan', async () => {
    await item('br-b');
    await item('br-c');
    await plan('br-b');
    await plan('br-b', '/withdraw');
    await replace('br-b', 'br-c');
    const result = await api()
      .post(`${base()}/items/br-b/plan/reinstate`)
      .send({ itemId: 'br-b', idempotencyKey: randomUUID(), expectedHeadSeq: head, reason: 'Restore plan' })
      .expect(400);
    expect(result.body.code).toBe('plan_not_plannable');
    expect((await preview('br-b')).effectivity).toBe('withdrawn');
  });

  it('requires explicit retirement when a new delivery restores an older revision', async () => {
    await item('br-a');
    await item('br-b');
    await replace('br-a', 'br-b');
    await deliver(['br-b']);
    const contentHash = (await preview('br-a')).contentHash;
    const ambiguous = await api()
      .post(`${base()}/releases`)
      .send({
        idempotencyKey: randomUUID(),
        expectedHeadSeq: head,
        deliveredRef: 'restore-a',
        included: [{ itemId: 'br-a', contentHash }],
        reason: 'Older behaviour restored',
      })
      .expect(400);
    expect(ambiguous.body.code).toBe('release_conflicting_items');
    await deliver(['br-a'], { retired: ['br-b'] });
    expect((await preview('br-a')).effectivity).toBe('effective');
    expect((await preview('br-b')).effectivity).toBe('not_effective');
  });

  it('pages durable history and rejects a non-current rollback without changing the head', async () => {
    await item('br-a');
    await item('br-b');
    const first = await deliver(['br-a']);
    const second = await deliver(['br-b']);
    const result = await api()
      .post(`${base()}/releases/1/rollback`)
      .send({
        idempotencyKey: randomUUID(),
        expectedHeadSeq: head,
        releaseSeq: first.response.event.seq,
        reason: 'Old release',
      })
      .expect(409);
    expect(result.body.code).toBe('release_not_current');
    const page = (await api().get(`${base()}/releases`).query({ limit: 1 }).expect(200)).body;
    expect(page.entries.map((e: { seq: number }) => e.seq)).toEqual([second.response.event.seq]);
    const next = (await api().get(`${base()}/releases`).query({ limit: 1, beforeSeq: page.nextBeforeSeq }).expect(200))
      .body;
    expect(next.entries.map((e: { seq: number }) => e.seq)).toEqual([first.response.event.seq]);
    expect(next.nextBeforeSeq).toBeNull();
    expect(next.headSeq).toBe(head);
  });

  it('accepts a baseline with the first head default and labels list-mode entries', async () => {
    await item('br-baseline');
    await item('br-unknown');
    const contentHash = (await preview('br-baseline')).contentHash;
    const result = await api()
      .post(`${base()}/releases`)
      .send({
        kind: 'baseline',
        idempotencyKey: randomUUID(),
        deliveredRef: 'initial-state',
        included: [{ itemId: 'br-baseline', contentHash }],
        reason: 'Verified starting state',
      })
      .expect(201);
    expect(result.body.headSeq).toBe(1);
    const listed = (await api().get(`${base()}/context`).query({ mode: 'list', effectivity: true }).expect(200)).body;
    expect(listed.entries.find((e: { id: string }) => e.id === 'br-baseline')).toMatchObject({
      effectivity: 'effective',
    });
    expect(listed.entries.find((e: { id: string }) => e.id === 'br-unknown')).toMatchObject({ effectivity: 'unknown' });
    expect(listed.currentRelease.deliveredRef).toBe('initial-state');
  });

  it('names invalid plan transitions and missing releases without appending events', async () => {
    await item('br-planned');
    await item('br-candidate', 'candidate');
    await item('br-live');
    await deliver(['br-live']);
    for (const itemId of ['br-candidate', 'br-live']) {
      const result = await api()
        .post(`${base()}/items/${itemId}/plan`)
        .send({
          idempotencyKey: randomUUID(),
          expectedHeadSeq: head,
          itemId,
          expectedVersion: 1,
          reason: 'Plan requested',
        })
        .expect(400);
      expect(result.body.code).toBe('plan_not_plannable');
    }
    for (const [action, code] of [
      ['withdraw', 'plan_not_active'],
      ['reinstate', 'plan_not_withdrawn'],
    ]) {
      const result = await api()
        .post(`${base()}/items/br-planned/plan/${action}`)
        .send({
          idempotencyKey: randomUUID(),
          expectedHeadSeq: head,
          itemId: 'br-planned',
          reason: 'Plan changed',
        })
        .expect(400);
      expect(result.body.code).toBe(code);
    }
    const absent = await api()
      .post(`${base()}/releases/999/rollback`)
      .send({
        idempotencyKey: randomUUID(),
        expectedHeadSeq: head,
        releaseSeq: 999,
        reason: 'Undo delivery',
      })
      .expect(404);
    expect(absent.body.code).toBe('release_not_found');
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(1);
    await plan('br-planned');
    await item('br-successor');
    await replace('br-planned', 'br-successor');
    await plan('br-planned', '/withdraw');
    expect((await preview('br-planned')).effectivity).toBe('withdrawn');
  });

  it('admits member writes (BR-1), refuses token writes, permits read tokens, and isolates workspaces', async () => {
    await item('br-a');
    const body = {
      itemId: 'br-a',
      expectedVersion: 1,
      expectedHeadSeq: 0,
      idempotencyKey: randomUUID(),
      reason: 'Plan change',
    };
    principal = 'token';
    await api().get(`${base()}/items/br-a/release-preview`).expect(200);
    await api().post(`${base()}/items/br-a/plan`).send(body).expect(403);
    principal = 'outsider';
    await api().get(`${base()}/releases`).expect(403);
    principal = 'owner';
    await api().get(`${base()}/items/nonexistent/release-preview`).expect(404);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(0);
    principal = 'member';
    await api().post(`${base()}/items/br-a/plan`).send(body).expect(201);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(1);
  });
  it('refuses an automatic record on a ref a maintainer already recorded by hand', async () => {
    await item('br-by-hand');
    await item('br-by-ci');
    const ref = 'd'.repeat(40);
    await deliver(['br-by-hand'], { deliveredRef: ref });
    const { response } = await deploy(delivers('br-by-ci'), { deliveredRef: ref });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe(IntentErrorCode.ReleaseRefRecorded);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws, kind: 'release' } })).toBe(1);
  });
  it('records deployment evidence using declarations from a session handoff', async () => {
    await item('br-shipped');
    await item('br-gone');
    const { body, response } = await deploy(`${delivers('br-shipped')}\nCoredoc-Intent-Retires: br-gone@1`);
    expect(response.status).toBe(201);
    const stored = await prisma.intentReleaseEvent.findFirstOrThrow({ where: { workspaceId: ws } });
    // One deploy ships several PRs (BR-5): the PR is part of the delivery identity.
    const prNumber = (stored.data as { pr: { number: number } }).pr.number;
    expect(stored.idempotencyKey).toBe(`${REPO_KEY}:${body.deliveredRef}:${body.deployId}:${prNumber}`);
    // No reason typed: the system default names the delivery, not the modal.
    expect(stored.reason).toMatch(/^PR /);
    expect(stored.data).toMatchObject({
      included: ['br-shipped'],
      retired: ['br-gone'],
      repoKey: REPO_KEY,
      deployId: body.deployId,
      orderingToken: body.deployedAt,
      // Posted by the owner's session here: a person is the maintainer actor; the CI token case follows.
      actorKind: 'maintainer',
    });
    // The hash is the server's own, resolved from the named version.
    expect((stored.data as { contentHashes: Record<string, string> }).contentHashes['br-shipped']).toBe(
      (await preview('br-shipped')).contentHash,
    );
    expect((await preview('br-shipped')).effectivity).toBe('effective');
    expect((await preview('br-gone')).effectivity).toBe('not_effective');
    const listed = (await api().get(`${base()}/releases`).expect(200)).body;
    expect(listed.entries[0]).toMatchObject({ actorKind: 'maintainer', orderingToken: body.deployedAt });
    expect(listed.currentRelease).toMatchObject({ repoKey: REPO_KEY, orderingToken: body.deployedAt });
  });

  it('records a real delivery with the unified CI token over REST', async () => {
    await item('br-shipped');
    await prisma.workspace.update({ where: { id: ws }, data: { intentReleaseTrigger: 'deploy' } });
    principal = 'token';
    tokenPermissions = [...CI_TOKEN_PERMISSIONS];
    const { body, response } = await deploy(delivers('br-shipped'));
    expect(response.status).toBe(201);
    const stored = await prisma.intentReleaseEvent.findFirstOrThrow({ where: { workspaceId: ws } });
    // The fourth `record` argument, end to end: a service token is the `ci` actor.
    expect(stored.data).toMatchObject({ included: ['br-shipped'], repoKey: REPO_KEY, actorKind: 'ci' });
    expect(stored.deliveredRef).toBe(body.deliveredRef);
  });

  it('refuses the maintainer body from a service token, trailers or nothing', async () => {
    await item('br-shipped');
    await prisma.workspace.update({ where: { id: ws }, data: { intentReleaseTrigger: 'deploy' } });
    const contentHash = (await preview('br-shipped')).contentHash;
    principal = 'token';
    tokenPermissions = ['intent:release'];
    // The human body defaults `kind` to release; admitting it would bypass the
    // trailers, the version check and the per-repository ordering token.
    const refused = await api()
      .post(`${base()}/releases`)
      .send({
        idempotencyKey: randomUUID(),
        expectedHeadSeq: 0,
        deliveredRef: 'typed-by-a-ci-token',
        included: [{ itemId: 'br-shipped', contentHash }],
        retired: [],
      })
      .expect(403);
    expect(refused.body.code).toBe('release_mode_forbids');
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it.each([
    ['a legacy wildcard token', ['*']],
    ['a token minted for reads and proposals', ['intent:read', 'intent:propose']],
  ])('refuses POST /releases to %s before any body is read', async (_case, permissions) => {
    await prisma.workspace.update({ where: { id: ws }, data: { intentReleaseTrigger: 'deploy' } });
    principal = 'token';
    tokenPermissions = permissions;
    await api()
      .post(`${base()}/releases`)
      .send({
        kind: 'release',
        repoKey: REPO_KEY,
        deliveredRef: 'v1',
        deployId: 'run-1',
        deployedAt: new Date().toISOString(),
        trailers: 'Coredoc-Intent-Delivers: br-any@1',
      })
      .expect(403);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('refuses a whole six-id trailer for one stale version and writes nothing', async () => {
    const ids = ['br-1', 'br-2', 'br-3', 'br-4', 'br-5', 'br-6'];
    for (const id of ids) await item(id);
    await prisma.intentItem.update({
      where: { workspaceId_id: { workspaceId: ws, id: 'br-4' } },
      data: { version: 3 },
    });
    const { response } = await deploy(delivers(...ids));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('release_version_stale');
    expect(response.body.message).toContain('br-4@1 (current 3)');
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it.each([
    ['an id no item carries', 'br-absent', 404, 'release_item_unknown'],
    ['a repository outside the workspace', 'br-present', 400, 'unknown_repo_key'],
  ])('refuses %s and writes nothing', async (_case, itemId, status, code) => {
    await item('br-present');
    const { response } = await deploy(
      delivers(itemId),
      itemId === 'br-present' ? { repoKey: 'github.com/acme/other-repo' } : {},
    );
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('refuses a lost R1 retried after R2 with R1 own deployedAt, leaving R2 current', async () => {
    await item('br-old');
    await item('br-new');
    // R1 deployed first; its record step lost the response and never landed.
    const lost = {
      deliveredRef: '1111111111111111111111111111111111111111',
      deployId: 'run-1',
      deployedAt: '2026-09-11T09:00:00.000Z',
    };
    const r2 = await deploy(`${delivers('br-new')}\nCoredoc-Intent-Retires: br-old@1`, {
      deliveredRef: '2222222222222222222222222222222222222222',
      deployId: 'run-2',
      deployedAt: '2026-09-11T10:00:00.000Z',
    });
    expect(r2.response.status).toBe(201);
    // The retry carries the DEPLOYMENT's pair, not a fresh clock reading.
    const retry = await deploy(delivers('br-old'), lost);
    expect(retry.response.status).toBe(409);
    expect(retry.response.body.code).toBe('release_out_of_order');
    expect(retry.response.body.message).toContain('2026-09-11T10:00:00.000Z');
    expect(retry.response.body.message).toContain('2026-09-11T09:00:00.000Z');
    const listed = (await api().get(`${base()}/releases`).expect(200)).body;
    expect(listed.currentRelease.deliveredRef).toBe('2222222222222222222222222222222222222222');
    expect(listed.entries).toHaveLength(1);
    expect((await preview('br-old')).effectivity).toBe('not_effective');
  });

  it('replays one delivery on retry and records a second one for a re-deploy of the same ref', async () => {
    await item('br-a');
    const first = await deploy(delivers('br-a'));
    expect(first.response.status).toBe(201);
    const retried = await api().post(`${base()}/releases`).send(first.body).expect(201);
    expect(retried.body).toEqual(first.response.body);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(1);
    await rollback(first.response.body.event.seq);
    // Same artifact, a NEW deploy run: a second release, not a replay.
    const again = await deploy(delivers('br-a'), {
      deliveredRef: first.body.deliveredRef,
      deployId: `${first.body.deployId}-again`,
      deployedAt: new Date(Date.parse(first.body.deployedAt) + 60_000).toISOString(),
    });
    expect(again.response.status).toBe(201);
    expect(again.response.body.event.seq).toBe(3);
    expect((await preview('br-a')).effectivity).toBe('effective');
  });

  it('refuses a release whose item version moves between the pre-check and the locked check', async () => {
    await item('br-a');
    // The race, made deterministic: the trailer versions are first compared against an
    // UNLOCKED read, so a review that commits v2 after that read and before the rows are
    // locked used to slip through and record a delivery naming `@1`.
    const service = app.get(IntentReleaseService) as unknown as {
      validateEvent: (...args: never[]) => Promise<unknown>;
    };
    const original = service.validateEvent.bind(service);
    const spy = vi.spyOn(service, 'validateEvent').mockImplementation(async (...args) => {
      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId: ws, id: 'br-a' } },
        data: { version: 2 },
      });
      return original(...args);
    });
    try {
      const { response } = await deploy(delivers('br-a'));
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('release_version_stale');
      expect(response.body.message).toContain('br-a@1 (current 2)');
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('records and replays a delivery whose identity is longer than the idempotency-key column', async () => {
    await item('br-a');
    // 26-character repo key + a 150-character ref + a 120-character deploy id: the plain
    // `<repoKey>:<deliveredRef>:<deployId>` composition is far past VARCHAR(200).
    const identity = { deliveredRef: 'a'.repeat(40), deployId: 'b'.repeat(180) };
    const first = await deploy(delivers('br-a'), identity);
    expect(first.response.status).toBe(201);
    const replay = await api().post(`${base()}/releases`).send(first.body).expect(201);
    expect(replay.body).toEqual(first.response.body);
    const rows = await prisma.intentReleaseEvent.findMany({ where: { workspaceId: ws } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey.length).toBeLessThanOrEqual(200);
    expect(rows[0]?.deliveredRef).toBe(identity.deliveredRef);
    expect((await preview('br-a')).effectivity).toBe('effective');
  });

  it('fills the system reason for a human record and a plan withdrawal that type none', async () => {
    await item('br-a');
    const contentHash = (await preview('br-a')).contentHash;
    await api()
      .post(`${base()}/releases`)
      .send({
        idempotencyKey: randomUUID(),
        expectedHeadSeq: 0,
        deliveredRef: 'typed-by-hand',
        included: [{ itemId: 'br-a', contentHash }],
      })
      .expect(201);
    head = 1;
    await item('br-planned');
    await plan('br-planned');
    await api()
      .post(`${base()}/items/br-planned/plan/withdraw`)
      .send({ itemId: 'br-planned', idempotencyKey: randomUUID(), expectedHeadSeq: head })
      .expect(201);
    const reasons = await prisma.intentReleaseEvent.findMany({ where: { workspaceId: ws }, orderBy: { seq: 'asc' } });
    expect(reasons.map((row) => row.reason)).toEqual(['manual', 'Reviewed task decision', 'manual']);
  });
  it('AC-4: one deploy without handoffId records every included merged PR; deliveries list both repos', async () => {
    await item('br-multi-1');
    await item('br-multi-2');
    const deliveredRef = 'f'.repeat(40);
    const merged = async (itemId: string, mergedAt: string) => {
      const number = deployedPrs.size + 1;
      const mergeCommit = randomUUID().replaceAll('-', '').padEnd(40, 'c');
      const input = SaveIntentHandoffSchema.parse({
        id: randomUUID(),
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        repoKey: REPO_KEY,
        headSha: 'b'.repeat(40),
        prNumber: number,
        bindings: [],
        delivers: [{ itemId, version: 1 }],
      });
      await new IntentHandoffService(prisma as unknown as PrismaService).save(ws, { id: owner, role: 'owner' }, input);
      // The worker's merge observation, which is what makes a handoff deployable.
      await prisma.intentHandoff.update({
        where: { id: input.id },
        data: { mergeCommit, mergedAt: new Date(mergedAt), deliveryReason: 'awaiting_production_deploy' },
      });
      deployedPrs.set(mergeCommit, { head: input.headSha, number, ref: mergeCommit });
      return { id: input.id, number };
    };
    // Saved newest first: the record order must follow the merges, not the saves.
    const later = await merged('br-multi-2', '2026-09-11T10:00:00Z');
    const earlier = await merged('br-multi-1', '2026-09-11T09:00:00Z');
    const body = {
      kind: 'release',
      repoKey: REPO_KEY,
      deliveredRef,
      deployId: 'multi-run',
      deployedAt: '2026-09-11T11:00:00.000Z',
    };
    const response = (await api().post(`${base()}/releases`).send(body).expect(201)).body;
    expect(response.deliveries).toEqual([
      expect.objectContaining({ handoffId: earlier.id, pr: earlier.number, outcome: 'recorded', seq: 1 }),
      expect.objectContaining({ handoffId: later.id, pr: later.number, outcome: 'recorded', seq: 2 }),
    ]);
    const events = await prisma.intentReleaseEvent.findMany({ where: { workspaceId: ws }, orderBy: { seq: 'asc' } });
    expect(events.map((e) => (e.data as { pr: { number: number } }).pr.number)).toEqual([earlier.number, later.number]);
    expect(events.every((e) => e.deliveredRef === deliveredRef)).toBe(true);
    const states = await prisma.intentHandoff.findMany({ where: { workspaceId: ws }, select: { deliveryState: true } });
    expect(states.map((row) => row.deliveryState)).toEqual(['recorded', 'recorded']);
    // A retried step of the same deployment replays both instead of answering no_delivery.
    expect((await api().post(`${base()}/releases`).send(body).expect(201)).body).toEqual(response);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(2);

    // The same item delivered from a second repository: effective after the first delivery,
    // and both deliveries are listed per repository.
    const context = async () =>
      (
        await api().get(`${base()}/context`).query({ effectivity: true, query: 'br-multi-1' }).expect(200)
      ).body.matches.find((v: { id: string }) => v.id === 'br-multi-1');
    expect(await context()).toMatchObject({
      effectivity: 'effective',
      deliveries: [{ repoKey: REPO_KEY, pr: { repoKey: REPO_KEY, number: earlier.number }, seq: 1, deliveredRef }],
    });
    const fromB = await deploy(delivers('br-multi-1'), {
      repoKey: REPO_KEY_B,
      deployId: 'b-run',
      deployedAt: '2026-09-11T12:00:00.000Z',
    });
    expect(fromB.response.status).toBe(201);
    const both = await context();
    expect(both.effectivity).toBe('effective');
    expect(both.deliveries.map((d: { repoKey: string; seq: number }) => [d.repoKey, d.seq])).toEqual([
      [REPO_KEY, 1],
      [REPO_KEY_B, 3],
    ]);
    expect(both.deliveries[1]).toMatchObject({
      deliveredRef: fromB.body.deliveredRef,
      orderingToken: fromB.body.deployedAt,
    });
  });

  it('orders a late delivery against its own repository, never against the workspace head', async () => {
    for (const id of ['br-a1', 'br-a2', 'br-b1', 'br-b2']) await item(id);
    const at = (hour: string) => `2026-09-11T${hour}:00:00.000Z`;
    const a2 = await deploy(delivers('br-a1'), {
      deliveredRef: '4444444444444444444444444444444444444444',
      deployId: 'a2',
      deployedAt: at('10'),
    });
    expect(a2.response.status).toBe(201);
    // Another repository releases afterwards: it becomes the workspace-wide
    // current release, and says NOTHING about orders-api's ordering.
    const b1 = await deploy(delivers('br-b1'), {
      repoKey: REPO_KEY_B,
      deliveredRef: '6666666666666666666666666666666666666666',
      deployId: 'b1',
      deployedAt: at('11'),
    });
    expect(b1.response.status).toBe(201);
    // Late on an item a2 already delivered (BR-6: ordering is per item).
    const lateA1 = await deploy(delivers('br-a1'), {
      deliveredRef: '3333333333333333333333333333333333333333',
      deployId: 'a1',
      deployedAt: at('09'),
    });
    expect(lateA1.response.status).toBe(409);
    expect(lateA1.response.body.code).toBe('release_out_of_order');
    expect(lateA1.response.body.message).toContain(at('10'));
    expect(lateA1.response.body.message).toContain('br-a1');
    // The inverse: a token older than ANOTHER repository's current release, but
    // newer than this repository's own, is a legitimate delivery.
    const a3 = await deploy(delivers('br-a2'), {
      deliveredRef: '5555555555555555555555555555555555555555',
      deployId: 'a3',
      deployedAt: at('13'),
    });
    expect(a3.response.status).toBe(201);
    const b2 = await deploy(delivers('br-b2'), {
      repoKey: REPO_KEY_B,
      deliveredRef: '7777777777777777777777777777777777777777',
      deployId: 'b2',
      deployedAt: at('12'),
    });
    expect(b2.response.status).toBe(201);
    const listed = (await api().get(`${base()}/releases`).expect(200)).body;
    expect(listed.currentRelease.deliveredRef).toBe('7777777777777777777777777777777777777777');
    expect(listed.entries.map((entry: { deliveredRef: string }) => entry.deliveredRef)).toEqual([
      '7777777777777777777777777777777777777777',
      '5555555555555555555555555555555555555555',
      '6666666666666666666666666666666666666666',
      '4444444444444444444444444444444444444444',
    ]);
  });

  it('orders a late successor against a newer delivery of the rule it replaces', async () => {
    await item('br-old-rule');
    await item('br-new-rule');
    const at = (hour: string) => `2026-09-12T${hour}:00:00.000Z`;
    const old = await deploy(delivers('br-old-rule'), {
      deployId: 'old',
      deployedAt: at('10'),
    });
    expect(old.response.status).toBe(201);
    await replace('br-old-rule', 'br-new-rule');
    // Delivering the successor retires its predecessor, so the predecessor's newer
    // delivery orders the successor too.
    const late = await deploy(delivers('br-new-rule'), {
      deployId: 'new',
      deployedAt: at('09'),
    });
    expect(late.response.status).toBe(409);
    expect(late.response.body.code).toBe('release_out_of_order');
    expect(late.response.body.message).toContain('br-old-rule');
  });

  it('AC-5: Y records, then an earlier-merged X on a disjoint item records; a late shared item is refused', async () => {
    for (const id of ['br-x', 'br-y']) await item(id);
    const at = (hour: string) => `2026-09-20T${hour}:00:00.000Z`;
    const y = await deploy(delivers('br-y'), {
      deliveredRef: '8888888888888888888888888888888888888888',
      deployId: 'y',
      deployedAt: at('10'),
    });
    expect(y.response.status).toBe(201);
    const x = await deploy(delivers('br-x'), {
      deliveredRef: '9999999999999999999999999999999999999999',
      deployId: 'x',
      deployedAt: at('09'),
    });
    expect(x.response.status).toBe(201);
    expect((await preview('br-x')).effectivity).toBe('effective');
    expect((await preview('br-y')).effectivity).toBe('effective');
    const late = await deploy(`${delivers('br-x')}\nCoredoc-Intent-Retires: br-y@1`, {
      deliveredRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deployId: 'late',
      deployedAt: at('08'),
    });
    expect(late.response.status).toBe(409);
    expect(late.response.body.code).toBe('release_out_of_order');
    expect(late.response.body.message).toContain(at('09'));
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: ws } })).toBe(2);
  });
});
