import { globMatches } from './glob.js';

/** The exact source set a language substrate intends to parse, plus files removed by its policy. */
export interface SourceFileScope {
  included: string[];
  /** Built-in defaults plus profile-authored exclusions, for reporting. */
  excluded: string[];
  /** Subset of excluded authored by the profile rather than the provider's built-in policy. */
  profileExcluded: string[];
}

/**
 * Apply one substrate's effective include/exclude policy to its language candidates.
 * Defaults and profile-authored exclusions stay separate so the parser and scorer share
 * one file set while the whole-repo audit can trust only the provider-owned defaults.
 */
export function applySourceFileScope(
  candidates: Iterable<string>,
  include: readonly string[],
  defaultExclude: readonly string[] = [],
  profileExclude: readonly string[] = [],
): SourceFileScope {
  const included: string[] = [];
  const excluded: string[] = [];
  const profileExcluded: string[] = [];
  const includeGlobs = [...include];
  const defaultExcludeGlobs = [...defaultExclude];
  const profileExcludeGlobs = [...profileExclude];
  for (const file of [...new Set(candidates)].sort()) {
    // Exclusions are intentional policy even outside a narrow include root. Recording
    // them first keeps built-in venv/vendor/test/build trees from looking like missing
    // language targets in the whole-repo audit.
    if (defaultExcludeGlobs.length > 0 && !globMatches(file, ['**/*'], defaultExcludeGlobs)) {
      excluded.push(file);
      continue;
    }
    if (profileExcludeGlobs.length > 0 && !globMatches(file, ['**/*'], profileExcludeGlobs)) {
      excluded.push(file);
      profileExcluded.push(file);
      continue;
    }
    if (globMatches(file, includeGlobs)) included.push(file);
  }
  return { included, excluded, profileExcluded };
}
