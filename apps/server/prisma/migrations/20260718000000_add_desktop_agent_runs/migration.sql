-- ADDITIVE-ONLY migration (reversibility guard).
-- Creates the desktop_agent_runs table plus its unique index, lookup index, and
-- workspace foreign key. Touches NO existing table: there is ZERO ALTER or DROP
-- of any pre-existing table. The single ALTER below adds the FK constraint to
-- the brand-new desktop_agent_runs table, not to workspaces.
--
-- Rollback (a plain `git revert` of the schema leaves only an orphan table,
-- which is harmless; to fully undo, run):
--   DROP TABLE "desktop_agent_runs";

-- CreateTable
CREATE TABLE "desktop_agent_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "run_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "user_id" TEXT,
    "user_email" TEXT,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "tool_calls" INTEGER NOT NULL DEFAULT 0,
    "interventions" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "app_version" TEXT,
    "surface" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "desktop_agent_runs_workspace_id_run_id_key" ON "desktop_agent_runs"("workspace_id", "run_id");

-- CreateIndex
CREATE INDEX "desktop_agent_runs_workspace_id_created_at_idx" ON "desktop_agent_runs"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "desktop_agent_runs" ADD CONSTRAINT "desktop_agent_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
