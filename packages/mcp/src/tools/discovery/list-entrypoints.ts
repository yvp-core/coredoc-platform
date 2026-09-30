/**
 * list_entrypoints Tool Handler
 *
 * List all API endpoints in the repository.
 */

import { type IGraphReadRepository } from '@coredoc/db';
import type { EntrypointType } from '@coredoc/core/types';
import { formatEntrypointList, createMetadata } from '../../response-formatter.js';
import { debug, debugResult } from '../../debug-logger.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  EntrypointInfo,
  EntrypointTypeFilter,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import { filterEntrypointArray, resolveDetailLevel } from '../../detail-level.js';

/**
 * Handle list_entrypoints tool
 */
export async function handleListEntrypoints(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<EntrypointInfo[] | string>> {
  const type = (args.type as EntrypointTypeFilter) || 'all';
  const pathFilter = args.pathFilter as string | undefined;
  const system = args.system as string | undefined;
  const displayLimit = Math.min(Math.floor(Number(args.limit)) || 20, 100);
  const displaySkip = Math.floor(Number(args.skip)) || 0;

  const repo = repository;

  debug(
    'listEntrypoints',
    `type=${type}, pathFilter=${pathFilter}, system=${system}, hashes=${scope.repoHashes.join(',')}`,
  );

  // Map 'all' to undefined for the repository method
  const entrypointType = type === 'all' ? undefined : (type as EntrypointType);

  const entrypoints = await repo.listEntrypoints(
    {
      type: entrypointType,
      pathPattern: pathFilter,
      system,
    },
    scope.repoHashes,
  );

  debugResult('listEntrypoints', entrypoints.length);

  // Map to the MCP EntrypointInfo format
  const mappedEntrypoints: EntrypointInfo[] = entrypoints.map((ep) => ({
    id: ep.id,
    type: ep.type,
    method: ep.method,
    path: ep.path,
    fullPath: ep.fullPath,
    fieldName: ep.fieldName,
    operationType: ep.operationType,
    topic: ep.topic,
    topicValue: ep.topicValue,
    system: ep.system,
    destination: ep.destination,
    destinationValue: ep.destinationValue,
    schedule: ep.schedule,
    handlerId: ep.handlerId || '',
    handlerName: ep.handlerName || 'unknown',
    eventName: ep.eventName,
    command: ep.command,
    className: ep.className,
    trigger: ep.trigger,
    summary: ep.summary,
    purpose: ep.purpose,
    filePath: ep.filePath,
    startLine: ep.startLine || 0,
  }));

  // Filter results based on detail level (use default 'full' config if not provided)
  const config = detailConfig || resolveDetailLevel('full');
  const filteredEntrypoints = filterEntrypointArray(mappedEntrypoints, config) as EntrypointInfo[];

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
  return formatEntrypointList(filteredEntrypoints, metadata, displayLimit, displaySkip);
}
