-- AlterTable
ALTER TABLE "workspace_members" RENAME CONSTRAINT "team_members_pkey" TO "workspace_members_pkey";

-- AlterTable
ALTER TABLE "workspace_repos" RENAME CONSTRAINT "team_repos_pkey" TO "workspace_repos_pkey";

-- AlterTable
ALTER TABLE "workspaces" RENAME CONSTRAINT "teams_pkey" TO "workspaces_pkey";

-- RenameForeignKey
ALTER TABLE "service_tokens" RENAME CONSTRAINT "service_tokens_team_id_fkey" TO "service_tokens_workspace_id_fkey";

-- RenameForeignKey
ALTER TABLE "workspace_members" RENAME CONSTRAINT "team_members_team_id_fkey" TO "workspace_members_workspace_id_fkey";

-- RenameForeignKey
ALTER TABLE "workspace_repos" RENAME CONSTRAINT "team_repos_team_id_fkey" TO "workspace_repos_workspace_id_fkey";

-- RenameIndex
ALTER INDEX "service_tokens_team_id_name_key" RENAME TO "service_tokens_workspace_id_name_key";

-- RenameIndex
ALTER INDEX "team_members_workos_membership_id_key" RENAME TO "workspace_members_workos_membership_id_key";

-- RenameIndex
ALTER INDEX "team_repos_team_id_repo_key_key" RENAME TO "workspace_repos_workspace_id_repo_key_key";

-- RenameIndex
ALTER INDEX "teams_slug_key" RENAME TO "workspaces_slug_key";

-- RenameIndex
ALTER INDEX "teams_workos_org_id_key" RENAME TO "workspaces_workos_org_id_key";
