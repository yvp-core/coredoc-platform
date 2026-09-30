-- Per-repository delivery override; NULL inherits the workspace mode.
-- Roll back application code without dropping the column. Dropping it would discard saved overrides.
ALTER TABLE "workspace_repos" ADD COLUMN "intent_release_trigger" "IntentReleaseTrigger";
