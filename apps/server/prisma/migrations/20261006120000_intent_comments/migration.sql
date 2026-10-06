-- Comments on features and items: one-level threads, the status on the root.
-- Additive only; rollback = drop the table and the enum type (the audit enum value is inert).
ALTER TYPE "IntentAuditEntityKind" ADD VALUE 'comment';

CREATE TYPE "IntentCommentStatus" AS ENUM ('open', 'resolved');

CREATE TABLE "intent_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "feature_id" VARCHAR(64),
    "item_id" VARCHAR(64),
    "parent_id" UUID,
    "body" VARCHAR(2000) NOT NULL,
    "status" "IntentCommentStatus",
    "resolved_by" VARCHAR(256),
    "resolved_at" TIMESTAMPTZ,
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "intent_comments_target_check" CHECK (("feature_id" IS NULL) <> ("item_id" IS NULL)),
    CONSTRAINT "intent_comments_status_check" CHECK (("parent_id" IS NULL) = ("status" IS NOT NULL))
);

CREATE INDEX "intent_comments_workspace_id_feature_id_created_at_idx" ON "intent_comments"("workspace_id", "feature_id", "created_at");
CREATE INDEX "intent_comments_workspace_id_item_id_created_at_idx" ON "intent_comments"("workspace_id", "item_id", "created_at");
CREATE INDEX "intent_comments_parent_id_created_at_idx" ON "intent_comments"("parent_id", "created_at");

ALTER TABLE "intent_comments"
ADD CONSTRAINT "intent_comments_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_comments"
ADD CONSTRAINT "intent_comments_workspace_id_feature_id_fkey"
FOREIGN KEY ("workspace_id", "feature_id") REFERENCES "intent_features"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_comments"
ADD CONSTRAINT "intent_comments_workspace_id_item_id_fkey"
FOREIGN KEY ("workspace_id", "item_id") REFERENCES "intent_items"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_comments"
ADD CONSTRAINT "intent_comments_parent_id_fkey"
FOREIGN KEY ("parent_id") REFERENCES "intent_comments"("id")
ON DELETE CASCADE ON UPDATE NO ACTION;
