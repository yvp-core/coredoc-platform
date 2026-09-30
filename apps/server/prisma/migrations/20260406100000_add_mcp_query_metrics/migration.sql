-- CreateTable
CREATE TABLE "mcp_query_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "user_id" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "queried_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_query_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_query_metrics_workspace_id_queried_at_idx" ON "mcp_query_metrics"("workspace_id", "queried_at");

-- CreateIndex
CREATE INDEX "mcp_query_metrics_workspace_id_tool_name_idx" ON "mcp_query_metrics"("workspace_id", "tool_name");

-- AddForeignKey
ALTER TABLE "mcp_query_metrics" ADD CONSTRAINT "mcp_query_metrics_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
