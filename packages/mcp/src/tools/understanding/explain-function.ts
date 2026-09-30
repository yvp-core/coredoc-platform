/**
 * explain_function Tool Handler
 *
 * Get comprehensive understanding of what a function does.
 */

import { type ExternalCallInfo, type IGraphReadRepository } from '@coredoc/db';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { formatFunctionExplanation, createMetadata } from '../../response-formatter.js';
import { debug, debugResult } from '../../debug-logger.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  FunctionExplanationResult,
  FunctionInfo,
  CallerInfo,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import { filterFunctionInfo, filterFunctionArray, filterCallerArray, resolveDetailLevel } from '../../detail-level.js';
import { ambiguousFunctionNote, findFunctionByName, parseFunctionName } from '../../function-name.js';
import { detectAmbiguity, toNodeTypes } from '../../ambiguity.js';
import { effectiveTarget, ownerRepoName } from '../cross-repo/external-call-target.js';

// Re-export so the test file can import the parser from this module. The
// canonical implementation lives in '../../function-name.js'.
export { parseFunctionName };

function externalCallPattern(call: ExternalCallInfo): string {
  if (call.messagingDestination) {
    return `messaging:${call.messagingSystem?.trim().toLowerCase() || 'unknown'}:${call.messagingDestination}`;
  }
  switch (call.protocol) {
    case 'http':
      return [call.httpMethod ?? call.method, call.pathTemplate].filter(Boolean).join(' ');
    case 'grpc':
      return [call.grpcService, call.grpcMethod ?? call.method].filter(Boolean).join('.');
    case 'graphql':
      return [call.graphqlOperationType, call.graphqlOperationName ?? call.method].filter(Boolean).join(' ');
    default:
      return call.dispatchMethod ?? call.method;
  }
}

/**
 * Handle explain_function tool
 */
export async function handleExplainFunction(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<FunctionExplanationResult | string>> {
  const functionName = args.functionName as string;
  const fileHint = args.fileHint as string | undefined;
  const includeCallees = args.includeCallees !== false;
  const includeCallers = args.includeCallers === true;
  // Source is opt-in AND only available when the operator enabled the capability.
  const includeSource = args.includeSource === true && allowSourcesInGraph();

  // Accept "Class.method" / "Namespace.Class.method": pass the qualifier as
  // className so findFunction filters by the owning class and bare-name
  // collisions across classes don't silently return the wrong function.
  const { lookupName, requestedClassName } = parseFunctionName(functionName);

  debug('findFunction', `name=${lookupName}, requestedClass=${requestedClassName ?? '-'}, fileHint=${fileHint}`);

  // Find the function. Try the fully-constrained lookup first.
  let funcInfo = await findFunctionByName(repository, functionName, scope.repoHashes, fileHint);

  // Reconciliation: when the agent passed a fileHint that doesn't belong to
  // the current scope (e.g. fileHint="services/api-gateway/..." while
  // scope="sample-admin"), the constrained lookup returns nothing even
  // though the bare name resolves cleanly. Retry name-only as a fallback so
  // the contradiction degrades gracefully instead of silently failing.
  let fileHintDropped = false;
  if (!funcInfo && fileHint) {
    debug('findFunction', `fileHint did not match in scope; retrying without it`);
    funcInfo = await findFunctionByName(repository, functionName, scope.repoHashes);
    fileHintDropped = funcInfo != null;
  }

  if (!funcInfo) {
    debugResult('findFunction', 0);
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    const notFoundLabel = requestedClassName
      ? `${requestedClassName}.${lookupName} (looked up as '${lookupName}')`
      : `'${functionName}'`;
    return {
      data:
        format === 'raw'
          ? {}
          : ((await ambiguousFunctionNote(repository, functionName, scope.repoHashes, fileHint)) ??
            `Function ${notFoundLabel} not found in scope`),
      metadata,
      isError: true,
    } as McpResponse<FunctionExplanationResult | string>;
  }

  if (fileHintDropped) {
    debug('findFunction', `resolved by name only; fileHint "${fileHint}" was dropped`);
  }
  debugResult('findFunction', 1);

  // Map to FunctionInfo format with additional fields
  const func: FunctionInfo & { businessLogic?: string; sideEffects?: string } = {
    id: funcInfo.id,
    name: funcInfo.name,
    filePath: funcInfo.filePath,
    startLine: funcInfo.startLine,
    endLine: funcInfo.endLine,
    type: 'function',
    kind: funcInfo.kind,
    // findFunction returns classId but not className. If the caller qualified
    // the input as Class.method, surface that name in the response.
    className: funcInfo.className ?? requestedClassName,
    summary: funcInfo.summary,
    purpose: funcInfo.purpose,
    visibility: funcInfo.visibility,
    isAsync: funcInfo.isAsync,
    businessLogic: funcInfo.businessLogic,
    sideEffects: funcInfo.sideEffects,
    // A node minted from a declaration convention (Rails association reader) has no body: the
    // formatter marks it so the answer is not read as an explanation of source that exists.
    synthesized: funcInfo.synthesized,
  };

  // Get callees (what this function calls)
  let callees: FunctionInfo[] | undefined;
  if (includeCallees) {
    debug('getDirectCallees', `sourceId=${func.id}`);
    const calleeInfos = await repository.getDirectCallees(func.id, scope.repoHashes);
    debugResult('getDirectCallees', calleeInfos.length);
    callees = calleeInfos.map((c) => ({
      id: c.id,
      name: c.name,
      filePath: c.filePath,
      startLine: c.startLine,
      endLine: c.endLine,
      type: 'function' as const,
      kind: c.kind,
      className: c.className,
      summary: c.summary,
      purpose: c.purpose,
      visibility: c.visibility,
      isAsync: c.isAsync,
      synthesized: c.synthesized,
    }));
  }

  // Get callers (who calls this function)
  let callers: CallerInfo[] | undefined;
  if (includeCallers) {
    debug('getDirectCallers', `targetId=${func.id}`);
    const callerInfos = await repository.getDirectCallers(func.id, scope.repoHashes);
    debugResult('getDirectCallers', callerInfos.length);
    callers = callerInfos.map((c) => ({
      id: c.id,
      name: c.name,
      filePath: c.filePath,
      startLine: c.startLine,
      endLine: c.endLine,
      type: 'function' as const,
      kind: c.kind,
      className: c.className,
      summary: c.summary,
      purpose: c.purpose,
      visibility: c.visibility,
      isAsync: c.isAsync,
      distance: 1,
    }));
  }

  // Get database operations - search for entity consumers
  // This is a simplified approach - actual db operations would need more tracking
  const dbOperations: { entity: string; operation: string }[] = [];

  debug('getExternalCallsFrom', `functionId=${func.id}`);
  const externalCallInfos = await repository.getExternalCallsFrom(func.id, scope.repoHashes);
  debugResult('getExternalCallsFrom', externalCallInfos.length);
  // Same target precedence (and the same self-dependency guard) the cross-repo tools use: a call
  // that resolves back into this function's own repository is an in-repo edge, not a service.
  const ownRepo = ownerRepoName(scope, func.id);
  const externalCalls = externalCallInfos
    .map((call) => ({ service: effectiveTarget(call, ownRepo), pattern: externalCallPattern(call) }))
    .filter((c): c is { service: string; pattern: string } => c.service !== undefined);

  // Filter results based on detail level (use default 'full' config if not provided)
  const config = detailConfig || resolveDetailLevel('full');
  const filteredFunc = filterFunctionInfo(func, config) as FunctionInfo;
  // Attach source AFTER the detail filter so includeSource works regardless of
  // detailLevel; only present when ALLOW_SOURCES_IN_GRAPH stored it.
  if (includeSource && funcInfo.sourceCode) {
    filteredFunc.sourceCode = funcInfo.sourceCode;
  }
  const filteredCallees = callees ? (filterFunctionArray(callees, config) as FunctionInfo[]) : undefined;
  const filteredCallers = callers ? (filterCallerArray(callers, config) as CallerInfo[]) : undefined;

  const result: FunctionExplanationResult = {
    function: filteredFunc,
    businessLogic: func.businessLogic,
    sideEffects: func.sideEffects,
    callees: filteredCallees,
    callers: filteredCallers,
    dbOperations: dbOperations.length > 0 ? dbOperations : undefined,
    externalCalls: externalCalls.length > 0 ? externalCalls : undefined,
  };

  const ambiguity = await detectAmbiguity(repository, {
    name: funcInfo.name,
    scope,
    nodeTypes: toNodeTypes('function'),
    resolvedId: funcInfo.id,
    resolvedFilePath: funcInfo.filePath,
    // fileHint was dropped during resolution, so don't narrow the candidate set by it.
    fileHint: fileHintDropped ? undefined : fileHint,
    className: funcInfo.className ?? requestedClassName,
    supportsClassName: true,
  });
  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository, ambiguity);
  return formatFunctionExplanation(result, metadata);
}
