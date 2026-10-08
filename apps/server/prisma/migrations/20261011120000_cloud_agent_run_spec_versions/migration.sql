-- SF-001 scope phase: spec versions (scope proposals and their reviews) and the
-- state archive a turn uploaded, which the run adopts when the turn completes.
-- Additive only; rollback = drop cloud_agent_run_spec_versions and the
-- cloud_agent_run_turns.state_archive_key column.

-- AlterTable
ALTER TABLE "cloud_agent_run_turns" ADD COLUMN     "state_archive_key" VARCHAR(1024);

-- CreateTable
CREATE TABLE "cloud_agent_run_spec_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "turn_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "summary" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "proposed_at" TIMESTAMPTZ NOT NULL,
    "reviewed_by" VARCHAR(256),
    "reviewed_at" TIMESTAMPTZ,
    "review_text" TEXT,
    "auto_accepted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "cloud_agent_run_spec_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cloud_agent_run_spec_versions_run_id_version_key" ON "cloud_agent_run_spec_versions"("run_id", "version");

-- AddForeignKey
ALTER TABLE "cloud_agent_run_spec_versions" ADD CONSTRAINT "cloud_agent_run_spec_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_agent_run_spec_versions" ADD CONSTRAINT "cloud_agent_run_spec_versions_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "cloud_agent_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
