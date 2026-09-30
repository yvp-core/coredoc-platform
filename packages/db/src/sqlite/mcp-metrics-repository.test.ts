import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from './driver.js';
import { McpMetricsRepository } from './mcp-metrics-repository.js';

describe('McpMetricsRepository', () => {
  let driver: SqliteDriver;
  let repo: McpMetricsRepository;

  beforeAll(async () => {
    driver = new SqliteDriver('file::memory:');
    await driver.initialize();
    repo = new McpMetricsRepository(driver);
  });

  afterAll(async () => {
    await driver.close();
  });

  describe('recordQuery', () => {
    it('should record a successful MCP query', async () => {
      await repo.recordQuery({
        toolName: 'search_symbols',
        durationMs: 150,
        success: true,
        scope: 'my-repo',
      });

      const count = await repo.getQueryCount(30);
      expect(count).toBe(1);
    });

    it('should record a failed MCP query', async () => {
      await repo.recordQuery({
        toolName: 'find_callers',
        durationMs: 50,
        success: false,
      });

      const count = await repo.getQueryCount(30);
      expect(count).toBe(2);
    });
  });

  describe('getQueryCount', () => {
    it('should count queries within time window', async () => {
      const count = await repo.getQueryCount(30);
      expect(count).toBe(2);
    });
  });

  describe('getQueryBreakdown', () => {
    it('should return per-tool breakdown', async () => {
      const breakdown = await repo.getQueryBreakdown(30);
      expect(breakdown).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: 'search_symbols', count: 1 }),
          expect.objectContaining({ toolName: 'find_callers', count: 1 }),
        ]),
      );
    });
  });

  describe('getRecentQueries', () => {
    it('should return recent queries ordered by time', async () => {
      const queries = await repo.getRecentQueries(10);
      expect(queries).toHaveLength(2);
      expect(queries[0].toolName).toBeDefined();
      expect(queries[0].durationMs).toBeDefined();
      expect(queries[0].success).toBeDefined();
      expect(queries[0].queriedAt).toBeDefined();
    });
  });
});

// Session rollup (P3): recordQuery stamps a session_id, and the next start
// atomically claims each un-summarized session — aggregating it into one
// mcp_session_summary payload and marking it summarized in the SAME transaction
// so it never re-emits (the dedup guard against concurrent/interrupted starts on
// the shared local db). A fresh in-memory DB per test keeps them independent —
// the claim mutates, so shared state would couple ordering.
describe('McpMetricsRepository session rollup', () => {
  let driver: SqliteDriver;
  let repo: McpMetricsRepository;
  let tmp: string;

  // A real temp-file DB (not `file::memory:`) so the atomic claim's write
  // transaction behaves exactly as production `file:./coredoc.db`: a `:memory:`
  // database does not survive across separate `transaction()` calls, which the
  // claim uses. Fresh file per test keeps them independent (the claim mutates).
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-metrics-'));
    driver = new SqliteDriver(`file:${join(tmp, 'test.db')}`);
    await driver.initialize();
    repo = new McpMetricsRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stamps session_id and rolls up rows grouped by session', async () => {
    await repo.recordQuery({ toolName: 'search_symbols', durationMs: 100, success: true, sessionId: 'sess-A' });
    await repo.recordQuery({ toolName: 'find_callers', durationMs: 300, success: false, sessionId: 'sess-A' });
    await repo.recordQuery({ toolName: 'search_symbols', durationMs: 200, success: true, sessionId: 'sess-A' });
    await repo.recordQuery({ toolName: 'explain', durationMs: 50, success: true, sessionId: 'sess-B' });

    // idleGraceSeconds: 0 disables the liveness gate so the just-inserted rows
    // surface (they would otherwise be treated as a still-live session).
    const rollups = await repo.claimUnsummarizedSessionRollups({ idleGraceSeconds: 0 });

    const a = rollups.find((r) => r.sessionId === 'sess-A');
    expect(a).toMatchObject({
      sessionId: 'sess-A',
      toolCalls: 3,
      distinctTools: 2,
      errorCount: 1,
      totalDurationMs: 600,
      avgDurationMs: 200,
    });
    const b = rollups.find((r) => r.sessionId === 'sess-B');
    expect(b).toMatchObject({
      sessionId: 'sess-B',
      toolCalls: 1,
      distinctTools: 1,
      errorCount: 0,
      totalDurationMs: 50,
      avgDurationMs: 50,
    });
  });

  // The claim MARKS as it reads (atomic): claiming a session removes it from the
  // next claim, so a concurrent/interrupted start can never re-emit it. This is
  // the exactly-once dedup that the old select-then-update pair left racy.
  it('marks claimed sessions so a second claim returns nothing (exactly-once)', async () => {
    await repo.recordQuery({ toolName: 'search_symbols', durationMs: 100, success: true, sessionId: 'sess-A' });
    await repo.recordQuery({ toolName: 'explain', durationMs: 50, success: true, sessionId: 'sess-B' });

    const first = await repo.claimUnsummarizedSessionRollups({ idleGraceSeconds: 0 });
    expect(first.map((r) => r.sessionId).sort()).toEqual(['sess-A', 'sess-B']);

    const second = await repo.claimUnsummarizedSessionRollups({ idleGraceSeconds: 0 });
    expect(second).toHaveLength(0);
  });

  it('excludes the in-flight session id — and does NOT claim it', async () => {
    await repo.recordQuery({ toolName: 'search_symbols', durationMs: 100, success: true, sessionId: 'sess-A' });
    await repo.recordQuery({ toolName: 'explain', durationMs: 50, success: true, sessionId: 'sess-B' });

    const rollups = await repo.claimUnsummarizedSessionRollups({ excludeSessionId: 'sess-A', idleGraceSeconds: 0 });
    const ids = rollups.map((r) => r.sessionId);
    expect(ids).not.toContain('sess-A');
    expect(ids).toContain('sess-B');

    // The excluded session was left un-marked, so a later claim (no exclude)
    // still picks it up — it is rolled up on a later start, not dropped.
    const later = await repo.claimUnsummarizedSessionRollups({ idleGraceSeconds: 0 });
    expect(later.map((r) => r.sessionId)).toEqual(['sess-A']);
  });

  it('ignores legacy rows with a null session_id', async () => {
    await repo.recordQuery({ toolName: 'search_symbols', durationMs: 100, success: true, sessionId: 'sess-A' });
    await repo.recordQuery({ toolName: 'explain', durationMs: 50, success: true, sessionId: 'sess-B' });
    await repo.recordQuery({ toolName: 'legacy_tool', durationMs: 10, success: true }); // no sessionId

    const rollups = await repo.claimUnsummarizedSessionRollups({ idleGraceSeconds: 0 });
    // No rollup group is produced for the null-session row.
    expect(rollups.every((r) => typeof r.sessionId === 'string' && r.sessionId.length > 0)).toBe(true);
    expect(rollups.map((r) => r.sessionId).sort()).toEqual(['sess-A', 'sess-B']);
  });

  // Liveness gate: a session that just recorded a query is treated as still-live
  // and withheld under the default idle window — this is what protects a
  // concurrent MCP instance sharing the same local db from having its open
  // session summarized (and later re-emitted) out from under it.
  it('withholds a still-active session under the default idle grace window', async () => {
    await repo.recordQuery({ toolName: 'search_symbols', durationMs: 5, success: true, sessionId: 'sess-live' });

    const guarded = await repo.claimUnsummarizedSessionRollups();
    expect(guarded.map((r) => r.sessionId)).not.toContain('sess-live');

    // With the gate disabled the same session surfaces (and is not claimed while
    // withheld — the guarded call above returned it in no batch).
    const ungated = await repo.claimUnsummarizedSessionRollups({ idleGraceSeconds: 0 });
    expect(ungated.map((r) => r.sessionId)).toContain('sess-live');
  });

  // …and a genuinely quiescent session (newest row older than the window) IS
  // rolled up under the default. Insert directly to backdate queried_at, which
  // recordQuery always stamps to now via the schema default.
  it('rolls up a quiescent session whose newest query predates the grace window', async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 86400; // a day ago — well past any idle window
    await driver.getClient().execute({
      sql: `INSERT INTO mcp_queries (id, tool_name, duration_ms, success, session_id, queried_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['old-1', 'explain', 20, 1, 'sess-idle', oldTs],
    });

    const rollups = await repo.claimUnsummarizedSessionRollups();
    expect(rollups.map((r) => r.sessionId)).toContain('sess-idle');
  });

  it('claims nothing (and does not throw) when there are no un-summarized sessions', async () => {
    await expect(repo.claimUnsummarizedSessionRollups({ idleGraceSeconds: 0 })).resolves.toEqual([]);
  });
});
