-- Token counters on agent_sessions are cumulative per session and overflow int4
-- (2,147,483,647) on long sessions: cache-read tokens alone reach billions, after
-- which every log-ingest increment fails with "integer out of range" and the
-- exporter retries the same window forever. Widen to bigint.
-- Rollback: ALTER ... TYPE INTEGER is only safe while every value fits int4.
ALTER TABLE "agent_sessions"
  ALTER COLUMN "tokens_input" TYPE BIGINT,
  ALTER COLUMN "tokens_output" TYPE BIGINT,
  ALTER COLUMN "tokens_cache_read" TYPE BIGINT,
  ALTER COLUMN "tokens_cache_creation" TYPE BIGINT,
  ALTER COLUMN "tokens_reasoning" TYPE BIGINT;
