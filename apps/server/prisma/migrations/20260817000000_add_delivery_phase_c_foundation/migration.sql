-- Phase C delivery facts and fine-event retention foundation.
-- Additive only: every legacy Delivery table/column remains available for rollback.

ALTER TABLE "delivery_tasks"
ADD COLUMN "authority_ref_id" BIGINT;

ALTER TABLE "task_external_refs"
ADD COLUMN "connector_id" UUID,
ADD COLUMN "source_updated_at" TIMESTAMPTZ,
ADD COLUMN "last_observed_at" TIMESTAMPTZ;

ALTER TABLE "delivery_status_map"
ADD COLUMN "lifecycle" VARCHAR(16),
ADD COLUMN "creates_ship_evidence" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "delivery_raw_payloads"
ADD COLUMN "canonical_projection_version" INTEGER;

ALTER TABLE "delivery_status_map"
ADD CONSTRAINT "delivery_status_map_lifecycle_check"
CHECK ("lifecycle" IS NULL OR "lifecycle" IN ('active', 'completed', 'abandoned'));

ALTER TABLE "delivery_raw_payloads"
ADD CONSTRAINT "delivery_raw_payloads_canonical_projection_version_check"
CHECK ("canonical_projection_version" IS NULL OR "canonical_projection_version" >= 1);

CREATE UNIQUE INDEX "delivery_connectors_workspace_id_id_key"
ON "delivery_connectors"("workspace_id", "id");

CREATE UNIQUE INDEX "task_external_refs_workspace_id_id_key"
ON "task_external_refs"("workspace_id", "id");

CREATE UNIQUE INDEX "task_external_refs_workspace_id_delivery_task_id_id_key"
ON "task_external_refs"("workspace_id", "delivery_task_id", "id");

CREATE INDEX "task_external_refs_workspace_id_connector_id_idx"
ON "task_external_refs"("workspace_id", "connector_id");

CREATE UNIQUE INDEX "delivery_code_changes_workspace_id_id_key"
ON "delivery_code_changes"("workspace_id", "id");

CREATE UNIQUE INDEX "delivery_actors_workspace_id_id_key"
ON "delivery_actors"("workspace_id", "id");

CREATE INDEX "delivery_raw_payloads_projection_replay_idx"
ON "delivery_raw_payloads"("workspace_id", "resource_type", "canonical_projection_version", "id");

CREATE INDEX "capture_events_received_at_id_idx"
ON "capture_events"("received_at", "id");

-- Backfill only a single exact provider ref. Zero/multiple candidates remain
-- legacy_unresolved and must be repaired before exact-authority writers enable.
WITH exact_authority AS (
  SELECT
    task."workspace_id",
    task."id" AS "delivery_task_id",
    MIN(ref."id") AS "authority_ref_id"
  FROM "delivery_tasks" task
  JOIN "task_external_refs" ref
    ON ref."workspace_id" = task."workspace_id"
   AND ref."delivery_task_id" = task."id"
   AND task."authority" = 'connector:' || ref."provider"
  WHERE task."authority" <> 'coredoc'
  GROUP BY task."workspace_id", task."id"
  HAVING COUNT(*) = 1
)
UPDATE "delivery_tasks" task
SET "authority_ref_id" = exact_authority."authority_ref_id"
FROM exact_authority
WHERE task."workspace_id" = exact_authority."workspace_id"
  AND task."id" = exact_authority."delivery_task_id";

DO $$
DECLARE
  legacy_unresolved BIGINT;
BEGIN
  SELECT COUNT(*) INTO legacy_unresolved
  FROM "delivery_tasks"
  WHERE "authority" <> 'coredoc' AND "authority_ref_id" IS NULL;
  RAISE NOTICE 'delivery_tasks legacy_unresolved=%', legacy_unresolved;
END $$;

ALTER TABLE "delivery_tasks"
ADD CONSTRAINT "delivery_tasks_authority_ref_fkey"
FOREIGN KEY ("workspace_id", "id", "authority_ref_id")
REFERENCES "task_external_refs"("workspace_id", "delivery_task_id", "id")
ON DELETE NO ACTION ON UPDATE CASCADE
DEFERRABLE INITIALLY DEFERRED;

-- Column-list SET NULL preserves required workspace_id while disconnecting the
-- ref from a deleted connector. Prisma cannot express this PostgreSQL action.
ALTER TABLE "task_external_refs"
ADD CONSTRAINT "task_external_refs_connector_workspace_fkey"
FOREIGN KEY ("workspace_id", "connector_id")
REFERENCES "delivery_connectors"("workspace_id", "id")
ON DELETE SET NULL ("connector_id") ON UPDATE CASCADE;

CREATE TABLE "task_external_ref_state_facts" (
  "id" BIGSERIAL NOT NULL,
  "workspace_id" UUID NOT NULL,
  "external_ref_id" BIGINT NOT NULL,
  "source_ref" VARCHAR(512) NOT NULL,
  "from_state" VARCHAR(128),
  "to_state" VARCHAR(128) NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "source_updated_at" TIMESTAMPTZ NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_id" UUID,

  CONSTRAINT "task_external_ref_state_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_external_ref_state_facts_source_ref_check" CHECK (length("source_ref") > 0)
);

CREATE UNIQUE INDEX "task_ref_state_source_key"
ON "task_external_ref_state_facts"("workspace_id", "external_ref_id", "source_ref");

CREATE INDEX "task_external_ref_state_facts_timeline_idx"
ON "task_external_ref_state_facts"("workspace_id", "external_ref_id", "occurred_at", "id");

CREATE INDEX "task_external_ref_state_facts_workspace_id_actor_id_idx"
ON "task_external_ref_state_facts"("workspace_id", "actor_id");

CREATE TABLE "delivery_task_code_changes" (
  "workspace_id" UUID NOT NULL,
  "delivery_task_id" VARCHAR(40) NOT NULL,
  "code_change_id" UUID NOT NULL,
  "association_source" VARCHAR(32) NOT NULL,
  "association_source_value" VARCHAR(256) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "delivery_task_code_changes_pkey"
    PRIMARY KEY ("workspace_id", "delivery_task_id", "code_change_id"),
  CONSTRAINT "delivery_task_code_changes_source_check"
    CHECK ("association_source" IN ('external_ref', 'issue_key', 'run_id')),
  CONSTRAINT "delivery_task_code_changes_source_value_check"
    CHECK (length("association_source_value") > 0)
);

CREATE INDEX "delivery_task_code_changes_workspace_id_code_change_id_idx"
ON "delivery_task_code_changes"("workspace_id", "code_change_id");

CREATE TABLE "delivery_ship_evidence" (
  "id" BIGSERIAL NOT NULL,
  "workspace_id" UUID NOT NULL,
  "delivery_task_id" VARCHAR(40) NOT NULL,
  "source" VARCHAR(32) NOT NULL,
  "source_key" VARCHAR(512) NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_id" TEXT,
  "provider" VARCHAR(64),
  "repo_external_id" VARCHAR(256),
  "external_id" VARCHAR(256),

  CONSTRAINT "delivery_ship_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_ship_evidence_source_check"
    CHECK ("source" IN ('github_pr_merged', 'connector_transition', 'coredoc')),
  CONSTRAINT "delivery_ship_evidence_source_key_check" CHECK (length("source_key") > 0),
  CONSTRAINT "delivery_ship_evidence_provider_check"
    CHECK ("provider" IS NULL OR "provider" ~ '^[a-z][a-z0-9._-]{0,63}$')
);

CREATE UNIQUE INDEX "delivery_ship_evidence_source_key"
ON "delivery_ship_evidence"("workspace_id", "source", "source_key");

CREATE INDEX "delivery_ship_evidence_task_timeline_idx"
ON "delivery_ship_evidence"("workspace_id", "delivery_task_id", "occurred_at", "id");

CREATE TABLE "delivery_rework_signals" (
  "id" BIGSERIAL NOT NULL,
  "workspace_id" UUID NOT NULL,
  "delivery_task_id" VARCHAR(40) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "source_key" VARCHAR(512) NOT NULL,
  "source_ref" VARCHAR(512) NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "observed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "delivery_rework_signals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_rework_signals_kind_check"
    CHECK ("kind" IN ('stage_reentry', 'tracker_reopened')),
  CONSTRAINT "delivery_rework_signals_source_key_check" CHECK (length("source_key") > 0),
  CONSTRAINT "delivery_rework_signals_source_ref_check" CHECK (length("source_ref") > 0)
);

CREATE UNIQUE INDEX "delivery_rework_signals_source_key"
ON "delivery_rework_signals"("workspace_id", "kind", "source_key");

CREATE INDEX "delivery_rework_signals_task_timeline_idx"
ON "delivery_rework_signals"("workspace_id", "delivery_task_id", "occurred_at", "id");

CREATE TABLE "capture_accepted_watermarks" (
  "workspace_id" UUID NOT NULL,
  "actor_id" TEXT NOT NULL,
  "host" VARCHAR(32) NOT NULL,
  "scope_key" VARCHAR(320) NOT NULL,
  "repository_key" VARCHAR(256),
  "first_accepted_at" TIMESTAMPTZ NOT NULL,
  "last_accepted_at" TIMESTAMPTZ NOT NULL,
  "workflow_last_accepted_at" TIMESTAMPTZ,

  CONSTRAINT "capture_accepted_watermarks_pkey"
    PRIMARY KEY ("workspace_id", "actor_id", "host", "scope_key"),
  CONSTRAINT "capture_accepted_watermarks_scope_check" CHECK (
    ("host" = 'claude-code' AND "repository_key" IS NOT NULL
      AND "scope_key" = 'repo:' || "repository_key")
    OR
    ("host" = 'codex' AND "repository_key" IS NULL AND "scope_key" = 'profile')
  ),
  CONSTRAINT "capture_accepted_watermarks_time_order_check"
    CHECK ("first_accepted_at" <= "last_accepted_at"),
  CONSTRAINT "capture_accepted_watermarks_workflow_time_check" CHECK (
    "workflow_last_accepted_at" IS NULL
    OR "workflow_last_accepted_at" BETWEEN "first_accepted_at" AND "last_accepted_at"
  )
);

CREATE INDEX "capture_accepted_watermarks_health_lookup_idx"
ON "capture_accepted_watermarks"("workspace_id", "actor_id", "host", "repository_key");

CREATE TABLE "capture_retention_checkpoints" (
  "id" VARCHAR(32) NOT NULL,
  "purged_through_received_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "capture_retention_checkpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_retention_checkpoints_singleton_check"
    CHECK ("id" = 'capture_fine_events')
);

ALTER TABLE "task_external_ref_state_facts"
ADD CONSTRAINT "task_external_ref_state_facts_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_external_ref_state_facts"
ADD CONSTRAINT "task_external_ref_state_facts_external_ref_fkey"
FOREIGN KEY ("workspace_id", "external_ref_id")
REFERENCES "task_external_refs"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_external_ref_state_facts"
ADD CONSTRAINT "task_external_ref_state_facts_actor_workspace_fkey"
FOREIGN KEY ("workspace_id", "actor_id")
REFERENCES "delivery_actors"("workspace_id", "id")
ON DELETE SET NULL ("actor_id") ON UPDATE CASCADE;

ALTER TABLE "delivery_task_code_changes"
ADD CONSTRAINT "delivery_task_code_changes_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_task_code_changes"
ADD CONSTRAINT "delivery_task_code_changes_task_fkey"
FOREIGN KEY ("workspace_id", "delivery_task_id")
REFERENCES "delivery_tasks"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_task_code_changes"
ADD CONSTRAINT "delivery_task_code_changes_code_change_fkey"
FOREIGN KEY ("workspace_id", "code_change_id")
REFERENCES "delivery_code_changes"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_ship_evidence"
ADD CONSTRAINT "delivery_ship_evidence_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_ship_evidence"
ADD CONSTRAINT "delivery_ship_evidence_task_fkey"
FOREIGN KEY ("workspace_id", "delivery_task_id")
REFERENCES "delivery_tasks"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_rework_signals"
ADD CONSTRAINT "delivery_rework_signals_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_rework_signals"
ADD CONSTRAINT "delivery_rework_signals_task_fkey"
FOREIGN KEY ("workspace_id", "delivery_task_id")
REFERENCES "delivery_tasks"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_accepted_watermarks"
ADD CONSTRAINT "capture_accepted_watermarks_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
