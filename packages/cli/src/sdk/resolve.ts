/**
 * SDK Resolve — programmatic API for cross-repo edge resolution.
 *
 * Walks the workspace-scoped output layout and resolves cross-repo edges
 * for the union of all parsed repos (optionally filtered to a subset of
 * project ids).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeConfig, ParsedRepo } from '@coredoc/core/types';
import { linkWorkspace, sliceParsedRepoByTarget } from '@coredoc/core';
import { parsedRepoFile, workspaceOutputDir } from '@coredoc/core/utils';
import { EventName, track } from '@coredoc/core/telemetry';

export interface ResolveOptions {
  config: RuntimeConfig;
  /** Optional list of project ids to filter to. Empty means all projects. */
  projectIds?: string[];
  /** Output file path (relative to configDir or absolute). Defaults to 'resolved-graph.json'. */
  output?: string;
  pretty?: boolean;
  verbose?: boolean;
}

export interface ResolveResult {
  outputPath: string;
  stats: {
    totalRepos: number;
    totalExternalCalls: number;
    resolvedEdges: number;
    unresolvedCalls: number;
  };
}

interface LoadedRepo {
  projectId: string;
  parsed: ParsedRepo;
}

/**
 * Walk `outputDir/{projectId}/{repoName}.json` for every repo configured
 * under each project. Returns the loaded ParsedRepos along with the projectId
 * each one came from.
 */
function loadParsedReposForResolve(config: RuntimeConfig, verbose: boolean): LoadedRepo[] {
  const outputDir = config.resolvedOutputDir;
  if (!fs.existsSync(outputDir)) {
    throw new Error(`Output directory not found: ${outputDir}. Run 'coredoc parse' first.`);
  }

  const loaded: LoadedRepo[] = [];

  for (const project of config.projects) {
    const projectDir = workspaceOutputDir(outputDir, project.id);
    if (!fs.existsSync(projectDir)) continue;

    for (const repo of project.repos) {
      const filePath = parsedRepoFile(outputDir, project.id, repo.name);
      if (!fs.existsSync(filePath)) {
        if (verbose) {
          console.warn(`  Skipping ${project.id}/${repo.name}: not parsed yet`);
        }
        continue;
      }
      try {
        const parsed: ParsedRepo = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!parsed.externalCalls) parsed.externalCalls = [];
        loaded.push({ projectId: project.id, parsed });
        if (verbose) {
          console.log(`  Loaded: ${project.id}/${parsed.name} (${parsed.externalCalls.length} external calls)`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`  Warning: Could not load ${filePath}: ${message}`);
      }
    }
  }

  if (loaded.length === 0) {
    throw new Error(`No parsed repo files found under ${outputDir}. Run 'coredoc parse' first.`);
  }

  return loaded;
}

/**
 * Resolve cross-repo edges across all (or filtered) projects.
 *
 * @throws Error if the output directory is missing or if no parsed repos are found.
 */
export function runResolveCore(options: ResolveOptions): ResolveResult {
  const { config } = options;
  const verbose = options.verbose ?? false;
  const projectFilter = new Set(options.projectIds ?? []);

  // P1.T3: resolve is synchronous and NOT trackOperation-wrapped, so the
  // resolve_completed funnel event is attached directly here, timed with a
  // Date.now() delta. It fires only on success (below the throwing loaders).
  const startedAt = Date.now();

  console.log('\nCross-Repo Resolver');
  console.log('===================\n');

  if (projectFilter.size > 0) {
    console.log(`Filtering by projects: ${[...projectFilter].join(', ')}\n`);
  }

  const allLoaded = loadParsedReposForResolve(config, verbose);

  const filtered = projectFilter.size > 0 ? allLoaded.filter((entry) => projectFilter.has(entry.projectId)) : allLoaded;

  if (projectFilter.size > 0 && filtered.length === 0) {
    const availableProjects = config.projects.map((p) => p.id);
    throw new Error(
      `No repos found in projects '${[...projectFilter].join(', ')}'. Available projects: ${availableProjects.join(', ') || 'none'}`,
    );
  }

  const repos = filtered.map((entry) => entry.parsed);
  const projectByRepoId = new Map(filtered.map((entry) => [entry.parsed.id, entry.projectId]));

  // Map repo name → httpPrefix for prefix-aware entrypoint indexing.
  const repoPrefixes: Record<string, string> = {};
  for (const proj of config.projects) {
    for (const r of proj.repos) {
      if (r.httpPrefix) repoPrefixes[r.name] = r.httpPrefix;
    }
  }

  console.log('Resolving cross-repo edges...');
  const linkResult = linkWorkspace(
    repos.flatMap((repo) => sliceParsedRepoByTarget(repo, [], repoPrefixes[repo.name]).map((slice) => slice.repoLike)),
  );

  const totalExternalCalls = repos.reduce((sum, r) => sum + r.externalCalls.length, 0);
  const stats = {
    totalRepos: repos.length,
    totalExternalCalls,
    resolvedEdges: linkResult.edges.length,
    unresolvedCalls: totalExternalCalls - linkResult.edges.length,
  };

  const serializable = {
    projects: projectFilter.size > 0 ? [...projectFilter] : null,
    repos: repos.map((r) => ({
      id: r.id,
      name: r.name,
      project: projectByRepoId.get(r.id) ?? null,
    })),
    crossRepoEdges: linkResult.edges,
    packageImportEdges: linkResult.packageImportEdges ?? [],
    unresolved: linkResult.unresolved,
    stats,
  };

  const outputPath = path.resolve(config.configDir, options.output ?? 'resolved-graph.json');
  const jsonContent = options.pretty === false ? JSON.stringify(serializable) : JSON.stringify(serializable, null, 2);
  fs.writeFileSync(outputPath, jsonContent);

  console.log(`\n  Total external calls: ${stats.totalExternalCalls}`);
  console.log(`  Resolved edges: ${stats.resolvedEdges}`);
  console.log(`  Unresolved calls: ${stats.unresolvedCalls}`);
  console.log(`\n  Output: ${outputPath}\n`);

  // `edges_resolved` maps to the real `resolvedEdges` field.
  track(EventName.ResolveCompleted, { edges_resolved: stats.resolvedEdges, duration_ms: Date.now() - startedAt });

  return { outputPath, stats };
}
