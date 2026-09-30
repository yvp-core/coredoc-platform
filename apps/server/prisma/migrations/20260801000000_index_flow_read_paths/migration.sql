-- The indexes the loop-readings request path and the channel-scoped rework reads
-- need. Both tables gained readers in this change and neither gained an index for
-- them, so every one of those reads was a workspace-wide scan plus a sort.
--
-- delivery_rework_episodes: every rework read is now scoped to one observation
-- channel (summary's pareto, journey's mart, the timeline strip, graph fusion, the
-- detectors' prune, the list route), and the readings additionally bound and order
-- by started_at. The table's existing indexes cover work_item_id and code_change_id
-- only, so none of them can serve a (workspace, channel, started_at) predicate.
--
-- delivery_flow_run_records: the readings enumerate a window with a predicate of
-- claimed_at OR (claimed_at IS NULL AND observed_at), and the table is indexed on
-- run_id and code_change_id only. Both branches of the OR get an index, because
-- Postgres can BitmapOr two index scans but cannot serve either branch from an
-- index that holds no moment.
--
-- ADDITIVE ONLY — three indexes, no column, no type, no data rewrite — so a plain
-- revert drops what it added and restores nothing.
--
-- Rollback:
--   DROP INDEX "delivery_rework_episodes_workspace_id_channel_started_at_idx";
--   DROP INDEX "delivery_flow_run_records_workspace_id_claimed_at_idx";
--   DROP INDEX "delivery_flow_run_records_workspace_id_observed_at_idx";
--
-- Written as plain CREATE INDEX rather than CONCURRENTLY because Prisma runs a
-- migration inside a transaction, which CONCURRENTLY cannot join — the same
-- trade-off the run_id index recorded, and for the same reason: these tables are
-- young. delivery_flow_run_records was created three migrations ago, and the
-- episode table holds only what the connector detectors have derived.
CREATE INDEX "delivery_rework_episodes_workspace_id_channel_started_at_idx" ON "delivery_rework_episodes"("workspace_id", "channel", "started_at");

CREATE INDEX "delivery_flow_run_records_workspace_id_claimed_at_idx" ON "delivery_flow_run_records"("workspace_id", "claimed_at");

CREATE INDEX "delivery_flow_run_records_workspace_id_observed_at_idx" ON "delivery_flow_run_records"("workspace_id", "observed_at");
