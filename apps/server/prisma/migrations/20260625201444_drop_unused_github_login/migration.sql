/*
  Warnings:

  - You are about to drop the column `github_login` on the `workspace_members` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "workspace_members" DROP COLUMN "github_login";
