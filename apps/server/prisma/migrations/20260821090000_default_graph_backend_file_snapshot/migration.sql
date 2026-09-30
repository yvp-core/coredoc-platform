-- New workspaces are provisioned on the immutable file-snapshot (Ladybug)
-- data plane instead of Turso. Column default only — EXISTING rows keep
-- whatever backend they are on; there is no data migration here.
ALTER TABLE "workspaces"
  ALTER COLUMN "graph_backend" SET DEFAULT 'file_snapshot';

-- Required companion, not an independent policy change: the
-- "workspaces_file_snapshot_requires_retention_check" constraint (migration
-- 20260811120000) rejects a file-snapshot row whose retain_graph_artifacts is
-- false, so an INSERT that takes both defaults would fail without this.
-- Existing rows are untouched (retention is monotonic and trigger-guarded).
ALTER TABLE "workspaces"
  ALTER COLUMN "retain_graph_artifacts" SET DEFAULT true;

-- Rollback:
--   ALTER TABLE "workspaces" ALTER COLUMN "graph_backend" SET DEFAULT 'turso';
--   ALTER TABLE "workspaces" ALTER COLUMN "retain_graph_artifacts" SET DEFAULT false;
