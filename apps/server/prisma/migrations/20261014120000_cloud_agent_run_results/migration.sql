-- Cloud agent runs, implement phase: the agent's submit_result, stored on its turn while
-- the turn runs and adopted by the run when the turn completes.
-- Additive only; rollback = drop the two columns.

-- AlterTable
ALTER TABLE "cloud_agent_run_turns" ADD COLUMN "result" JSONB;

-- AlterTable
ALTER TABLE "cloud_agent_runs" ADD COLUMN "result" JSONB;
