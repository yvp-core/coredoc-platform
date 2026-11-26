-- A run keeps its issue's title from creation. Runs created before stay null.
ALTER TABLE "cloud_agent_runs" ADD COLUMN "issue_title" VARCHAR(255);
