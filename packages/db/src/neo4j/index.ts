/**
 * Neo4j Backend Exports
 *
 * Re-exports driver and repository for the Neo4j backend.
 */

export {
  Neo4jDriver,
  getConnectionConfig,
  getMaskedConnectionString,
  getDriver as getNeo4jDriver,
  closeDriver as closeNeo4jDriver,
  isDriverInitialized as isNeo4jDriverInitialized,
  verifyConnectivity,
  registerExitHandlers as registerNeo4jExitHandlers,
  createVectorIndexes,
  ensureGraphIndexes,
  getServerInfo,
  isDatabaseAvailable as isNeo4jDatabaseAvailable,
  withSession,
  withReadTransaction,
  withWriteTransaction,
  executeBatch,
  DEFAULT_BATCH_SIZE,
  type Neo4jConnectionConfig,
  type Neo4jSessionOptions,
} from './driver.js';

export { Neo4jRepository } from './repository.js';
