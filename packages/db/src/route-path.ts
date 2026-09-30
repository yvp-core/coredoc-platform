/**
 * Route/entrypoint path matching that is agnostic to how a path parameter was
 * written. Parsers store the framework's own placeholder syntax — Express/Nest
 * `:id`, OpenAPI/Spring `{id}`, Flask `<id>`, Next.js `[id]`, or a bare `*` — so
 * an agent that types `{companyUuid}` must still match a stored `:companyUuid`,
 * `{uuid}`, or `{_}`. We normalize every parameter segment to a single canonical
 * token and compare on that, instead of a literal substring match.
 */

/**
 * A path segment is a parameter placeholder when it is wrapped in `{…}`, `<…>`,
 * `[…]`, prefixed with `:`, or is a bare wildcard (`*` / `**`). The name inside
 * is irrelevant for matching — `{companyUuid}`, `:id`, and `{_}` are all "a
 * parameter goes here".
 */
function isParamSegment(segment: string): boolean {
  return (
    /^\{.*\}$/.test(segment) ||
    /^<.*>$/.test(segment) ||
    /^\[.*\]$/.test(segment) ||
    /^:.+/.test(segment) ||
    segment === '*' ||
    segment === '**'
  );
}

/**
 * Canonicalize a route path for comparison: lowercase, strip surrounding
 * slashes, drop empty segments, and replace every parameter segment with `:p`.
 * `/v3/Companies/{companyUuid}/spaces` and `v3/companies/:id/spaces` both become
 * `v3/companies/:p/spaces`.
 */
export function normalizeRoutePath(path: string): string {
  return path
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (isParamSegment(s) ? ':p' : s))
    .join('/');
}

/**
 * True when `query` matches `candidate` ignoring parameter-placeholder syntax.
 * Uses substring semantics (a partial path like `companies/{id}/spaces` matches
 * a longer stored path) while making the parameter names/brackets irrelevant.
 * An empty query matches anything.
 */
export function routePathMatches(query: string, candidate: string): boolean {
  const q = normalizeRoutePath(query);
  if (!q) return true;
  const c = normalizeRoutePath(candidate);
  return c === q || c.includes(q);
}

/**
 * The address fields an entrypoint can be filtered by. HTTP entrypoints carry a
 * path; queue/event/kafka carry a destination or topic; cron a schedule; CLI a
 * command; GraphQL a field name. Structural (not the `EntrypointInfo` type) so
 * this stays a leaf module the three backends can share.
 */
export interface EntrypointAddress {
  fullPath?: string;
  path?: string;
  fieldName?: string;
  destination?: string;
  destinationValue?: string;
  topic?: string;
  topicValue?: string;
  eventName?: string;
  command?: string;
  schedule?: string;
  /** Mobile entrypoint address: the component class simple name. */
  className?: string;
}

/** Every non-empty address token of an entrypoint, in display precedence. */
export function entrypointAddressTokens(ep: EntrypointAddress): string[] {
  return [
    ep.fullPath,
    ep.path,
    ep.fieldName,
    ep.destinationValue,
    ep.destination,
    ep.topicValue,
    ep.topic,
    ep.eventName,
    ep.command,
    ep.schedule,
    ep.className,
  ].filter((token): token is string => typeof token === 'string' && token.trim().length > 0);
}

/**
 * True when `pattern` matches ANY of the entrypoint's address tokens.
 *
 * `listEntrypoints({pathPattern})` used to compare against `fullPath ?? path`
 * only, so a topic/queue/cron/CLI entrypoint could never be filtered by the
 * only name it has — `pathPattern: "DailySummaryRecalculateV2"` returned 0 rows
 * while the unfiltered list showed that exact topic. An empty pattern matches
 * anything (routePathMatches semantics); an entrypoint with no address token at
 * all cannot match a non-empty pattern.
 */
export function entrypointAddressMatches(pattern: string, ep: EntrypointAddress): boolean {
  if (!normalizeRoutePath(pattern)) return true;
  return entrypointAddressTokens(ep).some((token) => routePathMatches(pattern, token));
}

/**
 * The longest literal (non-parameter) segment of a path, used as a cheap,
 * placeholder-independent pre-filter for the DB query (the stored path is
 * guaranteed to contain this literal regardless of its parameter syntax).
 * Returns `undefined` when the path is entirely parameters — callers then skip
 * the DB path filter and rely solely on `routePathMatches` over the scope.
 */
export function staticRouteAnchor(path: string): string | undefined {
  // Preserve original case — the DB filter lowercases both sides itself, and the
  // anchor should remain a genuine substring of the stored path.
  const literals = path
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((s) => s.length > 0 && !isParamSegment(s));
  if (literals.length === 0) return undefined;
  return literals.reduce((longest, s) => (s.length > longest.length ? s : longest));
}
