-- Nested features: a feature may sit under another feature of the SAME domain.
-- The composite key (workspace, parent, domain) points at intent_features'
-- (workspace_id, id, domain_id) unique key, so a cross-domain parent is a foreign
-- key violation, not a service-layer promise. NO ACTION: a parent with children
-- cannot be deleted. Additive only; rollback = drop the constraints and the column.
ALTER TABLE "intent_features" ADD COLUMN "parent_feature_id" VARCHAR(64);

ALTER TABLE "intent_features"
  ADD CONSTRAINT "intent_features_parent_not_self_check" CHECK ("parent_feature_id" IS NULL OR "parent_feature_id" <> "id");

ALTER TABLE "intent_features"
  ADD CONSTRAINT "intent_features_parent_fkey"
  FOREIGN KEY ("workspace_id", "parent_feature_id", "domain_id")
  REFERENCES "intent_features"("workspace_id", "id", "domain_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "intent_features_workspace_id_parent_feature_id_idx" ON "intent_features"("workspace_id", "parent_feature_id");
