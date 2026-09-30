-- L4 per-workspace gating flag (closed-beta default OFF; owner directive 2026-07-21).
-- Rollback: ALTER TABLE "workspaces" DROP COLUMN "delivery_enabled";
ALTER TABLE "workspaces" ADD COLUMN "delivery_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Grandfather workspaces already using L4 (a connector or any ingested work item):
-- data-driven, not hardcoded — nobody currently on the feature goes dark.
UPDATE "workspaces" w
SET "delivery_enabled" = true
WHERE EXISTS (SELECT 1 FROM "delivery_connectors" c WHERE c."workspace_id" = w."id")
   OR EXISTS (SELECT 1 FROM "delivery_work_items" i WHERE i."workspace_id" = w."id");
