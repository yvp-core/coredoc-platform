ALTER TABLE "capture_provisioning"
  ADD COLUMN "attribution_pending_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attribution_rejected_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attribution_last_claim_at" TIMESTAMPTZ;
