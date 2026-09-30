/**
 * Shared regex helpers used by both the SubstrateProfileEngine and the
 * TreeSitterScipSubstrate.
 */

/**
 * Escape a literal string for safe interpolation into a RegExp pattern.
 *
 * Every caller interpolates PROFILE-AUTHORED text (an object key, a container name, an
 * `unwrapCalls` entry). Raw, that text is read as pattern syntax: `$topic` becomes an end-anchor
 * and silently never matches, `a|b` matches a bare `b`, and an unbalanced `topic(` throws
 * SyntaxError and aborts the whole extraction.
 */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function regexFromSource(src: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/.exec(src);
  if (m) return new RegExp(m[1], m[2]);
  return new RegExp(src);
}

export function requirePathToRel(t: string, prefix: string): string | undefined {
  const m = t.match(/require\(["']([^"']+)["']\)/);
  if (!m) return undefined;
  let p = m[1];
  if (!p.startsWith(prefix)) return undefined;
  if (!p.endsWith('.js')) p = `${p}.js`;
  return p;
}
