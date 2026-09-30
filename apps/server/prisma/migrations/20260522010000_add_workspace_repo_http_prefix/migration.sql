-- Add httpPrefix for cloud-side cross-repo resolution parity with local CLI.
-- Nullable, no backfill: repos without a prefix continue resolving by raw path.
ALTER TABLE "workspace_repos" ADD COLUMN "http_prefix" TEXT;
