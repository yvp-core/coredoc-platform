-- Normalize existing emails to lowercase so the unique index below agrees with
-- the case-insensitive invite reconciliation (placeholder userId + insensitive
-- email match). Idempotent: only rows that differ are touched.
UPDATE "workspace_members" SET "email" = lower("email") WHERE "email" <> lower("email");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_email_key" ON "workspace_members"("workspace_id", "email");
