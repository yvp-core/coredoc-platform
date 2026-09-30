/**
 * Locale-independent UTF-16 code-unit ordering.
 *
 * `String.prototype.localeCompare` is ICU- and locale-dependent: `'acme-actions'` and
 * `'acmeactions'` order differently under different collations, and Node builds differ in which
 * ICU data they ship. Anything whose output is compared, hashed, or persisted — canonical JSON,
 * cohort/manifest identity, graph row order, report provenance strings — must sort with this
 * instead, or the same inputs produce different bytes on two machines.
 *
 * Canonical HERE, in the shared foundation every package already depends on, because a
 * determinism primitive that exists in eight copies is a primitive that will silently drift.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** `compareCodeUnits` applied to a named field — the common `sort(byCodeUnits('id'))` shape. */
export function byCodeUnits<T>(key: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => compareCodeUnits(key(left), key(right));
}
