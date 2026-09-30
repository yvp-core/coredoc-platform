-- T2 partial mapping: progress and sticky manual removal; no history table.
-- Rollback: stop the new CI mapping caller before reverting application code.
-- Keep these additive nullable columns during rollback. Dropping them discards
-- progress/manual overrides and can let an old whole-repo writer revive links.
ALTER TABLE workspace_repos
  ADD COLUMN intent_anchors_commit VARCHAR(40),
  ADD COLUMN intent_anchors_graph_version_id VARCHAR(128),
  ADD CONSTRAINT workspace_repos_intent_anchors_pair CHECK
    ((intent_anchors_commit IS NULL) = (intent_anchors_graph_version_id IS NULL));
ALTER TABLE intent_anchors
  ADD COLUMN disabled_at TIMESTAMPTZ,
  ADD COLUMN disabled_by VARCHAR(256),
  ADD CONSTRAINT intent_anchors_disabled_pair CHECK
    ((disabled_at IS NULL) = (disabled_by IS NULL));
