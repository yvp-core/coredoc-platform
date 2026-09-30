ALTER TABLE "workspace_repos"
ADD COLUMN "capture_repository_key" TEXT;

CREATE UNIQUE INDEX "workspace_repos_workspace_id_capture_repository_key_key"
ON "workspace_repos"("workspace_id", "capture_repository_key");
