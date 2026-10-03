-- The canonical-order CHECK on node relations compared with the database collation, while
-- the service orders the pair by code unit (`canonicalRelationEndpoints`). Under a glibc
-- en_US.UTF-8 collation, which ignores hyphens at the first level, the two disagree
-- ('feature:pay-roll' vs 'feature:payment'), so a valid put was refused with a 500.
-- Compare bytewise instead. Rows stored in the old order are flipped first; the reverse
-- of a stored pair cannot exist, because the old CHECK refused it.
ALTER TABLE "intent_node_relations" DROP CONSTRAINT "intent_node_relations_canonical_check";

UPDATE "intent_node_relations"
SET "from_kind" = "to_kind", "from_id" = "to_id", "to_kind" = "from_kind", "to_id" = "from_id"
WHERE (("from_kind"::text || ':' || "from_id") COLLATE "C") > (("to_kind"::text || ':' || "to_id") COLLATE "C");

ALTER TABLE "intent_node_relations"
  ADD CONSTRAINT "intent_node_relations_canonical_check" CHECK (
    (("from_kind"::text || ':' || "from_id") COLLATE "C") < (("to_kind"::text || ':' || "to_id") COLLATE "C")
  );
