/**
 * Graph Data Transformer
 *
 * Converts ParsedRepo JSON to unified GraphNode[] + GraphEdge[] format
 * for use with both Neo4j and SQLite backends.
 */

import { posix } from 'node:path';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { EdgeType, NodeType, TypeUseKind } from './types.js';
import type { GraphNode, GraphEdge, PackageLinkerImportInfo, UnresolvedCallRecord } from './types.js';

import type {
  ParsedRepo,
  Package,
  FileNode,
  FunctionNode,
  ClassNode,
  InterfaceNode,
  Entrypoint,
  EntityNode,
  ComponentNode,
  RouteNode,
  StateStoreNode,
  TypeAliasNode,
  EnumNode,
  VariableNode,
  CallEdge,
  CallProvenance,
  ImportEdge,
  DbOperation,
  ExternalCallEdge,
  ReferencesVariableEdge,
  TypeInfo,
  TypeReference,
  HttpEntrypointDetails,
  GraphQLEntrypointDetails,
  CronEntrypointDetails,
  QueueEntrypointDetails,
  EventEntrypointDetails,
  CliEntrypointDetails,
  MobileEntrypointDetails,
  SummaryOutput,
  FunctionSummary,
  SideEffect,
  EmbeddingsOutput,
  FunctionEmbedding,
  EndpointEmbedding,
} from '@coredoc/core/types';

// =============================================================================
// Type Conversion Helpers
// =============================================================================

/**
 * Generate a unique edge ID.
 */
function generateEdgeId(sourceId: string, targetId: string, type: string): string {
  return `${sourceId}:${type}:${targetId}`;
}

/** A parser-created edge; the id defaults to the `source:TYPE:target` form. */
function parserEdge(
  sourceId: string,
  targetId: string,
  type: EdgeType,
  properties: Record<string, unknown> = {},
  confidence = 1,
  id = generateEdgeId(sourceId, targetId, type),
): GraphEdge {
  return { id, sourceId, targetId, type, confidence, createdBy: 'parser', properties };
}

// =============================================================================
// Node Transformers
// =============================================================================

function transformRepository(repo: ParsedRepo): GraphNode {
  const callResolution = repo.stats?.callResolution;
  const dbOpResolution = repo.stats?.dbOpResolution;
  return {
    id: repo.id,
    type: NodeType.Repository,
    name: repo.name,
    properties: {
      type: repo.type,
      parsedAt: repo.parsedAt,
      parserVersion: repo.parserVersion,
      parserId: repo.parserId,
      ...(repo.stats?.analysis?.length
        ? {
            analysis: JSON.stringify(
              repo.stats.analysis.map(({ language, target, mode, compilerReceiverTypes, fallback }) => ({
                language,
                target,
                mode,
                compilerReceiverTypes,
                fallback,
              })),
            ),
          }
        : {}),
      gitRemoteUrl: repo.git?.remoteUrl,
      gitCommitHash: repo.git?.commitHash,
      // Spread, not three `?? undefined` keys: a parse that measured nothing must
      // leave the keys absent, because a reader cannot tell a stored zero from
      // "not measured" (spec LIM-3).
      ...(callResolution
        ? {
            callSites: callResolution.callSites,
            resolvedCalls: callResolution.resolvedCalls,
            outOfScopeCalls: callResolution.outOfScopeCalls,
          }
        : {}),
      ...(dbOpResolution
        ? {
            dbOpSites: dbOpResolution.dbOpSites,
            boundDbOps: dbOpResolution.boundDbOps,
            outOfScopeDbOps: dbOpResolution.outOfScopeDbOps,
          }
        : {}),
    },
  };
}

function transformPackage(pkg: Package, repoId: string): GraphNode {
  return {
    id: pkg.id,
    type: NodeType.Package,
    name: pkg.name,
    properties: {
      path: pkg.path,
      version: pkg.version,
      mainEntry: pkg.mainEntry,
      packageType: pkg.type,
      language: pkg.language,
      description: pkg.description,
    },
    repoId,
  };
}

function transformFile(file: FileNode, repoId: string, packageImports: PackageLinkerImportInfo[]): GraphNode {
  return {
    id: file.id,
    type: NodeType.File,
    name: file.path,
    properties: {
      versionedId: file.versionedId,
      path: file.path,
      extension: file.extension,
      packageId: file.packageId,
      language: file.language,
      target: file.target,
      contentHash: file.contentHash,
      loc: file.loc,
      ...(packageImports.length > 0 ? { packageImports } : {}),
    },
    repoId,
    filePath: file.path,
  };
}

function packageImportsBySourceFile(imports: ImportEdge[]): Map<string, PackageLinkerImportInfo[]> {
  const byFile = new Map<string, PackageLinkerImportInfo[]>();
  for (const imported of imports) {
    const specifier = imported.moduleSpecifier;
    const isRelativeOrAbsolute =
      specifier === '.' ||
      specifier === '..' ||
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier.startsWith('/');
    if (
      isRelativeOrAbsolute ||
      imported.targetFileId !== undefined ||
      !imported.importedNames ||
      imported.importedNames.length === 0
    ) {
      continue;
    }
    const facts = byFile.get(imported.sourceFileId) ?? [];
    facts.push({
      id: imported.id,
      moduleSpecifier: imported.moduleSpecifier,
      isTypeOnly: imported.isTypeOnly,
      importKind: imported.importKind,
      importedNames: imported.importedNames.map(({ name, alias }) => ({ name, ...(alias ? { alias } : {}) })),
    });
    byFile.set(imported.sourceFileId, facts);
  }
  for (const facts of byFile.values()) {
    facts.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
  return byFile;
}

function transformFunction(fn: FunctionNode, repoId: string): GraphNode {
  return {
    id: fn.id,
    type: NodeType.Function,
    name: fn.name,
    properties: {
      versionedId: fn.versionedId,
      kind: fn.kind,
      fileId: fn.fileId,
      isAsync: fn.isAsync,
      isGenerator: fn.isGenerator,
      isExported: fn.isExported,
      classId: fn.classId,
      visibility: fn.visibility,
      isStatic: fn.isStatic,
      isAbstract: fn.isAbstract,
      complexity: fn.complexity,
      documentation: fn.documentation,
      // Raw source body — stored ONLY when the operator opted in via
      // ALLOW_SOURCES_IN_GRAPH. Default OFF: source must not enter the graph
      // (the cloud/SaaS push path strips it and the server rejects it). It rides
      // the properties JSON blob like documentation/purpose — no schema change.
      ...(allowSourcesInGraph() && fn.sourceCode ? { sourceCode: fn.sourceCode } : {}),
      monikerPackage: fn.moniker?.packageName,
      monikerDescriptor: fn.moniker?.descriptor,
      // Spread, not `synthesized: fn.synthesized`: a declared function must leave the key
      // ABSENT, so no reader can mistake a stored undefined for a synthesis convention.
      ...(fn.synthesized ? { synthesized: fn.synthesized } : {}),
    },
    repoId,
    filePath: fn.location.filePath,
    startLine: fn.location.startLine,
    endLine: fn.location.endLine,
  };
}

function transformClass(cls: ClassNode, repoId: string): GraphNode {
  return {
    id: cls.id,
    type: NodeType.Class,
    name: cls.name,
    properties: {
      versionedId: cls.versionedId,
      fileId: cls.fileId,
      isExported: cls.isExported,
      isAbstract: cls.isAbstract,
      extendsName: cls.extends?.name,
      extendsId: cls.extends?.resolvedId,
      implements: cls.implements?.map((i) => ({ name: i.name, resolvedId: i.resolvedId })),
      typeParameters: cls.typeParameters,
      decorators: cls.decorators,
      // IDs only — the methods themselves are separate function nodes connected
      // by HAS_METHOD edges. We keep the array here for cheap "what methods
      // does this class have" answers without a graph traversal.
      methodIds: cls.methods,
      properties_: cls.properties.map((p) => ({
        name: p.name,
        visibility: p.visibility,
        isStatic: p.isStatic,
        isReadonly: p.isReadonly,
        isOptional: p.isOptional,
        typeText: p.type?.text,
        defaultValue: p.defaultValue,
        startLine: p.location.startLine,
      })),
      constructorParams: cls.constructor?.parameters?.map((p) => ({
        name: p.name,
        typeText: p.type?.text,
        isOptional: p.isOptional,
      })),
      documentation: cls.documentation,
    },
    repoId,
    filePath: cls.location.filePath,
    startLine: cls.location.startLine,
    endLine: cls.location.endLine,
  };
}

function transformInterface(iface: InterfaceNode, repoId: string): GraphNode {
  return {
    id: iface.id,
    type: NodeType.Interface,
    name: iface.name,
    properties: {
      versionedId: iface.versionedId,
      fileId: iface.fileId,
      isExported: iface.isExported,
      extends: iface.extends?.map((e) => ({ name: e.name, resolvedId: e.resolvedId })),
      typeParameters: iface.typeParameters,
      members: iface.members.map((m) => ({
        name: m.name,
        kind: m.kind,
        isOptional: m.isOptional,
        isReadonly: m.isReadonly,
        typeText: m.type?.text,
        returnTypeText: m.returnType?.text,
        startLine: m.location.startLine,
      })),
      documentation: iface.documentation,
    },
    repoId,
    filePath: iface.location.filePath,
    startLine: iface.location.startLine,
    endLine: iface.location.endLine,
  };
}

/**
 * Human-readable `name` for a messaging entrypoint.
 *
 * Entrypoint nodes otherwise store their own node id in `name`, so a queue
 * consumer surfaced as `9ff436afb359:entrypoint:queue:e0a1727d` in every
 * renderer that treats `name` as text — even though the topic and the broker
 * were both already on the node. The destination is that name; the broker
 * qualifies it (`kafka:Topics.DailySummaryRecalculateV2`) so two systems
 * carrying the same destination string stay distinguishable.
 *
 * Returns undefined when the profile resolved neither — the caller keeps the id
 * rather than inventing a label. Readers must still tolerate the id form: it is
 * what every graph pushed before this lands contains (the MCP layer keeps its
 * address-based fallback for exactly that reason).
 */
function messagingEntrypointName(destination: unknown, system: unknown): string | undefined {
  const address = typeof destination === 'string' ? destination.trim() : '';
  if (!address) return undefined;
  const broker = typeof system === 'string' ? system.trim() : '';
  return broker ? `${broker}:${address}` : address;
}

function transformEntrypoint(ep: Entrypoint, repoId: string): GraphNode {
  const properties: Record<string, unknown> = {
    versionedId: ep.versionedId,
    entrypointType: ep.type,
    handlerId: ep.handlerId,
    documentation: ep.documentation,
  };

  switch (ep.details.type) {
    case 'http': {
      const httpDetails = ep.details as HttpEntrypointDetails;
      properties.method = httpDetails.method;
      properties.path = httpDetails.path;
      properties.fullPath = httpDetails.fullPath;
      break;
    }
    case 'graphql': {
      const gqlDetails = ep.details as GraphQLEntrypointDetails;
      properties.fieldName = gqlDetails.fieldName;
      properties.operationType = gqlDetails.operationType;
      break;
    }
    case 'cron': {
      const cronDetails = ep.details as CronEntrypointDetails;
      properties.schedule = cronDetails.schedule;
      break;
    }
    case 'queue': {
      const queueDetails = ep.details as QueueEntrypointDetails;
      properties.topic = queueDetails.topic;
      properties.topicValue = queueDetails.topicValue;
      properties.messagingSystem = queueDetails.system;
      properties.messagingDestination = queueDetails.topicValue ?? queueDetails.topic;
      properties.messagingDestinationRef = queueDetails.topic;
      break;
    }
    case 'event': {
      const eventDetails = ep.details as EventEntrypointDetails;
      properties.eventName = eventDetails.eventName;
      properties.eventValue = eventDetails.eventValue;
      if (eventDetails.emitter) properties.emitter = eventDetails.emitter;
      properties.messagingSystem = eventDetails.emitter;
      properties.messagingDestination = eventDetails.eventValue ?? eventDetails.eventName;
      properties.messagingDestinationRef = eventDetails.eventName;
      break;
    }
    case 'cli': {
      const cliDetails = ep.details as CliEntrypointDetails;
      properties.command = cliDetails.command;
      if (cliDetails.subcommands) properties.subcommands = cliDetails.subcommands;
      break;
    }
    case 'mobile': {
      const mobileDetails = ep.details as MobileEntrypointDetails;
      properties.platform = mobileDetails.platform;
      properties.trigger = mobileDetails.trigger;
      // The class name is this entrypoint's ADDRESS: it is what an agent types
      // into `pathPattern`, so it must survive into stored properties.
      properties.className = mobileDetails.className;
      if (mobileDetails.actions) properties.actions = mobileDetails.actions;
      if (mobileDetails.uriPatterns) properties.uriPatterns = mobileDetails.uriPatterns;
      if (mobileDetails.exported !== undefined) properties.exported = mobileDetails.exported;
      break;
    }
  }

  // Only the messaging kinds get a derived name for now: their address is the
  // token an agent actually types, and they are the ones that rendered as a raw
  // node id. HTTP/GraphQL/cron/cli keep the id until their renderers are ready
  // for a name change.
  const messagingName =
    ep.details.type === 'queue' || ep.details.type === 'event'
      ? messagingEntrypointName(properties.messagingDestination, properties.messagingSystem)
      : undefined;

  return {
    id: ep.id,
    type: NodeType.Entrypoint,
    name: messagingName ?? ep.id,
    properties,
    repoId,
    filePath: ep.location.filePath,
    startLine: ep.location.startLine,
    endLine: ep.location.endLine,
  };
}

function transformEntity(entity: EntityNode, repoId: string): GraphNode {
  return {
    id: entity.id,
    type: NodeType.Entity,
    name: entity.name,
    properties: {
      versionedId: entity.versionedId,
      fileId: entity.fileId,
      ormType: entity.ormType,
      tableName: entity.tableName,
      schema: entity.schema,
      documentation: entity.documentation,
      // Full DB structure — columns, relations, and indexes. Stored inside the
      // properties JSON blob (no schema migration); Neo4j serializes these
      // arrays-of-objects to JSON strings via flattenForNeo4j, read back with
      // JSON.parse in the neo4j repository. Consumed as a per-entity unit by the
      // describe_db_schema MCP tool.
      fields: entity.fields,
      relations: entity.relations,
      indexes: entity.indexes,
    },
    repoId,
    filePath: entity.location.filePath,
    startLine: entity.location.startLine,
    endLine: entity.location.endLine,
  };
}

function transformComponent(component: ComponentNode, repoId: string): GraphNode {
  return {
    id: component.id,
    type: NodeType.Component,
    name: component.name,
    properties: {
      versionedId: component.versionedId,
      fileId: component.fileId,
      framework: component.framework,
      componentType: component.componentType,
      documentation: component.documentation,
      templateFile: component.templateFile,
    },
    repoId,
    filePath: component.location.filePath,
    startLine: component.location.startLine,
    endLine: component.location.endLine,
  };
}

function transformRoute(route: RouteNode, repoId: string): GraphNode {
  return {
    id: route.id,
    type: NodeType.Route,
    name: route.path,
    properties: {
      path: route.path,
      componentId: route.componentId,
      componentName: route.componentName,
      parentRouteId: route.parentRouteId,
      childRouteIds: route.childRouteIds,
      guards: route.guards,
      meta: route.meta,
      isLazy: route.isLazy,
    },
    repoId,
    filePath: route.location?.filePath,
    startLine: route.location?.startLine,
    endLine: route.location?.endLine,
  };
}

function transformStateStore(store: StateStoreNode, repoId: string): GraphNode {
  return {
    id: store.id,
    type: NodeType.StateStore,
    name: store.storeName,
    properties: {
      versionedId: store.versionedId,
      fileId: store.fileId,
      library: store.library,
      storeName: store.storeName,
      actions: store.actions,
      selectors: store.selectors,
      effects: store.effects,
      documentation: store.documentation,
    },
    repoId,
    filePath: store.location.filePath,
    startLine: store.location.startLine,
    endLine: store.location.endLine,
  };
}

function transformTypeAlias(typeAlias: TypeAliasNode, repoId: string): GraphNode {
  return {
    id: typeAlias.id,
    type: NodeType.TypeAlias,
    name: typeAlias.name,
    properties: {
      versionedId: typeAlias.versionedId,
      fileId: typeAlias.fileId,
      isExported: typeAlias.isExported,
      typeParameters: typeAlias.typeParameters,
      aliasedTypeText: typeAlias.aliasedType.text,
      aliasedTypeStructure: typeAlias.aliasedType.structure,
      documentation: typeAlias.documentation,
    },
    repoId,
    filePath: typeAlias.location.filePath,
    startLine: typeAlias.location.startLine,
    endLine: typeAlias.location.endLine,
  };
}

function transformEnum(enumNode: EnumNode, repoId: string): GraphNode {
  return {
    id: enumNode.id,
    type: NodeType.Enum,
    name: enumNode.name,
    properties: {
      versionedId: enumNode.versionedId,
      fileId: enumNode.fileId,
      isExported: enumNode.isExported,
      isConst: enumNode.isConst,
      documentation: enumNode.documentation,
      // Enum members (name + value) — needed to answer "what are the valid
      // values?" (e.g. the shifts:published vs SHIFTS_PUBLISHED class of bug).
      // Structural nodes content-hash their source slice into versionedId, so a
      // value change already flips the checksum (no seed fix needed here).
      members: enumNode.members,
    },
    repoId,
    filePath: enumNode.location.filePath,
    startLine: enumNode.location.startLine,
    endLine: enumNode.location.endLine,
  };
}

function transformVariable(variable: VariableNode, repoId: string): GraphNode {
  return {
    id: variable.id,
    type: NodeType.Variable,
    name: variable.name,
    properties: {
      versionedId: variable.versionedId,
      fileId: variable.fileId,
      isExported: variable.isExported,
      declarationKind: variable.declarationKind,
      documentation: variable.documentation,
    },
    repoId,
    filePath: variable.location.filePath,
    startLine: variable.location.startLine,
    endLine: variable.location.endLine,
  };
}

function transformExternalCall(call: ExternalCallEdge, repoId: string): GraphNode {
  const descriptor = call.targetDescriptor;
  const messagingDestination =
    descriptor?.messaging?.destinationValue ?? descriptor?.messaging?.destination ?? descriptor?.ipc?.channel;
  const messagingDestinationRef = descriptor?.messaging?.destination ?? descriptor?.ipc?.channel;
  const messagingSystem =
    descriptor?.messaging?.system ?? (descriptor?.protocol === 'ipc' ? 'electron-ipc' : undefined);
  return {
    id: call.id,
    type: NodeType.ExternalCall,
    name: `${call.serviceName}.${call.method}`,
    properties: {
      versionedId: call.versionedId,
      callerId: call.callerId,
      serviceName: call.serviceName,
      // Parser-emitted canonical target. Distinct from `serviceName` (which may
      // be the client class, e.g. "sampleApiClient") — `targetService` is the
      // hint about the actual service the call resolves to ("walle"). Mapper
      // engine treats `targetService` as source of truth when present;
      // `fromTurso` falls back to `serviceName` if undefined.
      targetService: call.targetDescriptor?.targetService,
      sdkName: call.sdkName,
      method: call.method,
      targetPattern: call.targetPattern,
      protocol: descriptor?.protocol ?? (call.details?.httpMethod ? 'http' : 'internal'),
      httpMethod: call.details?.httpMethod || call.targetDescriptor?.http?.method,
      pathTemplate: call.targetDescriptor?.http?.pathTemplate || call.details?.path,
      // Prefer the resolved literal value over the symbol/enum reference —
      // same precedence as the cross-repo matcher (descriptor-matcher.ts), so
      // stored destinations join on the runtime string ('user.created'), not
      // the code-level token ('Topics.USER_CREATED').
      messagingSystem,
      messagingDestination,
      messagingDestinationRef,
      ipcDirection: descriptor?.ipc?.direction,
      grpcService: call.targetDescriptor?.grpc?.service,
      grpcMethod: call.targetDescriptor?.grpc?.method,
      graphqlOperationType: call.targetDescriptor?.graphql?.operationType,
      graphqlOperationName: call.targetDescriptor?.graphql?.operationName,
      // SCIP package moniker (consumer side) — the cross-repo symbol-hop join key.
      monikerPackage: call.moniker?.packageName,
      monikerDescriptor: call.moniker?.descriptor,
      // Dynamic-dispatch SDK method name — the cross-repo sdkMapping-fallback join key.
      dispatchMethod: call.dispatchMethod,
      resolvedTargetId: call.resolvedTargetId,
    },
    repoId,
    filePath: call.location.filePath,
    startLine: call.location.startLine,
    endLine: call.location.endLine,
  };
}

// =============================================================================
// Edge Transformers
// =============================================================================

function createContainsPackageEdges(repoId: string, packages: Package[]): GraphEdge[] {
  return packages.map((pkg) => parserEdge(repoId, pkg.id, EdgeType.ContainsPackage));
}

function createContainsFileEdges(repoId: string, files: FileNode[]): GraphEdge[] {
  return files.map((file) => parserEdge(repoId, file.id, EdgeType.ContainsFile));
}

function createContainsFunctionEdges(functions: FunctionNode[]): GraphEdge[] {
  return functions
    .filter((fn) => fn.kind === 'function')
    .map((fn) => parserEdge(fn.fileId, fn.id, EdgeType.ContainsFunction));
}

function createContainsClassEdges(classes: ClassNode[]): GraphEdge[] {
  return classes.map((cls) => parserEdge(cls.fileId, cls.id, EdgeType.ContainsClass));
}

function createContainsInterfaceEdges(interfaces: InterfaceNode[]): GraphEdge[] {
  return interfaces.map((iface) => parserEdge(iface.fileId, iface.id, EdgeType.ContainsInterface));
}

function createContainsEntityEdges(entities: EntityNode[]): GraphEdge[] {
  return entities.map((entity) => parserEdge(entity.fileId, entity.id, EdgeType.ContainsEntity));
}

/**
 * Entities can live in files the profile never parses as source (a Prisma
 * schema, an SQL DDL file): `entity.fileId` then references a file node that
 * `repo.files` does not contain. Backends that enforce edge endpoints
 * (Ladybug REL tables) reject the resulting CONTAINS_ENTITY edge — SQLite
 * merely accepted the dangling edge silently. Synthesize the missing file
 * node from the entity's own location, plus its repo containment edge, so
 * the chain stays intact on every backend.
 */
function synthesizeEntityFileNodes(
  repoId: string,
  entities: EntityNode[],
  knownNodeIds: ReadonlySet<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byFileId = new Map<string, GraphNode>();
  for (const entity of entities) {
    if (knownNodeIds.has(entity.fileId) || byFileId.has(entity.fileId)) continue;
    const path = entity.location.filePath;
    const dot = path.lastIndexOf('.');
    byFileId.set(entity.fileId, {
      id: entity.fileId,
      type: NodeType.File,
      name: path,
      properties: {
        path,
        extension: dot === -1 ? '' : path.slice(dot),
        synthesized: true,
      },
      repoId,
      filePath: path,
    });
  }
  const nodes = [...byFileId.values()];
  return {
    nodes,
    edges: nodes.map((file) => parserEdge(repoId, file.id, EdgeType.ContainsFile)),
  };
}

// Mirror the per-file containment pattern used by class/interface/function for
// type_alias, enum, variable, and external_call so they are reachable from
// their file (and via the file's containment chain, from the repo) — otherwise
// impact-analysis queries that walk containment can't find them.

function createContainsTypeAliasEdges(typeAliases: TypeAliasNode[]): GraphEdge[] {
  return typeAliases.map((ta) => parserEdge(ta.fileId, ta.id, EdgeType.ContainsTypeAlias));
}

function createContainsEnumEdges(enums: EnumNode[]): GraphEdge[] {
  return enums.map((en) => parserEdge(en.fileId, en.id, EdgeType.ContainsEnum));
}

function createContainsVariableEdges(variables: VariableNode[]): GraphEdge[] {
  return variables.map((v) => parserEdge(v.fileId, v.id, EdgeType.ContainsVariable));
}

function createContainsComponentEdges(components: ComponentNode[]): GraphEdge[] {
  return components.map((component) => parserEdge(component.fileId, component.id, EdgeType.ContainsComponent));
}

function createContainsRouteEdges(repoId: string, routes: RouteNode[]): GraphEdge[] {
  return routes.map((route) => parserEdge(repoId, route.id, EdgeType.ContainsRoute));
}

function createRendersComponentEdges(routes: RouteNode[]): GraphEdge[] {
  return routes
    .filter((route) => route.componentId)
    .map((route) => parserEdge(route.id, route.componentId!, EdgeType.RendersComponent));
}

function createUsesComponentEdges(components: ComponentNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const component of components) {
    if (component.childComponents) {
      for (const usage of component.childComponents) {
        if (usage.componentId) {
          edges.push(
            parserEdge(component.id, usage.componentId, EdgeType.UsesComponent, {
              componentName: usage.componentName,
              filePath: usage.location.filePath,
              line: usage.location.startLine,
            }),
          );
        }
      }
    }
  }
  return edges;
}

function createHasMethodEdges(functions: FunctionNode[]): GraphEdge[] {
  return functions
    .filter((fn) => fn.kind === 'method' && fn.classId)
    .map((fn) => parserEdge(fn.classId!, fn.id, EdgeType.HasMethod));
}

/**
 * Resolution lineages whose binding is an INFERENCE rather than a resolution the compiler (or an
 * equivalent proof) performed. Such an edge is stored at reduced confidence and flagged
 * `inferred`, so a consumer can render it honestly instead of as a proven call. Every other
 * lineage keeps confidence 1.0 — the value they have always been stored at.
 *
 * `iface-impl` is here because it binds interface-typed dispatch to the interface's SOLE in-scope
 * implementation: right whenever the analyzed scope holds the only implementation, wrong when an
 * unanalyzed one is what the caller passes.
 *
 * Typed `Set<CallProvenance>`, not `Set<string>`: a renamed or removed lineage must fail the
 * build here. Under `Set<string>` it compiles clean and every edge in this tier silently reverts
 * to confidence 1.0 — the honesty regression is invisible.
 */
const INFERRED_CALL_PROVENANCES = new Set<CallProvenance>(['iface-impl']);

/** Confidence an inferred call edge is stored at (see {@link INFERRED_CALL_PROVENANCES}). */
const INFERRED_CALL_CONFIDENCE = 0.5;

function createCallsEdges(calls: CallEdge[]): GraphEdge[] {
  return calls
    .filter((call) => call.calleeId !== undefined)
    .map((call) => {
      const inferred = call.provenance !== undefined && INFERRED_CALL_PROVENANCES.has(call.provenance);
      return parserEdge(
        call.callerId,
        call.calleeId!,
        EdgeType.Calls,
        {
          edgeId: call.id,
          isAsync: call.isAsync,
          calleeExpression: call.calleeExpression,
          filePath: call.location.filePath,
          line: call.location.startLine,
          // How the callee was resolved, carried for every call so a consumer can weight the
          // edge (see CallProvenance). Absent on graphs parsed before provenance existed.
          provenance: call.provenance,
          // Named `provenanceInferred`, NOT `inferred`: the component-graph projections in every
          // backend already define `inferred` as `createdBy <> 'parser'`, a different notion. A
          // provenance-inferred call is still parser-created, so reusing the bare name would make
          // the two confusable in the same package.
          ...(inferred ? { provenanceInferred: true } : {}),
        },
        inferred ? INFERRED_CALL_CONFIDENCE : 1,
        call.id,
      );
    });
}

/** Storage cap for a callee expression — enough for a dispatch site, bounded for an answer. */
const MAX_CALLEE_EXPRESSION_LENGTH = 160;

function isIdentifierStartChar(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36; // A-Z, a-z, _, $
}

function isIdentifierContinueChar(code: number): boolean {
  return isIdentifierStartChar(code) || (code >= 48 && code <= 57); // + 0-9
}

/**
 * Trailing plain identifier of a callee expression, or null when it has none.
 *
 * `app.useLogger` → `useLogger`, `recalculateDayDurations` → itself. An
 * expression whose last step is computed (`logger[logLevel]`), a call
 * (`getHandler()`), or a template literal has NO statically known name, and
 * inventing one would produce candidate matches the source never supports —
 * so those answer null and simply never match a name lookup.
 *
 * A hand-rolled backwards scan, not `/[A-Za-z_$][A-Za-z0-9_$]*$/.exec(...)`:
 * that regex is quadratic on an adversarial expression (a long run of
 * identifier-continue characters followed by a non-identifier terminator,
 * e.g. a giant computed-subscript string), since the engine retries the match
 * from every character of the run before giving up — measured 3.1s at 80k
 * chars. ParsedRepo artifacts come from authenticated-but-untrusted repo
 * content and the cloud push worker runs this synchronously, so the scan
 * must stay linear regardless of input shape.
 */
export function calleeNameTail(calleeExpression: string): string | null {
  const end = calleeExpression.length;
  // Maximal trailing run of identifier-continue characters (letters, digits,
  // `_`, `$`) ending at the string's end — mirrors the regex's implicit `$`
  // anchor plus its `[A-Za-z0-9_$]*` continuation class.
  let start = end;
  while (start > 0 && isIdentifierContinueChar(calleeExpression.charCodeAt(start - 1))) start--;
  // Within that run, the regex's leftmost match starts at the first
  // identifier-START character (letters/`_`/`$`, never a leading digit) —
  // trim any leading digit-only prefix of the run.
  let nameStart = start;
  while (nameStart < end && !isIdentifierStartChar(calleeExpression.charCodeAt(nameStart))) nameStart++;
  if (nameStart >= end) return null;
  return calleeExpression.slice(nameStart, end);
}

/**
 * Calls with no `calleeId` — the sites {@link createCallsEdges} drops because
 * there is no target to point an edge at. They are the dynamic boundary of the
 * static graph, so they are persisted as their own records instead of vanishing.
 *
 * The name tail is computed from the FULL expression and the text capped
 * afterwards: truncation is a storage bound, and deriving the tail from a
 * truncated expression would cut identifiers in half.
 */
function createUnresolvedCalls(calls: CallEdge[]): UnresolvedCallRecord[] {
  return calls
    .filter((call) => call.calleeId === undefined)
    .map((call) => {
      // Single line first, so a wrapped call reads as one expression.
      const normalized = call.calleeExpression.replace(/\s+/g, ' ').trim();
      return {
        callerId: call.callerId,
        calleeExpression: normalized.slice(0, MAX_CALLEE_EXPRESSION_LENGTH),
        calleeNameTail: calleeNameTail(normalized),
        filePath: call.location.filePath,
        line: call.location.startLine,
      };
    });
}

function createImportsEdges(imports: ImportEdge[]): GraphEdge[] {
  return imports
    .filter((imp) => imp.targetFileId !== undefined)
    .map((imp) =>
      parserEdge(
        imp.sourceFileId,
        imp.targetFileId!,
        EdgeType.Imports,
        {
          edgeId: imp.id,
          moduleSpecifier: imp.moduleSpecifier,
          isTypeOnly: imp.isTypeOnly,
          importKind: imp.importKind,
        },
        1,
        imp.id,
      ),
    );
}

function createClassExtendsEdges(classes: ClassNode[]): GraphEdge[] {
  return classes
    .filter((cls) => cls.extends?.resolvedId !== undefined)
    .map((cls) => parserEdge(cls.id, cls.extends!.resolvedId!, EdgeType.Extends));
}

function createInterfaceExtendsEdges(interfaces: InterfaceNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const iface of interfaces) {
    if (iface.extends) {
      for (const ext of iface.extends) {
        if (ext.resolvedId) {
          edges.push(parserEdge(iface.id, ext.resolvedId, EdgeType.Extends));
        }
      }
    }
  }
  return edges;
}

function createImplementsEdges(classes: ClassNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const cls of classes) {
    if (cls.implements) {
      for (const impl of cls.implements) {
        if (impl.resolvedId) {
          edges.push(parserEdge(cls.id, impl.resolvedId, EdgeType.ImplementsInterface));
        }
      }
    }
  }
  return edges;
}

function createHandlesEdges(entrypoints: Entrypoint[]): GraphEdge[] {
  // Empty-string handlerId passes a `!= null` check but produces an edge with
  // an empty targetId. SQLite stores it; downstream JOINs find nothing but the
  // bogus edge still consumes index space and shows up in counts.
  return entrypoints
    .filter((ep) => ep.handlerId != null && ep.handlerId.length > 0)
    .map((ep) => parserEdge(ep.id, ep.handlerId, EdgeType.Handles));
}

function createOperatesOnEdges(dbOperations: DbOperation[]): GraphEdge[] {
  return dbOperations
    .filter((op) => op.entityId != null && op.performerId != null)
    .map((op) =>
      parserEdge(
        op.performerId,
        op.entityId!,
        EdgeType.OperatesOn,
        { operation: op.operation, operationId: op.id },
        1,
        op.id,
      ),
    );
}

function createMakesExternalCallEdges(calls: ExternalCallEdge[]): GraphEdge[] {
  return calls.map((call) => parserEdge(call.callerId, call.id, EdgeType.MakesExternalCall));
}

/**
 * REFERENCES_VARIABLE: caller function/method references a non-callable
 * target (state_store or variable) by name in its body. Used as the
 * fallback edge for `find_callers` when the lookup is a state_store or
 * variable — see `getDirectCallers` in the SQLite repository.
 */
function createReferencesVariableEdges(refs: ReferencesVariableEdge[]): GraphEdge[] {
  return refs.map((ref) =>
    parserEdge(
      ref.callerId,
      ref.targetId,
      EdgeType.ReferencesVariable,
      {
        targetKind: ref.targetKind,
        identifierName: ref.identifierName,
        filePath: ref.location.filePath,
        line: ref.location.startLine,
      },
      1,
      ref.id,
    ),
  );
}

// =============================================================================
// Summary/Embedding Integration
// =============================================================================

// =============================================================================
// USES_TYPE Edge Construction
// =============================================================================

// TS keywords that aren't user types — drop them when text-parsing fallback fires.
// Capitalized built-ins that DO act as type references (Promise, Array, Record,
// Map, Set, Partial, …) stay in the candidate list and naturally drop out
// because they don't exist in the in-repo type index.
const TYPE_TEXT_NON_REFS = new Set([
  'Function',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Date',
  'Error',
  'RegExp',
  'JSON',
  'Math',
  'Infinity',
  'NaN',
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'never',
  'unknown',
  'void',
  'any',
  'object',
]);

/**
 * Collect names of types referenced by a TypeInfo. Prefers walking
 * structure.kind === 'reference' through arrays/unions/intersections/etc. when
 * the parser populated `structure`. Falls back to scanning `text` for
 * PascalCase identifiers when only `text` is available — this is the common
 * case in real parsed output, where the base parser emits `{ text }` only.
 *
 * Returns names in document order with no dedup; the caller dedupes if needed.
 * Returns [] for primitives, literals, and unknown structures.
 */
function collectTypeReferences(t: TypeInfo | undefined): string[] {
  if (!t) return [];
  const names: string[] = [];
  const visit = (ti: TypeInfo | undefined): void => {
    if (!ti) return;
    const s = ti.structure;
    if (!s) {
      // Text-only fallback: scan for PascalCase identifiers. Filters TS
      // built-in non-type globals; unknown names remain candidates and
      // naturally drop out at index lookup if not part of the repo.
      if (ti.text) {
        const matches = ti.text.match(/\b[A-Z][A-Za-z0-9_]*\b/g);
        if (matches) {
          for (const m of matches) {
            if (!TYPE_TEXT_NON_REFS.has(m)) names.push(m);
          }
        }
      }
      return;
    }
    switch (s.kind) {
      case 'reference':
        names.push(s.name);
        s.typeArguments?.forEach(visit);
        return;
      case 'array':
        visit(s.elementType);
        return;
      case 'tuple':
        s.elements.forEach(visit);
        return;
      case 'union':
      case 'intersection':
        s.types.forEach(visit);
        return;
      case 'function':
        s.parameters.forEach((p) => visit(p.type));
        visit(s.returnType);
        return;
      case 'object':
        s.properties.forEach((p) => visit(p.type));
        return;
      // primitive | literal | unknown have no nested refs
    }
  };
  visit(t);
  return names;
}

interface TypeIndexEntry {
  id: string;
  kind: 'class' | 'interface' | 'type_alias' | 'enum';
  /** Declaring file, repo-relative — used to check a reference's imported module against the declaration. */
  filePath?: string;
}

/** Module identity of a repo-relative path: extension and a trailing `/index` are not part of a specifier. */
function moduleIdOf(filePath: string): string {
  return filePath.replace(/\.(m|c)?[jt]sx?$/, '').replace(/\/index$/, '');
}

/**
 * Module a relative specifier points at, as a module id. Bare package specifiers and path aliases
 * name no repo file here, so they resolve to undefined — identity is unverifiable for those.
 */
function resolveRelativeModuleId(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return moduleIdOf(posix.normalize(posix.join(posix.dirname(fromFile), specifier)));
}

/** Index repo's type-bearing nodes by bare name. Multiple matches are kept so
 * an edge is emitted to every candidate when the parser didn't resolve the ref —
 * sparser-but-wrong-singleton would silently hide real dependencies. */
function buildTypeIndex(repo: ParsedRepo): Map<string, TypeIndexEntry[]> {
  const idx = new Map<string, TypeIndexEntry[]>();
  const push = (name: string, entry: TypeIndexEntry): void => {
    const cur = idx.get(name) ?? [];
    cur.push(entry);
    idx.set(name, cur);
  };
  // Declaring file is what the identity filter below matches an imported reference against: an
  // entry without one can never satisfy it, so a class candidate was silently dropped for every
  // identity-verified reference until this carried its location.
  for (const c of repo.classes) push(c.name, { id: c.id, kind: 'class', filePath: c.location?.filePath });
  for (const i of repo.interfaces) push(i.name, { id: i.id, kind: 'interface', filePath: i.location?.filePath });
  for (const t of repo.typeAliases) push(t.name, { id: t.id, kind: 'type_alias', filePath: t.location?.filePath });
  for (const e of repo.enums) push(e.name, { id: e.id, kind: 'enum', filePath: e.location?.filePath });
  return idx;
}

interface UsageSite {
  sourceId: string;
  usage:
    | 'parameter'
    | 'return'
    | 'property'
    | 'interface-member'
    | 'aliased'
    | 'extends'
    | 'implements'
    | 'constructor-param'
    | 'member-access'
    | 'construction'
    | 'import';
  via?: string;
  /**
   * Type- vs value-position use. Omitted for type positions (the overwhelming
   * majority) so existing edges keep their exact property set.
   */
  useKind?: TypeUseKind;
  /** Enum member touched at a value-position site; set only with `useKind: Value`. */
  member?: string;
  /** Module the referenced name was imported from at the site; absent when declared in the same file. */
  importedFrom?: string;
  /** File the site sits in — the base a relative `importedFrom` resolves against. */
  sourceFilePath?: string;
  /** Declaring file the parser resolved the imported name to (barrels and aliases already followed). */
  declaringFile?: string;
  /**
   * The site is known to be a NAME match only, whatever the index returns — set by callers whose
   * reference carries no identity at all (an unbound heritage clause). A verified-looking single
   * candidate must not read as proof when the parse never proved anything.
   */
  unverifiedIdentity?: boolean;
}

/**
 * Declaration forms a usage site can legally target. A usage absent here targets any form (a type
 * annotation names a class, interface, alias or enum indifferently).
 */
const TARGET_KINDS_BY_USAGE: Partial<Record<UsageSite['usage'], TypeIndexEntry['kind'][]>> = {
  'member-access': ['enum'],
  construction: ['class'],
  import: ['class'],
};

/**
 * Emit a USES_TYPE edge per resolved name match for one usage site. If the
 * name has no match in the type index, the reference is dropped — we can't
 * link to a node that doesn't exist.
 */
function emitUsesTypeEdges(
  edges: GraphEdge[],
  seen: Set<string>,
  site: UsageSite,
  typeNames: string[],
  index: Map<string, TypeIndexEntry[]>,
): void {
  for (const name of typeNames) {
    const entries = index.get(name);
    if (!entries) continue;
    // Some sites can only be about one declaration form: a member access is an enum read, a
    // construction or an import reference is about a class. A same-named declaration of another
    // form is a different symbol, not a weaker match.
    const targetKinds = TARGET_KINDS_BY_USAGE[site.usage];
    let candidates = targetKinds ? entries.filter((e) => targetKinds.includes(e.kind)) : entries;
    // The name was IMPORTED, so only the type declared by that module is the same symbol: a
    // same-named declaration elsewhere is a different one and linking it would fabricate a
    // dependency.
    //
    // Identity comes from the parser when it could resolve one: `declaringFile` is the module that
    // DECLARES the symbol, with barrel re-exports and path aliases already followed, so it is
    // matched directly. Older outputs (and references the parser refused to resolve) carry only the
    // raw specifier: a relative one still pins the declaring file by arithmetic, and anything else
    // (package, path alias) leaves the match name-only — kept so re-exported declarations stay
    // visible, but flagged as ambiguous.
    let unverifiedIdentity = site.unverifiedIdentity ?? false;
    if (site.declaringFile) {
      const target = moduleIdOf(site.declaringFile);
      candidates = candidates.filter((e) => e.filePath !== undefined && moduleIdOf(e.filePath) === target);
    } else if (site.importedFrom && site.sourceFilePath) {
      const target = resolveRelativeModuleId(site.sourceFilePath, site.importedFrom);
      if (target === undefined) unverifiedIdentity = true;
      else candidates = candidates.filter((e) => e.filePath !== undefined && moduleIdOf(e.filePath) === target);
    }
    for (const entry of candidates) {
      // Dedup by (source, target, usage, via, member): the same parameter shouldn't
      // produce N identical edges if it appears multiple times in a union.
      const key = `${site.sourceId}|${entry.id}|${site.usage}|${site.via ?? ''}|${site.member ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(
        parserEdge(
          site.sourceId,
          entry.id,
          EdgeType.UsesType,
          {
            usage: site.usage,
            via: site.via,
            targetKind: entry.kind,
            ambiguous: candidates.length > 1 || unverifiedIdentity,
            ...(site.useKind ? { useKind: site.useKind } : {}),
            ...(site.member ? { member: site.member } : {}),
          },
          candidates.length === 1 && !unverifiedIdentity ? 1 : 0.5,
          generateEdgeId(
            site.sourceId,
            entry.id,
            `USES_TYPE:${site.usage}:${site.via ?? ''}${site.member ? `:${site.member}` : ''}`,
          ),
        ),
      );
    }
  }
}

/**
 * By-name USES_TYPE fallback for ONE heritage clause the parser could not bind. A bound clause
 * already has its EXTENDS / IMPLEMENTS_INTERFACE edge and must not be counted twice.
 *
 * Two honesty rules, both about what the parser proved:
 *  - a base PROVEN external gets NO edge at all. Its declaration is not in this graph, so every
 *    name match is wrong by construction — with exactly one same-named local class the old code
 *    emitted a fabricated hierarchy at confidence 1.0.
 *  - an UNRESOLVED base keeps the fallback (the dependency surface stays visible) but is marked
 *    ambiguous at reduced confidence, the same discipline a name-matched member access follows,
 *    so consumers render it with the unverified-identity suffix.
 */
function emitHeritageFallback(
  edges: GraphEdge[],
  seen: Set<string>,
  index: Map<string, TypeIndexEntry[]>,
  sourceId: string,
  usage: 'extends' | 'implements',
  ref: TypeReference,
): void {
  if (ref.resolvedId || ref.external) return;
  emitUsesTypeEdges(edges, seen, { sourceId, usage, unverifiedIdentity: true }, [ref.name], index);
}

function createUsesTypeEdges(repo: ParsedRepo): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const index = buildTypeIndex(repo);
  if (index.size === 0) return edges;

  // Functions and methods: parameters and return types.
  for (const fn of repo.functions) {
    for (const p of fn.parameters) {
      emitUsesTypeEdges(
        edges,
        seen,
        { sourceId: fn.id, usage: 'parameter', via: p.name },
        collectTypeReferences(p.type),
        index,
      );
    }
    emitUsesTypeEdges(edges, seen, { sourceId: fn.id, usage: 'return' }, collectTypeReferences(fn.returnType), index);
  }

  // Classes: property types, extends (resolved or by-name), implements.
  for (const cls of repo.classes) {
    for (const prop of cls.properties) {
      emitUsesTypeEdges(
        edges,
        seen,
        { sourceId: cls.id, usage: 'property', via: prop.name },
        collectTypeReferences(prop.type),
        index,
      );
    }
    // Constructor parameters — captures DI-injected types (NestJS/Angular/
    // Inversify/hand-rolled like sample-admin's MainModule), which otherwise
    // leave find_dependents empty even when the class is consumed in 5+ files.
    // The parser parks these on `cls.constructor.parameters` via parseConstructor.
    for (const p of cls.constructor?.parameters ?? []) {
      emitUsesTypeEdges(
        edges,
        seen,
        { sourceId: cls.id, usage: 'constructor-param', via: p.name },
        collectTypeReferences(p.type),
        index,
      );
    }
    if (cls.extends) emitHeritageFallback(edges, seen, index, cls.id, 'extends', cls.extends);
    for (const impl of cls.implements ?? []) emitHeritageFallback(edges, seen, index, cls.id, 'implements', impl);
  }

  // Interfaces: member types and unresolved extends.
  for (const iface of repo.interfaces) {
    for (const m of iface.members) {
      emitUsesTypeEdges(
        edges,
        seen,
        { sourceId: iface.id, usage: 'interface-member', via: m.name },
        [...collectTypeReferences(m.type), ...collectTypeReferences(m.returnType)],
        index,
      );
    }
    for (const ext of iface.extends ?? []) emitHeritageFallback(edges, seen, index, iface.id, 'extends', ext);
  }

  // Type aliases: right-hand-side references.
  for (const ta of repo.typeAliases) {
    emitUsesTypeEdges(edges, seen, { sourceId: ta.id, usage: 'aliased' }, collectTypeReferences(ta.aliasedType), index);
  }

  // Value-position enum-member references (`if (x === Status.Locked)`): the same edge type to the
  // same enum, discriminated by useKind + the member name. Without these, "who consumes this enum"
  // answers only the type half, and an added member looks consumer-free.
  for (const ref of repo.enumMemberReferences ?? []) {
    emitUsesTypeEdges(
      edges,
      seen,
      {
        sourceId: ref.sourceId,
        usage: 'member-access',
        useKind: TypeUseKind.Value,
        member: ref.member,
        importedFrom: ref.importedFrom,
        sourceFilePath: ref.location?.filePath,
        declaringFile: ref.declaringFile,
      },
      [ref.enumName],
      index,
    );
  }

  // Class references: `new X()` (the site an impact question actually means) and the import that
  // brought the class into a module. Without these a class's only incoming edge is the containment
  // edge from its own file, and "who uses this class" renders a zero next to a file that constructs
  // it on every request.
  const classRefs = repo.classReferences ?? [];
  // A file that CONSTRUCTS the class already states the stronger fact; its import row would double
  // count the same dependency, so the concrete use subsumes it.
  const constructedInFile = new Set(
    classRefs
      .filter((ref) => ref.refKind === 'construction')
      .map((ref) => `${ref.location?.filePath ?? ''}|${ref.className}|${ref.declaringFile ?? ''}`),
  );
  for (const ref of classRefs) {
    const key = `${ref.location?.filePath ?? ''}|${ref.className}|${ref.declaringFile ?? ''}`;
    if (ref.refKind === 'import' && constructedInFile.has(key)) continue;
    emitUsesTypeEdges(
      edges,
      seen,
      {
        sourceId: ref.sourceId,
        usage: ref.refKind,
        // The alias the importing module renamed the class to — the name a reader greps for there.
        // Absent unless the parse recorded a rename, so an un-aliased row keeps its exact shape.
        ...(ref.localName ? { via: ref.localName } : {}),
        // A construction is a VALUE-position use of the class (the import is not: it binds the
        // name in both positions at once, so it stays undetermined).
        ...(ref.refKind === 'construction' ? { useKind: TypeUseKind.Value } : {}),
        importedFrom: ref.importedFrom,
        sourceFilePath: ref.location?.filePath,
        declaringFile: ref.declaringFile,
      },
      [ref.className],
      index,
    );
  }

  return edges;
}

function formatSideEffects(sideEffects: SideEffect[]): string {
  if (!sideEffects || sideEffects.length === 0) return '';
  return sideEffects.map((se) => `[${se.type}${se.isDirect ? '' : ' (indirect)'}] ${se.description}`).join('\n');
}

function formatBusinessLogic(businessLogic: string[]): string {
  if (!businessLogic || businessLogic.length === 0) return '';
  return businessLogic.map((rule) => `- ${rule}`).join('\n');
}

export interface DroppedMetadataCounts {
  summaries: number;
  functionEmbeddings: number;
  endpointEmbeddings: number;
  total: number;
}

export interface NormalizedMetadata {
  summaryOutput: SummaryOutput | null;
  embeddingsOutput: EmbeddingsOutput | null;
  dropped: DroppedMetadataCounts;
}

/**
 * Keep only per-node metadata that belongs to the current parsed node version.
 * Stable IDs deliberately survive source changes, so an older summary or
 * embedding artifact can legitimately contain entries for the previous
 * implementation. Those entries are cache misses, not a reason to reject the
 * graph update. Artifact-level repo identity is validated by the push boundary.
 *
 * The inputs are never mutated: incremental merge callers can safely use the
 * returned copies while retaining the downloaded artifacts for diagnostics.
 */
export function normalizeMetadataForParsedRepo(
  repo: ParsedRepo,
  summaryOutput: SummaryOutput | null,
  embeddingsOutput: EmbeddingsOutput | null,
): NormalizedMetadata {
  const functionVersions = new Map(repo.functions.map((fn) => [fn.id, fn.versionedId]));
  const endpointVersions = new Map(repo.entrypoints.map((endpoint) => [endpoint.id, endpoint.versionedId]));

  const summaries =
    summaryOutput?.summaries.filter((summary) => functionVersions.get(summary.functionId) === summary.versionedId) ??
    [];
  const functionEmbeddings =
    embeddingsOutput?.functions.filter(
      (embedding) => functionVersions.get(embedding.functionId) === embedding.versionedId,
    ) ?? [];
  const endpointEmbeddings =
    embeddingsOutput?.endpoints.filter(
      (embedding) => endpointVersions.get(embedding.endpointId) === embedding.versionedId,
    ) ?? [];

  const dropped = {
    summaries: (summaryOutput?.summaries.length ?? 0) - summaries.length,
    functionEmbeddings: (embeddingsOutput?.functions.length ?? 0) - functionEmbeddings.length,
    endpointEmbeddings: (embeddingsOutput?.endpoints.length ?? 0) - endpointEmbeddings.length,
    total: 0,
  };
  dropped.total = dropped.summaries + dropped.functionEmbeddings + dropped.endpointEmbeddings;

  return {
    summaryOutput: summaryOutput ? { ...summaryOutput, summaries } : null,
    embeddingsOutput: embeddingsOutput
      ? { ...embeddingsOutput, functions: functionEmbeddings, endpoints: endpointEmbeddings }
      : null,
    dropped,
  };
}

function mergeSummaries(nodes: GraphNode[], summaryOutput: SummaryOutput | null): void {
  if (!summaryOutput) return;

  // Merge repository-level summary onto the repository node
  if (summaryOutput.repositorySummary) {
    const repoNode = nodes.find((n) => n.type === 'repository');
    if (repoNode) {
      const rs = summaryOutput.repositorySummary;
      repoNode.summary = rs.overview;
      repoNode.properties.dataModel = rs.dataModel;
      repoNode.properties.externalIntegrations = JSON.stringify(rs.externalIntegrations);
      repoNode.properties.summaryGeneratedAt = rs.generatedAt;
    }
  }

  // Merge function-level summaries
  if (!summaryOutput.summaries) return;

  const summaryMap = new Map<string, FunctionSummary>();
  for (const summary of summaryOutput.summaries) {
    summaryMap.set(summary.functionId, summary);
  }

  for (const node of nodes) {
    if (node.type === 'function') {
      const summary = summaryMap.get(node.id);
      if (summary) {
        node.summary = summary.detailed_summary;
        node.properties.purpose = summary.purpose;
        node.properties.businessLogic = formatBusinessLogic(summary.business_logic);
        node.properties.sideEffects = formatSideEffects(summary.side_effects);
      }
    }
  }
}

function mergeEmbeddings(nodes: GraphNode[], embeddingsOutput: EmbeddingsOutput | null): void {
  if (!embeddingsOutput) return;

  if (embeddingsOutput.functions) {
    const functionMap = new Map<string, FunctionEmbedding>();
    for (const emb of embeddingsOutput.functions) {
      functionMap.set(emb.functionId, emb);
    }

    for (const node of nodes) {
      if (node.type === 'function') {
        const emb = functionMap.get(node.id);
        if (emb) {
          node.embedding = emb.embedding;
          node.properties.embeddingChecksum = emb.inputChecksum;
          node.properties.embeddingGeneratedAt = emb.generatedAt;
          node.properties.embeddingModel = embeddingsOutput.model;
          node.properties.embeddingProvider = embeddingsOutput.provider;
          node.properties.embeddingDimensions = embeddingsOutput.dimensions;
          node.properties.embeddingInputStrategy = embeddingsOutput.inputStrategy;
        }
      }
    }
  }

  if (embeddingsOutput.endpoints) {
    const endpointMap = new Map<string, EndpointEmbedding>();
    for (const emb of embeddingsOutput.endpoints) {
      endpointMap.set(emb.endpointId, emb);
    }

    for (const node of nodes) {
      if (node.type === 'entrypoint') {
        const emb = endpointMap.get(node.id);
        if (emb) {
          node.embedding = emb.embedding;
          node.properties.embeddingChecksum = emb.inputChecksum;
          node.properties.embeddingGeneratedAt = emb.generatedAt;
          node.properties.embeddingModel = embeddingsOutput.model;
          node.properties.embeddingProvider = embeddingsOutput.provider;
          node.properties.embeddingDimensions = embeddingsOutput.dimensions;
        }
      }
    }
  }
}

// =============================================================================
// Main Transformer
// =============================================================================

/**
 * Result of transforming a ParsedRepo to graph format.
 */
export interface TransformResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Call sites with no resolvable callee — persisted next to the graph rather
   * than dropped, so consumers can name where the static trace stopped.
   */
  unresolvedCalls: UnresolvedCallRecord[];
  repositoryId: string;
  repositoryName: string;
  /**
   * Node ids that appeared more than once in the parsed input (first
   * occurrence kept). Legacy artifacts can carry these — route ids were
   * hashed without the declaring file until 2026-08-12 — and hosts should
   * surface them as a warning rather than fail the whole build.
   */
  duplicateNodeIds: string[];
}

/**
 * Transform a ParsedRepo to unified graph format.
 *
 * @param repo - The parsed repository
 * @param summaryOutput - Optional AI summaries to merge
 * @param embeddingsOutput - Optional embeddings to merge
 * @returns Unified graph nodes and edges
 */
/**
 * Append `items` to `target` without spread: `target.push(...items)` passes
 * every element as a call argument and overflows the V8 stack somewhere past
 * ~100k elements — real repos exceed that in `calls` alone.
 */
function pushAll<T>(target: T[], items: T[]): void {
  for (const item of items) target.push(item);
}

export function transformParsedRepo(
  repo: ParsedRepo,
  summaryOutput: SummaryOutput | null = null,
  embeddingsOutput: EmbeddingsOutput | null = null,
): TransformResult {
  const normalizedMetadata = normalizeMetadataForParsedRepo(repo, summaryOutput, embeddingsOutput);

  const repoId = repo.id;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const packageImports = packageImportsBySourceFile(repo.imports);

  // Transform nodes
  nodes.push(transformRepository(repo));
  pushAll(
    nodes,
    repo.packages.map((pkg) => transformPackage(pkg, repoId)),
  );
  pushAll(
    nodes,
    repo.files.map((file) => transformFile(file, repoId, packageImports.get(file.id) ?? [])),
  );
  pushAll(
    nodes,
    repo.functions.map((fn) => transformFunction(fn, repoId)),
  );
  pushAll(
    nodes,
    repo.classes.map((cls) => transformClass(cls, repoId)),
  );
  pushAll(
    nodes,
    repo.interfaces.map((iface) => transformInterface(iface, repoId)),
  );
  pushAll(
    nodes,
    repo.entrypoints.map((ep) => transformEntrypoint(ep, repoId)),
  );
  pushAll(
    nodes,
    repo.entities.map((entity) => transformEntity(entity, repoId)),
  );
  if (repo.components) {
    pushAll(
      nodes,
      repo.components.map((comp) => transformComponent(comp, repoId)),
    );
  }
  if (repo.routes) {
    pushAll(
      nodes,
      repo.routes.map((route) => transformRoute(route, repoId)),
    );
  }
  if (repo.stateStores) {
    pushAll(
      nodes,
      repo.stateStores.map((store) => transformStateStore(store, repoId)),
    );
  }
  pushAll(
    nodes,
    repo.typeAliases.map((ta) => transformTypeAlias(ta, repoId)),
  );
  pushAll(
    nodes,
    repo.enums.map((en) => transformEnum(en, repoId)),
  );
  pushAll(
    nodes,
    repo.variables.map((v) => transformVariable(v, repoId)),
  );
  if (repo.externalCalls?.length) {
    pushAll(
      nodes,
      repo.externalCalls.map((ec) => transformExternalCall(ec, repoId)),
    );
  }

  const entityFileRepair = synthesizeEntityFileNodes(repoId, repo.entities, new Set(nodes.map((node) => node.id)));
  pushAll(nodes, entityFileRepair.nodes);

  // Transform edges
  pushAll(edges, createContainsPackageEdges(repoId, repo.packages));
  pushAll(edges, createContainsFileEdges(repoId, repo.files));
  pushAll(edges, createContainsFunctionEdges(repo.functions));
  pushAll(edges, createContainsClassEdges(repo.classes));
  pushAll(edges, createContainsInterfaceEdges(repo.interfaces));
  pushAll(edges, createContainsTypeAliasEdges(repo.typeAliases));
  pushAll(edges, createContainsEnumEdges(repo.enums));
  pushAll(edges, createContainsVariableEdges(repo.variables));
  pushAll(edges, createContainsEntityEdges(repo.entities));
  pushAll(edges, entityFileRepair.edges);
  if (repo.components) {
    pushAll(edges, createContainsComponentEdges(repo.components));
    pushAll(edges, createUsesComponentEdges(repo.components));
  }
  if (repo.routes) {
    pushAll(edges, createContainsRouteEdges(repoId, repo.routes));
    pushAll(edges, createRendersComponentEdges(repo.routes));
  }
  pushAll(edges, createHasMethodEdges(repo.functions));
  pushAll(edges, createCallsEdges(repo.calls));
  pushAll(edges, createImportsEdges(repo.imports));
  pushAll(edges, createClassExtendsEdges(repo.classes));
  pushAll(edges, createInterfaceExtendsEdges(repo.interfaces));
  pushAll(edges, createImplementsEdges(repo.classes));
  pushAll(edges, createUsesTypeEdges(repo));
  pushAll(edges, createHandlesEdges(repo.entrypoints));
  pushAll(edges, createOperatesOnEdges(repo.dbOperations));
  if (repo.externalCalls?.length) {
    pushAll(edges, createMakesExternalCallEdges(repo.externalCalls));
  }
  if (repo.referencesVariables?.length) {
    pushAll(edges, createReferencesVariableEdges(repo.referencesVariables));
  }

  // Merge summaries and embeddings
  mergeSummaries(nodes, normalizedMetadata.summaryOutput);
  mergeEmbeddings(nodes, normalizedMetadata.embeddingsOutput);

  // Deduplicate node ids keeping the first occurrence. Legacy parsed
  // artifacts can contain duplicates (same route path+component declared in
  // two files hashed to one id before the file was added to the input):
  // SQLite absorbed them via upsert while endpoint-enforcing backends
  // (Ladybug) reject the second insert. Edges are unaffected — the surviving
  // node keeps the shared id.
  const seenIds = new Set<string>();
  const duplicateNodeIds: string[] = [];
  const dedupedNodes = nodes.filter((node) => {
    if (seenIds.has(node.id)) {
      duplicateNodeIds.push(node.id);
      return false;
    }
    seenIds.add(node.id);
    return true;
  });

  return {
    nodes: dedupedNodes,
    edges,
    unresolvedCalls: createUnresolvedCalls(repo.calls),
    repositoryId: repoId,
    repositoryName: repo.name,
    duplicateNodeIds,
  };
}

/**
 * Get statistics about a transformed graph.
 */
export function getTransformStats(result: TransformResult): {
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  totalNodes: number;
  totalEdges: number;
  nodesWithSummaries: number;
  nodesWithEmbeddings: number;
} {
  const nodesByType: Record<string, number> = {};
  const edgesByType: Record<string, number> = {};

  let nodesWithSummaries = 0;
  let nodesWithEmbeddings = 0;

  for (const node of result.nodes) {
    nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    if (node.summary) nodesWithSummaries++;
    if (node.embedding) nodesWithEmbeddings++;
  }

  for (const edge of result.edges) {
    edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
  }

  return {
    nodesByType,
    edgesByType,
    totalNodes: result.nodes.length,
    totalEdges: result.edges.length,
    nodesWithSummaries,
    nodesWithEmbeddings,
  };
}
