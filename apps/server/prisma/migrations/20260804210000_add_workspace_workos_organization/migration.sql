-- WorkOS-backed workspaces receive an organization mapping lazily when
-- invitation delivery is first needed; non-WorkOS deployments remain NULL.
ALTER TABLE "workspaces"
ADD COLUMN "workos_organization_id" TEXT;

CREATE UNIQUE INDEX "workspaces_workos_organization_id_key"
ON "workspaces"("workos_organization_id");
