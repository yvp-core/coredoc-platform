import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeType, type GraphNode } from './types.js';
import {
  closeAllDrivers,
  closeDriver,
  closeProjectDatabases,
  getConfiguredBackend,
  getDriver,
  getOperationsRepository,
  openProjectDatabase,
  replaceProjectLadybugGraphFile,
  resetBackendState,
} from './backend-factory.js';
import { LadybugDriver } from './ladybug/driver.js';
import { SqliteDriver } from './sqlite/driver.js';
import { SqliteOperationsRepository } from './sqlite/operations-repository.js';

let workspace: string;
let originalBackend: string | undefined;
let originalLadybugPath: string | undefined;
let originalSqliteUrl: string | undefined;

const SHARED_REPO_HASH = 'abc123def456';
const SHARED_NODE_ID = `${SHARED_REPO_HASH}:function:src/handler.ts:handle`;

function node(overrides: Partial<GraphNode> & Pick<GraphNode, 'id' | 'name'>): GraphNode {
  return {
    type: NodeType.Function,
    properties: {},
    repoId: SHARED_REPO_HASH,
    filePath: 'src/handler.ts',
    startLine: 1,
    endLine: 10,
    ...overrides,
  } as GraphNode;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'project-isolation-'));
  originalBackend = process.env.COREDOC_DB_BACKEND;
  originalLadybugPath = process.env.COREDOC_LADYBUG_PATH;
  originalSqliteUrl = process.env.COREDOC_SQLITE_URL;
});

afterEach(async () => {
  await Promise.allSettled([closeAllDrivers(), closeProjectDatabases()]);
  if (originalBackend === undefined) delete process.env.COREDOC_DB_BACKEND;
  else process.env.COREDOC_DB_BACKEND = originalBackend;
  if (originalLadybugPath === undefined) delete process.env.COREDOC_LADYBUG_PATH;
  else process.env.COREDOC_LADYBUG_PATH = originalLadybugPath;
  if (originalSqliteUrl === undefined) delete process.env.COREDOC_SQLITE_URL;
  else process.env.COREDOC_SQLITE_URL = originalSqliteUrl;
  rmSync(workspace, { recursive: true, force: true });
});

describe('openProjectDatabase', () => {
  it('publishes a same-directory Ladybug candidate and preserves the old file when the build fails', async () => {
    const graphDir = join(workspace, 'coredoc.db.d');
    const ladybugPath = join(graphDir, 'project-a.lbdb');
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(ladybugPath, 'old-graph');

    await expect(
      replaceProjectLadybugGraphFile(workspace, 'project-a', async (candidatePath) => {
        expect(candidatePath.startsWith(graphDir)).toBe(true);
        expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(true);
        writeFileSync(candidatePath, 'partial-candidate');
        throw new Error('candidate validation failed');
      }),
    ).rejects.toThrow('candidate validation failed');

    expect(readFileSync(ladybugPath, 'utf8')).toBe('old-graph');
    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
    expect(readdirSync(graphDir).filter((entry) => entry.includes('.replace-'))).toEqual([]);

    const published = await replaceProjectLadybugGraphFile(workspace, 'project-a', async (candidatePath) => {
      expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(true);
      writeFileSync(candidatePath, 'new-graph');
      return 'built';
    });

    expect(published).toEqual({ graphPath: ladybugPath, result: 'built' });
    expect(readFileSync(ladybugPath, 'utf8')).toBe('new-graph');
    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
    expect(readdirSync(graphDir).filter((entry) => entry.includes('.replace-'))).toEqual([]);
  });

  it('keeps byte-identical node ids apart in two projects', async () => {
    const projectA = await openProjectDatabase(workspace, 'project-a');
    const projectB = await openProjectDatabase(workspace, 'project-b');

    await projectA.graph.pushNodes([node({ id: SHARED_NODE_ID, name: 'handle', summary: 'project A version' })]);
    await projectB.graph.pushNodes([node({ id: SHARED_NODE_ID, name: 'handle', summary: 'project B version' })]);

    const fromA = await projectA.graph.getNodeWithProperties(SHARED_NODE_ID, [SHARED_REPO_HASH]);
    const fromB = await projectB.graph.getNodeWithProperties(SHARED_NODE_ID, [SHARED_REPO_HASH]);
    expect(fromA?.node.summary).toBe('project A version');
    expect(fromB?.node.summary).toBe('project B version');
  });

  it('routes operations through the same project-owned connection', async () => {
    const projectA = await openProjectDatabase(workspace, 'project-a');
    const projectB = await openProjectDatabase(workspace, 'project-b');

    const opId = await projectA.operations.startOperation('project-a', 'api', 'push');
    await projectA.operations.completeOperation(opId);

    expect(await projectA.operations.getLatestOperation('project-a', 'api', 'push')).not.toBeNull();
    expect(await projectB.operations.getLatestOperation('project-a', 'api', 'push')).toBeNull();
  });

  it('reuses one connection per project under concurrent callers', async () => {
    const handles = await Promise.all(Array.from({ length: 8 }, () => openProjectDatabase(workspace, 'project-a')));
    expect(new Set(handles.map((handle) => handle.graph)).size).toBe(1);

    const other = await openProjectDatabase(workspace, 'project-b');
    expect(other.graph).not.toBe(handles[0]?.graph);
  });

  it('read mode never creates a missing database', async () => {
    const dbPath = join(workspace, 'coredoc.db.d', 'missing.db');
    await expect(openProjectDatabase(workspace, 'missing', { mode: 'read' })).rejects.toThrow(/coredoc push/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('selects Ladybug explicitly and opens its project graph read-only without touching SQLite graph data', async () => {
    process.env.COREDOC_DB_BACKEND = 'LaDyBuG';
    expect(getConfiguredBackend()).toBe('ladybug');

    const ladybugPath = join(workspace, 'coredoc.db.d', 'project-a.lbdb');
    const sqlitePath = join(workspace, 'coredoc.db.d', 'project-a.db');
    const writer = await openProjectDatabase(workspace, 'project-a', { backend: 'ladybug' });
    await writer.graph.pushNodes([node({ id: SHARED_NODE_ID, name: 'ladybug-only' })]);
    await closeProjectDatabases();

    expect(existsSync(ladybugPath)).toBe(true);
    expect(existsSync(`${ladybugPath}.wal`)).toBe(false);

    const reader = await openProjectDatabase(workspace, 'project-a', { mode: 'read', backend: 'ladybug' });
    expect((await reader.graph.getNodeWithProperties(SHARED_NODE_ID, [SHARED_REPO_HASH]))?.node.name).toBe(
      'ladybug-only',
    );
    await expect(reader.graph.pushNodes([node({ id: `${SHARED_NODE_ID}:write`, name: 'must-fail' })])).rejects.toThrow(
      /read-only/i,
    );

    // Operations/metrics deliberately keep their SQLite sidecar. It is not the
    // Ladybug graph, and therefore contains none of the planted graph rows.
    expect(existsSync(sqlitePath)).toBe(true);
  });

  it('Ladybug read mode does not create a missing graph file', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'missing.lbdb');
    await expect(openProjectDatabase(workspace, 'missing', { mode: 'read', backend: 'ladybug' })).rejects.toThrow(
      /coredoc push/,
    );
    expect(existsSync(ladybugPath)).toBe(false);
  });

  it('blocks a Ladybug writer while a project reader is active and releases every lease on close', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'project-a.lbdb');
    const writer = await openProjectDatabase(workspace, 'project-a', { backend: 'ladybug' });
    await writer.graph.pushNodes([node({ id: SHARED_NODE_ID, name: 'lease-check' })]);
    await closeProjectDatabases();

    process.env.COREDOC_LADYBUG_PATH = ladybugPath;
    await openProjectDatabase(workspace, 'project-a', { mode: 'read', backend: 'ladybug' });
    await expect(getDriver('ladybug')).rejects.toThrow(/Stop the local Coredoc MCP process/);

    await closeProjectDatabases();
    await expect(getDriver('ladybug')).resolves.toMatchObject({ backend: 'ladybug' });
    await closeAllDrivers();
    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
    expect(existsSync(`${ladybugPath}.readers`)).toBe(false);
  });

  it('reclaims a reader lease left by a dead process before opening a writer', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'project-a.lbdb');
    const readersPath = `${ladybugPath}.readers`;
    mkdirSync(readersPath, { recursive: true });
    writeFileSync(join(readersPath, '2147483647-stale.lock'), '');
    process.env.COREDOC_LADYBUG_PATH = ladybugPath;

    await expect(getDriver('ladybug')).resolves.toMatchObject({ backend: 'ladybug' });
    await closeAllDrivers();
    expect(existsSync(readersPath)).toBe(false);
  });

  it('reclaims a writer lease left by a dead process before opening a reader', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'project-a.lbdb');
    const writer = await openProjectDatabase(workspace, 'project-a', { backend: 'ladybug' });
    await writer.graph.pushNodes([node({ id: SHARED_NODE_ID, name: 'stale-writer-check' })]);
    await closeProjectDatabases();
    writeFileSync(`${ladybugPath}.writer.lock`, '2147483647');

    await expect(
      openProjectDatabase(workspace, 'project-a', { mode: 'read', backend: 'ladybug' }),
    ).resolves.toMatchObject({ backend: 'ladybug' });
    await closeProjectDatabases();
    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
  });

  it('blocks a project reader while the singleton writer lease is active', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'project-a.lbdb');
    process.env.COREDOC_LADYBUG_PATH = ladybugPath;
    await getDriver('ladybug');

    await expect(openProjectDatabase(workspace, 'project-a', { mode: 'read', backend: 'ladybug' })).rejects.toThrow(
      /being updated/i,
    );
  });

  it('rejects a symlinked Ladybug graph path', async () => {
    const graphDir = join(workspace, 'coredoc.db.d');
    const targetPath = join(graphDir, 'target.lbdb');
    const projectPath = join(graphDir, 'project-a.lbdb');
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(targetPath, 'not-a-graph');
    symlinkSync(targetPath, projectPath);

    await expect(openProjectDatabase(workspace, 'project-a', { mode: 'read', backend: 'ladybug' })).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it('keeps the writer lease and factory owner when Ladybug close fails', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'close-failure.lbdb');
    process.env.COREDOC_LADYBUG_PATH = ladybugPath;
    await getDriver('ladybug');

    const closeSpy = vi.spyOn(LadybugDriver.prototype, 'close').mockRejectedValueOnce(new Error('native close failed'));
    try {
      await expect(closeDriver()).rejects.toThrow('native close failed');
      expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(true);
      await expect(getDriver('ladybug')).resolves.toBeInstanceOf(LadybugDriver);
    } finally {
      closeSpy.mockRestore();
      await closeAllDrivers();
    }

    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
  });

  it('keeps a pooled Ladybug lease and connection when close fails so shutdown can retry', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'project-a.lbdb');
    const connection = await openProjectDatabase(workspace, 'project-a', { backend: 'ladybug' });
    const closeSpy = vi.spyOn(LadybugDriver.prototype, 'close').mockRejectedValueOnce(new Error('pooled close failed'));
    try {
      await expect(closeProjectDatabases()).rejects.toThrow('pooled close failed');
      expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(true);
      await expect(openProjectDatabase(workspace, 'project-a', { backend: 'ladybug' })).resolves.toBe(connection);
    } finally {
      closeSpy.mockRestore();
      await closeProjectDatabases();
    }
    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
  });

  it('releases the writer lease after an initialization failure closes cleanly', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'init-failure.lbdb');
    process.env.COREDOC_LADYBUG_PATH = ladybugPath;
    const initializeSpy = vi
      .spyOn(LadybugDriver.prototype, 'initialize')
      .mockRejectedValueOnce(new Error('initialization failed'));
    await expect(getDriver('ladybug')).rejects.toThrow('initialization failed');
    initializeSpy.mockRestore();

    expect(existsSync(`${ladybugPath}.writer.lock`)).toBe(false);
    await expect(getDriver('ladybug')).resolves.toBeInstanceOf(LadybugDriver);
  });

  it('refuses to reset state while a Ladybug driver still owns a live lease', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'reset-live.lbdb');
    process.env.COREDOC_LADYBUG_PATH = ladybugPath;
    const driver = await getDriver('ladybug');

    let resetFailure: unknown;
    try {
      resetBackendState();
    } catch (error) {
      resetFailure = error;
    }

    if (resetFailure === undefined) {
      // The RED implementation loses the factory owner, so close the captured
      // native handle explicitly before the assertion fails.
      await driver.close();
    } else {
      await closeAllDrivers();
    }

    expect(resetFailure).toBeInstanceOf(Error);
    expect((resetFailure as Error).message).toMatch(/closeAllDrivers/i);
  });

  it('does not reuse a Ladybug operations sidecar after switching to SQLite', async () => {
    const ladybugPath = join(workspace, 'coredoc.db.d', 'graph.lbdb');
    const sidecarAUrl = `file:${join(workspace, 'coredoc.db.d', 'sidecar-a.db')}`;
    const sqliteBUrl = `file:${join(workspace, 'coredoc.db.d', 'sqlite-b.db')}`;
    process.env.COREDOC_LADYBUG_PATH = ladybugPath;
    process.env.COREDOC_SQLITE_URL = sidecarAUrl;

    await getDriver('ladybug');
    await getOperationsRepository();

    process.env.COREDOC_SQLITE_URL = sqliteBUrl;
    await getDriver('sqlite');
    const sqliteOperations = await getOperationsRepository();
    const operationId = await sqliteOperations.startOperation('project-b', 'api', 'push');
    await sqliteOperations.completeOperation(operationId);
    await closeAllDrivers();

    const driverA = new SqliteDriver(sidecarAUrl);
    const driverB = new SqliteDriver(sqliteBUrl);
    await Promise.all([driverA.initialize(), driverB.initialize()]);
    try {
      const operationsA = new SqliteOperationsRepository(driverA);
      const operationsB = new SqliteOperationsRepository(driverB);
      expect(await operationsA.getLatestOperation('project-b', 'api', 'push')).toBeNull();
      expect(await operationsB.getLatestOperation('project-b', 'api', 'push')).not.toBeNull();
    } finally {
      await Promise.all([driverA.close(), driverB.close()]);
    }
  });

  it('rejects an explicitly unsupported backend instead of silently opening SQLite', () => {
    process.env.COREDOC_DB_BACKEND = 'ladybuug';
    expect(() => getConfiguredBackend()).toThrow(/ladybuug.*sqlite.*ladybug.*neo4j/i);
  });

  it('coalesces concurrent closes and blocks new opens until the shared close finishes', async () => {
    const originalClose = SqliteDriver.prototype.close;
    let releaseClose!: () => void;
    let signalCloseStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    const closeSpy = vi.spyOn(SqliteDriver.prototype, 'close').mockImplementation(async function () {
      signalCloseStarted();
      await closeGate;
      await originalClose.call(this);
    });

    await openProjectDatabase(workspace, 'project-a');
    const firstClose = closeProjectDatabases();
    await closeStarted;
    const secondClose = closeProjectDatabases();

    try {
      expect(secondClose).toBe(firstClose);
      await expect(openProjectDatabase(workspace, 'project-b')).rejects.toThrow(/databases are closing/i);
    } finally {
      releaseClose();
      await Promise.allSettled([firstClose, secondClose]);
      closeSpy.mockRestore();
    }

    await expect(openProjectDatabase(workspace, 'project-b')).resolves.toMatchObject({ projectId: 'project-b' });
  });
});
