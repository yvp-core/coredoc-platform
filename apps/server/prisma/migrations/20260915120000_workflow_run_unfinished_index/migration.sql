-- Serves the workspace activity read's unfinished-run queries: the incomplete/total counts and
-- the capped stale-run list all filter workspace_id + finished_at IS NULL and bound by created_at.
-- Additive and rollback-safe: DROP INDEX restores the previous plans, no data is touched.
-- CreateIndex
CREATE INDEX "workflow_runs_workspace_id_finished_at_created_at_idx" ON "workflow_runs"("workspace_id", "finished_at", "created_at");
