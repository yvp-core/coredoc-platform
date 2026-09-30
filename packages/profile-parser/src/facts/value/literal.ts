/** True if expr is a plain string literal (single/double/backtick, NO template interpolation). */
export function isStringLiteral(expr: string): boolean {
  const s = expr.trim();
  if (s.length < 2) return false;
  const q = s[0];
  if (q !== "'" && q !== '"' && q !== '`') return false;
  if (s[s.length - 1] !== q) return false;
  if (q === '`' && s.includes('${')) return false; // interpolated template — not a static literal
  return true;
}

/** Strip surrounding quotes from a string literal. */
export function unquoteLiteral(expr: string): string {
  return expr.trim().replace(/^['"`]|['"`]$/g, '');
}
