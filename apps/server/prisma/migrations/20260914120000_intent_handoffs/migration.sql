-- Hosted MCP handoff replaces PR-body declarations. Additive; preserves all anchors/ledger.
-- Rollback: disable the handoff worker first. Keep this table to preserve pending work;
-- dropping it would lose declarations, and is deliberately not an automatic rollback.
CREATE TABLE intent_handoffs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 repo_key varchar(200) NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 head_sha varchar(40) NOT NULL, pr_number integer CHECK(pr_number > 0), payload jsonb NOT NULL,
 mapping_state varchar(32) NOT NULL DEFAULT 'pending', delivery_state varchar(32) NOT NULL DEFAULT 'pending',
 mapping_reason varchar(200), delivery_reason varchar(200), results jsonb NOT NULL DEFAULT '[]',
 merge_commit varchar(40), merged_at timestamptz, pr_observed_at timestamptz, next_attempt_at timestamptz DEFAULT now(),
 created_by text NOT NULL, updated_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intent_handoffs_next_attempt_at_idx ON intent_handoffs(next_attempt_at);
CREATE UNIQUE INDEX intent_handoffs_workspace_id_repo_key_pr_number_key ON intent_handoffs(workspace_id,repo_key,pr_number);
