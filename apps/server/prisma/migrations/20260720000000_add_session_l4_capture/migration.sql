-- L4 Phase-0 capture columns (design doc 2026-07-20 §16 Phase 0). Additive only.
-- Rollback: ALTER TABLE "agent_sessions"
--   DROP COLUMN "head_sha_start", DROP COLUMN "head_sha_end", DROP COLUMN "skills_used";
ALTER TABLE "agent_sessions" ADD COLUMN "head_sha_start" TEXT;
ALTER TABLE "agent_sessions" ADD COLUMN "head_sha_end" TEXT;
ALTER TABLE "agent_sessions" ADD COLUMN "skills_used" JSONB NOT NULL DEFAULT '{}';
