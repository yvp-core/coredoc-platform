import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.PHASE_D_MIGRATION_TEST_DATABASE_URL;
if (!DATABASE_URL) throw new Error('PHASE_D_MIGRATION_TEST_DATABASE_URL is required');

const migrationSql = await readFile(
  resolve(process.argv[2] ?? 'prisma/migrations/20260818170000_delete_legacy_delivery_remnants/migration.sql'),
  'utf8',
);
const schema = `delivery_phase_d_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const connectorIds = { jira: randomUUID(), github: randomUUID(), coredoc: randomUUID() };
const actorId = randomUUID();
const agentSessionId = randomUUID();
const workflowRunId = randomUUID();
const deliveryTaskId = `cdt_${randomUUID()}`;
const legacyWorkItemId = randomUUID();
const client = new Client({ connectionString: DATABASE_URL });

const droppedTables = [
  'delivery_flow_run_records',
  'delivery_links',
  'delivery_rework_episodes',
  'delivery_spec_revisions',
  'delivery_task_journeys',
  'delivery_work_item_transitions',
  'delivery_work_items',
];
const droppedTypes = ['FlowRecordSource', 'LinkMethod', 'LinkRel', 'ObservationChannel', 'WorkItemStage'];
const droppedAgentColumns = ['edit_verify_rounds', 'outcome', 'run_id', 'spec_id', 'workflow_summary'];

try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);

  await client.query(`
    CREATE TYPE "DeliveryProvider" AS ENUM ('jira', 'github', 'gitlab', 'coredoc');
    CREATE TYPE "PushJobType" AS ENUM ('push', 'resolve', 'classify', 'renormalize');
    CREATE TYPE "WorkItemStage" AS ENUM ('backlog', 'ready', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled');
    CREATE TYPE "LinkRel" AS ENUM ('implements');
    CREATE TYPE "LinkMethod" AS ENUM ('manual');
    CREATE TYPE "ObservationChannel" AS ENUM ('loop', 'connector');
    CREATE TYPE "FlowRecordSource" AS ENUM ('commit', 'telemetry');

    CREATE TABLE workspaces (id UUID PRIMARY KEY);
    CREATE TABLE delivery_connectors (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider "DeliveryProvider" NOT NULL
    );
    CREATE TABLE delivery_status_map (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connector_id UUID NOT NULL REFERENCES delivery_connectors(id) ON DELETE CASCADE,
      status_raw TEXT NOT NULL,
      stage "WorkItemStage" NOT NULL,
      lifecycle TEXT,
      creates_ship_evidence BOOLEAN NOT NULL DEFAULT false,
      source TEXT NOT NULL
    );
    CREATE TABLE delivery_raw_payloads (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connector_id UUID NOT NULL REFERENCES delivery_connectors(id) ON DELETE CASCADE,
      payload JSONB NOT NULL
    );
    CREATE TABLE delivery_code_changes (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connector_id UUID NOT NULL REFERENCES delivery_connectors(id) ON DELETE CASCADE
    );
    CREATE TABLE delivery_actors (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE delivery_actor_identities (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_id UUID NOT NULL REFERENCES delivery_actors(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL
    );
    CREATE TABLE delivery_tasks (
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE task_external_refs (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL,
      delivery_task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      connector_id UUID REFERENCES delivery_connectors(id) ON DELETE SET NULL,
      FOREIGN KEY (workspace_id, delivery_task_id)
        REFERENCES delivery_tasks(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE capture_events (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      event_id UUID NOT NULL
    );
    CREATE TABLE agent_sessions (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      spec_id TEXT,
      run_id TEXT,
      edit_verify_rounds INTEGER,
      outcome TEXT,
      workflow_summary JSONB
    );
    CREATE INDEX agent_sessions_workspace_id_run_id_idx ON agent_sessions(workspace_id, run_id);
    CREATE TABLE workflow_runs (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      agent_session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE push_jobs (id TEXT PRIMARY KEY, type "PushJobType" NOT NULL);

    CREATE TABLE delivery_work_items (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL,
      connector_id UUID NOT NULL,
      current_stage "WorkItemStage" NOT NULL
    );
    CREATE TABLE delivery_work_item_transitions (
      id BIGSERIAL PRIMARY KEY,
      work_item_id UUID NOT NULL REFERENCES delivery_work_items(id) ON DELETE CASCADE,
      from_stage "WorkItemStage",
      to_stage "WorkItemStage"
    );
    CREATE TABLE delivery_spec_revisions (
      id BIGSERIAL PRIMARY KEY,
      work_item_id UUID NOT NULL REFERENCES delivery_work_items(id) ON DELETE CASCADE
    );
    CREATE TABLE delivery_task_journeys (
      work_item_id UUID PRIMARY KEY REFERENCES delivery_work_items(id) ON DELETE CASCADE
    );
    CREATE TABLE delivery_links (
      id BIGSERIAL PRIMARY KEY,
      rel "LinkRel" NOT NULL,
      method "LinkMethod" NOT NULL
    );
    CREATE TABLE delivery_flow_run_records (
      id BIGSERIAL PRIMARY KEY,
      source "FlowRecordSource" NOT NULL
    );
    CREATE TABLE delivery_rework_episodes (
      id BIGSERIAL PRIMARY KEY,
      channel "ObservationChannel" NOT NULL
    );
  `);

  await client.query('INSERT INTO workspaces (id) VALUES ($1)', [workspaceId]);
  for (const [provider, connectorId] of Object.entries(connectorIds)) {
    await client.query('INSERT INTO delivery_connectors (id, workspace_id, provider) VALUES ($1, $2, $3)', [
      connectorId,
      workspaceId,
      provider,
    ]);
  }
  await client.query(
    `INSERT INTO delivery_status_map
       (workspace_id, connector_id, status_raw, stage, lifecycle, creates_ship_evidence, source)
     VALUES ($1, $2, 'Done', 'done', 'completed', true, 'admin'),
            ($1, $3, 'Landed', 'done', 'completed', true, 'admin')`,
    [workspaceId, connectorIds.jira, connectorIds.coredoc],
  );
  await client.query(
    `INSERT INTO delivery_raw_payloads (workspace_id, connector_id, payload)
     VALUES ($1, $2, '{"provider":"jira"}'::jsonb),
            ($1, $3, '{"provider":"coredoc"}'::jsonb)`,
    [workspaceId, connectorIds.jira, connectorIds.coredoc],
  );
  await client.query('INSERT INTO delivery_code_changes (id, workspace_id, connector_id) VALUES ($1, $2, $3)', [
    randomUUID(),
    workspaceId,
    connectorIds.github,
  ]);
  await client.query('INSERT INTO delivery_actors (id, workspace_id) VALUES ($1, $2)', [actorId, workspaceId]);
  await client.query(
    `INSERT INTO delivery_actor_identities (workspace_id, actor_id, provider, external_id)
     VALUES ($1, $2, 'jira', 'actor-1')`,
    [workspaceId, actorId],
  );
  await client.query('INSERT INTO delivery_tasks (workspace_id, id) VALUES ($1, $2)', [workspaceId, deliveryTaskId]);
  await client.query(
    `INSERT INTO task_external_refs
       (workspace_id, delivery_task_id, provider, external_id, connector_id)
     VALUES ($1, $2, 'jira', 'SCRUM-15', $3),
            ($1, $2, 'coredoc', 'retired-spec', $4)`,
    [workspaceId, deliveryTaskId, connectorIds.jira, connectorIds.coredoc],
  );
  await client.query('INSERT INTO capture_events (workspace_id, event_id) VALUES ($1, $2)', [
    workspaceId,
    randomUUID(),
  ]);
  await client.query(
    `INSERT INTO agent_sessions
       (id, workspace_id, provider, session_id, spec_id, run_id, edit_verify_rounds, outcome, workflow_summary)
     VALUES ($1, $2, 'claude-code', 'session-1', 'SF-1', 'cdr-20260818-a1b2c3', 2, 'success', '{"outcome":"success"}'::jsonb)`,
    [agentSessionId, workspaceId],
  );
  await client.query(
    `INSERT INTO workflow_runs (id, workspace_id, run_id, agent_session_id)
     VALUES ($1, $2, 'cdr-20260818-a1b2c3', $3)`,
    [workflowRunId, workspaceId, agentSessionId],
  );
  await client.query("INSERT INTO push_jobs (id, type) VALUES ('classify-1', 'classify'), ('push-1', 'push')");
  await client.query(
    `INSERT INTO delivery_work_items (id, workspace_id, connector_id, current_stage)
     VALUES ($1, $2, $3, 'done')`,
    [legacyWorkItemId, workspaceId, connectorIds.jira],
  );
  await client.query(
    `INSERT INTO delivery_work_item_transitions (work_item_id, from_stage, to_stage)
     VALUES ($1, 'in_progress', 'done')`,
    [legacyWorkItemId],
  );
  await client.query('INSERT INTO delivery_spec_revisions (work_item_id) VALUES ($1)', [legacyWorkItemId]);
  await client.query('INSERT INTO delivery_task_journeys (work_item_id) VALUES ($1)', [legacyWorkItemId]);
  await client.query("INSERT INTO delivery_links (rel, method) VALUES ('implements', 'manual')");
  await client.query("INSERT INTO delivery_flow_run_records (source) VALUES ('telemetry')");
  await client.query("INSERT INTO delivery_rework_episodes (channel) VALUES ('loop')");

  await client.query(migrationSql);

  const retained = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM delivery_connectors) AS connectors,
      (SELECT COUNT(*)::int FROM delivery_raw_payloads) AS raw_payloads,
      (SELECT COUNT(*)::int FROM delivery_status_map) AS status_maps,
      (SELECT COUNT(*)::int FROM delivery_code_changes) AS code_changes,
      (SELECT COUNT(*)::int FROM delivery_actors) AS actors,
      (SELECT COUNT(*)::int FROM delivery_actor_identities) AS actor_identities,
      (SELECT COUNT(*)::int FROM delivery_tasks) AS tasks,
      (SELECT COUNT(*)::int FROM task_external_refs) AS external_refs,
      (SELECT COUNT(*)::int FROM capture_events) AS capture_events,
      (SELECT COUNT(*)::int FROM agent_sessions) AS agent_sessions,
      (SELECT COUNT(*)::int FROM workflow_runs) AS workflow_runs,
      (SELECT COUNT(*)::int FROM push_jobs) AS push_jobs
  `);
  const detached = await client.query(
    `SELECT provider, connector_id IS NULL AS detached
       FROM task_external_refs
      ORDER BY provider`,
  );
  const remainingTables = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = ANY($2::text[])
      ORDER BY table_name`,
    [schema, droppedTables],
  );
  const remainingTypes = await client.query(
    `SELECT t.typname
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = ANY($2::text[])
      ORDER BY t.typname`,
    [schema, droppedTypes],
  );
  const remainingAgentColumns = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'agent_sessions'
        AND column_name = ANY($2::text[])
      ORDER BY column_name`,
    [schema, droppedAgentColumns],
  );
  const remainingStatusStage = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'delivery_status_map'
        AND column_name = 'stage'`,
    [schema],
  );
  const workflow = await client.query(
    `SELECT w.run_id, a.session_id
       FROM workflow_runs w
       JOIN agent_sessions a ON a.id = w.agent_session_id`,
  );

  process.stdout.write(
    JSON.stringify({
      retained: retained.rows[0],
      externalRefs: detached.rows,
      workflow: workflow.rows[0],
      remainingTables: remainingTables.rows.map((row) => row.table_name),
      remainingTypes: remainingTypes.rows.map((row) => row.typname),
      remainingAgentColumns: remainingAgentColumns.rows.map((row) => row.column_name),
      statusStagePresent: remainingStatusStage.rows.length > 0,
    }),
  );
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end().catch(() => undefined);
}
