/**
 * Batched traversal capability (`IGraphBatchTraversalRepository`).
 *
 * These are the two set-shaped reads intent derivation is built on, so the
 * properties asserted here are the ones the derivation contract depends on:
 * one hop only, repo-scoped on BOTH endpoints, deterministic order, and a
 * `truncated` flag that is observed rather than inferred.
 *
 * Pool `forks` (vitest config): these open the Ladybug native module.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeType } from '@coredoc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildIntentGraphFixture,
  openIntentGraphFixture,
  type IntentGraphFixture,
  type OpenedIntentGraphFixture,
} from '../testing/intent-graph-fixture.js';

const CONTAINMENT = [EdgeType.ContainsFile, EdgeType.ContainsFunction, EdgeType.ContainsRoute];

let directory: string;
let fixture: IntentGraphFixture;
let opened: OpenedIntentGraphFixture;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'coredoc-batch-traversal-'));
  fixture = await buildIntentGraphFixture(join(directory, 'graph.ladybug'));
  opened = await openIntentGraphFixture(fixture.path, { readOnly: true });
});

afterAll(async () => {
  await opened?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('expandOutboundNodeIds', () => {
  it('expands a SET of sources in one hop and returns distinct targets in id order', async () => {
    const { repoA } = fixture;

    const result = await opened.repository.expandOutboundNodeIds(
      [repoA.appPackage, repoA.otherPackage],
      { edgeTypes: [EdgeType.ContainsFile], limit: 100 },
      [repoA.repoHash],
    );

    expect(result.nodeIds).toEqual([repoA.routesFile, repoA.handlersFile, repoA.guardsFile, repoA.storeFile].sort());
    expect(result.truncated).toBe(false);
  });

  it('does not echo the sources back and does not walk a second hop', async () => {
    const { repoA } = fixture;

    const result = await opened.repository.expandOutboundNodeIds(
      [repoA.appPackage],
      { edgeTypes: CONTAINMENT, limit: 100 },
      [repoA.repoHash],
    );

    expect(result.nodeIds).not.toContain(repoA.appPackage);
    // The functions are one hop below the files, so a single call must not
    // reach them — the caller's loop is what makes a closure, not the query.
    expect(result.nodeIds).not.toContain(repoA.handler);
  });

  it('scopes BOTH endpoints to the requested repos, so a cross-repo call is not followed', async () => {
    const { repoA, repoB } = fixture;

    const withinB = await opened.repository.expandOutboundNodeIds(
      [repoB.handler],
      { edgeTypes: [EdgeType.Calls], limit: 100 },
      [repoB.repoHash],
    );
    const acrossBoth = await opened.repository.expandOutboundNodeIds(
      [repoB.handler],
      { edgeTypes: [EdgeType.Calls], limit: 100 },
      [repoA.repoHash, repoB.repoHash],
    );

    expect(withinB.nodeIds).toEqual([repoB.guard, repoB.store].sort());
    expect(withinB.nodeIds).not.toContain(repoA.guard);
    // The edge exists — it is the repo filter, not the graph, that excludes it.
    expect(acrossBoth.nodeIds).toContain(repoA.guard);
  });

  it('reports truncation instead of silently returning fewer ids', async () => {
    const { repoA } = fixture;

    const result = await opened.repository.expandOutboundNodeIds(
      [repoA.appPackage],
      { edgeTypes: [EdgeType.ContainsFile], limit: 2 },
      [repoA.repoHash],
    );

    expect(result.nodeIds).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing for an empty source set or an empty edge-type set', async () => {
    const { repoA } = fixture;

    expect(
      await opened.repository.expandOutboundNodeIds([], { edgeTypes: CONTAINMENT, limit: 10 }, [repoA.repoHash]),
    ).toEqual({ nodeIds: [], truncated: false });
    expect(
      await opened.repository.expandOutboundNodeIds([repoA.appPackage], { edgeTypes: [], limit: 10 }, [repoA.repoHash]),
    ).toEqual({ nodeIds: [], truncated: false });
  });

  it('resolves a route to its handler through HANDLES, which containment cannot reach', async () => {
    const { repoA } = fixture;

    const byContainment = await opened.repository.expandOutboundNodeIds(
      [repoA.route],
      { edgeTypes: CONTAINMENT, limit: 100 },
      [repoA.repoHash],
    );
    const byHandles = await opened.repository.expandOutboundNodeIds(
      [repoA.route],
      { edgeTypes: [EdgeType.Handles], limit: 100 },
      [repoA.repoHash],
    );

    expect(byContainment.nodeIds).toEqual([]);
    expect(byHandles.nodeIds).toEqual([repoA.handler]);
  });
});

describe('selectReachedNodeIds', () => {
  it('returns only the candidates the source set actually reaches in one hop', async () => {
    const { repoA } = fixture;

    const result = await opened.repository.selectReachedNodeIds(
      [repoA.handler],
      [repoA.guard, repoA.store, repoA.deepHelper, repoA.unrelated],
      { edgeTypes: [EdgeType.Calls], limit: 100 },
      [repoA.repoHash],
    );

    // `deepHelper` is two hops away and `unrelated` is called by nobody.
    expect(result.nodeIds).toEqual([repoA.guard, repoA.store].sort());
    expect(result.truncated).toBe(false);
  });

  it('answers for a candidate in another repo only when that repo is in scope', async () => {
    const { repoA, repoB } = fixture;

    const scopedToB = await opened.repository.selectReachedNodeIds(
      [repoB.handler],
      [repoA.guard],
      { edgeTypes: [EdgeType.Calls], limit: 100 },
      [repoB.repoHash],
    );
    const scopedToBoth = await opened.repository.selectReachedNodeIds(
      [repoB.handler],
      [repoA.guard],
      { edgeTypes: [EdgeType.Calls], limit: 100 },
      [repoA.repoHash, repoB.repoHash],
    );

    expect(scopedToB.nodeIds).toEqual([]);
    expect(scopedToBoth.nodeIds).toEqual([repoA.guard]);
  });

  it('reports truncation on its own cap', async () => {
    const { repoA } = fixture;

    const result = await opened.repository.selectReachedNodeIds(
      [repoA.handler],
      [repoA.guard, repoA.store],
      { edgeTypes: [EdgeType.Calls], limit: 1 },
      [repoA.repoHash],
    );

    expect(result.nodeIds).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing when either side of the join is empty', async () => {
    const { repoA } = fixture;

    expect(
      await opened.repository.selectReachedNodeIds([], [repoA.guard], { edgeTypes: [EdgeType.Calls], limit: 10 }, [
        repoA.repoHash,
      ]),
    ).toEqual({ nodeIds: [], truncated: false });
    expect(
      await opened.repository.selectReachedNodeIds([repoA.handler], [], { edgeTypes: [EdgeType.Calls], limit: 10 }, [
        repoA.repoHash,
      ]),
    ).toEqual({ nodeIds: [], truncated: false });
  });
});

describe('intent graph fixture', () => {
  it('records a parsed commit per repo so freshness has something to compare against', async () => {
    const overviews = await opened.repository.getRepoOverview([fixture.repoA.repoHash]);

    expect(overviews[0]?.gitCommitHash).toBe(fixture.repoA.gitCommitHash);
  });

  it('carries a versioned id on anchorable nodes and none on a route', async () => {
    const { repoA } = fixture;

    const guard = await opened.repository.getNodeWithProperties(repoA.guard, [repoA.repoHash]);
    const route = await opened.repository.getNodeWithProperties(repoA.route, [repoA.repoHash]);

    expect(guard?.properties.versionedId).toBe(fixture.versionedIds[repoA.guard]);
    expect(route?.properties.versionedId).toBeUndefined();
  });
});
