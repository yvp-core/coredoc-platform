-- A run belongs to one workflow of the runner manifest and keeps that workflow's shape. Existing
-- runs are runs of the `default` workflow: scope (accepted by a person), implement, pull requests.
ALTER TABLE "cloud_agent_runs" ADD COLUMN "workflow" VARCHAR(32) NOT NULL DEFAULT 'default';
ALTER TABLE "cloud_agent_runs" ADD COLUMN "workflow_shape" JSONB;
ALTER TABLE "cloud_agent_runs" ADD COLUMN "session_ids" JSONB;

UPDATE "cloud_agent_runs"
SET "workflow_shape" = '{"id":"default","title":"Story to pull request","repositories":"write","delivery":"pull-request","phases":[{"id":"scope","gate":"acceptance"},{"id":"implement","gate":"none"}]}'::jsonb,
    "session_ids" = jsonb_build_object('scope', "scope_session_id"::text, 'implement', "implement_session_id"::text);

ALTER TABLE "cloud_agent_runs" ALTER COLUMN "workflow_shape" SET NOT NULL;
ALTER TABLE "cloud_agent_runs" ALTER COLUMN "session_ids" SET NOT NULL;
ALTER TABLE "cloud_agent_runs" DROP COLUMN "scope_session_id";
ALTER TABLE "cloud_agent_runs" DROP COLUMN "implement_session_id";

-- One status for every agent phase; `phase` says which.
UPDATE "cloud_agent_runs" SET "status" = 'running' WHERE "status" IN ('scoping', 'implementing');

ALTER TABLE "cloud_agent_run_spec_versions" ADD COLUMN "phase" VARCHAR(16) NOT NULL DEFAULT 'scope';

ALTER TABLE "agent_run_settings" ADD COLUMN "workflow_access" JSONB NOT NULL DEFAULT '{}';
