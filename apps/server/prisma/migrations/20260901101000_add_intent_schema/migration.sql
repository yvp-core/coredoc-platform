-- Cloud product-intent knowledge base: the nine relational tables (spec §4, §13).
-- Additive only — no existing table, column, or constraint is dropped or altered.
--
-- Tenant isolation is PHYSICAL: every child references its parent through a
-- composite key that carries "workspace_id", so a cross-workspace link cannot be
-- represented at all. Parent links use ON DELETE NO ACTION rather than RESTRICT
-- on purpose: NO ACTION still refuses to orphan a child, but its check runs at
-- end-of-statement, so a workspace hard delete (which cascades parent and child
-- rows in the same statement) still succeeds. Domain/feature deletion with live
-- children therefore fails at the database, exactly as the spec demands.

CREATE TYPE "IntentItemKind" AS ENUM (
  'capability',
  'use_case',
  'flow',
  'business_rule',
  'limitation',
  'decision'
);

CREATE TYPE "IntentItemAuthority" AS ENUM ('candidate', 'accepted', 'rejected', 'superseded');

CREATE TYPE "IntentSourceKind" AS ENUM ('spec', 'issue', 'adr', 'manual');

-- Transitions additionally admit 'import': an import records arrival, it never
-- fabricates a candidate -> accepted decision that no reviewer made (spec §4.7).
CREATE TYPE "IntentAuthoritySourceKind" AS ENUM ('spec', 'issue', 'adr', 'manual', 'import');

CREATE TYPE "IntentAuditEntityKind" AS ENUM (
  'domain',
  'feature',
  'feature_seed',
  'item',
  'item_source',
  'anchor'
);

-- ── Tree ────────────────────────────────────────────────────────────────────

CREATE TABLE "intent_domains" (
    "workspace_id" UUID NOT NULL,
    "id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "statement" VARCHAR(2000) NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(256) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "intent_domains_pkey" PRIMARY KEY ("workspace_id", "id"),
    CONSTRAINT "intent_domains_id_slug_check" CHECK (
      "id" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    )
);

CREATE INDEX "intent_domains_workspace_id_archived_idx"
ON "intent_domains"("workspace_id", "archived");

CREATE TABLE "intent_features" (
    "workspace_id" UUID NOT NULL,
    "id" VARCHAR(64) NOT NULL,
    "domain_id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "statement" VARCHAR(2000) NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(256) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "intent_features_pkey" PRIMARY KEY ("workspace_id", "id"),
    CONSTRAINT "intent_features_id_slug_check" CHECK (
      "id" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    )
);

-- Reference target for the three-column attachment FK on intent_items: a
-- feature-attached item must name the feature's OWN domain, so "feature implies
-- its domain" is a foreign key rather than a service-layer promise.
CREATE UNIQUE INDEX "intent_features_workspace_id_id_domain_id_key"
ON "intent_features"("workspace_id", "id", "domain_id");

CREATE INDEX "intent_features_workspace_id_domain_id_idx"
ON "intent_features"("workspace_id", "domain_id");

CREATE INDEX "intent_features_workspace_id_archived_idx"
ON "intent_features"("workspace_id", "archived");

CREATE TABLE "intent_feature_seeds" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "feature_id" VARCHAR(64) NOT NULL,
    "repo_key" VARCHAR(200) NOT NULL,
    "node_id" VARCHAR(500) NOT NULL,
    "note" VARCHAR(2000),
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_feature_seeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intent_feature_seeds_identity_key"
ON "intent_feature_seeds"("workspace_id", "feature_id", "repo_key", "node_id");

CREATE INDEX "intent_feature_seeds_workspace_id_repo_key_node_id_idx"
ON "intent_feature_seeds"("workspace_id", "repo_key", "node_id");

-- ── Items ───────────────────────────────────────────────────────────────────

CREATE TABLE "intent_items" (
    "workspace_id" UUID NOT NULL,
    "id" VARCHAR(64) NOT NULL,
    "domain_id" VARCHAR(64),
    "feature_id" VARCHAR(64),
    "kind" "IntentItemKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "statement" VARCHAR(2000) NOT NULL,
    "payload" JSONB,
    "rationale" VARCHAR(2000),
    "authority" "IntentItemAuthority" NOT NULL DEFAULT 'candidate',
    "proposed_successor_of_id" VARCHAR(64),
    "superseded_by_id" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(256) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "intent_items_pkey" PRIMARY KEY ("workspace_id", "id"),
    -- Attachment XOR (spec §4.4): product root (both null) | domain | feature.
    -- A feature reference without its domain is unrepresentable; the composite
    -- FK below then forces that domain to be the feature's own.
    CONSTRAINT "intent_items_attachment_check" CHECK (
      "feature_id" IS NULL OR "domain_id" IS NOT NULL
    ),
    CONSTRAINT "intent_items_id_slug_check" CHECK (
      "id" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    ),
    -- Item ids are kind-prefixed slugs (spec §4.4). A row whose prefix and kind
    -- disagree is a classification bug that no reader can recover from.
    CONSTRAINT "intent_items_id_kind_prefix_check" CHECK (
      ("kind" = 'capability' AND "id" LIKE 'cap-%')
      OR ("kind" = 'use_case' AND "id" LIKE 'uc-%')
      OR ("kind" = 'flow' AND "id" LIKE 'flow-%')
      OR ("kind" = 'business_rule' AND "id" LIKE 'br-%')
      OR ("kind" = 'limitation' AND "id" LIKE 'lim-%')
      OR ("kind" = 'decision' AND "id" LIKE 'dec-%')
    ),
    CONSTRAINT "intent_items_version_check" CHECK ("version" >= 1),
    -- A supersession pointer is only meaningful on a superseded item, and an
    -- item never supersedes or proposes to replace itself.
    CONSTRAINT "intent_items_superseded_by_authority_check" CHECK (
      "superseded_by_id" IS NULL OR "authority" = 'superseded'
    ),
    CONSTRAINT "intent_items_superseded_by_self_check" CHECK (
      "superseded_by_id" IS NULL OR "superseded_by_id" <> "id"
    ),
    CONSTRAINT "intent_items_proposed_successor_self_check" CHECK (
      "proposed_successor_of_id" IS NULL OR "proposed_successor_of_id" <> "id"
    )
);

CREATE INDEX "intent_items_workspace_id_authority_idx"
ON "intent_items"("workspace_id", "authority");

CREATE INDEX "intent_items_workspace_id_kind_idx"
ON "intent_items"("workspace_id", "kind");

CREATE INDEX "intent_items_workspace_id_domain_id_idx"
ON "intent_items"("workspace_id", "domain_id");

CREATE INDEX "intent_items_workspace_id_feature_id_idx"
ON "intent_items"("workspace_id", "feature_id");

CREATE INDEX "intent_items_workspace_id_updated_at_idx"
ON "intent_items"("workspace_id", "updated_at");

CREATE TABLE "intent_item_sources" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "item_id" VARCHAR(64) NOT NULL,
    "kind" "IntentSourceKind" NOT NULL,
    "ref" VARCHAR(500) NOT NULL,
    "local_id" VARCHAR(200) NOT NULL,
    "revision" VARCHAR(200),
    "locator" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_item_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intent_item_sources_identity_key"
ON "intent_item_sources"("workspace_id", "item_id", "kind", "ref", "local_id");

-- "Which items originate from spec X" stays a SQL question (spec §4.5).
CREATE INDEX "intent_item_sources_workspace_id_kind_ref_idx"
ON "intent_item_sources"("workspace_id", "kind", "ref");

CREATE TABLE "intent_anchors" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "item_id" VARCHAR(64) NOT NULL,
    "repo_key" VARCHAR(200) NOT NULL,
    "node_id" VARCHAR(500) NOT NULL,
    "node_type" VARCHAR(64) NOT NULL,
    "captured_versioned_id" VARCHAR(500) NOT NULL,
    "rationale" VARCHAR(2000),
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_anchors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intent_anchors_identity_key"
ON "intent_anchors"("workspace_id", "item_id", "repo_key", "node_id");

CREATE INDEX "intent_anchors_workspace_id_repo_key_node_id_idx"
ON "intent_anchors"("workspace_id", "repo_key", "node_id");

-- ── History ─────────────────────────────────────────────────────────────────

CREATE TABLE "intent_authority_transitions" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "item_id" VARCHAR(64) NOT NULL,
    "from_authority" "IntentItemAuthority",
    "to_authority" "IntentItemAuthority" NOT NULL,
    "actor_id" VARCHAR(256) NOT NULL,
    "actor_role" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(2000) NOT NULL,
    "source_kind" "IntentAuthoritySourceKind" NOT NULL,
    "source_ref" VARCHAR(500) NOT NULL,
    "source_local_id" VARCHAR(200),
    "source_revision" VARCHAR(200),
    "work_item" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_authority_transitions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "intent_authority_transitions_from_to_check" CHECK (
      "from_authority" IS NULL OR "from_authority" <> "to_authority"
    )
);

CREATE INDEX "intent_authority_transitions_item_recency_idx"
ON "intent_authority_transitions"("workspace_id", "item_id", "created_at");

CREATE INDEX "intent_authority_transitions_workspace_id_created_at_idx"
ON "intent_authority_transitions"("workspace_id", "created_at");

CREATE TABLE "intent_audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "entity_kind" "IntentAuditEntityKind" NOT NULL,
    "entity_id" VARCHAR(200) NOT NULL,
    "operation" VARCHAR(32) NOT NULL,
    "actor_id" VARCHAR(256) NOT NULL,
    "actor_role" VARCHAR(32) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "intent_audit_events_workspace_id_created_at_idx"
ON "intent_audit_events"("workspace_id", "created_at");

CREATE INDEX "intent_audit_events_entity_recency_idx"
ON "intent_audit_events"("workspace_id", "entity_kind", "entity_id", "created_at");

-- Idempotency ledger (spec §4.8). A replay with the same key AND request hash
-- returns the stored response; the same key with a different hash is an error.
-- RETENTION WINDOW: 30 days. Rows older than that carry no replay value (no
-- client retries a day-old mutation) and the ledger must not grow without
-- bound; the sweep itself lands with the mutation-request writer (issue 03) and
-- drives off the created_at index below.
CREATE TABLE "intent_mutation_requests" (
    "workspace_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_mutation_requests_pkey" PRIMARY KEY ("workspace_id", "idempotency_key")
);

-- Global date-only sweep for the retention cron: the workspace-first primary
-- key cannot serve `WHERE created_at < cutoff` across all workspaces.
CREATE INDEX "intent_mutation_requests_created_at_idx"
ON "intent_mutation_requests"("created_at");

-- ── Foreign keys ────────────────────────────────────────────────────────────

ALTER TABLE "intent_domains"
ADD CONSTRAINT "intent_domains_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_features"
ADD CONSTRAINT "intent_features_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_features"
ADD CONSTRAINT "intent_features_workspace_id_domain_id_fkey"
FOREIGN KEY ("workspace_id", "domain_id") REFERENCES "intent_domains"("workspace_id", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "intent_feature_seeds"
ADD CONSTRAINT "intent_feature_seeds_workspace_id_feature_id_fkey"
FOREIGN KEY ("workspace_id", "feature_id") REFERENCES "intent_features"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_items"
ADD CONSTRAINT "intent_items_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_items"
ADD CONSTRAINT "intent_items_workspace_id_domain_id_fkey"
FOREIGN KEY ("workspace_id", "domain_id") REFERENCES "intent_domains"("workspace_id", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "intent_items"
ADD CONSTRAINT "intent_items_workspace_id_feature_id_domain_id_fkey"
FOREIGN KEY ("workspace_id", "feature_id", "domain_id")
REFERENCES "intent_features"("workspace_id", "id", "domain_id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "intent_items"
ADD CONSTRAINT "intent_items_workspace_id_superseded_by_id_fkey"
FOREIGN KEY ("workspace_id", "superseded_by_id") REFERENCES "intent_items"("workspace_id", "id")
ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "intent_items"
ADD CONSTRAINT "intent_items_workspace_id_proposed_successor_of_id_fkey"
FOREIGN KEY ("workspace_id", "proposed_successor_of_id") REFERENCES "intent_items"("workspace_id", "id")
ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "intent_item_sources"
ADD CONSTRAINT "intent_item_sources_workspace_id_item_id_fkey"
FOREIGN KEY ("workspace_id", "item_id") REFERENCES "intent_items"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_anchors"
ADD CONSTRAINT "intent_anchors_workspace_id_item_id_fkey"
FOREIGN KEY ("workspace_id", "item_id") REFERENCES "intent_items"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_authority_transitions"
ADD CONSTRAINT "intent_authority_transitions_workspace_id_item_id_fkey"
FOREIGN KEY ("workspace_id", "item_id") REFERENCES "intent_items"("workspace_id", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_audit_events"
ADD CONSTRAINT "intent_audit_events_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intent_mutation_requests"
ADD CONSTRAINT "intent_mutation_requests_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
