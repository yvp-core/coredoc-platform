-- Per-workspace intent gating flag (default OFF; hides the Intent tab and the
-- cloud intent MCP tools until an owner turns it on).
-- Rollback: ALTER TABLE "workspaces" DROP COLUMN "intent_enabled";
ALTER TABLE "workspaces" ADD COLUMN "intent_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Grandfather workspaces already holding intent content (a domain or any item):
-- data-driven, not hardcoded — nobody currently on the feature goes dark.
UPDATE "workspaces" w
SET "intent_enabled" = true
WHERE EXISTS (SELECT 1 FROM "intent_domains" d WHERE d."workspace_id" = w."id")
   OR EXISTS (SELECT 1 FROM "intent_items" i WHERE i."workspace_id" = w."id");
