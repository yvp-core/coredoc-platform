/**
 * Default-ignored directories for file discovery — the single source of truth shared by the git
 * enumeration and the filesystem-walk fallback.
 *
 * These are well-known vendored / build / VCS directories that no extraction profile would ever
 * scope into. They are pruned **even when committed/tracked** in git: a Yarn-berry zero-installs
 * blob (`.yarn/releases/yarn-*.cjs`) or a vendored `node_modules` is a *tracked* file, so a plain
 * `git ls-files` would include it and the engine would parse + index thousands of nodes only to
 * drop them in the post-hoc scope prune. Pruning here means they are never parsed at all.
 *
 * Conservative by design — only directories that are unambiguously not source. Anything that could
 * legitimately hold source (`lib`, `src`, `app`, `out` used as a source root, …) is NOT listed; the
 * profile's own include/exclude globs handle scoping beyond this floor.
 */
export const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // package managers / vendored deps
  'node_modules',
  '.yarn',
  '.pnp',
  '.pnpm-store',
  // Coredoc's own repo-local artifacts (intent overlay) — never source (BR-10/AC-13)
  '.coredoc',
  // VCS
  '.git',
  '.worktrees',
  '.hg',
  '.svn',
  // build / dist output
  'dist',
  'build',
  'coverage',
  '.nyc_output',
  // framework build dirs
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.vercel',
  // tooling caches
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
]);

/**
 * True when any segment of a repo-relative (forward-slash) path is a default-ignored directory —
 * so `.yarn/releases/yarn-4.cjs` and `packages/x/node_modules/y.js` are both ignored.
 */
export function isDefaultIgnored(relPath: string): boolean {
  for (const segment of relPath.split('/')) {
    if (DEFAULT_IGNORE_DIRS.has(segment)) return true;
  }
  return false;
}
