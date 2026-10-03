/**
 * Canonical JSON text for any intent value.
 *
 * Object keys are sorted at every depth so two equal values always produce
 * identical bytes regardless of construction order; ARRAY order is preserved
 * because arrays here are ordered data (flow steps, authored source lists)
 * rather than sets. `undefined` members are dropped. Used for content hashes
 * and idempotency fingerprints.
 */
export function canonicalIntentJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}
