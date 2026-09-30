-- Durable intent repo identity on the workspace repo registry (spec §6.5).
-- Additive only: two nullable columns, two CHECKs, one unique index.
--
-- `intent_repo_key` is the DISPLAY-form durable key that anchors and feature
-- seeds address a repository by; `repo_key` is the graph identity. The pair is
-- only trustworthy when the unchanged graph-id algorithm reproduces the stored
-- hash from the key, which the CHECK below enforces on every write.

ALTER TABLE "workspace_repos"
ADD COLUMN "intent_repo_key" TEXT,
ADD COLUMN "normalized_git_remote" VARCHAR(2048);

-- A display name is a provable durable key only when the unchanged graph-id
-- algorithm reproduces the row's stored graph hash. Explicit keys cannot be
-- reversed from the hash, so every other legacy row intentionally stays null
-- until its next trusted sync.
UPDATE "workspace_repos"
SET "intent_repo_key" = "repo_name"
WHERE "repo_key" = left(encode(sha256(convert_to("repo_name", 'UTF8')), 'hex'), 12);

ALTER TABLE "workspace_repos"
ADD CONSTRAINT "workspace_repos_intent_repo_key_graph_hash_check"
CHECK (
  "intent_repo_key" IS NULL
  OR "repo_key" = left(encode(sha256(convert_to("intent_repo_key", 'UTF8')), 'hex'), 12)
),
ADD CONSTRAINT "workspace_repos_normalized_git_remote_check"
CHECK (
  "normalized_git_remote" IS NULL
  OR (
    "normalized_git_remote" !~ '[[:space:]@?#]'
    AND "normalized_git_remote" !~* '\.git$'
    AND "normalized_git_remote" ~ '^(https?|ssh|git)://[^/]+/.+$|^(github\.com|gitlab\.com|bitbucket\.org)/.+$'
  )
);

CREATE UNIQUE INDEX "workspace_repos_workspace_id_intent_repo_key_key"
ON "workspace_repos"("workspace_id", "intent_repo_key");
