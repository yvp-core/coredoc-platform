import { createRequire } from 'node:module';
import type { Connection, Database, PreparedStatement, QueryResult } from '@ladybugdb/core';
import { GraphFileReadOnlyError } from '../errors.js';
import type { ITransaction } from '../types.js';
import { getLadybugSchemaStatements } from './schema.js';

// Deliberate lazy load: @ladybugdb/core dlopens its native lbugjs.node on
// require, so a static value import would run that load in any host that
// merely bundles or imports this module — hosts that never open a Ladybug
// database (the packaged desktop app on the SQLite backend) must not pay or
// crash on it. Same rule as neo4j/driver.ts: externalized/native deps load
// via createRequire at first real use, where the dependency is guaranteed
// present.
const nodeRequire = createRequire(import.meta.url);
let ladybugCore: typeof import('@ladybugdb/core') | null = null;

function loadLadybugCore(): typeof import('@ladybugdb/core') {
  ladybugCore ??= nodeRequire('@ladybugdb/core') as typeof import('@ladybugdb/core');
  return ladybugCore;
}

const GIBIBYTE = 1024 ** 3;

export interface LadybugBudgets {
  maxDbSizeBytes: number;
  bufferPoolBytes: number;
  queryTimeoutMs?: number;
}

export type LadybugBudgetOverrides = Partial<LadybugBudgets>;

export const READ_ONLY_LADYBUG_BUDGETS: Readonly<LadybugBudgets> = Object.freeze({
  maxDbSizeBytes: 8 * GIBIBYTE,
  bufferPoolBytes: 256 * 1024 ** 2,
});

export const READ_WRITE_LADYBUG_BUDGETS: Readonly<LadybugBudgets> = Object.freeze({
  maxDbSizeBytes: 16 * GIBIBYTE,
  bufferPoolBytes: GIBIBYTE,
});

function assertPowerOfTwoBytes(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Ladybug ${label} must be a positive safe integer, got ${value}`);
  }

  const integer = BigInt(value);
  if ((integer & (integer - 1n)) !== 0n) {
    throw new Error(`Ladybug ${label} must be a power of two, got ${value}`);
  }
}

export function resolveLadybugBudgets(readOnly: boolean, overrides: LadybugBudgetOverrides = {}): LadybugBudgets {
  const defaults = readOnly ? READ_ONLY_LADYBUG_BUDGETS : READ_WRITE_LADYBUG_BUDGETS;
  const budgets = { ...defaults, ...overrides };

  assertPowerOfTwoBytes('maxDBSize', budgets.maxDbSizeBytes);
  assertPowerOfTwoBytes('buffer pool size', budgets.bufferPoolBytes);
  if (
    budgets.queryTimeoutMs !== undefined &&
    (!Number.isSafeInteger(budgets.queryTimeoutMs) || budgets.queryTimeoutMs <= 0)
  ) {
    throw new Error(`Ladybug query timeout must be a positive safe integer, got ${budgets.queryTimeoutMs}`);
  }

  return budgets;
}

type LadybugRow = Record<string, unknown>;
type LadybugQueryOutput = QueryResult | QueryResult[];
type LadybugCloseable = { close(): Promise<void> };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeQueryResults(output: LadybugQueryOutput): QueryResult[] {
  const results = Array.isArray(output) ? output : [output];
  if (results.length === 0) {
    throw new Error('Ladybug returned no QueryResult for an executed statement');
  }
  return results;
}

function closeQueryResults(results: readonly QueryResult[]): unknown[] {
  const failures: unknown[] = [];
  for (const result of results) {
    try {
      result.close();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function throwCleanupFailures(failures: readonly unknown[], context: string): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `${context}: ${failures.map(errorMessage).join('; ')}`);
}

async function consumeRows(output: LadybugQueryOutput): Promise<LadybugRow[]> {
  const results = normalizeQueryResults(output);
  let rows: LadybugRow[] | undefined;
  let consumeFailure: unknown;
  let cleanupFailures: unknown[] = [];
  try {
    rows = (await (results[results.length - 1] as QueryResult).getAll()) as LadybugRow[];
  } catch (error) {
    consumeFailure = error;
  } finally {
    cleanupFailures = closeQueryResults(results);
  }

  if (consumeFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [consumeFailure, ...cleanupFailures],
        `Ladybug query consumption failed: ${errorMessage(consumeFailure)}; result cleanup also failed`,
      );
    }
    throw consumeFailure;
  }
  throwCleanupFailures(cleanupFailures, 'Ladybug QueryResult cleanup failed');
  return rows as LadybugRow[];
}

export async function queryLadybugRows<T extends LadybugRow = LadybugRow>(
  connection: Connection,
  query: string,
): Promise<T[]> {
  return (await consumeRows(await connection.query(query))) as T[];
}

export async function executeLadybugRows<T extends LadybugRow = LadybugRow>(
  connection: Connection,
  statement: PreparedStatement,
  params: Record<string, unknown>,
): Promise<T[]> {
  return (await consumeRows(await connection.execute(statement, params as never))) as T[];
}

export async function runLadybugEffect(connection: Connection, query: string): Promise<void> {
  const results = normalizeQueryResults(await connection.query(query));
  throwCleanupFailures(closeQueryResults(results), 'Ladybug effect QueryResult cleanup failed');
}

export async function* streamLadybugRows<T extends LadybugRow = LadybugRow>(
  connection: Connection,
  query: string,
): AsyncGenerator<T> {
  yield* streamLadybugQueryOutput<T>(await connection.query(query));
}

export async function* streamLadybugExecutedRows<T extends LadybugRow = LadybugRow>(
  connection: Connection,
  statement: PreparedStatement,
  params: Record<string, unknown>,
): AsyncGenerator<T> {
  yield* streamLadybugQueryOutput<T>(await connection.execute(statement, params as never));
}

async function* streamLadybugQueryOutput<T extends LadybugRow = LadybugRow>(
  output: LadybugQueryOutput,
): AsyncGenerator<T> {
  const results = normalizeQueryResults(output);
  let iterationFailure: unknown;
  let cleanupFailures: unknown[] = [];
  try {
    const result = results[results.length - 1] as QueryResult;
    while (result.hasNext()) {
      const row = (await result.getNext()) as LadybugRow | null;
      if (row !== null) yield row as T;
    }
  } catch (error) {
    iterationFailure = error;
  } finally {
    cleanupFailures = closeQueryResults(results);
  }
  if (iterationFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [iterationFailure, ...cleanupFailures],
        `Ladybug result streaming failed: ${errorMessage(iterationFailure)}; result cleanup also failed`,
      );
    }
    throw iterationFailure;
  }
  throwCleanupFailures(cleanupFailures, 'Ladybug streaming QueryResult cleanup failed');
}

/**
 * Iterate one already-executed QueryResult WITHOUT closing it — the caller owns
 * the result lifecycle. `streamLadybugQueryOutput` closes on its own finally,
 * which is right for a generator handed straight to a consumer, but wrong when
 * the result must also survive a `getColumnNames()` read and be closed
 * deterministically even if the consumer never pulls a row.
 */
async function* iterateQueryResultRows<T extends LadybugRow = LadybugRow>(result: QueryResult): AsyncGenerator<T> {
  while (result.hasNext()) {
    const row = (await result.getNext()) as LadybugRow | null;
    if (row !== null) yield row as T;
  }
}

/**
 * Reset value for a per-query timeout override.
 *
 * `@ladybugdb/core`'s `Connection.setQueryTimeout(timeoutInMs)` documents no
 * "unset"/no-timeout representation (see `lbug.d.ts`), so a driver with no
 * configured `queryTimeoutMs` budget is restored to a sentinel large enough to
 * be indistinguishable from unbounded (~24.9 days) rather than left carrying
 * the short per-query bound.
 */
export const LADYBUG_NO_QUERY_TIMEOUT_MS = 2 ** 31 - 1;

export function configureLadybugConnection(
  connection: Pick<Connection, 'setQueryTimeout'>,
  budgets: LadybugBudgets,
): void {
  if (budgets.queryTimeoutMs !== undefined) {
    connection.setQueryTimeout(budgets.queryTimeoutMs);
  }
}

export async function closeLadybugResources(
  connection: LadybugCloseable | null,
  database: LadybugCloseable | null,
): Promise<void> {
  const failures: unknown[] = [];
  if (connection) {
    try {
      await connection.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (database) {
    try {
      await database.close();
    } catch (error) {
      failures.push(error);
    }
  }
  throwCleanupFailures(failures, 'Ladybug connection cleanup failed');
}

export async function loadLadybugFts(connection: Connection): Promise<void> {
  try {
    await runLadybugEffect(connection, 'LOAD FTS');
  } catch (error) {
    throw new Error(`Ladybug FTS load failed: ${errorMessage(error)}`, { cause: error });
  }
}

export async function bootstrapLadybugFts(connection: Connection): Promise<void> {
  try {
    await loadLadybugFts(connection);
    return;
  } catch {
    // Local writers provision a missing cache on first use. Artifact/server
    // paths pass `load` explicitly and remain offline at runtime.
  }
  try {
    await runLadybugEffect(connection, 'INSTALL FTS');
    await loadLadybugFts(connection);
  } catch (error) {
    throw new Error(`Ladybug FTS bootstrap failed: ${errorMessage(error)}`, { cause: error });
  }
}

async function initializeLadybugSchema(connection: Connection): Promise<void> {
  for (const statement of getLadybugSchemaStatements()) {
    try {
      await runLadybugEffect(connection, statement);
    } catch (error) {
      throw new Error(`Ladybug schema initialization failed for ${statement}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

export type LadybugFtsMode = 'load' | 'bootstrap';

export interface LadybugDriverOptions {
  readOnly: boolean;
  budgets?: LadybugBudgetOverrides;
  ftsMode?: LadybugFtsMode;
  initializeSchema?: boolean;
}

/** The sole raw Ladybug Database construction site. */
function createLadybugDatabase(path: string, readOnly: boolean, budgets: LadybugBudgets): Database {
  const { Database } = loadLadybugCore();
  return new Database(
    path,
    budgets.bufferPoolBytes,
    /* enableCompression */ true,
    readOnly,
    budgets.maxDbSizeBytes,
    /* autoCheckpoint */ true,
  );
}

class LadybugTransaction implements ITransaction {
  constructor(private readonly connection: Connection) {}

  async run<T = unknown>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    if (!params || Object.keys(params).length === 0) {
      return queryLadybugRows<T & LadybugRow>(this.connection, query) as Promise<T[]>;
    }
    const statement = await this.connection.prepare(query);
    return executeLadybugRows<T & LadybugRow>(this.connection, statement, params) as Promise<T[]>;
  }
}

export class LadybugDriver {
  readonly backend = 'ladybug';
  readonly readOnly: boolean;
  readonly budgets: LadybugBudgets;

  private readonly path: string;
  private readonly ftsMode: LadybugFtsMode;
  private readonly shouldInitializeSchema: boolean;
  private database: Database | null = null;
  private connection: Connection | null = null;
  private initialized = false;
  private closed = false;
  private closing = false;
  private initializationPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(path: string, options: LadybugDriverOptions) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('Ladybug database path must be a non-empty string');
    }
    if (options.readOnly && options.initializeSchema) {
      throw new Error('Cannot initialize the Ladybug schema through a read-only driver');
    }

    this.path = path;
    this.readOnly = options.readOnly;
    this.budgets = resolveLadybugBudgets(options.readOnly, options.budgets);
    this.ftsMode = options.ftsMode ?? (options.readOnly ? 'load' : 'bootstrap');
    this.shouldInitializeSchema = options.initializeSchema ?? !options.readOnly;
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializationPromise) return this.initializationPromise;
    if (this.closed || this.closing) return Promise.reject(new Error('Ladybug driver is closed'));

    this.initializationPromise = this.initializeResources().finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  protected createConnection(database: Database): Connection {
    const { Connection } = loadLadybugCore();
    return new Connection(database);
  }

  private async initializeResources(): Promise<void> {
    let database: Database | null = null;
    let connection: Connection | null = null;

    try {
      database = createLadybugDatabase(this.path, this.readOnly, this.budgets);
      // Register ownership before constructing the connection: native
      // connection construction can throw after the Database allocated its
      // file handle, and close() must still be able to retry cleanup.
      this.database = database;
      connection = this.createConnection(database);
      this.connection = connection;
      await database.init();
      await connection.init();
      configureLadybugConnection(connection, this.budgets);
      if (this.ftsMode === 'bootstrap') await bootstrapLadybugFts(connection);
      else await loadLadybugFts(connection);
      if (this.shouldInitializeSchema) await initializeLadybugSchema(connection);
      this.initialized = true;
    } catch (error) {
      let cleanupError: unknown;
      try {
        await closeLadybugResources(connection, database);
      } catch (failure) {
        cleanupError = failure;
      }
      if (cleanupError === undefined) {
        this.database = null;
        this.connection = null;
        this.closed = true;
      }
      if (cleanupError !== undefined) {
        // Keep the native references reachable so the public factory can retry
        // cleanup before it loses ownership of this failed driver instance.
        throw new AggregateError(
          [error, cleanupError],
          `Ladybug initialization failed: ${errorMessage(error)}; cleanup also failed`,
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.closing = true;
    const initialization = this.initializationPromise;
    this.closePromise = (async () => {
      try {
        if (initialization) {
          try {
            await initialization;
          } catch {
            if (this.closed) return;
          }
        }
        await this.operationTail;
        if (this.closed) return;
        const connection = this.connection;
        const database = this.database;
        await closeLadybugResources(connection, database);
        this.closed = true;
        this.initialized = false;
        this.connection = null;
        this.database = null;
      } finally {
        this.closing = false;
        this.closePromise = null;
      }
    })();
    return this.closePromise;
  }

  async withReadTransaction<T>(fn: (transaction: ITransaction) => Promise<T>): Promise<T> {
    const connection = this.requireConnection();
    return this.serialize(() => fn(new LadybugTransaction(connection)));
  }

  async withWriteTransaction<T>(fn: (transaction: ITransaction) => Promise<T>): Promise<T> {
    if (this.readOnly) {
      throw new GraphFileReadOnlyError('ladybug');
    }
    const connection = this.requireConnection();
    return this.serialize(async () => {
      await runLadybugEffect(connection, 'BEGIN TRANSACTION');
      try {
        const value = await fn(new LadybugTransaction(connection));
        await runLadybugEffect(connection, 'COMMIT');
        return value;
      } catch (error) {
        try {
          await runLadybugEffect(connection, 'ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Ladybug write transaction failed: ${errorMessage(error)}; rollback also failed`,
          );
        }
        throw error;
      }
    });
  }

  async executeBatch<T>(
    items: T[],
    handler: (batch: T[], transaction: ITransaction) => Promise<void>,
    batchSize = 500,
  ): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error(`Ladybug batch size must be a positive safe integer, got ${batchSize}`);
    }
    if (items.length === 0) return 0;

    return this.withWriteTransaction(async (transaction) => {
      let processed = 0;
      for (let index = 0; index < items.length; index += batchSize) {
        const batch = items.slice(index, index + batchSize);
        await handler(batch, transaction);
        processed += batch.length;
      }
      return processed;
    });
  }

  async checkpoint(): Promise<void> {
    if (this.readOnly) throw new GraphFileReadOnlyError('ladybug');
    const connection = this.requireConnection();
    await this.serialize(() => runLadybugEffect(connection, 'CHECKPOINT'));
  }

  async *streamReadRows<T extends LadybugRow = LadybugRow>(
    query: string,
    params: Record<string, unknown> = {},
  ): AsyncGenerator<T> {
    const connection = this.requireConnection();
    const release = await this.acquireOperation();
    try {
      if (Object.keys(params).length === 0) {
        yield* streamLadybugRows<T>(connection, query);
      } else {
        const statement = await connection.prepare(query);
        yield* streamLadybugExecutedRows<T>(connection, statement, params);
      }
    } finally {
      release();
    }
  }

  /**
   * Run one read query under a query-scoped timeout and hand the consumer the
   * column names plus a row iterator.
   *
   * The timeout is set on the SHARED connection and reset inside the same
   * `serialize()` operation, so it can never leak into another read: all reads
   * go through the operation chain, and the reset runs before the lock is
   * released. A second Connection would skip the `close()` drain and run
   * concurrently with checkpoints, so it is deliberately not used.
   *
   * The QueryResult is closed here (not by the iterator), so an unconsumed or
   * partially consumed stream still releases the native result.
   */
  async runTimedReadQuery<R, T extends LadybugRow = LadybugRow>(
    query: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    consume: (columns: string[], rows: AsyncGenerator<T>) => Promise<R>,
  ): Promise<R> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Ladybug query timeout must be a positive safe integer, got ${timeoutMs}`);
    }
    const connection = this.requireConnection();
    return this.serialize(async () => {
      connection.setQueryTimeout(timeoutMs);
      try {
        const output =
          Object.keys(params).length === 0
            ? await connection.query(query)
            : await connection.execute(await connection.prepare(query), params as never);
        const results = normalizeQueryResults(output);
        const result = results[results.length - 1] as QueryResult;
        let value: R | undefined;
        let consumeFailure: unknown;
        let cleanupFailures: unknown[] = [];
        try {
          value = await consume(await result.getColumnNames(), iterateQueryResultRows<T>(result));
        } catch (error) {
          consumeFailure = error;
        } finally {
          cleanupFailures = closeQueryResults(results);
        }
        if (consumeFailure !== undefined) {
          if (cleanupFailures.length > 0) {
            throw new AggregateError(
              [consumeFailure, ...cleanupFailures],
              `Ladybug timed read failed: ${errorMessage(consumeFailure)}; result cleanup also failed`,
            );
          }
          throw consumeFailure;
        }
        throwCleanupFailures(cleanupFailures, 'Ladybug timed read QueryResult cleanup failed');
        return value as R;
      } finally {
        connection.setQueryTimeout(this.budgets.queryTimeoutMs ?? LADYBUG_NO_QUERY_TIMEOUT_MS);
      }
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireOperation();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acquireOperation(): Promise<() => void> {
    const previous = this.operationTail;
    let release: () => void = () => undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private requireConnection(): Connection {
    if (!this.initialized || !this.connection || this.closed || this.closing) {
      throw new Error('Ladybug driver is not initialized');
    }
    return this.connection;
  }
}

export async function openLadybugDriver(path: string, options: LadybugDriverOptions): Promise<LadybugDriver> {
  const driver = new LadybugDriver(path, options);
  try {
    await driver.initialize();
    return driver;
  } catch (error) {
    try {
      await driver.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Ladybug open failed: ${errorMessage(error)}; cleanup retry also failed`,
      );
    }
    throw error;
  }
}
