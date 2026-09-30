-- L4 Phase-1b GitHub importer schema (design doc 2026-07-20 §5.7, §5.3, §7.2). Additive only.
-- Rollback:
--   DROP TABLE "delivery_raw_payloads"; DROP TABLE "delivery_code_changes";
--   DROP TYPE "CodeChangeState";
--   ALTER TABLE "delivery_connectors" DROP COLUMN "credentials_encrypted";
--   (PushJobType value 'connector_sync' stays — PG enum values are not removable; harmless.)

ALTER TYPE "PushJobType" ADD VALUE 'connector_sync';

CREATE TYPE "CodeChangeState" AS ENUM ('open', 'merged', 'closed');

ALTER TABLE "delivery_connectors" ADD COLUMN "credentials_encrypted" TEXT;

CREATE TABLE "delivery_code_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "provider" "DeliveryProvider" NOT NULL,
    "repo_external_id" TEXT NOT NULL,
    "workspace_repo_id" UUID,
    "external_id" TEXT NOT NULL,
    "number" INTEGER,
    "title" TEXT,
    "source_branch" TEXT,
    "target_branch" TEXT,
    "state" "CodeChangeState" NOT NULL,
    "is_draft" BOOLEAN NOT NULL DEFAULT false,
    "created_at_source" TIMESTAMPTZ,
    "ready_for_review_at" TIMESTAMPTZ,
    "first_review_at" TIMESTAMPTZ,
    "approved_at" TIMESTAMPTZ,
    "merged_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "commits_count" INTEGER,
    "additions" INTEGER,
    "deletions" INTEGER,
    "changed_files" INTEGER,
    "changed_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "review_rounds" INTEGER NOT NULL DEFAULT 0,
    "review_comments" INTEGER NOT NULL DEFAULT 0,
    "ai_assisted" BOOLEAN,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "delivery_code_changes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_code_changes_workspace_id_provider_repo_external_i_key"
    ON "delivery_code_changes"("workspace_id", "provider", "repo_external_id", "external_id");
CREATE INDEX "delivery_code_changes_workspace_id_source_branch_idx"
    ON "delivery_code_changes"("workspace_id", "source_branch");
CREATE INDEX "delivery_code_changes_workspace_id_merged_at_idx"
    ON "delivery_code_changes"("workspace_id", "merged_at");
ALTER TABLE "delivery_code_changes" ADD CONSTRAINT "delivery_code_changes_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_code_changes" ADD CONSTRAINT "delivery_code_changes_connector_id_fkey"
    FOREIGN KEY ("connector_id") REFERENCES "delivery_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "delivery_raw_payloads" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "external_id" TEXT,
    "payload" JSONB NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "norm_version" INTEGER,
    CONSTRAINT "delivery_raw_payloads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "delivery_raw_payloads_workspace_id_connector_id_resource_ty_idx"
    ON "delivery_raw_payloads"("workspace_id", "connector_id", "resource_type", "fetched_at");
ALTER TABLE "delivery_raw_payloads" ADD CONSTRAINT "delivery_raw_payloads_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_raw_payloads" ADD CONSTRAINT "delivery_raw_payloads_connector_id_fkey"
    FOREIGN KEY ("connector_id") REFERENCES "delivery_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
