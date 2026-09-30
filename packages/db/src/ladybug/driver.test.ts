import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Connection, Database } from '@ladybugdb/core';
import {
  LADYBUG_NO_QUERY_TIMEOUT_MS,
  LadybugDriver,
  READ_ONLY_LADYBUG_BUDGETS,
  READ_WRITE_LADYBUG_BUDGETS,
  bootstrapLadybugFts,
  closeLadybugResources,
  configureLadybugConnection,
  executeLadybugRows,
  loadLadybugFts,
  openLadybugDriver,
  queryLadybugRows,
  resolveLadybugBudgets,
  runLadybugEffect,
  streamLadybugExecutedRows,
  streamLadybugRows,
} from './driver.js';

describe('resolveLadybugBudgets', () => {
  it('uses the measured read-only and read-write defaults', () => {
    expect(resolveLadybugBudgets(true)).toEqual(READ_ONLY_LADYBUG_BUDGETS);
    expect(resolveLadybugBudgets(false)).toEqual(READ_WRITE_LADYBUG_BUDGETS);
    expect(READ_ONLY_LADYBUG_BUDGETS).toEqual({
      maxDbSizeBytes: 8 * 1024 ** 3,
      bufferPoolBytes: 256 * 1024 ** 2,
    });
    expect(READ_WRITE_LADYBUG_BUDGETS).toEqual({
      maxDbSizeBytes: 16 * 1024 ** 3,
      bufferPoolBytes: 1024 ** 3,
    });
  });

  it('rejects a non-power-of-two maxDBSize above the 32-bit range', () => {
    expect(() =>
      resolveLadybugBudgets(true, {
        maxDbSizeBytes: 2 ** 33 + 1,
      }),
    ).toThrow(/maxDBSize.*power of two/i);
  });

  it('rejects unsafe, non-positive, and non-power-of-two budget values', () => {
    expect(() => resolveLadybugBudgets(false, { maxDbSizeBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /positive safe integer/i,
    );
    expect(() => resolveLadybugBudgets(false, { bufferPoolBytes: 0 })).toThrow(/positive safe integer/i);
    expect(() => resolveLadybugBudgets(false, { bufferPoolBytes: 3 * 1024 ** 2 })).toThrow(/power of two/i);
    expect(() => resolveLadybugBudgets(false, { queryTimeoutMs: Number.NaN })).toThrow(/query timeout/i);
  });
});

function result(rows: Array<Record<string, unknown>> = []) {
  return {
    getAll: vi.fn(async () => rows),
    hasNext: vi.fn(() => rows.length > 0),
    getNext: vi.fn(async () => rows.shift() ?? null),
    close: vi.fn(),
  };
}

describe('Ladybug query-result lifecycle', () => {
  it('closes every result when consuming the last result throws', async () => {
    const first = result();
    const second = result();
    second.getAll.mockRejectedValueOnce(new Error('consume failed'));
    const connection = { query: vi.fn(async () => [first, second]) };

    await expect(queryLadybugRows(connection as never, 'RETURN 1')).rejects.toThrow('consume failed');
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('closes every prepared-execution result', async () => {
    const first = result();
    const second = result([{ value: 1 }]);
    const statement = { isSuccess: () => true };
    const connection = {
      execute: vi.fn(async () => [first, second]),
    };

    await expect(executeLadybugRows(connection as never, statement as never, {})).resolves.toEqual([{ value: 1 }]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('closes effect results and attempts every close when one close fails', async () => {
    const first = result();
    const second = result();
    first.close.mockImplementationOnce(() => {
      throw new Error('first close failed');
    });
    const connection = { query: vi.fn(async () => [first, second]) };

    await expect(runLadybugEffect(connection as never, 'CHECKPOINT')).rejects.toThrow('first close failed');
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('closes streaming results when the consumer stops early', async () => {
    const queryResult = result([{ value: 1 }, { value: 2 }]);
    const connection = { query: vi.fn(async () => queryResult) };

    for await (const row of streamLadybugRows(connection as never, 'RETURN 1')) {
      expect(row).toEqual({ value: 1 });
      break;
    }

    expect(queryResult.close).toHaveBeenCalledOnce();
  });

  it('closes prepared streaming results when the consumer stops early', async () => {
    const queryResult = result([{ value: 1 }, { value: 2 }]);
    const connection = { execute: vi.fn(async () => queryResult) };

    for await (const row of streamLadybugExecutedRows(connection as never, {} as never, { needle: 'x' })) {
      expect(row).toEqual({ value: 1 });
      break;
    }

    expect(connection.execute).toHaveBeenCalledWith({}, { needle: 'x' });
    expect(queryResult.close).toHaveBeenCalledOnce();
  });
});

describe('Ladybug connection lifecycle', () => {
  it('closes the database when native connection construction throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-driver-connection-constructor-'));
    const path = join(root, 'graph.lbug');
    let databaseClose: ReturnType<typeof vi.spyOn> | undefined;
    class ConnectionConstructorFailureDriver extends LadybugDriver {
      protected override createConnection(database: Database): Connection {
        databaseClose = vi.spyOn(database, 'close');
        throw new Error('connection constructor failed');
      }
    }
    const driver = new ConnectionConstructorFailureDriver(path, { readOnly: false });

    try {
      await expect(driver.initialize()).rejects.toThrow('connection constructor failed');
      expect(databaseClose).toHaveBeenCalledOnce();
    } finally {
      databaseClose?.mockRestore();
      await driver.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries native cleanup when the public factory fails during initialization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-driver-failed-open-'));
    const path = join(root, 'not-a-database.lbug');
    writeFileSync(path, 'not a Ladybug database');
    const originalClose = Connection.prototype.close;
    const closeSpy = vi
      .spyOn(Connection.prototype, 'close')
      .mockRejectedValueOnce(new Error('temporary initialization cleanup failure'))
      .mockImplementation(function (this: Connection) {
        return originalClose.call(this);
      });

    try {
      await expect(
        openLadybugDriver(path, {
          readOnly: true,
          initializeSchema: false,
          ftsMode: 'load',
        }),
      ).rejects.toThrow(/initialization failed/i);
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies an explicit query timeout when configured', () => {
    const connection = { setQueryTimeout: vi.fn() };
    configureLadybugConnection(connection as never, {
      ...READ_ONLY_LADYBUG_BUDGETS,
      queryTimeoutMs: 2_500,
    });
    expect(connection.setQueryTimeout).toHaveBeenCalledWith(2_500);
  });

  it('attempts database close even when connection close fails', async () => {
    const connection = { close: vi.fn(async () => Promise.reject(new Error('connection close failed'))) };
    const database = { close: vi.fn(async () => undefined) };

    await expect(closeLadybugResources(connection as never, database as never)).rejects.toThrow(
      'connection close failed',
    );
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('allows cleanup to be retried after a native close failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-driver-close-retry-'));
    const path = join(root, 'graph.lbug');
    const driver = new LadybugDriver(path, { readOnly: false });
    await driver.initialize();

    const closeSpy = vi
      .spyOn(Connection.prototype, 'close')
      .mockRejectedValueOnce(new Error('temporary close failure'));
    try {
      await expect(driver.close()).rejects.toThrow('temporary close failure');
    } finally {
      closeSpy.mockRestore();
    }

    await expect(driver.close()).resolves.toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('coalesces concurrent initialization of one driver instance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-driver-init-'));
    const path = join(root, 'graph.lbug');
    const driver = new LadybugDriver(path, { readOnly: false });
    try {
      await Promise.all([driver.initialize(), driver.initialize(), driver.initialize()]);
      await expect(
        driver.withReadTransaction((transaction) => transaction.run<{ value: number | bigint }>('RETURN 1 AS value')),
      ).resolves.toEqual([{ value: 1 }]);
    } finally {
      await driver.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('creates an RW schema, reopens it read-only, and enforces runtime immutability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-driver-'));
    const path = join(root, 'graph.lbug');
    let rw: LadybugDriver | undefined;
    let ro: LadybugDriver | undefined;
    try {
      rw = new LadybugDriver(path, { readOnly: false });
      await rw.initialize();
      const tables = await rw.withReadTransaction((transaction) =>
        transaction.run<{ name: string }>('CALL SHOW_TABLES() RETURN name'),
      );
      expect(tables.map(({ name }) => name)).toContain('GraphNode');
      await rw.checkpoint();
      await rw.close();
      rw = undefined;

      ro = new LadybugDriver(path, { readOnly: true });
      await ro.initialize();
      await expect(
        ro.withReadTransaction((transaction) =>
          transaction.run(
            "CREATE (n:GraphNode {id: 'mutation-canary', type: 'function', name: 'mutation-canary', properties: '{}'})",
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await ro?.close();
      await rw?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('opens 12 read-only handles simultaneously with an explicit production maxDBSize', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-driver-fanout-'));
    const path = join(root, 'graph.lbug');
    let writer: LadybugDriver | undefined;
    const readers: LadybugDriver[] = [];
    try {
      writer = await openLadybugDriver(path, {
        readOnly: false,
        budgets: READ_WRITE_LADYBUG_BUDGETS,
      });
      await writer.checkpoint();
      await writer.close();
      writer = undefined;

      for (let index = 0; index < 12; index += 1) {
        readers.push(
          await openLadybugDriver(path, {
            readOnly: true,
            budgets: READ_ONLY_LADYBUG_BUDGETS,
            initializeSchema: false,
            ftsMode: 'load',
          }),
        );
      }

      expect(readers).toHaveLength(12);
      expect(readers.every(({ budgets }) => budgets.maxDbSizeBytes === 8 * 1024 ** 3)).toBe(true);
      const tableSets = await Promise.all(
        readers.map((reader) =>
          reader.withReadTransaction((transaction) =>
            transaction.run<{ name: string }>('CALL SHOW_TABLES() RETURN name'),
          ),
        ),
      );
      for (const tables of tableSets) {
        expect(tables.map(({ name }) => name)).toContain('GraphNode');
      }
    } finally {
      for (const reader of readers) await reader.close();
      await writer?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('serializes transaction callbacks that share the single connection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-driver-serialized-'));
    const path = join(root, 'graph.lbug');
    const driver = new LadybugDriver(path, { readOnly: false });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    try {
      await driver.initialize();
      const first = driver.withReadTransaction(async () => {
        events.push('first:start');
        await firstGate;
        events.push('first:end');
      });
      await vi.waitFor(() => expect(events).toEqual(['first:start']));
      const second = driver.withReadTransaction(async () => {
        events.push('second');
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(events).toEqual(['first:start']);
      releaseFirst?.();
      await Promise.all([first, second]);
      expect(events).toEqual(['first:start', 'first:end', 'second']);
    } finally {
      releaseFirst?.();
      await driver.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('Ladybug FTS bootstrap', () => {
  it('loads the required extension and closes its result', async () => {
    const loadResult = result();
    const connection = { query: vi.fn(async () => loadResult) };

    await loadLadybugFts(connection as never);

    expect(connection.query).toHaveBeenCalledWith('LOAD FTS');
    expect(loadResult.close).toHaveBeenCalledOnce();
  });

  it('uses the cached extension without attempting a network install', async () => {
    const loadResult = result();
    const connection = { query: vi.fn(async () => loadResult) };

    await bootstrapLadybugFts(connection as never);

    expect(connection.query.mock.calls.map(([query]) => query)).toEqual(['LOAD FTS']);
    expect(loadResult.close).toHaveBeenCalledOnce();
  });

  it('installs only after a cache miss and reports a clear bootstrap error', async () => {
    const installResult = result();
    const connection = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error('extension cache missing'))
        .mockResolvedValueOnce(installResult)
        .mockRejectedValueOnce(new Error('extension load still failed')),
    };

    await expect(bootstrapLadybugFts(connection as never)).rejects.toThrow(
      /Ladybug FTS bootstrap failed.*extension load still failed/i,
    );
    expect(connection.query.mock.calls.map(([query]) => query)).toEqual(['LOAD FTS', 'INSTALL FTS', 'LOAD FTS']);
    expect(installResult.close).toHaveBeenCalledOnce();
  });
});

describe('LadybugDriver.runTimedReadQuery', () => {
  class TimeoutRecordingDriver extends LadybugDriver {
    readonly timeouts: number[] = [];

    protected override createConnection(database: Database): Connection {
      const connection = super.createConnection(database);
      const original = connection.setQueryTimeout.bind(connection);
      (connection as { setQueryTimeout: (timeoutInMs: number) => void }).setQueryTimeout = (
        timeoutInMs: number,
      ): void => {
        this.timeouts.push(timeoutInMs);
        original(timeoutInMs);
      };
      return connection;
    }
  }

  async function withDriver<T>(
    budgets: { queryTimeoutMs?: number } | undefined,
    run: (driver: TimeoutRecordingDriver) => Promise<T>,
  ): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-driver-timed-'));
    const driver = new TimeoutRecordingDriver(join(root, 'graph.lbug'), {
      readOnly: false,
      ...(budgets ? { budgets } : {}),
    });
    try {
      await driver.initialize();
      return await run(driver);
    } finally {
      await driver.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('exposes column names and rows and restores the configured timeout budget', async () => {
    await withDriver({ queryTimeoutMs: 2_500 }, async (driver) => {
      driver.timeouts.length = 0;
      const seen = await driver.runTimedReadQuery('RETURN 1 AS one, 2 AS two', {}, 5_000, async (columns, rows) => {
        const collected: Array<Record<string, unknown>> = [];
        for await (const row of rows) collected.push(row);
        return { columns, collected };
      });

      expect(seen.columns).toEqual(['one', 'two']);
      expect(seen.collected).toEqual([{ one: 1, two: 2 }]);
      expect(driver.timeouts).toEqual([5_000, 2_500]);
    });
  });

  it('restores the no-timeout sentinel when no budget is configured, even after a failure', async () => {
    await withDriver(undefined, async (driver) => {
      driver.timeouts.length = 0;
      await expect(
        driver.runTimedReadQuery('RETURN 1 AS one', {}, 5_000, async () => {
          throw new Error('consumer exploded');
        }),
      ).rejects.toThrow('consumer exploded');

      expect(driver.timeouts).toEqual([5_000, LADYBUG_NO_QUERY_TIMEOUT_MS]);
    });
  });

  it('rejects a non-positive timeout before touching the connection', async () => {
    await withDriver(undefined, async (driver) => {
      driver.timeouts.length = 0;
      await expect(driver.runTimedReadQuery('RETURN 1 AS one', {}, 0, async () => undefined)).rejects.toThrow(
        /query timeout must be a positive safe integer/i,
      );
      expect(driver.timeouts).toEqual([]);
    });
  });
});
