/**
 * `IntentDerivationService` end-to-end against the fixture snapshot (spec §6.3,
 * §6.4, issue 06 acceptance).
 *
 * The graph is real; only the two seams the service does not own are faked —
 * the workspace context (which snapshot to lease) and the control plane (which
 * repos exist). That keeps every assertion here about the service's own
 * behaviour: what it reports when the snapshot is fine, when it is unreadable,
 * and when it is readable but the backend cannot traverse.
 *
 * Pool `forks` (apps/server vitest config): the Ladybug native module.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeType } from '@coredoc/core';
import { AnchorStatus, SnapshotFreshness, type IGraphReadRepository } from '@coredoc/db';
import {
  buildIntentGraphFixture,
  openIntentGraphFixture,
  type IntentGraphFixture,
  type OpenedIntentGraphFixture,
} from '@coredoc/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ControlPlaneService, WorkspaceRepo } from '../../../database/control-plane.service.js';
import { WorkspaceFileCacheError } from '../../../database/workspace-file-cache.service.js';
import {
  WorkspaceGraphContextError,
  type WorkspaceContext,
  type WorkspaceMcpContextService,
} from '../../../mcp/workspace-mcp-context.service.js';
import { IntentGraphUnavailableCode, IntentMatchReason, type DerivableIntentItem } from './derivation-contract.js';
import { graphRemediation } from './graph-degradation.js';
import { IntentDerivationService } from './intent-derivation.service.js';

const WORKSPACE_ID = 'ws-1';
const VERSION_ID = 'v-2026-09-01';
const REPO_KEY_A = 'github.com/acme/orders-api';
const REPO_KEY_B = 'github.com/acme/reports-web';
const PUSHED_AT = new Date('2026-08-30T10:00:00.000Z');

let directory: string;
let fixture: IntentGraphFixture;
let opened: OpenedIntentGraphFixture;
let repos: WorkspaceRepo[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'coredoc-derivation-service-'));
  fixture = await buildIntentGraphFixture(join(directory, 'graph.ladybug'));
  opened = await openIntentGraphFixture(fixture.path, { readOnly: true });
  repos = [
    {
      repoKey: fixture.repoA.repoHash,
      repoName: fixture.repoA.repoName,
      intentRepoKey: REPO_KEY_A,
      lastPushedAt: PUSHED_AT,
    },
    {
      repoKey: fixture.repoB.repoHash,
      repoName: fixture.repoB.repoName,
      intentRepoKey: REPO_KEY_B,
      lastPushedAt: null,
    },
  ] as unknown as WorkspaceRepo[];
});

afterAll(async () => {
  await opened?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

interface ContextBehaviour {
  /** Thrown instead of leasing, to exercise §6.3 degradation. */
  error?: unknown;
  /** Serve a repository without the batched-traversal capability. */
  withoutBatchTraversal?: boolean;
  /** Thrown by every graph read INSIDE the lease, to exercise the inner catch. */
  queryError?: unknown;
}

/** A repository whose reads all fail, for the "the snapshot opened and then…" cases. */
function failingReads(repository: IGraphReadRepository, error: unknown): IGraphReadRepository {
  const failing = Object.create(repository) as IGraphReadRepository;
  const throwing = () => {
    throw error;
  };
  // defineProperty, not assignment: the base may be a frozen facade.
  Object.defineProperty(failing, 'getRepoOverview', { value: throwing, enumerable: true });
  Object.defineProperty(failing, 'getNodeWithProperties', { value: throwing, enumerable: true });
  return failing;
}

/** A repository facade that drops the optional batched methods, like the Turso plane. */
function withoutBatchTraversal(repository: IGraphReadRepository): IGraphReadRepository {
  const stripped = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(repository))) {
    if (key === 'constructor' || key === 'expandOutboundNodeIds' || key === 'selectReachedNodeIds') continue;
    const value = (repository as unknown as Record<string, unknown>)[key];
    if (typeof value === 'function') stripped[key] = value.bind(repository);
  }
  return stripped as unknown as IGraphReadRepository;
}

/**
 * The production scoped facade is FROZEN (workspace-mcp-context hands out an
 * immutable method allowlist), so the harness must be too — plain assignment
 * cannot shadow a frozen facade's methods, and a derivation helper that tries
 * blew up only in production until this mirrored it.
 */
function frozenFacade(repository: IGraphReadRepository): IGraphReadRepository {
  const facade = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(repository))) {
    if (key === 'constructor') continue;
    const value = (repository as unknown as Record<string, unknown>)[key];
    if (typeof value === 'function') facade[key] = value.bind(repository);
  }
  return Object.freeze(facade) as unknown as IGraphReadRepository;
}

function service(behaviour: ContextBehaviour = {}): IntentDerivationService {
  const workspaceContext = {
    async withContextByWorkspaceId<T>(_workspaceId: string, callback: (context: WorkspaceContext) => Promise<T>) {
      if (behaviour.error) throw behaviour.error;
      const repository = behaviour.withoutBatchTraversal
        ? withoutBatchTraversal(opened.repository)
        : frozenFacade(opened.repository as unknown as IGraphReadRepository);
      return callback({
        repository: behaviour.queryError ? failingReads(repository, behaviour.queryError) : repository,
        scope: {} as WorkspaceContext['scope'],
        repos,
        versionId: VERSION_ID,
        graphBackend: 'file_snapshot',
      });
    },
  } as unknown as WorkspaceMcpContextService;
  const controlPlane = {
    async listRepos() {
      return repos;
    },
  } as unknown as ControlPlaneService;
  return new IntentDerivationService(workspaceContext, controlPlane);
}

function guardRule(capturedVersionedId?: string): DerivableIntentItem {
  return {
    id: 'br-admin-only',
    attachment: { domainId: 'security', featureId: null },
    anchors: [
      {
        repoKey: REPO_KEY_A,
        nodeId: fixture.repoA.guard,
        nodeType: NodeType.Function,
        capturedVersionedId: capturedVersionedId ?? (fixture.versionedIds[fixture.repoA.guard] as string),
      },
    ],
  };
}

const ORDERS_FEATURE = () => ({
  id: 'orders',
  domainId: 'commerce',
  seeds: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.route }],
});

describe('deriveFeatureContext — readable snapshot', () => {
  it('returns the guard rule with its derived reason, evidence and provenance', async () => {
    const result = await service().deriveFeatureContext(WORKSPACE_ID, {
      feature: ORDERS_FEATURE(),
      items: [guardRule()],
    });

    expect(result.applicable).toEqual([
      {
        itemId: 'br-admin-only',
        reasons: [IntentMatchReason.AnchorCalledByArea],
        matchedAnchors: [expect.objectContaining({ nodeId: fixture.repoA.guard })],
      },
    ]);
    expect(result.evidence.available).toBe(true);
    expect(result.evidence.items?.[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(result.degradation).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.area?.repos[0]?.calledNodeIds).toContain(fixture.repoA.guard);
  });

  it('carries per-repo provenance assembled from the version and the push metadata', async () => {
    const result = await service().deriveFeatureContext(WORKSPACE_ID, {
      feature: ORDERS_FEATURE(),
      items: [guardRule()],
    });

    expect(result.evidence.repos).toEqual([
      expect.objectContaining({
        repoKey: REPO_KEY_A,
        repoName: fixture.repoA.repoName,
        graphVersionId: VERSION_ID,
        pushedAt: PUSHED_AT.toISOString(),
      }),
      expect.objectContaining({
        repoKey: REPO_KEY_B,
        graphVersionId: VERSION_ID,
        // A repo that never pushed says so rather than inheriting a timestamp.
        pushedAt: null,
      }),
    ]);
  });

  describe('anchorStatus matrix (§6.4)', () => {
    it('reports matched when the captured versioned id reproduces', async () => {
      const result = await service().deriveFeatureContext(WORKSPACE_ID, {
        feature: ORDERS_FEATURE(),
        items: [guardRule()],
      });

      expect(result.evidence.items?.[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    });

    it('reports changed when the node exists with a different versioned id', async () => {
      const result = await service().deriveFeatureContext(WORKSPACE_ID, {
        feature: ORDERS_FEATURE(),
        items: [guardRule('stale-checksum')],
      });

      const anchor = result.evidence.items?.[0]?.anchors[0];
      expect(anchor?.status).toBe(AnchorStatus.Changed);
      // Still applicable: the code moved on, the rule did not stop applying.
      expect(result.applicable[0]?.reasons).toContain(IntentMatchReason.AnchorCalledByArea);
    });

    it('reports missing when the node is absent from the snapshot', async () => {
      const item: DerivableIntentItem = {
        id: 'br-gone',
        attachment: { domainId: 'security', featureId: null },
        anchors: [
          {
            repoKey: REPO_KEY_A,
            nodeId: `${fixture.repoA.repoHash}:function:src/app/gone.ts:deleted`,
            nodeType: NodeType.Function,
            capturedVersionedId: 'whatever@0',
          },
        ],
      };

      const result = await service().deriveFeatureContext(WORKSPACE_ID, {
        feature: ORDERS_FEATURE(),
        items: [item],
      });

      expect(result.evidence.items?.[0]?.anchors[0]?.status).toBe(AnchorStatus.Missing);
    });

    it('reports an item with no anchors as unmapped rather than as a failed anchor', async () => {
      const result = await service().deriveFeatureContext(WORKSPACE_ID, {
        feature: ORDERS_FEATURE(),
        items: [{ id: 'cap-plain', attachment: { domainId: 'commerce', featureId: 'orders' }, anchors: [] }],
      });

      expect(result.evidence.items?.[0]).toEqual({ itemId: 'cap-plain', anchors: [], unmapped: true });
    });
  });

  describe('freshness matrix (§6.3)', () => {
    async function freshnessFor(observedCheckouts: Record<string, { commit?: string; dirty: boolean }> | undefined) {
      const result = await service().deriveFeatureContext(WORKSPACE_ID, {
        feature: ORDERS_FEATURE(),
        items: [guardRule()],
        ...(observedCheckouts ? { observedCheckouts } : {}),
      });
      return result.evidence.repos.find((repo) => repo.repoKey === REPO_KEY_A)?.snapshotFreshness;
    }

    it('is unverified when the caller supplied no observed checkout', async () => {
      expect(await freshnessFor(undefined)).toBe(SnapshotFreshness.Unverified);
    });

    it('is current for a clean checkout at the parsed commit', async () => {
      expect(await freshnessFor({ [REPO_KEY_A]: { commit: fixture.repoA.gitCommitHash, dirty: false } })).toBe(
        SnapshotFreshness.Current,
      );
    });

    it('is stale when the observed commit differs', async () => {
      expect(await freshnessFor({ [REPO_KEY_A]: { commit: 'c'.repeat(40), dirty: false } })).toBe(
        SnapshotFreshness.Stale,
      );
    });

    it('is unknown for a dirty checkout at the parsed commit', async () => {
      expect(await freshnessFor({ [REPO_KEY_A]: { commit: fixture.repoA.gitCommitHash, dirty: true } })).toBe(
        SnapshotFreshness.Unknown,
      );
    });

    it('leaves a repo the caller said nothing about unverified even when another was observed', async () => {
      const result = await service().deriveFeatureContext(WORKSPACE_ID, {
        feature: ORDERS_FEATURE(),
        items: [guardRule()],
        observedCheckouts: { [REPO_KEY_A]: { commit: fixture.repoA.gitCommitHash, dirty: false } },
      });

      expect(result.evidence.repos.find((repo) => repo.repoKey === REPO_KEY_B)?.snapshotFreshness).toBe(
        SnapshotFreshness.Unverified,
      );
    });
  });
});

describe('deriveFeatureContext — degradation (§6.3)', () => {
  it('degrades to attachment-only with evidence.available false when no snapshot is published', async () => {
    const degraded = service({
      error: new WorkspaceGraphContextError('ACTIVE_VERSION_MISSING', 'no active version'),
    });

    const result = await degraded.deriveFeatureContext(WORKSPACE_ID, {
      feature: ORDERS_FEATURE(),
      items: [
        guardRule(),
        { id: 'cap-attached', attachment: { domainId: 'commerce', featureId: 'orders' }, anchors: [] },
      ],
    });

    // The anchor-derived hit is gone; the attached one is not.
    expect(result.applicable).toEqual([
      { itemId: 'cap-attached', reasons: [IntentMatchReason.Attached], matchedAnchors: [] },
    ]);
    expect(result.evidence.available).toBe(false);
    expect(result.degradation).toEqual({
      code: IntentGraphUnavailableCode.ActiveVersionMissing,
      remediation: graphRemediation(IntentGraphUnavailableCode.ActiveVersionMissing),
    });
    expect(result.area).toBeUndefined();
  });

  it('names WHICH graph was unavailable by still reporting provenance', async () => {
    const degraded = service({ error: new WorkspaceFileCacheError('NOT_FOUND', 'object missing') });

    const result = await degraded.deriveFeatureContext(WORKSPACE_ID, {
      feature: ORDERS_FEATURE(),
      items: [guardRule()],
    });

    expect(result.degradation?.code).toBe(IntentGraphUnavailableCode.GraphObjectMissing);
    expect(result.evidence.repos.map((repo) => repo.repoKey)).toEqual([REPO_KEY_A, REPO_KEY_B]);
    expect(result.evidence.repos.every((repo) => repo.snapshotFreshness === SnapshotFreshness.Unverified)).toBe(true);
  });

  it('keeps evidence when the snapshot is readable but the backend cannot traverse in batches', async () => {
    const result = await service({ withoutBatchTraversal: true }).deriveFeatureContext(WORKSPACE_ID, {
      feature: ORDERS_FEATURE(),
      items: [
        guardRule(),
        { id: 'cap-attached', attachment: { domainId: 'commerce', featureId: 'orders' }, anchors: [] },
      ],
    });

    // anchorStatus still resolves — the snapshot IS readable — but the
    // anchor-derived reason cannot be computed, and the response says why.
    expect(result.evidence.available).toBe(true);
    expect(result.evidence.items?.[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(result.applicable.map((hit) => hit.itemId)).toEqual(['cap-attached']);
    expect(result.degradation?.code).toBe(IntentGraphUnavailableCode.BatchTraversalUnsupported);
  });

  it('rethrows a failure that is not a graph-plane failure instead of laundering it', async () => {
    const broken = service({ error: new Error('DI is on fire') });

    await expect(broken.deriveFeatureContext(WORKSPACE_ID, { feature: ORDERS_FEATURE(), items: [] })).rejects.toThrow(
      'DI is on fire',
    );
  });

  it('rethrows a PROGRAMMING error raised inside the lease, rather than calling the graph unavailable', async () => {
    // The inner catch used to convert ANY throw into `graph_query_failed`, so a
    // `TypeError` in this module reported itself as a healthy-snapshot problem
    // and sent the reader off to republish a snapshot that was fine.
    const broken = service({ queryError: new TypeError("Cannot read properties of undefined (reading 'node')") });

    await expect(
      broken.deriveFeatureContext(WORKSPACE_ID, { feature: ORDERS_FEATURE(), items: [guardRule()] }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('degrades a real query failure raised inside the lease', async () => {
    const broken = service({ queryError: new Error('kuzu: relation scan failed') });

    const result = await broken.deriveFeatureContext(WORKSPACE_ID, {
      feature: ORDERS_FEATURE(),
      items: [guardRule()],
    });
    expect(result.evidence.available).toBe(false);
    expect(result.degradation?.code).toBe(IntentGraphUnavailableCode.GraphQueryFailed);
  });

  it('keeps a TYPED cache failure raised inside the lease under its own code', async () => {
    const broken = service({ queryError: new WorkspaceFileCacheError('NOT_FOUND', 'object evicted mid-read') });

    const result = await broken.deriveFeatureContext(WORKSPACE_ID, {
      feature: ORDERS_FEATURE(),
      items: [guardRule()],
    });
    expect(result.degradation?.code).toBe(IntentGraphUnavailableCode.GraphObjectMissing);
  });
});

describe('query budget', () => {
  it('counts the anchor-evidence lookups, not just the traversal steps', async () => {
    const seedless = { id: 'orders', domainId: 'commerce', seeds: [] };

    // No anchors: evidence issues no graph query at all.
    const unanchored = await service().deriveFeatureContext(WORKSPACE_ID, { feature: seedless, items: [] });
    // One anchor in one repository: a repo overview plus a node lookup, both of
    // which used to be invisible to the budget that claims to bound this
    // request's graph work.
    const anchored = await service().deriveFeatureContext(WORKSPACE_ID, { feature: seedless, items: [guardRule()] });

    expect(unanchored.queriesUsed).toBe(0);
    expect(anchored.queriesUsed).toBeGreaterThan(unanchored.queriesUsed);
    expect(anchored.evidence.items?.[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
  });

  it('reports the budget as tripped when evidence alone spends it, and still resolves evidence', async () => {
    const result = await service().deriveFeatureContext(WORKSPACE_ID, {
      feature: ORDERS_FEATURE(),
      items: [guardRule()],
      bounds: { queryBudget: 1 },
    });

    // Evidence is not optional (§6.4): the spent budget cuts the traversal that
    // follows it and says so, it never leaves a returned anchor without status.
    expect(result.truncated).toBe(true);
    expect(result.evidence.items?.[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
  });
});

describe('deriveNodeContext — reverse direction', () => {
  it('finds the rules that apply to a node the caller is looking at', async () => {
    const result = await service().deriveNodeContext(WORKSPACE_ID, {
      nodes: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.handler }],
      items: [
        guardRule(),
        { id: 'cap-orders', attachment: { domainId: 'commerce', featureId: 'orders' }, anchors: [] },
      ],
      features: [ORDERS_FEATURE()],
    });

    expect(result.matchedFeatureIds).toEqual(['orders']);
    expect(result.applicable).toEqual([
      {
        itemId: 'br-admin-only',
        reasons: [IntentMatchReason.AnchorCalledByArea],
        matchedAnchors: [expect.objectContaining({ nodeId: fixture.repoA.guard })],
      },
      { itemId: 'cap-orders', reasons: [IntentMatchReason.Attached], matchedAnchors: [] },
    ]);
    expect(result.evidence.available).toBe(true);
  });

  it('reaches the rules that the members of a queried file node call', async () => {
    // A caller looking at a FILE (or a class) names the container, not each
    // function in it — the calls hop has to start from the members.
    const result = await service().deriveNodeContext(WORKSPACE_ID, {
      nodes: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.handlersFile }],
      items: [guardRule()],
      features: [],
    });

    expect(result.applicable).toEqual([
      {
        itemId: 'br-admin-only',
        reasons: [IntentMatchReason.AnchorCalledByArea],
        matchedAnchors: [expect.objectContaining({ nodeId: fixture.repoA.guard })],
      },
    ]);
  });

  it('reaches through file → class → method to the rule a method of the queried file calls', async () => {
    // The ordinary OO shape: the calling code is a METHOD, two containment
    // levels below the file the caller named.
    const methodRule: DerivableIntentItem = {
      id: 'br-settled-records',
      attachment: { domainId: 'security', featureId: null },
      anchors: [
        {
          repoKey: REPO_KEY_A,
          nodeId: fixture.repoA.methodCallee,
          nodeType: NodeType.Function,
          capturedVersionedId: fixture.versionedIds[fixture.repoA.methodCallee] as string,
        },
      ],
    };

    const result = await service().deriveNodeContext(WORKSPACE_ID, {
      nodes: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.handlersFile }],
      items: [methodRule],
      features: [],
    });

    expect(result.applicable).toEqual([
      {
        itemId: 'br-settled-records',
        reasons: [IntentMatchReason.AnchorCalledByArea],
        matchedAnchors: [expect.objectContaining({ nodeId: fixture.repoA.methodCallee })],
      },
    ]);
  });

  it('returns the rule anchored on a CLASS whose method calls the queried function', async () => {
    // Scenario (c): the edit is inside a shared callee; the rule lives on the
    // caller, which the change does not touch. The anchor is a class, so its
    // members stand in for it exactly as a queried container's do.
    const classRule: DerivableIntentItem = {
      id: 'cap-settlement',
      attachment: { domainId: 'commerce', featureId: null },
      anchors: [
        {
          repoKey: REPO_KEY_A,
          nodeId: fixture.repoA.serviceClass,
          nodeType: NodeType.Class,
          capturedVersionedId: fixture.versionedIds[fixture.repoA.serviceClass] as string,
        },
      ],
    };

    const result = await service().deriveNodeContext(WORKSPACE_ID, {
      nodes: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.methodCallee }],
      items: [classRule],
      features: [],
    });

    expect(result.applicable).toEqual([
      {
        itemId: 'cap-settlement',
        reasons: [IntentMatchReason.AnchorCallsArea],
        matchedAnchors: [expect.objectContaining({ nodeId: fixture.repoA.serviceClass })],
      },
    ]);
  });

  it('returns a file binding when a member calls the queried shared code', async () => {
    const fileRule: DerivableIntentItem = {
      id: 'cap-handlers-file',
      attachment: { domainId: 'commerce', featureId: null },
      anchors: [
        {
          repoKey: REPO_KEY_A,
          nodeId: fixture.repoA.handlersFile,
          nodeType: NodeType.File,
          capturedVersionedId: fixture.versionedIds[fixture.repoA.handlersFile] as string,
        },
      ],
    };

    const result = await service().deriveNodeContext(WORKSPACE_ID, {
      nodes: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.methodCallee }],
      items: [fileRule],
      features: [],
    });

    expect(result.applicable).toEqual([
      expect.objectContaining({
        itemId: fileRule.id,
        reasons: ['anchor_calls_area'],
        matchedAnchors: [expect.objectContaining({ nodeId: fixture.repoA.handlersFile })],
      }),
    ]);
  });

  it('does not claim an anchor calls the queried node when it is two hops away', async () => {
    // `handleRequest` (in the anchored file) calls `loadRecords`, which calls
    // `deepHelper`. One hop means one hop in this direction too.
    const fileRule: DerivableIntentItem = {
      id: 'cap-handlers',
      attachment: { domainId: 'commerce', featureId: null },
      anchors: [
        {
          repoKey: REPO_KEY_A,
          nodeId: fixture.repoA.handlersFile,
          nodeType: NodeType.File,
          capturedVersionedId: fixture.versionedIds[fixture.repoA.handlersFile] as string,
        },
      ],
    };

    const result = await service().deriveNodeContext(WORKSPACE_ID, {
      nodes: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.deepHelper }],
      items: [fileRule],
      features: [],
    });

    expect(result.applicable).toEqual([]);
  });

  it('names a narrowing when the budget stopped it short of every candidate feature', async () => {
    const result = await service().deriveNodeContext(WORKSPACE_ID, {
      nodes: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.handler }],
      items: [],
      features: [ORDERS_FEATURE(), { id: 'store', domainId: 'commerce', seeds: [] }],
      // Room for a query, not for an area: whatever is not reached must be named.
      bounds: { queryBudget: 1 },
    });

    expect(result.truncated).toBe(true);
    // A `truncated` a caller cannot act on is the support burden this replaces:
    // the sentence names both the parameter and a feature worth scoping to.
    expect(result.scopeSuggestion).toContain('feature=');
    expect(result.scopeSuggestion).toContain('store');
  });

  it('degrades to nothing-derived without a snapshot, and says so', async () => {
    const degraded = service({ error: new WorkspaceGraphContextError('VERSION_NOT_FOUND', 'gone') });

    const result = await degraded.deriveNodeContext(WORKSPACE_ID, {
      nodes: [{ repoKey: REPO_KEY_A, nodeId: fixture.repoA.handler }],
      items: [guardRule()],
      features: [ORDERS_FEATURE()],
    });

    expect(result.applicable).toEqual([]);
    expect(result.matchedFeatureIds).toEqual([]);
    expect(result.evidence.available).toBe(false);
    expect(result.degradation?.code).toBe(IntentGraphUnavailableCode.VersionNotFound);
  });
});
