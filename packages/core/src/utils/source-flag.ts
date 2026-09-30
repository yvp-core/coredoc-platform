/**
 * Source-in-graph capability flag.
 *
 * Whether raw symbol source code may be STORED in the graph and RETRIEVED through
 * MCP. Default OFF (fail-closed).
 *
 * The default cloud/SaaS path deliberately strips source before any remote push
 * and the server rejects pushes that contain it — source must never leave the
 * client. This flag relaxes both ends and is intended ONLY for on-prem /
 * self-hosted deployments, where the operator owns the infrastructure that would
 * then hold the source. Because each process reads it independently, it must be
 * set consistently wherever code is parsed/pushed (CLI) and served (server).
 *
 * It gates the whole feature, both directions:
 *  - STORE: the db transformer copies `sourceCode` onto graph nodes, and the
 *    remote push skips source-stripping (and the server accepts it).
 *  - RETRIEVE: MCP exposes an `includeSource` param on `search_symbols`/`explain`
 *    and surfaces a `sourceCode` field in the response.
 *
 * Accepts `true` or `1`; anything else (including unset) is off.
 */
export function allowSourcesInGraph(): boolean {
  const raw = process.env.ALLOW_SOURCES_IN_GRAPH;
  return raw === 'true' || raw === '1';
}
