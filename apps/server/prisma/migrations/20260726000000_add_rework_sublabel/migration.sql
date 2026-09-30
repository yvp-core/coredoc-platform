-- L4 Phase-4 missing_context sub-label (design 2026-07-20 §11.3). Additive only.
-- Rollback: ALTER TABLE "delivery_rework_episodes" DROP COLUMN "root_cause_sublabel";
ALTER TABLE "delivery_rework_episodes" ADD COLUMN "root_cause_sublabel" TEXT;
