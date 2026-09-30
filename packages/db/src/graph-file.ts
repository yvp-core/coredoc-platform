import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GraphFileOpenError } from './errors.js';
import { openLadybugDriver, type LadybugDriver } from './ladybug/driver.js';
import { LadybugRepository } from './ladybug/repository.js';
import {
  LADYBUG_EDGE_TYPES,
  LADYBUG_FTS_INDEX_NAME,
  LADYBUG_METADATA_TABLE,
  LADYBUG_NODE_TABLE,
} from './ladybug/schema.js';
import type { IGraphFileValidationRepository, IGraphReadRepository } from './types.js';

export { GraphFileOpenError, GraphFileReadOnlyError, type GraphFileOpenErrorCode } from './errors.js';

export interface GraphFileBudgets {
  maxDbSizeBytes: number;
  bufferPoolBytes: number;
  queryTimeoutMs?: number;
}

export interface GraphFileOptions {
  path: string;
  budgets: GraphFileBudgets;
}

export interface GraphFileHandle<T extends IGraphReadRepository> {
  readonly repository: T;
  close(): Promise<void>;
}

type GraphFileDriver = Pick<LadybugDriver, 'close'>;

async function validateLadybugGraphSchema(driver: LadybugDriver): Promise<void> {
  await driver.withReadTransaction(async (transaction) => {
    const tables = await transaction.run<{ name: string }>('CALL SHOW_TABLES() RETURN name');
    const names = new Set(tables.map(({ name }) => name));
    const required = [LADYBUG_NODE_TABLE, LADYBUG_METADATA_TABLE, ...LADYBUG_EDGE_TYPES];
    const missing = required.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`Ladybug graph schema is missing required tables: ${missing.join(', ')}`);
    }
    await transaction.run(
      `MATCH (n:${LADYBUG_NODE_TABLE}) RETURN n.id, n.type, n.name, n.properties, n.summary, ` +
        'n.embedding, n.repoId, n.filePath, n.startLine, n.endLine LIMIT 0',
    );
    await transaction.run(`MATCH (m:${LADYBUG_METADATA_TABLE}) RETURN m.repoId, m.snapshot LIMIT 0`);
    for (const type of LADYBUG_EDGE_TYPES) {
      await transaction.run(
        `MATCH (:${LADYBUG_NODE_TABLE})-[r:${type}]->(:${LADYBUG_NODE_TABLE}) ` +
          'RETURN r.id, r.confidence, r.createdBy, r.properties LIMIT 0',
      );
    }
    await transaction.run(
      `CALL QUERY_FTS_INDEX('${LADYBUG_NODE_TABLE}', '${LADYBUG_FTS_INDEX_NAME}', '__coredoc_schema_probe__') ` +
        'RETURN node.id LIMIT 0',
    );
  });
}

function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GraphFileOpenError('INVALID_BUDGET', `${label} must be a positive safe integer, got ${String(value)}`);
  }
}

function validateBudgets(budgets: GraphFileBudgets): void {
  assertPositiveSafeInteger('Graph file maxDbSizeBytes', budgets.maxDbSizeBytes);
  assertPositiveSafeInteger('Graph file bufferPoolBytes', budgets.bufferPoolBytes);
  if (budgets.queryTimeoutMs !== undefined) {
    assertPositiveSafeInteger('Graph file queryTimeoutMs', budgets.queryTimeoutMs);
  }
}

async function resolveExistingGraphPath(path: string, maxDbSizeBytes: number): Promise<string> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new GraphFileOpenError('INVALID_PATH', 'Graph file path must be a non-empty string');
  }

  const absolutePath = resolve(path);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_PATH';
    throw new GraphFileOpenError(code, `Graph file does not exist or cannot be inspected: ${absolutePath}`, {
      cause: error,
    });
  }
  if (!metadata.isFile()) {
    throw new GraphFileOpenError('NOT_REGULAR_FILE', `Graph file path is not a regular file: ${absolutePath}`);
  }
  if (metadata.size > maxDbSizeBytes) {
    throw new GraphFileOpenError(
      'FILE_TOO_LARGE',
      `Graph file exceeds maxDbSizeBytes: ${absolutePath} is ${metadata.size} bytes, limit is ${maxDbSizeBytes}`,
    );
  }
  return absolutePath;
}

function createHandle<T extends IGraphReadRepository>(repository: T, driver: GraphFileDriver): GraphFileHandle<T> {
  let closed = false;
  let closePromise: Promise<void> | null = null;

  return {
    repository,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      if (closePromise) return closePromise;
      closePromise = driver
        .close()
        .then(() => {
          closed = true;
        })
        .finally(() => {
          closePromise = null;
        });
      return closePromise;
    },
  };
}

function initializationError(path: string, cause: unknown): GraphFileOpenError {
  if (cause instanceof GraphFileOpenError) return cause;
  return new GraphFileOpenError('INITIALIZATION_FAILED', `Failed to initialize Ladybug graph file: ${path}`, {
    cause,
  });
}

async function closeAfterFailedOpen(driver: GraphFileDriver, path: string, openError: unknown): Promise<never> {
  try {
    await driver.close();
  } catch (cleanupError) {
    throw initializationError(
      path,
      new AggregateError([openError, cleanupError], 'Graph file open failed and cleanup also failed'),
    );
  }
  throw initializationError(path, openError);
}

export async function openGraphFile(
  options: GraphFileOptions,
): Promise<GraphFileHandle<IGraphFileValidationRepository>> {
  validateBudgets(options.budgets);
  const path = await resolveExistingGraphPath(options.path, options.budgets.maxDbSizeBytes);

  let driver: LadybugDriver | undefined;
  try {
    driver = await openLadybugDriver(path, {
      readOnly: true,
      budgets: options.budgets,
      initializeSchema: false,
      ftsMode: 'load',
    });
    await validateLadybugGraphSchema(driver);
    const repository = new LadybugRepository(driver);
    return createHandle(repository, driver);
  } catch (error) {
    if (driver) return closeAfterFailedOpen(driver, path, error);
    throw initializationError(path, error);
  }
}
