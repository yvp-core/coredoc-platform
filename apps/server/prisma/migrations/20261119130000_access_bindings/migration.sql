-- Access is stored as bindings: "principal (member or group) has role on
-- resource (the workspace or one repo)". The workspace role of a member moves
-- from workspace_members.role into its binding on the workspace.
CREATE TABLE "access_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "access_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "access_groups_workspace_id_name_key" ON "access_groups"("workspace_id", "name");

CREATE TABLE "access_group_members" (
    "group_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "access_group_members_pkey" PRIMARY KEY ("group_id", "user_id"),
    CONSTRAINT "access_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "access_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "access_group_members_workspace_id_user_id_fkey" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "workspace_members"("workspace_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "access_group_members_workspace_id_user_id_idx" ON "access_group_members"("workspace_id", "user_id");

CREATE TABLE "access_bindings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" TEXT,
    "group_id" UUID,
    "role" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(32) NOT NULL,
    "resource_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "access_bindings_one_principal" CHECK (("user_id" IS NULL) <> ("group_id" IS NULL)),
    CONSTRAINT "access_bindings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "access_bindings_workspace_id_user_id_fkey" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "workspace_members"("workspace_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "access_bindings_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "access_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "access_bindings_workspace_id_user_id_resource_type_resource_id_key" ON "access_bindings"("workspace_id", "user_id", "resource_type", "resource_id");
CREATE UNIQUE INDEX "access_bindings_group_id_resource_type_resource_id_key" ON "access_bindings"("group_id", "resource_type", "resource_id");
CREATE INDEX "access_bindings_workspace_id_resource_type_resource_id_idx" ON "access_bindings"("workspace_id", "resource_type", "resource_id");

INSERT INTO "access_bindings" ("workspace_id", "user_id", "role", "resource_type", "resource_id")
SELECT "workspace_id", "user_id", "role", 'workspace', "workspace_id"::text FROM "workspace_members";

ALTER TABLE "workspace_members" DROP COLUMN "role";

-- A restricted repo is not reached by bindings on the workspace.
ALTER TABLE "workspace_repos" ADD COLUMN "restricted" BOOLEAN NOT NULL DEFAULT false;
