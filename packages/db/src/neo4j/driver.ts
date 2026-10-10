/**
 * Neo4j Database Driver
 *
 * Handles Neo4j database connection, session management, and graceful shutdown.
 * Implements IDatabaseDriver interface for use with the database abstraction layer.
 */

import type { ManagedTransaction, Driver, Session, SessionConfig } from 'neo4j-driver';
import { createRequire } from 'node:module';
import { EdgeType } from '@coredoc/core';
import type { IDatabaseDriver, ITransaction, DatabaseBackend } from '../types.js';

// =============================================================================
// Module State
// =============================================================================

let driver: Driver | null = null;
let isShuttingDown = false;

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Neo4j connection configuration
 */
export interface Neo4jConnectionConfig {
  /** Neo4j URI (bolt://host:port) */
  uri: string;
  /** Neo4j username */
  user: string;
  /** Neo4j password */
  password: string;
}

/**
 * Options for session creation
 */
export interface Neo4jSessionOptions {
  /** Database name (default: 'neo4j') */
  database?: string;
  /** Session config to pass to neo4j driver */
  sessionConfig?: SessionConfig;
}

// =============================================================================
// Neo4j Module Loading
// =============================================================================

// Resolve neo4j-driver lazily via a synchronous require so that merely importing
// this module — which `@coredoc/db`'s index statically re-exports, so it loads at
// startup in every consumer — never eagerly pulls in the optional neo4j-driver
// dependency (that eager require crashed the packaged desktop app, which ships
// SQLite only). Only reached once the Neo4j backend is actually in use.
const nodeRequire = createRequire(import.meta.url);
let neo4jModule: typeof import('neo4j-driver') | null = null;

function getNeo4jModule(): typeof import('neo4j-driver') {
  if (!neo4jModule) {
    try {
      neo4jModule = nodeRequire('neo4j-driver') as typeof import('neo4j-driver');
    } catch {
      throw new Error('neo4j-driver is not installed. Install it with: npm install neo4j-driver');
    }
  }
  return neo4jModule;
}

// =============================================================================
// Environment Variable Helpers
// =============================================================================

/**
 * Get Neo4j connection configuration from environment variables.
 *
 * Required environment variables:
 * - NEO4J_URI: Connection URI (default: bolt://localhost:7687)
 * - NEO4J_USER: Username (default: neo4j)
 * - NEO4J_PASSWORD: Password (required, no default)
 *
 * @throws Error if NEO4J_PASSWORD is not set
 */
function getConnectionConfig(): Neo4jConnectionConfig {
  const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER || 'neo4j';
  const password = process.env.NEO4J_PASSWORD;

  if (!password) {
    throw new Error(
      'NEO4J_PASSWORD environment variable is required. ' + 'Set it in your .env file or export it in your shell.',
    );
  }

  return { uri, user, password };
}

// =============================================================================
// Driver Management
// =============================================================================

/**
 * Get the Neo4j driver instance, creating it if necessary (lazy initialization).
 *
 * The driver is a singleton that manages connection pooling internally.
 * It should be created once and reused throughout the application lifecycle.
 *
 * @throws Error if connection configuration is invalid or NEO4J_PASSWORD is not set
 */
export async function getDriver(): Promise<Driver> {
  if (driver) {
    return driver;
  }

  const neo4j = getNeo4jModule();
  const config = getConnectionConfig();

  driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 30000,
    connectionLivenessCheckTimeout: 30000, // ping pooled conns idle >30s before handing them out
    maxConnectionLifetime: 5 * 60 * 1000, // retire connections after 5 min, below the ~10 min network idle drop
    maxTransactionRetryTime: 60000, // ride out a reconnect / brief blip on managed transactions (default 30s)
    logging: {
      level: 'warn',
      logger: (level: string, message: string) => {
        if (level === 'error') {
          console.error(`[Neo4j] ${message}`);
        }
      },
    },
  }) as Driver;

  return driver!;
}

/**
 * Close the Neo4j driver and release all resources.
 *
 * This should be called when the application is shutting down.
 * Safe to call multiple times - subsequent calls are no-ops.
 */
export async function closeDriver(): Promise<void> {
  if (!driver) {
    return;
  }

  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    await driver.close();
    driver = null;
  } catch (error) {
    console.error('[Neo4j] Error closing driver:', error instanceof Error ? error.message : error);
    driver = null;
  } finally {
    isShuttingDown = false;
  }
}

/**
 * Verify connectivity to the Neo4j database configured by the environment.
 *
 * @throws Error if connection fails
 */
async function verifyConnectivity(): Promise<void> {
  const neo4j = getNeo4jModule();
  const config = getConnectionConfig();
  const testDriver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));

  try {
    await testDriver.verifyConnectivity();
  } finally {
    await testDriver.close();
  }
}

// =============================================================================
// Session Management
// =============================================================================

/**
 * Execute a function with a Neo4j session, ensuring proper cleanup.
 *
 * @param fn - Async function that receives a session and returns a result
 * @param options - Session options (database, config)
 * @returns The result of the function
 */
export async function withSession<T>(
  fn: (session: Session) => Promise<T>,
  options: Neo4jSessionOptions = {},
): Promise<T> {
  const { database = 'neo4j', sessionConfig } = options;
  const d = await getDriver();
  const session = d.session({
    database,
    ...sessionConfig,
  });

  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/**
 * Execute a write transaction with automatic retry on transient errors.
 *
 * @param fn - Async function that receives a transaction and returns a result
 * @param options - Session options (database, config)
 * @returns The result of the function
 */
export async function withWriteTransaction<T>(
  fn: (tx: ManagedTransaction) => Promise<T>,
  options: Neo4jSessionOptions = {},
): Promise<T> {
  return withSession(async (session) => {
    return session.executeWrite(fn);
  }, options);
}

/**
 * Execute a read transaction with automatic retry on transient errors.
 *
 * @param fn - Async function that receives a transaction and returns a result
 * @param options - Session options (database, config)
 * @returns The result of the function
 */
export async function withReadTransaction<T>(
  fn: (tx: ManagedTransaction) => Promise<T>,
  options: Neo4jSessionOptions = {},
): Promise<T> {
  return withSession(async (session) => {
    return session.executeRead(fn);
  }, options);
}

// =============================================================================
// Vector Index Management
// =============================================================================

/**
 * Create vector indexes for embedding similarity search.
 *
 * @param dimensions - Embedding dimensions (default: 768)
 * @throws Error if index creation fails
 */
export async function createVectorIndexes(dimensions: number = 768): Promise<void> {
  const specs = [
    { name: 'function_embedding', label: 'Function' },
    { name: 'entrypoint_embedding', label: 'Entrypoint' },
  ];
  await withSession(async (session) => {
    for (const { name, label } of specs) {
      await session.run(
        `CREATE VECTOR INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON (n.embedding)
         OPTIONS {indexConfig: {\`vector.dimensions\`: $dimensions, \`vector.similarity_function\`: 'cosine'}}`,
        { dimensions },
      );
    }
  });
}

/**
 * Node labels that carry an `id`. Every node also gets the shared `:CodeNode`
 * label (see Neo4jRepository.pushNodes) so that id lookups which don't know the
 * concrete type — `pushEdges`' endpoint MATCH, `deleteRepository`'s prefix scan
 * — can use a single index instead of scanning the whole graph.
 */
const ID_INDEX_LABELS = [
  'CodeNode',
  'Repository',
  'Package',
  'File',
  'Function',
  'Class',
  'Interface',
  'Entrypoint',
  'Entity',
  'Component',
  'Route',
  'StateStore',
  'TypeAlias',
  'Enum',
  'Variable',
  'ExternalCall',
];

/**
 * Ensure range indexes on `id` exist for every node label.
 *
 * Without these, `MERGE (n:Label {id})` in pushNodes and `MATCH (n {id})` in
 * pushEdges/deleteRepository are full label scans whose cost grows with the
 * graph — a multi-repo push degrades super-linearly (a single large repo's edge
 * push can take many minutes once the graph holds tens of thousands of nodes).
 *
 * Idempotent (`IF NOT EXISTS`); safe to call before every push. Requires schema
 * privileges, so it runs on the write/push path, not on read-only MCP startup.
 */
export async function ensureGraphIndexes(): Promise<void> {
  await withSession(async (session) => {
    for (const label of ID_INDEX_LABELS) {
      await session.run(`CREATE INDEX ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) ON (n.id)`);
    }
    // Relationship id indexes back the edge-rewire pre-pass in applyChangeset
    // (`MATCH ()-[existing:TYPE {id: ...}]->()`). Without them that lookup is a
    // full relationship-type scan per 500-edge batch — the relationship-level
    // twin of the node-id blowup documented below.
    for (const edgeType of Object.values(EdgeType)) {
      await session.run(
        `CREATE INDEX rel_${edgeType.toLowerCase()}_id IF NOT EXISTS FOR ()-[r:${edgeType}]-() ON (r.id)`,
      );
    }
    // CREATE INDEX returns before the index is populated. A freshly created index
    // is POPULATING, and until it is ONLINE the planner falls back to full label
    // scans — so on a non-empty graph the very next push's endpoint MATCHes scan
    // the whole graph, the exact super-linear blowup these indexes exist to
    // prevent. Block until every index is ONLINE so the first push uses them.
    await session.run('CALL db.awaitIndexes(300)');
  });
}

// =============================================================================
// Neo4j Transaction Wrapper
// =============================================================================

/**
 * Wraps Neo4j ManagedTransaction to implement ITransaction.
 */
class Neo4jTransaction implements ITransaction {
  constructor(private tx: ManagedTransaction) {}

  async run<T = unknown>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const result = await this.tx.run(query, params);
    return result.records.map((record) => {
      const obj: Record<string, unknown> = {};
      for (const key of record.keys) {
        const keyStr = String(key);
        const value = record.get(keyStr);
        obj[keyStr] = convertNeo4jValue(value);
      }
      return obj as T;
    });
  }
}

/**
 * Convert Neo4j values to plain JS values.
 */
function convertNeo4jValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle Neo4j Integer
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }

  // Handle Neo4j Node
  if (typeof value === 'object' && 'properties' in (value as object)) {
    const node = value as { properties: Record<string, unknown> };
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node.properties)) {
      props[key] = convertNeo4jValue(val);
    }
    return props;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(convertNeo4jValue);
  }

  // Handle plain objects
  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      obj[key] = convertNeo4jValue(val);
    }
    return obj;
  }

  return value;
}

// neo4j-driver's `int()` converts JS numbers into the 64-bit Integer that Cypher
// LIMIT/SKIP require.
export function toInt(value: string | number) {
  return getNeo4jModule().int(value);
}

// =============================================================================
// Neo4j Driver Class Implementation
// =============================================================================

/**
 * Neo4j driver implementing IDatabaseDriver interface.
 */
export class Neo4jDriver implements IDatabaseDriver {
  readonly backend: DatabaseBackend = 'neo4j';
  private initialized = false;

  /**
   * Initialize the Neo4j driver.
   * Verifies connectivity to the database.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await verifyConnectivity();
    this.initialized = true;
  }

  /**
   * Close the Neo4j driver.
   */
  async close(): Promise<void> {
    await closeDriver();
    this.initialized = false;
  }

  /**
   * Execute a function within a read transaction.
   */
  async withReadTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    return withReadTransaction(async (neo4jTx) => {
      const wrappedTx = new Neo4jTransaction(neo4jTx);
      return fn(wrappedTx);
    });
  }

  /**
   * Execute a function within a write transaction.
   */
  async withWriteTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    return withWriteTransaction(async (neo4jTx) => {
      const wrappedTx = new Neo4jTransaction(neo4jTx);
      return fn(wrappedTx);
    });
  }

  /**
   * Execute batch operations with automatic chunking.
   */
  async executeBatch<T>(
    items: T[],
    handler: (batch: T[], tx: ITransaction) => Promise<void>,
    batchSize: number = 500,
  ): Promise<number> {
    if (items.length === 0) {
      return 0;
    }

    let processed = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      await this.withWriteTransaction(async (tx) => {
        await handler(batch, tx);
      });

      processed += batch.length;
    }

    return processed;
  }

  /**
   * Get the underlying Neo4j driver instance.
   */
  async getOriginalDriver(): Promise<Driver> {
    return getDriver();
  }
}
