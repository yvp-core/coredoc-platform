-- The implement phase gets its own questions policy; `questions_policy` stays the scope phase's.
-- Defaulted, so a server that predates this column still inserts runs.
ALTER TABLE "agent_run_settings" ADD COLUMN "implement_questions_policy" VARCHAR(16) NOT NULL DEFAULT 'pause';
ALTER TABLE "cloud_agent_runs" ADD COLUMN "implement_questions_policy" VARCHAR(16) NOT NULL DEFAULT 'pause';

UPDATE "agent_run_settings" SET "implement_questions_policy" = "questions_policy";
UPDATE "cloud_agent_runs" SET "implement_questions_policy" = "questions_policy";
