-- Cloud agent runs: runs, turns, timeline events, per-workspace settings,
-- runner last-seen rows, and the per-turn MCP token's owning-turn column.
-- Additive only; rollback = drop the cloud_agent_run* / agent_run* / agent_runner_seen
-- tables and the service_tokens.owning_turn_id column.

-- AlterTable
ALTER TABLE "service_tokens" ADD COLUMN     "owning_turn_id" UUID;

-- CreateTable
CREATE TABLE "cloud_agent_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "jira_issue_id" VARCHAR(64) NOT NULL,
    "issue_key" VARCHAR(64) NOT NULL,
    "jira_connector_id" UUID,
    "trigger" VARCHAR(16) NOT NULL,
    "started_by" VARCHAR(256),
    "previous_run_id" UUID,
    "run_owner_id" VARCHAR(256) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "phase" VARCHAR(16) NOT NULL,
    "failure_code" VARCHAR(64),
    "failure_reason" VARCHAR(2000),
    "questions_policy" VARCHAR(16) NOT NULL,
    "scope_acceptance_policy" VARCHAR(16) NOT NULL,
    "model" VARCHAR(128),
    "repositories" JSONB NOT NULL DEFAULT '[]',
    "seeds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dropped_seeds" JSONB NOT NULL DEFAULT '[]',
    "run_ordinal" INTEGER NOT NULL,
    "branch" VARCHAR(255) NOT NULL,
    "scope_session_id" UUID NOT NULL,
    "implement_session_id" UUID NOT NULL,
    "state_archive_key" VARCHAR(1024),
    "spend_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "agent_turns" INTEGER NOT NULL DEFAULT 0,
    "unknown_spend_turns" INTEGER NOT NULL DEFAULT 0,
    "max_spend_usd" DOUBLE PRECISION NOT NULL,
    "max_active_seconds" INTEGER NOT NULL,
    "waiting_limit_seconds" INTEGER NOT NULL,
    "max_turn_duration_seconds" INTEGER NOT NULL,
    "max_repositories" INTEGER NOT NULL,
    "active_seconds" INTEGER NOT NULL DEFAULT 0,
    "active_since" TIMESTAMPTZ,
    "waiting_since" TIMESTAMPTZ,
    "pull_requests" JSONB NOT NULL DEFAULT '[]',
    "jira_outcome" JSONB NOT NULL DEFAULT '{}',
    "assumptions" JSONB NOT NULL DEFAULT '[]',
    "outcome_less_count" INTEGER NOT NULL DEFAULT 0,
    "last_event_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "last_turn_ended_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cloud_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_agent_run_turns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "input_text" TEXT,
    "state" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ,
    "claimed_by_token_id" UUID,
    "claimed_at" TIMESTAMPTZ,
    "outcome" VARCHAR(32),
    "spend_usd" DOUBLE PRECISION,
    "runner_versions" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "cloud_agent_run_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_agent_run_events" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "turn_id" UUID,
    "seq" INTEGER NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cloud_agent_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_settings" (
    "workspace_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "run_owner_id" VARCHAR(256),
    "trigger_label" VARCHAR(255) NOT NULL DEFAULT 'coredoc-agent',
    "done_status_id" VARCHAR(64),
    "done_status_name" VARCHAR(255),
    "questions_policy" VARCHAR(16) NOT NULL DEFAULT 'pause',
    "scope_acceptance_policy" VARCHAR(16) NOT NULL DEFAULT 'required',
    "max_spend_usd" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "max_turn_duration_seconds" INTEGER NOT NULL DEFAULT 10800,
    "max_active_seconds" INTEGER NOT NULL DEFAULT 86400,
    "waiting_limit_seconds" INTEGER NOT NULL DEFAULT 604800,
    "max_started_runs" INTEGER NOT NULL DEFAULT 2,
    "max_repositories" INTEGER NOT NULL DEFAULT 5,
    "model" VARCHAR(128),
    "updated_by" VARCHAR(256),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_run_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "agent_runner_seen" (
    "service_token_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "last_action" VARCHAR(16) NOT NULL,
    "protocol_version" INTEGER NOT NULL,
    "versions" JSONB NOT NULL,
    "refused_reason" VARCHAR(200),

    CONSTRAINT "agent_runner_seen_pkey" PRIMARY KEY ("service_token_id")
);

-- CreateIndex
CREATE INDEX "cloud_agent_runs_workspace_id_created_at_idx" ON "cloud_agent_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "cloud_agent_runs_workspace_id_jira_issue_id_idx" ON "cloud_agent_runs"("workspace_id", "jira_issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_agent_runs_workspace_id_id_key" ON "cloud_agent_runs"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "cloud_agent_run_turns_workspace_id_state_created_at_idx" ON "cloud_agent_run_turns"("workspace_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_agent_run_turns_workspace_id_id_key" ON "cloud_agent_run_turns"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_agent_run_turns_run_id_ordinal_key" ON "cloud_agent_run_turns"("run_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_agent_run_events_run_id_seq_key" ON "cloud_agent_run_events"("run_id", "seq");

-- CreateIndex
CREATE INDEX "agent_runner_seen_workspace_id_idx" ON "agent_runner_seen"("workspace_id");

-- CreateIndex
CREATE INDEX "service_tokens_owning_turn_id_idx" ON "service_tokens"("owning_turn_id");

-- AddForeignKey
ALTER TABLE "service_tokens" ADD CONSTRAINT "service_tokens_workspace_id_owning_turn_id_fkey" FOREIGN KEY ("workspace_id", "owning_turn_id") REFERENCES "cloud_agent_run_turns"("workspace_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_workspace_id_previous_run_id_fkey" FOREIGN KEY ("workspace_id", "previous_run_id") REFERENCES "cloud_agent_runs"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_agent_run_turns" ADD CONSTRAINT "cloud_agent_run_turns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_agent_run_turns" ADD CONSTRAINT "cloud_agent_run_turns_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "cloud_agent_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_agent_run_turns" ADD CONSTRAINT "cloud_agent_run_turns_claimed_by_token_id_fkey" FOREIGN KEY ("claimed_by_token_id") REFERENCES "service_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_agent_run_events" ADD CONSTRAINT "cloud_agent_run_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_agent_run_events" ADD CONSTRAINT "cloud_agent_run_events_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "cloud_agent_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_settings" ADD CONSTRAINT "agent_run_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runner_seen" ADD CONSTRAINT "agent_runner_seen_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runner_seen" ADD CONSTRAINT "agent_runner_seen_service_token_id_fkey" FOREIGN KEY ("service_token_id") REFERENCES "service_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written partial unique indexes (not representable in schema.prisma; guarded
-- by migration-invariants.test.ts). New tables, so no dedupe step is needed.
-- At most one non-terminal run per workspace and Jira issue id (ACTIVE_RUN_EXISTS).
CREATE UNIQUE INDEX "cloud_agent_runs_one_open_run_per_issue"
  ON "cloud_agent_runs"("workspace_id", "jira_issue_id")
  WHERE "status" NOT IN ('done', 'failed', 'cancelled');

-- At most one queued or claimed turn per run.
CREATE UNIQUE INDEX "cloud_agent_run_turns_one_pending_turn_per_run"
  ON "cloud_agent_run_turns"("run_id")
  WHERE "state" IN ('queued', 'claimed');
