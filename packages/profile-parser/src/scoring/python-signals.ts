// =============================================================================
// Python source signals for the coverage scorer — the language-specific denominators
// the Python LanguageProvider supplies to the shared score-core. The scoring math is
// score-core's scoreCategories.
// =============================================================================
import { discoverPythonFileScope } from '../substrate/python/python-cst.js';
import { globMatches } from '../substrate/glob.js';
import { absoluteSourceFiles, grepCountInFiles } from './explicit-source-files.js';
import type { SourceSignals } from './score-core.js';
import type { PythonProfile } from '../types/python-profile.js';

/** Escape ERE metacharacters in a literal (e.g. `models.Model` → `models\.Model`). */
function escapeEre(s: string): string {
  return s.replace(/[.[\]{}()*+?^$|\\/]/g, '\\$&');
}

/**
 * Python source-signal denominators from the repo on disk:
 *   - http: Django/DRF route-table lines (`path(`/`re_path(`/`router.register(`) across the
 *           profile's route-file globs (default `**\/urls.py`) — an order-of-magnitude signal.
 *   - entities: model-class declarations (`class X(...models.Model)`, base classes
 *           profile-configurable) across the include roots.
 * `queue` is added in a later step; omitting it → the scorer treats it self-relative
 * (PASS when emitted, N/A at 0).
 */
export function pythonSourceSignals(
  repoRoot: string,
  profile: PythonProfile,
  includedSourceFiles: readonly string[] = discoverPythonFileScope(
    repoRoot,
    profile.substrate.include,
    profile.substrate.exclude ?? [],
    profile.substrate.excludeDefaults,
  ).included,
): SourceSignals {
  const sourceFiles = absoluteSourceFiles(repoRoot, includedSourceFiles);

  // HTTP is counted only in the exact route files the extractor can read.
  const routeGlobs = profile.entrypoints?.djangoRoutes?.routeFileGlobs ?? ['**/urls.py'];
  const httpEre = '(^|[^[:alnum:]_])(path\\(|re_path\\(|router\\.register\\()';
  const routeFiles = absoluteSourceFiles(
    repoRoot,
    includedSourceFiles.filter((file) => globMatches(file, routeGlobs)),
  );
  const http = grepCountInFiles(routeFiles, httpEre, 'python route signals');

  // entities — model classes whose base list contains a configured base (default models.Model).
  const baseClasses = profile.entities?.baseClasses ?? ['models.Model'];
  const baseAlt = baseClasses.map(escapeEre).join('|');
  // The base name must sit right after the class `(` OR be preceded by a boundary char (`,`/`.`/
  // whitespace) — so a configured `UUIDModel` matches `class Foo(UUIDModel)` / `(a.UUIDModel)` /
  // `(Mixin, UUIDModel)` but NOT the substring inside `class Foo(MyUUIDModel)` (over-count). The
  // boundary group is OPTIONAL so the base directly after `(` still matches. (Multi-line base lists
  // on a separate line from `class …(` remain a documented under-count — an order-of-magnitude denominator.)
  const entitiesEre = `class [[:alnum:]_]+\\(([^)]*[[:space:](,.])?(${baseAlt})`;
  const entities = grepCountInFiles(sourceFiles, entitiesEre, 'python entity signals');

  return { http, entities };
}
