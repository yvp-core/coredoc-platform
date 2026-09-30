/**
 * The one source-discovery policy every bespoke substrate applies: the gitignore-honouring repo
 * walk, narrowed to the substrate's own file extensions, then the shared include/exclude policy.
 *
 * Parameterised by extensions and globs only — nothing here knows which grammar owns them.
 */
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import { type SourceFileScope, applySourceFileScope } from '../source-file-scope.js';

export interface FileScopeSpec {
  /** The file suffixes this substrate claims. A repo file outside them is never a candidate. */
  extensions: readonly string[];
  /** Include globs applied when the profile authored none. */
  defaultInclude: readonly string[];
  /** Built-in skips (vendor/build/test trees), which `excludeDefaults: false` opts out of. */
  defaultExclude?: readonly string[];
}

export function makeFileScopeDiscoverer(
  spec: FileScopeSpec,
): (root: string, include: string[], exclude?: string[], excludeDefaults?: boolean) => SourceFileScope {
  return (root, include, exclude, excludeDefaults) =>
    applySourceFileScope(
      enumerateRepoFiles(root).filter((rel) => spec.extensions.some((ext) => rel.endsWith(ext))),
      include.length > 0 ? include : spec.defaultInclude,
      excludeDefaults === false ? [] : (spec.defaultExclude ?? []),
      exclude ?? [],
    );
}
