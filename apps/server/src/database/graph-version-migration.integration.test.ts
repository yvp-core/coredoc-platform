import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const DATABASE_URL = process.env.GRAPH_MIGRATION_TEST_DATABASE_URL;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe.skipIf(!DATABASE_URL)('graph-version migration PostgreSQL constraints', () => {
  it('enforces retained constraints and proves derived-parent rollback', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(SERVER_ROOT, 'scripts/test-graph-version-migration.mjs')],
      {
        cwd: resolve(SERVER_ROOT, '../..'),
        env: { ...process.env, GRAPH_MIGRATION_TEST_DATABASE_URL: DATABASE_URL },
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      rejected: [
        'cross-workspace active pointer',
        'cross-workspace parent pointer',
        'active version deletion',
        'zero-sized graph version',
        'cross-workspace artifact registry',
        'wrong-workspace artifact prefix',
        'artifact descriptor mutation',
        'file snapshot without retention',
        'retention flag clear',
      ],
      workspaceCascade: true,
      activePointerNullable: true,
      removedSchema: {
        candidateColumns: true,
        candidateConstraints: true,
        candidateTrigger: true,
        candidateFunction: true,
        tursoAppliedManifest: true,
        tursoAppliedManifestConstraint: true,
      },
      rollback: {
        childToParent: { from: 'v-child', to: 'v1' },
        staleExpectedRows: 0,
        firstVersionToNull: { from: 'v1', to: null },
        versionHistoryCount: 2,
      },
      advisorySerialization: true,
      retentionBackfill: true,
    });
  }, 30_000);
});
