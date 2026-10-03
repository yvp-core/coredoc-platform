/**
 * `intent_read` on the local server: an explicit refusal.
 *
 * The cloud tool reads a workspace's tree, node documents (layout, relations,
 * delivery) and full-text search. The repo-local overlay has none of those, so
 * there is nothing faithful to answer with. The tool is listed anyway, so an
 * agent told to use `intent_read` gets a reason and the read that does work
 * here, instead of an unknown-tool error.
 */
import type { IGraphReadRepository } from '@coredoc/db';
import { createMetadata } from '../../response-formatter.js';
import type { DetailLevel, DetailLevelConfig, McpResponse, OutputFormat, ScopeContext } from '../../types.js';

export const INTENT_READ_LOCAL_REFUSAL =
  'intent_read reads a cloud workspace (tree, node documents, search) and has no local equivalent: the repo-local ' +
  'intent overlay has no tree layout, relations or delivery records. Here, call get_intent_context — mode "list" ' +
  'to orient, then exact intentIds or a query. For a project cut over to a cloud workspace, call intent_read on ' +
  'the workspace MCP.';

export async function handleIntentRead(
  _args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel?: DetailLevel,
  detailConfig?: DetailLevelConfig,
  repository?: IGraphReadRepository,
): Promise<McpResponse<string>> {
  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
  return { data: INTENT_READ_LOCAL_REFUSAL, metadata, isError: true };
}
