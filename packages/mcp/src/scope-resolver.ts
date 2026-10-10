/**
 * Scope Resolver Module
 *
 * Resolves workspace paths to repository scope context for MCP queries.
 * Handles matching paths to repos, extracting groups for cross-repo queries,
 * and generating repo hashes for Cypher filtering.
 */

import * as fs from 'fs';
import * as path from 'path';

import { generateRepoHash } from '@coredoc/core';
import type { RepoConfig, RuntimeConfig } from '@coredoc/core/types';
import {
  findProjectsContainingRepo,
  getAllRepos,
  repoRefKey,
  loadConfig as loadCoredocConfig,
} from '@coredoc/core/utils';
import type { ScopeContext, ScopeResolutionResult } from './types.js';
import { debug } from './debug-logger.js';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default config file name
 */
const DEFAULT_CONFIG_FILENAME = 'coredoc.config.json';

/**
 * Environment variable for config path override
 */
const CONFIG_PATH_ENV_VAR = 'MCP_CONFIG_PATH';

// Repo hash generation is single-sourced in @coredoc/core (`generateRepoHash`,
// the same function StableIdGenerator mints node-id prefixes with); re-exported
// here because it is part of this module's published surface.
export { generateRepoHash };

/**
 * Whether COREDOC_SCOPE declares a host binding. `auto` (and unset) defer to
 * cwd resolution — the server is UNBOUND; anything else (`project:X` or a
 * pinned repo) is a hard boundary. Single source for the check used by the
 * server's discovery fall-through and the topic tools' scope widening.
 */
export function isScopeBound(envScope?: string): boolean {
  return !!envScope && envScope !== 'auto';
}

/**
 * Repo hashes for a lookup whose ANSWER is by definition outside the scope: the
 * far side of a cross-repo bridge, or "which other repos declare this symbol".
 * `[]` is the all-repos convention.
 *
 * A caller-supplied `scope` narrows WHERE THE QUESTION STARTS, not where the
 * answer may live — `trace_cross_repo_call` already reads the resolved target
 * entrypoint with `[]` for exactly that reason, and a caller-side scope filter
 * is what made it report `caller repo == target repo` with a null caller. The
 * one hard boundary is a cloud workspace scope: the backing store can hold rows
 * outside the connected repos, so a workspace-resolved scope widens only to
 * `workspaceRepoHashes`, never to the whole graph.
 *
 * Deliberately NOT the same policy as `resolveMessagingQueryHashes`: that one
 * enumerates every producer/consumer SITE in the graph (an inventory), which a
 * host binding legitimately constrains. This one follows a single named edge.
 */
export function crossRepoLookupHashes(scope: ScopeContext): string[] {
  return scope.origin === 'workspace' ? (scope.workspaceRepoHashes ?? scope.repoHashes) : [];
}

/**
 * Project-qualified `project/repo` list of every configured repo, for error
 * messages. Qualified rather than bare so the names are (a) copy-pasteable
 * back as `scope` and (b) distinguishable when the same repo name exists in
 * more than one project (e.g. `demo/sample-reports` vs `test-demo/sample-reports`).
 */
function listAvailableRepoScopes(config: RuntimeConfig, projectConstraint?: string): string {
  return config.projects
    .filter((project) => !projectConstraint || project.id === projectConstraint)
    .flatMap((project) => project.repos.map((repo) => `${project.id}/${repo.name}`))
    .join(', ');
}

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Find the config file by searching up from the given path
 *
 * @param startPath - Starting path to search from
 * @returns Config file path or null if not found
 */
function findConfigFile(startPath: string): string | null {
  // First check environment variable
  const envPath = process.env[CONFIG_PATH_ENV_VAR];
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  // Search up directory tree
  let currentDir = path.resolve(startPath);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const configPath = path.join(currentDir, DEFAULT_CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Load and parse config file
 *
 * @param configPath - Path to config file
 * @returns Parsed RuntimeConfig
 */
export function loadConfig(configPath: string): RuntimeConfig {
  return loadCoredocConfig(configPath);
}

/**
 * One row of the repo→project map: the project that owns a repo name and the
 * copy-pasteable `scope` token to address it. `ambiguous` is true when the same
 * bare repo name exists in more than one project — callers MUST use `scopeToken`
 * (the qualified `project/repo` form) for those, since the bare name would be
 * rejected as ambiguous by resolveScope.
 */
export interface RepoProjectInfo {
  projectId: string;
  scopeToken: string;
  ambiguous: boolean;
}

/**
 * Build a `repoName → {projectId, scopeToken}` map from config, for tools that
 * present a discovery list of repos (e.g. describe_repository with no scope) and
 * want to qualify each entry so the agent can paste it straight back as `scope`.
 *
 * Projects are a CONFIG concept — the graph DB doesn't store repo→project
 * membership — so this is the only place the mapping is known. Returns an empty
 * map (never throws) when no config is found, so discovery still works in the
 * bootstrap / config-less case; callers fall back to the bare repo name.
 *
 * The `scopeToken` is always the qualified `project/repo` form so it round-trips
 * through resolveScope even when the name collides across projects.
 */
export function buildRepoProjectMap(configPathOverride?: string): Map<string, RepoProjectInfo> {
  const map = new Map<string, RepoProjectInfo>();
  const configPath = configPathOverride || findConfigFile(process.cwd());
  if (!configPath) return map;

  let config: RuntimeConfig;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    debug('buildRepoProjectMap', `Failed to load config: ${error}`);
    return map;
  }

  for (const project of config.projects) {
    for (const repo of project.repos) {
      // A repo name in >1 project is ambiguous as a bare scope; the qualified
      // token disambiguates. findProjectsContainingRepo is the canonical check.
      const owningProjects = findProjectsContainingRepo(config, repo.name);
      map.set(repo.name, {
        projectId: project.id,
        scopeToken: `${project.id}/${repo.name}`,
        ambiguous: owningProjects.length > 1,
      });
    }
  }
  return map;
}

// =============================================================================
// Path Matching
// =============================================================================

/**
 * Check if a workspace path is within a repo path
 *
 * @param workspacePath - Current workspace path from AI agent
 * @param repoPath - Resolved repository path
 * @returns true if workspace is within repo
 */
function isPathWithinRepo(workspacePath: string, repoPath: string): boolean {
  const normalizedWorkspace = path.resolve(workspacePath);
  const normalizedRepo = path.resolve(repoPath);

  // Check if workspace path starts with repo path
  return normalizedWorkspace.startsWith(normalizedRepo + path.sep) || normalizedWorkspace === normalizedRepo;
}

/** A matched repo together with the project id it belongs to. */
interface RepoMatch {
  repo: RepoConfig;
  projectId: string;
}

// Explicit MCP scopes may use a stable id or a human-readable project name.
// Check ids across the whole config first so a preceding project's display
// name can never shadow another project's canonical id.
function findProjectByIdentifier(projectIdentifier: string, config: RuntimeConfig) {
  return (
    config.projects.find((project) => project.id === projectIdentifier) ??
    config.projects.find((project) => project.name === projectIdentifier)
  );
}

function formatProjectIdentifier(project: { id: string; name: string }): string {
  return project.id === project.name ? project.name : `${project.name} [${project.id}]`;
}

/**
 * Find repos that match the given workspace path
 *
 * @param workspacePath - Current workspace path
 * @param config - Runtime config
 * @returns Matching repos with their project ids
 */
function findMatchingRepos(workspacePath: string, config: RuntimeConfig): RepoMatch[] {
  const matches: RepoMatch[] = [];

  for (const project of config.projects) {
    for (const repo of project.repos) {
      const repoPath = config.resolvedRepoPaths.get(repoRefKey(project.id, repo.name));
      if (repoPath && isPathWithinRepo(workspacePath, repoPath)) {
        matches.push({ repo, projectId: project.id });
      }
    }
  }

  return matches;
}

/**
 * Get all repos in the same project as the given matched repos
 *
 * @param matches - Primary repo matches (repo + projectId)
 * @param config - Runtime config
 * @returns All repos in the same projects (including originals), with projectIds
 */
function getProjectReposForMatched(matches: RepoMatch[], config: RuntimeConfig): RepoMatch[] {
  const projectIds = new Set<string>(matches.map((m) => m.projectId));

  if (projectIds.size === 0) {
    return matches;
  }

  const allProjectRepos: RepoMatch[] = [];
  for (const projectId of projectIds) {
    const project = config.projects.find((p) => p.id === projectId);
    if (project) {
      for (const repo of project.repos) {
        allProjectRepos.push({ repo, projectId });
      }
    }
  }
  return allProjectRepos;
}

// =============================================================================
// Main Scope Resolution
// =============================================================================

/**
 * Resolve a project identifier to scope context
 * Used when COREDOC_SCOPE starts with "project:" prefix
 *
 * @param projectIdentifier - Project id or legacy display name
 * @param config - Runtime config
 * @returns ScopeResolutionResult with scope context for all repos in the project
 */
function resolveByProject(projectIdentifier: string, config: RuntimeConfig): ScopeResolutionResult {
  debug('resolveByProject', `projectIdentifier=${projectIdentifier}`);

  const project = findProjectByIdentifier(projectIdentifier, config);

  if (!project || project.repos.length === 0) {
    debug('resolveByProject', `No repos found in project: ${projectIdentifier}`);
    return {
      success: false,
      error: `No repos found in project: ${projectIdentifier}. Available projects: ${config.projects.map(formatProjectIdentifier).join(', ')}`,
      scope: createEmptyScope(config.configDir),
    };
  }

  // Generate hashes for all repos in the project
  const repoHashes: string[] = [];
  const resolvedRepos: string[] = [];

  for (const repo of project.repos) {
    const repoPath = config.resolvedRepoPaths.get(repoRefKey(project.id, repo.name));
    if (repoPath) {
      const hash = generateRepoHash(repo.key ?? repo.name);
      repoHashes.push(hash);
      resolvedRepos.push(repo.name);
      debug('resolveByProject', `Repo: ${repo.name} -> key=${repo.key ?? repo.name} -> hash=${hash}`);
    }
  }

  const scope: ScopeContext = {
    currentPath: config.configDir,
    configDir: config.configDir,
    resolvedRepos,
    repoHashes,
    project: project.name,
    projectId: project.id,
    crossRepoEnabled: true,
  };

  debug(
    'resolveByProject',
    `Final scope: repos=[${resolvedRepos.join(',')}], hashes=[${repoHashes.join(',')}], project=${project.name}, projectId=${project.id}`,
  );

  return {
    success: true,
    scope,
  };
}

/**
 * Resolve scope to a specific repo by name (for narrowing within a project)
 *
 * @param repoName - Repository name to resolve
 * @param projectIdentifier - Project id or legacy display name
 * @param config - Runtime config
 * @returns ScopeResolutionResult with scope context for the single repo
 */
function resolveRepoByName(repoName: string, projectIdentifier: string, config: RuntimeConfig): ScopeResolutionResult {
  debug('resolveRepoByName', `repoName=${repoName}, projectIdentifier=${projectIdentifier}`);

  const project = findProjectByIdentifier(projectIdentifier, config);
  if (!project) {
    debug('resolveRepoByName', `Project not found: ${projectIdentifier}`);
    return {
      success: false,
      error: `Project not found: ${projectIdentifier}. Available projects: ${config.projects.map(formatProjectIdentifier).join(', ')}`,
      scope: createEmptyScope(config.configDir),
    };
  }

  const projectId = project.id;
  const repo = project.repos.find((candidate) => candidate.name === repoName);
  if (!repo) {
    debug('resolveRepoByName', `Repo not found: ${repoName}`);
    return {
      success: false,
      error: `Repo not found: ${repoName}. Available repos: ${project.repos.map((candidate) => candidate.name).join(', ')}`,
      scope: createEmptyScope(config.configDir),
    };
  }

  const repoPath = config.resolvedRepoPaths.get(repoRefKey(projectId, repo.name));
  if (!repoPath) {
    debug('resolveRepoByName', `Repo path not resolved: ${repoName}`);
    return {
      success: false,
      error: `Repo path not resolved: ${repoName}`,
      scope: createEmptyScope(config.configDir),
    };
  }

  const hash = generateRepoHash(repo.key ?? repo.name);
  debug('resolveRepoByName', `Repo: ${repo.name} -> key=${repo.key ?? repo.name} -> hash=${hash}`);

  const scope: ScopeContext = {
    currentPath: repoPath,
    configDir: config.configDir,
    resolvedRepos: [repo.name],
    repoHashes: [hash],
    project: project.name,
    projectId,
    crossRepoEnabled: false, // Narrowed to single repo, no cross-repo
  };

  debug(
    'resolveRepoByName',
    `Final scope: repo=${repo.name}, hash=${hash}, project=${project.name}, projectId=${projectId}`,
  );

  return {
    success: true,
    scope,
  };
}

/**
 * Options for {@link resolveScope}.
 */
interface ResolveScopeOptions {
  configPath?: string;
  includeCrossRepo?: boolean;
  /**
   * Stable project id the server is bound to via `COREDOC_SCOPE=project:X`.
   * Acts as a HARD boundary: a bare repo name is resolved within this project
   * first, and any resolution that lands in a DIFFERENT project is rejected by
   * {@link resolveScope}. Omitted for unbound, path-based resolution.
   */
  projectConstraint?: string;
}

/**
 * Canonicalize a project-boundary token to the unique project id it names.
 *
 * The boundary token (from `COREDOC_SCOPE=project:X`) must be a stable project
 * id. Display names remain valid for explicit caller-supplied scopes, but are
 * deliberately not accepted as a security boundary.
 *
 * SECURITY: this exists so the fence never matches the raw token against a
 * resolved scope's id OR display name. That cross-field comparison is
 * collision-prone — if project B's display name equals project A's id, a scope
 * that lands in B (projectId=B) would satisfy a `name === token` check and
 * escape A's boundary. `id` is unique; `name` is not, so id-to-id is the only
 * collision-free comparison.
 *
 * Returns undefined when config can't be found/loaded or the token names no
 * project — the fence treats that as out-of-bounds (fail closed).
 *
 * @param boundaryToken - The stable project id in projectConstraint
 * @param configStartPath - Where to start the config search (mirrors the inner resolver)
 * @param configPathOverride - Explicit config path, when the caller supplied one
 */
function resolveBoundProjectId(
  boundaryToken: string,
  configStartPath: string,
  configPathOverride?: string,
): string | undefined {
  const configPath = configPathOverride || findConfigFile(configStartPath);
  if (!configPath) return undefined;
  try {
    const config = loadConfig(configPath);
    return config.projects.find((project) => project.id === boundaryToken)?.id;
  } catch (error) {
    debug('resolveBoundProjectId', `Could not resolve boundary "${boundaryToken}": ${error}`);
    return undefined;
  }
}

/**
 * Resolve a workspace path to a scope context, enforcing the project boundary.
 *
 * When `projectConstraint` is set (the host bound this server to a project via
 * `COREDOC_SCOPE=project:X`), the resolved scope MUST stay inside that project.
 * The inner resolver treats the constraint only as a narrowing *preference* — it
 * will otherwise resolve a repo in ANOTHER project addressed by bare name,
 * `project/repo`, `project:` prefix, or filesystem path. This wrapper rejects
 * any such out-of-project result so a caller cannot reach cross-project code
 * intelligence the host meant to isolate. Fail-closed: an out-of-project scope
 * is an error, never a silent widen.
 *
 * @param workspacePath - Current workspace path from AI agent, or "project:NAME" for project-level scope
 * @param options - Resolution options
 * @returns ScopeResolutionResult with scope context or error
 */
export function resolveScope(workspacePath: string, options: ResolveScopeOptions = {}): ScopeResolutionResult {
  const result = resolveScopeUnfenced(workspacePath, options);

  const { projectConstraint } = options;
  if (projectConstraint && result.success) {
    // Enforce the boundary by project IDENTITY, not by the raw token. The token
    // is a stable project id, so resolve it by id only and require the resolved
    // scope to carry that exact id. Comparing against project *name* is unsafe:
    // a project whose display name collides with another project's id would let
    // a scope escape the boundary.
    const configStartPath = workspacePath.startsWith('project:') ? process.cwd() : workspacePath;
    const boundProjectId = resolveBoundProjectId(projectConstraint, configStartPath, options.configPath);
    const withinBound = boundProjectId !== undefined && result.scope.projectId === boundProjectId;
    if (!withinBound) {
      const landed = result.scope.project ?? result.scope.projectId ?? 'unknown';
      debug(
        'resolveScope',
        `Boundary violation: "${workspacePath}" -> project "${landed}" (id=${result.scope.projectId ?? 'none'}) != bound "${projectConstraint}" (id=${boundProjectId ?? 'unresolved'})`,
      );
      return {
        success: false,
        error: `Scope "${workspacePath}" resolves to project "${landed}", outside the bound project "${projectConstraint}". This server is scoped to "${projectConstraint}" — pass a repo inside it, or omit scope to use the whole project.`,
        scope: createEmptyScope(workspacePath),
      };
    }
  }

  return result;
}

/**
 * Inner resolver — see {@link resolveScope} for the enforced public entry point.
 * Resolves by project reference, `project/repo` form, bare name, or filesystem
 * path WITHOUT enforcing the project boundary.
 */
function resolveScopeUnfenced(workspacePath: string, options: ResolveScopeOptions = {}): ScopeResolutionResult {
  const { includeCrossRepo = false, projectConstraint } = options;
  debug(
    'resolveScope',
    `workspacePath=${workspacePath}, includeCrossRepo=${includeCrossRepo}, projectConstraint=${projectConstraint}`,
  );

  try {
    // Check if this is a project reference (e.g., "project:my-project")
    if (workspacePath.startsWith('project:')) {
      const projectName = workspacePath.slice(8);
      debug('resolveScope', `Detected project reference: ${projectName}`);

      // Find and load config - use cwd as fallback for config search
      const configPath = options.configPath || findConfigFile(process.cwd());
      if (!configPath) {
        return {
          success: false,
          error: `Could not find ${DEFAULT_CONFIG_FILENAME}. Set MCP_CONFIG_PATH environment variable to specify config location.`,
          scope: createEmptyScope(workspacePath),
        };
      }

      const config = loadConfig(configPath);
      return resolveByProject(projectName, config);
    }

    // Find and load config
    const configPath = options.configPath || findConfigFile(workspacePath);
    if (!configPath) {
      debug('resolveScope', 'No config file found');
      return {
        success: false,
        error: `Could not find ${DEFAULT_CONFIG_FILENAME} in path hierarchy. Set MCP_CONFIG_PATH environment variable to specify config location.`,
        scope: createEmptyScope(workspacePath),
      };
    }

    debug('resolveScope', `Found config at: ${configPath}`);
    const config = loadConfig(configPath);

    // Explicit "<project>/<repo>" form. Agents frequently address a repo this
    // way — it mirrors how describe_repository lists repos under a project and
    // reads like a natural qualified name. We only treat it as project/repo
    // when the first segment names a real project AND the second names a repo
    // inside it; otherwise we fall through to path resolution so genuine
    // relative paths like "src/foo" still work. This disambiguates the case
    // where the same repo name exists in multiple projects (which the
    // bare-name and trailing-segment fallbacks below reject as ambiguous).
    if (!workspacePath.startsWith('.') && !path.isAbsolute(workspacePath)) {
      const slashParts = workspacePath.split('/');
      if (slashParts.length === 2 && slashParts[0] && slashParts[1]) {
        const [projectIdentifier, repoName] = slashParts as [string, string];
        const proj = findProjectByIdentifier(projectIdentifier, config);
        if (proj?.repos.some((r) => r.name === repoName)) {
          debug('resolveScope', `Detected project/repo form: ${projectIdentifier}/${repoName}`);
          return resolveRepoByName(repoName, projectIdentifier, config);
        }
      }
    }

    // Bare-name lookup: if the agent passed a string like "server-api" (no
    // path separator, no leading dot), treat it as a repo-name lookup against
    // the config — NOT a path. Without this, path.resolve() makes it
    // cwd-relative, and isPathWithinRepo's prefix check then matches it
    // against whatever repo currently owns cwd. Net effect: scope="anything"
    // silently resolves to the cwd's repo.
    const looksLikeBareName =
      !workspacePath.includes(path.sep) &&
      !workspacePath.includes('/') &&
      !workspacePath.startsWith('.') &&
      !workspacePath.startsWith('project:');
    if (looksLikeBareName) {
      // Prefer the bound project. When the server is scoped to a project
      // (COREDOC_SCOPE=project:X), a bare repo name resolves within THAT
      // project first — matching exactly what describe_repository lists — and
      // only widens to a global lookup when the repo isn't in the bound
      // project. This removes the contradiction where describe_repository
      // (project-bounded) advertised a bare name that the global resolver then
      // rejected as cross-project ambiguous (e.g. `sample-reports` exists in
      // demo, test-demo, and ssss). Pure narrowing — it never resolves a name
      // the global path wouldn't, so no scope leaks across the boundary.
      if (projectConstraint) {
        const boundProject = config.projects.find((project) => project.id === projectConstraint);
        if (boundProject?.repos.some((r) => r.name === workspacePath)) {
          debug('resolveScope', `Bare name "${workspacePath}" resolved within bound project "${projectConstraint}"`);
          return resolveRepoByName(workspacePath, projectConstraint, config);
        }
      }

      const byName = findProjectsContainingRepo(config, workspacePath);
      if (byName.length === 0) {
        const allReposList = getAllRepos(config);
        debug(
          'resolveScope',
          `Bare-name "${workspacePath}" unknown. Available: ${allReposList.map((r) => r.name).join(', ')}`,
        );
        return {
          success: false,
          error: `Unknown scope "${workspacePath}". Available repos (pass one of these as scope): ${listAvailableRepoScopes(config, projectConstraint)}`,
          scope: createEmptyScope(workspacePath),
        };
      }
      if (byName.length > 1) {
        const refs = byName.map((p) => `${p.id}/${workspacePath}`).join(', ');
        return {
          success: false,
          error: `Scope "${workspacePath}" is ambiguous: ${refs}. Pass project:<id> or a path instead.`,
          scope: createEmptyScope(workspacePath),
        };
      }
      const proj = byName[0]!;
      const repo = proj.repos.find((r) => r.name === workspacePath)!;
      const allMatches = includeCrossRepo
        ? proj.repos.map((r) => ({ repo: r, projectId: proj.id }))
        : [{ repo, projectId: proj.id }];
      const repoHashes: string[] = [];
      const resolvedRepos: string[] = [];
      for (const { repo: r } of allMatches) {
        const hash = generateRepoHash(r.key ?? r.name);
        repoHashes.push(hash);
        resolvedRepos.push(r.name);
      }
      const scope: ScopeContext = {
        currentPath: workspacePath,
        configDir: config.configDir,
        resolvedRepos,
        repoHashes,
        project: proj.name,
        projectId: proj.id,
        crossRepoEnabled: includeCrossRepo && allMatches.length > 1,
      };
      return { success: true, scope };
    }

    // Find repos matching workspace path
    const matchedMatches = findMatchingRepos(workspacePath, config);
    debug('resolveScope', `Matched repos: ${matchedMatches.map((m) => m.repo.name).join(', ') || 'none'}`);

    if (matchedMatches.length === 0) {
      // Fall back to trying to match by repo name in path
      const pathParts = workspacePath.split(path.sep);
      const possibleRepoName = pathParts[pathParts.length - 1];
      const matchingProjects = findProjectsContainingRepo(config, possibleRepoName);

      if (matchingProjects.length === 1) {
        const fallbackProject = matchingProjects[0];
        const repoByName = fallbackProject.repos.find((r) => r.name === possibleRepoName)!;
        debug('resolveScope', `Fallback match by name: ${repoByName.name} in project ${fallbackProject.id}`);
        matchedMatches.push({ repo: repoByName, projectId: fallbackProject.id });
      } else if (matchingProjects.length > 1) {
        const refs = matchingProjects.map((p) => `${p.id}/${possibleRepoName}`).join(', ');
        debug('resolveScope', `Fallback match ambiguous: ${refs}`);
        return {
          success: false,
          error: `Workspace path '${workspacePath}' resolves to repo "${possibleRepoName}", which is ambiguous: ${refs}.`,
          scope: createEmptyScope(workspacePath),
        };
      } else {
        const allReposList = getAllRepos(config);
        debug('resolveScope', `No match found. Available: ${allReposList.map((r) => r.name).join(', ')}`);
        const available = listAvailableRepoScopes(config, projectConstraint);
        const error = workspacePath.startsWith('@')
          ? `Scope "${workspacePath}" looks like a package coordinate, but scope accepts repository names/paths. Pass a repository scope, then narrow with the tool's path or fileHint argument. Available repo scopes: ${available}`
          : `Workspace path '${workspacePath}' does not match any configured repository. Available repos (pass one of these as scope): ${available}`;
        return {
          success: false,
          error,
          scope: createEmptyScope(workspacePath),
        };
      }
    }

    // Determine cross-repo scope
    const allMatches = includeCrossRepo ? getProjectReposForMatched(matchedMatches, config) : matchedMatches;

    // Extract project name and id from first matched repo
    const firstMatch = matchedMatches[0];
    const matchedProject = config.projects.find((p) => p.id === firstMatch?.projectId);
    const project = matchedProject?.name;
    const projectId = firstMatch?.projectId;

    // Generate repo hashes
    const repoHashes: string[] = [];
    const resolvedRepos: string[] = [];

    for (const { repo, projectId: pid } of allMatches) {
      const repoPath = config.resolvedRepoPaths.get(repoRefKey(pid, repo.name));
      if (repoPath) {
        const hash = generateRepoHash(repo.key ?? repo.name);
        repoHashes.push(hash);
        resolvedRepos.push(repo.name);
        debug('resolveScope', `Repo: ${repo.name} -> key=${repo.key ?? repo.name} -> hash=${hash}`);
      }
    }

    const scope: ScopeContext = {
      currentPath: path.resolve(workspacePath),
      configDir: config.configDir,
      resolvedRepos,
      repoHashes,
      project,
      projectId,
      crossRepoEnabled: includeCrossRepo && allMatches.length > matchedMatches.length,
    };

    debug(
      'resolveScope',
      `Final scope: repos=[${resolvedRepos.join(',')}], hashes=[${repoHashes.join(',')}], project=${project}, projectId=${projectId}`,
    );

    return {
      success: true,
      scope,
    };
  } catch (error) {
    debug('resolveScope', `Error: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      scope: createEmptyScope(workspacePath),
    };
  }
}

/**
 * Create an empty scope context for error cases
 */
function createEmptyScope(currentPath: string): ScopeContext {
  return {
    currentPath: path.resolve(currentPath),
    resolvedRepos: [],
    repoHashes: [],
    crossRepoEnabled: false,
  };
}

// =============================================================================
// Scope Context Helpers
// =============================================================================

/**
 * Resolve the "vantage" repo — the repo the MCP server is physically running
 * from — to a `{ name, hash }` pair within an already-resolved scope.
 *
 * The vantage is a HINT (where the agent is standing), distinct from the scope
 * BOUNDARY (what it can see). Under `COREDOC_SCOPE=project:X` the scope spans
 * every repo in the project, but single-origin tools (e.g.
 * list_service_dependencies — "what does THIS repo call") need to know which
 * repo is "this" one rather than guessing `scope.resolvedRepos[0]` (just the
 * first repo in config order).
 *
 * Resolution is PURE against the ScopeContext — no config load — so it works in
 * the cloud MCP / config-less case too. The signal is matched, in order:
 *   1. by repo name (what describe_repository advertises; the dominant input),
 *   2. by the qualified `project/repo` / `project:repo` form (the repo segment),
 *   3. by repo hash, covering a `repo.key` passed directly when key !== name
 *      (the stored hash is `generateRepoHash(key ?? name)`).
 *
 * Fail-soft by design: returns `undefined` when the signal is empty or names a
 * repo OUTSIDE the resolved scope. A vantage may only narrow within the
 * boundary, never cross it, and a stale `COREDOC_CURRENT_REPO` is ignored rather
 * than breaking the query.
 *
 * @param scope - Already-resolved scope context (resolvedRepos[i] ↔ repoHashes[i])
 * @param signal - Vantage signal (repo name, key, or qualified form)
 * @returns The matched repo's name and hash, or undefined when out of scope
 */
export function resolveVantageRepo(scope: ScopeContext, signal: string): { name: string; hash: string } | undefined {
  const trimmed = signal.trim();
  if (!trimmed) return undefined;

  // Accept bare `repo`, qualified `project/repo`, and `project:repo` forms —
  // take the repo segment after the last separator.
  const bareName = trimmed.split(/[/:]/).pop() ?? trimmed;

  // 1 + 2. Match by repo name.
  const nameIdx = scope.resolvedRepos.indexOf(bareName);
  if (nameIdx !== -1) {
    return { name: scope.resolvedRepos[nameIdx]!, hash: scope.repoHashes[nameIdx]! };
  }

  // 3. Match by hash — covers a `repo.key` passed directly (key !== name).
  const hashIdx = scope.repoHashes.indexOf(generateRepoHash(bareName));
  if (hashIdx !== -1) {
    return { name: scope.resolvedRepos[hashIdx]!, hash: scope.repoHashes[hashIdx]! };
  }

  return undefined;
}

// =============================================================================
// Exported Types
// =============================================================================

export type { ScopeContext, ScopeResolutionResult } from './types.js';
