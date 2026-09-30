-- Phase A is additive: legacy Delivery tables and columns remain untouched.
ALTER TABLE "agent_sessions"
ADD COLUMN "provider" VARCHAR(32) NOT NULL DEFAULT 'claude-code';

CREATE UNIQUE INDEX "agent_sessions_workspace_id_provider_session_id_key"
ON "agent_sessions"("workspace_id", "provider", "session_id");

CREATE TABLE "capture_events" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "host" VARCHAR(32) NOT NULL,
    "session_id" VARCHAR(128) NOT NULL,
    "run_id" VARCHAR(32),
    "repository_key" VARCHAR(256),
    "task_id" VARCHAR(128),
    "data" JSONB NOT NULL,
    "actor_id" TEXT NOT NULL,

    CONSTRAINT "capture_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "run_id" VARCHAR(32) NOT NULL,
    "agent_session_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "workflow_id" VARCHAR(76),
    "intent" VARCHAR(32),
    "risk" VARCHAR(16),
    "scale" VARCHAR(16),
    "repository_key" VARCHAR(256),
    "task_id" VARCHAR(128),
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "outcome" VARCHAR(16),
    "counters" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "capture_events_workspace_id_event_id_key"
ON "capture_events"("workspace_id", "event_id");

CREATE UNIQUE INDEX "workflow_runs_workspace_id_run_id_key"
ON "workflow_runs"("workspace_id", "run_id");

CREATE INDEX "workflow_runs_agent_session_id_idx"
ON "workflow_runs"("agent_session_id");

ALTER TABLE "capture_events"
ADD CONSTRAINT "capture_events_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_runs"
ADD CONSTRAINT "workflow_runs_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_runs"
ADD CONSTRAINT "workflow_runs_agent_session_id_fkey"
FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
