import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGraphFile } from '@coredoc/db/file-builder';
import { openGraphFile } from '@coredoc/db/graph-file';
import { LadybugDriver } from '@coredoc/db/ladybug';
import { OFFLINE_FTS_NEEDLE, OFFLINE_FTS_REPO_ID, queryOfflineFts } from './offline-fts-smoke.mjs';

function parsedFixture() {
  const fileId = `${OFFLINE_FTS_REPO_ID}:file:src/offline.ts`;
  const functionId = `${OFFLINE_FTS_REPO_ID}:function:src/offline.ts:${OFFLINE_FTS_NEEDLE}`;
  const location = { filePath: 'src/offline.ts', startLine: 1, endLine: 3 };
  return {
    id: OFFLINE_FTS_REPO_ID,
    name: 'offline-fts-fixture',
    path: '/fixture/offline-fts-fixture',
    type: 'backend',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: 'offline-fts-v1',
    parserId: 'offline-fts',
    packages: [],
    files: [
      {
        id: fileId,
        versionedId: `${fileId}@v1`,
        path: location.filePath,
        extension: '.ts',
        language: 'typescript',
        contentHash: 'offline-fts-content-v1',
        loc: 3,
      },
    ],
    functions: [
      {
        id: functionId,
        versionedId: `${functionId}@v1`,
        name: OFFLINE_FTS_NEEDLE,
        kind: 'function',
        fileId,
        isAsync: false,
        isGenerator: false,
        isExported: true,
        parameters: [],
        location,
        sourceCode: `export function ${OFFLINE_FTS_NEEDLE}() { return true; }`,
      },
    ],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: {
      totalFiles: 1,
      parsedFiles: 1,
      skippedFiles: 0,
      totalFunctions: 1,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 1,
    },
  };
}

async function bootstrapExtension(workDir) {
  const bootstrapPath = join(workDir, 'extension-bootstrap.graph');
  const driver = new LadybugDriver(bootstrapPath, {
    readOnly: false,
    ftsMode: 'bootstrap',
    initializeSchema: false,
    budgets: { maxDbSizeBytes: 1024 ** 3, bufferPoolBytes: 256 * 1024 ** 2 },
  });
  try {
    await driver.initialize();
  } finally {
    await driver.close();
    await rm(bootstrapPath, { force: true });
  }
}

async function buildFixture(outputPath, workDir) {
  async function* components() {
    yield { parsedRepo: parsedFixture() };
  }
  return buildGraphFile({
    outputPath,
    workDir,
    components: components(),
  });
}

async function main() {
  const outputPath = resolve(process.argv[2] ?? 'fts-smoke/offline.graph');
  const workDir = resolve(process.argv[3] ?? 'fts-smoke/work');
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(workDir, { recursive: true });
  await bootstrapExtension(workDir);
  const built = await buildFixture(outputPath, workDir);
  const handle = await openGraphFile({
    path: outputPath,
    budgets: { maxDbSizeBytes: 1024 ** 3, bufferPoolBytes: 256 * 1024 ** 2, queryTimeoutMs: 5_000 },
  });
  let rows;
  try {
    rows = await queryOfflineFts(handle.repository);
    if (!JSON.stringify(rows).includes(OFFLINE_FTS_NEEDLE)) {
      throw new Error(`Ladybug FTS provisioning smoke missed ${OFFLINE_FTS_NEEDLE}`);
    }
  } finally {
    await handle.close();
  }
  process.stdout.write(
    `${JSON.stringify({ provisioned: true, artifactPath: built.artifactPath, rows: rows.length })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
