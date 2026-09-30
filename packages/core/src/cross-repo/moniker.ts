/**
 * Normalize a raw SCIP moniker descriptor tail into the semantic suffix join key.
 *
 * The descriptor passed in is the SCIP `descriptors` field (everything after the
 * package version), as decoded by `parseMoniker` in profile-parser
 * (`src/facts/scip/decode.ts`). It has the shape:
 *
 *     <file-namespace> <semantic-suffix>
 *
 * where the file-namespace is a path of segments ending in a backtick-quoted file
 * token, e.g. ``src/`index.d.ts`/`` or ``src/lib/clients/`calculations.ts`/``, and
 * the semantic suffix is the `Class#member` / `term` path the consumer joins on,
 * e.g. `CalculationsClient#dailySummaries().`.
 *
 * Two skews must collapse to one key:
 *   - version skew (`0.208.0` vs `0.1.0`) — already excluded by the caller.
 *   - file-namespace skew (`index.d.ts` barrel vs `src/lib/...` source) — dropped here.
 *
 * We drop the entire file-namespace prefix (everything up to and including the LAST
 * backtick-quoted segment and its trailing `/`) and the trailing call/term arg
 * suffix (`().` for methods, `.` for terms, `#` left dangling for bare types), then
 * return the semantic suffix. A backtick-wrapped private member name (`` `#refresh` ``)
 * inside the suffix is preserved.
 */
export function normalizeMonikerDescriptor(descriptor: string): string {
  if (descriptor === '') return '';

  // Drop the file-namespace prefix: find the last backtick-quoted file token and
  // cut everything up to and including the slash that follows it. A backtick-quoted
  // file token is ``...`name.ext`/``. We match the final such token so nested
  // `src/lib/...` paths collapse to the same key as the `index.d.ts` barrel.
  let suffix = descriptor;
  const fileToken = /`[^`]*`\//g;
  let lastEnd = -1;
  for (let m = fileToken.exec(descriptor); m !== null; m = fileToken.exec(descriptor)) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd >= 0) {
    suffix = descriptor.slice(lastEnd);
  }

  // Drop trailing arg/term scaffolding: trailing `.` (term/method separator) first,
  // then `()` (call sigil), then any remaining trailing `.` or `#` (bare-type
  // separator). Order matters — the raw descriptor ends with `().` (call + term dot),
  // so we must strip the dot before the parens. Backtick-wrapped private names inside
  // the suffix (`` Client#`#refresh` ``) are left intact — only the unwrapped
  // trailing scaffolding is removed.
  suffix = suffix
    .replace(/\.$/, '')
    .replace(/\(\)$/, '')
    .replace(/[.#]+$/, '');

  return suffix;
}
