// =============================================================================
// Ruby source signals for the coverage scorer — the language-specific denominators
// the Ruby LanguageProvider supplies to the shared score-core. The scoring math is
// score-core's scoreCategories.
// =============================================================================
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverRubyFileScope } from '../substrate/ruby/ruby-parser.js';
import { absoluteSourceFiles, grepCountInFiles } from './explicit-source-files.js';
import type { SourceSignals } from './score-core.js';
import type { RubyProfile } from '../types/ruby-profile.js';

/**
 * Ruby source-signal denominators from the repo on disk:
 *   - entities: `create_table` blocks in the declared schema (precise).
 *   - http: route-DSL lines (`resources`/`resource`/verb calls) in routes.rb + the Grape
 *           api dir — an order-of-magnitude signal (lenient by design).
 * `queue` is omitted → the scorer treats it self-relative (PASS when emitted, N/A at 0).
 */
export function rubySourceSignals(
  repoRoot: string,
  profile: RubyProfile,
  includedSourceFiles: readonly string[] = discoverRubyFileScope(
    repoRoot,
    profile.substrate.include,
    profile.substrate.exclude ?? [],
    profile.substrate.excludeDefaults,
  ).included,
): SourceSignals {
  const schemaPath = profile.entities?.schemaPath ?? 'db/schema.rb';
  const schemaAbs = join(repoRoot, schemaPath);
  const entities = existsSync(schemaAbs)
    ? (readFileSync(schemaAbs, 'utf8').match(/^\s*create_table\b/gm)?.length ?? 0)
    : 0;

  const routeFile = profile.entrypoints?.railsRoutes?.routeFile ?? 'config/routes.rb';
  const apiPath = profile.entrypoints?.grape?.apiPath ?? 'app/api/';
  const routeFiles = new Set<string>();
  if (profile.entrypoints?.railsRoutes?.enabled ?? true) routeFiles.add(routeFile);
  if (profile.entrypoints?.grape?.enabled ?? true) {
    for (const file of includedSourceFiles) {
      if (file.startsWith(apiPath) || file.endsWith(routeFile)) routeFiles.add(file);
    }
  }
  const http = grepCountInFiles(
    absoluteSourceFiles(repoRoot, [...routeFiles]),
    '(\\bresources\\b|\\bresource\\b|^[[:space:]]*(get|post|put|patch|delete)[[:space:]])',
    'ruby route signals',
  );

  return { http, entities };
}
