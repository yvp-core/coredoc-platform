import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.GRAPH_MIGRATION_TEST_DATABASE_URL;
if (!DATABASE_URL) throw new Error('GRAPH_MIGRATION_TEST_DATABASE_URL is required');

const graphVersionMigrationPath = resolve(
  process.argv[2] ?? 'apps/server/prisma/migrations/20260811000000_add_workspace_graph_versions/migration.sql',
);
const snapshotWriteMigrationPath = resolve(
  process.argv[3] ?? 'apps/server/prisma/migrations/20260811120000_add_graph_snapshot_write_path/migration.sql',
);
const graphVersionMigrationSql = await readFile(graphVersionMigrationPath, 'utf8');
const snapshotWriteMigrationSql = await readFile(snapshotWriteMigrationPath, 'utf8');
const schema = `phase3_graph_${randomUUID().replaceAll('-', '')}`;
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const client = new Client({ connectionString: DATABASE_URL });
const rejected = [];
const candidateColumns = [
  'candidate_manifest',
  'candidate_version_id',
  'candidate_r2_key',
  'candidate_artifact_sha256',
  'candidate_artifact_size_bytes',
];
const candidateConstraints = [
  'push_jobs_candidate_manifest_pair_check',
  'push_jobs_candidate_manifest_object_check',
  'push_jobs_candidate_version_id_check',
  'push_jobs_candidate_artifact_triple_check',
  'push_jobs_candidate_artifact_requires_manifest_check',
  'push_jobs_candidate_r2_key_prefix_check',
  'push_jobs_candidate_artifact_sha256_check',
  'push_jobs_candidate_artifact_size_bytes_check',
];

async function expectPgFailure(label, expectedCode, operation) {
  const savepoint = `probe_${rejected.length}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let failure;
  try {
    await operation();
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } catch (error) {
    failure = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  if (!failure) throw new Error(`${label} unexpectedly satisfied its database constraint`);
  if (failure.code !== expectedCode) {
    throw new Error(`${label} failed with PostgreSQL code ${failure.code ?? 'unknown'}, expected ${expectedCode}`, {
      cause: failure,
    });
  }
  rejected.push(label);
}

async function expectNoCatalogEntries(label, query, parameters) {
  const result = await client.query(query, parameters);
  if (result.rows.length !== 0) {
    throw new Error(`${label} still exist: ${result.rows.map((row) => Object.values(row).join(':')).join(', ')}`);
  }
}

async function proveAdvisorySerialization() {
  const locker = new Client({ connectionString: DATABASE_URL });
  const contender = new Client({ connectionString: DATABASE_URL });
  try {
    await locker.connect();
    await contender.connect();
    await locker.query('BEGIN');
    await contender.query('BEGIN');
    await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [workspaceA]);

    const whileHeld = await contender.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS acquired',
      [workspaceA],
    );
    if (whileHeld.rows[0]?.acquired !== false) {
      throw new Error('a competing transaction acquired the held workspace advisory lock');
    }

    await locker.query('ROLLBACK');
    const afterRelease = await contender.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS acquired',
      [workspaceA],
    );
    if (afterRelease.rows[0]?.acquired !== true) {
      throw new Error('the competing transaction could not acquire the released workspace advisory lock');
    }
  } finally {
    await locker.query('ROLLBACK').catch(() => undefined);
    await contender.query('ROLLBACK').catch(() => undefined);
    await locker.end().catch(() => undefined);
    await contender.end().catch(() => undefined);
  }
}

try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query('CREATE TABLE workspaces (id UUID PRIMARY KEY)');
  await client.query(graphVersionMigrationSql);
  await client.query(`
    CREATE TABLE workspace_repos (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
      repo_key TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      UNIQUE (workspace_id, repo_key)
    )
  `);
  await client.query(`
    CREATE TABLE push_jobs (
      id TEXT PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await client.query('INSERT INTO workspaces (id) VALUES ($1)', [workspaceA]);
  await client.query("UPDATE workspaces SET graph_backend = 'file_snapshot' WHERE id = $1", [workspaceA]);
  // Prisma deploys these as separate transactions; settle the first migration's
  // deferred FK events before the next migration alters the same table.
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query(snapshotWriteMigrationSql);
  const retentionBackfill = await client.query(
    'SELECT retain_graph_artifacts AS retained FROM workspaces WHERE id = $1',
    [workspaceA],
  );
  if (retentionBackfill.rows[0]?.retained !== true) {
    throw new Error('file-snapshot retention backfill did not enable immutable artifact retention');
  }

  await expectNoCatalogEntries(
    'retired push-job candidate columns',
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'push_jobs'
        AND column_name = ANY($2::text[])`,
    [schema, candidateColumns],
  );
  await expectNoCatalogEntries(
    'retired Turso applied-manifest column',
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'workspaces'
        AND column_name = 'turso_applied_manifest'`,
    [schema],
  );
  await expectNoCatalogEntries(
    'retired push-job candidate constraints',
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE constraint_schema = $1
        AND constraint_name = ANY($2::text[])`,
    [schema, candidateConstraints],
  );
  await expectNoCatalogEntries(
    'retired Turso applied-manifest constraint',
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE constraint_schema = $1
        AND constraint_name = 'workspaces_turso_applied_manifest_object_check'`,
    [schema],
  );
  await expectNoCatalogEntries(
    'retired push-job candidate trigger',
    `SELECT trigger_name
       FROM information_schema.triggers
      WHERE trigger_schema = $1
        AND trigger_name = 'push_jobs_candidate_fields_immutable'`,
    [schema],
  );
  await expectNoCatalogEntries(
    'retired push-job candidate function',
    `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
        AND p.proname = 'reject_push_job_candidate_field_change'`,
    [schema],
  );

  await client.query('INSERT INTO workspaces (id) VALUES ($1)', [workspaceB]);
  await client.query(
    `INSERT INTO workspace_repos (id, workspace_id, repo_key, repo_name)
     VALUES ($1, $2, 'repo-a', 'api'), ($3, $4, 'repo-b', 'billing')`,
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceA, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workspaceB],
  );
  await client.query('INSERT INTO push_jobs (id, workspace_id) VALUES ($1, $2)', ['job-a', workspaceA]);

  const insertVersion = async (workspaceId, versionId, parentVersionId = null) =>
    client.query(
      `INSERT INTO workspace_graph_versions
        (workspace_id, version_id, engine, r2_key, sha256, size_bytes,
         storage_format_version, manifest, parent_version_id)
       VALUES ($1, $2, 'ladybug', $3, $4, 42, 1, '{}'::jsonb, $5)`,
      [workspaceId, versionId, `${workspaceId}/${versionId}.graph`, 'a'.repeat(64), parentVersionId],
    );

  await insertVersion(workspaceA, 'v1');
  await insertVersion(workspaceB, 'v-parent');
  await client.query(
    "UPDATE workspaces SET graph_backend = 'file_snapshot', active_graph_version_id = 'v1', retain_graph_artifacts = true WHERE id = $1",
    [workspaceA],
  );
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('SET CONSTRAINTS ALL DEFERRED');

  await expectPgFailure('cross-workspace active pointer', '23503', () =>
    client.query("UPDATE workspaces SET active_graph_version_id = 'v1' WHERE id = $1", [workspaceB]),
  );
  await expectPgFailure('cross-workspace parent pointer', '23503', () =>
    insertVersion(workspaceA, 'v-child', 'v-parent'),
  );
  await expectPgFailure('active version deletion', '23503', () =>
    client.query("DELETE FROM workspace_graph_versions WHERE workspace_id = $1 AND version_id = 'v1'", [workspaceA]),
  );

  const zeroSizeSavepoint = 'probe_zero_size';
  await client.query(`SAVEPOINT ${zeroSizeSavepoint}`);
  let zeroSizeFailure;
  try {
    await client.query(
      `INSERT INTO workspace_graph_versions
        (workspace_id, version_id, engine, r2_key, sha256, size_bytes, storage_format_version, manifest)
       VALUES ($1, 'zero-size', 'ladybug', $2, $3, 0, 1, '{}'::jsonb)`,
      [workspaceB, `${workspaceB}/zero-size.graph`, 'b'.repeat(64)],
    );
  } catch (error) {
    zeroSizeFailure = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${zeroSizeSavepoint}`);
  await client.query(`RELEASE SAVEPOINT ${zeroSizeSavepoint}`);
  if (zeroSizeFailure?.code !== '23514') {
    throw new Error(`zero-sized graph version failed with PostgreSQL code ${zeroSizeFailure?.code ?? 'none'}`);
  }
  rejected.push('zero-sized graph version');

  const artifactKey = `${workspaceA}/api/results/parsed/${'a'.repeat(16)}.json`;
  await client.query(
    `INSERT INTO workspace_repo_artifacts
      (workspace_id, repo_key, repo_name, kind, version, r2_key, sha256, size_bytes)
     VALUES ($1, 'repo-a', 'api', 'parsed', $2, $3, $4, 42)`,
    [workspaceA, 'a'.repeat(16), artifactKey, 'a'.repeat(64)],
  );
  await expectPgFailure('cross-workspace artifact registry', '23503', () =>
    client.query(
      `INSERT INTO workspace_repo_artifacts
        (workspace_id, repo_key, repo_name, kind, version, r2_key, sha256, size_bytes)
       VALUES ($1, 'repo-a', 'api', 'parsed', $2, $3, $4, 42)`,
      [workspaceB, 'b'.repeat(16), `${workspaceB}/api/results/parsed/${'b'.repeat(16)}.json`, 'b'.repeat(64)],
    ),
  );
  await expectPgFailure('wrong-workspace artifact prefix', '23514', () =>
    client.query(
      `INSERT INTO workspace_repo_artifacts
        (workspace_id, repo_key, repo_name, kind, version, r2_key, sha256, size_bytes)
       VALUES ($1, 'repo-b', 'billing', 'parsed', $2, $3, $4, 42)`,
      [workspaceB, 'c'.repeat(16), `${workspaceA}/billing/result.json`, 'c'.repeat(64)],
    ),
  );
  await expectPgFailure('artifact descriptor mutation', '23514', () =>
    client.query(
      `UPDATE workspace_repo_artifacts SET sha256 = $1
       WHERE workspace_id = $2 AND repo_key = 'repo-a' AND kind = 'parsed' AND version = $3`,
      ['d'.repeat(64), workspaceA, 'a'.repeat(16)],
    ),
  );

  await expectPgFailure('file snapshot without retention', '23514', () =>
    client.query(
      "UPDATE workspaces SET graph_backend = 'file_snapshot', retain_graph_artifacts = false WHERE id = $1",
      [workspaceB],
    ),
  );

  await client.query('UPDATE workspaces SET retain_graph_artifacts = true WHERE id = $1', [workspaceA]);
  await expectPgFailure('retention flag clear', '23514', () =>
    client.query('UPDATE workspaces SET retain_graph_artifacts = false WHERE id = $1', [workspaceA]),
  );
  const nullPointer = await client.query(
    'SELECT active_graph_version_id IS NULL AS nullable FROM workspaces WHERE id = $1',
    [workspaceB],
  );
  if (nullPointer.rows[0]?.nullable !== true) throw new Error('active graph pointer no longer permits NULL');

  await insertVersion(workspaceA, 'v-child', 'v1');
  await client.query("UPDATE workspaces SET active_graph_version_id = 'v-child' WHERE id = $1", [workspaceA]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('SET CONSTRAINTS ALL DEFERRED');

  const rollbackSql = `
    UPDATE workspaces w
       SET active_graph_version_id = v.parent_version_id
      FROM workspace_graph_versions v
     WHERE w.id = $1
       AND w.graph_backend = 'file_snapshot'
       AND w.active_graph_version_id = $2
       AND v.workspace_id = w.id
       AND v.version_id = w.active_graph_version_id
    RETURNING v.version_id AS rolled_back_from, v.parent_version_id AS rolled_back_to
  `;
  const childRollback = await client.query(rollbackSql, [workspaceA, 'v-child']);
  const childRollbackRow = childRollback.rows[0];
  if (
    childRollback.rows.length !== 1 ||
    childRollbackRow?.rolled_back_from !== 'v-child' ||
    childRollbackRow?.rolled_back_to !== 'v1'
  ) {
    throw new Error('derived-parent rollback did not move the child pointer to its parent');
  }

  const staleRollback = await client.query(rollbackSql, [workspaceA, 'v-child']);
  if (staleRollback.rows.length !== 0) throw new Error('stale expected version unexpectedly moved the graph pointer');

  const firstVersionRollback = await client.query(rollbackSql, [workspaceA, 'v1']);
  const firstVersionRollbackRow = firstVersionRollback.rows[0];
  if (
    firstVersionRollback.rows.length !== 1 ||
    firstVersionRollbackRow?.rolled_back_from !== 'v1' ||
    firstVersionRollbackRow?.rolled_back_to !== null
  ) {
    throw new Error('rolling back the first version did not clear the graph pointer');
  }
  const clearedPointer = await client.query(
    'SELECT active_graph_version_id IS NULL AS cleared FROM workspaces WHERE id = $1',
    [workspaceA],
  );
  if (clearedPointer.rows[0]?.cleared !== true) {
    throw new Error('rolling back the first version returned NULL without clearing the graph pointer');
  }

  const versionHistory = await client.query(
    'SELECT COUNT(*)::int AS count FROM workspace_graph_versions WHERE workspace_id = $1',
    [workspaceA],
  );
  if (versionHistory.rows[0]?.count !== 2) throw new Error('rollback mutated immutable graph-version history');

  await proveAdvisorySerialization();

  // The deferred active FK must not break the owner's cascade as both rows
  // disappear by transaction end.
  await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceA]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  const remaining = await client.query(
    'SELECT COUNT(*)::int AS count FROM workspace_graph_versions WHERE workspace_id = $1',
    [workspaceA],
  );
  if (remaining.rows[0]?.count !== 0) throw new Error('workspace cascade left graph-version rows behind');

  process.stdout.write(
    `${JSON.stringify({
      rejected,
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
    })}\n`,
  );
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end().catch(() => undefined);
}
