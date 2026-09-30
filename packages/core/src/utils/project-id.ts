/**
 * Project ID helpers.
 *
 * `id` is a stable, slugified identifier used as a folder name on disk for
 * a project (workspace). It is generated once at project creation and never
 * changes when the user renames the project's display `name`.
 */

/**
 * Convert a project display name into a folder-safe slug.
 *
 * - Lowercases
 * - Strips diacritics
 * - Replaces non-alphanumeric runs with single dashes
 * - Trims leading/trailing dashes
 * - Falls back to `"project"` if the result is empty
 */
export function slugifyProjectName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized.length > 0 ? normalized : 'project';
}

/**
 * Pick a unique project id for a project with the given display `name`,
 * avoiding collisions with `takenIds`. The returned id is NOT appended to
 * `takenIds` — the caller is responsible for adding it before assigning
 * another.
 *
 * Comparison is case-insensitive: `Test` and `test` collide.
 */
export function assignProjectId(name: string, takenIds: Set<string>): string {
  const base = slugifyProjectName(name);
  const lowercaseTaken = new Set(Array.from(takenIds, (id) => id.toLowerCase()));

  if (!lowercaseTaken.has(base)) {
    return base;
  }

  let suffix = 2;
  while (lowercaseTaken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}
