-- Phase 2 read-side prerequisite: immutable graph-version metadata and one
-- workspace-scoped active pointer. Publishing/CAS remains a later migration.
ALTER TABLE "workspaces"
  ADD COLUMN "graph_backend" VARCHAR(32) NOT NULL DEFAULT 'turso',
  ADD COLUMN "active_graph_version_id" VARCHAR(64);

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_graph_backend_check"
  CHECK ("graph_backend" IN ('turso', 'file_snapshot'));

CREATE TABLE "workspace_graph_versions" (
  "workspace_id" UUID NOT NULL,
  "version_id" VARCHAR(64) NOT NULL,
  "engine" VARCHAR(16) NOT NULL,
  "r2_key" TEXT NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "storage_format_version" INTEGER NOT NULL,
  "manifest" JSONB NOT NULL,
  "parent_version_id" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workspace_graph_versions_pkey"
    PRIMARY KEY ("workspace_id", "version_id"),
  CONSTRAINT "workspace_graph_versions_engine_check"
    CHECK ("engine" IN ('sqlite', 'ladybug')),
  CONSTRAINT "workspace_graph_versions_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "workspace_graph_versions_size_bytes_check"
    CHECK ("size_bytes" > 0),
  CONSTRAINT "workspace_graph_versions_storage_format_version_check"
    CHECK ("storage_format_version" > 0),
  CONSTRAINT "workspace_graph_versions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_graph_versions_parent_fkey"
    FOREIGN KEY ("workspace_id", "parent_version_id")
    REFERENCES "workspace_graph_versions"("workspace_id", "version_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION
    DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_active_graph_version_fkey"
  FOREIGN KEY ("id", "active_graph_version_id")
  REFERENCES "workspace_graph_versions"("workspace_id", "version_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX "workspace_graph_versions_workspace_id_created_at_idx"
  ON "workspace_graph_versions"("workspace_id", "created_at");

CREATE INDEX "workspace_graph_versions_workspace_id_parent_version_id_idx"
  ON "workspace_graph_versions"("workspace_id", "parent_version_id");
