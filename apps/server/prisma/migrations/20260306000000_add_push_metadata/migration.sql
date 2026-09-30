-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "is_cloud" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "workspace_repos" ADD COLUMN "last_parse_hash" TEXT,
ADD COLUMN "last_pushed_at" TIMESTAMPTZ,
ADD COLUMN "last_pushed_by_user_id" TEXT,
ADD COLUMN "node_count" INTEGER,
ADD COLUMN "edge_count" INTEGER;
