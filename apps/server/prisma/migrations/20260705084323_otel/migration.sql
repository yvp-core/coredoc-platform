-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "user_email" TEXT,
    "model" TEXT,
    "app_version" TEXT,
    "tokens_input" INTEGER NOT NULL DEFAULT 0,
    "tokens_output" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_read" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_creation" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active_time_sec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commit_count" INTEGER NOT NULL DEFAULT 0,
    "pr_count" INTEGER NOT NULL DEFAULT 0,
    "coredoc_tool_calls" INTEGER NOT NULL DEFAULT 0,
    "coredoc_tools" JSONB NOT NULL DEFAULT '{}',
    "loc_added" INTEGER NOT NULL DEFAULT 0,
    "loc_removed" INTEGER NOT NULL DEFAULT 0,
    "coredoc_tool_stats" JSONB NOT NULL DEFAULT '{}',
    "repo_key" TEXT,
    "branch" TEXT,
    "pr_number" INTEGER,
    "issue_key" TEXT,
    "spec_id" TEXT,
    "edit_verify_rounds" INTEGER,
    "outcome" TEXT,
    "last_event_nanos" BIGINT NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "session_id" TEXT,
    "user_id" TEXT,
    "user_email" TEXT,
    "repo_key" TEXT,
    "overall_rating" INTEGER,
    "per_tool_issues" JSONB NOT NULL DEFAULT '[]',
    "missing_capabilities" JSONB NOT NULL DEFAULT '[]',
    "misleading_metadata" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_sessions_workspace_id_started_at_idx" ON "agent_sessions"("workspace_id", "started_at");

-- CreateIndex
CREATE INDEX "agent_sessions_workspace_id_issue_key_idx" ON "agent_sessions"("workspace_id", "issue_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_sessions_workspace_id_session_id_key" ON "agent_sessions"("workspace_id", "session_id");

-- CreateIndex
CREATE INDEX "mcp_feedback_workspace_id_created_at_idx" ON "mcp_feedback"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_feedback_workspace_id_session_id_idx" ON "mcp_feedback"("workspace_id", "session_id");

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_feedback" ADD CONSTRAINT "mcp_feedback_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
