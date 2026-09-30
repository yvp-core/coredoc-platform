/*
  Warnings:

  - You are about to drop the column `repo_hash` on the `workspace_repos` table. All the data in the column will be lost.

*/
-- repo_hash stored a hash-of-hash: connectRepo derived sha256(repoKey)[:12] from a
-- repoKey that is itself already the repo hash (the StableIdGenerator prefix on every
-- graph node). The value was never read — the MCP scope resolver joins Turso graph
-- nodes on repo_key, not repo_hash (see workspace-scope-resolver.ts). Dropping it.
-- AlterTable
ALTER TABLE "workspace_repos" DROP COLUMN "repo_hash";
