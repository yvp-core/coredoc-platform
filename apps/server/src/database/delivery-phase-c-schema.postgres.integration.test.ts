import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrismaAdapter } from './create-prisma-client.js';
import { PrismaClient } from '../generated/prisma/client.js';

const TEST_DATABASE_URL = process.env.PHASE_C_SCHEMA_TEST_DATABASE_URL ?? '';
const RUN = `phase-c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

function taskId(): string {
  return `cdt_${randomUUID()}`;
}

async function expectSqlState(operation: Promise<unknown>, state: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const originalCode = (
      error as {
        meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
      }
    ).meta?.driverAdapterError?.cause?.originalCode;
    expect(originalCode).toBe(state);
    return;
  }
  throw new Error(`Expected PostgreSQL SQLSTATE ${state}`);
}

describe.skipIf(!TEST_DATABASE_URL)('Phase-C delivery schema (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds.reverse()) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function createWorkspace(suffix: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name: `${RUN}-${suffix}`, slug: `${RUN}-${suffix}` },
    });
    workspaceIds.push(workspace.id);
    return workspace.id;
  }

  async function createConnector(
    workspaceId: string,
    suffix: string,
    provider: 'jira' | 'github' = 'jira',
  ): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "delivery_connectors"
         ("workspace_id", "provider", "display_name", "config", "capabilities", "cursors", "created_at")
       VALUES ($1::uuid, $2::"DeliveryProvider", $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)
       RETURNING "id"::text`,
      workspaceId,
      provider,
      `${RUN}-${suffix}`,
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Connector insert returned no ID');
    return id;
  }

  async function createTask(workspaceId: string, id = taskId()): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "delivery_tasks"
         ("workspace_id", "id", "lifecycle", "authority", "created_by", "created_at", "updated_at")
       VALUES ($1::uuid, $2, 'active', 'coredoc', 'phase-c-schema-test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      workspaceId,
      id,
    );
    return id;
  }

  async function createRef(
    workspaceId: string,
    deliveryTaskId: string,
    connectorId: string,
    externalId: string,
  ): Promise<bigint> {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
      `INSERT INTO "task_external_refs"
         ("workspace_id", "delivery_task_id", "provider", "external_id", "external_key",
          "external_url", "external_state", "connector_id", "source_updated_at", "last_observed_at")
       VALUES ($1::uuid, $2, 'jira', $3, $3, $4, 'In Progress', $5::uuid,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING "id"`,
      workspaceId,
      deliveryTaskId,
      externalId,
      `https://jira.example.test/browse/${externalId}`,
      connectorId,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('External-ref insert returned no ID');
    return id;
  }

  async function createActor(workspaceId: string, suffix: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "delivery_actors" ("workspace_id", "display_name", "kind", "created_at")
       VALUES ($1::uuid, $2, 'human', CURRENT_TIMESTAMP)
       RETURNING "id"::text`,
      workspaceId,
      `${RUN}-${suffix}`,
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Delivery-actor insert returned no ID');
    return id;
  }

  it('enforces exact authority within the same workspace/task and retains it across connector deletion', async () => {
    const workspaceA = await createWorkspace('authority-a');
    const workspaceB = await createWorkspace('authority-b');
    const connectorA = await createConnector(workspaceA, 'connector-a');
    const connectorB = await createConnector(workspaceB, 'connector-b');
    const taskA = await createTask(workspaceA);
    const taskB = await createTask(workspaceA);
    const taskOtherWorkspace = await createTask(workspaceB, taskA);
    const refA = await createRef(workspaceA, taskA, connectorA, `${RUN}-A`);
    const refB = await createRef(workspaceA, taskB, connectorA, `${RUN}-B`);
    const refOtherWorkspace = await createRef(workspaceB, taskOtherWorkspace, connectorB, `${RUN}-OTHER`);
    const actorA = await createActor(workspaceA, 'actor-a');
    const actorB = await createActor(workspaceB, 'actor-b');

    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "task_external_refs"
           ("workspace_id", "delivery_task_id", "provider", "external_id", "connector_id",
            "source_updated_at", "last_observed_at")
         VALUES ($1::uuid, $2, 'jira', $3, $4::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        workspaceA,
        taskA,
        `${RUN}-CROSS-CONNECTOR`,
        connectorB,
      ),
      '23503',
    );

    await prisma.$executeRawUnsafe(
      `UPDATE "delivery_tasks"
       SET "authority_ref_id" = $3, "authority" = 'connector:jira'
       WHERE "workspace_id" = $1::uuid AND "id" = $2`,
      workspaceA,
      taskA,
      refA,
    );

    await expectSqlState(
      prisma.$executeRawUnsafe(
        `UPDATE "delivery_tasks" SET "authority_ref_id" = $3
         WHERE "workspace_id" = $1::uuid AND "id" = $2`,
        workspaceA,
        taskA,
        refB,
      ),
      '23503',
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `UPDATE "delivery_tasks" SET "authority_ref_id" = $3
         WHERE "workspace_id" = $1::uuid AND "id" = $2`,
        workspaceA,
        taskA,
        refOtherWorkspace,
      ),
      '23503',
    );

    const stateSourceRef = `${RUN}:authority-state`;
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "task_external_ref_state_facts"
           ("workspace_id", "external_ref_id", "source_ref", "from_state", "to_state",
            "occurred_at", "source_updated_at", "received_at", "actor_id")
         VALUES ($1::uuid, $2, $3, 'Open', 'In Progress', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $4::uuid)`,
        workspaceA,
        refA,
        `${stateSourceRef}:cross-actor`,
        actorB,
      ),
      '23503',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "task_external_ref_state_facts"
         ("workspace_id", "external_ref_id", "source_ref", "from_state", "to_state",
          "occurred_at", "source_updated_at", "received_at", "actor_id")
       VALUES ($1::uuid, $2, $3, 'Open', 'In Progress', CURRENT_TIMESTAMP,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $4::uuid)`,
      workspaceA,
      refA,
      stateSourceRef,
      actorA,
    );
    await expectSqlState(prisma.$executeRawUnsafe(`DELETE FROM "task_external_refs" WHERE "id" = $1`, refA), '23503');

    await prisma.$executeRawUnsafe(`DELETE FROM "delivery_connectors" WHERE "id" = $1::uuid`, connectorA);
    await prisma.$executeRawUnsafe(`DELETE FROM "delivery_actors" WHERE "id" = $1::uuid`, actorA);
    const rows = await prisma.$queryRawUnsafe<
      Array<{ authorityRefId: bigint; connectorId: string | null; stateFacts: bigint; actorsCleared: boolean }>
    >(
      `SELECT t."authority_ref_id" AS "authorityRefId", r."connector_id"::text AS "connectorId",
              COUNT(f."id") AS "stateFacts", BOOL_AND(f."actor_id" IS NULL) AS "actorsCleared"
       FROM "delivery_tasks" t
       JOIN "task_external_refs" r ON r."id" = t."authority_ref_id"
       LEFT JOIN "task_external_ref_state_facts" f ON f."external_ref_id" = r."id"
       WHERE t."workspace_id" = $1::uuid AND t."id" = $2
       GROUP BY t."authority_ref_id", r."connector_id"`,
      workspaceA,
      taskA,
    );
    expect(rows).toEqual([{ authorityRefId: refA, connectorId: null, stateFacts: 1n, actorsCleared: true }]);

    await prisma.workspace.delete({ where: { id: workspaceA } });
    expect(await prisma.deliveryTask.count({ where: { workspaceId: workspaceA } })).toBe(0);
  });

  it('enforces fact dedupe, projection metadata, and the received-at purge index', async () => {
    const workspaceId = await createWorkspace('facts');
    const connectorId = await createConnector(workspaceId, 'facts-connector');
    const githubConnectorId = await createConnector(workspaceId, 'github-connector', 'github');
    const firstTask = await createTask(workspaceId);
    const secondTask = await createTask(workspaceId);
    const externalRefId = await createRef(workspaceId, firstTask, connectorId, `${RUN}-FACT`);
    const sourceRef = `${RUN}:transition:1`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "task_external_ref_state_facts"
         ("workspace_id", "external_ref_id", "source_ref", "from_state", "to_state",
          "occurred_at", "source_updated_at", "received_at")
       VALUES ($1::uuid, $2, $3, 'Open', 'Done', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      workspaceId,
      externalRefId,
      sourceRef,
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "task_external_ref_state_facts"
           ("workspace_id", "external_ref_id", "source_ref", "from_state", "to_state",
            "occurred_at", "source_updated_at", "received_at")
         VALUES ($1::uuid, $2, $3, 'Open', 'Done', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        workspaceId,
        externalRefId,
        sourceRef,
      ),
      '23505',
    );

    const codeChanges = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "delivery_code_changes"
         ("workspace_id", "connector_id", "provider", "repo_external_id", "external_id",
          "state", "attrs", "updated_at")
       VALUES ($1::uuid, $2::uuid, 'github', $3, '7', 'merged', '{}'::jsonb, CURRENT_TIMESTAMP)
       RETURNING "id"::text`,
      workspaceId,
      githubConnectorId,
      `${RUN}/repo`,
    );
    const codeChangeId = codeChanges[0]?.id;
    if (!codeChangeId) throw new Error('Code-change insert returned no ID');
    await prisma.$executeRawUnsafe(
      `INSERT INTO "delivery_task_code_changes"
         ("workspace_id", "delivery_task_id", "code_change_id", "association_source",
          "association_source_value", "created_at")
       VALUES ($1::uuid, $2, $3::uuid, 'issue_key', $4, CURRENT_TIMESTAMP)`,
      workspaceId,
      firstTask,
      codeChangeId,
      `${RUN}-FACT`,
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "delivery_task_code_changes"
           ("workspace_id", "delivery_task_id", "code_change_id", "association_source",
            "association_source_value", "created_at")
         VALUES ($1::uuid, $2, $3::uuid, 'run_id', $4, CURRENT_TIMESTAMP)`,
        workspaceId,
        firstTask,
        codeChangeId,
        'cdr-20260817-a1b2c3',
      ),
      '23505',
    );

    const shipKey = `${RUN}:ship:1`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "delivery_ship_evidence"
         ("workspace_id", "delivery_task_id", "source", "source_key", "occurred_at", "received_at")
       VALUES ($1::uuid, $2, 'coredoc', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      workspaceId,
      firstTask,
      shipKey,
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "delivery_ship_evidence"
           ("workspace_id", "delivery_task_id", "source", "source_key", "occurred_at", "received_at")
         VALUES ($1::uuid, $2, 'coredoc', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        workspaceId,
        secondTask,
        shipKey,
      ),
      '23505',
    );

    const reworkKey = `${RUN}:rework:1`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "delivery_rework_signals"
         ("workspace_id", "delivery_task_id", "kind", "source_key", "source_ref",
          "occurred_at", "observed_at")
       VALUES ($1::uuid, $2, 'tracker_reopened', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      workspaceId,
      firstTask,
      reworkKey,
      sourceRef,
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "delivery_rework_signals"
           ("workspace_id", "delivery_task_id", "kind", "source_key", "source_ref",
            "occurred_at", "observed_at")
         VALUES ($1::uuid, $2, 'tracker_reopened', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        workspaceId,
        secondTask,
        reworkKey,
        sourceRef,
      ),
      '23505',
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO "capture_accepted_watermarks"
         ("workspace_id", "actor_id", "host", "scope_key", "repository_key",
          "first_accepted_at", "last_accepted_at")
       VALUES ($1::uuid, $2, 'claude-code', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      workspaceId,
      `${RUN}-actor`,
      'repo:coredoc/coredoc-parser',
      'coredoc/coredoc-parser',
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "capture_accepted_watermarks"
           ("workspace_id", "actor_id", "host", "scope_key", "repository_key",
            "first_accepted_at", "last_accepted_at")
         VALUES ($1::uuid, $2, 'claude-code', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        workspaceId,
        `${RUN}-actor`,
        'repo:coredoc/coredoc-parser',
        'coredoc/coredoc-parser',
      ),
      '23505',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "capture_accepted_watermarks"
         ("workspace_id", "actor_id", "host", "scope_key", "repository_key",
          "first_accepted_at", "last_accepted_at")
       VALUES ($1::uuid, $2, 'codex', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      workspaceId,
      `${RUN}-codex-actor`,
      'repo:coredoc/coredoc-parser',
      'coredoc/coredoc-parser',
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "capture_accepted_watermarks"
           ("workspace_id", "actor_id", "host", "scope_key", "repository_key",
            "first_accepted_at", "last_accepted_at")
         VALUES ($1::uuid, $2, 'codex', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        workspaceId,
        `${RUN}-codex-actor`,
        'repo:coredoc/coredoc-parser',
        'coredoc/coredoc-parser',
      ),
      '23505',
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "capture_accepted_watermarks"
           ("workspace_id", "actor_id", "host", "scope_key", "repository_key",
            "first_accepted_at", "last_accepted_at")
         VALUES ($1::uuid, $2, 'codex', $3, $4,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 second')`,
        workspaceId,
        `${RUN}-invalid-time`,
        'repo:coredoc/coredoc-parser',
        'coredoc/coredoc-parser',
      ),
      '23514',
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO "capture_retention_checkpoints"
         ("id", "purged_through_received_at", "updated_at")
       VALUES ('capture_fine_events', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "capture_retention_checkpoints"
           ("id", "purged_through_received_at", "updated_at")
         VALUES ('another_scope', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ),
      '23514',
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO "delivery_raw_payloads"
         ("workspace_id", "connector_id", "resource_type", "external_id", "payload",
          "norm_version", "canonical_projection_version")
       VALUES
         ($1::uuid, $2::uuid, 'pull_request', 'null', '{}'::jsonb, 4, NULL),
         ($1::uuid, $2::uuid, 'pull_request', 'old', '{}'::jsonb, 4, 1),
         ($1::uuid, $2::uuid, 'pull_request', 'current', '{}'::jsonb, 3, 2)`,
      workspaceId,
      githubConnectorId,
    );
    const replayRows = await prisma.$queryRawUnsafe<Array<{ externalId: string }>>(
      `SELECT "external_id" AS "externalId"
       FROM "delivery_raw_payloads"
       WHERE "workspace_id" = $1::uuid
         AND "resource_type" = 'pull_request'
         AND ("canonical_projection_version" IS NULL OR "canonical_projection_version" < 2)
       ORDER BY "id"`,
      workspaceId,
    );
    expect(replayRows).toEqual([{ externalId: 'null' }, { externalId: 'old' }]);

    const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'delivery_raw_payloads'
         AND column_name = 'canonical_projection_version'`,
    );
    expect(columns).toEqual([{ name: 'canonical_projection_version' }]);

    const indexes = await prisma.$queryRawUnsafe<Array<{ name: string; definition: string }>>(
      `SELECT indexname AS name, indexdef AS definition
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN (
           'capture_events_received_at_id_idx',
           'delivery_raw_payloads_projection_replay_idx'
         )
       ORDER BY indexname`,
    );
    expect(indexes).toHaveLength(2);
    expect(indexes.find((index) => index.name === 'capture_events_received_at_id_idx')?.definition).toContain(
      '(received_at, id)',
    );
    expect(indexes.find((index) => index.name === 'delivery_raw_payloads_projection_replay_idx')?.definition).toContain(
      '(workspace_id, resource_type, canonical_projection_version, id)',
    );
  });
});
