/**
 * @coredoc/core utilities
 */

// ERD generator
export * from './erd-generator.js';

// Locale-independent ordering for hashed / persisted / compared output
export { compareCodeUnits } from './deterministic-order.js';

// Config helpers
export * from './config-helpers.js';

// Git version info capture
export * from './git.js';

// Coredoc home directory resolution (~/.coredoc, COREDOC_HOME override)
export { resolveCoredocHome } from './coredoc-home.js';

// Telemetry configuration
export {
  getTelemetryConfig,
  setTelemetryEnabled,
  markTelemetryConsentPrompted,
  resetTelemetryConfigCache,
  type TelemetryConfig,
} from './telemetry-config.js';

// Source-in-graph capability flag (ALLOW_SOURCES_IN_GRAPH)
export { allowSourcesInGraph } from './source-flag.js';

// Semantic-search capability flag (ENABLE_SEMANTIC_SEARCH)
export { semanticSearchEnabled } from './semantic-search-flag.js';

// Project ID helpers
export * from './project-id.js';

// Repo reference & path-construction helpers
export * from './repo-ref.js';

// Canonical coredoc.config.json loader (shared by CLI, SDK, sync and MCP)
export { loadConfig } from './load-config.js';
