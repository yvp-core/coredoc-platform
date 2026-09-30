CREATE TABLE "capture_provisioning" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "host" VARCHAR(32) NOT NULL,
    "target_key" VARCHAR(256) NOT NULL,
    "repository_key" VARCHAR(256),
    "state" VARCHAR(16) NOT NULL,
    "configured_at" TIMESTAMPTZ,
    "disabled_at" TIMESTAMPTZ,
    "reported_at" TIMESTAMPTZ NOT NULL,
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(32),

    CONSTRAINT "capture_provisioning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "capture_provisioning_workspace_id_actor_id_host_target_key_key"
ON "capture_provisioning"("workspace_id", "actor_id", "host", "target_key");

ALTER TABLE "capture_provisioning"
ADD CONSTRAINT "capture_provisioning_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
