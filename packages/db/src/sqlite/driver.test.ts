/**
 * SQLite Driver Tests
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createClient } from '@libsql/client';
import { getSqliteUrl, SqliteDriver, rewriteParams } from './driver.js';

// A fixed cwd path lets overlapping Vitest processes delete or lock each other's database.
const TEST_DB_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-sqlite-driver-'));
const TEST_DB_FILE = path.join(TEST_DB_DIRECTORY, 'test.db');
const TEST_DB_URL = `file:${TEST_DB_FILE}`;

describe('SqliteDriver', () => {
  let driver: SqliteDriver;

  beforeAll(async () => {
    // Create driver with local file URL and initialize
    driver = new SqliteDriver(TEST_DB_URL);
    await driver.initialize();
  });

  afterAll(async () => {
    try {
      await driver.close();
    } finally {
      fs.rmSync(TEST_DB_DIRECTORY, { recursive: true, force: true });
    }
  });

  it('uses an atomically isolated database directory for each test run', () => {
    expect(path.basename(path.dirname(path.resolve(TEST_DB_FILE)))).toMatch(/^coredoc-sqlite-driver-/);
  });

  it('should initialize and create tables', async () => {
    // Verify tables exist by querying schema
    const result = await driver.withReadTransaction(async (tx) => {
      return tx.run<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    });

    const tableNames = result.map((r) => r.name);
    expect(tableNames).toContain('nodes');
    expect(tableNames).toContain('edges');
    expect(tableNames).toContain('schema_version');
    // calls_closure was removed in schema v6 — reads now use recursive CTE.
    expect(tableNames).not.toContain('calls_closure');
  });

  it('creates the project/repo operations index on a fresh database', async () => {
    const result = await driver.getClient().execute(`PRAGMA index_list(operations)`);
    expect(result.rows.map((row) => (row as Record<string, unknown>).name)).toContain('idx_operations_project_repo');
  });

  it('upgrades a legacy operations table before creating the project/repo index', async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-sqlite-legacy-'));
    const legacyDbUrl = `file:${path.join(legacyDir, 'legacy.db')}`;
    const seedClient = createClient({ url: legacyDbUrl });
    try {
      await seedClient.execute(`
        CREATE TABLE operations (
          id TEXT PRIMARY KEY,
          repo_name TEXT NOT NULL,
          operation TEXT NOT NULL,
          started_at INTEGER NOT NULL
        )
      `);
    } finally {
      seedClient.close();
    }

    const legacyDriver = new SqliteDriver(legacyDbUrl);
    try {
      await legacyDriver.initialize();

      const columns = await legacyDriver.getClient().execute(`PRAGMA table_info(operations)`);
      expect(columns.rows.map((row) => (row as Record<string, unknown>).name)).toContain('project_id');

      const indexes = await legacyDriver.getClient().execute(`PRAGMA index_list(operations)`);
      expect(indexes.rows.map((row) => (row as Record<string, unknown>).name)).toContain('idx_operations_project_repo');
    } finally {
      await legacyDriver.close();
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('should execute read transactions', async () => {
    const result = await driver.withReadTransaction(async (tx) => {
      return tx.run<{ count: number }>('SELECT COUNT(*) as count FROM nodes');
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.count).toBe(0);
  });

  it('should execute write transactions', async () => {
    await driver.withWriteTransaction(async (tx) => {
      await tx.run(`INSERT INTO nodes (id, type, name, properties) VALUES (@id, @type, @name, @properties)`, {
        id: 'test:repo:root',
        type: 'repository',
        name: 'test-repo',
        properties: '{"path": "/test"}',
      });
    });

    const result = await driver.withReadTransaction(async (tx) => {
      return tx.run<{ id: string; name: string }>('SELECT id, name FROM nodes WHERE id = @id', {
        id: 'test:repo:root',
      });
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('test-repo');
  });

  it('adds the mcp_queries session columns via idempotent migration', async () => {
    const cols = await driver.getClient().execute(`PRAGMA table_info(mcp_queries)`);
    const names = cols.rows.map((r) => (r as Record<string, unknown>).name);
    expect(names).toContain('session_id');
    expect(names).toContain('summarized');

    // Re-running the column migrations must not throw or duplicate columns
    // (PRAGMA-guarded, same as result_count) — the boot path runs on every start.
    await (driver as unknown as { runColumnMigrations(): Promise<void> }).runColumnMigrations();
    const after = await driver.getClient().execute(`PRAGMA table_info(mcp_queries)`);
    const summarized = after.rows.filter((r) => (r as Record<string, unknown>).name === 'summarized');
    expect(summarized).toHaveLength(1);
  });

  it('supports the session_id INSERT + summarized default on a fresh DB (CREATE-body columns, not just the ALTER)', async () => {
    // The session columns live in the CREATE TABLE body, so a fresh DB accepts an
    // INSERT that names session_id and gives summarized its NOT NULL DEFAULT 0 —
    // the exact shape recordQuery writes and the session rollup filters on — with
    // no dependency on the guarded ALTER having run.
    const client = driver.getClient();
    const id = `q-create-body-${Date.now()}`;
    await client.execute({
      sql: `INSERT INTO mcp_queries (id, tool_name, duration_ms, success, session_id) VALUES (?, ?, ?, ?, ?)`,
      args: [id, 'search_symbols', 12, 1, 'sess-create-body'],
    });

    const row = await client.execute({
      sql: `SELECT session_id, summarized FROM mcp_queries WHERE id = ?`,
      args: [id],
    });
    expect(row.rows).toHaveLength(1);
    expect((row.rows[0] as Record<string, unknown>).session_id).toBe('sess-create-body');
    expect((row.rows[0] as Record<string, unknown>).summarized).toBe(0);
  });

  it('should handle batch operations', async () => {
    const items = [
      { id: 'test:func:1', type: 'function', name: 'func1' },
      { id: 'test:func:2', type: 'function', name: 'func2' },
      { id: 'test:func:3', type: 'function', name: 'func3' },
    ];

    const processed = await driver.executeBatch(
      items,
      async (batch, tx) => {
        for (const item of batch) {
          await tx.run(
            `INSERT OR REPLACE INTO nodes (id, type, name, properties) VALUES (@id, @type, @name, '{}')`,
            item,
          );
        }
      },
      2,
    ); // Small batch size to test chunking

    expect(processed).toBe(3);

    const result = await driver.withReadTransaction(async (tx) => {
      return tx.run<{ id: string }>("SELECT id FROM nodes WHERE type = 'function' ORDER BY id");
    });

    expect(result).toHaveLength(3);
  });
});

describe('SQLite binding', () => {
  it('retains a failed client so native cleanup can be retried', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-sqlite-cleanup-retry-'));
    const failedDriver = new SqliteDriver(`file:${path.join(root, 'failed.db')}`);
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(failedDriver as unknown as { runMigrations(): Promise<void> }, 'runMigrations').mockImplementation(
      async () => {
        const client = failedDriver.getClient();
        const realClose = client.close.bind(client);
        closeSpy = vi
          .spyOn(client, 'close')
          .mockImplementationOnce(() => {
            throw new Error('temporary native close failure');
          })
          .mockImplementation(() => realClose());
        throw new Error('schema initialization failed');
      },
    );

    try {
      await expect(failedDriver.initialize()).rejects.toThrow(/cleanup also failed/i);
      await expect(failedDriver.close()).resolves.toBeUndefined();
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy?.mockRestore();
      await failedDriver.close().catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing URL instead of falling back to ./coredoc.db', () => {
    const previous = process.env.COREDOC_SQLITE_URL;
    delete process.env.COREDOC_SQLITE_URL;
    try {
      expect(() => getSqliteUrl()).toThrow('COREDOC_SQLITE_URL is not set');
    } finally {
      if (previous === undefined) delete process.env.COREDOC_SQLITE_URL;
      else process.env.COREDOC_SQLITE_URL = previous;
    }
  });

  it('opens file::memory: without treating it as a filesystem path', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const memoryDriver = new SqliteDriver('file::memory:');
    try {
      await memoryDriver.initialize();
      expect(warning).not.toHaveBeenCalledWith(expect.stringContaining('creating a new empty graph database'));
    } finally {
      await memoryDriver.close();
      warning.mockRestore();
    }
  });

  it('preserves nested cwd-relative file URL semantics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-sqlite-relative-url-'));
    const absolutePath = path.join(root, 'nested', 'relative.db');
    const relativePath = path.relative(process.cwd(), absolutePath);
    const relativeDriver = new SqliteDriver(`file:${relativePath}`);
    try {
      await relativeDriver.initialize();
      expect(fs.existsSync(absolutePath)).toBe(true);
    } finally {
      await relativeDriver.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rewriteParams', () => {
  it('should convert @param to $param', () => {
    expect(rewriteParams('SELECT * FROM nodes WHERE id = @id')).toBe('SELECT * FROM nodes WHERE id = $id');
  });

  it('should handle multiple parameters', () => {
    expect(rewriteParams('INSERT INTO nodes (id, name) VALUES (@id, @name)')).toBe(
      'INSERT INTO nodes (id, name) VALUES ($id, $name)',
    );
  });

  it('should preserve @-signs inside single-quoted strings', () => {
    expect(rewriteParams("SELECT * FROM nodes WHERE email = 'user@email.com'")).toBe(
      "SELECT * FROM nodes WHERE email = 'user@email.com'",
    );
  });

  it('should preserve @-signs inside double-quoted identifiers', () => {
    expect(rewriteParams('SELECT "col@name" FROM nodes')).toBe('SELECT "col@name" FROM nodes');
  });

  it('should preserve @-signs inside single-line comments', () => {
    expect(rewriteParams('SELECT * FROM nodes -- @note\nWHERE id = @id')).toBe(
      'SELECT * FROM nodes -- @note\nWHERE id = $id',
    );
  });

  it('should preserve @-signs inside multi-line comments', () => {
    expect(rewriteParams('SELECT * FROM nodes /* @note */ WHERE id = @id')).toBe(
      'SELECT * FROM nodes /* @note */ WHERE id = $id',
    );
  });

  it('should not rewrite @ followed by non-identifier characters', () => {
    expect(rewriteParams('SELECT @id, @@ FROM nodes')).toBe('SELECT $id, @@ FROM nodes');
  });
});
