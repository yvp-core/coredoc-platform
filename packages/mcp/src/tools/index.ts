/**
 * Tool Exports
 *
 * Re-exports all tool handlers from their categories.
 */

// Impact Analysis Tools
export { handleAnalyzeChangeImpact } from './impact/analyze-change-impact.js';
export { handleFindCallers } from './impact/find-callers.js';
export { handleFindDependents } from './impact/find-dependents.js';
export { handleFindEntityUsage } from './impact/find-entity-usage.js';

// Understanding Tools
// NOTE: explain-function / explain-entrypoint are no longer standalone tools, but
// their handlers stay — `explain` routes to them internally (see explain.ts).
export { handleExplain } from './understanding/explain.js';

// Discovery Tools
export { handleSearchSymbols } from './discovery/search-symbols.js';
export { handleListEntrypoints } from './discovery/list-entrypoints.js';
export { handleDescribeRepository } from './discovery/describe-repository.js';
export { handleDescribeDbSchema } from './discovery/describe-db-schema.js';
export { handleGetExtractionCoverage } from './discovery/get-extraction-coverage.js';
// Read-only Cypher escape hatch — shared with the hosted MCP surface, which
// registers it statically and feature-detects the leased repository per call.
export { handleRunCypherQuery } from './discovery/run-cypher-query.js';

// Cross-Repo Tools
export { handleTraceCrossRepoCall } from './cross-repo/trace-cross-repo-call.js';
export { handleListServiceDependencies } from './cross-repo/list-service-dependencies.js';
