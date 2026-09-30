import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeType, type GraphNode } from '@coredoc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphFileReadOnlyError, openGraphFile } from './graph-file.js';
import { LadybugDriver } from './ladybug/driver.js';
import { LadybugRepository } from './ladybug/repository.js';
import {
  LADYBUG_CREATE_FTS_INDEX_STATEMENT,
  LADYBUG_EDGE_TYPES,
  LADYBUG_UNRESOLVED_CALL_TABLE,
} from './ladybug/schema.js';
import type { IGraphRepository } from './types.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const path of tempDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const GRAPH_FILE_BUDGETS = {
  maxDbSizeBytes: 1024 ** 3,
  bufferPoolBytes: 256 * 1024 ** 2,
} as const;

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function functionNode(name: string): GraphNode {
  return {
    id: `repo-a:function:src/read.ts:${name}`,
    type: NodeType.Function,
    name,
    properties: { kind: 'function' },
    repoId: 'repo-a',
    filePath: 'src/read.ts',
    startLine: 7,
    endLine: 11,
  };
}

async function createGraph(name = 'readSnapshot'): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'coredoc-graph-file-'));
  tempDirectories.push(directory);
  const path = join(directory, 'graph.lbug');
  const driver = new LadybugDriver(path, {
    readOnly: false,
    budgets: GRAPH_FILE_BUDGETS,
    ftsMode: 'load',
    initializeSchema: true,
  });
  await driver.initialize();
  await new LadybugRepository(driver).pushNodes([functionNode(name)]);
  await driver.withReadTransaction((transaction) => transaction.run(LADYBUG_CREATE_FTS_INDEX_STATEMENT));
  await driver.checkpoint();
  await driver.close();
  return path;
}

describe('openGraphFile', () => {
  it('exposes scoped logical node-text inspection', async () => {
    const path = await createGraph('sensitive-read-snapshot');
    const handle = await openGraphFile({ path, budgets: GRAPH_FILE_BUDGETS });

    await expect(handle.repository.containsNodeText(['sensitive-read'], ['repo-a'])).resolves.toBe(true);
    await expect(handle.repository.containsNodeText(['sensitive-read'], ['other-repo'])).resolves.toBe(false);
    await handle.close();
  });

  it('answers unresolved-call queries as empty on a file published without that table', async () => {
    const path = await createGraph('legacySnapshot');
    // A graph file built before the unresolved-call table existed. Dropping it
    // reproduces that vintage exactly: the required serving schema is untouched,
    // so the file still opens, and the boundary queries must degrade to "nothing
    // recorded" rather than fail.
    const writable = new LadybugDriver(path, { readOnly: false, initializeSchema: false, ftsMode: 'load' });
    await writable.initialize();
    await writable.withWriteTransaction((tx) => tx.run(`DROP TABLE ${LADYBUG_UNRESOLVED_CALL_TABLE}`));
    await writable.checkpoint();
    await writable.close();

    const handle = await openGraphFile({ path, budgets: GRAPH_FILE_BUDGETS });
    try {
      await expect(handle.repository.findUnresolvedCallsByNameTail('emit', ['repo-a'])).resolves.toEqual([]);
      await expect(handle.repository.findUnresolvedCallsInFiles(['src/read.ts'], ['repo-a'])).resolves.toEqual([]);
      // The rest of the file still reads normally.
      await expect(handle.repository.findFunction('legacySnapshot', ['repo-a'])).resolves.toMatchObject({
        name: 'legacySnapshot',
      });
    } finally {
      await handle.close();
    }
  });

  it('opens an existing artifact read-only and rejects forced mutations', async () => {
    const path = await createGraph();
    const beforeSha256 = fileSha256(path);
    const handle = await openGraphFile({ path, budgets: GRAPH_FILE_BUDGETS });

    await expect(handle.repository.findFunction('readSnapshot', ['repo-a'])).resolves.toMatchObject({
      name: 'readSnapshot',
    });
    await expect((handle.repository as IGraphRepository).deleteRepository('repo-a')).rejects.toBeInstanceOf(
      GraphFileReadOnlyError,
    );
    await expect(handle.repository.findFunction('readSnapshot', ['repo-a'])).resolves.toMatchObject({
      name: 'readSnapshot',
    });

    await Promise.all([handle.close(), handle.close()]);
    await expect(handle.close()).resolves.toBeUndefined();
    expect(fileSha256(path)).toBe(beforeSha256);
  });

  it('keeps simultaneous artifacts independent when one handle closes', async () => {
    const firstPath = await createGraph('firstGraph');
    const secondPath = await createGraph('secondGraph');
    const [first, second] = await Promise.all([
      openGraphFile({ path: firstPath, budgets: GRAPH_FILE_BUDGETS }),
      openGraphFile({ path: secondPath, budgets: GRAPH_FILE_BUDGETS }),
    ]);

    await expect(first.repository.findFunction('firstGraph', ['repo-a'])).resolves.toMatchObject({
      name: 'firstGraph',
    });
    await expect(second.repository.findFunction('firstGraph', ['repo-a'])).resolves.toBeNull();
    await first.close();
    await expect(second.repository.findFunction('secondGraph', ['repo-a'])).resolves.toMatchObject({
      name: 'secondGraph',
    });
    await second.close();
  });

  it('requires an existing artifact and does not create one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coredoc-graph-file-missing-'));
    tempDirectories.push(directory);
    const missing = join(directory, 'missing.lbug');

    await expect(openGraphFile({ path: missing, budgets: GRAPH_FILE_BUDGETS })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(existsSync(missing)).toBe(false);
  });

  it('rejects a database without the Coredoc graph schema and closes it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coredoc-graph-file-empty-'));
    tempDirectories.push(directory);
    const path = join(directory, 'empty.lbug');
    const seed = new LadybugDriver(path, {
      readOnly: false,
      budgets: GRAPH_FILE_BUDGETS,
      ftsMode: 'load',
      initializeSchema: false,
    });
    await seed.initialize();
    await seed.checkpoint();
    await seed.close();
    const close = vi.spyOn(LadybugDriver.prototype, 'close');

    try {
      await expect(openGraphFile({ path, budgets: GRAPH_FILE_BUDGETS })).rejects.toMatchObject({
        code: 'INITIALIZATION_FAILED',
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });

  it('rejects relationship tables missing required serving properties', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coredoc-graph-file-bad-relations-'));
    tempDirectories.push(directory);
    const path = join(directory, 'bad-relations.lbug');
    const seed = new LadybugDriver(path, {
      readOnly: false,
      budgets: GRAPH_FILE_BUDGETS,
      ftsMode: 'load',
      initializeSchema: false,
    });
    await seed.initialize();
    await seed.withReadTransaction(async (transaction) => {
      await transaction.run(
        'CREATE NODE TABLE GraphNode(' +
          'id STRING PRIMARY KEY, type STRING, name STRING, properties STRING, summary STRING, ' +
          'embedding DOUBLE[], repoId STRING, filePath STRING, startLine INT64, endLine INT64)',
      );
      await transaction.run('CREATE NODE TABLE CoredocMeta(repoId STRING PRIMARY KEY, snapshot STRING)');
      for (const type of LADYBUG_EDGE_TYPES) {
        await transaction.run(`CREATE REL TABLE ${type}(FROM GraphNode TO GraphNode)`);
      }
      await transaction.run(LADYBUG_CREATE_FTS_INDEX_STATEMENT);
    });
    await seed.checkpoint();
    await seed.close();

    await expect(openGraphFile({ path, budgets: GRAPH_FILE_BUDGETS })).rejects.toMatchObject({
      code: 'INITIALIZATION_FAILED',
    });
  });

  it('rejects invalid and undersized budgets before opening an artifact', async () => {
    const path = await createGraph();
    await expect(
      openGraphFile({
        path,
        budgets: { ...GRAPH_FILE_BUDGETS, bufferPoolBytes: 0 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BUDGET' });
    await expect(
      openGraphFile({
        path,
        budgets: { ...GRAPH_FILE_BUDGETS, maxDbSizeBytes: statSync(path).size - 1 },
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});
