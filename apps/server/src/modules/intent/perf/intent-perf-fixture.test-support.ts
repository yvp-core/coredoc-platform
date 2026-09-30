/**
 * Large-workspace fixture generator for the intent performance smoke (spec §15).
 *
 * NOT the unit fixture. `@coredoc/db/testing`'s `buildIntentGraphFixture` builds
 * a two-repo topology whose every node is named after the assertion it serves —
 * exactly right for proving what derivation MEANS, and useless for measuring
 * what it COSTS, because the whole graph fits in one query. This generator
 * builds the other thing: a workspace shaped like a mature multi-repo team
 * product (dozens of repos, hundreds of features, thousands of items), written
 * through the same ordinary `@coredoc/db` Ladybug write path, plus the control-
 * plane and intent rows that address it.
 *
 * Two properties are deliberate rather than incidental:
 *
 * 1. EVERY FEATURE HAS A GUARD. Each feature's first function CALLS a function
 *    in a package the feature does not contain, and an item is anchored there.
 *    That is the §6.2 "admin guard" case — the one derivation path that cannot
 *    be answered from attachment — so the node workloads measure real traversal
 *    instead of a row lookup.
 * 2. IDS ARE THE PRODUCTION SHAPE — minted by `StableIdGenerator` itself, so the
 *    per-kind shapes (a file and a package carry no name segment, a route's
 *    third segment is a digest) cannot drift from what a real snapshot holds.
 *    The repo hash is the real `sha256(durableKey)[0..12]`, because
 *    `workspace_repos_intent_repo_key_graph_hash_check` refuses any other
 *    pairing and `IntentContextService.resolveNodes` reads the repository back
 *    out of the id's first segment.
 *
 * Runner constraint: writing a Ladybug database loads a native module, so any
 * suite using this generator must run under vitest pool `forks` (the server
 * vitest config already sets it).
 */

import { EdgeType, IntentKind, NodeType, StableIdGenerator, type GraphEdge, type GraphNode } from '@coredoc/core';
import { LadybugDriver, LadybugRepository } from '@coredoc/db/ladybug';
import type { PrismaClient } from '../../../generated/prisma/client.js';

/** Generator parameters. Recorded verbatim in the baseline artifact. */
export interface PerfWorkspaceShape {
  /** Repositories in the workspace; one intent domain is declared per repository. */
  repos: number;
  /** Features per repository. Each gets its own seeded package. */
  featuresPerRepo: number;
  /** Files inside a feature's package. */
  filesPerFeature: number;
  /** Functions inside each of those files. */
  functionsPerFile: number;
  /** Intent items spread across features, domains and the product root. */
  items: number;
  /** Anchors spread over the generated functions (one per feature is the guard). */
  anchors: number;
  /** Extra candidate items reserved for the review-batch workload. */
  reviewCandidates: number;
}

/**
 * The shape the committed baseline was measured at.
 *
 * ~4× the derivation spike's fixture on nodes and ~2.5× on edges, with a
 * workspace-level count (features, items, anchors) that no unit fixture reaches.
 */
export const PERF_WORKSPACE_SHAPE: Readonly<PerfWorkspaceShape> = Object.freeze({
  repos: 12,
  featuresPerRepo: 20,
  filesPerFeature: 5,
  functionsPerFile: 12,
  items: 3000,
  anchors: 1500,
  reviewCandidates: 400,
});

/** Kind of each generated item, cycled so every kind and its id prefix appear. */
const ITEM_KINDS: ReadonlyArray<{ kind: IntentKind; prefix: string }> = [
  { kind: IntentKind.BusinessRule, prefix: 'br' },
  { kind: IntentKind.Capability, prefix: 'cap' },
  { kind: IntentKind.UseCase, prefix: 'uc' },
  { kind: IntentKind.Flow, prefix: 'flow' },
  { kind: IntentKind.Limitation, prefix: 'lim' },
  { kind: IntentKind.Decision, prefix: 'dec' },
];

/** The phrase the lexical workload searches for; carried by every seventh item. */
export const PERF_LEXICAL_PHRASE = 'refund window';

export interface PerfFeatureNodes {
  /** Slug of the intent feature this package is seeded for. */
  featureId: string;
  /** Durable repo key the seed and anchors address. */
  repoKey: string;
  /** Seeded package — the containment root of the feature's area. */
  packageNodeId: string;
  /** First function of the first file: the feature's handler. */
  handlerNodeId: string;
  /** Function OUTSIDE the feature's package that the handler calls. */
  guardNodeId: string;
  /** Every function inside the feature's package, in generation order. */
  functionNodeIds: string[];
}

export interface PerfGraphFixture {
  path: string;
  repoKeys: string[];
  /** Graph repo hash per durable repo key. */
  repoHashByKey: Record<string, string>;
  /** Commit each repository claims to have been parsed at. */
  commitByRepoKey: Record<string, string>;
  features: PerfFeatureNodes[];
  /** Captured versioned id per node id, as an anchor would have recorded it. */
  versionedIds: Record<string, string>;
  nodeCount: number;
  edgeCount: number;
  buildMs: number;
}

function versionedId(nodeId: string): string {
  // Shape only — `{stableId}@{checksum}` is what IdGenerator emits. Anchor
  // resolution compares the captured string to the stored one and nothing else.
  let hash = 0;
  for (let index = 0; index < nodeId.length; index += 1) hash = (hash * 31 + nodeId.charCodeAt(index)) >>> 0;
  return `${nodeId}@${hash.toString(16).padStart(8, '0')}`;
}

interface Builder {
  nodes: GraphNode[];
  edges: GraphEdge[];
  versionedIds: Record<string, string>;
}

/**
 * Mint a node id the way production does, per kind — see the unit fixture's
 * `mintNodeId` for why a single four-segment template is not the shape.
 */
function nodeId(ids: StableIdGenerator, type: NodeType, path: string, name: string): string {
  switch (type) {
    case NodeType.Package:
      return ids.packageId(path);
    case NodeType.File:
      return ids.fileId(path);
    case NodeType.Function:
      return ids.functionId(path, name);
    case NodeType.Route:
      return ids.routeId(name);
    default:
      throw new Error(`intent perf fixture does not mint ${type} node ids`);
  }
}

function addNode(
  builder: Builder,
  ids: StableIdGenerator,
  type: NodeType,
  path: string,
  name: string,
  properties: Record<string, unknown> = {},
): string {
  const repoHash = ids.getRepoHash();
  const id = nodeId(ids, type, path, name);
  const versioned =
    type === NodeType.Function || type === NodeType.Class || type === NodeType.File
      ? { versionedId: versionedId(id) }
      : {};
  if (versioned.versionedId) builder.versionedIds[id] = versioned.versionedId;
  builder.nodes.push({
    id,
    type,
    name,
    properties: { ...versioned, ...properties },
    repoId: repoHash,
    filePath: path,
    startLine: 1,
    endLine: 20,
  });
  return id;
}

function addEdge(builder: Builder, type: EdgeType, sourceId: string, targetId: string): void {
  builder.edges.push({
    id: `${type}:${sourceId}->${targetId}`,
    sourceId,
    targetId,
    type,
    confidence: 1,
    createdBy: 'parser',
    properties: {},
  });
}

/** Durable repo key of repository `index`. */
export function perfRepoKey(index: number): string {
  return `github.com/acme/service-${String(index).padStart(2, '0')}`;
}

/** Intent domain slug of repository `index` — one domain per repository. */
export function perfDomainId(index: number): string {
  return `domain-${String(index).padStart(2, '0')}`;
}

/** Intent feature slug: repository-scoped, so a feature never spans two domains. */
export function perfFeatureId(repoIndex: number, featureIndex: number): string {
  return `feature-${String(repoIndex).padStart(2, '0')}-${String(featureIndex).padStart(2, '0')}`;
}

/**
 * Write the workspace graph to `databasePath`.
 *
 * Per repository: one package per feature holding that feature's files and
 * functions, one shared `src/security` package holding the per-feature guards
 * (deliberately outside every feature's containment closure), one route per
 * feature reaching its handler through HANDLES, and a call chain inside each
 * file so the one-hop callee set is not empty.
 */
export async function buildPerfGraphFixture(
  databasePath: string,
  shape: PerfWorkspaceShape = PERF_WORKSPACE_SHAPE,
): Promise<PerfGraphFixture> {
  const startedAt = performance.now();
  const builder: Builder = { nodes: [], edges: [], versionedIds: {} };
  const repoKeys: string[] = [];
  const repoHashByKey: Record<string, string> = {};
  const commitByRepoKey: Record<string, string> = {};
  const features: PerfFeatureNodes[] = [];

  for (let repoIndex = 0; repoIndex < shape.repos; repoIndex += 1) {
    const repoKey = perfRepoKey(repoIndex);
    const ids = new StableIdGenerator('', repoKey);
    const repoHash = ids.getRepoHash();
    const commit = repoIndex.toString(16).padStart(2, '0').repeat(20);
    repoKeys.push(repoKey);
    repoHashByKey[repoKey] = repoHash;
    commitByRepoKey[repoKey] = commit;

    builder.nodes.push({
      id: repoHash,
      type: NodeType.Repository,
      name: repoKey,
      properties: { type: 'backend', parsedAt: '2026-09-01T00:00:00.000Z', gitCommitHash: commit },
    });

    const securityPath = 'src/security';
    const securityPackage = addNode(builder, ids, NodeType.Package, securityPath, 'security');
    const guardsPath = 'src/security/guards.ts';
    const guardsFile = addNode(builder, ids, NodeType.File, guardsPath, 'guards.ts');
    addEdge(builder, EdgeType.ContainsFile, securityPackage, guardsFile);

    for (let featureIndex = 0; featureIndex < shape.featuresPerRepo; featureIndex += 1) {
      const featureId = perfFeatureId(repoIndex, featureIndex);
      const packagePath = `src/${featureId}`;
      const packageNodeId = addNode(builder, ids, NodeType.Package, packagePath, featureId);

      const guardName = `guard_${featureId.replace(/-/g, '_')}`;
      const guardNodeId = addNode(builder, ids, NodeType.Function, guardsPath, guardName, { kind: 'function' });
      addEdge(builder, EdgeType.ContainsFunction, guardsFile, guardNodeId);

      const functionNodeIds: string[] = [];
      for (let fileIndex = 0; fileIndex < shape.filesPerFeature; fileIndex += 1) {
        const filePath = `${packagePath}/module-${fileIndex}.ts`;
        const file = addNode(builder, ids, NodeType.File, filePath, `module-${fileIndex}.ts`);
        addEdge(builder, EdgeType.ContainsFile, packageNodeId, file);

        let previous: string | undefined;
        for (let functionIndex = 0; functionIndex < shape.functionsPerFile; functionIndex += 1) {
          const name = `handle_${fileIndex}_${functionIndex}`;
          const fn = addNode(builder, ids, NodeType.Function, filePath, name, { kind: 'function' });
          addEdge(builder, EdgeType.ContainsFunction, file, fn);
          // A chain inside the file: the one-hop callee set of an area is then
          // non-trivial without inventing cross-package edges nobody would have.
          if (previous) addEdge(builder, EdgeType.Calls, previous, fn);
          previous = fn;
          functionNodeIds.push(fn);
        }

        if (fileIndex === 0) {
          const routePath = `${packagePath}/routes.ts`;
          const routeFile = addNode(builder, ids, NodeType.File, routePath, 'routes.ts');
          addEdge(builder, EdgeType.ContainsFile, packageNodeId, routeFile);
          const route = addNode(builder, ids, NodeType.Route, routePath, `/${featureId}`, {
            method: 'GET',
            path: `/${featureId}`,
          });
          addEdge(builder, EdgeType.ContainsRoute, routeFile, route);
          addEdge(builder, EdgeType.Handles, route, functionNodeIds[0] as string);
        }
      }

      // The guard case: the handler calls a function no feature contains.
      addEdge(builder, EdgeType.Calls, functionNodeIds[0] as string, guardNodeId);

      features.push({
        featureId,
        repoKey,
        packageNodeId,
        handlerNodeId: functionNodeIds[0] as string,
        guardNodeId,
        functionNodeIds,
      });
    }
  }

  const driver = new LadybugDriver(databasePath, { readOnly: false });
  await driver.initialize();
  try {
    const repository = new LadybugRepository(driver);
    await repository.pushNodes(builder.nodes);
    await repository.pushEdges(builder.edges);
  } finally {
    await driver.close();
  }

  return {
    path: databasePath,
    repoKeys,
    repoHashByKey,
    commitByRepoKey,
    features,
    versionedIds: builder.versionedIds,
    nodeCount: builder.nodes.length,
    edgeCount: builder.edges.length,
    buildMs: Math.round(performance.now() - startedAt),
  };
}

export interface PerfRowCounts {
  domains: number;
  features: number;
  featureSeeds: number;
  items: number;
  anchors: number;
  reviewCandidates: number;
  insertMs: number;
}

export interface PerfWorkspaceRows {
  counts: PerfRowCounts;
  /** Accepted item ids, in id order — the exact-id workload's input pool. */
  acceptedItemIds: string[];
  /** Candidate ids reserved for review batches, never returned by a default read. */
  reviewCandidateIds: string[];
}

/** Deterministic candidate id — the review workload's items are addressed by index. */
export function perfReviewCandidateId(index: number): string {
  return `br-review-${String(index).padStart(4, '0')}`;
}

/**
 * Insert the control-plane and intent rows that address {@link buildPerfGraphFixture}.
 *
 * Attachment mix, chosen so the tree scope and the inheritance rule both have
 * something to do: two thirds of the items hang off a feature, a quarter off a
 * domain, the rest off the product root. Authority mix: mostly accepted, with
 * candidates and rejected items present so the authority filter is not free.
 */
export async function seedPerfWorkspaceRows(
  prisma: PrismaClient,
  workspaceId: string,
  authorId: string,
  graph: PerfGraphFixture,
  shape: PerfWorkspaceShape = PERF_WORKSPACE_SHAPE,
): Promise<PerfWorkspaceRows> {
  const startedAt = performance.now();
  const author = { createdBy: authorId, updatedBy: authorId };

  await prisma.workspaceRepo.createMany({
    data: graph.repoKeys.map((repoKey) => ({
      workspaceId,
      repoKey: graph.repoHashByKey[repoKey] as string,
      repoName: repoKey,
      intentRepoKey: repoKey,
      lastPushedAt: new Date('2026-08-30T10:00:00.000Z'),
    })),
  });

  await prisma.intentDomain.createMany({
    data: Array.from({ length: shape.repos }, (_unused, index) => ({
      workspaceId,
      id: perfDomainId(index),
      title: `Domain ${index}`,
      statement: `Everything service ${index} is responsible for.`,
      ...author,
    })),
  });

  await prisma.intentFeature.createMany({
    data: graph.features.map((feature) => ({
      workspaceId,
      id: feature.featureId,
      domainId: perfDomainId(graph.repoKeys.indexOf(feature.repoKey)),
      title: `Feature ${feature.featureId}`,
      statement: `The ${feature.featureId} capability of ${feature.repoKey}.`,
      ...author,
    })),
  });

  // One seed per feature, plus a second seed in the NEXT repository for every
  // sixth feature: a multi-repo union is then part of the measured shape.
  const seeds = graph.features.flatMap((feature, index) => {
    const own = {
      workspaceId,
      featureId: feature.featureId,
      repoKey: feature.repoKey,
      nodeId: feature.packageNodeId,
      createdBy: authorId,
    };
    if (index % 6 !== 0) return [own];
    const neighbour = graph.features[(index + shape.featuresPerRepo) % graph.features.length];
    if (!neighbour || neighbour.repoKey === feature.repoKey) return [own];
    return [
      own,
      {
        workspaceId,
        featureId: feature.featureId,
        repoKey: neighbour.repoKey,
        nodeId: neighbour.packageNodeId,
        createdBy: authorId,
      },
    ];
  });
  await prisma.intentFeatureSeed.createMany({ data: seeds });

  const acceptedItemIds: string[] = [];
  const items: Array<Record<string, unknown>> = [];
  for (let index = 0; index < shape.items; index += 1) {
    const { kind, prefix } = ITEM_KINDS[index % ITEM_KINDS.length] as (typeof ITEM_KINDS)[number];
    const id = `${prefix}-item-${String(index).padStart(4, '0')}`;
    const feature = graph.features[index % graph.features.length] as PerfFeatureNodes;
    const domainId = perfDomainId(graph.repoKeys.indexOf(feature.repoKey));
    const attachment =
      index % 12 < 8
        ? { domainId, featureId: feature.featureId }
        : index % 12 < 11
          ? { domainId, featureId: null }
          : { domainId: null, featureId: null };
    // Rejected items exist so the authority filter has rows to exclude; they are
    // reachable only through the exact-id path, which is one of the workloads.
    const authority = index % 20 === 19 ? 'rejected' : index % 20 === 18 ? 'candidate' : 'accepted';
    if (authority === 'accepted') acceptedItemIds.push(id);
    items.push({
      workspaceId,
      id,
      kind,
      ...attachment,
      title: `Rule ${index}`,
      statement:
        index % 7 === 0
          ? `The ${PERF_LEXICAL_PHRASE} for ${feature.featureId} closes thirty days after delivery.`
          : `Item ${index} states a bounded fact about ${feature.featureId} in ${feature.repoKey}.`,
      rationale: index % 5 === 0 ? `Finance owns item ${index}.` : null,
      authority,
      ...author,
    });
  }
  for (let index = 0; index < shape.reviewCandidates; index += 1) {
    const feature = graph.features[index % graph.features.length] as PerfFeatureNodes;
    items.push({
      workspaceId,
      id: perfReviewCandidateId(index),
      kind: IntentKind.BusinessRule,
      domainId: perfDomainId(graph.repoKeys.indexOf(feature.repoKey)),
      featureId: feature.featureId,
      title: `Proposed rule ${index}`,
      statement: `A proposed rule ${index} awaiting a decision.`,
      authority: 'candidate',
      ...author,
    });
  }
  await prisma.intentItem.createMany({ data: items as never });

  // Anchors: the first one per feature is the GUARD (the §6.2 case the node
  // workloads measure); the rest spread over functions inside feature areas.
  const anchors: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (let index = 0; index < shape.anchors; index += 1) {
    const feature = graph.features[index % graph.features.length] as PerfFeatureNodes;
    const guardTurn = index < graph.features.length;
    const node = guardTurn
      ? feature.guardNodeId
      : (feature.functionNodeIds[(index * 7) % feature.functionNodeIds.length] as string);
    const itemId = acceptedItemIds[index % acceptedItemIds.length] as string;
    const identity = `${itemId}|${feature.repoKey}|${node}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    anchors.push({
      workspaceId,
      itemId,
      repoKey: feature.repoKey,
      nodeId: node,
      nodeType: NodeType.Function,
      capturedVersionedId: graph.versionedIds[node] as string,
      createdBy: authorId,
    });
  }
  await prisma.intentAnchor.createMany({ data: anchors as never });

  return {
    counts: {
      domains: shape.repos,
      features: graph.features.length,
      featureSeeds: seeds.length,
      items: items.length,
      anchors: anchors.length,
      reviewCandidates: shape.reviewCandidates,
      insertMs: Math.round(performance.now() - startedAt),
    },
    acceptedItemIds,
    reviewCandidateIds: Array.from({ length: shape.reviewCandidates }, (_unused, index) =>
      perfReviewCandidateId(index),
    ),
  };
}

/** Remove everything {@link seedPerfWorkspaceRows} wrote, child rows first. */
export async function clearPerfWorkspaceRows(prisma: PrismaClient, workspaceId: string): Promise<void> {
  await prisma.intentAuthorityTransition.deleteMany({ where: { workspaceId } });
  await prisma.intentAnchor.deleteMany({ where: { workspaceId } });
  await prisma.intentItemSource.deleteMany({ where: { workspaceId } });
  await prisma.intentItem.updateMany({ where: { workspaceId }, data: { supersededById: null } });
  await prisma.intentItem.updateMany({ where: { workspaceId }, data: { proposedSuccessorOfId: null } });
  await prisma.intentItem.deleteMany({ where: { workspaceId } });
  await prisma.intentFeatureSeed.deleteMany({ where: { workspaceId } });
  await prisma.intentFeature.deleteMany({ where: { workspaceId } });
  await prisma.intentDomain.deleteMany({ where: { workspaceId } });
  await prisma.intentAuditEvent.deleteMany({ where: { workspaceId } });
  await prisma.intentMutationRequest.deleteMany({ where: { workspaceId } });
  await prisma.workspaceRepo.deleteMany({ where: { workspaceId } });
}
