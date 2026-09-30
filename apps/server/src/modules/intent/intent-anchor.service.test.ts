/**
 * `IntentAnchorService` against a REAL Ladybug fixture snapshot and an in-memory
 * control plane (spec §4.6, §7, issue 05 acceptance).
 *
 * The graph is real, because the whole point of the surface is that graph facts
 * are read rather than accepted from the caller — a stubbed repository could
 * agree with a resolver that got the property name wrong. The row store is a
 * small fake, because the row lifecycle is proven against real PostgreSQL in
 * `intent-anchor.postgres.integration.test.ts`; here it exists so preview and
 * commit can be compared on the SAME request without a database.
 *
 * Pool `forks` (apps/server vitest config): the Ladybug native module.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeType } from '@coredoc/core';
import {
  buildIntentGraphFixture,
  openIntentGraphFixture,
  type IntentGraphFixture,
  type OpenedIntentGraphFixture,
} from '@coredoc/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import type { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { IntentAnchorTargetService } from './intent-anchor-target.js';
import { IntentAnchorService } from './intent-anchor.service.js';
import { IntentOperation, hashIntentRequest, type IntentActor } from './intent-idempotency.js';

const WORKSPACE_ID = 'ws-1';
const VERSION_ID = 'v-2026-09-02';
const REPO_KEY = 'github.com/acme/orders-api';
const ACTOR: IntentActor = { id: 'user-1', role: 'owner' };

let directory: string;
let fixture: IntentGraphFixture;
let opened: OpenedIntentGraphFixture;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'coredoc-anchor-service-'));
  fixture = await buildIntentGraphFixture(join(directory, 'graph.ladybug'));
  opened = await openIntentGraphFixture(fixture.path, { readOnly: true });
});

afterAll(async () => {
  await opened?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

/* ------------------------------------------------------------ fake store --- */

interface FakeAnchor {
  id: bigint;
  workspaceId: string;
  itemId: string;
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
  rationale: string | null;
  createdBy: string;
  createdAt: Date;
}

interface Store {
  items: Record<string, { id: string; authority: string }>;
  anchors: FakeAnchor[];
  audits: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  /** A committed ledger row the replay peek finds, keyed by idempotency key. */
  committed: Record<string, { operation: string; requestHash: string; response: unknown }>;
  /** Every `FOR UPDATE` the service took, so the lock can be asserted, not assumed. */
  locks: string[];
}

function fakePrisma(store: Store): PrismaService {
  let nextId = 1n;
  const client = {
    intentItem: {
      async findUnique({ where }: { where: { workspaceId_id: { id: string } } }) {
        return store.items[where.workspaceId_id.id] ?? null;
      },
    },
    intentAnchor: {
      async findUnique({ where }: { where: { workspaceId_itemId_repoKey_nodeId: Omit<FakeAnchor, 'id'> } }) {
        const key = where.workspaceId_itemId_repoKey_nodeId;
        const found = store.anchors.find(
          (anchor) =>
            anchor.workspaceId === key.workspaceId &&
            anchor.itemId === key.itemId &&
            anchor.repoKey === key.repoKey &&
            anchor.nodeId === key.nodeId,
        );
        // A COPY, like a real read: the service compares the row it read to the
        // row it wrote, and a shared reference would make every refresh look
        // unchanged.
        return found ? { ...found } : null;
      },
      async create({ data }: { data: Omit<FakeAnchor, 'id' | 'createdAt'> }) {
        const anchor: FakeAnchor = { ...data, id: nextId++, createdAt: new Date('2026-09-02T00:00:00.000Z') };
        store.anchors.push(anchor);
        return anchor;
      },
      async update({ where, data }: { where: { id: bigint }; data: Partial<FakeAnchor> }) {
        const anchor = store.anchors.find((candidate) => candidate.id === where.id);
        if (!anchor) throw new Error('no such anchor');
        Object.assign(anchor, data);
        return { ...anchor };
      },
      async delete({ where }: { where: { id: bigint } }) {
        const index = store.anchors.findIndex((candidate) => candidate.id === where.id);
        const [removed] = store.anchors.splice(index, 1);
        return removed;
      },
    },
    intentMutationRequest: {
      async findUnique({ where }: { where: { workspaceId_idempotencyKey: { idempotencyKey: string } } }) {
        return store.committed[where.workspaceId_idempotencyKey.idempotencyKey] ?? null;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        store.ledger.push(data);
      },
    },
    intentAuditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        store.audits.push(data);
      },
    },
    // The item-row lock the accepted-only rule depends on. The fake cannot
    // BLOCK, so it records instead: the assertion this suite can make is that
    // the lock is taken before the authority is read.
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      if (strings.join('').includes('FOR UPDATE')) store.locks.push(String(values[1]));
      return [];
    },
    async $transaction<T>(run: (tx: unknown) => Promise<T>) {
      return run(client);
    },
  };
  return client as unknown as PrismaService;
}

function repoReader() {
  return {
    workspaceRepo: {
      async findMany() {
        return [
          { intentRepoKey: REPO_KEY, repoKey: fixture.repoA.repoHash, repoName: fixture.repoA.repoName },
          { intentRepoKey: null, repoKey: fixture.repoB.repoHash, repoName: fixture.repoB.repoName },
        ];
      },
    },
  };
}

function anchorService(store: Store): IntentAnchorService {
  const workspaceContext = {
    async withContextByWorkspaceId<T>(_workspaceId: string, callback: (context: never) => Promise<T>) {
      return callback({
        repository: opened.repository,
        scope: {},
        repos: [],
        versionId: VERSION_ID,
        graphBackend: 'file_snapshot',
      } as never);
    },
  } as unknown as WorkspaceMcpContextService;

  const prisma = fakePrisma(store);
  // The identity gate reads `workspaceRepo`, which the row fake does not model;
  // it is the one seam this suite stubs, because registration is the subject of
  // the PostgreSQL suite instead.
  Object.assign(prisma, repoReader());
  return new IntentAnchorService(prisma, new IntentAnchorTargetService(workspaceContext));
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(IntentPublicException);
  return (error as IntentPublicException).publicError;
}

let store: Store;
let service: IntentAnchorService;
let keySeed = 0;

function nextKey(): string {
  keySeed += 1;
  return `key-${keySeed}`;
}

beforeEach(() => {
  store = {
    items: {
      'br-admin-only': { id: 'br-admin-only', authority: 'accepted' },
      draft: { id: 'draft', authority: 'candidate' },
    },
    anchors: [],
    audits: [],
    ledger: [],
    committed: {},
    locks: [],
  };
  service = anchorService(store);
});

/* ----------------------------------------------------------------- tests --- */

describe('IntentAnchorService', () => {
  const guard = () => ({ repoKey: REPO_KEY, nodeId: fixture.repoA.guard });

  it('preview and add resolve the same target, and only add writes', async () => {
    const preview = await service.preview(WORKSPACE_ID, { itemId: 'br-admin-only', ...guard() });
    expect(preview.wouldCreate).toBe(true);
    expect(preview.existing).toBeNull();
    expect(store.anchors).toHaveLength(0);

    const added = await service.add(WORKSPACE_ID, ACTOR, {
      idempotencyKey: nextKey(),
      itemId: 'br-admin-only',
      ...guard(),
    });

    // Byte-for-byte the same graph facts: one resolver, two callers.
    expect({
      repoKey: added.anchor.repoKey,
      nodeId: added.anchor.nodeId,
      nodeType: added.anchor.nodeType,
      capturedVersionedId: added.anchor.capturedVersionedId,
    }).toEqual(preview.target);
    expect(added.anchor.capturedVersionedId).toBe(fixture.versionedIds[fixture.repoA.guard]);
    expect(added.anchor.nodeType).toBe(NodeType.Function);
    expect(added.created).toBe(true);
    expect(added.graphVersionId).toBe(VERSION_ID);
    expect(store.anchors).toHaveLength(1);
  });

  it('reports the stored baseline and drift on a preview of an existing anchor', async () => {
    await service.add(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() });
    const matched = await service.preview(WORKSPACE_ID, { itemId: 'br-admin-only', ...guard() });
    expect(matched.wouldCreate).toBe(false);
    expect(matched.drifted).toBe(false);
    expect(matched.existing?.capturedVersionedId).toBe(fixture.versionedIds[fixture.repoA.guard]);

    // Simulate the code moving under a captured anchor.
    (store.anchors[0] as FakeAnchor).capturedVersionedId = 'stale@0000';
    const drifted = await service.preview(WORKSPACE_ID, { itemId: 'br-admin-only', ...guard() });
    expect(drifted.drifted).toBe(true);
    expect(drifted.target.capturedVersionedId).toBe(fixture.versionedIds[fixture.repoA.guard]);
  });

  it('refresh re-captures the baseline from the snapshot and reports what changed', async () => {
    await service.add(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() });
    (store.anchors[0] as FakeAnchor).capturedVersionedId = 'stale@0000';

    const refreshed = await service.refresh(WORKSPACE_ID, ACTOR, {
      idempotencyKey: nextKey(),
      itemId: 'br-admin-only',
      ...guard(),
    });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.previousCapturedVersionedId).toBe('stale@0000');
    expect(refreshed.anchor.capturedVersionedId).toBe(fixture.versionedIds[fixture.repoA.guard]);
  });

  it('refuses refresh and remove for an identity the item does not carry', async () => {
    const missing = { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() };
    expect((await refusal(service.refresh(WORKSPACE_ID, ACTOR, missing))).code).toBe(IntentErrorCode.AnchorNotFound);
    expect((await refusal(service.remove(WORKSPACE_ID, ACTOR, { ...missing, idempotencyKey: nextKey() }))).code).toBe(
      IntentErrorCode.AnchorNotFound,
    );
  });

  it('removes without reading the graph, because the node is usually gone by then', async () => {
    await service.add(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() });
    const brokenGraph = new IntentAnchorService(
      Object.assign(fakePrisma(store), repoReader()),
      new IntentAnchorTargetService({
        withContextByWorkspaceId: () => Promise.reject(new Error('graph leased')),
      } as unknown as WorkspaceMcpContextService),
    );
    await expect(
      brokenGraph.remove(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() }),
    ).resolves.toMatchObject({ removed: true });
    expect(store.anchors).toHaveLength(0);
  });

  it('refuses an anchor on a Route: seeds admit routes, anchors do not', async () => {
    const error = await refusal(
      service.add(WORKSPACE_ID, ACTOR, {
        idempotencyKey: nextKey(),
        itemId: 'br-admin-only',
        repoKey: REPO_KEY,
        nodeId: fixture.repoA.route,
      }),
    );
    expect(error.code).toBe(IntentErrorCode.AnchorNodeTypeUnsupported);
    expect(store.anchors).toHaveLength(0);
  });

  it('refuses an anchor on a Package for the same reason', async () => {
    const error = await refusal(
      service.add(WORKSPACE_ID, ACTOR, {
        idempotencyKey: nextKey(),
        itemId: 'br-admin-only',
        repoKey: REPO_KEY,
        nodeId: fixture.repoA.appPackage,
      }),
    );
    expect(error.code).toBe(IntentErrorCode.AnchorNodeTypeUnsupported);
  });

  it('refuses a node that is not in the addressed repository', async () => {
    const error = await refusal(
      service.add(WORKSPACE_ID, ACTOR, {
        idempotencyKey: nextKey(),
        itemId: 'br-admin-only',
        repoKey: REPO_KEY,
        // A real node — in the OTHER repo. The repo filter is what refuses it.
        nodeId: fixture.repoB.guard,
      }),
    );
    expect(error.code).toBe(IntentErrorCode.AnchorNodeMissing);
  });

  it('refuses a repo that is registered but carries no durable identity', async () => {
    const error = await refusal(
      service.add(WORKSPACE_ID, ACTOR, {
        idempotencyKey: nextKey(),
        itemId: 'br-admin-only',
        repoKey: fixture.repoB.repoName,
        nodeId: fixture.repoB.guard,
      }),
    );
    expect(error.code).toBe(IntentErrorCode.UnknownRepoKey);
    expect(error.message).toContain(`unbound (${fixture.repoB.repoName}`);
  });

  it('refuses every write on a candidate, and the preview too', async () => {
    for (const call of [
      () => service.preview(WORKSPACE_ID, { itemId: 'draft', ...guard() }),
      () => service.add(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'draft', ...guard() }),
      () => service.refresh(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'draft', ...guard() }),
      () => service.remove(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'draft', ...guard() }),
    ]) {
      expect((await refusal(call())).code).toBe(IntentErrorCode.ItemNotAccepted);
    }
  });

  it('refuses an unknown item as not found', async () => {
    const error = await refusal(
      service.add(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'ghost', ...guard() }),
    );
    expect(error.code).toBe(IntentErrorCode.ItemNotFound);
  });

  it('audits every write with the identity and the baseline, and never a row dump', async () => {
    await service.add(WORKSPACE_ID, ACTOR, {
      idempotencyKey: nextKey(),
      itemId: 'br-admin-only',
      ...guard(),
      rationale: 'the guard this rule is about',
    });
    await service.remove(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() });

    expect(store.audits).toHaveLength(2);
    expect(store.audits[0]).toMatchObject({ entityKind: 'anchor', operation: 'create', actorId: ACTOR.id });
    expect(store.audits[1]).toMatchObject({ entityKind: 'anchor', operation: 'delete' });
    // The projection carries identity + baseline; the rationale (free text) stays out.
    expect(Object.keys((store.audits[0] as { after: Record<string, unknown> }).after).sort()).toEqual([
      'capturedVersionedId',
      'itemId',
      'nodeId',
      'nodeType',
      'repoKey',
    ]);
    expect(store.ledger).toHaveLength(2);
    expect(store.ledger.map((entry) => entry.operation)).toEqual(['anchor.add', 'anchor.remove']);
  });

  it('locks the item row inside the transaction, so a concurrent supersede cannot slip in', async () => {
    await service.add(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() });
    await service.refresh(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() });
    await service.remove(WORKSPACE_ID, ACTOR, { idempotencyKey: nextKey(), itemId: 'br-admin-only', ...guard() });

    // One `FOR UPDATE` per write, on the item the write is about.
    expect(store.locks).toEqual(['br-admin-only', 'br-admin-only', 'br-admin-only']);
  });

  it('replays a committed add without touching the graph, even after the node is gone', async () => {
    const idempotencyKey = nextKey();
    const input = { idempotencyKey, itemId: 'br-admin-only', repoKey: REPO_KEY, nodeId: 'node-that-no-longer-exists' };
    const stored = { anchor: { itemId: 'br-admin-only' }, created: true, graphVersionId: VERSION_ID };
    store.committed[idempotencyKey] = {
      operation: 'anchor.add',
      requestHash: hashIntentRequest(IntentOperation.AnchorAdd, input),
      response: stored,
    };

    // Without the pre-transaction peek this refuses `anchor_node_missing`: the
    // node the original call anchored has since vanished from the snapshot.
    await expect(service.add(WORKSPACE_ID, ACTOR, input)).resolves.toEqual(stored);
    expect(store.anchors).toHaveLength(0);
    expect(store.ledger).toHaveLength(0);
  });

  it('still refuses a key replayed with a different request body, before any graph work', async () => {
    const idempotencyKey = nextKey();
    store.committed[idempotencyKey] = {
      operation: 'anchor.add',
      requestHash: 'a'.repeat(64),
      response: {},
    };
    const error = await refusal(
      service.add(WORKSPACE_ID, ACTOR, { idempotencyKey, itemId: 'br-admin-only', ...guard() }),
    );
    expect(error.code).toBe(IntentErrorCode.IdempotencyRequestConflict);
  });
});
