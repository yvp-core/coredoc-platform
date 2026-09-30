-- L4 Phase-1a delivery canonical slice (design doc 2026-07-20 §5). Additive only.
-- Rollback:
--   DROP TABLE "delivery_spec_revisions";
--   DROP TABLE "delivery_work_item_transitions";
--   DROP TABLE "delivery_work_items";
--   DROP TABLE "delivery_connectors";
--   DROP TYPE "WorkItemStage"; DROP TYPE "DeliveryProvider";

CREATE TYPE "DeliveryProvider" AS ENUM ('jira', 'github', 'gitlab', 'coredoc');
CREATE TYPE "WorkItemStage" AS ENUM ('backlog', 'ready', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled');

CREATE TABLE "delivery_connectors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "provider" "DeliveryProvider" NOT NULL,
    "provider_variant" TEXT,
    "display_name" TEXT NOT NULL,
    "base_url" TEXT,
    "auth_kind" TEXT NOT NULL DEFAULT 'none',
    "config" JSONB NOT NULL DEFAULT '{}',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "cursors" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_sync_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_connectors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_connectors_workspace_id_provider_provider_variant_key"
    ON "delivery_connectors"("workspace_id", "provider", "provider_variant");
ALTER TABLE "delivery_connectors" ADD CONSTRAINT "delivery_connectors_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "delivery_work_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "provider" "DeliveryProvider" NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_key" TEXT,
    "external_url" TEXT,
    "item_type" TEXT,
    "title" TEXT,
    "current_stage" "WorkItemStage" NOT NULL DEFAULT 'backlog',
    "current_status_raw" TEXT,
    "parent_id" UUID,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at_source" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "delivery_work_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_work_items_workspace_id_provider_external_id_key"
    ON "delivery_work_items"("workspace_id", "provider", "external_id");
CREATE INDEX "delivery_work_items_workspace_id_current_stage_idx"
    ON "delivery_work_items"("workspace_id", "current_stage");
CREATE INDEX "delivery_work_items_workspace_id_external_key_idx"
    ON "delivery_work_items"("workspace_id", "external_key");
ALTER TABLE "delivery_work_items" ADD CONSTRAINT "delivery_work_items_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_work_items" ADD CONSTRAINT "delivery_work_items_connector_id_fkey"
    FOREIGN KEY ("connector_id") REFERENCES "delivery_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_work_items" ADD CONSTRAINT "delivery_work_items_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "delivery_work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "delivery_work_item_transitions" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "from_status_raw" TEXT,
    "to_status_raw" TEXT,
    "from_stage" "WorkItemStage",
    "to_stage" "WorkItemStage",
    "actor_email" TEXT,
    "source_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_work_item_transitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_work_item_transitions_workspace_id_work_item_id_so_key"
    ON "delivery_work_item_transitions"("workspace_id", "work_item_id", "source_ref");
CREATE INDEX "delivery_work_item_transitions_workspace_id_work_item_id_oc_idx"
    ON "delivery_work_item_transitions"("workspace_id", "work_item_id", "occurred_at");
ALTER TABLE "delivery_work_item_transitions" ADD CONSTRAINT "delivery_work_item_transitions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_work_item_transitions" ADD CONSTRAINT "delivery_work_item_transitions_work_item_id_fkey"
    FOREIGN KEY ("work_item_id") REFERENCES "delivery_work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "delivery_spec_revisions" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "field" TEXT NOT NULL DEFAULT 'spec_file',
    "change_kind" TEXT NOT NULL,
    "actor_email" TEXT,
    "chars_before" INTEGER,
    "chars_after" INTEGER,
    "diff_summary" TEXT,
    "after_work_started" BOOLEAN,
    "source_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_spec_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_spec_revisions_workspace_id_work_item_id_source_re_key"
    ON "delivery_spec_revisions"("workspace_id", "work_item_id", "source_ref", "field");
CREATE INDEX "delivery_spec_revisions_workspace_id_work_item_id_occurred__idx"
    ON "delivery_spec_revisions"("workspace_id", "work_item_id", "occurred_at");
ALTER TABLE "delivery_spec_revisions" ADD CONSTRAINT "delivery_spec_revisions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_spec_revisions" ADD CONSTRAINT "delivery_spec_revisions_work_item_id_fkey"
    FOREIGN KEY ("work_item_id") REFERENCES "delivery_work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
