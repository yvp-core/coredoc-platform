import { resolve } from 'node:path';
import { openGraphFile } from '@coredoc/db/graph-file';
import { resolveDetailLevel } from '@coredoc/mcp';
import { handleSearchSymbols } from '@coredoc/mcp/tools';
import { OFFLINE_FTS_NEEDLE, OFFLINE_FTS_REPO_ID, queryOfflineFts } from './offline-fts-smoke.mjs';

const artifactPath = resolve(process.argv[2] ?? '/app/fts-smoke/offline.graph');

// One serving-owned, load-only handle proves both the actual index query and
// the canonical portable MCP read. No raw driver or second artifact open can
// mask a broken graph-file capability.
const handle = await openGraphFile({
  path: artifactPath,
  budgets: {
    maxDbSizeBytes: 1024 ** 3,
    bufferPoolBytes: 256 * 1024 ** 2,
    queryTimeoutMs: 5_000,
  },
});
try {
  const ftsRows = await queryOfflineFts(handle.repository);
  if (!JSON.stringify(ftsRows).includes(OFFLINE_FTS_NEEDLE)) {
    throw new Error(`Offline Ladybug FTS query missed ${OFFLINE_FTS_NEEDLE}`);
  }
  const response = await handleSearchSymbols(
    { query: OFFLINE_FTS_NEEDLE, type: 'function', limit: 5 },
    {
      currentPath: 'workspace://offline-fts-fixture',
      resolvedRepos: ['offline-fts-fixture'],
      repoHashes: [OFFLINE_FTS_REPO_ID],
      crossRepoEnabled: false,
      origin: 'workspace',
    },
    'raw',
    'full',
    resolveDetailLevel('full'),
    handle.repository,
  );
  if (!JSON.stringify(response.data).includes(OFFLINE_FTS_NEEDLE)) {
    throw new Error(`Offline MCP serving smoke missed ${OFFLINE_FTS_NEEDLE}`);
  }
  process.stdout.write(`${JSON.stringify({ offlineFts: true, mcpRead: true, ftsRows: ftsRows.length })}\n`);
} finally {
  await handle.close();
}
