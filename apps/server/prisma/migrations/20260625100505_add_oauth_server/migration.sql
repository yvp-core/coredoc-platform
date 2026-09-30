/*
  Warnings:

  - You are about to drop the column `workos_membership_id` on the `workspace_members` table. All the data in the column will be lost.
  - You are about to drop the column `workos_org_id` on the `workspaces` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "workspace_members_workos_membership_id_key";

-- DropIndex
DROP INDEX "workspaces_workos_org_id_key";

-- AlterTable
ALTER TABLE "workspace_members" DROP COLUMN "workos_membership_id",
ADD COLUMN     "github_login" TEXT,
ADD COLUMN     "pending" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "workspaces" DROP COLUMN "workos_org_id";

-- CreateTable
CREATE TABLE "oauth_clients" (
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "client_name" TEXT NOT NULL,
    "client_description" TEXT,
    "logo_uri" TEXT,
    "client_uri" TEXT,
    "developer_name" TEXT,
    "developer_email" TEXT,
    "redirect_uris" TEXT[],
    "grant_types" TEXT[],
    "response_types" TEXT[],
    "token_endpoint_auth_method" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "code" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "code_challenge_method" TEXT NOT NULL,
    "expires_at" BIGINT NOT NULL,
    "resource" TEXT,
    "scope" TEXT,
    "used_at" TIMESTAMPTZ,
    "user_profile_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "oauth_sessions" (
    "sessionId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "clientId" TEXT,
    "redirectUri" TEXT,
    "codeChallenge" TEXT,
    "codeChallengeMethod" TEXT,
    "oauthState" TEXT,
    "resource" TEXT,
    "scope" TEXT,
    "expiresAt" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_sessions_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "oauth_user_profiles" (
    "profile_id" TEXT NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "raw" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "oauth_user_profiles_pkey" PRIMARY KEY ("profile_id")
);

-- CreateIndex
CREATE INDEX "oauth_user_profiles_provider_user_id_idx" ON "oauth_user_profiles"("provider_user_id");
