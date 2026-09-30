-- Phase D cutover: remove the retired SpecFlow/flow-readings storage surface.
-- Canonical delivery tasks, capture events, workflow runs, connector raw payloads,
-- code changes, actor identities, and status lifecycle policy remain authoritative.

-- No runtime producer or processor remains for these rows.
DELETE FROM "push_jobs" WHERE "type" = 'classify';

-- The retired coredoc/specflow connector has no polled importer. Its connector-
-- scoped rows cascade; canonical task refs retain their identity and detach via
-- the connector FK's column-list SET NULL action.
DELETE FROM "delivery_connectors" WHERE "provider" = 'coredoc';

DROP TABLE IF EXISTS "delivery_task_journeys";
DROP TABLE IF EXISTS "delivery_spec_revisions";
DROP TABLE IF EXISTS "delivery_work_item_transitions";
DROP TABLE IF EXISTS "delivery_work_items";
DROP TABLE IF EXISTS "delivery_links";
DROP TABLE IF EXISTS "delivery_flow_run_records";
DROP TABLE IF EXISTS "delivery_rework_episodes";

ALTER TABLE "delivery_status_map" DROP COLUMN IF EXISTS "stage";

DROP INDEX IF EXISTS "agent_sessions_workspace_id_run_id_idx";
ALTER TABLE "agent_sessions"
  DROP COLUMN IF EXISTS "spec_id",
  DROP COLUMN IF EXISTS "run_id",
  DROP COLUMN IF EXISTS "edit_verify_rounds",
  DROP COLUMN IF EXISTS "outcome",
  DROP COLUMN IF EXISTS "workflow_summary";

DROP TYPE IF EXISTS "WorkItemStage";
DROP TYPE IF EXISTS "LinkRel";
DROP TYPE IF EXISTS "LinkMethod";
DROP TYPE IF EXISTS "ObservationChannel";
DROP TYPE IF EXISTS "FlowRecordSource";
