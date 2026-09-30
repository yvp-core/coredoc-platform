-- Intent context conditions (.scratch/intent-dimensions/spec.md, step 3): the
-- workspace dimension registry and the item-level `applies_when` column.
-- Additive only; rollback = drop the table and the column (the enum value is inert).
ALTER TYPE "IntentAuditEntityKind" ADD VALUE 'dimension';

CREATE TABLE "intent_dimensions" (
    "workspace_id" UUID NOT NULL,
    "id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "values" JSONB NOT NULL,
    "multi" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(256) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "intent_dimensions_pkey" PRIMARY KEY ("workspace_id", "id"),
    CONSTRAINT "intent_dimensions_id_slug_check" CHECK (
      "id" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    )
);

CREATE INDEX "intent_dimensions_workspace_id_archived_idx"
ON "intent_dimensions"("workspace_id", "archived");

ALTER TABLE "intent_dimensions"
ADD CONSTRAINT "intent_dimensions_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_items" ADD COLUMN "applies_when" JSONB;
