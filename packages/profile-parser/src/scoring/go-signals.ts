// =============================================================================
// Go source signals for the coverage scorer — the language-specific denominators the Go
// LanguageProvider supplies to the shared score-core. The scoring math is score-core's
// scoreCategories.
//
// `queue` and `cli` are deliberately OMITTED. Go's queue surface is a bare `for msg := range ch`
// / a consumer library's callback, and its CLI surface is a `cobra.Command` composite literal
// whose `Use:` field is the command name — neither has a call-shape a grep can count without
// inventing a number. Omitting a signal makes that row SELF-RELATIVE (PASS whenever anything was
// emitted, `not_applicable` at zero) instead of a fabricated ratio, which is the honest answer
// when the denominator is unknowable. Same reasoning as rust-signals' omission of `queue`.
// =============================================================================
import type { ParsedRepo } from '@coredoc/core/types';
import { enumerateRepoFiles } from '../facts/discovery/discover.js';
import { discoverGoFileScope } from '../substrate/go/go-cst.js';
import { globMatches } from '../substrate/glob.js';
import type { GoProfile } from '../types/go-profile.js';
import { absoluteSourceFiles, grepCountInFiles, grepMatchingFiles } from './explicit-source-files.js';
import type { SourceSignals } from './score-core.js';

/** Escape ERE metacharacters in a literal. */
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

/**
 * Router registration verbs, in BOTH ecosystem spellings: chi / gorilla / stdlib use
 * `r.Get("/p", h)`, gin / echo use `r.GET("/p", h)`. `Handle`/`HandleFunc`/`Method`/`MethodFunc`
 * cover `net/http`'s ServeMux and chi's explicit-verb form.
 */
const DEFAULT_ROUTER_METHODS = [
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Head',
  'Options',
  'Connect',
  'Trace',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'Handle',
  'HandleFunc',
  'Method',
  'MethodFunc',
];

/** Sub-router builders that contribute a base path: chi `Route`/`Mount`, gin/echo `Group`, gorilla `PathPrefix`. */
const DEFAULT_MOUNT_METHODS = ['Route', 'Mount', 'Group', 'PathPrefix'];

const DEFAULT_STRUCT_TAGS = ['db', 'gorm'];
const DEFAULT_SCHEMA_GLOBS = ['**/migrations/**/*.sql', '**/schema.sql', '**/db/**/*.sql'];

/**
 * Go source-signal denominators from the repo on disk:
 *   - http: router registration call sites (`.Get("/…`, `.HandleFunc("/…`) plus the sub-router
 *           builders that carry a base path (`.Route("/…`, `.Group("/…`).
 *   - entities: `CREATE TABLE` DDL in the schema globs, plus the struct declarations in files
 *           that carry persistence evidence (a configured struct tag, an embedded `gorm.Model`,
 *           or a `TableName()` method).
 */
export function goSourceSignals(
  repoRoot: string,
  profile: GoProfile,
  parsed?: ParsedRepo,
  includedSourceFiles: readonly string[] = discoverGoFileScope(
    repoRoot,
    profile.substrate.include,
    profile.substrate.exclude ?? [],
    profile.substrate.excludeDefaults,
  ).included,
): SourceSignals {
  const sourceFiles = absoluteSourceFiles(repoRoot, includedSourceFiles);

  // http — ONE alternation over the verb and mount builders rather than two greps: `grep -c`
  // counts LINES, so a compact `r.Route("/api", func(r chi.Router) { r.Get("/x", h) })` counts
  // once here and twice across two passes. Under-counting a denominator is the safe direction.
  //
  // The `["`]/` tail is load-bearing: the registration argument is a PATH literal. Without it
  // `\.Get\(["`]` matches `r.Header.Get("Authorization")` — which appears in essentially every
  // Go HTTP handler — and the http denominator inflates by an order of magnitude, turning a
  // correctly-extracted repo into a permanent FAIL.
  const routerMethods = profile.entrypoints?.http?.routerMethods ?? DEFAULT_ROUTER_METHODS;
  const mountMethods = profile.entrypoints?.http?.mountMethods ?? DEFAULT_MOUNT_METHODS;
  const routeAlt = [...new Set([...routerMethods, ...mountMethods])].map(escapeEre).join('|');
  const http = grepCountInFiles(sourceFiles, `\\.(${routeAlt})\\(["\`]/`, 'go source signals');

  // entities — the two plain-text schema sources plus the tagged-struct count.
  const schemaGlobs = profile.entities?.schemaFileGlobs ?? DEFAULT_SCHEMA_GLOBS;
  const createTable = `${caseInsensitiveEre('create')}[[:space:]]+${caseInsensitiveEre('table')}`;
  const schemaFiles = absoluteSourceFiles(
    repoRoot,
    enumerateRepoFiles(repoRoot).filter((file) => file.endsWith('.sql') && globMatches(file, schemaGlobs)),
  );
  const ddl = grepCountInFiles(schemaFiles, createTable, 'go schema signals');

  // Go has NO per-struct persistence marker the way Rust has `#[derive(Queryable)]`: the signal
  // lives on the FIELDS (`db:"id"`), and the numerator counts TABLES. Counting tagged fields
  // would put columns over tables and FAIL every correctly-extracted repo. So the count is taken
  // in two steps — find the files carrying persistence evidence, then count the STRUCT
  // declarations inside them. It over-counts a DTO that shares a file with a model; that is what
  // an order-of-magnitude denominator is for.
  const tagKeys = profile.entities?.structTags ?? DEFAULT_STRUCT_TAGS;
  const tagAlt = tagKeys.map(escapeEre).join('|');
  // A tag pair inside a tag literal (`\`db:"id"\``), an embedded `gorm.Model`, or a `TableName()`
  // method — the three ways a Go struct says "I am a table".
  const evidenceEre = `((${tagAlt}):"|gorm\\.Model|TableName\\(\\)[[:space:]]+string)`;
  // Matches both the plain `type User struct {` and the grouped `type ( User struct { … } )` form.
  const structDeclEre = '(^|[^[:alnum:]_])[[:alnum:]_]+[[:space:]]+struct[[:space:]]*\\{';
  const entityFiles = grepMatchingFiles(sourceFiles, evidenceEre, 'go entity signals');
  const entities = ddl + grepCountInFiles(entityFiles, structDeclEre, 'go entity signals');

  return { http, entities, dbOperationsNote: dbOperationsBasis(parsed) };
}

/**
 * Disclosure for the `dbOperations` row, which otherwise reports a number that cannot fail.
 *
 * With no `signals.dbOperations` denominator, score-core scores db-ops against the EMITTED
 * ENTITY count and caps the ratio at 1 — and a Go repo using sqlc emits far more operations than
 * tables (1889 against 94 on the validation target), so the row reads a permanent 100% PASS no
 * matter how badly attribution is working. Supplying the table count as the denominator does not
 * help: the ratio still caps.
 *
 * What is actually diagnostic is the SHARE OF ENTITIES that carry at least one operation, so
 * that goes in the basis column. A collapse there is the signal that table attribution broke,
 * and it is visible on the scorecard rather than only in a hand-written query afterwards.
 *
 * A share below 100% is normal, not a defect: a table may be written only by migrations or by a
 * background job, and a table deleted inside a data-modifying CTE (`d AS (DELETE FROM t …)`) is
 * attributed to the statement's outer table — a documented `parseSqlOp` boundary.
 */
function dbOperationsBasis(parsed: ParsedRepo | undefined): string | undefined {
  if (!parsed || parsed.entities.length === 0) return undefined;
  const entityIds = new Set(parsed.entities.map((e) => e.id));
  const operated = new Set(
    parsed.dbOperations.map((o) => o.entityId).filter((id): id is string => !!id && entityIds.has(id)),
  );
  const pct = Math.round((operated.size / entityIds.size) * 100);
  const unlinked = parsed.dbOperations.filter((o) => !o.entityId).length;
  return (
    `entity-coverage basis: ${operated.size}/${entityIds.size} entities carry a db-op (${pct}%), ` +
    `${parsed.dbOperations.length} ops emitted, ${unlinked} unlinked to an entity`
  );
}
