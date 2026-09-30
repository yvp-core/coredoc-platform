-- Add R2 versioned storage tracking columns to workspace_repos
ALTER TABLE "workspace_repos" ADD COLUMN "last_parsed_version" TEXT;
ALTER TABLE "workspace_repos" ADD COLUMN "last_summary_version" TEXT;
ALTER TABLE "workspace_repos" ADD COLUMN "last_embed_version" TEXT;
