/**
 * Prebuilt Ladybug graph fixture for intent-derivation tests.
 *
 * The only existing way to obtain a workspace-shaped graph file is the full R2
 * publish flow (build artifact → upload → version row → file cache lease),
 * which is far too heavy to assert a traversal against. This harness writes the
 * same file format DIRECTLY through the ordinary `@coredoc/db` write path
 * (`LadybugDriver` + `LadybugRepository.pushNodes/pushEdges`) — no R2, no
 * control plane, no publish job — and hands back the ids the assertions need,
 * so a test never has to reconstruct an id convention by hand.
 *
 * It lives in `src/` (not next to a single test file) because BOTH
 * `packages/db` and `apps/server` derivation suites open the same topology, and
 * a fixture whose shape is duplicated per package stops being one fixture.
 *
 * Runner constraint: opening a Ladybug database loads a native module, which is
 * unsafe under vitest's `threads` pool — every suite using this harness must run
 * under pool `forks` (both `packages/db` and `apps/server` vitest configs
 * already set it).
 */

import { EdgeType, NodeType, StableIdGenerator, type GraphEdge, type GraphNode } from '@coredoc/core';
import { LadybugDriver } from '../ladybug/driver.js';
import { LadybugRepository } from '../ladybug/repository.js';

export const FIXTURE_REPO_A_NAME = 'orders-api';
export const FIXTURE_REPO_B_NAME = 'reports-web';

/**
 * Graph repo hash (the `repoId` every node carries) of the fixture's first repo.
 *
 * DERIVED, never a readable literal: the hash is `sha256(repoKey)[0..12]`, and a
 * fixture that made one up could not produce a node id a production consumer
 * would recognise — `workspace_repos_intent_repo_key_graph_hash_check` refuses
 * the pairing, and `resolveNodes` reads the repository back out of the id.
 */
export const FIXTURE_REPO_A_HASH = new StableIdGenerator('', FIXTURE_REPO_A_NAME).getRepoHash();
/** Graph repo hash of the fixture's second repo. */
export const FIXTURE_REPO_B_HASH = new StableIdGenerator('', FIXTURE_REPO_B_NAME).getRepoHash();

/** Commit the fixture graph claims to have been parsed at, per repo. */
export const FIXTURE_REPO_A_COMMIT = 'a'.repeat(40);
export const FIXTURE_REPO_B_COMMIT = 'b'.repeat(40);

/** Node ids of one fixture repository, named after their role in the topology. */
export interface FixtureRepoNodes {
  repoHash: string;
  repoName: string;
  gitCommitHash: string;
  /** Seeded package: the containment root of the feature's area. */
  appPackage: string;
  /** Package deliberately OUTSIDE the seeded containment tree. */
  otherPackage: string;
  routesFile: string;
  handlersFile: string;
  guardsFile: string;
  /** File under {@link otherPackage} — reachable only through a call, never containment. */
  storeFile: string;
  /** Seeded route; reaches its handler through HANDLES, not containment. */
  route: string;
  /** The route's handler function. */
  handler: string;
  /** Class inside {@link handlersFile}, reached by `CONTAINS_CLASS`. */
  serviceClass: string;
  /**
   * Method of {@link serviceClass}. Reachable ONLY through `HAS_METHOD`: the
   * transformer emits `CONTAINS_FUNCTION` for `kind === 'function'` and nothing
   * else, so a method has no containment edge from its file.
   */
  serviceMethod: string;
  /** In the containment closure, called by nothing. */
  siblingHandler: string;
  /** The shared guard: called directly by {@link handler}, contained by nothing in the area. */
  guard: string;
  /** One hop from {@link handler} via CALLS, in another package of the same repo. */
  store: string;
  /** TWO hops from the seed — proof that the one-hop policy is not transitive. */
  deepHelper: string;
  /**
   * Called ONLY by {@link serviceMethod}, so it is reachable from
   * {@link handlersFile} only through `file → class → method → CALLS` — two
   * containment levels, which is the ordinary shape of a queried file in an OO
   * codebase.
   */
  methodCallee: string;
  /** Contained by {@link otherPackage} and called by nobody: never in the area. */
  unrelated: string;
  /** Synthetic in-closure functions added by {@link BuildIntentFixtureOptions.scale}. */
  syntheticFunctions: string[];
  /** Synthetic one-hop callees of {@link syntheticFunctions}. */
  syntheticCallees: string[];
}

export interface IntentGraphFixture {
  path: string;
  repoA: FixtureRepoNodes;
  repoB: FixtureRepoNodes;
  /** Captured versioned id per node id, as an anchor would have recorded it. */
  versionedIds: Record<string, string>;
  nodeCount: number;
  edgeCount: number;
}

export interface FixtureScale {
  /** Extra files added under the seeded package. */
  files: number;
  /** Functions contained by each generated file (all inside the closure). */
  functionsPerFile: number;
  /** Distinct one-hop callees each generated function calls. */
  calleesPerFunction: number;
}

export interface BuildIntentFixtureOptions {
  /**
   * Synthetic bulk on top of the hand-written topology, so a spike can measure
   * a realistic frontier. Omitted (the default) builds the small topology only,
   * which is what the semantic assertions want.
   */
  scale?: FixtureScale;
  /**
   * Durable repo keys the two repositories are minted under.
   *
   * KEYS, not hashes: the graph hash is `sha256(key)[0..12]` and every node id
   * starts with it, so handing the fixture a hash it cannot reproduce a key for
   * is exactly the drift `workspace_repos_intent_repo_key_graph_hash_check`
   * exists to catch. A suite that also writes `workspace_repos` rows passes the
   * same durable key it stores, and reads the hash back off `repoA.repoHash`.
   */
  repoKeys?: { a: string; b: string };
}

const NO_SCALE: FixtureScale = { files: 0, functionsPerFile: 0, calleesPerFunction: 0 };

function versionedId(nodeId: string): string {
  // Shape only — `{stableId}@{checksum}` is what IdGenerator emits. The value
  // never has to be reproducible from source here; anchor resolution compares
  // the captured string to the stored one and nothing else.
  let hash = 0;
  for (let index = 0; index < nodeId.length; index += 1) hash = (hash * 31 + nodeId.charCodeAt(index)) >>> 0;
  return `${nodeId}@${hash.toString(16).padStart(8, '0')}`;
}

interface FixtureBuilder {
  nodes: GraphNode[];
  edges: GraphEdge[];
  versionedIds: Record<string, string>;
}

/**
 * Mint a node id THE WAY PRODUCTION DOES, per kind.
 *
 * Not a `{repoHash}:{type}:{path}:{name}` template: the real shapes differ by
 * kind — a file and a package carry no name segment, a route's third segment is
 * a digest of its path — and a fixture that flattened them produced ids no
 * production rule could match (the enclosing-anchor rule constructs
 * `{repoHash}:file:{path}` from a function id and found nothing). Delegating to
 * `StableIdGenerator` is what keeps the two from drifting apart again.
 *
 * Throws on a kind the fixture has never minted, rather than silently inventing
 * a shape for it.
 */
function mintNodeId(ids: StableIdGenerator, type: NodeType, path: string, name: string): string {
  switch (type) {
    case NodeType.Package:
      return ids.packageId(path);
    case NodeType.File:
      return ids.fileId(path);
    case NodeType.Function:
      return ids.functionId(path, name);
    case NodeType.Class:
      return ids.classId(path, name);
    case NodeType.Route:
      // The route's own path IS its identity; `name` carries it here.
      return ids.routeId(name);
    default:
      throw new Error(`intent graph fixture does not mint ${type} node ids`);
  }
}

function addNode(
  builder: FixtureBuilder,
  ids: StableIdGenerator,
  type: NodeType,
  path: string,
  name: string,
  properties: Record<string, unknown> = {},
): string {
  return addNodeWithId(builder, ids, mintNodeId(ids, type, path, name), type, path, name, properties);
}

function addNodeWithId(
  builder: FixtureBuilder,
  ids: StableIdGenerator,
  id: string,
  type: NodeType,
  path: string,
  name: string,
  properties: Record<string, unknown> = {},
): string {
  const repoHash = ids.getRepoHash();
  // Only the kinds the versioned-anchor contract covers carry a versionedId;
  // a Route/Package deliberately does not, which is exactly what the seeds-vs-
  // anchors allowlist split in the spec is about.
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
    endLine: 10,
  });
  return id;
}

function addEdge(builder: FixtureBuilder, type: EdgeType, sourceId: string, targetId: string): void {
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

function buildRepo(
  builder: FixtureBuilder,
  ids: StableIdGenerator,
  repoName: string,
  gitCommitHash: string,
  routePath: string,
  scale: FixtureScale,
): FixtureRepoNodes {
  const repoHash = ids.getRepoHash();
  builder.nodes.push({
    id: repoHash,
    type: NodeType.Repository,
    name: repoName,
    properties: { type: 'backend', parsedAt: '2026-09-01T00:00:00.000Z', gitCommitHash },
  });

  const appPackage = addNode(builder, ids, NodeType.Package, 'src/app', 'app');
  const otherPackage = addNode(builder, ids, NodeType.Package, 'src/store', 'store');
  const routesFile = addNode(builder, ids, NodeType.File, 'src/app/routes.ts', 'routes.ts');
  const handlersFile = addNode(builder, ids, NodeType.File, 'src/app/handlers.ts', 'handlers.ts');
  const guardsFile = addNode(builder, ids, NodeType.File, 'src/app/guards.ts', 'guards.ts');
  const storeFile = addNode(builder, ids, NodeType.File, 'src/store/store.ts', 'store.ts');

  const route = addNode(builder, ids, NodeType.Route, 'src/app/routes.ts', routePath, {
    method: 'GET',
    path: routePath,
  });
  const handler = addNode(builder, ids, NodeType.Function, 'src/app/handlers.ts', 'handleRequest', {
    kind: 'function',
  });
  const siblingHandler = addNode(builder, ids, NodeType.Function, 'src/app/handlers.ts', 'siblingHandler', {
    kind: 'function',
  });
  const guard = addNode(builder, ids, NodeType.Function, 'src/app/guards.ts', 'assertAdmin', {
    kind: 'function',
  });
  const store = addNode(builder, ids, NodeType.Function, 'src/store/store.ts', 'loadRecords', {
    kind: 'function',
  });
  const deepHelper = addNode(builder, ids, NodeType.Function, 'src/store/store.ts', 'deepHelper', {
    kind: 'function',
  });
  const unrelated = addNode(builder, ids, NodeType.Function, 'src/store/store.ts', 'unrelatedHelper', {
    kind: 'function',
  });
  const methodCallee = addNode(builder, ids, NodeType.Function, 'src/store/store.ts', 'settleRecords', {
    kind: 'function',
  });

  const serviceClass = addNode(builder, ids, NodeType.Class, 'src/app/handlers.ts', 'OrdersService');
  // A METHOD, exactly as the transformer emits one: a Function node carrying
  // `kind: 'method'`, a method-shaped id, and NO containment edge from its file
  // — `createContainsFunctionEdges` filters on `kind === 'function'`, so
  // `HAS_METHOD` from the class is the only edge that reaches it.
  const serviceMethod = addNodeWithId(
    builder,
    ids,
    ids.methodId('src/app/handlers.ts', 'OrdersService', 'settle'),
    NodeType.Function,
    'src/app/handlers.ts',
    'settle',
    { kind: 'method' },
  );

  addEdge(builder, EdgeType.ContainsFile, appPackage, routesFile);
  addEdge(builder, EdgeType.ContainsFile, appPackage, handlersFile);
  addEdge(builder, EdgeType.ContainsFile, appPackage, guardsFile);
  addEdge(builder, EdgeType.ContainsFile, otherPackage, storeFile);
  addEdge(builder, EdgeType.ContainsRoute, routesFile, route);
  addEdge(builder, EdgeType.ContainsFunction, handlersFile, handler);
  addEdge(builder, EdgeType.ContainsFunction, handlersFile, siblingHandler);
  addEdge(builder, EdgeType.ContainsFunction, guardsFile, guard);
  addEdge(builder, EdgeType.ContainsFunction, storeFile, store);
  addEdge(builder, EdgeType.ContainsFunction, storeFile, deepHelper);
  addEdge(builder, EdgeType.ContainsFunction, storeFile, unrelated);
  addEdge(builder, EdgeType.ContainsFunction, storeFile, methodCallee);
  addEdge(builder, EdgeType.ContainsClass, handlersFile, serviceClass);
  addEdge(builder, EdgeType.HasMethod, serviceClass, serviceMethod);

  addEdge(builder, EdgeType.Handles, route, handler);
  addEdge(builder, EdgeType.Calls, handler, guard);
  addEdge(builder, EdgeType.Calls, handler, store);
  addEdge(builder, EdgeType.Calls, store, deepHelper);
  addEdge(builder, EdgeType.Calls, serviceMethod, methodCallee);

  const syntheticFunctions: string[] = [];
  const syntheticCallees: string[] = [];
  for (let fileIndex = 0; fileIndex < scale.files; fileIndex += 1) {
    const path = `src/app/generated-${fileIndex}.ts`;
    const file = addNode(builder, ids, NodeType.File, path, `generated-${fileIndex}.ts`);
    addEdge(builder, EdgeType.ContainsFile, appPackage, file);
    for (let functionIndex = 0; functionIndex < scale.functionsPerFile; functionIndex += 1) {
      const generated = addNode(builder, ids, NodeType.Function, path, `generated${fileIndex}_${functionIndex}`, {
        kind: 'function',
      });
      addEdge(builder, EdgeType.ContainsFunction, file, generated);
      syntheticFunctions.push(generated);
    }
  }
  for (let index = 0; index < syntheticFunctions.length; index += 1) {
    const source = syntheticFunctions[index] as string;
    for (let offset = 1; offset <= scale.calleesPerFunction; offset += 1) {
      // Callees live under the NON-seeded package, so the synthetic bulk grows
      // the one-hop callee set rather than just re-walking the closure.
      const calleePath = 'src/store/generated-callees.ts';
      const name = `callee${(index + offset) % Math.max(1, syntheticFunctions.length)}`;
      const callee = mintNodeId(ids, NodeType.Function, calleePath, name);
      if (!syntheticCallees.includes(callee)) {
        addNode(builder, ids, NodeType.Function, calleePath, name, { kind: 'function' });
        addEdge(builder, EdgeType.ContainsFunction, storeFile, callee);
        syntheticCallees.push(callee);
      }
      addEdge(builder, EdgeType.Calls, source, callee);
    }
  }

  return {
    repoHash,
    repoName,
    gitCommitHash,
    appPackage,
    otherPackage,
    routesFile,
    handlersFile,
    guardsFile,
    storeFile,
    route,
    handler,
    serviceClass,
    serviceMethod,
    siblingHandler,
    guard,
    store,
    deepHelper,
    methodCallee,
    unrelated,
    syntheticFunctions,
    syntheticCallees,
  };
}

/**
 * Write the fixture graph to `databasePath` and return the ids it contains.
 *
 * Topology (identical in both repos, so a multi-repo union has something to
 * union): a seeded Route reaches its handler through HANDLES; the handler's
 * package contains a sibling function and the guard; the handler CALLS the
 * guard and a store function in ANOTHER package; the store function calls a
 * deeper helper that must stay out of a one-hop area; a class in the same file
 * owns a method reachable only through HAS_METHOD. Repo B's handler also
 * CALLS repo A's guard — the cross-repo edge that must NOT extend repo B's
 * area.
 */
export async function buildIntentGraphFixture(
  databasePath: string,
  options: BuildIntentFixtureOptions = {},
): Promise<IntentGraphFixture> {
  const scale = options.scale ?? NO_SCALE;
  const idsA = new StableIdGenerator('', options.repoKeys?.a ?? FIXTURE_REPO_A_NAME);
  const idsB = new StableIdGenerator('', options.repoKeys?.b ?? FIXTURE_REPO_B_NAME);
  const builder: FixtureBuilder = { nodes: [], edges: [], versionedIds: {} };
  const repoA = buildRepo(builder, idsA, FIXTURE_REPO_A_NAME, FIXTURE_REPO_A_COMMIT, '/orders', scale);
  const repoB = buildRepo(builder, idsB, FIXTURE_REPO_B_NAME, FIXTURE_REPO_B_COMMIT, '/reports', scale);
  // The cross-repo call: repo B's handler calls repo A's guard. Area
  // computation is per-repo, so this edge must never pull the guard into
  // area(feature-in-B) — the fixture exists to make that assertable.
  addEdge(builder, EdgeType.Calls, repoB.handler, repoA.guard);

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
    repoA,
    repoB,
    versionedIds: builder.versionedIds,
    nodeCount: builder.nodes.length,
    edgeCount: builder.edges.length,
  };
}

export interface OpenedIntentGraphFixture {
  driver: LadybugDriver;
  repository: LadybugRepository;
  close(): Promise<void>;
}

/**
 * Open a fixture built by {@link buildIntentGraphFixture}.
 *
 * Read-only by default: it is how the server serves a published snapshot, and
 * it is the ONLY handle on which `runReadOnlyCypher*` is allowed to run.
 */
export async function openIntentGraphFixture(
  databasePath: string,
  options: { readOnly?: boolean } = {},
): Promise<OpenedIntentGraphFixture> {
  const driver = new LadybugDriver(databasePath, { readOnly: options.readOnly ?? true });
  await driver.initialize();
  return {
    driver,
    repository: new LadybugRepository(driver),
    close: () => driver.close(),
  };
}
