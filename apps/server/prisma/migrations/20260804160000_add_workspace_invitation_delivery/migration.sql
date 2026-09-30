-- Workspace membership remains the authorization source of truth. This table
-- stores invitation lifecycle and WorkOS delivery metadata separately so the
-- existing GET /members response never exposes provider identifiers.
CREATE TABLE "workspace_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "member_user_id" TEXT NOT NULL,
    "workos_invitation_id" TEXT,
    "expires_at" TIMESTAMPTZ,
    "last_sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_invitations_workspace_id_member_user_id_key"
ON "workspace_invitations"("workspace_id", "member_user_id");

CREATE INDEX "workspace_invitations_workos_invitation_id_idx"
ON "workspace_invitations"("workos_invitation_id");

ALTER TABLE "workspace_invitations"
ADD CONSTRAINT "workspace_invitations_workspace_id_member_user_id_fkey"
FOREIGN KEY ("workspace_id", "member_user_id")
REFERENCES "workspace_members"("workspace_id", "user_id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve pending invitations created before WorkOS delivery was restored.
-- They intentionally have no provider id/expiry and surface as "email not
-- sent" until an admin uses the new resend action.
INSERT INTO "workspace_invitations" ("workspace_id", "member_user_id", "created_at")
SELECT "workspace_id", "user_id", "joined_at"
FROM "workspace_members"
WHERE "pending" = true
ON CONFLICT ("workspace_id", "member_user_id") DO NOTHING;
