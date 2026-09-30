// =============================================================================
// Rust source signals for the coverage scorer — the language-specific denominators the Rust
// LanguageProvider supplies to the shared score-core. The scoring math is score-core's
// scoreCategories.
//
// `queue` is deliberately OMITTED: contract handlers land there (see rust-entrypoints), and a
// pure-contract crate has no external denominator worth grepping. Omitting it makes the row
// self-relative — PASS whenever anything was emitted, `not_applicable` at zero — instead of a
// fabricated ratio. The same reasoning keeps the http denominator honestly ZERO on a
// contract-only crate, so it goes `not_applicable` rather than scoring as an HTTP FAIL.
// =============================================================================
import { enumerateRepoFiles } from '../facts/discovery/discover.js';
import { globMatches } from '../substrate/glob.js';
import { discoverRustFileScope } from '../substrate/rust/rust-cst.js';
import type { RustProfile } from '../types/rust-profile.js';
import { absoluteSourceFiles, grepCountInFiles } from './explicit-source-files.js';
import type { SourceSignals } from './score-core.js';

/** Escape ERE metacharacters in a literal (e.g. `sqlx::query` → `sqlx::query`). */
function escapeEre(s: string): string {
  return s.replace(/[.[\]{}()*+?^$|\\/]/g, '\\$&');
}

/** A case-insensitive ERE for an ASCII literal — POSIX ERE has no `(?i)` and `grep -E` has no `-i` here. */
function caseInsensitiveEre(word: string): string {
  return [...word]
    .map((ch) => {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return lower === upper ? escapeEre(ch) : `[${lower}${upper}]`;
    })
    .join('');
}

const DEFAULT_ROUTE_ATTRIBUTES = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'route'];
const DEFAULT_DERIVE_MACROS = ['DeriveEntityModel', 'Queryable', 'Insertable'];
const DEFAULT_SCHEMA_GLOBS = ['**/migrations/**/*.sql', '**/schema.sql', '**/db/**/*.sql'];

/**
 * Rust source-signal denominators from the repo on disk:
 *   - http: attribute route macros (`#[get("/x")]`) + router registration call sites
 *           (`.route(`, `.nest(`, `.mount(`, `.service(`, `.scope(`).
 *   - entities: `#[derive(...)]` lines naming a configured persistence derive, plus the
 *           schema sources (`table!` blocks and `CREATE TABLE` DDL in the schema globs).
 */
export function rustSourceSignals(
  repoRoot: string,
  profile: RustProfile,
  includedSourceFiles: readonly string[] = discoverRustFileScope(
    repoRoot,
    profile.substrate.include,
    profile.substrate.exclude ?? [],
    profile.substrate.excludeDefaults,
  ).included,
): SourceSignals {
  const sourceFiles = absoluteSourceFiles(repoRoot, includedSourceFiles);

  // http — the attribute form `#[get("…")]` and the builder form `.route("…", …)`.
  // UNION with the defaults, never replacement: the denominator is the honesty floor, and a
  // profile that tunes (or drops) these lists must not be able to shrink the signal below what
  // a bare profile would measure — that turns an under-emitting profile into a fake PASS.
  const routeAttrs = [...new Set([...DEFAULT_ROUTE_ATTRIBUTES, ...(profile.entrypoints?.http?.routeAttributes ?? [])])];
  const routerMethods = [
    ...new Set(['route', 'nest', 'mount', 'service', 'scope', ...(profile.entrypoints?.http?.routerMethods ?? [])]),
  ];
  const attrAlt = routeAttrs.map(escapeEre).join('|');
  const methodAlt = routerMethods.map(escapeEre).join('|');
  let http =
    grepCountInFiles(sourceFiles, `#\\[(${attrAlt})\\(`, 'rust route signals') +
    grepCountInFiles(sourceFiles, `\\.(${methodAlt})\\(["']`, 'rust route signals');

  // Custom registration call shapes (`r.insert(Method::GET, path, handler)`). A registration
  // callee like `insert` is also every map's method name, so the callee alone is a useless
  // denominator — the observable that identifies a VERB-FIRST registration is the verb argument
  // itself: `.insert(Method::GET, …` on one line, or rustfmt's multiline form where the verb is
  // a lone `Method::GET,` argument line. Path-first shapes count like the builder form.
  const registrationShapes = profile.entrypoints?.http?.registrationCalls ?? [];
  const verbAlt = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
  const verbFirst = registrationShapes.filter((r) => r.methodArg !== undefined);
  if (verbFirst.length > 0) {
    const calleeAlt = [...new Set(verbFirst.map((r) => r.callee))].map(escapeEre).join('|');
    http +=
      grepCountInFiles(
        sourceFiles,
        `\\.(${calleeAlt})\\([[:space:]]*&?[A-Za-z_]+::(${verbAlt})`,
        'rust route signals',
      ) +
      grepCountInFiles(
        sourceFiles,
        `^[[:space:]]*[A-Za-z_]+::(${verbAlt})[[:space:]]*,[[:space:]]*$`,
        'rust route signals',
      );
  }
  const pathFirst = registrationShapes.filter((r) => r.methodArg === undefined);
  if (pathFirst.length > 0) {
    const calleeAlt = [...new Set(pathFirst.map((r) => r.callee))].map(escapeEre).join('|');
    http += grepCountInFiles(sourceFiles, `\\.(${calleeAlt})\\(["']`, 'rust route signals');
  }

  // entities — derive-marked structs plus the two plain-text schema sources.
  const derives = profile.entities?.deriveMacros ?? DEFAULT_DERIVE_MACROS;
  const deriveAlt = derives.map(escapeEre).join('|');
  // The derive name must sit right after `derive(` OR after a `,`/whitespace boundary, so a
  // configured `Queryable` matches `#[derive(Debug, Queryable)]` but not `MyQueryable`.
  const deriveEre = `derive\\(([^)]*[[:space:](,])?(${deriveAlt})`;
  const schemaGlobs = profile.entities?.schemaFileGlobs ?? DEFAULT_SCHEMA_GLOBS;
  const createTable = `${caseInsensitiveEre('create')}[[:space:]]+${caseInsensitiveEre('table')}`;
  const schemaFiles = absoluteSourceFiles(
    repoRoot,
    enumerateRepoFiles(repoRoot).filter((file) => file.endsWith('.sql') && globMatches(file, schemaGlobs)),
  );
  const ddl = grepCountInFiles(schemaFiles, createTable, 'rust schema signals');
  // `table!` is written both bare and path-qualified (`diesel::table! {` is what diesel-cli
  // generates today), so the boundary must allow the `::` prefix.
  const tableMacroEre = '(^|[^[:alnum:]_])table![[:space:]]*\\{';
  const entities =
    grepCountInFiles(sourceFiles, deriveEre, 'rust entity signals') +
    grepCountInFiles(sourceFiles, tableMacroEre, 'rust entity signals') +
    ddl;

  return { http, entities };
}
