/**
 * find_entity_usage Tool Handler
 *
 * Find all functions that read, write, update, or delete a specific DB model.
 */

import { type IGraphReadRepository } from '@coredoc/db';
import type { DbOperationType } from '@coredoc/core/types';
import { formatEntityConsumers, createMetadata } from '../../response-formatter.js';
import { detectAmbiguity, toNodeTypes } from '../../ambiguity.js';
import { debug, debugResult } from '../../debug-logger.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  EntityConsumerInfo,
  DbOperationFilter,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import { filterFunctionInfo, resolveDetailLevel } from '../../detail-level.js';
import { appendLowCoverageCaveat } from '../../coverage.js';
import { findEntityByName } from '../../function-name.js';

/**
 * Handle find_entity_usage tool
 */
export async function handleFindEntityUsage(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<EntityConsumerInfo[] | string>> {
  const entityName = args.entityName as string;
  const operation = (args.operation as DbOperationFilter) || 'all';

  debug('findEntity', `name=${entityName}`);

  // Find the entity
  const entity = await findEntityByName(repository, entityName, scope.repoHashes);

  if (!entity) {
    debugResult('findEntity', 0);
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    // Unbound (or uncounted) db-operation sites make "not found" inconclusive — say so on
    // the message itself (summary text only; raw stays a plain empty array).
    const notFound: McpResponse<EntityConsumerInfo[] | string> = {
      data: format === 'raw' ? [] : `Entity '${entityName}' not found in scope`,
      metadata,
    };
    await appendLowCoverageCaveat(notFound, repository, scope.repoHashes, 'dbOp');
    return notFound;
  }

  debugResult('findEntity', 1);

  // Get consumers
  debug('getEntityConsumers', `entityName=${entityName}, operation=${operation}`);
  const opFilter = operation === 'all' ? undefined : (operation as DbOperationType);
  const consumers = await repository.getEntityConsumers(entity.name, scope.repoHashes, opFilter);

  debugResult('getEntityConsumers', consumers.length);

  // Map to EntityConsumerInfo format
  const consumerInfos: EntityConsumerInfo[] = consumers.map((c) => ({
    id: c.id,
    name: c.name,
    filePath: c.filePath,
    startLine: c.startLine,
    type: 'function' as const,
    kind: c.kind,
    className: c.className,
    operation: c.operation,
  }));

  // Filter results based on detail level (use default 'full' config if not provided)
  // EntityConsumerInfo extends FunctionInfo, so we filter each and preserve the operation field
  const config = detailConfig || resolveDetailLevel('full');
  const filteredConsumers = consumerInfos.map((consumer) => ({
    ...filterFunctionInfo(consumer, config),
    operation: consumer.operation, // Always preserve operation field
  })) as EntityConsumerInfo[];

  const ambiguity = await detectAmbiguity(repository, {
    name: entity.name,
    scope,
    nodeTypes: toNodeTypes('entity'),
    resolvedId: entity.id,
    resolvedFilePath: entity.filePath,
  });
  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository, ambiguity);
  const response = formatEntityConsumers(filteredConsumers, entityName, metadata);
  // Entity found but zero consumers: with counted db-operation sites left unbound (or none
  // counted at all) the absence may be a profile gap — append the one-line caveat (lazy: only
  // computed on the empty path, and only on the summary text).
  if (filteredConsumers.length === 0) {
    await appendLowCoverageCaveat(response, repository, scope.repoHashes, 'dbOp');
  }
  return response;
}
