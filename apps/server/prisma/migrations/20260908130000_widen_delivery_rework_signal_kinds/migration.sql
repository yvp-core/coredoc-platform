-- Widen the rework-signal vocabulary to the review-driven kinds the GitHub
-- canonical projection now emits (`review_changes_requested`, `review_commented`).
--
-- The CHECK constraint was written when the only rework evidence was a stage
-- re-entry or a reopened tracker issue. The projector already writes review
-- signals; without this the INSERT fails inside the projection transaction, and
-- because the raw payload is replayed from storage the failure repeats forever —
-- a poison pill rather than a dropped row.
--
-- CONSTRAINT ONLY — no column, no type change, no data rewrite. The widened set
-- is a strict superset of the old one, so every existing row still satisfies it.
--
-- Rollback (only safe once review-kind rows are gone; the old constraint would
-- reject them):
--   DELETE FROM "delivery_rework_signals"
--    WHERE "kind" IN ('review_changes_requested', 'review_commented');
--   ALTER TABLE "delivery_rework_signals" DROP CONSTRAINT "delivery_rework_signals_kind_check";
--   ALTER TABLE "delivery_rework_signals" ADD CONSTRAINT "delivery_rework_signals_kind_check"
--     CHECK ("kind" IN ('stage_reentry', 'tracker_reopened'));
ALTER TABLE "delivery_rework_signals" DROP CONSTRAINT "delivery_rework_signals_kind_check";
ALTER TABLE "delivery_rework_signals" ADD CONSTRAINT "delivery_rework_signals_kind_check"
  CHECK ("kind" IN ('stage_reentry', 'tracker_reopened', 'review_changes_requested', 'review_commented'));
