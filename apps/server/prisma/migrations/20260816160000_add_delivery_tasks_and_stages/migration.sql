CREATE TABLE "delivery_tasks" (
    "workspace_id" UUID NOT NULL,
    "id" VARCHAR(40) NOT NULL,
    "repository_key" VARCHAR(256),
    "lifecycle" VARCHAR(16) NOT NULL,
    "authority" VARCHAR(80) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "delivery_tasks_pkey" PRIMARY KEY ("workspace_id", "id"),
    CONSTRAINT "delivery_tasks_id_check" CHECK (
      "id" ~ '^cdt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT "delivery_tasks_lifecycle_check" CHECK (
      "lifecycle" IN ('active', 'completed', 'abandoned')
    ),
    CONSTRAINT "delivery_tasks_authority_check" CHECK (
      "authority" = 'coredoc' OR "authority" ~ '^connector:[a-z][a-z0-9._-]{0,63}$'
    )
);

CREATE INDEX "delivery_tasks_workspace_id_created_at_idx"
ON "delivery_tasks"("workspace_id", "created_at");

CREATE TABLE "task_external_refs" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "delivery_task_id" VARCHAR(40) NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "external_id" VARCHAR(256) NOT NULL,
    "external_key" VARCHAR(256),
    "external_url" VARCHAR(2048),
    "external_state" VARCHAR(128),

    CONSTRAINT "task_external_refs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_external_refs_provider_check" CHECK (
      "provider" ~ '^[a-z][a-z0-9._-]{0,63}$'
    ),
    CONSTRAINT "task_external_refs_external_id_check" CHECK (length("external_id") > 0)
);

CREATE UNIQUE INDEX "task_external_refs_workspace_id_provider_external_id_key"
ON "task_external_refs"("workspace_id", "provider", "external_id");

CREATE INDEX "task_external_refs_workspace_id_delivery_task_id_idx"
ON "task_external_refs"("workspace_id", "delivery_task_id");

ALTER TABLE "workflow_runs"
ADD COLUMN "delivery_task_id" VARCHAR(40),
ADD COLUMN "declared_stages" JSONB;

CREATE INDEX "workflow_runs_workspace_id_delivery_task_id_idx"
ON "workflow_runs"("workspace_id", "delivery_task_id");

CREATE TABLE "workflow_stage_occurrences" (
    "id" UUID NOT NULL,
    "workflow_run_id" UUID NOT NULL,
    "stage_id" VARCHAR(76) NOT NULL,
    "attempt" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "outcome" VARCHAR(16),

    CONSTRAINT "workflow_stage_occurrences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_stage_occurrences_attempt_check" CHECK ("attempt" BETWEEN 1 AND 1000),
    CONSTRAINT "workflow_stage_occurrences_outcome_check" CHECK (
      "outcome" IS NULL OR "outcome" IN ('success', 'failed', 'blocked', 'abandoned')
    ),
    CONSTRAINT "workflow_stage_occurrences_finish_pair_check" CHECK (
      ("finished_at" IS NULL AND "outcome" IS NULL) OR
      ("finished_at" IS NOT NULL AND "outcome" IS NOT NULL)
    ),
    CONSTRAINT "workflow_stage_occurrences_time_order_check" CHECK (
      "started_at" IS NULL OR "finished_at" IS NULL OR "started_at" <= "finished_at"
    )
);

CREATE UNIQUE INDEX "workflow_stage_occurrences_workflow_run_id_stage_id_attempt_key"
ON "workflow_stage_occurrences"("workflow_run_id", "stage_id", "attempt");

ALTER TABLE "delivery_tasks"
ADD CONSTRAINT "delivery_tasks_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_external_refs"
ADD CONSTRAINT "task_external_refs_task_fkey"
FOREIGN KEY ("workspace_id", "delivery_task_id")
REFERENCES "delivery_tasks"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_runs"
ADD CONSTRAINT "workflow_runs_delivery_task_fkey"
FOREIGN KEY ("workspace_id", "delivery_task_id")
REFERENCES "delivery_tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "workflow_stage_occurrences"
ADD CONSTRAINT "workflow_stage_occurrences_workflow_run_id_fkey"
FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
