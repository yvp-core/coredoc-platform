/**
 * explain_entrypoint Tool Handler
 *
 * Get full understanding of an API endpoint.
 */

import { type IGraphReadRepository } from '@coredoc/db';
import { type EntrypointAddress, entrypointAddressTokens, normalizeRoutePath } from '@coredoc/db/route-path';
import type { EntrypointType } from '@coredoc/core/types';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { formatEntrypointExplanation, createMetadata } from '../../response-formatter.js';
import { debug, debugResult } from '../../debug-logger.js';
import { httpMethodMatches, splitHttpMethodPrefix } from '../../http-method.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  EntrypointExplanationResult,
  EntrypointInfo,
  FunctionExplanationResult,
  FunctionInfo,
  EntityInfo,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import {
  filterEntrypointInfo,
  filterFunctionInfo,
  filterFunctionArray,
  resolveDetailLevel,
} from '../../detail-level.js';

/**
 * Handle explain_entrypoint tool
 */
export async function handleExplainEntrypoint(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<EntrypointExplanationResult | string>> {
  let method = args.method as string | undefined;
  let path = args.path as string | undefined;
  const entrypointType = args.entrypointType as string | undefined;
  // Exact node id — how `explain` deep-dives an entrypoint it already resolved
  // (from a `path:line` target or a destination token) without re-deriving an
  // address the node may not have (a queue entrypoint has no path).
  const id = args.id as string | undefined;
  // Handler body opt-in, same contract as explain_function: only when the
  // caller asked AND the operator enabled the capability.
  const includeSource = args.includeSource === true && allowSourcesInGraph();

  // Accept "METHOD /path" written into the path field on its own. Agents
  // naturally type the path the same way they'd write an OpenAPI line —
  // verb plus URL. Without splitting, `path: "POST /shifts/..."` does a
  // substring LIKE match starting with "POST " and never hits. Mirrors the
  // parse logic used by trace_cross_repo_call.
  if (!method && path) {
    const split = splitHttpMethodPrefix(path);
    if (split.method) {
      method = split.method;
      path = split.path;
    }
  }

  debug('findEntrypoint', `method=${method}, path=${path}, type=${entrypointType}`);

  // Find the entrypoint
  const type = entrypointType && entrypointType !== 'all' ? (entrypointType as EntrypointType) : undefined;
  const entrypoints = await repository.listEntrypoints(
    {
      type,
      ...(id ? { id } : { pathPattern: path }),
    },
    scope.repoHashes,
  );

  // Filter by method if specified. Wildcard-aware in both directions: a stored
  // `ALL` (file-convention / Pages API handler) serves whatever verb the agent
  // asked for, and a requested `ALL`/`ANY` accepts whatever verb is stored.
  const matchingEntrypoints = method ? entrypoints.filter((ep) => httpMethodMatches(method, ep.method)) : entrypoints;

  if (matchingEntrypoints.length === 0) {
    debugResult('findEntrypoint', 0);
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    const searchDesc = method && path ? `${method} ${path}` : path || method || id || 'specified entrypoint';
    return {
      data: format === 'raw' ? {} : `Entrypoint '${searchDesc}' not found in scope`,
      metadata,
      isError: true,
    } as McpResponse<EntrypointExplanationResult | string>;
  }

  debugResult('findEntrypoint', matchingEntrypoints.length);

  // Backends order `listEntrypoints` differently (Ladybug with localeCompare,
  // Neo4j with Cypher ORDER BY), so the pick must not depend on row order: rank
  // by how much each address adds to the query. An exact match adds nothing.
  const query = path ? normalizeRoutePath(path) : '';
  const ranked = query
    ? [...matchingEntrypoints].sort(
        (a, b) =>
          addressDistance(a, query) - addressDistance(b, query) ||
          compareCodePoints(a.fullPath ?? a.path ?? '', b.fullPath ?? b.path ?? '') ||
          compareCodePoints(a.method ?? '', b.method ?? '') ||
          compareCodePoints(a.id, b.id),
      )
    : matchingEntrypoints;
  const ep = ranked[0]!;
  const closestOf =
    query && ranked.length > 1 && addressDistance(ep, query) > 0
      ? {
          total: ranked.length,
          others: ranked.slice(1, 6).map((other) => ({
            id: other.id,
            ...(other.method ? { method: other.method } : {}),
            path: entrypointAddressTokens(other)[0] ?? other.id,
          })),
        }
      : undefined;
  const entrypoint: EntrypointInfo = {
    id: ep.id,
    type: ep.type,
    method: ep.method,
    path: ep.path,
    fullPath: ep.fullPath,
    fieldName: ep.fieldName,
    operationType: ep.operationType,
    topic: ep.topic,
    topicValue: ep.topicValue,
    // Messaging/CLI addressing — without these the queue/event title had
    // nothing human to render and fell back to the raw node id.
    system: ep.system,
    destination: ep.destination,
    destinationValue: ep.destinationValue,
    eventName: ep.eventName,
    command: ep.command,
    schedule: ep.schedule,
    // Mobile addressing, for the same reason: a mobile entrypoint is addressed by its
    // component class, so dropping it here renders every Android launcher and receiver as
    // its lifecycle method (`onCreate`, `onReceive`) — a name that is neither what the
    // caller typed nor unique in the repository.
    className: ep.className,
    trigger: ep.trigger,
    handlerId: ep.handlerId || '',
    handlerName: ep.handlerName || 'unknown',
    filePath: ep.filePath,
    startLine: ep.startLine || 0,
  };

  // Get handler function details
  let handler: FunctionExplanationResult;
  if (entrypoint.handlerId) {
    debug('findFunction', `handlerId=${entrypoint.handlerId}`);
    // Parse the handler's file path from its versioned ID so the lookup
    // disambiguates by file. ID format (id-generator.ts:functionId):
    // `{repoHash}:function:{filePath}:{functionName}`. Without this hint,
    // findFunction does a name-only `WHERE n.name = ?` and returns the
    // alphabetically-first match — a repo can have many same-named handlers
    // (e.g. 12+ `wrapper` functions across Pages API routes), so without the
    // file hint the lookup can resolve to the wrong handler entirely.
    const idParts = entrypoint.handlerId.split(':');
    const handlerFilePath = idParts.length >= 4 ? idParts.slice(2, -1).join(':') : undefined;
    const handlerFn = await repository.findFunction(entrypoint.handlerName || '', scope.repoHashes, handlerFilePath);

    if (handlerFn) {
      debugResult('findFunction', 1);
      handler = {
        function: {
          id: handlerFn.id,
          name: handlerFn.name,
          filePath: handlerFn.filePath,
          startLine: handlerFn.startLine,
          endLine: handlerFn.endLine,
          type: 'function',
          kind: handlerFn.kind,
          className: handlerFn.className,
          summary: handlerFn.summary,
          purpose: handlerFn.purpose,
          visibility: handlerFn.visibility,
          isAsync: handlerFn.isAsync,
          // Reuses the exact field explain_function surfaces — findFunction
          // already returns the stored body, so no new query machinery.
          ...(includeSource && handlerFn.sourceCode ? { sourceCode: handlerFn.sourceCode } : {}),
        },
        businessLogic: handlerFn.businessLogic,
        sideEffects: handlerFn.sideEffects,
      };
    } else {
      debugResult('findFunction', 0);
      handler = createEmptyHandler(entrypoint.handlerName || 'unknown');
    }
  } else {
    handler = createEmptyHandler(entrypoint.handlerName || 'unknown');
  }

  // Get call tree from handler
  let callTree: FunctionInfo[] = [];
  if (entrypoint.handlerId) {
    debug('getCallTree', `handlerId=${entrypoint.handlerId}`);
    const treeNodes = await repository.getCallTree(entrypoint.handlerId, 5, scope.repoHashes);
    debugResult('getCallTree', treeNodes.length);
    callTree = treeNodes.map((n) => ({
      id: n.id,
      name: n.name,
      filePath: n.filePath,
      startLine: n.startLine,
      type: 'function' as const,
      kind: n.kind,
      className: n.className,
      summary: n.summary,
    }));
  }

  // Entities touched + outbound services across the handler and everything it
  // reaches. Both were previously stubbed to [] even though the backing repo
  // methods exist — surface them, since "what does this endpoint read/write and
  // who does it call" is the highest-value part for planning a change.
  const reachableIds = [entrypoint.handlerId, ...callTree.map((fn) => fn.id)].filter((id): id is string => Boolean(id));

  const entities: EntityInfo[] = [];
  if (reachableIds.length > 0) {
    debug('getEntitiesForFunctions', `functions=${reachableIds.length}`);
    const entityOps = await repository.getEntitiesForFunctions(reachableIds, scope.repoHashes);
    const seen = new Set<string>();
    for (const op of entityOps) {
      if (seen.has(op.entityName)) continue;
      seen.add(op.entityName);
      // Enrich with the full entity so the location/repo tag render correctly;
      // fall back to the aggregate row when the entity can't be resolved.
      const full = await repository.findEntity(op.entityName, scope.repoHashes);
      entities.push({
        id: full?.id ?? op.entityId,
        name: op.entityName,
        tableName: full?.tableName ?? op.tableName,
        ormType: full?.ormType ?? 'unknown',
        schema: full?.schema,
        filePath: full?.filePath ?? '',
        startLine: full?.startLine ?? 0,
      });
    }
    debugResult('getEntitiesForFunctions', entities.length);
  }

  let externalServices: string[] = [];
  if (reachableIds.length > 0) {
    // Query external calls per reachable function (handler + everything it
    // reaches) rather than scanning the whole external_call table and filtering
    // in memory — cost then scales with this endpoint's reach, not the repo's
    // total outbound-call count.
    const services = new Set<string>();
    const perCaller = await Promise.all(
      reachableIds.map((id) => repository.getExternalCallsFrom(id, scope.repoHashes)),
    );
    for (const calls of perCaller) {
      for (const call of calls) {
        const name = (call.serviceName ?? '').trim();
        if (name) services.add(name);
      }
    }
    externalServices = Array.from(services).sort();
  }

  // Upstream callers - not yet implemented
  const upstreamCallers: { repo: string; callSites: number }[] = [];

  // Filter results based on detail level (use default 'full' config if not provided)
  const config = detailConfig || resolveDetailLevel('full');
  const filteredEntrypoint = filterEntrypointInfo(entrypoint, config) as EntrypointInfo;
  const filteredCallTree = filterFunctionArray(callTree, config) as FunctionInfo[];

  // Filter handler's function if handler exists. Source is re-attached AFTER
  // the detail filter (which rebuilds a narrow object) so includeSource works
  // at any detailLevel — same ordering as explain_function.
  const filteredHandlerFn = filterFunctionInfo(handler.function, config) as FunctionInfo;
  if (handler.function.sourceCode) {
    filteredHandlerFn.sourceCode = handler.function.sourceCode;
  }
  const filteredHandler = {
    ...handler,
    function: filteredHandlerFn,
  };

  const result: EntrypointExplanationResult = {
    entrypoint: filteredEntrypoint,
    handler: filteredHandler,
    callTree: filteredCallTree,
    entities,
    externalServices,
    upstreamCallers: upstreamCallers.length > 0 ? upstreamCallers : undefined,
    ...(closestOf ? { closestOf } : {}),
  };

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
  return formatEntrypointExplanation(result, metadata);
}

/**
 * Characters the closest address of `ep` adds to the normalized `query`: 0 for an
 * exact match, Infinity when no address contains the query.
 */
function addressDistance(ep: EntrypointAddress, query: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (const token of entrypointAddressTokens(ep)) {
    const normalized = normalizeRoutePath(token);
    if (normalized.includes(query)) best = Math.min(best, normalized.length - query.length);
  }
  return best;
}

/** Locale-independent tie-break, so the pick is the same on every host. */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Create empty handler explanation
 */
function createEmptyHandler(name: string): FunctionExplanationResult {
  return {
    function: {
      id: '',
      name,
      filePath: '',
      startLine: 0,
      type: 'function',
      kind: 'function',
    },
  };
}
