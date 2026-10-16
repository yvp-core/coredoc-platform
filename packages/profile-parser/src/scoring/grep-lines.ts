// =============================================================================
// Shared `grep -rEc` output reader for the per-language source-signal modules.
//
// Every `*-signals.ts` counts denominators the same way — run `grep -rEcH` over the profile's
// include roots, sum the per-file `path:count` lines, drop the ones under test/vendor/build
// noise — and each one owns a different noise pattern and a different error policy. Only the
// LINE READING (and the ERE literal escapes) is shared here; the patterns and the failure
// handling stay with each language.
//
// `-H` is load-bearing: GNU grep omits the `path:` prefix when the operand is a single
// explicit FILE (BSD grep prints it under -r regardless), and this parser drops any line
// without a `path:count` shape — a routes.rb-only target silently counted as 0 on Linux.
// =============================================================================

/**
 * Sum the per-file `path:count` lines of `grep -rEc`, dropping paths that match `noise`.
 *
 * The roots handed to grep are ABSOLUTE, so grep echoes absolute paths — and testing `noise`
 * against the whole line matches the CHECKOUT path, not the path inside the repo. A repo living
 * under `~/examples/api`, `/srv/vendor/api` or any dir named `tests`/`target`/`node_modules`
 * then drops EVERY line and the denominator comes back 0. A zero denominator is not a visible
 * failure: the scorer marks that category `not_applicable`, which reads as a PASS. So the noise
 * test runs on the path BELOW the matched root.
 *
 * The leading `/` of that relative path is kept, so a `/tests/`-style pattern still anchors on a
 * top-level directory. A root may be a directory (grep prints `<root>/<sub>:<n>`) or a single
 * file (`<root>:<n>`); both are stripped. `noise` must NOT carry the `g` flag — a global regex
 * keeps `lastIndex` between calls and would skip lines at random.
 */
export function sumGrepCounts(out: string, roots: string[], noise: RegExp): number {
  // Trailing slashes come from profile globs (`app/api/`); longest root first because include
  // roots nest (`crates` and `crates/api` can both be present).
  const normalized = [...new Set(roots.map((r) => r.replace(/\/+$/, '')))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let total = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const m = /:(\d+)$/.exec(line);
    if (!m) continue;
    const root = normalized.find((r) => line.startsWith(`${r}/`) || line.startsWith(`${r}:`));
    const rel = root ? line.slice(root.length) : line;
    if (!noise.test(rel)) total += Number(m[1]);
  }
  return total;
}

/** Escape ERE metacharacters in a literal (e.g. `models.Model` → `models\.Model`). */
export function escapeEre(s: string): string {
  return s.replace(/[.[\]{}()*+?^$|\\/]/g, '\\$&');
}

/** A case-insensitive ERE for an ASCII literal — POSIX ERE has no `(?i)` and `grep -E` has no `-i` here. */
export function caseInsensitiveEre(word: string): string {
  return [...word]
    .map((ch) => {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return lower === upper ? escapeEre(ch) : `[${lower}${upper}]`;
    })
    .join('');
}
