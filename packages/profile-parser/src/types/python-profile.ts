// =============================================================================
// PythonProfile — declarative per-repo config for the Python parser.
//
// A NEW type (not ExtractionProfile, whose primitives are TS-AST-shaped, and not
// RubyProfile/SwiftProfile). The framework conventions (Django routing, DRF routers,
// Celery tasks, the Django/SQLAlchemy ORM, HTTP client libs) live in generic code
// under substrate/python/; this profile only TUNES them per repo (globs, the ORM base
// classes, the route-table locations, the task decorators, the HTTP-client modules).
// No client-specific strings belong in shared code — only in a repo's own profile.ts.
// The `'python'` literal is the registry dispatch discriminant.
//
// The field grammar is FIXED in the spec (SF-20260724): the author-profile agent must
// not guess nesting. Every knob is optional with a code-level default, so a bare
// `{ parserId, substrate }` profile parses a Django/DRF/Celery repo out of the box.
// =============================================================================
import type { IndexPolicy } from '../facts/scip/index-host.js';
import type { BaseProfile } from './profile-base.js';

export interface PythonProfile extends BaseProfile {
  parserId: string;
  substrate: {
    language: 'python';
    /** Optional compiler-backed calls; defaults to enhanced with basic fallback. */
    analysis?: IndexPolicy;
    include: string[];
    exclude?: string[];
    /**
     * Built-in default excludes SHIP in code (venv/.venv/site-packages/__pycache__/
     * node_modules/migrations/*_pb2.py); the profile's `exclude` EXTENDS them. Set
     * `excludeDefaults: false` to opt out of the built-ins entirely (DX D5a — defaults
     * are first-class, not a doc suggestion). Default: true. (Exclude LOGIC ships in the
     * file-walk step, not here — this is only the knob.)
     */
    excludeDefaults?: boolean;
  };
  /** ORM model entities. Base classes are CONFIGURABLE — never a hardcoded client base. */
  entities?: {
    /** Base classes that mark a class as a persisted entity. Default: ['models.Model'] (Django). */
    baseClasses?: string[];
    /**
     * ORM tag stamped on every emitted entity. Default: 'django'. Set it when `baseClasses`
     * points at another ORM — a SQLAlchemy repo onboarded via `baseClasses: ['Base']` would
     * otherwise carry `ormType: 'django'` on every entity in the graph.
     */
    orm?: string;
  };
  /** DB operations (ORM query call sites). Omit to skip. */
  dbOperations?: {
    /** ORM verb methods that count as a DB op. Default: ORM verbs (objects.*, save, bulk_*). */
    methods?: string[];
    /**
     * Raw-SQL query functions — the non-ORM lane (`sync_execute(QUERY, params)`,
     * `cursor.execute(SQL)`). The named callee's SQL argument is read (literal, f-string,
     * or a constant bound in the same module) and parsed into an operation + table.
     */
    rawQueries?: PythonRawQueryMatcher[];
  };
  /**
   * Entrypoint sources.
   *
   * Django MANAGEMENT COMMANDS have no knob and are always extracted: Django discovers them by a
   * fixed file convention (a non-underscore module directly inside `management/commands/`), so
   * there is nothing per-repo to tune and a single-valued key would be dead config (YAGNI).
   * The DRF router lane (nested routers, `include(<router>.urls)` mounts, `@action` sub-routes)
   * likewise follows DRF's own conventions; only WHERE the route tables live is repo-specific,
   * which is what `routeFileGlobs` already says.
   */
  entrypoints?: {
    /** Django/DRF URL route tables. `routeFileGlobs` locates them. Default: ['**\/urls.py']. */
    djangoRoutes?: { routeFileGlobs?: string[] };
    /** Celery task-decorator consumers. Default decorators: ['shared_task','app.task']. */
    queue?: { taskDecorators?: string[] };
  };
  /** Outbound HTTP egress (the Python service as a cross-repo consumer). */
  egress?: {
    /** HTTP-client modules whose call sites become egress edges. Default: ['requests','httpx','aiohttp']. */
    clientModules?: string[];
  };
}

/**
 * A raw-SQL query call shape: `sync_execute(QUERY, params)`, `cursor.execute(SQL)`.
 * Matched by CALLEE NAME (bare, or the attribute tail of `client.execute(...)`) — Python's
 * raw-query surfaces are functions, not the Manager/queryset grammar the ORM lane models.
 */
export interface PythonRawQueryMatcher {
  /** Callee names that take a SQL string, e.g. ['sync_execute', 'execute']. */
  functions: string[];
  /** Which positional argument carries the SQL. Default 0. A keyword arg there is read by value. */
  queryArg?: number;
  /**
   * Emit the op with the unresolved-sentinel as its entityName when the SQL is not statically
   * readable (built at runtime, or an f-string whose table is interpolated). Off by default:
   * the surface is only worth marking where the profile says these calls are always queries.
   */
  emitUnresolved?: boolean;
}
