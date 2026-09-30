-- Widen session feedback from "how did the MCP tools behave" to "how did the
-- whole session go": workflow routing, skill instructions, missing task
-- context, transport, agent behaviour, host environment.
--
-- `session_issues` holds the non-tool issues as a JSON array shaped like
-- `per_tool_issues`, keyed by a closed `area` vocabulary instead of a tool name.
-- `summary` is one short redacted narrative for the session.
--
-- `user_rating`, `user_notes`, `review_status` carry the human side of the
-- record. The agent's self-assessment (`overall_rating`) is systematically
-- optimistic: it cannot report the skill or capability it never knew was
-- missing. The plugin therefore shows its draft to the user before submitting
-- and records whether the user confirmed it, amended it, or never answered
-- (`unreviewed`, which is also the truth for every existing row). The gap
-- between the two ratings is the metric this exists to expose.
--
-- ADDITIVE ONLY — five nullable/defaulted columns, no type change, no data
-- rewrite — so a plain revert drops what it added and restores nothing.
--
-- Rollback:
--   ALTER TABLE "mcp_feedback" DROP COLUMN "session_issues";
--   ALTER TABLE "mcp_feedback" DROP COLUMN "summary";
--   ALTER TABLE "mcp_feedback" DROP COLUMN "user_rating";
--   ALTER TABLE "mcp_feedback" DROP COLUMN "user_notes";
--   ALTER TABLE "mcp_feedback" DROP COLUMN "review_status";
ALTER TABLE "mcp_feedback" ADD COLUMN "session_issues" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "mcp_feedback" ADD COLUMN "summary" VARCHAR(2000);
ALTER TABLE "mcp_feedback" ADD COLUMN "user_rating" INTEGER;
ALTER TABLE "mcp_feedback" ADD COLUMN "user_notes" VARCHAR(2000);
ALTER TABLE "mcp_feedback" ADD COLUMN "review_status" VARCHAR(16) NOT NULL DEFAULT 'unreviewed';
