-- A repo assigned to an access area is readable only by the area's members and by
-- workspace admins/owners. A repo with no area stays readable by every member.
CREATE TABLE "access_areas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_areas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "access_areas_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "access_areas_workspace_id_name_key" ON "access_areas"("workspace_id", "name");

CREATE TABLE "access_area_members" (
    "area_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "access_area_members_pkey" PRIMARY KEY ("area_id", "user_id"),
    CONSTRAINT "access_area_members_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "access_areas"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "access_area_members_workspace_id_user_id_fkey" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "workspace_members"("workspace_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "access_area_members_workspace_id_user_id_idx" ON "access_area_members"("workspace_id", "user_id");

-- RESTRICT: deleting an area must never silently open the repos it protected.
ALTER TABLE "workspace_repos" ADD COLUMN "access_area_id" UUID;
ALTER TABLE "workspace_repos" ADD CONSTRAINT "workspace_repos_access_area_id_fkey" FOREIGN KEY ("access_area_id") REFERENCES "access_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
