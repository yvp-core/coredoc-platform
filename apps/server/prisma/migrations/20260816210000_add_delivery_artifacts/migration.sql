CREATE TABLE "delivery_artifacts" (
    "workspace_id" UUID NOT NULL,
    "id" VARCHAR(40) NOT NULL,
    "delivery_task_id" VARCHAR(40) NOT NULL,
    "repository_key" VARCHAR(256) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "delivery_artifacts_pkey" PRIMARY KEY ("workspace_id", "id"),
    CONSTRAINT "delivery_artifacts_id_check" CHECK (
      "id" ~ '^cda_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT "delivery_artifacts_kind_check" CHECK (
      "kind" IN ('spec', 'design', 'implementation_issue')
    )
);

CREATE INDEX "delivery_artifacts_workspace_id_delivery_task_id_created_at_idx"
ON "delivery_artifacts"("workspace_id", "delivery_task_id", "created_at");

CREATE TABLE "artifact_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "artifact_id" VARCHAR(40) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "byte_count" INTEGER NOT NULL,
    "markdown" TEXT NOT NULL,
    "checkpoint" VARCHAR(32) NOT NULL,
    "run_id" VARCHAR(32),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_revisions_sha256_check" CHECK (
      "sha256" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "artifact_revisions_byte_count_check" CHECK (
      "byte_count" BETWEEN 0 AND 1048576
    ),
    CONSTRAINT "artifact_revisions_markdown_size_check" CHECK (
      octet_length("markdown") = "byte_count"
    ),
    CONSTRAINT "artifact_revisions_checkpoint_check" CHECK (
      "checkpoint" IN ('run-finish', 'session-end', 'session-start-reconcile')
    ),
    CONSTRAINT "artifact_revisions_run_id_check" CHECK (
      "run_id" IS NULL OR "run_id" ~ '^cdr-[0-9]{8}-[0-9a-f]{6}$'
    )
);

CREATE UNIQUE INDEX "artifact_revisions_workspace_id_artifact_id_sha256_key"
ON "artifact_revisions"("workspace_id", "artifact_id", "sha256");

CREATE INDEX "artifact_revisions_workspace_id_artifact_id_created_at_idx"
ON "artifact_revisions"("workspace_id", "artifact_id", "created_at");

ALTER TABLE "delivery_artifacts"
ADD CONSTRAINT "delivery_artifacts_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_artifacts"
ADD CONSTRAINT "delivery_artifacts_task_fkey"
FOREIGN KEY ("workspace_id", "delivery_task_id")
REFERENCES "delivery_tasks"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "artifact_revisions"
ADD CONSTRAINT "artifact_revisions_artifact_fkey"
FOREIGN KEY ("workspace_id", "artifact_id")
REFERENCES "delivery_artifacts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
