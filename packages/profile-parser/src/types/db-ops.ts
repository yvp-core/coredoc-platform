import type { ArgRef } from './detectors.js';

// ─────────────────────────────────────────────────────────────────────────────
// DB operations
// ─────────────────────────────────────────────────────────────────────────────

export type DbOpRule = {
  /**
   * ORM method name → operation type. Optional: a repo with no ORM (raw SQL/Cypher only)
   * declares `rawQueries` alone and omits this, in which case the ORM receiver pass is
   * skipped entirely.
   */
  opMap?: Record<string, string>;
  /** receiver patterns for the entity-manager (regex source strings). */
  emReceivers?: string[];
  /** repo receiver pattern (regex source string). */
  repoReceiverPattern?: string;
  /** receiver pattern that names the entity inline, e.g. `models.User`. */
  modelReceiverPattern?: string;
  /** transaction-ish receiver pattern (entity-agnostic ops). */
  transactionReceiverPattern?: string;
  /** entity from first arg (em-style ops). */
  entityFrom?: ArgRef;
  /**
   * Generic base-repository class names whose FIRST generic type argument is the
   * managed entity, e.g. `class FooRepository extends EntityRepository<Foo>` or a
   * custom `class FooRepository extends BaseRepository<Foo>`. When a class extends
   * one of these with an entity type arg, opMap calls on `this.<op>()` inside that
   * class — and on a DI prop typed as that repository class — resolve their
   * entityName/entityId to the captured entity (instead of `unknown`). Matched by
   * exact base-class name. Generic: the entity binding comes from the type arg, no
   * repo-specific names live in engine code.
   */
  repoBaseClasses?: string[];
  /**
   * Raw SQL / Cypher query sources (no ORM): for call shapes like
   * `client.execute('SELECT … FROM nodes')` or `tx.run('MATCH (n:Function)…')`,
   * parse the query string into an operation + table/label. The entity name is the
   * table (SQL) or node label (Cypher).
   */
  rawQueries?: RawQueryMatcher[];
};

export type RawQueryMatcher = {
  /** 'sql' → SELECT/INSERT/UPDATE/DELETE + table; 'cypher' → MATCH/MERGE/CREATE/SET/DELETE + node label. */
  dialect: 'sql' | 'cypher';
  /** Method names that take a query string, e.g. ['execute', 'run']. */
  methods: string[];
  /** Optional receiver regex(es) — e.g. ['client$', '(^|\\.)tx$']. */
  receivers?: string[];
  /** Which arg holds the query string (or a `{ sql }` object). Default 0. */
  queryArg?: number;
  /** Restrict to files under these repo-relative path prefixes (e.g. ['packages/db/src/sqlite']). */
  inPaths?: string[];
  /**
   * Emit the op even when the query argument is not statically readable SQL — an identifier
   * bound elsewhere (`postgres.query(use, sql, params)`), a builder fragment, or a template
   * whose table is interpolated. The op carries the unresolved-sentinel as its `entityName`
   * (`unresolved:<expression>`), so the raw-SQL surface is visible while nothing joins it to
   * a real table by accident. Off by default: a matcher pointed at a composable query builder
   * would otherwise emit one marked op per fragment.
   */
  emitUnresolved?: boolean;
};
