-- Lexical selector support for the intent context API (spec §7, §13).
--
-- Trigram, chosen now rather than left as "FTS or trigram": intent statements
-- are short, are queried with partial words and identifier fragments, and are
-- searched across mixed natural language and code-ish tokens, none of which a
-- stemmed tsvector serves well.
--
-- DEPLOYMENT NOTE: `CREATE EXTENSION` requires a role permitted to install
-- extensions. pg_trgm is a standard contrib module available on every managed
-- Postgres this project targets (AWS RDS/Aurora, Google Cloud SQL, Neon,
-- Supabase, and the postgres:16-alpine image the integration suite runs), but it
-- must be confirmed enabled for the deployment role before this migration is
-- applied to production. It is the FIRST extension this schema installs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "intent_items_title_trgm_idx"
ON "intent_items" USING GIN ("title" gin_trgm_ops);

CREATE INDEX "intent_items_statement_trgm_idx"
ON "intent_items" USING GIN ("statement" gin_trgm_ops);
