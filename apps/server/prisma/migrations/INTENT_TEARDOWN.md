# Operator teardown — cloud product intent

**This is not a rollback procedure. Read the first section before running anything.**

It documents the one destructive action that removes the cloud intent module's data, for an
operator who has decided to remove the feature permanently. It lives beside the migrations that
created that data:

- `20260901100000_add_workspace_repo_intent_identity` — two columns on `workspace_repos`
- `20260901101000_add_intent_schema` — the nine tables and five enum types
- `20260901102000_add_intent_lexical_search` — `pg_trgm` and two GIN indexes
- `20260902090000_add_intent_source_title_url` — source title and URL columns
- `20260905100000_intent_release_effectivity` — durable release/plan evidence ledger
- `20260926120000_intent_dimensions` — the dimension registry table, `intent_items.applies_when`,
  and the `dimension` audit entity kind
- `20260928120000_intent_tree_conditions` — `applies_when` on `intent_domains` and `intent_features`
- `20261002120000_intent_node_relations` — the `intent_node_relations` table, the `IntentNodeKind`
  enum type, and the `node_relation` audit entity kind
- `20261002130000_intent_node_layout_item_body` — `layout` on `intent_domains` and
  `intent_features`, `body` on `intent_items`
- `20261002140000_intent_feature_parent` — `parent_feature_id` on `intent_features`, its
  same-domain foreign key, CHECK and index
- `20261003100000_intent_node_relations_collate_c` — the node-relation canonical-order CHECK
  compared bytewise (`COLLATE "C"`)

## Rollback is a code deploy, and it drops nothing

Every intent migration is additive: no pre-existing table, column, or constraint was dropped or
altered. So reverting the deploy is the whole rollback. The tables and their rows stay, and that
is deliberate — **reviewed intent is user data and survives any code-level rollback** (spec §16).
A workspace that reviewed two hundred business rules does not lose them because a release was
rolled back.

Two rules follow, and neither has an exception:

1. **`_prisma_migrations` is never hand-edited as a rollback mechanism.** Deleting a migration
   row does not undo anything; it only makes the schema and the recorded history disagree, so the
   next `prisma migrate deploy` either re-runs DDL against objects that already exist or refuses
   to run at all. The rows below are removed only as the *last* step of a full teardown, once the
   objects they describe are actually gone.
2. **Teardown requires a verified database backup and a checked export first.** The export
   omits release/plan evidence and audit history, and cannot restore them. Follow the database
   recovery verification below before deleting any data.

## Precondition: verified recovery of every workspace holding intent

For each workspace with intent content:

```sql
SELECT w.id, w.name,
       (SELECT count(*) FROM intent_items i WHERE i.workspace_id = w.id) AS items,
       (SELECT count(*) FROM intent_domains d WHERE d.workspace_id = w.id) AS domains,
       (SELECT count(*) FROM intent_features f WHERE f.workspace_id = w.id) AS features,
       (SELECT count(*) FROM intent_dimensions m WHERE m.workspace_id = w.id) AS dimensions,
       (SELECT count(*) FROM intent_anchors a WHERE a.workspace_id = w.id) AS anchors,
       (SELECT count(*) FROM intent_release_events e WHERE e.workspace_id = w.id) AS release_events
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM intent_items i WHERE i.workspace_id = w.id)
   OR EXISTS (SELECT 1 FROM intent_domains d WHERE d.workspace_id = w.id)
   OR EXISTS (SELECT 1 FROM intent_dimensions m WHERE m.workspace_id = w.id)
   OR EXISTS (SELECT 1 FROM intent_release_events e WHERE e.workspace_id = w.id);
```

Then, per workspace, take the export (`GET /api/v1/workspaces/:id/intent/export`, or
`coredoc intent export`) and **verify it before deleting anything**:

- the export parses as `CloudIntentExportV1`;
- its item, domain, feature, dimension, seed, source and anchor counts match the query above;
- it is stored somewhere that outlives this database.

`generatedAt` sits outside the hashed content, so two exports of unchanged data compare equal
apart from that field — use that to confirm the export is stable before trusting it.

The export is **not** a backup of `intent_release_events` or audit history. Take a database
backup containing all twelve intent tables, their sequences, and referenced workspace/repository
data (a full database backup is sufficient). Verify restoration in an isolated database: compare
row counts and release event contents, including sequence numbers, request/content hashes,
original responses and actor/timestamp evidence. Check that the restored head and effective set
match the source. Store the backup outside the database being removed. Export validation alone
must never satisfy this precondition; there is no cloud-export restore for release evidence.

## The destructive SQL

Run inside one transaction, against the deployment you intend to strip. Order matters: children
before parents, and the enum types only after the tables that use them are gone.

```sql
BEGIN;

-- 1. The twelve intent tables. CASCADE covers the foreign keys between them and
--    the indexes/constraints each one owns, including the two pg_trgm GIN
--    indexes on intent_items. Each `applies_when` column goes with its table.
DROP TABLE IF EXISTS "intent_node_relations"        CASCADE;
DROP TABLE IF EXISTS "intent_release_events"        CASCADE;
DROP TABLE IF EXISTS "intent_authority_transitions" CASCADE;
DROP TABLE IF EXISTS "intent_audit_events"          CASCADE;
DROP TABLE IF EXISTS "intent_mutation_requests"     CASCADE;
DROP TABLE IF EXISTS "intent_anchors"               CASCADE;
DROP TABLE IF EXISTS "intent_item_sources"          CASCADE;
DROP TABLE IF EXISTS "intent_items"                 CASCADE;
DROP TABLE IF EXISTS "intent_feature_seeds"         CASCADE;
DROP TABLE IF EXISTS "intent_features"              CASCADE;
DROP TABLE IF EXISTS "intent_domains"               CASCADE;
DROP TABLE IF EXISTS "intent_dimensions"            CASCADE;

-- 2. The enum types those tables declared (the `dimension` value of
--    IntentAuditEntityKind goes with its type).
DROP TYPE IF EXISTS "IntentAuditEntityKind";
DROP TYPE IF EXISTS "IntentAuthoritySourceKind";
DROP TYPE IF EXISTS "IntentSourceKind";
DROP TYPE IF EXISTS "IntentItemAuthority";
DROP TYPE IF EXISTS "IntentItemKind";
DROP TYPE IF EXISTS "IntentNodeKind";

-- 3. The workspace_repos additions. Named explicitly rather than left to a
--    column drop, because an operator reading this needs to see exactly which
--    constraints and index disappear with them.
DROP INDEX IF EXISTS "workspace_repos_workspace_id_intent_repo_key_key";
ALTER TABLE "workspace_repos"
  DROP CONSTRAINT IF EXISTS "workspace_repos_intent_repo_key_graph_hash_check",
  DROP CONSTRAINT IF EXISTS "workspace_repos_normalized_git_remote_check";
ALTER TABLE "workspace_repos"
  DROP COLUMN IF EXISTS "intent_repo_key",
  DROP COLUMN IF EXISTS "normalized_git_remote";

-- 4. Migration history, LAST, and only now that the objects are gone.
DELETE FROM "_prisma_migrations"
WHERE "migration_name" IN (
  '20260901100000_add_workspace_repo_intent_identity',
  '20260901101000_add_intent_schema',
  '20260901102000_add_intent_lexical_search',
  '20260902090000_add_intent_source_title_url',
  '20260905100000_intent_release_effectivity',
  '20260926120000_intent_dimensions',
  '20260928120000_intent_tree_conditions',
  '20261002120000_intent_node_relations',
  '20261002130000_intent_node_layout_item_body',
  '20261002140000_intent_feature_parent',
  '20261003100000_intent_node_relations_collate_c'
);

COMMIT;
```

### `pg_trgm` is deliberately not dropped

`20260901102000_add_intent_lexical_search` installs `pg_trgm` with `CREATE EXTENSION IF NOT
EXISTS`. Dropping the two GIN indexes (step 1, via `CASCADE`) removes everything this feature
used it for. The extension itself stays: it is a database-wide object, another feature may have
started depending on it, and `DROP EXTENSION` is not this module's call to make. An operator who
has confirmed nothing else uses it can run `DROP EXTENSION pg_trgm;` separately.

## After teardown

- The application code must already be off the intent deploy. Running it against a torn-down
  database produces "relation does not exist" on every intent route, not a degradation path.
- `prisma migrate status` will report the seven migrations as not applied, which is now correct.
- Re-adopting the feature later means applying the seven migrations again from scratch. There is
  no import path that reconstructs authority transitions, audit history or release evidence from an export — the
  export carries reviewed content, and re-import records arrival, never a decision nobody made.
