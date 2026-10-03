/**
 * `area(feature)` and item→feature applicability against a real graph snapshot
 * (spec §6.1/§6.2, issue 06 acceptance).
 *
 * These run against the prebuilt Ladybug fixture rather than a stubbed
 * repository on purpose: the properties under test — that containment stops at
 * the CONTAINS_* family, that HANDLES is what reaches a handler, that one hop
 * means one hop, and that a cross-repo edge does not extend an area — are
 * properties of the QUERY, and a hand-rolled fake would assert the test's own
 * idea of the graph instead of the engine's.
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveNodeApplicability } from './applicability.js';
import { DerivationBudget, resolveDerivationBounds } from './derivation-bounds.js';
import {
  IntentDerivationLimit,
  IntentMatchReason,
  type DerivableFeature,
  type DerivableIntentItem,
} from './derivation-contract.js';
import { computeFeatureArea, resolveBatchTraversal, type BatchTraversalCapability } from './feature-area.js';

const REPO_KEY_A = 'github.com/acme/orders-api';
const REPO_KEY_B = 'github.com/acme/reports-web';
const DOMAIN = 'commerce';

let directory: string;
let fixture: IntentGraphFixture;
let opened: OpenedIntentGraphFixture;
let traversal: BatchTraversalCapability;
let repoHashByKey: Map<string, string>;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'coredoc-derivation-area-'));
  fixture = await buildIntentGraphFixture(join(directory, 'graph.ladybug'));
  opened = await openIntentGraphFixture(fixture.path, { readOnly: true });
  const capability = resolveBatchTraversal(opened.repository);
  if (!capability) throw new Error('fixture repository must expose batched traversal');
  traversal = capability;
  repoHashByKey = new Map([
    [REPO_KEY_A, fixture.repoA.repoHash],
    [REPO_KEY_B, fixture.repoB.repoHash],
  ]);
});

afterAll(async () => {
  await opened?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function budget(overrides: Parameters<typeof resolveDerivationBounds>[0] = {}): DerivationBudget {
  return new DerivationBudget(resolveDerivationBounds(overrides));
}

function feature(id: string, seeds: DerivableFeature['seeds']): DerivableFeature {
  return { id, domainId: DOMAIN, seeds };
}

function anchoredItem(id: string, repoKey: string, nodeId: string, capturedVersionedId?: string): DerivableIntentItem {
  return {
    id,
    attachment: { domainId: null, featureId: null },
    anchors: [
      {
        repoKey,
        nodeId,
        nodeType: NodeType.Function,
        capturedVersionedId: capturedVersionedId ?? fixture.versionedIds[nodeId] ?? 'unknown',
      },
    ],
  };
}

describe('area composition (§6.1)', () => {
  it("reaches a seeded route's handler through HANDLES and its callees in one hop", async () => {
    const { repoA } = fixture;

    const area = await computeFeatureArea({
      traversal,
      feature: feature('orders', [{ repoKey: REPO_KEY_A, nodeId: repoA.route }]),
      graphRepoHashByKey: repoHashByKey,
      budget: budget(),
    });

    const slice = area.slices[0];
    expect(slice?.repoKey).toBe(REPO_KEY_A);
    expect([...(slice?.coreNodeIds ?? [])].sort()).toEqual([repoA.route, repoA.handler].sort());
    expect([...(slice?.calledNodeIds ?? [])].sort()).toEqual([repoA.guard, repoA.store].sort());
    // Two hops from the handler: the call layer is one hop, not a closure.
    expect(slice?.calledNodeIds.has(repoA.deepHelper)).toBe(false);
    expect(area.truncated).toBe(false);
  });

  it('walks the CONTAINS_* closure downward from a seeded package', async () => {
    const { repoA } = fixture;

    const area = await computeFeatureArea({
      traversal,
      feature: feature('app', [{ repoKey: REPO_KEY_A, nodeId: repoA.appPackage }]),
      graphRepoHashByKey: repoHashByKey,
      budget: budget(),
    });

    const core = area.slices[0]?.coreNodeIds;
    expect([...(core ?? [])].sort()).toEqual(
      [
        repoA.appPackage,
        repoA.routesFile,
        repoA.handlersFile,
        repoA.guardsFile,
        repoA.route,
        repoA.handler,
        repoA.siblingHandler,
        repoA.guard,
        repoA.serviceClass,
        repoA.serviceMethod,
      ].sort(),
    );
    // The other package was never seeded, so nothing under it is in the core —
    // only what the area CALLS.
    expect(core?.has(repoA.unrelated)).toBe(false);
    expect(area.slices[0]?.calledNodeIds.has(repoA.store)).toBe(true);
  });

  it('reaches a class METHOD through HAS_METHOD, which no CONTAINS_* edge can', async () => {
    const { repoA } = fixture;

    const area = await computeFeatureArea({
      traversal,
      feature: feature('app', [{ repoKey: REPO_KEY_A, nodeId: repoA.appPackage }]),
      graphRepoHashByKey: repoHashByKey,
      budget: budget(),
    });

    // The method's ONLY structural edge is HAS_METHOD from its class (the
    // transformer emits CONTAINS_FUNCTION for plain functions only), so this
    // passing is the whole content of the v1.1-05 containment decision.
    const core = area.slices[0]?.coreNodeIds;
    expect(core?.has(repoA.serviceClass)).toBe(true);
    expect(core?.has(repoA.serviceMethod)).toBe(true);

    const withoutContainment = await computeFeatureArea({
      traversal,
      // Seeding the class itself would reach the method either way; seeding the
      // ROUTE proves the method is not reached by accident from elsewhere.
      feature: feature('orders', [{ repoKey: REPO_KEY_A, nodeId: repoA.route }]),
      graphRepoHashByKey: repoHashByKey,
      budget: budget(),
    });
    expect(withoutContainment.slices[0]?.coreNodeIds.has(repoA.serviceMethod)).toBe(false);
  });

  it('unions per-repo areas for a multi-repo feature without letting a cross-repo edge extend either', async () => {
    const { repoA, repoB } = fixture;

    const area = await computeFeatureArea({
      traversal,
      feature: feature('cross', [
        { repoKey: REPO_KEY_A, nodeId: repoA.route },
        { repoKey: REPO_KEY_B, nodeId: repoB.route },
      ]),
      graphRepoHashByKey: repoHashByKey,
      budget: budget(),
    });

    expect(area.slices.map((slice) => slice.repoKey).sort()).toEqual([REPO_KEY_A, REPO_KEY_B].sort());
    const sliceB = area.slices.find((slice) => slice.repoKey === REPO_KEY_B);
    expect([...(sliceB?.calledNodeIds ?? [])].sort()).toEqual([repoB.guard, repoB.store].sort());
    // repo B's handler DOES call repo A's guard in the fixture. v1 refuses to
    // let that edge widen repo B's area.
    expect(sliceB?.calledNodeIds.has(repoA.guard)).toBe(false);
    expect(sliceB?.coreNodeIds.has(repoA.guard)).toBe(false);
  });

  it('reports a seed repo the workspace never registered instead of dropping it', async () => {
    const { repoA } = fixture;

    const area = await computeFeatureArea({
      traversal,
      feature: feature('orders', [
        { repoKey: REPO_KEY_A, nodeId: repoA.route },
        { repoKey: 'github.com/acme/never-registered', nodeId: 'x:function:src/a.ts:a' },
      ]),
      graphRepoHashByKey: repoHashByKey,
      budget: budget(),
    });

    expect(area.unresolvedRepoKeys).toEqual(['github.com/acme/never-registered']);
    expect(area.slices).toHaveLength(1);
  });
});

describe('bounds (§6.1)', () => {
  it('marks a node-budget trip as truncated rather than returning a quietly smaller area', async () => {
    const { repoA } = fixture;

    const area = await computeFeatureArea({
      traversal,
      feature: feature('app', [{ repoKey: REPO_KEY_A, nodeId: repoA.appPackage }]),
      graphRepoHashByKey: repoHashByKey,
      budget: budget({ nodeBudget: 3 }),
    });

    expect(area.truncated).toBe(true);
    expect(area.limits).toContain(IntentDerivationLimit.NodeBudget);
    const total = area.slices.reduce((sum, slice) => sum + slice.coreNodeIds.size, 0);
    expect(total).toBeLessThanOrEqual(3);
  });

  it('marks a query-budget trip as truncated', async () => {
    const { repoA } = fixture;

    const area = await computeFeatureArea({
      traversal,
      feature: feature('app', [{ repoKey: REPO_KEY_A, nodeId: repoA.appPackage }]),
      graphRepoHashByKey: repoHashByKey,
      budget: budget({ queryBudget: 1 }),
    });

    expect(area.truncated).toBe(true);
    expect(area.limits).toContain(IntentDerivationLimit.QueryBudget);
    expect(area.queriesUsed).toBe(1);
  });

  it('shares one budget across the repos of a multi-repo feature', async () => {
    const { repoA, repoB } = fixture;
    const shared = budget();

    const area = await computeFeatureArea({
      traversal,
      feature: feature('cross', [
        { repoKey: REPO_KEY_A, nodeId: repoA.route },
        { repoKey: REPO_KEY_B, nodeId: repoB.route },
      ]),
      graphRepoHashByKey: repoHashByKey,
      budget: shared,
    });

    expect(area.queriesUsed).toBe(shared.queriesUsed);
    expect(shared.queriesUsed).toBeGreaterThan(2);
  });
});

describe('reverse direction: nodes → items (§6.2)', () => {
  it('matches an anchor ON a queried node and an anchor the queried nodes CALL', async () => {
    const { repoA } = fixture;

    const result = await resolveNodeApplicability({
      nodes: [{ repoKey: REPO_KEY_A, nodeId: repoA.handler }],
      items: [
        { ...anchoredItem('br-on-node', REPO_KEY_A, repoA.handler), attachment: { domainId: 'x', featureId: null } },
        { ...anchoredItem('br-called', REPO_KEY_A, repoA.guard), attachment: { domainId: 'x', featureId: null } },
        { ...anchoredItem('br-far', REPO_KEY_A, repoA.deepHelper), attachment: { domainId: 'x', featureId: null } },
      ],
      features: [],
      graphRepoHashByKey: repoHashByKey,
      traversal,
      budget: budget(),
    });

    expect(result.applicable).toEqual([
      { itemId: 'br-on-node', reasons: [IntentMatchReason.AnchorInArea], matchedAnchors: expect.any(Array) },
      { itemId: 'br-called', reasons: [IntentMatchReason.AnchorCalledByArea], matchedAnchors: expect.any(Array) },
    ]);
  });

  it("lends a feature's attached items to a node its area covers", async () => {
    const { repoA } = fixture;

    const result = await resolveNodeApplicability({
      nodes: [{ repoKey: REPO_KEY_A, nodeId: repoA.handler }],
      items: [{ id: 'cap-orders', attachment: { domainId: DOMAIN, featureId: 'orders' }, anchors: [] }],
      features: [
        feature('orders', [{ repoKey: REPO_KEY_A, nodeId: repoA.route }]),
        feature('unrelated', [{ repoKey: REPO_KEY_A, nodeId: repoA.otherPackage }]),
      ],
      graphRepoHashByKey: repoHashByKey,
      traversal,
      budget: budget(),
    });

    expect(result.matchedFeatureIds).toEqual(['orders']);
    expect(result.applicable).toEqual([
      { itemId: 'cap-orders', reasons: [IntentMatchReason.Attached], matchedAnchors: [] },
    ]);
  });

  it('spends a budget that fits ONE area on the feature nearest the queried code, not the first by id', async () => {
    const { repoA } = fixture;
    // `aaa-` sorts first and is seeded in a package the queried node is not in;
    // `zzz-` sorts last and is seeded in the package that contains it.
    const nearest = feature('zzz-app', [{ repoKey: REPO_KEY_A, nodeId: repoA.appPackage }]);
    const elsewhere = feature('aaa-store', [{ repoKey: REPO_KEY_A, nodeId: repoA.otherPackage }]);

    // Measure one area rather than hard-coding its query count: the bound under
    // test is "room for a single feature", not a number that moves whenever the
    // fixture topology grows.
    const probe = budget();
    await computeFeatureArea({ traversal, feature: nearest, graphRepoHashByKey: repoHashByKey, budget: probe });

    const result = await resolveNodeApplicability({
      nodes: [{ repoKey: REPO_KEY_A, nodeId: repoA.handler }],
      // No anchors: the anchor half of the reverse direction must not spend any
      // of the budget this assertion is about.
      items: [{ id: 'cap-app', attachment: { domainId: DOMAIN, featureId: 'zzz-app' }, anchors: [] }],
      features: [elsewhere, nearest],
      graphRepoHashByKey: repoHashByKey,
      traversal,
      budget: budget({ queryBudget: probe.queriesUsed }),
    });

    expect(result.matchedFeatureIds).toEqual(['zzz-app']);
    expect(result.undeterminedFeatureIds).toEqual(['aaa-store']);
    expect(result.applicable).toEqual([
      { itemId: 'cap-app', reasons: [IntentMatchReason.Attached], matchedAnchors: [] },
    ]);
  });

  it('reports a feature it never checked instead of implying the graph ruled it out', async () => {
    const { repoA } = fixture;

    const result = await resolveNodeApplicability({
      nodes: [{ repoKey: REPO_KEY_A, nodeId: repoA.handler }],
      items: [],
      features: [
        feature('orders', [{ repoKey: REPO_KEY_A, nodeId: repoA.route }]),
        feature('store', [{ repoKey: REPO_KEY_A, nodeId: repoA.otherPackage }]),
      ],
      graphRepoHashByKey: repoHashByKey,
      traversal,
      // Room for a single query, which is not room for a single area.
      budget: budget({ queryBudget: 1 }),
    });

    // `store` ranks first (its seed shares a path root with the queried node)
    // and burns the one query without finishing; `orders` is never started, and
    // saying so is what separates "not applicable" from "not checked".
    expect(result.matchedFeatureIds).toEqual([]);
    expect(result.undeterminedFeatureIds).toEqual(['orders']);
  });

  it('asks the graph nothing when the caller named no nodes', async () => {
    const { repoA } = fixture;
    const shared = budget();

    const result = await resolveNodeApplicability({
      nodes: [],
      items: [{ id: 'cap-orders', attachment: { domainId: DOMAIN, featureId: 'orders' }, anchors: [] }],
      features: [feature('orders', [{ repoKey: REPO_KEY_A, nodeId: repoA.route }])],
      graphRepoHashByKey: repoHashByKey,
      traversal,
      budget: shared,
    });

    // An area cannot cover a node nobody named, so every query would have been
    // a guaranteed miss.
    expect(shared.queriesUsed).toBe(0);
    expect(result.matchedFeatureIds).toEqual([]);
    expect(result.undeterminedFeatureIds).toEqual([]);
  });

  it('still matches anchors on the queried nodes with no traversal capability', async () => {
    const { repoA } = fixture;

    const result = await resolveNodeApplicability({
      nodes: [{ repoKey: REPO_KEY_A, nodeId: repoA.handler }],
      items: [
        { ...anchoredItem('br-on-node', REPO_KEY_A, repoA.handler), attachment: { domainId: 'x', featureId: null } },
        { ...anchoredItem('br-called', REPO_KEY_A, repoA.guard), attachment: { domainId: 'x', featureId: null } },
      ],
      features: [feature('orders', [{ repoKey: REPO_KEY_A, nodeId: repoA.route }])],
      graphRepoHashByKey: repoHashByKey,
      traversal: null,
      budget: budget(),
    });

    expect(result.applicable.map((hit) => hit.itemId)).toEqual(['br-on-node']);
    expect(result.matchedFeatureIds).toEqual([]);
  });
});
