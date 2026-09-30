-- Additive and reversible: stores one closed, source-free workflow projection
-- for the initial one-routed-workflow-per-session pilot.
ALTER TABLE "agent_sessions" ADD COLUMN "workflow_summary" JSONB;

-- Rollback:
-- ALTER TABLE "agent_sessions" DROP COLUMN "workflow_summary";
