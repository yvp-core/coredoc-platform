-- Tree conditions (.scratch/intent-dimensions-inheritance/spec.md, step 2):
-- `applies_when` on domains and features. Additive only; rollback = drop the columns.
ALTER TABLE "intent_domains" ADD COLUMN "applies_when" JSONB;
ALTER TABLE "intent_features" ADD COLUMN "applies_when" JSONB;
