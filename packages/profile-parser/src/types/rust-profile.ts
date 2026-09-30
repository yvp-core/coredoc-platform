// =============================================================================
// RustProfile — declarative per-repo config for the Rust substrate.
//
// Shaped like PythonProfile, for the same reason: the framework conventions
// (axum/actix/rocket routing, Anchor/ink!/CosmWasm contract handlers, diesel /
// sea-orm / sqlx data access, reqwest/hyper egress) live in generic code under
// substrate/rust/, and this profile only TUNES them per repo. No client-specific
// strings belong in shared code — only in a repo's own profile.ts.
// The `'rust'` literal is the registry dispatch discriminant.
//
// Every knob is optional with a code-level default, so a bare
// `{ parserId, substrate }` profile already extracts meaningfully.
// =============================================================================
import type { IndexPolicy } from '../facts/scip/index-host.js';
import type { BaseProfile } from './profile-base.js';

/**
 * One custom router-registration call shape (`r.insert(Method::GET, path, handler)`), for repos
 * with a hand-rolled router that the axum/actix `.route("/p", get(h))` lane cannot see.
 * Argument indices are zero-based positions in the call's argument list.
 */
export interface RouterRegistrationCall {
  /** Callee method name of the registration call (`insert` for `r.insert(…)`). */
  callee: string;
  /**
   * Index of the path argument. Accepts a string literal, a const/static reference, or a
   * `format!(…)` composition; const parts resolve repo-wide when the name is unambiguous, and
   * an unresolvable part becomes a `{name}` template segment rather than dropping the route.
   */
  pathArg: number;
  /** Index of the HTTP-method argument (`Method::POST` / `"POST"`). Omitted → labeled GET. */
  methodArg?: number;
  /**
   * Index of the handler argument — a handler fn identifier, or a handler STRUCT expression
   * (`AdminOperation(&CreateKeyHandler {})`); a struct resolves to its impl's single method
   * when that is unambiguous repo-wide.
   */
  handlerArg?: number;
}

export interface RustProfile extends BaseProfile {
  parserId: string;
  substrate: {
    language: 'rust';
    /** Optional compiler-backed calls; defaults to enhanced with basic fallback. */
    analysis?: IndexPolicy;
    include: string[];
    exclude?: string[];
    /**
     * Built-in default excludes SHIP in code (`target/`, `vendor/`, `tests/`, `benches/`,
     * `examples/`, `build.rs`); the profile's `exclude` EXTENDS them. Set
     * `excludeDefaults: false` to opt out of the built-ins entirely. Default: true.
     * (`target/` is NOT in the shared enumerator's ignore floor, so this is the only
     * thing keeping a built workspace's artifacts out of scope.)
     */
    excludeDefaults?: boolean;
  };
  /** ORM entities. Base traits/derives are CONFIGURABLE — never a hardcoded client name. */
  entities?: {
    /**
     * Derive macros that mark a struct as persisted. Default:
     * ['DeriveEntityModel','Queryable','Insertable'].
     * `sqlx::FromRow` is deliberately NOT a default: those structs are usually
     * projections (`UserRow`, `UserSummary`) over one table, so defaulting them on
     * inflates the entity count and guarantees the entities-but-0-dbOperations red flag.
     * Name it here for a repo where `FromRow` really does mark the model.
     */
    deriveMacros?: string[];
    /** ORM tag stamped on every entity. Default: inferred per source (diesel/sea-orm/sql), else 'rust'. */
    orm?: string;
    /**
     * Where plain-SQL schema DDL lives. `CREATE TABLE` in a sqlx/diesel migration is the
     * highest-fidelity entity source in Rust and its table names match what `parseSqlOp`
     * reads out of `sqlx::query!` strings. Default (depth-agnostic, because a Cargo workspace
     * keeps migrations under the owning crate):
     * ['**\/migrations/**\/*.sql', '**\/schema.sql', '**\/db/**\/*.sql'].
     */
    schemaFileGlobs?: string[];
  };
  dbOperations?: {
    /** Additional query verbs that count as a DB op. Default: the sqlx/diesel/sea-orm verb set. */
    methods?: string[];
  };
  entrypoints?: {
    /** axum/actix/rocket route registration. */
    http?: {
      /** Attribute macros carrying a route. Default: ['get','post','put','patch','delete','head','options','route']. */
      routeAttributes?: string[];
      /** Call-shape router builders. Default: ['route','nest','mount','service','scope']. */
      routerMethods?: string[];
      /**
       * Hand-rolled router registration call shapes beyond `.route(…)` — e.g. a repo-owned
       * `S3Router`-style `r.insert(Method::GET, path, handler)`. No default: each entry names
       * the callee and where the verb/path/handler sit in the argument list.
       */
      registrationCalls?: RouterRegistrationCall[];
    };
    /**
     * Smart-contract handlers → `queue` entrypoints (`event` is counted in NO scorecard row,
     * so contracts would score as nothing at all). Default frameworks: anchor (`#[program]`),
     * ink (`#[ink(message)]` / `#[ink(constructor)]`), cosmwasm (`#[entry_point]`).
     * The lane is gated on the matching crate appearing in a `Cargo.toml` dependency table.
     */
    contracts?: { frameworks?: string[] };
    /** tonic gRPC service impls. Default: `impl <X>Server for` / `#[tonic::async_trait]`. */
    grpc?: { serviceSuffixes?: string[] };
  };
  egress?: {
    /** HTTP-client crates whose call sites become egress edges. Default: ['reqwest','hyper']. */
    clientCrates?: string[];
  };
}
