-- L4 Phase-1c delivery links, rework episodes, task journey schema (design doc 2026-07-20 §5.4, §5.5, §5.6). Additive only.
-- Rollback:
--   DROP TABLE "delivery_task_journeys"; DROP TABLE "delivery_rework_episodes"; DROP TABLE "delivery_links";
--   DROP TYPE "LinkMethod"; DROP TYPE "LinkRel";
--   ALTER TABLE "delivery_code_changes" DROP COLUMN "last_commit_at";

-- CreateEnum
CREATE TYPE "LinkRel" AS ENUM ('implements', 'fixes', 'mentions', 'session_of', 'spec_of', 'parent_of');

-- CreateEnum
CREATE TYPE "LinkMethod" AS ENUM ('trailer', 'dev_panel', 'branch_name', 'pr_title', 'pr_body', 'session_context', 'specflow_frontmatter', 'temporal', 'manual');

-- AlterTable
ALTER TABLE "delivery_code_changes" ADD COLUMN     "last_commit_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "delivery_links" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "src_type" TEXT NOT NULL,
    "src_id" TEXT NOT NULL,
    "dst_type" TEXT NOT NULL,
    "dst_id" TEXT NOT NULL,
    "rel" "LinkRel" NOT NULL,
    "method" "LinkMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMPTZ,

    CONSTRAINT "delivery_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_rework_episodes" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "work_item_id" UUID,
    "code_change_id" UUID,
    "kind" TEXT NOT NULL,
    "detector_version" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "magnitude" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "root_cause_label" TEXT,
    "root_cause_confidence" DOUBLE PRECISION,
    "root_cause_evidence" JSONB,
    "rationale" TEXT,
    "classifier_version" TEXT,
    "classified_at" TIMESTAMPTZ,
    "human_label" TEXT,
    "human_labeled_by" TEXT,
    "human_labeled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_rework_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_task_journeys" (
    "workspace_id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "first_session_at" TIMESTAMPTZ,
    "first_pr_at" TIMESTAMPTZ,
    "review_started_at" TIMESTAMPTZ,
    "approved_at" TIMESTAMPTZ,
    "merged_at" TIMESTAMPTZ,
    "done_at" TIMESTAMPTZ,
    "stage_seconds" JSONB NOT NULL DEFAULT '{}',
    "sessions_count" INTEGER NOT NULL DEFAULT 0,
    "session_seconds" BIGINT NOT NULL DEFAULT 0,
    "agent_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prs_count" INTEGER NOT NULL DEFAULT 0,
    "review_rounds_total" INTEGER NOT NULL DEFAULT 0,
    "rework_count" INTEGER NOT NULL DEFAULT 0,
    "rework_kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "spec_revs_after_start" INTEGER NOT NULL DEFAULT 0,
    "link_coverage" DOUBLE PRECISION,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_task_journeys_pkey" PRIMARY KEY ("workspace_id","work_item_id")
);

-- CreateIndex
CREATE INDEX "delivery_links_workspace_id_dst_type_dst_id_idx" ON "delivery_links"("workspace_id", "dst_type", "dst_id");

-- CreateIndex
CREATE INDEX "delivery_links_workspace_id_src_type_src_id_idx" ON "delivery_links"("workspace_id", "src_type", "src_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_links_workspace_id_src_type_src_id_dst_type_dst_id_key" ON "delivery_links"("workspace_id", "src_type", "src_id", "dst_type", "dst_id", "rel", "method");

-- CreateIndex
CREATE INDEX "delivery_rework_episodes_workspace_id_work_item_id_idx" ON "delivery_rework_episodes"("workspace_id", "work_item_id");

-- CreateIndex
CREATE INDEX "delivery_rework_episodes_workspace_id_code_change_id_idx" ON "delivery_rework_episodes"("workspace_id", "code_change_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_rework_episodes_workspace_id_kind_dedupe_key_key" ON "delivery_rework_episodes"("workspace_id", "kind", "dedupe_key");

-- AddForeignKey
ALTER TABLE "delivery_links" ADD CONSTRAINT "delivery_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_rework_episodes" ADD CONSTRAINT "delivery_rework_episodes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_task_journeys" ADD CONSTRAINT "delivery_task_journeys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_task_journeys" ADD CONSTRAINT "delivery_task_journeys_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "delivery_work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
