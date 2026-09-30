-- SF-20260728-archive-learns-the-successor-runs, step 2: the run-record table, the
-- observation channel on every episode, and the run id on the usage spine.
--
-- ADDITIVE ONLY, so a plain revert drops what it added and restores nothing:
-- one new table, one new NULLABLE column on agent_sessions, and one NOT NULL
-- column on delivery_rework_episodes whose default is true of every existing
-- row (every episode that exists was derived from a connector).
--
-- Rollback:
--   ALTER TABLE "delivery_rework_episodes" DROP COLUMN "channel";
--   ALTER TABLE "agent_sessions" DROP COLUMN "run_id";
--   DROP TABLE "delivery_flow_run_records";
--   DROP TYPE "FlowRecordSource";
--   DROP TYPE "ObservationChannel";
-- What the revert does NOT undo: runs already ingested, which are data and are
-- removed by deleting the rows; and a normalization version already stamped
-- forward, which the next renormalize re-stamps.

-- CreateEnum
CREATE TYPE "ObservationChannel" AS ENUM ('loop', 'connector');

-- CreateEnum
CREATE TYPE "FlowRecordSource" AS ENUM ('commit', 'telemetry');

-- AlterTable
ALTER TABLE "agent_sessions" ADD COLUMN     "run_id" TEXT;

-- AlterTable
ALTER TABLE "delivery_rework_episodes" ADD COLUMN     "channel" "ObservationChannel" NOT NULL DEFAULT 'connector';

-- CreateTable
CREATE TABLE "delivery_flow_run_records" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" "FlowRecordSource" NOT NULL,
    "record_key" TEXT NOT NULL,
    "claimed_at" TIMESTAMPTZ,
    "observed_at" TIMESTAMPTZ NOT NULL,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "superseded_at" TIMESTAMPTZ,
    "code_change_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_flow_run_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_flow_run_records_workspace_id_run_id_idx" ON "delivery_flow_run_records"("workspace_id", "run_id");

-- CreateIndex
CREATE INDEX "delivery_flow_run_records_workspace_id_code_change_id_idx" ON "delivery_flow_run_records"("workspace_id", "code_change_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_flow_run_records_workspace_id_run_id_source_record_key" ON "delivery_flow_run_records"("workspace_id", "run_id", "source", "record_key");

-- AddForeignKey
ALTER TABLE "delivery_flow_run_records" ADD CONSTRAINT "delivery_flow_run_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
