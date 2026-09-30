-- Rollback: reverting application code does not revoke these grants.
-- Before production rollout, save the IDs and permissions of rows selected by
-- this UPDATE. To undo the backfill, restore those permission arrays by ID, or
-- revoke and replace the affected credentials. Do not strip intent permissions
-- globally: some tokens already held them before this migration.
-- Stop upgraded token minting before rollback; tokens minted after the backup
-- need separate review/revocation because they are absent from that snapshot.
-- Scope was stored as permissions. Upgrade only the known CI permission set,
-- preserving credentials and unrelated grants. Wildcards/custom purposes stay unchanged.
UPDATE "service_tokens"
SET "permissions" = "permissions" || ARRAY(
  SELECT permission
  FROM unnest(ARRAY['intent:release', 'intent:bindings']::text[]) AS permission
  WHERE NOT permission = ANY ("permissions")
)
WHERE "permissions" @> ARRAY['parser:read', 'parser:write', 'result:read', 'result:write', 'repo:push']::text[]
  AND "permissions" <@ ARRAY['parser:read', 'parser:write', 'result:read', 'result:write', 'repo:push', 'intent:release', 'intent:bindings']::text[]
  AND NOT "permissions" @> ARRAY['intent:release', 'intent:bindings']::text[];
