/**
 * SQLite Database Driver
 *
 * Implements IDatabaseDriver for SQLite/Turso using @libsql/client.
 * Supports both explicit local file URLs and remote libsql/Turso URLs.
 *
 * IMPORTANT: @libsql/client uses $param syntax for named parameters, but existing SQL
 * uses @param convention. This driver includes a quote-aware parameter rewriter
 * that converts @param → $param only outside string literals and comments.
 */

import { createClient, type Client, type InStatement, type InArgs, type Transaction } from '@libsql/client';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphFileReadOnlyError } from '../errors.js';
import type { IDatabaseDriver, ITransaction, DatabaseBackend, TransactionStatement } from '../types.js';

// =============================================================================
// Module State
// =============================================================================

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_BATCH_SIZE = 500;

/**
 * Page cache per connection, in KiB. Sized for a process holding ONE database.
 * Callers that keep several open at once (the per-project pool) must pass a
 * smaller budget — SQLite grows this cache lazily but never shrinks it, so N
 * connections at the default would permanently cost N × this.
 */
const DEFAULT_CACHE_SIZE_KB = 64000;

/** Per-project pool budget: several databases open at once, each much smaller. */
export const POOLED_CACHE_SIZE_KB = 8000;

export interface SqliteDriverOptions {
  cacheSizeKb?: number;
  readOnly?: boolean;
  initializeSchema?: boolean;
}

/**
 * How long a statement waits for a lock before giving up. Sized for a parse
 * worker's write transaction, which is the longest lock a reader realistically
 * queues behind.
 */
const BUSY_TIMEOUT_MS = 10000;

const NODES_FTS_UPDATE_TRIGGER_SQL = `
CREATE TRIGGER nodes_fts_au AFTER UPDATE OF name ON nodes
WHEN old.name IS NOT new.name BEGIN
    INSERT INTO nodes_name_fts(nodes_name_fts, rowid, name) VALUES('delete', old.rowid, old.name);
    INSERT INTO nodes_name_fts(rowid, name) VALUES (new.rowid, new.name);
END`;

/**
 * Get the explicitly configured SQLite URL.
 *
 * There is intentionally no cwd-relative fallback. Local product flows bind a
 * project database before opening the singleton; silently creating
 * `./coredoc.db` makes a missing binding look like a valid empty graph.
 */
export function getSqliteUrl(): string {
  const url = process.env.COREDOC_SQLITE_URL;
  if (!url) {
    throw new Error(
      'COREDOC_SQLITE_URL is not set. Bind a project database first (for example with `coredoc push --project <id>`).',
    );
  }
  return url;
}

/**
 * Get SQLite auth token from environment (required for remote mode).
 */
export function getSqliteAuthToken(): string | undefined {
  return process.env.COREDOC_SQLITE_TOKEN || undefined;
}

// =============================================================================
// Parameter Rewriter
// =============================================================================

/**
 * Quote-aware parameter rewriter that converts @param → $param
 * only outside string literals and SQL comments.
 *
 * Handles:
 * - Single-quoted strings: 'user@email.com' → preserved
 * - Double-quoted identifiers: "column@name" → preserved
 * - Single-line comments: -- @note → preserved
 * - Multi-line comments: /* @note *​/ → preserved
 * - Named parameters: @param → $param
 */
export function rewriteParams(sql: string): string {
  let result = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    // Single-quoted string
    if (ch === "'") {
      result += ch;
      i++;
      while (i < len) {
        if (sql[i] === "'" && i + 1 < len && sql[i + 1] === "'") {
          // Escaped quote
          result += "''";
          i += 2;
        } else if (sql[i] === "'") {
          result += "'";
          i++;
          break;
        } else {
          result += sql[i];
          i++;
        }
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        if (sql[i] === '"' && i + 1 < len && sql[i + 1] === '"') {
          result += '""';
          i += 2;
        } else if (sql[i] === '"') {
          result += '"';
          i++;
          break;
        } else {
          result += sql[i];
          i++;
        }
      }
      continue;
    }

    // Single-line comment
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      const nlIdx = sql.indexOf('\n', i);
      if (nlIdx === -1) {
        result += sql.slice(i);
        i = len;
      } else {
        result += sql.slice(i, nlIdx + 1);
        i = nlIdx + 1;
      }
      continue;
    }

    // Multi-line comment
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const endIdx = sql.indexOf('*/', i + 2);
      if (endIdx === -1) {
        result += sql.slice(i);
        i = len;
      } else {
        result += sql.slice(i, endIdx + 2);
        i = endIdx + 2;
      }
      continue;
    }

    // Named parameter: @identifier → $identifier
    if (ch === '@' && i + 1 < len && /[a-zA-Z_]/.test(sql[i + 1])) {
      result += '$';
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Rewrite parameter keys from @-prefixed to plain names for libSQL args.
 * The SQL uses @param syntax which gets rewritten to $param in queries.
 * Parameter keys don't need rewriting — just pass through.
 */
function rewriteParamKeys(params: Record<string, unknown>): Record<string, unknown> {
  return params;
}

function toInStatement(query: string, params?: Record<string, unknown>): InStatement {
  return params
    ? { sql: rewriteParams(query), args: rewriteParamKeys(params) as InArgs }
    : { sql: rewriteParams(query), args: [] };
}

// =============================================================================
// SQLite Transaction Wrapper
// =============================================================================

/**
 * SQLite transaction wrapper implementing ITransaction.
 */
class SqliteTransaction implements ITransaction {
  constructor(private client: Client) {}

  async run<T = unknown>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const result = await this.client.execute(toInStatement(query, params));

    // Check if this is a SELECT/WITH query (WITH...INSERT/UPDATE/DELETE are write operations)
    const trimmed = query.trim().toUpperCase();
    const isSelect =
      trimmed.startsWith('SELECT') || (trimmed.startsWith('WITH') && !/\)\s*(INSERT|UPDATE|DELETE)\s/i.test(query));

    if (isSelect) {
      return result.rows as unknown as T[];
    }

    return [];
  }
}

/**
 * SQLite transaction wrapper for explicit transactions.
 */
class SqliteExplicitTransaction implements ITransaction {
  constructor(private transaction: Transaction) {}

  async run<T = unknown>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const result = await this.transaction.execute(toInStatement(query, params));

    const trimmed2 = query.trim().toUpperCase();
    const isSelect =
      trimmed2.startsWith('SELECT') || (trimmed2.startsWith('WITH') && !/\)\s*(INSERT|UPDATE|DELETE)\s/i.test(query));

    if (isSelect) {
      return result.rows as unknown as T[];
    }

    return [];
  }

  async runBatch(statements: readonly TransactionStatement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.transaction.batch(statements.map((statement) => toInStatement(statement.query, statement.params)));
  }
}

// =============================================================================
// SQLite Driver Implementation
// =============================================================================

/**
 * SQLite driver implementing IDatabaseDriver.
 * Uses @libsql/client under the hood. Supports both local file mode and remote Turso mode.
 */
export class SqliteDriver implements IDatabaseDriver {
  readonly backend: DatabaseBackend = 'sqlite';
  private client: Client | null = null;
  private _initialized = false;
  private url: string;
  private authToken: string | undefined;
  private cacheSizeKb: number;
  private readonly readOnly: boolean;
  private readonly shouldInitializeSchema: boolean;

  constructor(url?: string, authToken?: string, options?: SqliteDriverOptions) {
    this.url = url ?? getSqliteUrl();
    this.authToken = authToken ?? getSqliteAuthToken();
    this.cacheSizeKb = options?.cacheSizeKb ?? DEFAULT_CACHE_SIZE_KB;
    this.readOnly = options?.readOnly ?? false;
    this.shouldInitializeSchema = options?.initializeSchema ?? !this.readOnly;
    if (this.readOnly && this.shouldInitializeSchema) {
      throw new Error('Cannot initialize the SQLite schema through a read-only driver');
    }
    if (this.readOnly && !this.isLocalFile()) {
      throw new Error('SQLite read-only graph files require a local file URL');
    }
  }

  /**
   * Initialize the SQLite database.
   * Creates the client and runs schema setup.
   */
  /**
   * True when this driver talks to a local SQLite file (as opposed to a
   * remote libsql/Turso URL). Callers use it to gate maintenance work that is
   * cheap locally but unacceptable over the remote write path (e.g. ANALYZE
   * after applyChangeset).
   */
  isLocalFile(): boolean {
    return this.url.startsWith('file:') && !this.url.startsWith('file::memory:');
  }

  private localFilePath(): string | null {
    if (!this.isLocalFile()) return null;
    const fileReference = this.url.slice('file:'.length);
    // @libsql/client deliberately supports cwd-relative `file:./x.db` and
    // `file:relative/x.db` references. Node's fileURLToPath resolves those as
    // filesystem-root paths, so decode only canonical/absolute file URLs.
    return fileReference.startsWith('/') ? fileURLToPath(this.url) : fileReference;
  }

  async initialize(): Promise<void> {
    if (this.client && this._initialized) {
      return;
    }

    // `createClient` silently CREATES a missing file and `runMigrations` then
    // gives it an empty schema — so a stale or mistyped url does not fail, it
    // yields a graph with no rows, which reads as "this code doesn't exist"
    // rather than "wrong database". Announce the creation so that failure mode
    // is never silent. It also cannot mkdir, so the parent must exist first.
    const filePath = this.localFilePath();
    if (filePath !== null) {
      if (this.readOnly && !existsSync(filePath)) {
        throw new Error(`Read-only SQLite graph file does not exist: ${filePath}`);
      }
      if (!this.readOnly) mkdirSync(dirname(filePath), { recursive: true });
      if (!existsSync(filePath)) {
        console.warn(`[coredoc/db] creating a new empty graph database at ${filePath}`);
      }
    }

    this.client = createClient({
      url: this.url,
      authToken: this.authToken,
    });

    try {
      // Configure for performance (local file mode). Snapshot readers must not
      // change journaling or schema state on immutable artifacts.
      if (this.url.startsWith('file:')) {
        if (this.readOnly) {
          await this.client.execute('PRAGMA query_only = ON');
        } else {
          await this.client.execute('PRAGMA journal_mode = WAL');
          await this.client.execute('PRAGMA synchronous = NORMAL');
        }
        await this.client.execute('PRAGMA foreign_keys = ON');
        await this.client.execute(`PRAGMA cache_size = -${this.cacheSizeKb}`);
        // Per-project databases are opened by more than one process at a time:
        // the desktop's read pool holds a project's file open while a parse
        // worker writes to it. Without a busy timeout, a read landing during a
        // write transaction fails immediately with SQLITE_BUSY instead of
        // waiting the moment out.
        await this.client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      }

      if (this.shouldInitializeSchema) {
        await this.runMigrations();
        await this.runColumnMigrations();
      }

      this._initialized = true;
    } catch (error) {
      let cleanupError: unknown;
      try {
        this.client.close();
      } catch (failure) {
        cleanupError = failure;
      }
      if (cleanupError === undefined) {
        this.client = null;
      }
      this._initialized = false;
      if (cleanupError !== undefined) {
        // Keep the client reachable so closeAfterFailedOpen()/close() can
        // retry native cleanup instead of losing the only FD owner.
        throw new AggregateError([error, cleanupError], 'SQLite initialization failed and cleanup also failed');
      }
      throw error;
    }
  }

  /**
   * Run schema migrations using batch execution.
   */
  private async runMigrations(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    const schemaStatements = getEmbeddedSchemaStatements();
    await this.client.executeMultiple(schemaStatements);
  }

  /**
   * Schema column migrations not expressible via `CREATE TABLE IF NOT EXISTS`.
   * Idempotent: uses `PRAGMA table_info` to detect columns before adding them.
   */
  private async runColumnMigrations(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    // Check if operations.project_id exists.
    const cols = await this.client.execute(`PRAGMA table_info(operations)`);
    const hasProjectId = cols.rows.some((row) => (row as Record<string, unknown>).name === 'project_id');

    if (!hasProjectId) {
      await this.client.execute(`ALTER TABLE operations ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
    }
    await this.client.execute(
      `CREATE INDEX IF NOT EXISTS idx_operations_project_repo ON operations(project_id, repo_name)`,
    );

    // mcp_queries.result_count semantics: NULL = tool doesn't populate this
    // (single-entity tools); 0 = empty result; N = N items.
    const mcpCols = await this.client.execute(`PRAGMA table_info(mcp_queries)`);
    const hasResultCount = mcpCols.rows.some((row) => (row as Record<string, unknown>).name === 'result_count');
    if (!hasResultCount) {
      await this.client.execute(`ALTER TABLE mcp_queries ADD COLUMN result_count INTEGER`);
    }

    // mcp_queries session grouping: session_id groups one stdio server session's
    // rows so the next-start rollup can emit one mcp_session_summary per session;
    // summarized marks a session already rolled up so it is never re-emitted.
    // Both columns are in the CREATE TABLE body above (fresh DBs), so these
    // PRAGMA-guarded ALTERs only add them to pre-existing DBs — same shape as
    // result_count above.
    const hasSessionId = mcpCols.rows.some((row) => (row as Record<string, unknown>).name === 'session_id');
    if (!hasSessionId) {
      await this.client.execute(`ALTER TABLE mcp_queries ADD COLUMN session_id TEXT`);
    }
    const hasSummarized = mcpCols.rows.some((row) => (row as Record<string, unknown>).name === 'summarized');
    if (!hasSummarized) {
      await this.client.execute(`ALTER TABLE mcp_queries ADD COLUMN summarized INTEGER NOT NULL DEFAULT 0`);
    }

    // calls_closure was removed in schema v6: getCallers / getReachingEntrypoints
    // use a recursive CTE over the edges table, eliminating the per-push O(N²)
    // rebuild that dominated incremental push latency.
    // For existing DBs, drop the table + its indexes on first boot.
    await this.client.execute(`DROP INDEX IF EXISTS idx_closure_descendant`);
    await this.client.execute(`DROP INDEX IF EXISTS idx_closure_ancestor`);
    await this.client.execute(`DROP INDEX IF EXISTS idx_closure_depth`);
    await this.client.execute(`DROP INDEX IF EXISTS idx_closure_descendant_depth`);
    await this.client.execute(`DROP TABLE IF EXISTS calls_closure`);

    await this.runFtsV9Migration();
  }

  /**
   * Repair every index written under INSERT OR REPLACE semantics exactly once.
   * A count comparison is insufficient: stale and missing rowids can cancel
   * each other. Version 9 is deliberately absent from the embedded schema so
   * an existing database cannot be marked repaired before this transaction.
   */
  private async runFtsV9Migration(): Promise<void> {
    if (!this.client) throw new Error('Client not initialized');

    const applied = await this.client.execute(`SELECT 1 FROM schema_version WHERE version = 9`);
    if (applied.rows.length > 0) return;

    // libSQL's `file::memory:` transaction API uses a separate connection; the
    // database vanishes when that connection closes. Keep the test/dev-only
    // in-memory shape atomic through the client's write batch instead. The
    // in-memory database is single-connection by construction, so the outer
    // version check above is already race-free here; OR IGNORE is belt and
    // braces to keep both branches' scripts identical in effect.
    if (this.url.startsWith('file::memory:')) {
      const count = await this.client.execute(`SELECT count(*) AS count FROM nodes`);
      const statements = [
        `DROP TRIGGER IF EXISTS nodes_fts_au`,
        NODES_FTS_UPDATE_TRIGGER_SQL,
        ...(Number((count.rows[0] as Record<string, unknown> | undefined)?.count ?? 0) > 0
          ? [`INSERT INTO nodes_name_fts(nodes_name_fts) VALUES('rebuild')`]
          : []),
        `INSERT OR IGNORE INTO schema_version(version) VALUES (9)`,
      ];
      await this.client.batch(statements, 'write');
      return;
    }

    const transaction = await this.client.transaction('write');
    try {
      // Re-check under the write lock: the outer check races with other
      // processes/pods initializing the same database (desktop pool + CLI
      // worker on one file, two server pods on one Turso DB). BEGIN IMMEDIATE
      // serializes writers, so this inner check is authoritative — the loser
      // skips the redundant rebuild instead of failing initialize() on a
      // duplicate version insert.
      const recheck = await transaction.execute(`SELECT 1 FROM schema_version WHERE version = 9`);
      if (recheck.rows.length > 0) {
        await transaction.rollback();
        return;
      }
      const count = await transaction.execute(`SELECT count(*) AS count FROM nodes`);
      await transaction.execute(`DROP TRIGGER IF EXISTS nodes_fts_au`);
      await transaction.execute(NODES_FTS_UPDATE_TRIGGER_SQL);
      if (Number((count.rows[0] as Record<string, unknown> | undefined)?.count ?? 0) > 0) {
        await transaction.execute(`INSERT INTO nodes_name_fts(nodes_name_fts) VALUES('rebuild')`);
      }
      await transaction.execute(`INSERT OR IGNORE INTO schema_version(version) VALUES (9)`);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
      this._initialized = false;
    }
  }

  /**
   * Execute a function within a read transaction.
   */
  async withReadTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    if (!this.client) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const tx = new SqliteTransaction(this.client);
    return fn(tx);
  }

  /**
   * Execute a function within a write transaction.
   * Uses libSQL's explicit transaction for atomicity.
   */
  async withWriteTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    if (this.readOnly) {
      throw new GraphFileReadOnlyError('sqlite');
    }
    if (!this.client) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const transaction = await this.client.transaction('write');
    try {
      const tx = new SqliteExplicitTransaction(transaction);
      const result = await fn(tx);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  }

  /**
   * Execute batch operations with automatic chunking.
   */
  async executeBatch<T>(
    items: T[],
    handler: (batch: T[], tx: ITransaction) => Promise<void>,
    batchSize: number = DEFAULT_BATCH_SIZE,
  ): Promise<number> {
    if (this.readOnly) {
      throw new GraphFileReadOnlyError('sqlite');
    }
    if (items.length === 0) {
      return 0;
    }

    if (!this.client) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    let processed = 0;
    const transaction = await this.client.transaction('write');

    try {
      const tx = new SqliteExplicitTransaction(transaction);

      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await handler(batch, tx);
        processed += batch.length;
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }

    return processed;
  }

  /**
   * Get the underlying client instance (for advanced operations).
   */
  getClient(): Client {
    if (!this.client) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.client;
  }

  /** Singleton compatibility probe; independent graph-file instances are ignored. */
  _initializedForSingletonStatus(): boolean {
    return this._initialized;
  }
}

// =============================================================================
// Module-Level Functions
// =============================================================================

let driverInstance: SqliteDriver | null = null;

/**
 * Get the SQLite driver instance, creating it if necessary.
 */
export function getDriver(): SqliteDriver {
  if (!driverInstance) {
    driverInstance = new SqliteDriver();
  }
  return driverInstance;
}

/**
 * Check if the database is initialized.
 */
export function isDriverInitialized(): boolean {
  return driverInstance?._initializedForSingletonStatus() ?? false;
}

/**
 * Close the database connection.
 */
export async function closeDriver(): Promise<void> {
  if (driverInstance) {
    await driverInstance.close();
    driverInstance = null;
  }
}

// =============================================================================
// Embedded Schema
// =============================================================================

function getEmbeddedSchemaStatements(): string {
  return `
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    properties TEXT DEFAULT '{}',
    summary TEXT,
    embedding TEXT,
    repo_id TEXT,
    file_path TEXT,
    start_line INTEGER,
    end_line INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    created_by TEXT DEFAULT 'parser',
    properties TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_repo ON nodes(repo_id);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_id_prefix ON nodes(substr(id, 1, 13));
CREATE INDEX IF NOT EXISTS idx_nodes_type_name ON nodes(type, name);
-- Covering index for per-repo type counts (getRepoOverview/getCoverageCounts):
-- the correlated COUNT(*) ... WHERE repo_id = ? AND type = ? subqueries walk
-- ~36k idx_nodes_repo entries per repo without it (measured 160-280ms on a
-- 181k-node graph vs 12ms with it — Phase 0 bench, 2026-08-10).
CREATE INDEX IF NOT EXISTS idx_nodes_repo_type ON nodes(repo_id, type);

CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(json_extract(properties, '$.kind')) WHERE type = 'function';
CREATE INDEX IF NOT EXISTS idx_nodes_entrypoint_type ON nodes(json_extract(properties, '$.entrypointType')) WHERE type = 'entrypoint';
CREATE INDEX IF NOT EXISTS idx_nodes_http_method ON nodes(json_extract(properties, '$.method')) WHERE type = 'entrypoint';
CREATE INDEX IF NOT EXISTS idx_nodes_orm_type ON nodes(json_extract(properties, '$.ormType')) WHERE type = 'entity';
CREATE INDEX IF NOT EXISTS idx_nodes_table_name ON nodes(json_extract(properties, '$.tableName')) WHERE type = 'entity';

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(source_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_target_type ON edges(target_id, type);

-- Substring search index for findCode (and downstream search_symbols / explain
-- fuzzy lookups). FTS5 with the trigram tokenizer supports 3+ character
-- substring matches WITHOUT a full table scan — the previous LIKE '%foo%'
-- path forced a scan because SQLite can't use idx_nodes_name when the leading
-- wildcard is present. Queries shorter than 3 characters fall back to LIKE
-- (trigram has no 1/2-char tokens). Case-insensitive by tokenizer default.
--
-- External-content table linked to nodes.rowid keeps the FTS index a thin
-- secondary structure; triggers below sync inserts/updates/deletes.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_name_fts USING fts5(
    name,
    content='nodes',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_name_fts(rowid, name) VALUES (new.rowid, new.name);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_name_fts(nodes_name_fts, rowid, name) VALUES('delete', old.rowid, old.name);
END;

${NODES_FTS_UPDATE_TRIGGER_SQL.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ')};

-- Call sites the parser could not resolve to a callee (dynamic dispatch, missing
-- type information). They are not edges — there is no target node — so they live
-- beside the graph and are replaced wholesale with their repo.
CREATE TABLE IF NOT EXISTS unresolved_calls (
    repo_id TEXT NOT NULL,
    caller_id TEXT NOT NULL,
    callee_expression TEXT NOT NULL,
    callee_name_tail TEXT,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL
);

-- The name tail is precomputed by the transformer precisely so this lookup is an
-- indexed equality match instead of a LIKE scan over every unresolved call.
CREATE INDEX IF NOT EXISTS idx_unresolved_calls_name_tail ON unresolved_calls(callee_name_tail);
CREATE INDEX IF NOT EXISTS idx_unresolved_calls_file ON unresolved_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_calls_repo ON unresolved_calls(repo_id);

CREATE TABLE IF NOT EXISTS graph_meta (
    repo_id TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);

CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    repo_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'started',
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER,
    metadata TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_operations_repo ON operations(repo_name);
CREATE INDEX IF NOT EXISTS idx_operations_repo_op ON operations(repo_name, operation);
CREATE INDEX IF NOT EXISTS idx_operations_started ON operations(started_at DESC);

INSERT OR IGNORE INTO schema_version (version) VALUES (2);

CREATE TABLE IF NOT EXISTS mcp_queries (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    success INTEGER NOT NULL DEFAULT 1,
    scope TEXT,
    result_count INTEGER,
    session_id TEXT,
    summarized INTEGER NOT NULL DEFAULT 0,
    queried_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_mcp_queries_tool ON mcp_queries(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcp_queries_queried_at ON mcp_queries(queried_at DESC);

INSERT OR IGNORE INTO schema_version (version) VALUES (3);

INSERT OR IGNORE INTO schema_version (version) VALUES (4);

INSERT OR IGNORE INTO schema_version (version) VALUES (5);

INSERT OR IGNORE INTO schema_version (version) VALUES (6);

INSERT OR IGNORE INTO schema_version (version) VALUES (7);

INSERT OR IGNORE INTO schema_version (version) VALUES (8);
`;
}
