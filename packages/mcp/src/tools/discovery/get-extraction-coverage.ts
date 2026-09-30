/**
 * get_extraction_coverage Tool Handler
 *
 * Report how completely the extraction profile captured each repo in scope: per-repo counts
 * (call and db-operation resolution over the sites the parser counted, external-call resolution)
 * computed on demand from the stored graph, plus plain-language trust guidance (see coverage.ts
 * for the semantics).
 */

import { type IGraphReadRepository } from '@coredoc/db';
import { formatExtractionCoverage, createMetadata } from '../../response-formatter.js';
import { computeCoverageStats, type RepoCoverageStats } from '../../coverage.js';
import { debug, debugResult } from '../../debug-logger.js';
import type { ScopeContext, OutputFormat, McpResponse, DetailLevel, DetailLevelConfig } from '../../types.js';

/**
 * Handle get_extraction_coverage tool
 */
export async function handleGetExtractionCoverage(
  _args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  _detailLevel: DetailLevel | undefined,
  _detailConfig: DetailLevelConfig | undefined,
  repository: IGraphReadRepository,
): Promise<McpResponse<RepoCoverageStats[] | string>> {
  debug('getCoverageCounts', `hashes=${scope.repoHashes.join(',')}`);
  const stats = await computeCoverageStats(repository, scope.repoHashes);
  debugResult('getCoverageCounts', stats.length);

  const metadata = await createMetadata(scope, format, undefined, undefined, repository);
  return formatExtractionCoverage(stats, metadata);
}
