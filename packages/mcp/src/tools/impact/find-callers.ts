/**
 * find_callers Tool Handler
 *
 * Find everything that calls a function — direct and transitive, plus which entrypoints ultimately trigger it.
 */

import { type IGraphReadRepository } from '@coredoc/db';
// NodeType enum (runtime value) — imported from @coredoc/core (canonical source)
// so it survives `vi.mock('@coredoc/db')` in tests.
import { NodeType } from '@coredoc/core';
import { formatCallerList, createMetadata } from '../../response-formatter.js';
import { boundariesForSymbolName, appendBoundarySection } from '../../boundaries.js';
import { debug, debugResult } from '../../debug-logger.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  DetailLevel,
  DetailLevelConfig,
  CallerInfo,
  EntrypointInfo as McpEntrypointInfo,
} from '../../types.js';
import type { CallerInfo as DbCallerInfo, EntrypointInfo } from '@coredoc/db';
import { filterCallerArray, filterEntrypointArray } from '../../detail-level.js';
import {
  ambiguousFunctionNote,
  findFunctionByName,
  implementedInterfaceMethods,
  parseFunctionName,
} from '../../function-name.js';
import { detectAmbiguity, toNodeTypes } from '../../ambiguity.js';
import { appendLowCoverageCaveat } from '../../coverage.js';

/**
 * Handle find_callers tool
 */
export async function handleFindCallers(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<unknown>> {
  // `explain` names its subject `target`, and agents carry that habit over.
  // Honor it as an alias — otherwise the lookup runs on `undefined` and reports
  // "Function 'undefined' not found in scope" for a function that is in the
  // graph (measured: useIsOrioleDb, UsersPage).
  const functionName = (args.functionName as string | undefined) ?? (args.target as string | undefined);
  const fileHint = args.fileHint as string | undefined;
  // Default depth=1 (direct callers only). Transitive depth is opt-in because
  // most rename/refactor questions only need direct references — pulling depth
  // 2+ inflates the agent's "files to touch" list with controllers and other
  // upstream callers that don't actually need editing.
  const depth = (args.depth as number) || 1;
  const includeEntrypoints = args.includeEntrypoints !== false;
  const displayLimit = Math.floor(Number(args.limit)) || 20;

  if (!functionName) {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return {
      data:
        format === 'raw'
          ? []
          : 'find_callers requires `functionName` — the function to find callers for (a bare name or `Class.method`).',
      metadata,
    };
  }

  // Accept "Class.method" — pass the qualifier as className so findFunction
  // filters by owning class. See packages/mcp/src/function-name.ts.
  const { lookupName, requestedClassName } = parseFunctionName(functionName);

  // Find the target function
  debug(
    'findFunction',
    `name=${lookupName}, requestedClass=${requestedClassName ?? '-'}, fileHint=${fileHint}, hashes=${scope.repoHashes.join(',')}`,
  );
  const targetFunction = await findFunctionByName(repository, functionName, scope.repoHashes, fileHint);

  // Two-pass resolution: try function first (the dominant case), then fall
  // back to state_store / variable when no function exists with this name.
  // The fallback is what surfaces Kea-style logics (`userLogic`, `teamLogic`,
  // …) and other named-but-not-invoked targets: `find_callers(userLogic)`
  // would otherwise dead-end because `userLogic` is a state_store node and
  // findFunction filters strictly on `type = 'function'`.
  let targetId: string | null = targetFunction?.id ?? null;
  let targetIsCallable = !!targetFunction;
  if (!targetId && !requestedClassName) {
    const candidates = await repository.findCode(
      { pattern: lookupName, types: [NodeType.StateStore, NodeType.Variable], limit: 1 },
      scope.repoHashes,
    );
    if (candidates.length > 0) {
      targetId = candidates[0]!.id;
      targetIsCallable = false;
    }
  }

  if (!targetId) {
    debugResult('findFunction', 0);
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    const notFoundLabel = requestedClassName
      ? `${requestedClassName}.${lookupName} (looked up as '${lookupName}')`
      : `'${functionName}'`;
    // Unbound call sites (and dispatch no substrate resolves) make "not found" inconclusive —
    // say so on the message itself (summary text only; raw stays a plain empty array).
    const notFound: McpResponse<unknown> = {
      data:
        format === 'raw'
          ? []
          : ((await ambiguousFunctionNote(repository, functionName, scope.repoHashes, fileHint)) ??
            `Function ${notFoundLabel} not found in scope`),
      metadata,
    };
    await appendLowCoverageCaveat(notFound, repository, scope.repoHashes, 'call');
    return notFound;
  }
  debugResult('findFunction', 1);

  // Get callers. For non-callable targets (state_store / variable) we skip
  // transitive lookup — the closure table tracks CALLS only, so any depth>1
  // hop would necessarily traverse a function-to-function CALLS edge that
  // doesn't exist for a non-callable target. Direct callers (depth=1)
  // already cover the use case: "who in the codebase references this?".
  debug('getCallers', `targetId=${targetId}, depth=${depth}, callable=${targetIsCallable}`);
  const dbCallers = targetIsCallable
    ? await repository.getTransitiveCallers(targetId, depth, scope.repoHashes)
    : await repository.getDirectCallers(targetId, scope.repoHashes);
  // Calls bound to an interface method the target implements reach it through dispatch the
  // call graph cannot see; merge them, flagged as inferred.
  const interfaceMethods =
    targetFunction && targetIsCallable
      ? await implementedInterfaceMethods(repository, targetFunction, scope.repoHashes)
      : [];
  for (const methodId of interfaceMethods) {
    const seen = new Set(dbCallers.map((caller) => caller.id));
    for (const caller of await repository.getTransitiveCallers(methodId, depth, scope.repoHashes))
      if (!seen.has(caller.id)) dbCallers.push({ ...caller, provenanceInferred: true });
  }
  debugResult('getCallers', dbCallers.length);

  // Get reaching entrypoints if requested. Same reasoning: closure table
  // only has CALLS edges, so reaching-entrypoints is a no-op for non-
  // callable targets.
  let entrypoints: EntrypointInfo[] = [];
  if (includeEntrypoints && targetIsCallable) {
    debug('getReachingEntrypoints', `targetId=${targetId}, depth=${depth}`);
    entrypoints = await repository.getReachingEntrypoints(targetId, depth, scope.repoHashes);
    for (const methodId of interfaceMethods) {
      const seen = new Set(entrypoints.map((entrypoint) => entrypoint.id));
      for (const entrypoint of await repository.getReachingEntrypoints(methodId, depth, scope.repoHashes))
        if (!seen.has(entrypoint.id)) entrypoints.push(entrypoint);
    }
    debugResult('getReachingEntrypoints', entrypoints.length);
  }

  // Map db CallerInfo to MCP CallerInfo (add required 'type' field)
  const callers: CallerInfo[] = dbCallers.map((c: DbCallerInfo) => ({
    id: c.id,
    name: c.name,
    type: 'function' as const,
    kind: c.kind,
    filePath: c.filePath,
    startLine: c.startLine,
    endLine: c.endLine,
    // A heuristic call edge (`iface-impl`: bound to the sole declared implementor
    // of an interface) must not read like a compiler-proven SCIP edge. Structured
    // flag, never folded into `name` — it survives basic detail and the text
    // formatter renders the caveat from it.
    ...(c.provenanceInferred && { provenanceInferred: true as const }),
    className: c.className,
    summary: c.summary,
    purpose: c.purpose,
    visibility: c.visibility,
    isAsync: c.isAsync,
    distance: c.distance,
    callSiteLine: c.callSiteLine,
  }));

  // Filter callers based on detail level
  const filteredCallers = filterCallerArray(callers, detailConfig) as CallerInfo[];

  // Filter entrypoints based on detail level
  const filteredEntrypoints = filterEntrypointArray(
    entrypoints.map((ep) => ({
      id: ep.id,
      type: ep.type,
      method: ep.method,
      path: ep.path,
      fullPath: ep.fullPath,
      fieldName: ep.fieldName,
      operationType: ep.operationType,
      topic: ep.topic,
      topicValue: ep.topicValue,
      schedule: ep.schedule,
      // See analyze-change-impact: the component class is a mobile entrypoint's address.
      className: ep.className,
      trigger: ep.trigger,
      handlerId: ep.handlerId || '',
      handlerName: ep.handlerName || 'unknown',
      filePath: ep.filePath,
      startLine: ep.startLine || 0,
      summary: ep.summary,
      purpose: ep.purpose,
    })) as McpEntrypointInfo[],
    detailConfig,
  ) as McpEntrypointInfo[];

  const ambiguity = targetFunction
    ? await detectAmbiguity(repository, {
        name: targetFunction.name,
        scope,
        nodeTypes: toNodeTypes('function'),
        resolvedId: targetFunction.id,
        resolvedFilePath: targetFunction.filePath,
        fileHint,
        className: requestedClassName,
        supportsClassName: true,
      })
    : undefined;
  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository, ambiguity);
  const response = formatCallerList(filteredCallers, functionName, metadata, filteredEntrypoints, displayLimit);
  // Function found but zero callers AND zero reaching entrypoints: with counted call sites left
  // unbound (or none counted at all) the absence may be a profile gap — append the one-line
  // caveat (lazy: only computed on the empty path, and only on the summary text).
  if (filteredCallers.length === 0 && filteredEntrypoints.length === 0) {
    await appendLowCoverageCaveat(response, repository, scope.repoHashes, 'call');
  }

  // Dynamic boundaries: statically unresolved call sites whose callee text
  // name-matches the target — CANDIDATE next-hop callers the static trace
  // could not cross. Matched by short name (bare identifier, no class
  // qualifier), the same shape `calleeNameTail` is precomputed against.
  // Appended as its own labeled section — never merged into `callers`/its
  // count (spec BR-1). No-op when nothing matches (absence stays meaningful).
  const boundaryName = targetFunction?.name ?? lookupName;
  const boundaryRecords = await boundariesForSymbolName(repository, boundaryName, scope.repoHashes);
  appendBoundarySection(
    response,
    boundaryRecords,
    `Dynamic boundaries — statically unresolved call sites whose callee text matches '${boundaryName}'; candidates, NOT confirmed callers`,
  );
  return response;
}
