import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface GitFixtureProfile {
  workspaceDir: string;
  userDataDir: string;
}

/**
 * Git-backed seeding shared by the staleness scenarios (`s6-banners.spec.ts`)
 * and their screenshot baselines (`baselines.spec.ts`).
 *
 * `state-manager.ts`'s staleness check is real git plus a real operations
 * database (`checkRepoStaleness` shells out to `git rev-parse HEAD`,
 * `neo4jSynced.synced` reads a completed `push` operation row) — neither can be
 * hand-written JSON, which is why this seeding is code and not a fixture file.
 */

/**
 * Identity is pinned so commits are reproducible, and the developer's global
 * and system git config are routed to /dev/null: a machine with `commit.gpgsign`,
 * `core.hooksPath`, a commit template, or a `commit -m` alias would otherwise
 * make these fixture commits prompt, fail, or diverge from the run's intent.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Coredoc E2E',
  GIT_AUTHOR_EMAIL: 'e2e@coredoc.test',
  GIT_COMMITTER_NAME: 'Coredoc E2E',
  GIT_COMMITTER_EMAIL: 'e2e@coredoc.test',
};

export function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, env: GIT_ENV }).toString().trim();
}

/** Seed the cloud-member repository identity without involving a real home or network. */
export function seedMemberProvisioningRepo(launchProfile: GitFixtureProfile): void {
  const repoPath = path.join(launchProfile.workspaceDir, 'repos', 'demo-api');
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['remote', 'add', 'origin', 'https://github.com/demo/demo-api.git']);
  writeFileSync(
    path.join(launchProfile.userDataDir, 'linked-repos.json'),
    JSON.stringify(
      {
        repos: [{ workspaceId: 'ws_e2e_demo', repoName: 'demo-api', localPath: repoPath }],
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Makes `repos/demo-api` a real two-commit git repo, points the seeded parsed
 * output at the first commit (so HEAD reads one commit ahead of what was
 * "parsed"), and records a completed `push` operation in the project's SQLite
 * database so the repo also reads as synced — both are preconditions
 * `deriveWorkspaceFacts`'s `staleRepos` filter checks (`workspace-facts.ts`).
 *
 * Runs against the fixture's already-copied temp profile, before the app
 * launches.
 */
export async function seedStaleRepo(launchProfile: GitFixtureProfile): Promise<void> {
  const repoPath = path.join(launchProfile.workspaceDir, 'repos', 'demo-api');
  const parsedOutputPath = path.join(launchProfile.workspaceDir, 'coredoc-output', 'demo', 'demo-api.json');

  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'initial']);
  const parsedCommitHash = git(repoPath, ['rev-parse', 'HEAD']);
  const parsedCommitShortHash = git(repoPath, ['rev-parse', '--short', 'HEAD']);

  const parsed = JSON.parse(readFileSync(parsedOutputPath, 'utf-8'));
  parsed.git = {
    commitHash: parsedCommitHash,
    commitShortHash: parsedCommitShortHash,
    branch: 'main',
    isDirty: false,
    commitDate: new Date().toISOString(),
  };
  writeFileSync(parsedOutputPath, JSON.stringify(parsed, null, 2));

  // A second, later commit — HEAD is now one commit ahead of the "parsed"
  // revision recorded above, which is what `checkRepoStaleness` compares.
  writeFileSync(path.join(repoPath, 'NOTES.md'), 'follow-up change\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'follow-up']);

  // `getOpsTimestamps` (packages/cli/src/sdk/ops.ts) reads this DB via
  // `@coredoc/db`, the same package the main process uses — no separate schema
  // to hand-maintain.
  const { openProjectDatabase, closeProjectDatabases } = await import('@coredoc/db');
  const db = await openProjectDatabase(launchProfile.workspaceDir, 'demo');
  const operationId = await db.operations.startOperation('demo', 'demo-api', 'push');
  await db.operations.completeOperation(operationId);
  // Closes this writer connection before Electron (a separate process) opens
  // its own — SQLite would otherwise contend over the same file.
  await closeProjectDatabases();
}
