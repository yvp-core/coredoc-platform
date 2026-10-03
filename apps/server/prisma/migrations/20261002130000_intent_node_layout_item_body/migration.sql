-- Document shape for the file-like node read: a node's layout (headings, prose lines, item
-- slots) and an item's body lines. Additive only; rollback = drop the three columns.
ALTER TABLE "intent_domains" ADD COLUMN "layout" JSONB;
ALTER TABLE "intent_features" ADD COLUMN "layout" JSONB;
ALTER TABLE "intent_items" ADD COLUMN "body" JSONB;
