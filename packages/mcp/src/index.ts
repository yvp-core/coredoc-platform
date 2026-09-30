#!/usr/bin/env node
/**
 * MCP Server Entry Point
 *
 * Coredoc MCP Server provides AI agents with structured access
 * to parsed codebase data stored in Database.
 */

export { createServer, startServer, main, LOCAL_TOOL_NAMES } from './server.js';
export { resolveScope, loadConfig, generateRepoHash } from './scope-resolver.js';
export type {
  ScopeContext,
  ScopeResolutionResult,
  OutputFormat,
  McpResponse,
  McpResponseMetadata,
  StalenessInfo,
  DetailLevel,
  DetailLevelConfig,
} from './types.js';
export { resolveDetailLevel, getDefaultDetailLevel } from './detail-level.js';
export { formatMcpContent } from './response-formatter.js';

// Canonical tool descriptions + parameter schemas, shared with the cloud MCP
// server so the two surfaces describe and validate each tool identically.
export { TOOL_DESCRIPTIONS, buildCypherDescription } from './tool-descriptions.js';
export type { CypherDialect } from './tool-descriptions.js';
export { TOOL_SCHEMAS, TOOL_INPUT_SCHEMAS, SYMBOL_TYPES, ENTRYPOINT_TYPES } from './tool-schemas.js';

// Declared read/write class of every Coredoc MCP tool, shared with the cloud
// MCP server and rendered into the workflow plugin's fixture.
export { COREDOC_TOOL_CLASSES, ToolAccess, toolAnnotations } from './tool-classes.js';
export type { ToolClass, ToolActionClasses } from './tool-classes.js';
export type { McpInputSchema } from './tool-schemas.js';

// Re-export tool handlers for programmatic use
export * from './tools/index.js';

// Start server if run directly (matches both dev and packaged runtime layouts)
const _entrypoint = process.argv[1]?.replace(/\\/g, '/');
if (
  _entrypoint?.endsWith('mcp/index.js') ||
  _entrypoint?.endsWith('mcp/index.ts') ||
  _entrypoint?.endsWith('mcp/dist/index.js')
) {
  import('./server.js').then((m) => m.main());
}
