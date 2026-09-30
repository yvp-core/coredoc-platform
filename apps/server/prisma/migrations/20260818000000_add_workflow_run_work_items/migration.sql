CREATE UNIQUE INDEX "workflow_runs_workspace_id_id_key"
ON "workflow_runs"("workspace_id", "id");

CREATE TABLE "workflow_run_work_items" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "workflow_run_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "external_id" VARCHAR(256) NOT NULL,
    "external_key" VARCHAR(256),

    CONSTRAINT "workflow_run_work_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_run_work_items_identity_key"
ON "workflow_run_work_items"("workspace_id", "workflow_run_id", "provider", "external_id");

CREATE INDEX "workflow_run_work_items_external_identity_idx"
ON "workflow_run_work_items"("workspace_id", "provider", "external_id");

ALTER TABLE "workflow_run_work_items"
ADD CONSTRAINT "workflow_run_work_items_workflow_run_fkey"
FOREIGN KEY ("workspace_id", "workflow_run_id")
REFERENCES "workflow_runs"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
