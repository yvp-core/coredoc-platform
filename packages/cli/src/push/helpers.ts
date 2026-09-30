/**
 * Shared helper functions for push commands.
 *
 * Used by both the Neo4j push and unified push implementations.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeConfig, ParsedRepo } from '@coredoc/core/types';
import { parsedRepoFile, summariesFile, embeddingsFile } from '@coredoc/core/utils';
import type { SummaryOutput } from '../summarize/types.js';
import type { EmbeddingsOutput } from '../embed/types.js';

/**
 * Find the parsed repository JSON file for a given (projectId, repoName).
 *
 * If `repoNameOrPath` ends in `.json` and direct paths are allowed, treat it as
 * a direct path and ignore `projectId`. Otherwise look in
 * `{outputDir}/{projectId}/{repoName}.json`.
 *
 * Local pushes disable direct paths so their input is always owned by the
 * configured `(projectId, repoName)` pair. Remote upload keeps direct-path
 * support for intentionally ad-hoc artifacts.
 */
export function findParsedRepo(
  projectId: string | undefined,
  repoNameOrPath: string,
  config: RuntimeConfig,
  options: { allowDirectPath?: boolean } = {},
): string | null {
  if (options.allowDirectPath !== false && repoNameOrPath.endsWith('.json')) {
    const absolutePath = path.isAbsolute(repoNameOrPath) ? repoNameOrPath : path.resolve(process.cwd(), repoNameOrPath);
    return fs.existsSync(absolutePath) ? absolutePath : null;
  }

  if (!projectId) {
    return null;
  }

  const jsonPath = parsedRepoFile(config.resolvedOutputDir, projectId, repoNameOrPath);
  return fs.existsSync(jsonPath) ? jsonPath : null;
}

export function findSummariesFile(
  projectId: string | undefined,
  repoName: string,
  config: RuntimeConfig,
  parsedRepoPath?: string,
): string | null {
  if (!projectId && parsedRepoPath) {
    const siblingPath = path.join(path.dirname(parsedRepoPath), `${repoName}-summaries.json`);
    return fs.existsSync(siblingPath) ? siblingPath : null;
  }
  if (!projectId) {
    return null;
  }

  const summariesPath = summariesFile(config.resolvedOutputDir, projectId, repoName);
  return fs.existsSync(summariesPath) ? summariesPath : null;
}

/**
 * Load and parse a summaries file.
 *
 * @param summariesPath - Path to the summaries JSON file
 * @returns Parsed summary output, or null if loading fails
 */
export function loadSummaries(summariesPath: string): SummaryOutput | null {
  try {
    const content = fs.readFileSync(summariesPath, 'utf-8');
    return JSON.parse(content) as SummaryOutput;
  } catch {
    return null;
  }
}

export function findEmbeddingsFile(
  projectId: string | undefined,
  repoName: string,
  config: RuntimeConfig,
  parsedRepoPath?: string,
): string | null {
  if (!projectId && parsedRepoPath) {
    const siblingPath = path.join(path.dirname(parsedRepoPath), `${repoName}-embeddings.json`);
    return fs.existsSync(siblingPath) ? siblingPath : null;
  }
  if (!projectId) {
    return null;
  }

  const embeddingsPath = embeddingsFile(config.resolvedOutputDir, projectId, repoName);
  return fs.existsSync(embeddingsPath) ? embeddingsPath : null;
}

/**
 * Load and parse an embeddings file.
 *
 * @param embeddingsPath - Path to the embeddings JSON file
 * @returns Parsed embeddings output, or null if loading fails
 */
export function loadEmbeddings(embeddingsPath: string): EmbeddingsOutput | null {
  try {
    const content = fs.readFileSync(embeddingsPath, 'utf-8');
    return JSON.parse(content) as EmbeddingsOutput;
  } catch {
    return null;
  }
}

/**
 * Load all ParsedRepo JSONs for repos in the same project as the given repo.
 * Used for project-scoped cross-repo resolution.
 *
 * @param repoId - ID of the repo being pushed (for dedup/exclusion)
 * @param projectId - Project id of the repo being pushed
 * @param config - Runtime configuration with project definitions
 * @returns Array of loaded ParsedRepo objects (excludes the pushed repo by ID)
 */
export function loadProjectParsedRepos(repoId: string, projectId: string, config: RuntimeConfig): ParsedRepo[] {
  const outputDir = config.resolvedOutputDir;
  const repos: ParsedRepo[] = [];
  const seenIds = new Set<string>();

  const projectRepos = config.projects.find((project) => project.id === projectId)?.repos ?? [];

  for (const repo of projectRepos) {
    const jsonPath = parsedRepoFile(outputDir, projectId, repo.name);
    if (!fs.existsSync(jsonPath)) continue;

    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(content) as ParsedRepo;

      // Validate basic structure
      if (!parsed.id || !parsed.name || !parsed.entrypoints) continue;

      // Ensure externalCalls array exists (older JSON files may lack it)
      if (!parsed.externalCalls) parsed.externalCalls = [];

      // Deduplicate by repo ID — skip the pushed repo (caller will add in-memory version)
      if (parsed.id === repoId) continue;
      if (seenIds.has(parsed.id)) continue;
      seenIds.add(parsed.id);

      repos.push(parsed);
    } catch {
      // Skip invalid JSON files
    }
  }

  return repos;
}
