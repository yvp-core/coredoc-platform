// =============================================================================
// GoProfile — declarative per-repo config for the Go substrate.
//
// Shaped like RustProfile, for the same reason: the framework conventions
// (chi/gin/echo/gorilla/huma routing, cobra commands, gRPC service registration,
// sqlc / database/sql / sqlx / GORM data access, net/http + resty egress) live in
// generic code under substrate/go/, and this profile only TUNES them per repo.
// No client-specific strings belong in shared code — only in a repo's own profile.ts.
// The `'go'` literal is the registry dispatch discriminant.
//
// Every knob is optional with a code-level default, so a bare
// `{ parserId, substrate: { language: 'go', include: ['**\/*.go'] } }` profile already
// extracts modules, files, types, entrypoints, entities, db-ops, egress and Tier-B calls.
// Absence of a key means "use the defaults", NEVER "opt out".
// =============================================================================
import type { IndexPolicy } from '../facts/scip/index-host.js';
import type { BaseProfile } from './profile-base.js';

export interface GoProfile extends BaseProfile {
  parserId: string;
  substrate: {
    language: 'go';
    /** Optional compiler-backed calls; defaults to enhanced with basic fallback. */
    analysis?: IndexPolicy;
    include: string[];
    exclude?: string[];
    /**
     * Built-in default excludes SHIP in code (`vendor/`, `testdata/`, `*_test.go`,
     * `*.pb.go` — which also covers `*_grpc.pb.go`); the profile's `exclude` EXTENDS
     * them. Set `excludeDefaults: false` to opt out of the built-ins entirely.
     * Default: true. (`vendor/` is NOT in the shared enumerator's ignore floor, so
     * this is the only thing keeping a vendored dependency tree out of scope.)
     */
    excludeDefaults?: boolean;
  };
  /** Persistence entities. Tag keys are CONFIGURABLE — never a hardcoded client name. */
  entities?: {
    /**
     * Struct-tag keys that mark a struct as persisted. Default: ['db', 'gorm'].
     * `json` is deliberately NOT a default: a json-tagged struct is an API DTO
     * (`LoginRequest`, `UserResponse`) far more often than a table, so defaulting it on
     * emits entities no db-op ever touches — the "entities but 0 dbOperations" red flag.
     * A sqlc repo with `emit_json_tags` and no DDL in scope opts in with
     * `structTags: ['db', 'gorm', 'json']`.
     */
    structTags?: string[];
    /**
     * ORM tag stamped on every entity. Default: inferred per source — 'sql' for a
     * DDL-derived entity, 'gorm' when the struct shows a GORM signal (embedded
     * `gorm.Model`, a `gorm:` tag, or a `TableName()` method), else 'go'. A `db:` tag
     * alone names no library (sqlx, pgx/scany and sqlc all emit it), so the honest
     * default label is the language. Setting this overrides every entity's label.
     */
    orm?: string;
    /**
     * Where plain-SQL DDL lives. `CREATE TABLE` in a goose / golang-migrate / sqlc
     * migration is the highest-fidelity entity source in Go, and its table names are the
     * same ones read out of the raw SQL at the db-op sites, so `entityId` resolution
     * LANDS instead of dangling. Default (depth-agnostic, because a multi-module Go repo
     * keeps migrations under the owning module):
     * ['**\/migrations/**\/*.sql', '**\/schema.sql', '**\/db/**\/*.sql'].
     */
    schemaFileGlobs?: string[];
  };
  dbOperations?: {
    /**
     * Additional query verbs that count as a DB op. Default: [] — nothing beyond the
     * built-ins. An entry joins BOTH built-in sets: it becomes a raw-SQL executor (its
     * string argument is read through `parseSqlOp`, so the operation still comes from the
     * SQL and never from the verb) AND, unless it is already a known ORM verb, an ORM verb
     * classified 'query' with the table gate still applied.
     * Built-in raw-SQL executors: the `database/sql` + pgx set (Exec/Query/QueryRow/Prepare
     * and their `…Context` forms), the sqlx set (Get/Select/Queryx/QueryRowx/NamedExec/
     * NamedQuery/MustExec and their `…Context` forms) and GORM's `Raw`.
     * Built-in GORM verbs (chain-TERMINAL only, so a builder chain is never double-counted):
     * read — Find/FindInBatches/First/Last/Take/Count/Pluck/Scan; create —
     * Create/CreateInBatches/FirstOrCreate; update — Save/Update/Updates/UpdateColumn/
     * UpdateColumns; delete — Delete.
     */
    methods?: string[];
    /**
     * Where sqlc's annotated query files live — the `-- name: GetUser :one` directive is the
     * only marker they carry. Default (depth-agnostic, same multi-module reason as the
     * schema globs): ['**\/queries/**\/*.sql', '**\/query/**\/*.sql'].
     */
    sqlcQueryGlobs?: string[];
  };
  entrypoints?: {
    /** chi / gin / echo / gorilla / `net/http` route registration. */
    http?: {
      /**
       * Router methods that REGISTER a handler. Default (both ecosystem spellings, because chi /
       * gorilla / stdlib write `r.Get(…)` and gin / echo write `r.GET(…)`):
       * ['Get','Post','Put','Patch','Delete','Head','Options','Connect','Trace',
       *  'GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS',
       *  'Handle','HandleFunc','Method','MethodFunc'].
       */
      routerMethods?: string[];
      /**
       * Sub-router builders that contribute a BASE PATH the nested routes are joined onto —
       * chi's `Route`/`Mount`, gin's and echo's `Group`, gorilla's `PathPrefix`. Default:
       * ['Route','Mount','Group','PathPrefix'].
       */
      mountMethods?: string[];
    };
    /**
     * CLI command frameworks → `cli` entrypoints. Default: ['cobra','urfave'], each still gated
     * on the matching module appearing in a `go.mod` require block, so a repo that does not
     * depend on the framework can never emit its commands.
     */
    cli?: { frameworks?: string[] };
    /** Generated gRPC service registration. Default suffixes: ['Server']. */
    grpc?: { serviceSuffixes?: string[] };
  };
  egress?: {
    /**
     * HTTP-client packages whose call sites become egress edges. Default:
     * ['net/http', 'github.com/go-resty/resty']. Matched on the import-path PREFIX at a
     * segment boundary, so a gate written WITHOUT the `/vN` suffix matches
     * `github.com/go-resty/resty/v2`. Setting this REPLACES the default list — a profile
     * that names only its own client turns `net/http` off.
     */
    clientPackages?: string[];
  };
}
