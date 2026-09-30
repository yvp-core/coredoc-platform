-- Automatic release actors (amendment §2): per-workspace trigger mode and the
-- per-repository branch a merge/deploy into counts as production.
-- Additive only, both defaulted: every existing workspace stays on `manual`,
-- which is byte-for-byte today's behaviour, and `production_branch` NULL means
-- "the default branch the delivery connector reports".
-- Rollback:
--   ALTER TABLE "workspace_repos" DROP COLUMN "production_branch";
--   ALTER TABLE "workspaces" DROP COLUMN "intent_release_trigger";
--   DROP TYPE "IntentReleaseTrigger";
CREATE TYPE "IntentReleaseTrigger" AS ENUM ('manual', 'merge', 'deploy');

ALTER TABLE "workspaces"
  ADD COLUMN "intent_release_trigger" "IntentReleaseTrigger" NOT NULL DEFAULT 'manual';

ALTER TABLE "workspace_repos" ADD COLUMN "production_branch" TEXT;
