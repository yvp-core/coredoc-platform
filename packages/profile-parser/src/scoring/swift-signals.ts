// =============================================================================
// Swift source signals for the coverage scorer — the language-specific denominators the
// Swift LanguageProvider supplies to the shared score-core. Modeled on ruby-signals.ts
// (minimal), NOT ts-signals.ts. A mobile app is a CONSUMER, not a server, so `http` is 0
// (→ not_applicable → PASS); `queue`/`dbOperations` are omitted → self-relative.
// =============================================================================
import { discoverSwiftFileScope } from '../substrate/swift/swift-parser.js';
import { absoluteSourceFiles, grepCountInFiles } from './explicit-source-files.js';
import type { SourceSignals } from './score-core.js';
import type { SwiftProfile } from '../types/swift-profile.js';
import { escapeEre } from './grep-lines.js';

/**
 * Swift source-signal denominators from the repo on disk:
 *   - entities: declarations of a persisted-model base class (`class X: … Object`), an
 *     order-of-magnitude signal for the Realm/ORM model count.
 *   - http: 0 — a mobile client exposes no HTTP entrypoints, so the scorer marks it
 *     `not_applicable` → PASS (a number is still required by the SourceSignals contract).
 * `queue` and `dbOperations` are omitted → self-relative (PASS-if-emitted, N/A at 0).
 */
export function swiftSourceSignals(
  repoRoot: string,
  profile: SwiftProfile,
  includedSourceFiles: readonly string[] = discoverSwiftFileScope(
    repoRoot,
    profile.substrate.include,
    profile.substrate.exclude ?? [],
  ).included,
): SourceSignals {
  const baseClasses = profile.entities?.baseClasses ?? ['Object'];
  const alt = baseClasses.map(escapeEre).join('|');
  const sourceFiles = absoluteSourceFiles(repoRoot, includedSourceFiles);
  // A class whose inheritance list names a base as a WHOLE WORD — the `[^A-Za-z0-9_]` guards
  // stop `Object` from matching inside `NSObject` / `NSManagedObject`. `[^{]*` keeps the match
  // on the inheritance clause (before the body). Scoped to the parsed include roots.
  const entities = grepCountInFiles(
    sourceFiles,
    `class[[:space:]]+[A-Za-z0-9_]+[[:space:]]*:[^{]*[^A-Za-z0-9_](${alt})([^A-Za-z0-9_]|$)`,
    'swift entity signals',
  );
  return { http: 0, entities };
}
