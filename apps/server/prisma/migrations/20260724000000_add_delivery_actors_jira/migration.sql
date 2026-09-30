-- L4 Phase-2 Jira connector schema (design 2026-07-20 §5.4, §5.10). Additive only.
-- Rollback:
--   ALTER TABLE "delivery_task_journeys" DROP COLUMN "ready_at";
--   ALTER TABLE "delivery_spec_revisions" DROP COLUMN "actor_id";
--   ALTER TABLE "delivery_work_item_transitions" DROP COLUMN "actor_id";
--   ALTER TABLE "delivery_work_items" DROP COLUMN "assignee_actor_id", DROP COLUMN "reporter_actor_id";
--   DROP TABLE "delivery_status_map"; DROP TABLE "delivery_actor_identities"; DROP TABLE "delivery_actors";
--   (PushJobType value 'renormalize' stays — PG enum values are not removable; harmless.)

ALTER TYPE "PushJobType" ADD VALUE 'renormalize';

CREATE TABLE "delivery_actors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "display_name" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'human',
    "member_user_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_actors_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "delivery_actors_workspace_id_member_user_id_idx"
    ON "delivery_actors"("workspace_id", "member_user_id");
ALTER TABLE "delivery_actors" ADD CONSTRAINT "delivery_actors_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "delivery_actor_identities" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_actor_identities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "delivery_actor_identities_workspace_id_actor_id_idx"
    ON "delivery_actor_identities"("workspace_id", "actor_id");
CREATE UNIQUE INDEX "delivery_actor_identities_workspace_id_provider_external_id_key"
    ON "delivery_actor_identities"("workspace_id", "provider", "external_id");
ALTER TABLE "delivery_actor_identities" ADD CONSTRAINT "delivery_actor_identities_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_actor_identities" ADD CONSTRAINT "delivery_actor_identities_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "delivery_actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "delivery_status_map" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "status_raw" TEXT NOT NULL,
    "stage" "WorkItemStage" NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'default',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_status_map_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_status_map_workspace_id_connector_id_status_raw_key"
    ON "delivery_status_map"("workspace_id", "connector_id", "status_raw");
ALTER TABLE "delivery_status_map" ADD CONSTRAINT "delivery_status_map_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_status_map" ADD CONSTRAINT "delivery_status_map_connector_id_fkey"
    FOREIGN KEY ("connector_id") REFERENCES "delivery_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_work_items" ADD COLUMN "assignee_actor_id" UUID, ADD COLUMN "reporter_actor_id" UUID;
ALTER TABLE "delivery_work_items" ADD CONSTRAINT "delivery_work_items_assignee_actor_id_fkey"
    FOREIGN KEY ("assignee_actor_id") REFERENCES "delivery_actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delivery_work_items" ADD CONSTRAINT "delivery_work_items_reporter_actor_id_fkey"
    FOREIGN KEY ("reporter_actor_id") REFERENCES "delivery_actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delivery_work_item_transitions" ADD COLUMN "actor_id" UUID;
ALTER TABLE "delivery_work_item_transitions" ADD CONSTRAINT "delivery_work_item_transitions_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "delivery_actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delivery_spec_revisions" ADD COLUMN "actor_id" UUID;
ALTER TABLE "delivery_spec_revisions" ADD CONSTRAINT "delivery_spec_revisions_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "delivery_actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delivery_task_journeys" ADD COLUMN "ready_at" TIMESTAMPTZ;
