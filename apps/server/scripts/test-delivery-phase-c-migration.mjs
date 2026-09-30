import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.PHASE_C_MIGRATION_TEST_DATABASE_URL;
if (!DATABASE_URL) throw new Error('PHASE_C_MIGRATION_TEST_DATABASE_URL is required');

const migrationSql = await readFile(
  resolve(process.argv[2] ?? 'prisma/migrations/20260817000000_add_delivery_phase_c_foundation/migration.sql'),
  'utf8',
);
const schema = `delivery_phase_c_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const connectorId = randomUUID();
const taskIds = {
  coredoc: `cdt_${randomUUID()}`,
  exact: `cdt_${randomUUID()}`,
  zero: `cdt_${randomUUID()}`,
  multiple: `cdt_${randomUUID()}`,
};
const client = new Client({ connectionString: DATABASE_URL });

try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);

  await client.query('CREATE TABLE workspaces (id UUID PRIMARY KEY)');
  await client.query(`
    CREATE TABLE delivery_connectors (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE delivery_tasks (
      workspace_id UUID NOT NULL,
      id VARCHAR(40) NOT NULL,
      lifecycle VARCHAR(16) NOT NULL,
      authority VARCHAR(80) NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (workspace_id, id)
    )
  `);
  await client.query(`
    CREATE TABLE task_external_refs (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL,
      delivery_task_id VARCHAR(40) NOT NULL,
      provider VARCHAR(64) NOT NULL,
      external_id VARCHAR(256) NOT NULL,
      external_key VARCHAR(256),
      external_url VARCHAR(2048),
      external_state VARCHAR(128),
      UNIQUE (workspace_id, provider, external_id)
    )
  `);
  await client.query(`
    CREATE TABLE delivery_status_map (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL,
      connector_id UUID NOT NULL,
      status_raw TEXT NOT NULL,
      stage TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE delivery_raw_payloads (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL,
      connector_id UUID NOT NULL,
      resource_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL,
      norm_version INTEGER
    )
  `);
  await client.query(`
    CREATE TABLE delivery_code_changes (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE capture_events (
      id BIGSERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query('CREATE TABLE delivery_actors (id UUID PRIMARY KEY, workspace_id UUID NOT NULL)');

  await client.query('INSERT INTO workspaces (id) VALUES ($1)', [workspaceId]);
  await client.query('INSERT INTO delivery_connectors (id, workspace_id) VALUES ($1, $2)', [connectorId, workspaceId]);
  for (const [kind, taskId] of Object.entries(taskIds)) {
    await client.query(
      `INSERT INTO delivery_tasks
         (workspace_id, id, lifecycle, authority, created_by, updated_at)
       VALUES ($1, $2, 'active', $3, 'migration-test', CURRENT_TIMESTAMP)`,
      [workspaceId, taskId, kind === 'coredoc' ? 'coredoc' : 'connector:jira'],
    );
  }
  const exactRef = await client.query(
    `INSERT INTO task_external_refs
       (workspace_id, delivery_task_id, provider, external_id)
     VALUES ($1, $2, 'jira', 'exact') RETURNING id`,
    [workspaceId, taskIds.exact],
  );
  await client.query(
    `INSERT INTO task_external_refs
       (workspace_id, delivery_task_id, provider, external_id)
     VALUES ($1, $2, 'jira', 'multiple-a'), ($1, $2, 'jira', 'multiple-b')`,
    [workspaceId, taskIds.multiple],
  );

  await client.query(migrationSql);
  const rows = await client.query(
    `SELECT id, authority_ref_id
     FROM delivery_tasks
     WHERE workspace_id = $1
     ORDER BY id`,
    [workspaceId],
  );
  const authorityByTask = Object.fromEntries(rows.rows.map((row) => [row.id, row.authority_ref_id]));
  const unresolved = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM delivery_tasks
     WHERE authority <> 'coredoc' AND authority_ref_id IS NULL`,
  );

  process.stdout.write(
    JSON.stringify({
      coredoc: authorityByTask[taskIds.coredoc] ?? null,
      exact: authorityByTask[taskIds.exact] ?? null,
      expectedExact: exactRef.rows[0].id,
      zero: authorityByTask[taskIds.zero] ?? null,
      multiple: authorityByTask[taskIds.multiple] ?? null,
      unresolved: unresolved.rows[0].count,
    }),
  );
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end().catch(() => undefined);
}
