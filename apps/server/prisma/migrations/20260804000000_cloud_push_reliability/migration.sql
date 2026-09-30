-- Release B: durable attempts, renewable leases, progress and idempotent metrics.
ALTER TABLE "push_metrics" ADD COLUMN "execution_token" UUID;
CREATE UNIQUE INDEX "push_metrics_execution_token_key" ON "push_metrics"("execution_token");

CREATE TYPE "PushJobAttemptStatus" AS ENUM (
  'running',
  'succeeded',
  'retry_scheduled',
  'failed',
  'lease_lost',
  'interrupted'
);

ALTER TABLE "push_jobs"
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "heartbeat_at" TIMESTAMPTZ,
  ADD COLUMN "phase" TEXT,
  ADD COLUMN "progress" JSONB;

CREATE TABLE "push_job_attempts" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "lease_token" UUID NOT NULL,
  "status" "PushJobAttemptStatus" NOT NULL DEFAULT 'running',
  "phase" TEXT,
  "progress" JSONB,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ,
  "last_error" TEXT,
  "phase_timings" JSONB,
  CONSTRAINT "push_job_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "push_job_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "push_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "push_job_attempts_job_id_attempt_number_key"
  ON "push_job_attempts"("job_id", "attempt_number");
CREATE UNIQUE INDEX "push_job_attempts_lease_token_key"
  ON "push_job_attempts"("lease_token");
CREATE INDEX "push_job_attempts_job_id_started_at_idx"
  ON "push_job_attempts"("job_id", "started_at");

CREATE TABLE "repo_push_leases" (
  "workspace_id" UUID NOT NULL,
  "repo_name" TEXT NOT NULL,
  "owner_token" UUID NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 1,
  "heartbeat_at" TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "repo_push_leases_pkey" PRIMARY KEY ("workspace_id", "repo_name"),
  CONSTRAINT "repo_push_leases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "repo_push_leases_expires_at_idx" ON "repo_push_leases"("expires_at");

CREATE TABLE "workspace_graph_write_leases" (
  "workspace_id" UUID NOT NULL,
  "owner_token" UUID NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 1,
  "heartbeat_at" TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "workspace_graph_write_leases_pkey" PRIMARY KEY ("workspace_id"),
  CONSTRAINT "workspace_graph_write_leases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "workspace_graph_write_leases_expires_at_idx"
  ON "workspace_graph_write_leases"("expires_at");

-- Jobs claimed by pre-lease code carry lease_token NULL and would be invisible
-- to heartbeat-based stale recovery (NULL never equals NULL); requeue them now
-- so nothing stays 'running' forever across the deploy boundary.
UPDATE "push_jobs"
SET "status" = 'pending', "next_run_at" = NOW(), "started_at" = NULL
WHERE "status" = 'running' AND "lease_token" IS NULL;

-- Self-healing dedup: the partial unique index below aborts the whole
-- transactional migration if duplicate active push rows exist (reachable via
-- the pre-index enqueue findFirst/create race). Keep the newest per
-- (workspace, repo), fail the rest deterministically.
UPDATE "push_jobs"
SET "status" = 'failed',
    "finished_at" = NOW(),
    "last_error" = 'superseded: duplicate active push resolved by 20260804000000 migration'
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           row_number() OVER (
             PARTITION BY "workspace_id", "repo_name"
             ORDER BY "queued_at" DESC, "id" DESC
           ) AS rn
    FROM "push_jobs"
    WHERE "type" = 'push' AND "status" IN ('pending', 'running') AND "repo_name" IS NOT NULL
  ) ranked
  WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX "push_jobs_one_active_push_per_repo"
  ON "push_jobs"("workspace_id", "repo_name")
  WHERE "type" = 'push' AND "status" IN ('pending', 'running');
