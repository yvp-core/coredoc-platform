-- CreateEnum
CREATE TYPE "PushJobType" AS ENUM ('push', 'resolve');

-- CreateEnum
CREATE TYPE "PushJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "push_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "repo_name" TEXT,
    "type" "PushJobType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PushJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "last_error" TEXT,
    "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_run_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "result" JSONB,
    "queued_by_user_id" TEXT,

    CONSTRAINT "push_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_jobs_status_next_run_at_idx" ON "push_jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "push_jobs_workspace_id_queued_at_idx" ON "push_jobs"("workspace_id", "queued_at" DESC);

-- AddForeignKey
ALTER TABLE "push_jobs" ADD CONSTRAINT "push_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
