import {
  EdgeType,
  GraphApplyMode,
  NodeType,
  type GraphEdge,
  type GraphNode,
  type IGraphRepository,
  type UnresolvedCallRecord,
} from '../types.js';

export const CONTRACT_REPO_A = 'aaa111aaa111';
export const CONTRACT_REPO_B = 'bbb222bbb222';
export const CONTRACT_OUT_OF_SCOPE_REPO = 'zzz999zzz999';
export const CONTRACT_BRIDGE_REPO_C = 'ccc333ccc333';
export const CONTRACT_BRIDGE_REPO_D = 'ddd444ddd444';

const LIMIT_PROBE_IDS = Object.freeze(
  Array.from(
    { length: 1005 },
    (_, index) => `${CONTRACT_REPO_A}:variable:limit-probe-${index.toString().padStart(4, '0')}`,
  ),
);
const ENTRYPOINT_LIMIT_IDS = Object.freeze(
  Array.from(
    { length: 1005 },
    (_, index) => `${CONTRACT_REPO_B}:entrypoint:limit-probe-${index.toString().padStart(4, '0')}`,
  ),
);
const PAGINATION_EDGE_IDS = Object.freeze(
  LIMIT_PROBE_IDS.slice(0, 205).map((_, index) => `contract:pagination-neighbor:${index.toString().padStart(4, '0')}`),
);
const DEEP_CALL_NODE_IDS = Object.freeze(
  Array.from(
    { length: 13 },
    (_, index) => `${CONTRACT_REPO_A}:function:src/deep.ts:deep-${index.toString().padStart(2, '0')}`,
  ),
);
const DEEP_CALL_EDGE_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => `contract:deep-call:${index.toString().padStart(2, '0')}`),
);
const BRIDGE_LIMIT_SOURCE_IDS = Object.freeze(
  Array.from(
    { length: 201 },
    (_, index) => `${CONTRACT_BRIDGE_REPO_C}:external-call:limit-${index.toString().padStart(3, '0')}`,
  ),
);
const BRIDGE_LIMIT_TARGET_IDS = Object.freeze(
  Array.from(
    { length: 201 },
    (_, index) => `${CONTRACT_BRIDGE_REPO_D}:entrypoint:limit-${index.toString().padStart(3, '0')}`,
  ),
);
const BRIDGE_LIMIT_EDGE_IDS = Object.freeze(
  Array.from({ length: 201 }, (_, index) => `contract:bridge-limit:${index.toString().padStart(3, '0')}`),
);

const CAP_CALLER_IDS = Object.freeze(
  Array.from(
    { length: 105 },
    (_, index) => `${CONTRACT_REPO_A}:function:src/cap/caller-${index.toString().padStart(3, '0')}.ts:caller`,
  ),
);
const CAP_CALL_EDGE_IDS = Object.freeze(
  CAP_CALLER_IDS.map((_, index) => `contract:cap-call:${index.toString().padStart(3, '0')}`),
);
const CAP_CONTAINMENT_EDGE_IDS = Object.freeze(
  CAP_CALLER_IDS.map((_, index) => `contract:cap-containment:${index.toString().padStart(3, '0')}`),
);
const DIRECT_CAP_CALL_EDGE_IDS = Object.freeze(
  CAP_CALLER_IDS.slice(0, 99).map((_, index) => `contract:direct-cap-call:${index.toString().padStart(3, '0')}`),
);
const DIRECT_CAP_REFERENCE_EDGE_IDS = Object.freeze([
  'contract:direct-cap-reference:000-overlap',
  'contract:direct-cap-reference:099',
  'contract:direct-cap-reference:100',
]);
const REACHING_CAP_EDGE_IDS = Object.freeze(
  Array.from({ length: 25 }, (_, index) => `contract:reaching-cap:${index.toString().padStart(3, '0')}`),
);
const CALL_TREE_CAP_NODE_IDS = Object.freeze(
  Array.from(
    { length: 204 },
    (_, index) => `${CONTRACT_REPO_A}:function:src/call-tree-cap.ts:child-${index.toString().padStart(3, '0')}`,
  ),
);
const CALL_TREE_CAP_EDGE_IDS = Object.freeze(
  CALL_TREE_CAP_NODE_IDS.map((_, index) => `contract:call-tree-cap:${index.toString().padStart(3, '0')}`),
);
const SUPPORT_EDGE_IDS = Object.freeze([
  'contract:contains-package:a1',
  'contract:contains-package:a2',
  'contract:contains-package:b',
  'contract:contains-file:symbols',
  'contract:contains-file:secondary',
  'contract:contains-file:data',
  'contract:contains-file:beta',
  'contract:contains-function:shared',
  'contract:contains-class:base',
  'contract:contains-interface',
  'contract:contains-enum',
  'contract:contains-alias',
  'contract:contains-variable',
  'contract:contains-entity',
  'contract:contains-component',
  'contract:contains-route',
  'contract:has-method',
  'contract:imports',
  'contract:path:left-target',
  'contract:path:right-target',
  'contract:extends',
  'contract:implements',
  'contract:uses-type',
  'contract:operates-on',
  'contract:renders-component',
  'contract:uses-component',
  'contract:references-variable',
]);

export const CONTRACT_IDS = Object.freeze({
  repositoryA: CONTRACT_REPO_A,
  repositoryB: CONTRACT_REPO_B,
  packageA1: `${CONTRACT_REPO_A}:package:alpha-core`,
  packageA2: `${CONTRACT_REPO_A}:package:alpha-data`,
  packageB: `${CONTRACT_REPO_B}:package:beta-core`,
  fileSymbols: `${CONTRACT_REPO_A}:file:src/symbols.ts`,
  fileSecondary: `${CONTRACT_REPO_A}:file:src/secondary.ts`,
  fileData: `${CONTRACT_REPO_A}:file:src/data.ts`,
  fileBeta: `${CONTRACT_REPO_B}:file:src/beta.ts`,
  sharedA1: `${CONTRACT_REPO_A}:function:src/symbols.ts:sharedName`,
  sharedA2: `${CONTRACT_REPO_A}:function:src/secondary.ts:sharedName`,
  sharedB: `${CONTRACT_REPO_B}:function:src/beta.ts:sharedName`,
  unicodeFunction: `${CONTRACT_REPO_A}:function:src/symbols.ts:unicode`,
  escapedSearchFunction: `${CONTRACT_REPO_A}:function:src/symbols.ts:escaped-search`,
  classMethod: `${CONTRACT_REPO_A}:function:src/service.ts:Service.run`,
  baseClass: `${CONTRACT_REPO_A}:class:src/service.ts:BaseService`,
  childClass: `${CONTRACT_REPO_A}:class:src/child.ts:ChildService`,
  interfaceNode: `${CONTRACT_REPO_A}:interface:src/service.ts:Runnable`,
  implementingClass: `${CONTRACT_REPO_A}:class:src/service.ts:Service`,
  enumNode: `${CONTRACT_REPO_A}:enum:src/symbols.ts:Status`,
  typeAlias: `${CONTRACT_REPO_A}:type-alias:src/symbols.ts:Identifier`,
  entity: `${CONTRACT_REPO_A}:entity:src/data.ts:User`,
  entityConsumer: `${CONTRACT_REPO_A}:function:src/service.ts:Service.run`,
  typeUser: `${CONTRACT_REPO_A}:function:src/service.ts:Service.run`,
  entrypointA: `${CONTRACT_REPO_A}:entrypoint:01-http`,
  queueEntrypointA: `${CONTRACT_REPO_A}:entrypoint:02-queue`,
  eventEntrypointA: `${CONTRACT_REPO_A}:entrypoint:03-event`,
  mobileEntrypointA: `${CONTRACT_REPO_A}:entrypoint:04-mobile`,
  entrypointB1: `${CONTRACT_REPO_B}:entrypoint:01-items`,
  entrypointB2: `${CONTRACT_REPO_B}:entrypoint:02-orders`,
  handlerA: `${CONTRACT_REPO_A}:function:src/cycle.ts:cycle-a`,
  handlerB1: `${CONTRACT_REPO_B}:function:src/beta.ts:handler-one`,
  handlerB2: `${CONTRACT_REPO_B}:function:src/beta.ts:handler-two`,
  cycleA: `${CONTRACT_REPO_A}:function:src/cycle.ts:cycle-a`,
  cycleB: `${CONTRACT_REPO_A}:function:src/cycle.ts:cycle-b`,
  cycleC: `${CONTRACT_REPO_A}:function:src/cycle.ts:cycle-c`,
  pathStart: `${CONTRACT_REPO_A}:function:src/path.ts:path-start`,
  pathLeft: `${CONTRACT_REPO_A}:function:src/path.ts:path-left`,
  pathRight: `${CONTRACT_REPO_A}:function:src/path.ts:path-right`,
  pathTarget: `${CONTRACT_REPO_A}:function:src/path.ts:path-target`,
  orphan1: `${CONTRACT_REPO_A}:function:src/orphan.ts:orphan-01`,
  orphan2: `${CONTRACT_REPO_A}:function:src/orphan.ts:orphan-02`,
  externalCall1: `${CONTRACT_REPO_A}:external-call:01-http`,
  externalCall2: `${CONTRACT_REPO_A}:external-call:02-messaging`,
  externalCallWithoutEdge: `${CONTRACT_REPO_A}:external-call:03-without-edge`,
  externalCallResolvedUnnamed: `${CONTRACT_REPO_A}:external-call:04-resolved-unnamed`,
  externalCallUnresolvedUnnamed: `${CONTRACT_REPO_A}:external-call:05-unresolved-unnamed`,
  monikerFunction: `${CONTRACT_REPO_A}:function:src/sdk.ts:monikered`,
  synthesizedFunction: `${CONTRACT_REPO_A}:function:src/models/company.rb:employees`,
  embeddedFunction: `${CONTRACT_REPO_A}:function:src/search.ts:embedded`,
  componentA: `${CONTRACT_REPO_A}:component:ContractPanel`,
  stateStoreA: `${CONTRACT_REPO_A}:state-store:ContractState`,
  dependencySource: `${CONTRACT_REPO_A}:function:src/symbols.ts:dependency-source`,
  dependencyTarget: `${CONTRACT_REPO_A}:function:src/data.ts:dependency-target`,
  capTarget: `${CONTRACT_REPO_A}:function:src/cap/target.ts:target`,
  directCapTarget: `${CONTRACT_REPO_A}:function:src/cap/direct-target.ts:target`,
  callTreeCapRoot: `${CONTRACT_REPO_A}:function:src/call-tree-cap.ts:root`,
  callTreeCapNodeIds: CALL_TREE_CAP_NODE_IDS,
  scopeTraversalRoot: `${CONTRACT_REPO_A}:type-alias:scope-root`,
  scopeTraversalForeign: `${CONTRACT_OUT_OF_SCOPE_REPO}:type-alias:scope-foreign`,
  scopeTraversalTarget: `${CONTRACT_REPO_A}:type-alias:scope-target`,
  callTreeScopeRoot: `${CONTRACT_REPO_A}:function:src/scope.ts:scope-root`,
  callTreeScopeForeign: `${CONTRACT_OUT_OF_SCOPE_REPO}:function:src/scope.ts:scope-foreign`,
  callTreeScopeTarget: `${CONTRACT_REPO_A}:function:src/scope.ts:scope-target`,
  capCallerIds: CAP_CALLER_IDS,
  limitProbeIds: LIMIT_PROBE_IDS,
  entrypointLimitIds: ENTRYPOINT_LIMIT_IDS,
  paginationEdgeIds: PAGINATION_EDGE_IDS,
  deepCallNodeIds: DEEP_CALL_NODE_IDS,
  deepCallEdgeIds: DEEP_CALL_EDGE_IDS,
  deepAllowedEntrypoint: `${CONTRACT_REPO_A}:entrypoint:deep-allowed`,
  deepTooFarEntrypoint: `${CONTRACT_REPO_A}:entrypoint:deep-too-far`,
  deepAllowedHandlesEdge: 'contract:deep-handles:allowed',
  deepTooFarHandlesEdge: 'contract:deep-handles:too-far',
  bridgeLimitSourceIds: BRIDGE_LIMIT_SOURCE_IDS,
  bridgeLimitTargetIds: BRIDGE_LIMIT_TARGET_IDS,
  bridgeLimitEdgeIds: BRIDGE_LIMIT_EDGE_IDS,
  variable: `${CONTRACT_REPO_A}:variable:src/symbols.ts:contractValue`,
  route: `${CONTRACT_REPO_A}:route:src/routes.ts:contract-route`,
  routeOrderA: `${CONTRACT_REPO_A}:route:scope-order:a`,
  routeOrderZ: `${CONTRACT_REPO_A}:route:scope-order:z`,
  neighborEdge1: 'contract:neighbor:01-left',
  neighborEdge2: 'contract:neighbor:02-right',
  neighbor1: 'contract:neighbor:01-left',
  neighbor2: 'contract:neighbor:02-right',
  cycleEdgeAB: 'contract:cycle:ab',
  cycleEdgeBC: 'contract:cycle:bc',
  cycleEdgeCA: 'contract:cycle:ca',
  dependencyEdge: 'contract:dependency:source-target',
  dependencySourceContainment: 'contract:contains-function:dependency-source',
  dependencyTargetContainment: 'contract:contains-function:dependency-target',
  makesExternalEdge1: 'contract:makes-external:01',
  makesExternalEdge2: 'contract:makes-external:02',
  makesExternalEdge4: 'contract:makes-external:04',
  makesExternalEdge5: 'contract:makes-external:05',
  bridgeEdge1: 'contract:resolves:01',
  bridgeEdge2: 'contract:resolves:02',
  bridgeEdge4: 'contract:resolves:04',
  bridge1: 'contract:resolves:01',
  bridge2: 'contract:resolves:02',
  handlesAEdge: 'contract:handles:a',
  handlesQueueAEdge: 'contract:handles:a-queue',
  handlesB1Edge: 'contract:handles:b1',
  handlesB2Edge: 'contract:handles:b2',
  capCallEdgeIds: CAP_CALL_EDGE_IDS,
  capContainmentEdgeIds: CAP_CONTAINMENT_EDGE_IDS,
  directCapCallEdgeIds: DIRECT_CAP_CALL_EDGE_IDS,
  directCapReferenceEdgeIds: DIRECT_CAP_REFERENCE_EDGE_IDS,
  reachingCapEdgeIds: REACHING_CAP_EDGE_IDS,
  callTreeCapEdgeIds: CALL_TREE_CAP_EDGE_IDS,
  callTreeCapCycleEdge: 'contract:call-tree-cap:root-cycle',
  scopeTraversalRootEdge: 'contract:scope-traversal:root-foreign',
  scopeTraversalTargetEdge: 'contract:scope-traversal:foreign-target',
  componentCallerEdge: 'contract:direct-caller:component',
  callTreeScopeRootEdge: 'contract:call-tree-scope:root-foreign',
  callTreeScopeTargetEdge: 'contract:call-tree-scope:foreign-target',
  allPlantedEdgeIds: Object.freeze([
    ...SUPPORT_EDGE_IDS,
    'contract:contains-function:dependency-source',
    'contract:contains-function:dependency-target',
    'contract:neighbor:01-left',
    'contract:neighbor:02-right',
    'contract:cycle:ab',
    'contract:cycle:bc',
    'contract:cycle:ca',
    'contract:dependency:source-target',
    'contract:calls:embedded-moniker',
    'contract:calls:synthesized-path-target',
    'contract:makes-external:01',
    'contract:makes-external:02',
    'contract:makes-external:04',
    'contract:makes-external:05',
    'contract:resolves:01',
    'contract:resolves:02',
    'contract:resolves:04',
    'contract:handles:a',
    'contract:handles:a-queue',
    'contract:handles:b1',
    'contract:handles:b2',
    'contract:deep-handles:allowed',
    'contract:deep-handles:too-far',
    ...PAGINATION_EDGE_IDS,
    ...DEEP_CALL_EDGE_IDS,
    ...BRIDGE_LIMIT_EDGE_IDS,
    ...CAP_CALL_EDGE_IDS,
    ...CAP_CONTAINMENT_EDGE_IDS,
    ...DIRECT_CAP_CALL_EDGE_IDS,
    ...DIRECT_CAP_REFERENCE_EDGE_IDS,
    ...REACHING_CAP_EDGE_IDS,
    ...CALL_TREE_CAP_EDGE_IDS,
    'contract:call-tree-cap:root-cycle',
    'contract:scope-traversal:root-foreign',
    'contract:scope-traversal:foreign-target',
    'contract:direct-caller:component',
    'contract:call-tree-scope:root-foreign',
    'contract:call-tree-scope:foreign-target',
  ]),
  edges: Object.freeze({
    targetCallsCycle: 'contract:cycle:ab',
    cycleCallsThird: 'contract:cycle:bc',
    cycleThirdCallsTarget: 'contract:cycle:ca',
    sharedMakesExternalCall: 'contract:makes-external:01',
    sharedMakesExternalCall2: 'contract:makes-external:02',
    remoteEntrypointHandlesRemote: 'contract:handles:b1',
    remoteEntrypoint2HandlesRemote: 'contract:handles:b2',
  }),
});

interface NodeOptions {
  repoId?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  properties?: Record<string, unknown>;
  summary?: string;
  embedding?: number[];
}

function graphNode(id: string, type: NodeType, name: string, options: NodeOptions = {}): GraphNode {
  const node: GraphNode = { id, type, name, properties: options.properties ?? {} };
  if (options.repoId !== undefined) node.repoId = options.repoId;
  if (options.filePath !== undefined) node.filePath = options.filePath;
  if (options.startLine !== undefined) node.startLine = options.startLine;
  if (options.endLine !== undefined) node.endLine = options.endLine;
  if (options.summary !== undefined) node.summary = options.summary;
  if (options.embedding !== undefined) node.embedding = options.embedding;
  return node;
}

function functionNode(
  id: string,
  name: string,
  repoId: string,
  filePath: string,
  fileId: string,
  startLine: number,
  properties: Record<string, unknown> = {},
  options: Pick<NodeOptions, 'summary' | 'embedding'> = {},
): GraphNode {
  return graphNode(id, NodeType.Function, name, {
    repoId,
    filePath,
    startLine,
    endLine: startLine + 1,
    properties: {
      kind: 'function',
      fileId,
      isAsync: false,
      isGenerator: false,
      isExported: true,
      ...properties,
    },
    ...options,
  });
}

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  type: EdgeType,
  properties: Record<string, unknown> = {},
  confidence = 1,
  createdBy: GraphEdge['createdBy'] = 'parser',
): GraphEdge {
  return { id, sourceId, targetId, type, properties, confidence, createdBy };
}

function fixtureNodes(): GraphNode[] {
  const id = CONTRACT_IDS;
  const nodes: GraphNode[] = [
    graphNode(id.repositoryA, NodeType.Repository, 'contract-alpha', {
      properties: {
        type: 'backend',
        parsedAt: '2026-08-10T00:00:00.000Z',
        parserVersion: 'contract-v1',
        gitRemoteUrl: 'https://example.test/alpha.git',
        // Measured call and db-op resolution; contract-beta deliberately carries neither.
        callSites: 12,
        analysis: JSON.stringify([{ language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: true }]),
        resolvedCalls: 7,
        outOfScopeCalls: 3,
        dbOpSites: 9,
        boundDbOps: 5,
        outOfScopeDbOps: 2,
      },
    }),
    graphNode(id.repositoryB, NodeType.Repository, 'contract-beta', {
      properties: { type: 'service', parsedAt: '2026-08-10T00:00:01.000Z' },
    }),
    graphNode(id.packageA1, NodeType.Package, 'alpha-core', {
      repoId: CONTRACT_REPO_A,
      properties: { path: 'packages/core', packageType: 'workspace', language: 'typescript' },
    }),
    graphNode(id.packageA2, NodeType.Package, 'alpha-data', {
      repoId: CONTRACT_REPO_A,
      properties: { path: 'packages/data', packageType: 'workspace', language: 'typescript' },
    }),
    graphNode(id.packageB, NodeType.Package, 'beta-core', {
      repoId: CONTRACT_REPO_B,
      properties: { path: 'packages/beta', packageType: 'workspace', language: 'typescript' },
    }),
    graphNode(id.fileSymbols, NodeType.File, 'symbols.ts', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/symbols.ts',
      properties: { path: 'src/symbols.ts', packageId: id.packageA1, language: 'typescript' },
    }),
    graphNode(id.fileSecondary, NodeType.File, 'secondary.ts', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/secondary.ts',
      properties: { path: 'src/secondary.ts', packageId: id.packageA1, language: 'typescript' },
    }),
    graphNode(id.fileData, NodeType.File, 'data.ts', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/data.ts',
      properties: { path: 'src/data.ts', packageId: id.packageA2, language: 'typescript' },
    }),
    graphNode(id.fileBeta, NodeType.File, 'beta.ts', {
      repoId: CONTRACT_REPO_B,
      filePath: 'src/beta.ts',
      properties: { path: 'src/beta.ts', packageId: id.packageB, language: 'typescript' },
    }),
    functionNode(
      id.sharedA1,
      'sharedName',
      CONTRACT_REPO_A,
      'src/symbols.ts',
      id.fileSymbols,
      10,
      {},
      {
        summary: 'present only on the first duplicate',
      },
    ),
    functionNode(id.sharedA2, 'sharedName', CONTRACT_REPO_A, 'src/secondary.ts', id.fileSecondary, 5),
    functionNode(id.sharedB, 'sharedName', CONTRACT_REPO_B, 'src/beta.ts', id.fileBeta, 5),
    functionNode(id.unicodeFunction, 'Überprüfen_日本', CONTRACT_REPO_A, 'src/symbols.ts', id.fileSymbols, 20, {
      explicitNull: null,
      unicode: 'Привіт 世界',
      orderedList: ['β', 2, null],
      numeric: 7.5,
    }),
    functionNode(
      id.escapedSearchFunction,
      'prefix_pct%under_score_suffix雪',
      CONTRACT_REPO_A,
      'src/symbols.ts',
      id.fileSymbols,
      21,
    ),
    graphNode(id.baseClass, NodeType.Class, 'BaseService', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/service.ts',
      startLine: 1,
      endLine: 10,
      properties: {
        fileId: id.fileSymbols,
        isExported: true,
        isAbstract: true,
        properties_: [{ name: 'client', visibility: 'protected', typeText: 'Client' }],
      },
    }),
    graphNode(id.childClass, NodeType.Class, 'ChildService', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/child.ts',
      startLine: 1,
      endLine: 10,
      properties: { fileId: id.fileSymbols, isExported: true, isAbstract: false, extendsId: id.baseClass },
    }),
    graphNode(id.implementingClass, NodeType.Class, 'Service', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/service.ts',
      startLine: 20,
      endLine: 40,
      properties: { fileId: id.fileSymbols, isExported: true, isAbstract: false },
    }),
    functionNode(id.classMethod, 'run', CONTRACT_REPO_A, 'src/service.ts', id.fileSymbols, 25, {
      kind: 'method',
      classId: id.implementingClass,
      className: 'Service',
      visibility: 'public',
    }),
    graphNode(id.interfaceNode, NodeType.Interface, 'Runnable', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/service.ts',
      startLine: 15,
      endLine: 19,
      properties: {
        fileId: id.fileSymbols,
        isExported: true,
        members: [{ name: 'run', kind: 'method', returnTypeText: 'void' }],
      },
    }),
    graphNode(id.enumNode, NodeType.Enum, 'Status', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/status.ts',
      startLine: 1,
      endLine: 4,
      properties: {
        fileId: id.fileSymbols,
        isExported: true,
        members: [
          { name: 'Ready', value: 1 },
          { name: 'Paused', value: 'pause' },
        ],
      },
    }),
    graphNode(id.typeAlias, NodeType.TypeAlias, 'Identifier', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/types.ts',
      startLine: 1,
      endLine: 1,
      properties: { fileId: id.fileSymbols, isExported: true, aliasedTypeText: 'string | number' },
    }),
    graphNode(id.entity, NodeType.Entity, 'User', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/data.ts',
      startLine: 1,
      endLine: 20,
      properties: {
        fileId: id.fileData,
        ormType: 'orm',
        tableName: 'users',
        fields: [
          { name: 'id', type: 'string', isPrimary: true, isNullable: false },
          { name: 'displayName', type: 'string', isPrimary: false, isNullable: false },
        ],
        relations: [{ name: 'manager', targetEntity: 'User', relationType: 'many-to-one' }],
        indexes: [{ name: 'users_display_name_idx', fields: ['displayName'], isUnique: false }],
      },
    }),
    graphNode(id.entrypointA, NodeType.Entrypoint, 'GET /items', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/http.ts',
      startLine: 1,
      endLine: 2,
      properties: { entrypointType: 'http', method: 'GET', path: '/items', fullPath: '/items', handlerId: id.handlerA },
    }),
    graphNode(id.queueEntrypointA, NodeType.Entrypoint, 'orders.Δ', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/queue.ts',
      startLine: 1,
      endLine: 2,
      properties: {
        entrypointType: 'queue',
        messagingSystem: 'kafka',
        messagingDestinationRef: 'orders.Δ',
        messagingDestination: 'orders.Δ',
        handlerId: id.sharedA1,
      },
    }),
    // Event entrypoint whose SYMBOLIC name and RUNTIME value differ, so a
    // pathPattern filter must reach both stored tokens (`eventName`/`eventValue`),
    // not just the derived destination.
    graphNode(id.eventEntrypointA, NodeType.Entrypoint, 'user.created', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/events.ts',
      startLine: 1,
      endLine: 2,
      properties: {
        entrypointType: 'event',
        emitter: 'nestjs',
        messagingSystem: 'nestjs',
        eventName: 'Events.USER_CREATED',
        eventValue: 'user.created',
        messagingDestinationRef: 'Events.USER_CREATED',
        messagingDestination: 'user.created',
        handlerId: id.sharedA1,
      },
    }),
    // A mobile entrypoint's only address is its component class name, so
    // `pathPattern: 'MainActivity'` must reach the stored `className` property.
    graphNode(id.mobileEntrypointA, NodeType.Entrypoint, 'MainActivity', {
      repoId: CONTRACT_REPO_A,
      filePath: 'app/src/main/java/com/example/MainActivity.kt',
      startLine: 1,
      endLine: 2,
      properties: {
        entrypointType: 'mobile',
        platform: 'android',
        trigger: 'launcher',
        className: 'MainActivity',
        exported: true,
        handlerId: id.sharedA1,
      },
    }),
    graphNode(id.entrypointB1, NodeType.Entrypoint, 'GET /v1/items', {
      repoId: CONTRACT_REPO_B,
      filePath: 'src/beta.ts',
      startLine: 10,
      endLine: 11,
      properties: {
        entrypointType: 'http',
        method: 'GET',
        path: '/v1/items',
        fullPath: '/v1/items',
        handlerId: id.handlerB1,
      },
    }),
    graphNode(id.entrypointB2, NodeType.Entrypoint, 'POST /v1/orders', {
      repoId: CONTRACT_REPO_B,
      filePath: 'src/beta.ts',
      startLine: 20,
      endLine: 21,
      properties: {
        entrypointType: 'http',
        method: 'POST',
        path: '/v1/orders',
        fullPath: '/v1/orders',
        handlerId: id.handlerB2,
      },
    }),
    functionNode(id.handlerB1, 'handleItems', CONTRACT_REPO_B, 'src/beta.ts', id.fileBeta, 30),
    functionNode(id.handlerB2, 'handleOrders', CONTRACT_REPO_B, 'src/beta.ts', id.fileBeta, 40),
    functionNode(id.cycleA, 'cycleA', CONTRACT_REPO_A, 'src/cycle.ts', id.fileSymbols, 1),
    functionNode(id.cycleB, 'cycleB', CONTRACT_REPO_A, 'src/cycle.ts', id.fileSymbols, 2),
    functionNode(id.cycleC, 'cycleC', CONTRACT_REPO_A, 'src/cycle.ts', id.fileSymbols, 3),
    functionNode(id.pathStart, 'pathStart', CONTRACT_REPO_A, 'src/path.ts', id.fileSymbols, 1),
    functionNode(id.pathLeft, 'pathLeft', CONTRACT_REPO_A, 'src/path.ts', id.fileSymbols, 3),
    functionNode(id.pathRight, 'pathRight', CONTRACT_REPO_A, 'src/path.ts', id.fileSymbols, 2),
    functionNode(id.pathTarget, 'pathTarget', CONTRACT_REPO_A, 'src/path.ts', id.fileSymbols, 4),
    functionNode(id.orphan1, 'orphanOne', CONTRACT_REPO_A, 'src/orphan.ts', id.fileSymbols, 1, { isExported: false }),
    functionNode(id.orphan2, 'orphanTwo', CONTRACT_REPO_A, 'src/orphan.ts', id.fileSymbols, 2, { isExported: false }),
    graphNode(id.externalCall1, NodeType.ExternalCall, 'GET contract-beta items', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/cycle.ts',
      startLine: 10,
      endLine: 10,
      properties: {
        callerId: id.cycleA,
        serviceName: 'contract-beta-client',
        targetService: 'contract-beta',
        method: 'fetchItems',
        protocol: 'http',
        httpMethod: 'GET',
        pathTemplate: '/v1/items',
        resolvedTargetId: id.entrypointB1,
      },
    }),
    graphNode(id.externalCall2, NodeType.ExternalCall, 'publish orders.Δ', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/cycle.ts',
      startLine: 11,
      endLine: 11,
      properties: {
        callerId: id.cycleA,
        serviceName: 'contract-beta-client',
        targetService: 'contract-beta',
        method: 'publish',
        protocol: 'messaging',
        messagingSystem: 'kafka',
        messagingDestination: 'orders.Δ',
        resolvedTargetId: id.entrypointB2,
      },
    }),
    graphNode(id.externalCallWithoutEdge, NodeType.ExternalCall, 'GET contract-beta orphan', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/cycle.ts',
      startLine: 12,
      endLine: 12,
      properties: {
        callerId: id.cycleA,
        serviceName: 'contract-beta-client',
        targetService: 'contract-beta',
        method: 'fetchOrphan',
        protocol: 'http',
        httpMethod: 'GET',
        pathTemplate: '/v1/orphan',
      },
    }),
    // Swift/Kotlin shape: the profile cannot name the callee service, so the only
    // target name available is the repo the call RESOLVES_TO. Its unresolved twin
    // has no name at all and must stay unnamed.
    graphNode(id.externalCallResolvedUnnamed, NodeType.ExternalCall, 'GET items (unnamed)', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/cycle.ts',
      startLine: 13,
      endLine: 13,
      properties: {
        callerId: id.cycleB,
        serviceName: '',
        method: 'fetchItemsUnnamed',
        protocol: 'http',
        httpMethod: 'GET',
        pathTemplate: '/v1/items',
        resolvedTargetId: id.entrypointB1,
      },
    }),
    graphNode(id.externalCallUnresolvedUnnamed, NodeType.ExternalCall, 'GET unknown (unnamed)', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/cycle.ts',
      startLine: 14,
      endLine: 14,
      properties: {
        callerId: id.cycleB,
        serviceName: '',
        method: 'fetchUnknown',
        protocol: 'http',
        httpMethod: 'GET',
        pathTemplate: '/v1/unknown',
      },
    }),
    functionNode(id.monikerFunction, 'fetch', CONTRACT_REPO_A, 'src/sdk.ts', id.fileSymbols, 1, {
      monikerPackage: '@contract/sdk',
      monikerDescriptor: 'ContractClient.fetch().',
    }),
    // A function the substrate SYNTHESIZED from a declaration convention (a Rails
    // association reader) — the provenance must survive the graph round-trip, while a
    // declared function leaves the key absent.
    functionNode(id.synthesizedFunction, 'employees', CONTRACT_REPO_A, 'src/models/company.rb', id.fileSymbols, 1, {
      kind: 'method',
      synthesized: 'ruby-association',
    }),
    functionNode(
      id.embeddedFunction,
      'embedded',
      CONTRACT_REPO_A,
      'src/search.ts',
      id.fileSymbols,
      1,
      { embeddingProvider: 'contract-provider', embeddingModel: 'contract-model' },
      { embedding: [0.25, -1.5, 2] },
    ),
    graphNode(id.componentA, NodeType.Component, 'ContractPanel', {
      repoId: CONTRACT_REPO_A,
      properties: { kind: 'component' },
    }),
    graphNode(id.stateStoreA, NodeType.StateStore, 'ContractState', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/state.ts',
      startLine: 1,
      endLine: 2,
      properties: { kind: 'store' },
    }),
    functionNode(id.dependencySource, 'dependencySource', CONTRACT_REPO_A, 'src/symbols.ts', id.fileSymbols, 80),
    functionNode(id.dependencyTarget, 'dependencyTarget', CONTRACT_REPO_A, 'src/data.ts', id.fileData, 80),
    functionNode(id.capTarget, 'capTarget', CONTRACT_REPO_A, 'src/cap/target.ts', id.fileSymbols, 1),
    functionNode(id.directCapTarget, 'directCapTarget', CONTRACT_REPO_A, 'src/cap/direct-target.ts', id.fileSymbols, 1),
    functionNode(id.callTreeCapRoot, '000-callTreeRoot', CONTRACT_REPO_A, 'src/call-tree-cap.ts', id.fileSymbols, 1),
    graphNode(id.scopeTraversalRoot, NodeType.TypeAlias, 'scopeRoot', {
      repoId: CONTRACT_REPO_A,
      properties: { isExported: true },
    }),
    graphNode(id.scopeTraversalForeign, NodeType.TypeAlias, 'scopeForeign', {
      repoId: CONTRACT_OUT_OF_SCOPE_REPO,
      properties: { isExported: true },
    }),
    graphNode(id.scopeTraversalTarget, NodeType.TypeAlias, 'scopeTarget', {
      repoId: CONTRACT_REPO_A,
      properties: { isExported: true },
    }),
    functionNode(id.callTreeScopeRoot, 'zzScopeRoot', CONTRACT_REPO_A, 'src/scope.ts', id.fileSymbols, 1, {
      isExported: true,
    }),
    functionNode(
      id.callTreeScopeForeign,
      'zzScopeForeign',
      CONTRACT_OUT_OF_SCOPE_REPO,
      'src/scope.ts',
      id.fileSymbols,
      2,
      { isExported: true },
    ),
    functionNode(id.callTreeScopeTarget, 'zzScopeTarget', CONTRACT_REPO_A, 'src/scope.ts', id.fileSymbols, 3, {
      isExported: true,
    }),
    graphNode(id.variable, NodeType.Variable, 'contractValue', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/symbols.ts',
      startLine: 50,
      endLine: 50,
      properties: { fileId: id.fileSymbols, isExported: true, kind: 'const' },
    }),
    graphNode(id.route, NodeType.Route, '/contract', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/routes.ts',
      startLine: 1,
      endLine: 2,
      properties: { path: '/contract', componentId: id.componentA },
    }),
    graphNode(id.routeOrderA, NodeType.Route, 'z-route-name', {
      repoId: CONTRACT_REPO_A,
      properties: { path: '/a-route-order', componentId: id.componentA },
    }),
    graphNode(id.routeOrderZ, NodeType.Route, 'a-route-name', {
      repoId: CONTRACT_REPO_A,
      properties: { path: '/z-route-order', componentId: id.componentA },
    }),
    graphNode(id.deepAllowedEntrypoint, NodeType.Entrypoint, 'GET /deep/allowed', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/deep.ts',
      startLine: 30,
      endLine: 31,
      properties: {
        entrypointType: 'http',
        method: 'GET',
        path: '/deep/allowed',
        fullPath: '/deep/allowed',
        handlerId: id.deepCallNodeIds[2],
      },
    }),
    graphNode(id.deepTooFarEntrypoint, NodeType.Entrypoint, 'GET /deep/too-far', {
      repoId: CONTRACT_REPO_A,
      filePath: 'src/deep.ts',
      startLine: 32,
      endLine: 33,
      properties: {
        entrypointType: 'http',
        method: 'GET',
        path: '/deep/too-far',
        fullPath: '/deep/too-far',
        handlerId: id.deepCallNodeIds[0],
      },
    }),
  ];

  for (const [index, nodeId] of id.deepCallNodeIds.entries()) {
    nodes.push(
      functionNode(
        nodeId,
        `deep${index.toString().padStart(2, '0')}`,
        CONTRACT_REPO_A,
        'src/deep.ts',
        id.fileSymbols,
        index + 1,
      ),
    );
  }

  for (const [index, nodeId] of id.limitProbeIds.entries()) {
    nodes.push(
      graphNode(nodeId, NodeType.Variable, `limitProbe${index.toString().padStart(4, '0')}`, {
        repoId: CONTRACT_REPO_A,
        filePath: 'src/limit-probes.ts',
        startLine: index + 1,
        endLine: index + 1,
        properties: { fileId: id.fileSymbols, isExported: false, kind: 'const' },
      }),
    );
  }

  for (const [index, nodeId] of id.entrypointLimitIds.entries()) {
    nodes.push(
      graphNode(nodeId, NodeType.Entrypoint, `limitEntrypoint${index.toString().padStart(4, '0')}`, {
        repoId: CONTRACT_REPO_B,
        filePath: 'src/limit-entrypoints.ts',
        startLine: index + 1,
        endLine: index + 1,
        properties: {
          entrypointType: 'event',
          eventName: `limit-event-${index.toString().padStart(4, '0')}`,
          fullPath: `/limit/${index.toString().padStart(4, '0')}`,
          handlerId: id.handlerB1,
        },
      }),
    );
  }

  for (const [index, sourceId] of id.bridgeLimitSourceIds.entries()) {
    nodes.push(
      graphNode(sourceId, NodeType.ExternalCall, `bridgeSource${index.toString().padStart(3, '0')}`, {
        repoId: CONTRACT_BRIDGE_REPO_C,
        properties: {
          callerId: id.cycleA,
          serviceName: 'bridge-limit-target',
          targetService: 'bridge-limit-target',
          method: 'fetch',
          protocol: 'http',
        },
      }),
      graphNode(
        id.bridgeLimitTargetIds[index] as string,
        NodeType.Entrypoint,
        `bridgeTarget${index.toString().padStart(3, '0')}`,
        {
          repoId: CONTRACT_BRIDGE_REPO_D,
          properties: {
            entrypointType: 'http',
            method: 'GET',
            fullPath: `/bridge-limit/${index.toString().padStart(3, '0')}`,
            handlerId: id.handlerB1,
          },
        },
      ),
    );
  }

  for (const callerId of id.capCallerIds) {
    nodes.push(functionNode(callerId, 'capCaller', CONTRACT_REPO_A, 'src/cap/caller.ts', id.fileSymbols, 1));
  }
  for (const [index, nodeId] of id.callTreeCapNodeIds.entries()) {
    nodes.push(
      functionNode(
        nodeId,
        `callTreeChild${index.toString().padStart(3, '0')}`,
        CONTRACT_REPO_A,
        'src/call-tree-cap.ts',
        id.fileSymbols,
        index + 2,
      ),
    );
  }
  return nodes;
}

function fixtureEdges(): GraphEdge[] {
  const id = CONTRACT_IDS;
  const edges: GraphEdge[] = [
    edge('contract:contains-package:a1', id.repositoryA, id.packageA1, EdgeType.ContainsPackage),
    edge('contract:contains-package:a2', id.repositoryA, id.packageA2, EdgeType.ContainsPackage),
    edge('contract:contains-package:b', id.repositoryB, id.packageB, EdgeType.ContainsPackage),
    edge('contract:contains-file:symbols', id.packageA1, id.fileSymbols, EdgeType.ContainsFile),
    edge('contract:contains-file:secondary', id.packageA1, id.fileSecondary, EdgeType.ContainsFile),
    edge('contract:contains-file:data', id.packageA2, id.fileData, EdgeType.ContainsFile),
    edge('contract:contains-file:beta', id.packageB, id.fileBeta, EdgeType.ContainsFile),
    edge('contract:contains-function:shared', id.fileSymbols, id.sharedA1, EdgeType.ContainsFunction),
    edge(id.dependencySourceContainment, id.fileSymbols, id.dependencySource, EdgeType.ContainsFunction),
    edge(id.dependencyTargetContainment, id.fileData, id.dependencyTarget, EdgeType.ContainsFunction),
    edge('contract:contains-class:base', id.fileSymbols, id.baseClass, EdgeType.ContainsClass),
    edge('contract:contains-interface', id.fileSymbols, id.interfaceNode, EdgeType.ContainsInterface),
    edge('contract:contains-enum', id.fileSymbols, id.enumNode, EdgeType.ContainsEnum),
    edge('contract:contains-alias', id.fileSymbols, id.typeAlias, EdgeType.ContainsTypeAlias),
    edge('contract:contains-variable', id.fileSymbols, id.variable, EdgeType.ContainsVariable),
    edge('contract:contains-entity', id.fileData, id.entity, EdgeType.ContainsEntity),
    edge('contract:contains-component', id.fileSymbols, id.componentA, EdgeType.ContainsComponent),
    edge('contract:contains-route', id.fileSymbols, id.route, EdgeType.ContainsRoute),
    edge('contract:has-method', id.implementingClass, id.classMethod, EdgeType.HasMethod),
    edge('contract:imports', id.fileSymbols, id.fileData, EdgeType.Imports),
    edge(id.cycleEdgeAB, id.cycleA, id.cycleB, EdgeType.Calls, { line: 101, callSiteLine: 101 }),
    edge(id.cycleEdgeBC, id.cycleB, id.cycleC, EdgeType.Calls, { line: 102, callSiteLine: 102 }),
    edge(id.cycleEdgeCA, id.cycleC, id.cycleA, EdgeType.Calls, { line: 103, callSiteLine: 103 }),
    edge(id.componentCallerEdge, id.componentA, id.cycleB, EdgeType.Calls, {
      line: 100,
      callSiteLine: 100,
    }),
    edge(id.neighborEdge1, id.pathStart, id.pathLeft, EdgeType.Calls, { line: 201, callSiteLine: 201 }),
    edge(id.neighborEdge2, id.pathStart, id.pathRight, EdgeType.Calls, { line: 202, callSiteLine: 202 }),
    edge('contract:path:left-target', id.pathLeft, id.pathTarget, EdgeType.Calls),
    edge('contract:path:right-target', id.pathRight, id.pathTarget, EdgeType.Calls),
    // A SYNTHESIZED function calling a declared one: pathTarget therefore has both a
    // synthesized caller and declared callers, so a caller row must carry the caller
    // node's synthesis provenance while a declared caller leaves the key absent.
    edge('contract:calls:synthesized-path-target', id.synthesizedFunction, id.pathTarget, EdgeType.Calls, {
      line: 7,
      callSiteLine: 7,
    }),
    edge(id.dependencyEdge, id.dependencySource, id.dependencyTarget, EdgeType.Calls, {}, 0.75, 'ai'),
    // Intra-repo CALLS edge INTO the monikered SDK method — the evidence the
    // cross-repo call-edge hop reads back through getInternalCallEdges.
    edge('contract:calls:embedded-moniker', id.embeddedFunction, id.monikerFunction, EdgeType.Calls, {
      line: 42,
      callSiteLine: 42,
    }),
    edge('contract:extends', id.childClass, id.baseClass, EdgeType.Extends),
    edge('contract:implements', id.implementingClass, id.interfaceNode, EdgeType.ImplementsInterface),
    edge('contract:uses-type', id.typeUser, id.interfaceNode, EdgeType.UsesType, {
      usage: 'parameter',
      via: 'job',
      ambiguous: false,
    }),
    edge(id.handlesAEdge, id.entrypointA, id.handlerA, EdgeType.Handles),
    edge(id.handlesQueueAEdge, id.queueEntrypointA, id.sharedA1, EdgeType.Handles),
    edge(id.handlesB1Edge, id.entrypointB1, id.handlerB1, EdgeType.Handles),
    edge(id.handlesB2Edge, id.entrypointB2, id.handlerB2, EdgeType.Handles),
    edge('contract:operates-on', id.entityConsumer, id.entity, EdgeType.OperatesOn, { operation: 'read' }),
    edge('contract:renders-component', id.route, id.componentA, EdgeType.RendersComponent),
    edge('contract:uses-component', id.route, id.stateStoreA, EdgeType.UsesComponent),
    edge(id.makesExternalEdge1, id.cycleA, id.externalCall1, EdgeType.MakesExternalCall),
    edge(id.makesExternalEdge2, id.cycleA, id.externalCall2, EdgeType.MakesExternalCall),
    edge(id.makesExternalEdge4, id.cycleB, id.externalCallResolvedUnnamed, EdgeType.MakesExternalCall),
    edge(id.makesExternalEdge5, id.cycleB, id.externalCallUnresolvedUnnamed, EdgeType.MakesExternalCall),
    edge('contract:references-variable', id.unicodeFunction, id.variable, EdgeType.ReferencesVariable),
    edge(
      id.bridgeEdge1,
      id.externalCall1,
      id.entrypointB1,
      EdgeType.ResolvesTo,
      {
        via: 'protocol',
        chain: [
          { kind: 'protocol', detail: 'http:GET:/v1/items' },
          { kind: 'entrypoint', detail: 'GET /v1/items' },
        ],
      },
      0.9,
      'ai',
    ),
    edge(id.bridgeEdge2, id.externalCall2, id.entrypointB2, EdgeType.ResolvesTo, { via: 'messaging' }, 0.85, 'ai'),
    edge(
      id.bridgeEdge4,
      id.externalCallResolvedUnnamed,
      id.entrypointB1,
      EdgeType.ResolvesTo,
      { via: 'protocol' },
      0.9,
      'ai',
    ),
    edge(id.deepAllowedHandlesEdge, id.deepAllowedEntrypoint, id.deepCallNodeIds[2] as string, EdgeType.Handles),
    edge(id.deepTooFarHandlesEdge, id.deepTooFarEntrypoint, id.deepCallNodeIds[0] as string, EdgeType.Handles),
    edge(id.scopeTraversalRootEdge, id.scopeTraversalRoot, id.scopeTraversalForeign, EdgeType.Calls),
    edge(id.scopeTraversalTargetEdge, id.scopeTraversalForeign, id.scopeTraversalTarget, EdgeType.Calls),
    edge(id.callTreeScopeRootEdge, id.callTreeScopeRoot, id.callTreeScopeForeign, EdgeType.Calls),
    edge(id.callTreeScopeTargetEdge, id.callTreeScopeForeign, id.callTreeScopeTarget, EdgeType.Calls),
  ];

  for (let index = 0; index < id.deepCallEdgeIds.length; index += 1) {
    edges.push(
      edge(
        id.deepCallEdgeIds[index] as string,
        id.deepCallNodeIds[index] as string,
        id.deepCallNodeIds[index + 1] as string,
        EdgeType.Calls,
        { line: 2000 + index, callSiteLine: 2000 + index },
      ),
    );
  }

  for (let index = 0; index < id.paginationEdgeIds.length; index += 1) {
    edges.push(
      edge(
        id.paginationEdgeIds[index] as string,
        id.pathStart,
        id.limitProbeIds[index] as string,
        EdgeType.ReferencesVariable,
      ),
    );
  }

  for (let index = 0; index < id.bridgeLimitEdgeIds.length; index += 1) {
    edges.push(
      edge(
        id.bridgeLimitEdgeIds[index] as string,
        id.bridgeLimitSourceIds[index] as string,
        id.bridgeLimitTargetIds[index] as string,
        EdgeType.ResolvesTo,
      ),
    );
  }

  for (const [index, callerId] of id.capCallerIds.entries()) {
    edges.push(
      edge(id.capCallEdgeIds[index] as string, callerId, id.capTarget, EdgeType.Calls, {
        line: 1000 + index,
        callSiteLine: 1000 + index,
      }),
      edge(id.capContainmentEdgeIds[index] as string, id.fileSymbols, callerId, EdgeType.ContainsFunction),
    );
  }
  for (let index = 0; index < id.directCapCallEdgeIds.length; index += 1) {
    edges.push(
      edge(
        id.directCapCallEdgeIds[index] as string,
        id.capCallerIds[index] as string,
        id.directCapTarget,
        EdgeType.Calls,
      ),
    );
  }
  for (const [edgeId, callerIndex] of [
    [id.directCapReferenceEdgeIds[0], 0],
    [id.directCapReferenceEdgeIds[1], 99],
    [id.directCapReferenceEdgeIds[2], 100],
  ] as const) {
    edges.push(
      edge(edgeId as string, id.capCallerIds[callerIndex] as string, id.directCapTarget, EdgeType.ReferencesVariable),
    );
  }
  for (let index = 0; index < id.reachingCapEdgeIds.length; index += 1) {
    edges.push(
      edge(
        id.reachingCapEdgeIds[index] as string,
        id.entrypointLimitIds[index] as string,
        id.handlerB1,
        EdgeType.Handles,
      ),
    );
  }
  for (let index = 0; index < id.callTreeCapEdgeIds.length; index += 1) {
    edges.push(
      edge(
        id.callTreeCapEdgeIds[index] as string,
        id.callTreeCapRoot,
        id.callTreeCapNodeIds[index] as string,
        EdgeType.Calls,
      ),
    );
  }
  edges.push(edge(id.callTreeCapCycleEdge, id.callTreeCapRoot, id.callTreeCapRoot, EdgeType.Calls));
  return edges;
}

function assertFixtureIntegrity(nodes: GraphNode[], edges: GraphEdge[]): void {
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Duplicate contract node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  const identities = new Set<string>();
  for (const relationship of edges) {
    if (!nodeIds.has(relationship.sourceId) || !nodeIds.has(relationship.targetId)) {
      throw new Error(`Contract edge ${relationship.id} has a missing endpoint`);
    }
    if (edgeIds.has(relationship.id)) throw new Error(`Duplicate contract edge id: ${relationship.id}`);
    edgeIds.add(relationship.id);
    const identity = JSON.stringify([relationship.sourceId, relationship.targetId, relationship.type]);
    if (identities.has(identity)) throw new Error(`Duplicate contract edge identity: ${identity}`);
    identities.add(identity);
  }
  const recordedEdgeIds = new Set(CONTRACT_IDS.allPlantedEdgeIds);
  if (recordedEdgeIds.size !== edgeIds.size || [...edgeIds].some((id) => !recordedEdgeIds.has(id))) {
    throw new Error('CONTRACT_IDS.allPlantedEdgeIds is out of sync with the seeded relationships');
  }
}

/**
 * Statically unresolved call sites, seeded through the same changeset field the
 * push path uses. Deliberately mixed: two share a name tail, one is a dynamic
 * member access with no tail at all, and one lives in the other repo so scoping
 * is observable. Resolved calls are seeded as CALLS edges (above) and must never
 * appear in these results.
 */
export const CONTRACT_UNRESOLVED_CALLS_A: readonly UnresolvedCallRecord[] = Object.freeze([
  {
    callerId: CONTRACT_IDS.cycleA,
    calleeExpression: 'this.client.emit',
    calleeNameTail: 'emit',
    filePath: 'src/dispatch.ts',
    line: 42,
  },
  {
    callerId: CONTRACT_IDS.cycleB,
    calleeExpression: 'handlers[kind]',
    calleeNameTail: null,
    filePath: 'src/dispatch.ts',
    line: 17,
  },
  {
    callerId: CONTRACT_IDS.cycleC,
    calleeExpression: 'bus.emit',
    calleeNameTail: 'emit',
    filePath: 'src/alpha-dispatch.ts',
    line: 5,
  },
]);

export const CONTRACT_UNRESOLVED_CALLS_B: readonly UnresolvedCallRecord[] = Object.freeze([
  {
    callerId: CONTRACT_IDS.handlerB1,
    calleeExpression: 'queue.emit',
    calleeNameTail: 'emit',
    filePath: 'src/beta-dispatch.ts',
    line: 9,
  },
]);

export async function seedContractFixture(repository: IGraphRepository): Promise<void> {
  const nodes = fixtureNodes();
  const edges = fixtureEdges();
  assertFixtureIntegrity(nodes, edges);
  await repository.pushNodes(nodes);
  await repository.pushEdges(edges);
  if (!repository.applyChangeset) throw new Error('The repository contract requires applyChangeset support');
  await repository.applyChangeset(
    {
      repoId: CONTRACT_REPO_A,
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
      unresolvedCalls: CONTRACT_UNRESOLVED_CALLS_A,
    },
    {
      snapshot: {
        parsedVersion: 'contract-parsed-v1',
        summaryVersion: null,
        embeddingsVersion: 'contract-embeddings-v1',
        commitSha: null,
        totalNodeCount: nodes.length,
        totalEdgeCount: edges.length,
        mode: GraphApplyMode.Full,
        executionToken: 'contract-execution-token',
      },
    },
  );
  await repository.applyChangeset({
    repoId: CONTRACT_REPO_B,
    nodesToAdd: [],
    nodesToUpdate: [],
    nodeIdsToDelete: [],
    edgeNodeIdsToWipe: [],
    edgesToInsert: [],
    unresolvedCalls: CONTRACT_UNRESOLVED_CALLS_B,
  });
}
