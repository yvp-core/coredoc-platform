-- Cloud agent runs, per-turn report caps: what the runner reported during a turn, so a
-- runaway runner fails the run with report_limit_exceeded.
-- Additive only; rollback = drop the four columns.

-- AlterTable
ALTER TABLE "cloud_agent_run_turns" ADD COLUMN     "reported_event_bytes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reported_events" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reported_proposals" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reported_questions" INTEGER NOT NULL DEFAULT 0;
