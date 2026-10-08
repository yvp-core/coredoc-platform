import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Hand-written partial indexes Prisma cannot represent: `prisma migrate dev`
 * proposes dropping them, and code depends on each one for correctness.
 */
const HAND_WRITTEN_PARTIAL_INDEXES = [
  // Enqueue's P2002 race handling in push-queue.service.ts.
  { name: 'push_jobs_one_active_push_per_repo', migration: '20260804000000_cloud_push_reliability' },
  // ACTIVE_RUN_EXISTS: one non-terminal cloud agent run per workspace and Jira issue.
  { name: 'cloud_agent_runs_one_open_run_per_issue', migration: '20261010120000_cloud_agent_runs' },
  // One queued or claimed turn per run.
  { name: 'cloud_agent_run_turns_one_pending_turn_per_run', migration: '20261010120000_cloud_agent_runs' },
];

describe('database migration invariants', () => {
  it('keeps the legacy agent-session key valid for application rollback', async () => {
    const migration = await readFile(
      resolve(process.cwd(), 'prisma/migrations/20260816000000_add_capture_foundation/migration.sql'),
      'utf8',
    );
    const schema = await readFile(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');

    expect(migration).not.toContain('DROP INDEX "agent_sessions_workspace_id_session_id_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "agent_sessions_workspace_id_provider_session_id_key"');
    expect(schema).toContain('@@unique([workspaceId, sessionId])');
    expect(schema).toContain('@@unique([workspaceId, provider, sessionId])');
  });

  it('enforces workspace-scoped immutable graph-version pointers in PostgreSQL', async () => {
    const migrationPath = resolve(
      process.cwd(),
      'prisma/migrations/20260811000000_add_workspace_graph_versions/migration.sql',
    );
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('"graph_backend" VARCHAR(32) NOT NULL DEFAULT \'turso\'');
    expect(sql).toContain('"active_graph_version_id" VARCHAR(64)');
    expect(sql).toContain('CREATE TABLE "workspace_graph_versions"');
    expect(sql).toContain('PRIMARY KEY ("workspace_id", "version_id")');
    expect(sql).toContain('CHECK ("size_bytes" > 0)');
    expect(sql).toContain('ON "workspace_graph_versions"("workspace_id", "parent_version_id")');
    expect(sql).toMatch(
      /FOREIGN KEY \("id", "active_graph_version_id"\)\s+REFERENCES "workspace_graph_versions"\("workspace_id", "version_id"\)\s+ON DELETE NO ACTION ON UPDATE NO ACTION\s+DEFERRABLE INITIALLY DEFERRED/s,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("workspace_id", "parent_version_id"\)\s+REFERENCES "workspace_graph_versions"\("workspace_id", "version_id"\)\s+ON DELETE NO ACTION ON UPDATE NO ACTION\s+DEFERRABLE INITIALLY DEFERRED/s,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("workspace_id"\)\s+REFERENCES "workspaces"\("id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE/s,
    );
    expect(sql).not.toMatch(/"active"\s+BOOLEAN/i);
  });

  it.each(HAND_WRITTEN_PARTIAL_INDEXES)(
    'keeps the hand-written partial index $name in the migration history',
    async ({ name, migration }) => {
      const migrationsDir = resolve(process.cwd(), 'prisma/migrations');
      const migrationNames = (await readdir(migrationsDir)).sort();
      let createMigration: string | null = null;

      for (const migrationName of migrationNames) {
        const sql = await readFile(resolve(migrationsDir, migrationName, 'migration.sql'), 'utf8').catch(() => '');
        if (sql.includes(`CREATE UNIQUE INDEX "${name}"`)) createMigration = migrationName;
        if (createMigration && sql.includes(`DROP INDEX "${name}"`)) {
          throw new Error(
            `${migrationName} drops ${name}; Prisma cannot represent this partial index, so recreate it in the same migration`,
          );
        }
      }

      expect(createMigration).toBe(migration);
    },
  );

  it('adds canonical delivery tasks and stage occurrences without replacing legacy delivery rows', async () => {
    const migration = await readFile(
      resolve(process.cwd(), 'prisma/migrations/20260816160000_add_delivery_tasks_and_stages/migration.sql'),
      'utf8',
    );

    for (const additiveSymbol of [
      'CREATE TABLE "delivery_tasks"',
      'CREATE TABLE "task_external_refs"',
      'CREATE TABLE "workflow_stage_occurrences"',
      'ADD COLUMN "delivery_task_id" VARCHAR(40)',
      'ADD COLUMN "declared_stages" JSONB',
      'task_external_refs_workspace_id_provider_external_id_key',
      'workflow_stage_occurrences_workflow_run_id_stage_id_attempt_key',
      'workflow_stage_occurrences_finish_pair_check',
      'workflow_stage_occurrences_time_order_check',
    ]) {
      expect(migration).toContain(additiveSymbol);
    }
    for (const legacyTable of ['delivery_work_items', 'delivery_spec_revisions']) {
      expect(migration).not.toMatch(new RegExp(`(?:DROP|ALTER) TABLE "${legacyTable}"`));
    }
    expect(migration).not.toContain('DROP COLUMN "task_id"');
  });

  it('deduplicates active push rows before creating the partial unique index', async () => {
    const migrationPath = resolve(
      process.cwd(),
      'prisma/migrations/20260804000000_cloud_push_reliability/migration.sql',
    );
    const sql = await readFile(migrationPath, 'utf8');
    const dedupe = sql.indexOf('row_number() OVER');
    const createIndex = sql.indexOf(`CREATE UNIQUE INDEX "push_jobs_one_active_push_per_repo"`);

    expect(dedupe).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(dedupe);
  });

  it('keeps artifact retention while omitting retired graph coordination state', async () => {
    const migrationPath = resolve(
      process.cwd(),
      'prisma/migrations/20260811120000_add_graph_snapshot_write_path/migration.sql',
    );
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE "workspace_repo_artifacts"');
    expect(sql).toContain('PRIMARY KEY ("workspace_id", "repo_key", "kind", "version")');
    expect(sql).toMatch(
      /FOREIGN KEY \("workspace_id", "repo_key"\)\s+REFERENCES "workspace_repos"\("workspace_id", "repo_key"\)/s,
    );
    expect(sql).toContain('"r2_key" LIKE "workspace_id"::text || \'/%\'');
    expect(sql).toContain('"version" ~ \'^[0-9a-f]{16}$\'');
    expect(sql).toContain('CHECK ("sha256" ~ \'^[0-9a-f]{64}$\')');
    expect(sql).toContain('CHECK ("size_bytes" > 0)');
    for (const retainedArtifactSymbol of [
      '"workspace_repo_artifacts_pkey"',
      '"workspace_repo_artifacts_repository_fkey"',
      '"workspace_repo_artifacts_version_check"',
      '"workspace_repo_artifacts_sha256_check"',
      '"workspace_repo_artifacts_size_bytes_check"',
      '"workspace_repo_artifacts_r2_key_prefix_check"',
      '"workspace_repo_artifacts_workspace_id_repo_name_kind_version_idx"',
    ]) {
      expect(sql).toContain(retainedArtifactSymbol);
    }
    expect(sql).toContain('CREATE FUNCTION "reject_workspace_repo_artifact_update"()');
    expect(sql).toContain('CREATE TRIGGER "workspace_repo_artifacts_immutable"');

    for (const removedSymbol of [
      'candidate_manifest',
      'candidate_version_id',
      'candidate_r2_key',
      'candidate_artifact_sha256',
      'candidate_artifact_size_bytes',
      'push_jobs_candidate_manifest_pair_check',
      'push_jobs_candidate_manifest_object_check',
      'push_jobs_candidate_version_id_check',
      'push_jobs_candidate_artifact_triple_check',
      'push_jobs_candidate_artifact_requires_manifest_check',
      'push_jobs_candidate_r2_key_prefix_check',
      'push_jobs_candidate_artifact_sha256_check',
      'push_jobs_candidate_artifact_size_bytes_check',
      'reject_push_job_candidate_field_change',
      'push_jobs_candidate_fields_immutable',
      'turso_applied_manifest',
      'workspaces_turso_applied_manifest_object_check',
    ]) {
      expect(sql).not.toContain(removedSymbol);
    }

    expect(sql).toContain('ADD COLUMN "retain_graph_artifacts" BOOLEAN NOT NULL DEFAULT false');
    const retentionBackfill = sql.search(
      /UPDATE "workspaces"\s+SET "retain_graph_artifacts" = true\s+WHERE "graph_backend" = 'file_snapshot'/s,
    );
    const backendRetentionConstraint = sql.indexOf('"workspaces_file_snapshot_requires_retention_check"');
    expect(retentionBackfill).toBeGreaterThanOrEqual(0);
    expect(backendRetentionConstraint).toBeGreaterThan(retentionBackfill);
    expect(sql).toContain(`CHECK ("graph_backend" <> 'file_snapshot' OR "retain_graph_artifacts")`);
    expect(sql).toContain('CREATE FUNCTION "reject_retain_graph_artifacts_clear"()');
    expect(sql).toContain('CREATE TRIGGER "workspaces_retain_graph_artifacts_monotonic"');

    const schema = await readFile(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/activeGraphVersionId\s+String\?/);
    expect(schema).not.toMatch(/activeGraphVersionId\s+String(?!\?)/);
    for (const removedField of [
      'candidateManifest',
      'candidateVersionId',
      'candidateR2Key',
      'candidateArtifactSha256',
      'candidateArtifactSizeBytes',
      'tursoAppliedManifest',
      'candidate_manifest',
      'candidate_version_id',
      'candidate_r2_key',
      'candidate_artifact_sha256',
      'candidate_artifact_size_bytes',
      'turso_applied_manifest',
    ]) {
      expect(schema).not.toContain(removedField);
    }
  });

  it('documents the operator rollback as executable psql with derived-parent CAS', async () => {
    const runbook = await readFile(resolve(process.cwd(), 'ONPREM.md'), 'utf8');

    expect(runbook).toContain("\\set workspace_id '");
    expect(runbook).toContain("\\set expected_active_version_id '");
    expect(runbook).toContain("w.id = :'workspace_id'::uuid");
    expect(runbook).toContain("w.active_graph_version_id = :'expected_active_version_id'");
    expect(runbook).toContain('expected_version_exists');
    expect(runbook).toContain("gv.version_id = :'expected_active_version_id'");
    expect(runbook).not.toContain('$workspaceId');
    expect(runbook).not.toContain('$expectedActiveVersionId');
  });

  it('adds bounded canonical artifacts and revisions without altering legacy delivery tables', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'prisma/migrations/20260816210000_add_delivery_artifacts/migration.sql'),
      'utf8',
    );
    const schema = await readFile(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');

    expect(sql).toContain('CREATE TABLE "delivery_artifacts"');
    expect(sql).toContain('CREATE TABLE "artifact_revisions"');
    expect(sql).toContain('"delivery_artifacts_id_check"');
    expect(sql).toContain('^cda_[0-9a-f]');
    expect(sql).toContain('"delivery_artifacts_kind_check"');
    expect(sql).toContain("'spec', 'design', 'implementation_issue'");
    expect(sql).toContain('"artifact_revisions_sha256_check"');
    expect(sql).toContain('"artifact_revisions_byte_count_check"');
    expect(sql).toContain('"artifact_revisions_markdown_size_check"');
    expect(sql).toContain('octet_length("markdown") = "byte_count"');
    expect(sql).toContain('"artifact_revisions_checkpoint_check"');
    expect(sql).toContain("'run-finish', 'session-end', 'session-start-reconcile'");
    expect(sql).toContain('"artifact_revisions_workspace_id_artifact_id_sha256_key"');
    expect(sql).toMatch(
      /FOREIGN KEY \("workspace_id", "delivery_task_id"\)\s+REFERENCES "delivery_tasks"\("workspace_id", "id"\)\s+ON DELETE CASCADE/s,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("workspace_id", "artifact_id"\)\s+REFERENCES "delivery_artifacts"\("workspace_id", "id"\)\s+ON DELETE CASCADE/s,
    );
    expect(sql).not.toMatch(/ALTER TABLE "(?:work_items|spec_revisions)"/);
    expect(schema).toContain('model DeliveryArtifact');
    expect(schema).toContain('model ArtifactRevision');
  });

  it('adds the Phase-C delivery and retention foundation without deleting rollback schema', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'prisma/migrations/20260817000000_add_delivery_phase_c_foundation/migration.sql'),
      'utf8',
    );
    const schema = await readFile(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');

    for (const additiveSymbol of [
      'ADD COLUMN "authority_ref_id" BIGINT',
      'ADD COLUMN "canonical_projection_version" INTEGER',
      'ADD COLUMN "lifecycle" VARCHAR(16)',
      'ADD COLUMN "creates_ship_evidence" BOOLEAN NOT NULL DEFAULT false',
      'CREATE TABLE "task_external_ref_state_facts"',
      'CREATE TABLE "delivery_task_code_changes"',
      'CREATE TABLE "delivery_ship_evidence"',
      'CREATE TABLE "delivery_rework_signals"',
      'CREATE TABLE "capture_accepted_watermarks"',
      'CREATE TABLE "capture_retention_checkpoints"',
      'capture_events_received_at_id_idx',
      'delivery_raw_payloads_projection_replay_idx',
      'task_ref_state_source_key',
      'delivery_task_code_changes_pkey',
      'delivery_ship_evidence_source_key',
      'delivery_rework_signals_source_key',
      'delivery_actors_workspace_id_id_key',
      'delivery_tasks_authority_ref_fkey',
      'task_external_refs_connector_workspace_fkey',
      'task_external_ref_state_facts_actor_workspace_fkey',
    ]) {
      expect(sql).toContain(additiveSymbol);
    }

    expect(sql).toMatch(
      /FOREIGN KEY \("workspace_id", "id", "authority_ref_id"\)\s+REFERENCES "task_external_refs"\("workspace_id", "delivery_task_id", "id"\)\s+ON DELETE NO ACTION ON UPDATE CASCADE\s+DEFERRABLE INITIALLY DEFERRED/s,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("workspace_id", "connector_id"\)\s+REFERENCES "delivery_connectors"\("workspace_id", "id"\)\s+ON DELETE SET NULL \("connector_id"\)/s,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("workspace_id", "actor_id"\)\s+REFERENCES "delivery_actors"\("workspace_id", "id"\)\s+ON DELETE SET NULL \("actor_id"\)/s,
    );
    expect(sql).toContain('COUNT(*) = 1');
    expect(sql).toContain('legacy_unresolved');
    expect(sql).toContain(
      'ON "delivery_raw_payloads"("workspace_id", "resource_type", "canonical_projection_version", "id")',
    );
    expect(sql).toContain('ON "capture_events"("received_at", "id")');

    for (const retainedTable of [
      'delivery_work_items',
      'delivery_work_item_transitions',
      'delivery_spec_revisions',
      'delivery_links',
      'delivery_rework_episodes',
      'delivery_task_journeys',
    ]) {
      expect(sql).not.toMatch(new RegExp(`DROP TABLE(?: IF EXISTS)? "${retainedTable}"`));
    }
    expect(sql).not.toMatch(/DROP COLUMN/);

    for (const model of [
      'TaskExternalRefStateFact',
      'DeliveryTaskCodeChange',
      'DeliveryShipEvidence',
      'DeliveryReworkSignal',
      'CaptureAcceptedWatermark',
      'CaptureRetentionCheckpoint',
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
  });

  it('preserves the custom Phase-C foreign-key actions in later migrations', async () => {
    const migrationsDir = resolve(process.cwd(), 'prisma/migrations');
    const migrationNames = (await readdir(migrationsDir)).sort();
    const guarded = [
      {
        name: 'delivery_tasks_authority_ref_fkey',
        signature: 'DEFERRABLE INITIALLY DEFERRED',
      },
      {
        name: 'task_external_refs_connector_workspace_fkey',
        signature: 'ON DELETE SET NULL ("connector_id")',
      },
      {
        name: 'task_external_ref_state_facts_actor_workspace_fkey',
        signature: 'ON DELETE SET NULL ("actor_id")',
      },
    ];

    for (const constraint of guarded) {
      let creationMigration: string | null = null;
      for (const migrationName of migrationNames) {
        const sql = await readFile(resolve(migrationsDir, migrationName, 'migration.sql'), 'utf8').catch(() => '');
        if (sql.includes(`ADD CONSTRAINT "${constraint.name}"`) && sql.includes(constraint.signature)) {
          creationMigration = migrationName;
        }
        if (
          creationMigration &&
          migrationName > creationMigration &&
          sql.includes(`DROP CONSTRAINT "${constraint.name}"`) &&
          !(sql.includes(`ADD CONSTRAINT "${constraint.name}"`) && sql.includes(constraint.signature))
        ) {
          throw new Error(`${migrationName} replaces ${constraint.name} without restoring its required custom action`);
        }
      }
      expect(creationMigration).toBe('20260817000000_add_delivery_phase_c_foundation');
    }
  });
});
