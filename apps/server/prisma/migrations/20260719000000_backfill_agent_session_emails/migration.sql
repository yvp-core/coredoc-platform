-- DATA-ONLY backfill (reversibility guard).
-- Restores real member emails onto historical agent_sessions rows that were
-- stamped with the synthetic `service-token:<name>` marker before the auth
-- guard learned to resolve the creating member's email (see AuthGuard). Touches
-- NO schema: zero ALTER/DROP/CREATE. It is a single scoped UPDATE.
--
-- Idempotent by construction: the WHERE clause only matches rows still carrying
-- a `service-token:%` email, so once a row is rewritten to a real email it can
-- never match again — re-running is a no-op. Rows whose (workspace_id, user_id)
-- no longer resolve to a membership row (deleted member) are left untouched,
-- keeping their synthetic marker.
--
-- Rollback: none needed — a plain `git revert` of this migration folder does not
-- un-run applied data. The rewrite is safe to leave in place (real emails are
-- strictly better data); there is no destructive change to undo.

UPDATE "agent_sessions" AS s
SET "user_email" = m."email"
FROM "workspace_members" AS m
WHERE s."workspace_id" = m."workspace_id"
  AND s."user_id" = m."user_id"
  AND s."user_email" LIKE 'service-token:%';
