/**
 * Repo reference & path-construction helpers.
 *
 * Every place in the codebase that constructs a path into `parserStorage/`
 * or `coredoc-output/` MUST use these helpers. Do not inline
 * `path.join(parserStorage, repoName, ...)` anywhere.
 *
 * A "repo ref" is the pair `(projectId, repoName)` that uniquely identifies
 * a repository instance within the local config. The same repository name
 * can appear in multiple projects with independent parsers and outputs.
 */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { CoredocConfig, ProjectConfig, RepoConfig } from '../types/config.js';

export interface RepoRef {
  projectId: string;
  repoName: string;
}

// ---------------------------------------------------------------------------
// Path construction
// ---------------------------------------------------------------------------

/** Composite key for `RuntimeConfig.resolvedRepoPaths`. */
export function repoRefKey(projectId: string, repoName: string): string {
  return `${projectId}/${repoName}`;
}

/** Absolute path to a repo's parser folder: `{parserStorage}/{projectId}/{repoName}`. */
export function parserDir(parserStorage: string, projectId: string, repoName: string): string {
  return join(parserStorage, projectId, repoName);
}

/** Absolute path to a project's output subfolder: `{outputBase}/{projectId}`. */
export function workspaceOutputDir(outputBase: string, projectId: string): string {
  return join(outputBase, projectId);
}

/** Absolute path to a parsed-repo JSON file. */
export function parsedRepoFile(outputBase: string, projectId: string, repoName: string): string {
  return join(workspaceOutputDir(outputBase, projectId), `${repoName}.json`);
}

/** Absolute path to a summaries JSON file. */
export function summariesFile(outputBase: string, projectId: string, repoName: string): string {
  return join(workspaceOutputDir(outputBase, projectId), `${repoName}-summaries.json`);
}

/** Absolute path to an embeddings JSON file. */
export function embeddingsFile(outputBase: string, projectId: string, repoName: string): string {
  return join(workspaceOutputDir(outputBase, projectId), `${repoName}-embeddings.json`);
}

/** Absolute path to a docs output directory. */
export function docsDir(outputBase: string, projectId: string, repoName: string): string {
  return join(workspaceOutputDir(outputBase, projectId), `${repoName}-docs`);
}

/**
 * Directory holding the per-project graph databases, as a sibling of the
 * workspace config. The `coredoc.db.d` name is deliberate on two counts: it
 * already matches the `coredoc.db*` .gitignore rule, and it sits OUTSIDE
 * `coredoc-output/`, whose layout migration deletes entries no project claims —
 * a live database inside a directory with an orphan sweep is a data-loss trap.
 */
const PROJECT_DB_DIRNAME = 'coredoc.db.d';

/** Mirrors `schema/coredoc.schema.json`'s project id constraint. */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Absolute path to the per-project database directory: `{configDir}/coredoc.db.d`. */
export function projectDbDir(configDir: string): string {
  return join(configDir, PROJECT_DB_DIRNAME);
}

/**
 * Absolute path to one project's graph database:
 * `{configDir}/coredoc.db.d/{projectId}.db`.
 *
 * Project ids are slugs (`^[a-z0-9][a-z0-9-]*$`, see `assignProjectId`), so
 * they are filesystem-safe by construction — but this builds a path from them,
 * so it rejects anything that is not, rather than trusting the caller.
 */
export function projectDbPath(configDir: string, projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(
      `Invalid project id "${projectId}" — expected a slug matching ${PROJECT_ID_PATTERN.source}. ` +
        `Cannot build a database path from it.`,
    );
  }
  const dbDir = projectDbDir(configDir);
  const dbDirEntry = lstatSync(dbDir, { throwIfNoEntry: false });
  if (dbDirEntry?.isSymbolicLink()) {
    throw new Error(
      `Refusing to use project database directory "${dbDir}" because it is a symbolic link. ` +
        'Replace it with a real directory inside the coredoc workspace.',
    );
  }
  const dbPath = join(dbDir, `${projectId}.db`);
  const dbEntry = lstatSync(dbPath, { throwIfNoEntry: false });
  if (dbEntry?.isSymbolicLink()) {
    throw new Error(
      `Refusing to use project database "${dbPath}" because it is a symbolic link. ` +
        'Replace it with a real file inside the coredoc workspace.',
    );
  }
  return dbPath;
}

/** libsql URL for one project's graph database. */
export function projectDbUrl(configDir: string, projectId: string): string {
  return `file:${projectDbPath(configDir, projectId)}`;
}

// ---------------------------------------------------------------------------
// Config lookup
// ---------------------------------------------------------------------------

/** Find a repo by exact `(projectId, repoName)` ref. Returns undefined if missing. */
export function findRepoByRef(config: CoredocConfig, projectId: string, repoName: string): RepoConfig | undefined {
  const project = config.projects.find((p) => p.id === projectId);
  return project?.repos.find((r) => r.name === repoName);
}

/** All projects whose `repos[]` contains the given repo name. */
export function findProjectsContainingRepo(config: CoredocConfig, repoName: string): ProjectConfig[] {
  return config.projects.filter((p) => p.repos.some((r) => r.name === repoName));
}

/**
 * Resolve a `RepoRef` from a CLI/IPC invocation.
 *
 * Precedence:
 *   1. If `projectId` is given, the `(projectId, repoName)` pair must exist exactly.
 *   2. Otherwise, if `repoName` is unique across all projects, resolve directly.
 *   3. Otherwise, throw an "ambiguous" error listing the matching `projectId/repoName` pairs.
 *
 * Throws `Error` on any failure with a user-facing message.
 */
export function resolveRepoRef(config: CoredocConfig, repoName: string, projectId?: string): RepoRef {
  if (projectId) {
    const project = config.projects.find((p) => p.id === projectId);
    if (!project) {
      const projectList = config.projects.map((p) => p.id).join(', ') || '(none)';
      throw new Error(`Project "${projectId}" not found. Available projects: ${projectList}`);
    }
    if (!project.repos.some((r) => r.name === repoName)) {
      const repoList = project.repos.map((r) => r.name).join(', ') || '(none)';
      throw new Error(`Repo "${repoName}" not found in project "${projectId}". Repos in this project: ${repoList}`);
    }
    return { projectId, repoName };
  }

  const projectMatches = findProjectsContainingRepo(config, repoName);

  if (projectMatches.length === 0) {
    const allRefs = config.projects.flatMap((p) => p.repos.map((r) => `${p.id}/${r.name}`));
    if (allRefs.length === 0) {
      throw new Error(
        `Repo "${repoName}" not found. No repos are configured — add a repo to your coredoc.config.json.`,
      );
    }
    throw new Error(`Repo "${repoName}" not found in any project. Available repos: ${allRefs.join(', ')}`);
  }

  if (projectMatches.length > 1) {
    const refs = projectMatches.map((p) => `${p.id}/${repoName}`).join(', ');
    throw new Error(
      `Repo name "${repoName}" is ambiguous — it exists in multiple projects: ${refs}. ` +
        `Use --project <id> to disambiguate.`,
    );
  }

  return { projectId: projectMatches[0].id, repoName };
}
