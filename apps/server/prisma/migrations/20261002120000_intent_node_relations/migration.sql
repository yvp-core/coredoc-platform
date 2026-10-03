-- Node relations: "see also" links between domains and features, each with a reason.
-- Additive only; rollback = drop the table and the enum type (the audit enum value is inert).
ALTER TYPE "IntentAuditEntityKind" ADD VALUE 'node_relation';

CREATE TYPE "IntentNodeKind" AS ENUM ('domain', 'feature');

CREATE TABLE "intent_node_relations" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "from_kind" "IntentNodeKind" NOT NULL,
    "from_id" VARCHAR(64) NOT NULL,
    "to_kind" "IntentNodeKind" NOT NULL,
    "to_id" VARCHAR(64) NOT NULL,
    "why" VARCHAR(500) NOT NULL,
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_node_relations_pkey" PRIMARY KEY ("id"),
    -- Stored once, in canonical order: never a self-link, never both directions.
    CONSTRAINT "intent_node_relations_canonical_check" CHECK (
      ("from_kind"::text || ':' || "from_id") < ("to_kind"::text || ':' || "to_id")
    )
);

CREATE UNIQUE INDEX "intent_node_relations_identity_key"
ON "intent_node_relations"("workspace_id", "from_kind", "from_id", "to_kind", "to_id");

CREATE INDEX "intent_node_relations_workspace_id_to_kind_to_id_idx"
ON "intent_node_relations"("workspace_id", "to_kind", "to_id");

ALTER TABLE "intent_node_relations"
ADD CONSTRAINT "intent_node_relations_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
