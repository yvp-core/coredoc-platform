-- Persist the source `title` and `url` the intent contract already accepts.
--
-- `IntentSourceSchema` (contract/intent-primitives.ts) has always validated both
-- fields — title bounded at 200 chars, url by the shared `externalUrl` rule
-- (http/https, no credentials, no token-shaped query parameters) — but there was
-- no column to write them to, so every propose and every import silently dropped
-- them. Silent loss of caller-supplied provenance is worse than a refusal: the
-- caller believes the link was kept.
--
-- Additive and nullable, so it is a plain forward-only column add and a revert is
-- a `DROP COLUMN` that loses only data written after this migration. Identity is
-- still `(ref, localId)` (unique index unchanged): a re-titled or re-hosted source
-- refreshes the row rather than appending a second one.
ALTER TABLE "intent_item_sources"
  ADD COLUMN "title" VARCHAR(200),
  ADD COLUMN "url"   VARCHAR(2048);
