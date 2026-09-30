/**
 * Enum cross-reference for entity columns.
 *
 * Entity columns whose type is an enum carry the enum NAME in `type.text`
 * (e.g. `status: WebhookStatus`). These helpers resolve that name to the enum's
 * members so the column listing can inline the value set (`status: WebhookStatus
 * {active, deactivated, paused}`) — the difference between "there's an enum" and
 * "here are the valid values" (the shifts:published-vs-SHIFTS_PUBLISHED bug).
 *
 * Resolution is same-repo and fail-soft: an enum imported from a shared package
 * (a different repo than the entity) won't resolve and the column renders exactly
 * as before. Broadening the lookup cross-repo is deliberately avoided — common
 * names like `Status` would collide.
 */

import type { IGraphReadRepository, EntityInfo } from '@coredoc/db';
import type { EnumMember } from '@coredoc/core/types';

/** Inline at most this many values per column to keep a column line scannable. */
const MAX_INLINE_ENUM_VALUES = 12;

/**
 * Extract a single enum identifier from a column's type text, stripping a
 * trailing `[]` and ` | null`/` | undefined`. Returns null for anything that
 * isn't a single PascalCase identifier (unions of multiple types, generics,
 * primitives) — those aren't a single resolvable enum.
 */
export function enumBaseId(typeText: string | undefined): string | null {
  if (!typeText) return null;
  const cleaned = typeText
    .trim()
    .replace(/\[\]$/, '')
    .replace(/\s*\|\s*(?:null|undefined)\b/g, '')
    .trim();
  return /^[A-Z][A-Za-z0-9_$]*$/.test(cleaned) ? cleaned : null;
}

/**
 * Compact `{value, value, +N more}` rendering of an enum's values. `limit` caps
 * the shown values (default {@link MAX_INLINE_ENUM_VALUES}); pass `Infinity` for
 * the full set (detailLevel:full). Single source of truth for enum-value display
 * in both the column suffix and the `explain` enum block. Empty string for no
 * members.
 */
export function enumValuesList(members: EnumMember[] | undefined, limit: number = MAX_INLINE_ENUM_VALUES): string {
  if (!members || members.length === 0) return '';
  const values = members.map((m) => (m.value !== undefined ? String(m.value) : m.name));
  const shown = values.slice(0, limit);
  const more = values.length > shown.length ? `, +${values.length - shown.length} more` : '';
  return `{${shown.join(', ')}${more}}`;
}

/** Leading-space variant for appending after a column's type, e.g. ` {active, …}`. */
export function enumValuesSuffix(members: EnumMember[] | undefined): string {
  const list = enumValuesList(members);
  return list ? ` ${list}` : '';
}

/**
 * Resolve the distinct enum types referenced by a table's columns to their
 * members. Same-repo only (`repoHashes`), fail-soft (unresolved names are simply
 * absent from the map). Pass the union of all columns' fields for a whole-schema
 * dump; dedupes by enum name internally.
 */
export async function resolveFieldEnums(
  fields: EntityInfo['fields'],
  repo: IGraphReadRepository,
  repoHashes: string[],
): Promise<Map<string, EnumMember[]>> {
  const resolved = new Map<string, EnumMember[]>();
  if (!fields || fields.length === 0) return resolved;

  const names = new Set<string>();
  for (const f of fields) {
    const id = enumBaseId(f.type?.text);
    if (id) names.add(id);
  }
  for (const name of names) {
    const en = await repo.findEnum(name, repoHashes);
    if (en?.members && en.members.length > 0) resolved.set(name, en.members);
  }
  return resolved;
}
