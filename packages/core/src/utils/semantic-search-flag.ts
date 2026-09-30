/**
 * Semantic-search capability flag.
 *
 * Whether the MCP `semantic_search` tool is registered. Default OFF
 * (fail-closed): the tool only works when embeddings have been generated
 * (`coredoc embed`) and pushed, which most deployments don't do yet — so the
 * tool stays entirely absent (schema and handler) unless the operator opts in.
 * Read at MCP server module load, so the tool set is fixed per process.
 *
 * Accepts `true` or `1`; anything else (including unset) is off.
 */
export function semanticSearchEnabled(): boolean {
  const raw = process.env.ENABLE_SEMANTIC_SEARCH;
  return raw === 'true' || raw === '1';
}
