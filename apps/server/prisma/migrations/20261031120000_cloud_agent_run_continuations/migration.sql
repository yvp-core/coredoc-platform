ALTER TABLE "cloud_agent_runs" ADD COLUMN "continuations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "cloud_agent_runs" ADD COLUMN "queued_at" TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE "cloud_agent_runs" SET "queued_at" = "created_at";
