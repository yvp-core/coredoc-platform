-- Phase 3 write-side prerequisites: immutable component descriptors and
-- monotonic graph-artifact retention.
ALTER TABLE "workspaces"
  ADD COLUMN "retain_graph_artifacts" BOOLEAN NOT NULL DEFAULT false;

-- File-snapshot manifests keep immutable references to component and mapper
-- blobs. Heal any branch-local pilot rows before making that relationship a
-- database invariant so out-of-band backend flips cannot enable destructive GC.
UPDATE "workspaces"
SET "retain_graph_artifacts" = true
WHERE "graph_backend" = 'file_snapshot';

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_file_snapshot_requires_retention_check"
  CHECK ("graph_backend" <> 'file_snapshot' OR "retain_graph_artifacts");

CREATE FUNCTION "reject_retain_graph_artifacts_clear"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."retain_graph_artifacts" AND NOT NEW."retain_graph_artifacts" THEN
    RAISE EXCEPTION 'retain_graph_artifacts is monotonic and cannot be cleared'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "workspaces_retain_graph_artifacts_monotonic"
BEFORE UPDATE OF "retain_graph_artifacts" ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "reject_retain_graph_artifacts_clear"();

CREATE TYPE "WorkspaceRepoArtifactKind" AS ENUM ('parsed', 'summary', 'embeddings');

CREATE TABLE "workspace_repo_artifacts" (
  "workspace_id" UUID NOT NULL,
  "repo_key" TEXT NOT NULL,
  "repo_name" TEXT NOT NULL,
  "kind" "WorkspaceRepoArtifactKind" NOT NULL,
  "version" VARCHAR(68) NOT NULL,
  "r2_key" TEXT NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workspace_repo_artifacts_pkey"
    PRIMARY KEY ("workspace_id", "repo_key", "kind", "version"),
  CONSTRAINT "workspace_repo_artifacts_repository_fkey"
    FOREIGN KEY ("workspace_id", "repo_key")
    REFERENCES "workspace_repos"("workspace_id", "repo_key")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_repo_artifacts_version_check"
    CHECK (
      ("kind" = 'parsed' AND "version" ~ '^[0-9a-f]{16}$') OR
      ("kind" = 'summary' AND "version" ~ '^sum_[0-9a-f]{16}$') OR
      ("kind" = 'embeddings' AND "version" ~ '^emb_[0-9a-f]{16}$')
    ),
  CONSTRAINT "workspace_repo_artifacts_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "workspace_repo_artifacts_size_bytes_check"
    CHECK ("size_bytes" > 0),
  CONSTRAINT "workspace_repo_artifacts_r2_key_prefix_check"
    CHECK (
      "r2_key" LIKE "workspace_id"::text || '/%' AND
      position('/../' IN "r2_key") = 0 AND
      position('/./' IN "r2_key") = 0
    )
);

CREATE INDEX "workspace_repo_artifacts_workspace_id_repo_name_kind_version_idx"
  ON "workspace_repo_artifacts"("workspace_id", "repo_name", "kind", "version");

CREATE FUNCTION "reject_workspace_repo_artifact_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'workspace repository artifact descriptors are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "workspace_repo_artifacts_immutable"
BEFORE UPDATE ON "workspace_repo_artifacts"
FOR EACH ROW EXECUTE FUNCTION "reject_workspace_repo_artifact_update"();
