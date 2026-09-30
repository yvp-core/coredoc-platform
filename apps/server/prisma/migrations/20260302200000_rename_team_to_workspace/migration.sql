-- Rename tables
ALTER TABLE "teams" RENAME TO "workspaces";
ALTER TABLE "team_members" RENAME TO "workspace_members";
ALTER TABLE "team_repos" RENAME TO "workspace_repos";

-- Rename columns
ALTER TABLE "workspace_members" RENAME COLUMN "team_id" TO "workspace_id";
ALTER TABLE "workspace_repos" RENAME COLUMN "team_id" TO "workspace_id";
ALTER TABLE "service_tokens" RENAME COLUMN "team_id" TO "workspace_id";
