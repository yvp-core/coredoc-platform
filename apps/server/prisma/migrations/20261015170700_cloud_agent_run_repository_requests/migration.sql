-- Cloud agent runs, request_repo: a repository the agent asks for under required
-- acceptance is stored on its turn and becomes a repository-request question
-- when the turn completes; the question names the repository it decides.
-- Additive only; rollback = drop the two columns.

-- AlterTable
ALTER TABLE "cloud_agent_run_turns" ADD COLUMN "repository_request" JSONB;

-- AlterTable
ALTER TABLE "cloud_agent_run_questions" ADD COLUMN "repository_key" VARCHAR(255);
