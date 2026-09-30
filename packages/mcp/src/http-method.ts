/**
 * HTTP verb vocabulary shared by every surface that addresses an entrypoint as
 * `METHOD /path` — `explain`'s router, `explain_entrypoint`, `search_symbols`'
 * pattern normalizer, and `trace_cross_repo_call`.
 *
 * The vocabulary includes the WILDCARD verbs. File-convention routers (Next.js
 * Pages API, and anything else that exports one handler per file rather than
 * one per verb) have no verb to extract, so the parser stores `method: 'ALL'`
 * on those entrypoints. Agents, reading the source, ask for the verb the
 * handler actually serves (`POST /api/ai/sql/generate-v4`), and a strict
 * string equality on `POST === 'ALL'` misses a route that plainly exists.
 */

/** Concrete request verbs. */
const CONCRETE_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * Verbs that stand for "any method". `ALL` is what the parser writes for a
 * file-convention handler; `ANY` is the spelling several other routers (and
 * agents) use, accepted as an alias so both addressings resolve.
 */
const WILDCARD_HTTP_METHODS = ['ALL', 'ANY'] as const;

/** Every verb an agent may type in a `METHOD /path` target. */
export const HTTP_METHODS: readonly string[] = [...CONCRETE_HTTP_METHODS, ...WILDCARD_HTTP_METHODS];

/** Regex alternation source (`GET|POST|…|ALL|ANY`) for embedding in patterns. */
export const HTTP_METHOD_ALTERNATION = HTTP_METHODS.join('|');

/** Matches a leading `METHOD ` prefix; group 1 is the verb, group 2 the rest. */
const HTTP_METHOD_PREFIX_PATTERN = new RegExp(`^(${HTTP_METHOD_ALTERNATION})\\s+(.+)$`, 'i');

function isWildcardMethod(method: string): boolean {
  return (WILDCARD_HTTP_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * Does a STORED entrypoint method satisfy a REQUESTED one?
 *
 * Wildcards match in both directions: an `ALL` handler serves every verb, so a
 * requested `POST` matches it; and a requested `ALL`/`ANY` means "whatever verb
 * this path is on", so it matches every stored method. Otherwise it is a
 * case-insensitive equality. A missing stored method never matches a concrete
 * request — an entrypoint with no verb is not evidence that it serves one.
 */
export function httpMethodMatches(requested: string | undefined, stored: string | undefined): boolean {
  if (!requested) return true;
  if (isWildcardMethod(requested)) return true;
  if (!stored) return false;
  if (isWildcardMethod(stored)) return true;
  return stored.toUpperCase() === requested.toUpperCase();
}

/**
 * Split a `METHOD /path` target into its parts. Returns `method: undefined`
 * when the target carries no verb prefix (a bare `/path` is a legal target).
 */
export function splitHttpMethodPrefix(target: string): { method?: string; path: string } {
  const m = HTTP_METHOD_PREFIX_PATTERN.exec(target.trim());
  if (!m) return { path: target.trim() };
  return { method: m[1]!.toUpperCase(), path: m[2]! };
}
