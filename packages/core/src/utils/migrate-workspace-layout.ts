/**
 * One-shot migration from the old flat parser/output layout to the new
 * workspace-scoped layout.
 *
 * Old layout:
 *   coredoc-parsers/{repoName}/...
 *   coredoc-output/{repoName}.json, {repoName}-summaries.json, ...
 *
 * New layout:
 *   coredoc-parsers/{projectId}/{repoName}/...
 *   coredoc-output/{projectId}/{repoName}.json, ...
 *
 * Triggered from CLI/desktop/MCP loaders. Idempotent: a sentinel file
 * `.layout-version` is written under `parserStorage` after a successful run
 * and short-circuits subsequent invocations.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { assignProjectId } from './project-id.js';

export const LAYOUT_VERSION_FILE = '.layout-version';
export const CURRENT_LAYOUT_VERSION = '4';
const SESSIONS_DIR = 'coredoc-sessions';

export interface MigrationResult {
  /** True if migration was skipped because the sentinel already exists. */
  skipped: boolean;
  /** Number of project entries that had an `id` backfilled. */
  idsAssigned: number;
  /** Number of `parserStorage/{repoName}/` directories moved into `{projectId}/{repoName}/`. */
  parserDirsMoved: number;
  /** Number of output artifacts (files + dirs) moved into `{projectId}/`. */
  outputArtifactsMoved: number;
  /** Number of orphaned entries (files + dirs) deleted because no project referenced them. */
  orphansDeleted: number;
  /** Number of root-level standalone repos absorbed into the synthesized "Legacy" project. */
  standaloneReposConverted: number;
  /** Number of `coredoc-sessions/{displayName}/` directories renamed to `{projectId}/`. */
  sessionDirsMigrated: number;
  /** Non-fatal errors encountered during the migration. */
  errors: string[];
}

interface RawProject {
  id?: string;
  name: string;
  repos: Array<{ name: string; path: string }>;
}

/**
 * Looser-than-CoredocConfig shape used during migration.
 *
 * The migration runs on pre-v2 configs that may lack `id` on some or all
 * projects. Using `CoredocConfig` here would cause a TypeScript error since
 * that type requires `id: string` on every `ProjectConfig`.
 */
interface RawConfig {
  version?: string;
  projects: RawProject[];
  /** Pre-v3 root-level standalone repos. Migration absorbs them into a synthesized project. */
  repos?: Array<{ name: string; path: string }>;
  output?: { dir?: string };
  parserStorage?: string;
}

/**
 * Run the migration once. `configPath` must be an absolute path to the user's
 * `coredoc.config.json`. The function:
 *
 *  1. Loads the config.
 *  2. Backfills missing `id` on every project (idempotent).
 *  3. Walks `parserStorage/` and `outputDir/` for old-layout entries and
 *     moves or deletes them.
 *  4. Writes the sentinel.
 *
 * Errors during file moves are collected into `result.errors` and the
 * sentinel is written only when `errors` is empty.
 */
export function migrateWorkspaceLayout(configPath: string): MigrationResult {
  const result: MigrationResult = {
    skipped: false,
    idsAssigned: 0,
    parserDirsMoved: 0,
    outputArtifactsMoved: 0,
    orphansDeleted: 0,
    standaloneReposConverted: 0,
    sessionDirsMigrated: 0,
    errors: [],
  };

  if (!existsSync(configPath)) {
    return result;
  }

  const configDir = dirname(configPath);
  const raw = readFileSync(configPath, 'utf-8');
  const config: RawConfig = JSON.parse(raw);

  const parserStorage = resolve(configDir, config.parserStorage ?? './coredoc-parsers');
  const outputDir = resolve(configDir, config.output?.dir ?? './coredoc-output');
  const sentinelPath = join(parserStorage, LAYOUT_VERSION_FILE);

  // Step 1: check sentinel — if present at current version or newer, this is a true no-op.
  if (existsSync(sentinelPath)) {
    const version = Number.parseInt(readFileSync(sentinelPath, 'utf-8').trim(), 10);
    const current = Number.parseInt(CURRENT_LAYOUT_VERSION, 10);
    if (Number.isFinite(version) && version >= current) {
      result.skipped = true;
      return result;
    }
  }

  // Step 2: backfill ids (cheap and idempotent; only runs when sentinel absent).
  result.idsAssigned = backfillProjectIds(config);
  // Convert legacy standalone repos into a synthesized project before any
  // file moves below run, so that parser/output artifacts owned by those
  // repos are correctly attributed to the new project id.
  const hadReposField = config.repos !== undefined;
  result.standaloneReposConverted = convertStandaloneReposToLegacyProject(config);
  if (result.idsAssigned > 0 || result.standaloneReposConverted > 0 || hadReposField) {
    writeConfigAtomic(configPath, config);
  }

  const projectIds = new Set(config.projects.map((p) => p.id).filter((id): id is string => !!id));

  // Step 3: migrate parser storage.
  if (existsSync(parserStorage)) {
    const entries = readdirSync(parserStorage, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip already-migrated workspace folders (their name matches a known projectId).
      if (projectIds.has(entry.name)) continue;
      // Skip any reserved/internal folder (legacy `_standalone` from old migrations).
      if (entry.name.startsWith('_')) continue;

      const oldPath = join(parserStorage, entry.name);
      const owningProject = findProjectByRepoName(config, entry.name);
      if (owningProject?.id) {
        const newPath = join(parserStorage, owningProject.id, entry.name);
        try {
          mkdirSync(dirname(newPath), { recursive: true });
          renameSync(oldPath, newPath);
          result.parserDirsMoved += 1;
        } catch (err) {
          result.errors.push(`parser dir ${entry.name}: ${(err as Error).message}`);
        }
      } else {
        try {
          rmSync(oldPath, { recursive: true, force: true });
          result.orphansDeleted += 1;
        } catch (err) {
          result.errors.push(`orphan parser ${entry.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Step 4: migrate output artifacts.
  if (existsSync(outputDir)) {
    const entries = readdirSync(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip already-migrated project folders.
      if (entry.isDirectory() && projectIds.has(entry.name)) continue;
      // Skip any reserved/internal folder (legacy `_standalone` from old migrations).
      if (entry.name.startsWith('_')) continue;
      // Skip dotfiles.
      if (entry.name.startsWith('.')) continue;

      const repoName = extractRepoNameFromArtifact(entry.name);
      if (!repoName) continue;

      const owningProject = findProjectByRepoName(config, repoName);
      const oldPath = join(outputDir, entry.name);
      if (owningProject?.id) {
        const newPath = join(outputDir, owningProject.id, entry.name);
        try {
          mkdirSync(dirname(newPath), { recursive: true });
          renameSync(oldPath, newPath);
          result.outputArtifactsMoved += 1;
        } catch (err) {
          result.errors.push(`output ${entry.name}: ${(err as Error).message}`);
        }
      } else {
        try {
          rmSync(oldPath, { recursive: true, force: true });
          result.orphansDeleted += 1;
        } catch (err) {
          result.errors.push(`orphan output ${entry.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Step 4b: migrate chat session directories.
  // Sessions were historically keyed by project *display name*, not by the
  // stable `projectId`. Rename `coredoc-sessions/{DisplayName}/` to
  // `coredoc-sessions/{projectId}/` and rewrite `session.projectId` inside
  // each JSON file. Orphan dirs (no matching project) are left alone — we
  // do NOT delete chat history on a best-effort name match.
  const sessionsDir = join(configDir, SESSIONS_DIR);
  if (existsSync(sessionsDir)) {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip already-migrated folders (their name matches a known projectId).
      if (projectIds.has(entry.name)) continue;
      // Skip reserved/internal/dotfiles.
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

      const owningProject = config.projects.find((p) => !!p.id && p.name.toLowerCase() === entry.name.toLowerCase());
      if (!owningProject?.id) continue;

      const oldPath = join(sessionsDir, entry.name);
      const newPath = join(sessionsDir, owningProject.id);
      // Detect case-only renames on case-insensitive filesystems (macOS HFS+/APFS
      // default, Windows). A direct `renameSync` is a silent no-op there, so we
      // route through a temporary name.
      const isCaseOnlyRename =
        entry.name !== owningProject.id && entry.name.toLowerCase() === owningProject.id.toLowerCase();
      try {
        if (existsSync(newPath) && !isCaseOnlyRename) {
          // Target already exists — merge file by file.
          const files = readdirSync(oldPath).filter((f) => f.endsWith('.json'));
          for (const file of files) {
            renameSync(join(oldPath, file), join(newPath, file));
          }
          rmSync(oldPath, { recursive: true, force: true });
        } else if (isCaseOnlyRename) {
          const tmpPath = join(sessionsDir, `${owningProject.id}.${process.pid}.tmp`);
          renameSync(oldPath, tmpPath);
          renameSync(tmpPath, newPath);
        } else {
          renameSync(oldPath, newPath);
        }

        // Rewrite `projectId` inside each session JSON that still references the
        // old display name.
        const migratedFiles = readdirSync(newPath).filter((f) => f.endsWith('.json'));
        for (const file of migratedFiles) {
          const filePath = join(newPath, file);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(content) as { projectId?: string };
            if (parsed.projectId !== owningProject.id) {
              parsed.projectId = owningProject.id;
              writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));
            }
          } catch (err) {
            result.errors.push(`session file ${file}: ${(err as Error).message}`);
          }
        }

        result.sessionDirsMigrated += 1;
      } catch (err) {
        result.errors.push(`session dir ${entry.name}: ${(err as Error).message}`);
      }
    }
  }

  // Step 5: write sentinel only if no errors.
  if (result.errors.length === 0) {
    mkdirSync(parserStorage, { recursive: true });
    writeFileAtomic(sentinelPath, CURRENT_LAYOUT_VERSION);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function backfillProjectIds(config: RawConfig): number {
  const taken = new Set<string>(config.projects.map((p) => p.id ?? '').filter((id) => id.length > 0));
  let assigned = 0;
  for (const project of config.projects) {
    if (project.id) continue;
    const id = assignProjectId(project.name, taken);
    project.id = id;
    taken.add(id);
    assigned += 1;
  }
  return assigned;
}

/**
 * Convert root-level `config.repos` into a synthesized "Legacy" project.
 * Returns the number of standalone repos absorbed (0 if none).
 *
 * Mutates `config` in place. After this call, `config.repos` is undefined.
 */
function convertStandaloneReposToLegacyProject(config: RawConfig): number {
  const standaloneRepos = config.repos ?? [];
  if (standaloneRepos.length === 0) {
    // Field present but empty (or absent) — just drop it.
    delete config.repos;
    return 0;
  }

  const taken = new Set<string>(config.projects.map((p) => p.id ?? '').filter((id) => id.length > 0));
  const legacyId = assignProjectId('Legacy', taken);

  config.projects.push({
    id: legacyId,
    name: 'Legacy',
    repos: standaloneRepos,
  });

  delete config.repos;
  return standaloneRepos.length;
}

function writeFileAtomic(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, targetPath);
}

function writeConfigAtomic(configPath: string, config: unknown): void {
  writeFileAtomic(configPath, JSON.stringify(config, null, 2));
}

function findProjectByRepoName(config: RawConfig, repoName: string): RawProject | undefined {
  return config.projects.find((p) => p.repos.some((r) => r.name === repoName));
}

/**
 * Given an old-layout output entry name like `svc-a.json`, `svc-a-summaries.json`,
 * `svc-a-embeddings.json`, `svc-a-docs`, return the repo name (`svc-a`).
 *
 * Returns `null` for entries that do not match any of the known suffixes.
 */
function extractRepoNameFromArtifact(name: string): string | null {
  if (name.endsWith('-summaries.json')) return name.slice(0, -'-summaries.json'.length);
  if (name.endsWith('-embeddings.json')) return name.slice(0, -'-embeddings.json'.length);
  if (name.endsWith('-docs')) return name.slice(0, -'-docs'.length);
  if (name.endsWith('.json')) return name.slice(0, -'.json'.length);
  return null;
}
