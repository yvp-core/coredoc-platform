DELETE FROM "capture_accepted_watermarks"
WHERE "host" = 'codex'
  AND "scope_key" = 'profile'
  AND "repository_key" IS NULL;

ALTER TABLE "capture_accepted_watermarks"
DROP CONSTRAINT "capture_accepted_watermarks_scope_check";

ALTER TABLE "capture_accepted_watermarks"
ADD CONSTRAINT "capture_accepted_watermarks_scope_check" CHECK (
  "host" IN ('claude-code', 'codex')
  AND "repository_key" IS NOT NULL
  AND "scope_key" = 'repo:' || "repository_key"
);
