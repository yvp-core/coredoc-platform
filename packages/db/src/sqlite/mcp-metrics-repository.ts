/**
 * MCP Metrics Repository
 *
 * Records and queries local MCP tool invocation metrics.
 * Uses the same SQLite database as the graph and operations repositories.
 */

import { randomBytes } from 'crypto';
import type { SqliteDriver } from './driver.js';

export interface McpQueryRecord {
  id: string;
  toolName: string;
  durationMs: number;
  success: boolean;
  scope?: string;
  /** Number of items returned. NULL for single-entity tools that don't track it. */
  resultCount?: number | null;
  queriedAt: number;
}

export interface RecordMcpQueryInput {
  toolName: string;
  durationMs: number;
  success: boolean;
  scope?: string;
  /** Items returned by the tool. Omit (or null) for single-entity tools. 0 = empty. */
  resultCount?: number | null;
  /**
   * Per-process stdio session id (minted at server start). Groups rows so a
   * later start can roll each session up into one `mcp_session_summary`. Omit
   * (→ null) for callers that don't track sessions; such rows never roll up.
   */
  sessionId?: string;
}

/**
 * One session's rolled-up counters — the payload for a durable
 * `mcp_session_summary` event, computed from the session's `mcp_queries` rows.
 */
export interface McpSessionRollup {
  sessionId: string;
  /** Total tool calls in the session. */
  toolCalls: number;
  /** Distinct tool names exercised. */
  distinctTools: number;
  /** Calls that failed (success = 0). */
  errorCount: number;
  /** Summed call duration across the session. */
  totalDurationMs: number;
  /** Mean call duration, rounded to whole ms. */
  avgDurationMs: number;
}

/**
 * How long a session must be quiescent (no new query) before the next-start
 * rollup treats it as finished and rolls it up. A project's local database is
 * shared by every MCP server launched for that project (two editor windows →
 * two processes, one project file), and a session carries no liveness
 * signal beyond its rows' `queried_at`. Requiring the newest row to be older
 * than this window keeps a concurrent, STILL-LIVE instance's in-flight session
 * from being summarized (and then re-emitted) out from under it. Best-effort
 * telemetry: a session idle past the window that later resumes may split across
 * two summaries — an accepted residual of a time-based liveness heuristic.
 */
const SESSION_IDLE_GRACE_SEC = 30 * 60;

/** Options for {@link McpMetricsRepository.claimUnsummarizedSessionRollups}. */
export interface UnsummarizedSessionRollupOptions {
  /**
   * Skip this session id — the in-flight process's own session at startup. It is
   * rolled up on a later start once its rows fall quiet. Omit for callers with
   * no current session (null arg reduces the filter to a no-op).
   */
  excludeSessionId?: string;
  /**
   * Liveness gate: only roll up sessions whose newest `queried_at` is at least
   * this many seconds old. Defaults to {@link SESSION_IDLE_GRACE_SEC}. Pass 0 to
   * include every session regardless of recency (tests, or a caller that has
   * already established the sessions are dead).
   */
  idleGraceSeconds?: number;
}

function generateQueryId(): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString('hex');
  return `mcp-${ts}-${rand}`;
}

export class McpMetricsRepository {
  constructor(private driver: SqliteDriver) {}

  /**
   * Record an MCP tool invocation. Non-blocking — errors are logged, not thrown.
   */
  async recordQuery(input: RecordMcpQueryInput): Promise<void> {
    try {
      const id = generateQueryId();
      const client = this.driver.getClient();
      await client.execute({
        sql: `INSERT INTO mcp_queries (id, tool_name, duration_ms, success, scope, result_count, session_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          input.toolName,
          input.durationMs,
          input.success ? 1 : 0,
          input.scope ?? null,
          input.resultCount ?? null,
          input.sessionId ?? null,
        ],
      });
    } catch (err) {
      console.error(`[McpMetrics] Failed to record query: ${err}`);
    }
  }

  /**
   * Per-tool empty-result rate. Only includes tools that populate result_count.
   * Useful for spotting where retrieval quality is poor (e.g. search_symbols
   * returning many zero-hit queries → embeddings may help).
   */
  async getEmptyResultBreakdown(
    days: number = 30,
  ): Promise<Array<{ toolName: string; total: number; empty: number; emptyPct: number }>> {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const client = this.driver.getClient();
    const result = await client.execute({
      sql: `SELECT tool_name,
                   COUNT(*) AS total,
                   SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS empty
            FROM mcp_queries
            WHERE queried_at >= ?
              AND result_count IS NOT NULL
            GROUP BY tool_name
            ORDER BY empty * 1.0 / total DESC, total DESC`,
      args: [since],
    });
    return result.rows.map((row: Record<string, unknown>) => {
      const total = Number(row.total);
      const empty = Number(row.empty);
      return {
        toolName: row.tool_name as string,
        total,
        empty,
        emptyPct: total > 0 ? Math.round((empty / total) * 1000) / 10 : 0,
      };
    });
  }

  /**
   * Count total MCP queries within a time window.
   */
  async getQueryCount(days: number = 30): Promise<number> {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const client = this.driver.getClient();
    const result = await client.execute({
      sql: `SELECT COUNT(*) as count FROM mcp_queries WHERE queried_at >= ?`,
      args: [since],
    });
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Get per-tool query breakdown within a time window.
   */
  async getQueryBreakdown(days: number = 30): Promise<Array<{ toolName: string; count: number }>> {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const client = this.driver.getClient();
    const result = await client.execute({
      sql: `SELECT tool_name, COUNT(*) as count
            FROM mcp_queries
            WHERE queried_at >= ?
            GROUP BY tool_name
            ORDER BY count DESC`,
      args: [since],
    });
    return result.rows.map((row: Record<string, unknown>) => ({
      toolName: row.tool_name as string,
      count: Number(row.count),
    }));
  }

  /**
   * Get recent MCP queries for display.
   */
  async getRecentQueries(limit: number = 20): Promise<McpQueryRecord[]> {
    const client = this.driver.getClient();
    const result = await client.execute({
      sql: `SELECT id, tool_name, duration_ms, success, scope, result_count, queried_at
            FROM mcp_queries
            ORDER BY queried_at DESC
            LIMIT ?`,
      args: [limit],
    });
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      toolName: row.tool_name as string,
      durationMs: Number(row.duration_ms),
      success: row.success === 1,
      scope: row.scope as string | undefined,
      resultCount: row.result_count === null ? null : Number(row.result_count),
      queriedAt: Number(row.queried_at),
    }));
  }

  /**
   * Atomically CLAIM every QUIESCENT un-summarized session and return its
   * rolled-up counters. The aggregate SELECT and the `summarized = 1` UPDATE run
   * inside ONE `BEGIN IMMEDIATE` write transaction, so the claim of a session is
   * indivisible from the read of its counters. The caller emits one
   * `mcp_session_summary` per RETURNED rollup AFTER this resolves
   * (mark-before-emit).
   *
   * This is what makes the next-start rollup the exactly-once owner of session
   * summaries on the shared project database (two editor windows → two
   * processes, one file). Without the transaction, a plain SELECT-then-UPDATE
   * re-emits two ways: two starts both SELECT the same idle sessions before
   * either marks them (concurrent double-emit), and a swallowed UPDATE failure
   * after the emits leaves rows `summarized = 0` for the next start to re-emit.
   * `BEGIN IMMEDIATE` takes the write lock up front and marks in the same
   * transaction, closing both:
   *   - a second concurrent starter either blocks until this commits and then
   *     aggregates over `summarized = 1` rows (returns nothing), or fails
   *     SQLITE_BUSY and its guarded caller swallows — neither re-emits;
   *   - the mark commits atomically with the read, and emit happens only after,
   *     so nothing is ever emitted for a session left `summarized = 0`.
   * Residual best-effort gap: a crash between commit and the caller's emit drops
   * at most that one batch (the sessions are marked but never emitted) — accepted
   * because the server lives long after startup and posthog batches the emits.
   *
   * Gating (unchanged): rows with a null session_id (legacy, pre-session inserts)
   * never form a group; a session is claimable only when its newest `queried_at`
   * is older than the idle-grace window — the liveness gate that stops a
   * concurrent, still-live MCP instance's open session from being summarized
   * mid-run; `excludeSessionId` additionally skips the in-flight process's own
   * session at startup (rolled up on a later start once it too falls quiet).
   */
  async claimUnsummarizedSessionRollups(options: UnsummarizedSessionRollupOptions = {}): Promise<McpSessionRollup[]> {
    const { excludeSessionId, idleGraceSeconds = SESSION_IDLE_GRACE_SEC } = options;
    const idleCutoff = Math.floor(Date.now() / 1000) - idleGraceSeconds;
    // BEGIN IMMEDIATE: take the write lock before reading so a concurrent starter
    // can't select the same sessions in parallel (mirrors driver write-txn shape).
    const tx = await this.driver.getClient().transaction('write');
    try {
      // `session_id IS NOT ?` is null-safe: a null arg reduces to `IS NOT NULL`
      // (excludes nothing extra), a value excludes exactly that session.
      // `HAVING MAX(queried_at) <= ?` is the liveness gate: only sessions idle
      // for the grace window roll up, so a live instance's open session is left
      // alone (queried_at is seconds — `unixepoch()` default — matching the arg).
      const result = await tx.execute({
        sql: `SELECT session_id,
                     COUNT(*) AS tool_calls,
                     COUNT(DISTINCT tool_name) AS distinct_tools,
                     SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS error_count,
                     SUM(duration_ms) AS total_duration_ms,
                     AVG(duration_ms) AS avg_duration_ms
              FROM mcp_queries
              WHERE summarized = 0
                AND session_id IS NOT NULL
                AND session_id IS NOT ?
              GROUP BY session_id
              HAVING MAX(queried_at) <= ?
              ORDER BY session_id`,
        args: [excludeSessionId ?? null, idleCutoff],
      });
      const rollups = result.rows.map((row: Record<string, unknown>) => ({
        sessionId: row.session_id as string,
        toolCalls: Number(row.tool_calls),
        distinctTools: Number(row.distinct_tools),
        errorCount: Number(row.error_count),
        totalDurationMs: Number(row.total_duration_ms),
        avgDurationMs: Math.round(Number(row.avg_duration_ms)),
      }));

      // Mark exactly the claimed sessions summarized, in the SAME transaction, so
      // a later rollup skips them — the dedupe that makes the emit exactly-once.
      if (rollups.length > 0) {
        const placeholders = rollups.map(() => '?').join(', ');
        await tx.execute({
          sql: `UPDATE mcp_queries SET summarized = 1 WHERE session_id IN (${placeholders})`,
          args: rollups.map((rollup) => rollup.sessionId),
        });
      }

      await tx.commit();
      return rollups;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
}
