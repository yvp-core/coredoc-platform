/**
 * list_service_dependencies Tool Handler
 *
 * List all external services and internal systems this repo calls — third-party APIs,
 * microservices, IPC — with call counts and usage patterns.
 */

import { type IGraphReadRepository } from '@coredoc/db';
import { formatServiceDependencies, createMetadata } from '../../response-formatter.js';
import { debug, debugResult } from '../../debug-logger.js';
import { appendLowCoverageCaveat } from '../../coverage.js';
import { effectiveTarget, ownerRepoName } from './external-call-target.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  ServiceDependencyResult,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';

// Language/runtime built-in method names that leak into external_call rows when
// the parser's heuristic flags a promise/iteration chain (`.then(...)`,
// `.map(...)`) as an outbound call. They are never a real service operation, so
// we drop them from the human-readable patterns rather than show them as noise.
const NOISE_METHODS = new Set([
  'then',
  'catch',
  'finally',
  'map',
  'filter',
  'forEach',
  'reduce',
  'find',
  'some',
  'every',
  'flatMap',
]);

/**
 * Handle list_service_dependencies tool
 */
export async function handleListServiceDependencies(
  _args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  _detailLevel: DetailLevel | undefined,
  _detailConfig: DetailLevelConfig | undefined,
  repository: IGraphReadRepository,
): Promise<McpResponse<ServiceDependencyResult[] | string>> {
  // "What does THIS repo call" is inherently single-origin. When the host told
  // us which repo the agent is standing in (scope.currentRepoHash, a vantage
  // within the scope), report that repo's dependencies — not an aggregate of
  // every repo in a project-wide scope mislabeled as the first one. No vantage
  // → unchanged: query the full scope.
  const originHashes = scope.currentRepoHash ? [scope.currentRepoHash] : scope.repoHashes;

  debug('getServiceDependencies', `hashes=${originHashes.join(',')}`);

  const externalCalls = await repository.getExternalCalls(originHashes);

  debugResult('getServiceDependencies', externalCalls.length);

  // Aggregate by the call's effective target service.
  const serviceMap = new Map<
    string,
    {
      count: number;
      resolved: number;
      protocols: Set<string>;
      patterns: Set<string>;
      sdkNames: Set<string>;
    }
  >();

  for (const call of externalCalls) {
    // `effectiveTarget` owns the precedence (targetService → resolved repo → serviceName), the
    // whitespace normalization and the self-dependency guard: a call that resolves back into the
    // repo it was made from (multi-target monorepo, intra-repo RESOLVES_TO) is an in-repo edge,
    // and listing the repo among the services it depends on is a dependency that does not exist.
    // Unresolved and nameless stays dropped.
    const service = effectiveTarget(call, ownerRepoName(scope, call.id));
    if (!service) continue;

    const entry = serviceMap.get(service) || {
      count: 0,
      resolved: 0,
      protocols: new Set<string>(),
      patterns: new Set<string>(),
      sdkNames: new Set<string>(),
    };
    entry.count++;
    if (call.resolvedTargetId) entry.resolved++;
    entry.protocols.add(call.protocol);
    if (call.sdkName) entry.sdkNames.add(call.sdkName);

    // Build human-readable pattern.
    if (call.protocol === 'http' && call.httpMethod && call.pathTemplate) {
      entry.patterns.add(`${call.httpMethod} ${call.pathTemplate}`);
    } else if (call.messagingDestination) {
      entry.patterns.add(
        `messaging:${call.messagingSystem?.trim().toLowerCase() || 'unknown'}:${call.messagingDestination}`,
      );
    } else if (call.protocol === 'grpc' && call.grpcService) {
      entry.patterns.add(`grpc:${call.grpcService}.${call.grpcMethod ?? ''}`);
    } else if (call.protocol === 'graphql' && (call.graphqlOperationType || call.graphqlOperationName)) {
      entry.patterns.add(
        `graphql:${call.graphqlOperationType ?? 'operation'} ${call.graphqlOperationName ?? ''}`.trim(),
      );
    } else if (call.method && !NOISE_METHODS.has(call.method)) {
      // Fallback pattern: the raw method name, minus promise/iteration built-ins.
      entry.patterns.add(call.method);
    }
    serviceMap.set(service, entry);
  }

  const dependencies: ServiceDependencyResult[] = Array.from(serviceMap.entries())
    .map(([service, data]) => ({
      service,
      callCount: data.count,
      resolvedCount: data.resolved,
      callTypes: Array.from(data.protocols),
      patterns: Array.from(data.patterns).slice(0, 10),
    }))
    .sort((a, b) => b.callCount - a.callCount);

  if (dependencies.length === 0) {
    const metadata = await createMetadata(scope, format, undefined, undefined, repository);
    // Low external-call extraction density (0 extracted counts as 0%) makes
    // the empty list inconclusive — say so on the message itself (summary
    // text only; raw stays a plain empty array). Same origin as the query.
    const empty = {
      data:
        format === 'raw'
          ? []
          : `No external service dependencies detected in this repository.

This tool reads external_call nodes created by the parser during analysis.
If none were found, the parser may not have detected external service calls
in this codebase (e.g., HTTP clients, Kafka producers, gRPC stubs).`,
      metadata,
    } as McpResponse<ServiceDependencyResult[] | string>;
    await appendLowCoverageCaveat(empty, repository, originHashes, 'externalResolution');
    return empty;
  }

  const repoName = scope.currentRepo || scope.resolvedRepos[0] || 'unknown';
  const metadata = await createMetadata(scope, format, undefined, undefined, repository);
  return formatServiceDependencies(dependencies, repoName, metadata);
}
