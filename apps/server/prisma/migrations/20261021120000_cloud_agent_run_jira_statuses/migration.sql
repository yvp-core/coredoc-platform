-- Four optional Jira statuses a run moves its issue to, matched by name.
ALTER TABLE "agent_run_settings"
    ADD COLUMN "started_status" VARCHAR(255),
    ADD COLUMN "done_status" VARCHAR(255),
    ADD COLUMN "failed_status" VARCHAR(255),
    ADD COLUMN "cancelled_status" VARCHAR(255);

-- The configured done status carries over. One saved without a name keeps its
-- id, so the setting stays visible (and warns on the run) instead of vanishing.
UPDATE "agent_run_settings"
SET "done_status" = COALESCE("done_status_name", "done_status_id")
WHERE "done_status_id" IS NOT NULL OR "done_status_name" IS NOT NULL;

ALTER TABLE "agent_run_settings"
    DROP COLUMN "done_status_id",
    DROP COLUMN "done_status_name";
