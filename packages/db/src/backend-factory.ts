/**
 * Database Backend Factory
 *
 * Creates the appropriate database driver and repository based on configuration.
 * Supports Neo4j, SQLite, and Ladybug backends.
 */

import type { IDatabaseDriver, IGraphRepository, DatabaseBackend, ProjectFileBackend } from './types.js';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { projectDbPath, projectDbUrl } from '@coredoc/core/utils';
import { SqliteDriver, POOLED_CACHE_SIZE_KB } from './sqlite/driver.js';
import { SqliteRepository } from './sqlite/repository.js';
import { SqliteOperationsRepository } from './sqlite/operations-repository.js';
import { McpMetricsRepository } from './sqlite/mcp-metrics-repository.js';

// =============================================================================
// Module State
// =============================================================================

let currentDriver: IDatabaseDriver | null = null;
let currentRepository: IGraphRepository | null = null;
let currentBackend: DatabaseBackend | null = null;
let currentLadybugLease: LadybugLease | null = null;

// Operations always use SQL (SQLite). When the graph backend is also SQLite,
// the ops repo shares the same driver. Other graph engines lazily create a
// dedicated SQLite driver for operations only.
let opsOnlyDriver: SqliteDriver | null = null; // Only used when graph backend != sqlite
let currentOpsRepo: SqliteOperationsRepository | null = null;

// =============================================================================
// Configuration
// =============================================================================

/**
 * Get the configured database backend.
 * Reads from COREDOC_DB_BACKEND environment variable.
 * Defaults to 'sqlite' as it's the self-contained option.
 */
export function getConfiguredBackend(): DatabaseBackend {
  const backend = process.env.COREDOC_DB_BACKEND?.trim().toLowerCase();
  if (!backend || backend === 'sqlite') {
    return 'sqlite';
  }
  if (backend === 'neo4j') {
    return 'neo4j';
  }
  if (backend === 'ladybug') {
    return 'ladybug';
  }
  throw new Error(
    `Unsupported COREDOC_DB_BACKEND "${process.env.COREDOC_DB_BACKEND}". ` + 'Expected one of: sqlite, ladybug, neo4j.',
  );
}

function assertRegularLadybugPath(path: string): string {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) {
    throw new Error(
      `Refusing to use Ladybug database "${path}" because it is a symbolic link. ` +
        'Replace it with a real file inside the coredoc workspace.',
    );
  }
  return path;
}

function projectLadybugPath(configDir: string, projectId: string): string {
  return assertRegularLadybugPath(projectDbPath(configDir, projectId).replace(/\.db$/, '.lbdb'));
}

function getLadybugPath(): string {
  const path = process.env.COREDOC_LADYBUG_PATH;
  if (!path) {
    throw new Error(
      'COREDOC_LADYBUG_PATH is not set. Bind a project database first ' +
        '(for example with `coredoc push --project <id>`).',
    );
  }
  return assertRegularLadybugPath(path);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contextualizeLadybugOpenError(error: unknown, path: string): unknown {
  if (!/could not set lock|lock on file|database.*locked/i.test(errorText(error))) return error;
  return new Error(
    `Ladybug graph "${path}" is already open. Stop the local Coredoc MCP process, retry the push, ` +
      'then restart MCP.',
    { cause: error },
  );
}

interface LadybugLease {
  release(): void;
}

type LadybugLeaseMode = 'read' | 'write';

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function activeWriterLease(path: string): boolean {
  const lockPath = `${path}.writer.lock`;
  const entry = lstatSync(lockPath, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink()) return true;

  let ownerPid = Number.NaN;
  try {
    ownerPid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
  } catch {
    return true;
  }
  if (pidIsAlive(ownerPid)) return true;
  unlinkIfPresent(lockPath);
  return false;
}

function activeReaderLeases(path: string): string[] {
  const readersPath = `${path}.readers`;
  const entry = lstatSync(readersPath, { throwIfNoEntry: false });
  if (!entry) return [];
  if (!entry.isDirectory() || entry.isSymbolicLink()) return [readersPath];

  const active: string[] = [];
  for (const name of readdirSync(readersPath)) {
    const markerPath = join(readersPath, name);
    const marker = lstatSync(markerPath, { throwIfNoEntry: false });
    const ownerPid = Number.parseInt(name.split('-', 1)[0] ?? '', 10);
    if (!marker?.isFile() || marker.isSymbolicLink() || pidIsAlive(ownerPid)) {
      active.push(markerPath);
      continue;
    }
    unlinkIfPresent(markerPath);
  }
  try {
    rmdirSync(readersPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
  return active;
}

function ladybugLeaseError(path: string, mode: LadybugLeaseMode): Error {
  return mode === 'write'
    ? new Error(
        `Ladybug graph "${path}" has active readers. Stop the local Coredoc MCP process, retry the push, ` +
          'then restart MCP.',
      )
    : new Error(`Ladybug graph "${path}" is being updated. Retry after the local push completes.`);
}

/**
 * Coordinate the local CLI writer and MCP readers explicitly. Ladybug's file
 * lock is process-scoped on supported local platforms, so it does not reject
 * every unsafe RW+RO combination itself. The create/check/recheck protocol
 * closes the race between a reader marker and the exclusive writer marker.
 */
function acquireLadybugLease(path: string, mode: LadybugLeaseMode): LadybugLease {
  const writerPath = `${path}.writer.lock`;
  if (mode === 'write') {
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
      try {
        writeFileSync(writerPath, String(process.pid), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || activeWriterLease(path)) {
          throw ladybugLeaseError(path, mode);
        }
      }
    }
    if (!acquired) throw ladybugLeaseError(path, mode);

    if (activeReaderLeases(path).length > 0) {
      unlinkIfPresent(writerPath);
      throw ladybugLeaseError(path, mode);
    }
    return { release: () => unlinkIfPresent(writerPath) };
  }

  if (activeWriterLease(path)) throw ladybugLeaseError(path, mode);
  const readersPath = `${path}.readers`;
  const readersEntry = lstatSync(readersPath, { throwIfNoEntry: false });
  if (readersEntry?.isSymbolicLink() || (readersEntry && !readersEntry.isDirectory())) {
    throw ladybugLeaseError(path, mode);
  }
  mkdirSync(readersPath, { recursive: true, mode: 0o700 });
  const markerPath = join(readersPath, `${process.pid}-${randomUUID()}.lock`);
  writeFileSync(markerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const release = (): void => {
    unlinkIfPresent(markerPath);
    try {
      rmdirSync(readersPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
    }
  };
  if (activeWriterLease(path)) {
    release();
    throw ladybugLeaseError(path, mode);
  }
  return { release };
}

interface CheckpointableLadybugDriver extends IDatabaseDriver {
  readonly readOnly: boolean;
  checkpoint(): Promise<void>;
}

async function closeGraphDriver(driver: IDatabaseDriver, backend: DatabaseBackend): Promise<unknown | undefined> {
  let checkpointFailure: unknown;
  if (backend === 'ladybug' && !(driver as CheckpointableLadybugDriver).readOnly) {
    try {
      await (driver as CheckpointableLadybugDriver).checkpoint();
    } catch (error) {
      checkpointFailure = error;
    }
  }

  try {
    await driver.close();
  } catch (closeFailure) {
    if (checkpointFailure !== undefined) {
      throw new AggregateError([checkpointFailure, closeFailure], 'Ladybug checkpoint and close both failed');
    }
    throw closeFailure;
  }
  return checkpointFailure;
}

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Get or create the database driver.
 * Initializes the driver if not already done.
 *
 * @param backend - Optional backend override (uses env var if not provided)
 */
export async function getDriver(backend?: DatabaseBackend): Promise<IDatabaseDriver> {
  const targetBackend = backend || getConfiguredBackend();

  // Return existing driver if same backend
  if (currentDriver && currentBackend === targetBackend) {
    return currentDriver;
  }

  // Close existing driver if switching backends
  if (currentDriver && currentBackend && currentBackend !== targetBackend) {
    // If ops repo was sharing the sqlite graph driver, invalidate it
    if (currentBackend === 'sqlite' && !opsOnlyDriver) {
      currentOpsRepo = null;
    }
    const previousDriver = currentDriver;
    const previousBackend = currentBackend;
    const previousLease = currentLadybugLease;
    const checkpointFailure = await closeGraphDriver(previousDriver, previousBackend);
    currentDriver = null;
    currentRepository = null;
    currentBackend = null;
    currentLadybugLease = null;
    const cleanupFailures: unknown[] = checkpointFailure === undefined ? [] : [checkpointFailure];
    try {
      previousLease?.release();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (targetBackend === 'sqlite' && opsOnlyDriver) {
      try {
        await closeOperationsDriver();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    throwCleanupFailures(cleanupFailures, 'Database backend switch cleanup failed');
  }

  // Create and initialize before publishing module state. A failed Ladybug open
  // (most commonly an MCP read lock) must not cache a closed driver and poison
  // a same-process retry after the reader exits.
  let nextDriver: IDatabaseDriver;
  let ladybugPath: string | undefined;
  let ladybugLease: LadybugLease | undefined;
  if (targetBackend === 'sqlite') {
    nextDriver = new SqliteDriver();
  } else if (targetBackend === 'ladybug') {
    ladybugPath = getLadybugPath();
    mkdirSync(dirname(ladybugPath), { recursive: true });
    ladybugLease = acquireLadybugLease(ladybugPath, 'write');
    try {
      const { LadybugDriver } = await import('./ladybug/driver.js');
      nextDriver = new LadybugDriver(ladybugPath, {
        readOnly: false,
        ftsMode: 'bootstrap',
        initializeSchema: true,
      });
    } catch (error) {
      ladybugLease.release();
      throw error;
    }
  } else {
    const { Neo4jDriver } = await import('./neo4j/driver.js');
    nextDriver = new Neo4jDriver();
  }

  try {
    await nextDriver.initialize();
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await nextDriver.close();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length === 0) {
      try {
        ladybugLease?.release();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    const openError =
      targetBackend === 'ladybug' && ladybugPath ? contextualizeLadybugOpenError(error, ladybugPath) : error;
    if (cleanupFailures.length > 0) {
      throw new AggregateError([openError, ...cleanupFailures], 'Database initialization and cleanup failed');
    }
    throw openError;
  }

  currentDriver = nextDriver;
  currentBackend = targetBackend;
  currentLadybugLease = ladybugLease ?? null;
  return nextDriver;
}

/**
 * Get or create the graph repository.
 * Initializes the driver if not already done.
 *
 * @param backend - Optional backend override (uses env var if not provided)
 */
export async function getRepository(backend?: DatabaseBackend): Promise<IGraphRepository> {
  const targetBackend = backend || getConfiguredBackend();

  // Get driver first (may create/switch)
  const driver = await getDriver(targetBackend);

  // Return existing repository if same backend
  if (currentRepository && currentBackend === targetBackend) {
    return currentRepository;
  }

  // Create new repository
  if (targetBackend === 'sqlite') {
    currentRepository = new SqliteRepository(driver);
  } else if (targetBackend === 'ladybug') {
    const { LadybugRepository } = await import('./ladybug/repository.js');
    const { LadybugDriver } = await import('./ladybug/driver.js');
    currentRepository = new LadybugRepository(driver as InstanceType<typeof LadybugDriver>);
  } else {
    const { Neo4jRepository } = await import('./neo4j/repository.js');
    const { Neo4jDriver: Neo4jDriverClass } = await import('./neo4j/driver.js');
    currentRepository = new Neo4jRepository(driver as InstanceType<typeof Neo4jDriverClass>);
  }

  return currentRepository;
}

/**
 * Get or create the operations repository.
 *
 * When the graph backend is SQLite, the ops repo shares the same driver
 * (single connection, no busy errors). For other graph engines,
 * we create a dedicated SQLite driver for operations.
 */
export async function getOperationsRepository(): Promise<SqliteOperationsRepository> {
  // If graph backend is SQLite, reuse its driver for operations
  if (currentBackend === 'sqlite' && currentDriver) {
    if (!currentOpsRepo) {
      currentOpsRepo = new SqliteOperationsRepository(currentDriver);
    }
    return currentOpsRepo;
  }

  // A non-SQLite graph backend (or an uninitialized graph) uses dedicated SQLite.
  if (currentOpsRepo && opsOnlyDriver) {
    return currentOpsRepo;
  }

  opsOnlyDriver = new SqliteDriver();
  await opsOnlyDriver.initialize();
  currentOpsRepo = new SqliteOperationsRepository(opsOnlyDriver);
  return currentOpsRepo;
}

/**
 * Close the current graph driver and release resources.
 * If the ops repo was sharing this driver, it is also invalidated.
 */
export async function closeDriver(): Promise<void> {
  if (currentDriver) {
    const driver = currentDriver;
    const backend = currentBackend as DatabaseBackend;
    const ladybugLease = currentLadybugLease;
    // If ops repo was sharing the graph driver, clear it (don't double-close)
    if (driver instanceof SqliteDriver && !opsOnlyDriver) {
      currentOpsRepo = null;
    }
    const checkpointFailure = await closeGraphDriver(driver, backend);
    currentDriver = null;
    currentRepository = null;
    currentBackend = null;
    currentLadybugLease = null;
    const cleanupFailures: unknown[] = checkpointFailure === undefined ? [] : [checkpointFailure];
    try {
      ladybugLease?.release();
    } catch (error) {
      cleanupFailures.push(error);
    }
    throwCleanupFailures(cleanupFailures, 'Database cleanup failed');
  }
}

/**
 * Close the dedicated operations-only SQLite driver used by non-SQLite graphs.
 */
export async function closeOperationsDriver(): Promise<void> {
  if (opsOnlyDriver) {
    const driver = opsOnlyDriver;
    await driver.close();
    if (opsOnlyDriver === driver) {
      opsOnlyDriver = null;
      currentOpsRepo = null;
    }
  }
}

/**
 * Close all drivers (graph + dedicated operations).
 */
export async function closeAllDrivers(): Promise<void> {
  // Clear ops repo first so closeDriver doesn't try to double-clear
  const hadOpsOnly = !!opsOnlyDriver;
  if (!hadOpsOnly) {
    currentOpsRepo = null;
  }
  const results = await Promise.allSettled([closeDriver(), closeOperationsDriver()]);
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Database cleanup failed');
}

/**
 * Build and publish a complete project-owned Ladybug file while holding the
 * same writer lease used by ordinary local pushes. The callback must finish
 * every validation and close the candidate before returning; publication is a
 * same-directory rename, so a failure leaves the previous graph in place.
 */
export async function replaceProjectLadybugGraphFile<T>(
  configDir: string,
  projectId: string,
  build: (candidatePath: string) => Promise<T>,
): Promise<{ graphPath: string; result: T }> {
  // A prior skipClose caller may still own this process's writer marker. Close
  // it before acquiring the replacement lease; operations-only SQLite state is
  // deliberately independent and remains available to the operation tracker.
  await closeDriver();

  const graphPath = projectLadybugPath(configDir, projectId);
  mkdirSync(dirname(graphPath), { recursive: true });
  const lease = acquireLadybugLease(graphPath, 'write');
  const candidatePath = join(dirname(graphPath), `.${basename(graphPath)}.replace-${randomUUID()}`);
  let result!: T;
  let primaryError: unknown;
  let published = false;

  try {
    // Replaying a previous file's WAL against the replacement main file would
    // corrupt the candidate. Refuse before doing expensive work; a clean close
    // of the old writer checkpoints and removes this companion.
    if (existsSync(`${graphPath}.wal`)) {
      throw new Error(
        `Ladybug graph "${graphPath}" has an uncheckpointed WAL. Open and cleanly close the existing graph, then retry.`,
      );
    }

    result = await build(candidatePath);
    const candidate = lstatSync(candidatePath, { throwIfNoEntry: false });
    if (!candidate?.isFile() || candidate.isSymbolicLink()) {
      throw new Error(`Ladybug replacement candidate is not a regular file: ${candidatePath}`);
    }
    if (existsSync(`${candidatePath}.wal`)) {
      throw new Error(`Ladybug replacement candidate still has an uncheckpointed WAL: ${candidatePath}.wal`);
    }
    assertRegularLadybugPath(graphPath);
    renameSync(candidatePath, graphPath);
    published = true;
  } catch (error) {
    primaryError = error;
  }

  const cleanupFailures: unknown[] = [];
  if (!published) {
    try {
      rmSync(candidatePath, { force: true });
      rmSync(`${candidatePath}.wal`, { force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    lease.release();
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (cleanupFailures.length > 0) {
    const failures = primaryError === undefined ? cleanupFailures : [primaryError, ...cleanupFailures];
    throw new AggregateError(
      failures,
      published
        ? 'Ladybug graph was published but writer lease cleanup failed'
        : 'Ladybug graph replacement failed and cleanup also failed',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  return { graphPath, result };
}

// =============================================================================
// Project database connections
// =============================================================================

/**
 * Graph node ids are `{repoHash}:{...}` where the hash covers only the repo
 * name, so two same-named repos in different projects produce identical ids and
 * overwrite each other in a shared file. Isolation therefore lives in the file
 * path: each project gets its own database, and callers reach it through here
 * instead of the process-wide singleton above.
 *
 * Keyed by the canonical derived URL rather than project id because different
 * config directories may reuse the same id while owning different files.
 *
 * Unlike the cloud's per-workspace pool this never evicts. The set of local
 * projects is small and user-visible, and the cloud pool's idle sweep is
 * exactly what closed a driver under a running push in the 2026-05-24 incident
 * documented in `workspace-db-pool.service.ts`. With no eviction there is no
 * lease to forget and no such race to lose.
 */
export interface ProjectDatabase {
  projectId: string;
  url: string;
  backend: ProjectFileBackend;
  graph: IGraphRepository;
  operations: SqliteOperationsRepository;
  metrics: McpMetricsRepository;
}

interface DbConnection extends ProjectDatabase {
  graphDriver: IDatabaseDriver;
  operationsDriver: SqliteDriver;
  ladybugLease?: LadybugLease;
}

const connectionsByUrl = new Map<string, DbConnection>();
/** In-flight opens, so concurrent cold callers never both run the migrations. */
const pendingByUrl = new Map<string, Promise<DbConnection>>();
let closingAllProjectDatabases = false;
let closeProjectDatabasesPromise: Promise<void> | null = null;

async function cleanupOpeningDrivers(
  initialized: IDatabaseDriver[],
  graphDriver: IDatabaseDriver | undefined,
  ladybugLease: LadybugLease | undefined,
): Promise<unknown[]> {
  const drivers = [...initialized].reverse();
  const results = await Promise.allSettled(drivers.map((driver) => driver.close()));
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  const graphIndex = graphDriver ? drivers.indexOf(graphDriver) : -1;
  const graphClosed = graphIndex < 0 || results[graphIndex]?.status === 'fulfilled';
  if (graphClosed) {
    try {
      ladybugLease?.release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function openConnection(
  projectId: string,
  backend: ProjectFileBackend,
  graphPath: string,
  sqliteUrl: string,
  mode: ProjectDatabaseOpenMode,
): Promise<DbConnection> {
  if (closingAllProjectDatabases) {
    throw new Error('Project databases are closing; retry after shutdown completes.');
  }
  const graphUrl = `file:${graphPath}`;
  const cacheKey = backend === 'sqlite' ? graphUrl : `${backend}:${mode}:${graphUrl}`;
  const existing = connectionsByUrl.get(cacheKey);
  if (existing) return existing;

  const pending = pendingByUrl.get(cacheKey);
  if (pending) return pending;

  const opening = (async () => {
    let graphDriver: IDatabaseDriver | undefined;
    let operationsDriver: SqliteDriver | undefined;
    let ladybugLease: LadybugLease | undefined;
    const initialized: IDatabaseDriver[] = [];
    try {
      if (backend === 'sqlite') {
        // A smaller page cache than the single-database default: this pool holds
        // one connection per project and never evicts.
        operationsDriver = new SqliteDriver(sqliteUrl, undefined, { cacheSizeKb: POOLED_CACHE_SIZE_KB });
        graphDriver = operationsDriver;
        initialized.push(graphDriver);
        await graphDriver.initialize();
      } else {
        mkdirSync(dirname(graphPath), { recursive: true });
        ladybugLease = acquireLadybugLease(graphPath, mode === 'read' ? 'read' : 'write');
        const { LadybugDriver } = await import('./ladybug/driver.js');
        graphDriver = new LadybugDriver(graphPath, {
          readOnly: mode === 'read',
          ftsMode: mode === 'read' ? 'load' : 'bootstrap',
          initializeSchema: mode === 'create',
        });
        initialized.push(graphDriver);
        try {
          await graphDriver.initialize();
        } catch (error) {
          throw contextualizeLadybugOpenError(error, graphPath);
        }

        // Operations and MCP metrics remain in SQLite. Keeping this sidecar
        // preserves their mature schema and an immediate SQLite rollback path.
        operationsDriver = new SqliteDriver(sqliteUrl, undefined, { cacheSizeKb: POOLED_CACHE_SIZE_KB });
        initialized.push(operationsDriver);
        await operationsDriver.initialize();
      }
    } catch (error) {
      // `initialize` assigns its libsql client BEFORE the pragmas and
      // migrations that can throw, so a rejection leaves an open connection
      // with no owner: nothing is written to `connectionsByUrl`, and the
      // failure is deliberately not cached, so every retrying caller — each
      // MCP tool call, each desktop graph IPC — would leak another one. A
      // database that fails migrations (locked, corrupt, disk full) is exactly
      // the case that retries hardest.
      const cleanupFailures = await cleanupOpeningDrivers(initialized, graphDriver, ladybugLease);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'Project database initialization and cleanup failed');
      }
      throw error;
    }
    if (!graphDriver || !operationsDriver) {
      throw new Error('Project database initialization completed without both required drivers');
    }
    let graph: IGraphRepository;
    try {
      if (backend === 'sqlite') {
        graph = new SqliteRepository(graphDriver);
      } else {
        const { LadybugRepository } = await import('./ladybug/repository.js');
        const { LadybugDriver } = await import('./ladybug/driver.js');
        graph = new LadybugRepository(graphDriver as InstanceType<typeof LadybugDriver>);
      }
    } catch (error) {
      const cleanupFailures = await cleanupOpeningDrivers(initialized, graphDriver, ladybugLease);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'Project repository initialization and cleanup failed');
      }
      throw error;
    }
    const connection: DbConnection = {
      projectId,
      url: graphUrl,
      backend,
      graphDriver,
      operationsDriver,
      ladybugLease,
      graph,
      operations: new SqliteOperationsRepository(operationsDriver),
      metrics: new McpMetricsRepository(operationsDriver),
    };
    connectionsByUrl.set(cacheKey, connection);
    return connection;
  })().finally(() => {
    pendingByUrl.delete(cacheKey);
  });

  pendingByUrl.set(cacheKey, opening);
  return opening;
}

export type ProjectDatabaseOpenMode = 'create' | 'read';
export interface ProjectDatabaseOpenOptions {
  mode?: ProjectDatabaseOpenMode;
  backend?: ProjectFileBackend;
}

/**
 * Open the SQLite or Ladybug graph database owned by `projectId`.
 *
 * Callers never supply a URL, so a project scope cannot accidentally be paired
 * with another project's file. Read paths use `mode: 'read'` to avoid creating
 * an empty database when the user has not pushed a graph yet.
 */
export async function openProjectDatabase(
  configDir: string,
  projectId: string,
  options: ProjectDatabaseOpenOptions = {},
): Promise<ProjectDatabase> {
  const backend = options.backend ?? 'sqlite';
  const mode = options.mode ?? 'create';
  const sqlitePath = projectDbPath(configDir, projectId);
  const graphPath = backend === 'ladybug' ? projectLadybugPath(configDir, projectId) : sqlitePath;
  if (mode === 'read' && !existsSync(graphPath)) {
    throw new Error(
      `No graph database for project "${projectId}". ` +
        `Run \`coredoc push --config "${configDir}/coredoc.config.json" --project ${projectId}\`.`,
    );
  }
  return openConnection(projectId, backend, graphPath, projectDbUrl(configDir, projectId), mode);
}

/**
 * Bounds the shutdown drain below. Reached only if callers keep opening
 * connections while a close is in progress; the drain then gives up rather
 * than spinning, because this runs on the SIGINT/SIGTERM path and a loop that
 * never settles swallows Ctrl-C.
 */
const MAX_DRAIN_PASSES = 10;

/** Close every pooled connection — app quit and test teardown. */
export function closeProjectDatabases(): Promise<void> {
  if (closeProjectDatabasesPromise) return closeProjectDatabasesPromise;

  closingAllProjectDatabases = true;
  closeProjectDatabasesPromise = (async () => {
    // Settle in-flight opens first. `openConnection` registers the connection
    // AFTER its await, so closing without draining lets a racing open re-register
    // a live driver into a map we just emptied — a connection that survives
    // app-quit and test teardown, holding a file that may already be deleted.
    for (let pass = 0; pendingByUrl.size > 0 && pass < MAX_DRAIN_PASSES; pass++) {
      await Promise.allSettled([...pendingByUrl.values()]);
    }
    const open = [...connectionsByUrl.entries()];
    await Promise.all(
      open.map(async ([cacheKey, connection]) => {
        const failures: unknown[] = [];
        let graphClosed = false;
        try {
          const checkpointFailure = await closeGraphDriver(connection.graphDriver, connection.backend);
          graphClosed = true;
          if (checkpointFailure !== undefined) failures.push(checkpointFailure);
        } catch (error) {
          failures.push(error);
        }
        if (graphClosed) {
          connectionsByUrl.delete(cacheKey);
          try {
            connection.ladybugLease?.release();
          } catch (error) {
            failures.push(error);
          }
          if (connection.operationsDriver !== connection.graphDriver) {
            try {
              await connection.operationsDriver.close();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        throwCleanupFailures(failures, 'Project database cleanup failed');
      }),
    );
  })().finally(() => {
    closingAllProjectDatabases = false;
    closeProjectDatabasesPromise = null;
  });

  return closeProjectDatabasesPromise;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if Neo4j backend is available (dependencies installed and configured).
 */
async function isNeo4jAvailable(): Promise<boolean> {
  try {
    await import('neo4j-driver');
    const password = process.env.NEO4J_PASSWORD;
    return !!password;
  } catch {
    return false;
  }
}

/** Check whether the optional Ladybug native package can be loaded. */
async function isLadybugAvailable(): Promise<boolean> {
  try {
    await import('@ladybugdb/core');
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Exit Handlers
// =============================================================================

let exitHandlersRegistered = false;

/**
 * Register process exit handlers to close the driver cleanly.
 * Safe to call multiple times - subsequent calls are no-ops.
 */
export function registerExitHandlers(): void {
  if (exitHandlersRegistered) {
    return;
  }

  const handleExit = async (signal: string): Promise<void> => {
    try {
      // Pooled per-project connections too: N projects means N WAL files, and an
      // un-checkpointed WAL per project is both disk and crash-recovery surface.
      await Promise.all([closeAllDrivers(), closeProjectDatabases()]);
    } finally {
      // A close failure must not swallow Ctrl-C or leave a terminating process
      // alive indefinitely.
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        process.kill(process.pid, signal);
      }
    }
  };

  // Signals are re-sent after cleanup so Node terminates with the original
  // signal semantics. These listeners must therefore be one-shot: an `on`
  // wrapper survives the re-send and recursively runs cleanup forever.
  process.once('SIGINT', () => handleExit('SIGINT'));
  process.once('SIGTERM', () => handleExit('SIGTERM'));
  process.once('beforeExit', () => handleExit('beforeExit'));

  exitHandlersRegistered = true;
}

/**
 * Check if the configured database backend is available and connectable.
 * @returns true if the database is available, false otherwise
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  const backend = getConfiguredBackend();

  try {
    if (backend === 'sqlite') return true;
    if (backend === 'ladybug') return await isLadybugAvailable();
    if (!(await isNeo4jAvailable())) return false;
    await getDriver('neo4j');
    return true;
  } catch {
    return false;
  }
}
