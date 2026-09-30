-- CreateTable
CREATE TABLE "push_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "repo_key" TEXT NOT NULL,
    "repo_name" TEXT NOT NULL,
    "commit_hash" TEXT,
    "pushed_by_user_id" TEXT,
    "push_mode" TEXT NOT NULL,
    "pushed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "push_duration_ms" INTEGER,
    "diff_skipped_pct" DOUBLE PRECISION,
    "total_nodes" INTEGER NOT NULL,
    "total_edges" INTEGER NOT NULL,
    "nodes_by_type" JSONB NOT NULL,
    "edges_by_type" JSONB NOT NULL,
    "entrypoint_count" INTEGER NOT NULL DEFAULT 0,
    "entity_count" INTEGER NOT NULL DEFAULT 0,
    "external_call_count" INTEGER NOT NULL DEFAULT 0,
    "component_count" INTEGER NOT NULL DEFAULT 0,
    "nodes_added" INTEGER,
    "nodes_updated" INTEGER,
    "nodes_deleted" INTEGER,
    "nodes_with_summaries" INTEGER NOT NULL DEFAULT 0,
    "nodes_with_embeddings" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "push_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_metrics_workspace_id_repo_key_idx" ON "push_metrics"("workspace_id", "repo_key");

-- CreateIndex
CREATE INDEX "push_metrics_workspace_id_pushed_at_idx" ON "push_metrics"("workspace_id", "pushed_at");

-- CreateIndex
CREATE INDEX "push_metrics_repo_key_pushed_at_idx" ON "push_metrics"("repo_key", "pushed_at");

-- AddForeignKey
ALTER TABLE "push_metrics" ADD CONSTRAINT "push_metrics_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
