/**
 * Cross-repo resolution (workspace linking) as a standalone step.
 *
 * Runs ONCE over a whole project (`coredoc resolve <project>`) rather than per
 * `push`. Re-linking the entire workspace on each push is O(N²) — it reloads
 * every sibling repo, recomputes all hops, and wipes+rewrites all RESOLVES_TO
 * edges — and only the final pass (with every repo's nodes present) actually
 * matters.
 *
 * One pass loads all parsed repos, runs the substrate-native linker (symbol +
 * protocol hops → RESOLVES_TO edges with per-hop chain provenance), applies the
 * optional mapper.json override, and persists via persistLinkResult.
 */

import * as fs from 'fs';
import type { RuntimeConfig } from '@coredoc/core/types';
import type { LinkResultMutationRepository } from '@coredoc/db';
import { loadProjectParsedRepos } from './helpers.js';

export interface CrossRepoResult {
  /** Number of parsed repos linked. */
  repos: number;
  resolved: number;
  resolvable: number;
  rate: number;
  unresolvableExcluded: number;
}

/**
 * Resolve cross-repo calls for an entire project and persist RESOLVES_TO edges.
 * Returns null when the project has no parsed repos on disk.
 */
export async function resolveProjectCrossRepo(
  projectId: string,
  config: RuntimeConfig,
  repository: LinkResultMutationRepository,
): Promise<CrossRepoResult | null> {
  // Empty repoId excludes nothing → load every parsed repo in the project.
  const allRepos = loadProjectParsedRepos('', projectId, config);
  if (allRepos.length === 0) return null;

  // Per-repo httpPrefix from RepoConfig → ParsedRepoLike.httpPrefix. Scoped to
  // the project being linked: repo names are unique only within a project, so
  // walking every project let a same-named sibling elsewhere overwrite the
  // entry and lend this project its prefix.
  const prefixByName = new Map<string, string>();
  for (const r of config.projects.find((p) => p.id === projectId)?.repos ?? []) {
    if (r.httpPrefix) prefixByName.set(r.name, r.httpPrefix);
  }

  const { linkWorkspace, validateMapper, mapperPathsForProject, sliceParsedRepoByTarget } = await import(
    '@coredoc/core'
  );
  // Mapper type is inferred from the validated schema result.
  type MapperT = Extract<ReturnType<typeof validateMapper>, { ok: true }>['mapper'];

  // Optional small override file (unresolvableServices / pathRewrite / aliases
  // for published-only SDKs). An invalid file is logged and ignored, not fatal.
  let override: MapperT | undefined;
  const paths = mapperPathsForProject(config.resolvedParserStorage, projectId);
  if (fs.existsSync(paths.mapperJson)) {
    try {
      const raw = JSON.parse(fs.readFileSync(paths.mapperJson, 'utf-8'));
      const validation = validateMapper(raw);
      if (validation.ok) {
        override = validation.mapper;
      } else {
        console.warn(`  mapper.json at ${paths.mapperJson} is invalid; linking without override:`);
        for (const e of validation.errors) console.warn(`    ${e.path.join('.')}: ${e.message}`);
      }
    } catch (e) {
      console.warn(
        `  mapper.json at ${paths.mapperJson} is not valid JSON; linking without override: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }

  // Slice each parsed repo into one ParsedRepoLike per profile target (multi-target
  // monorepos) so the linker resolves intra-repo ui→backend edges; single-target
  // repos and mapper-less projects yield exactly one slice — behavior-identical to
  // the pre-slicing path. Slices of one merged repo share its id (correct graph
  // placement) and carry per-target service names + prefixes.
  const repoLikes = allRepos.flatMap((r) => {
    const serviceEntries = (override?.services ?? []).filter((s) => s.repo === r.name);
    return sliceParsedRepoByTarget(r, serviceEntries, prefixByName.get(r.name)).map((slice) => slice.repoLike);
  });

  const linkResult = linkWorkspace(repoLikes, override);

  const { persistLinkResult } = await import('@coredoc/db');
  await persistLinkResult(
    repository,
    allRepos.map((r) => ({ id: r.id, name: r.name, externalCalls: r.externalCalls ?? [] })),
    linkResult,
  );

  return {
    repos: allRepos.length,
    resolved: linkResult.metrics.resolved,
    resolvable: linkResult.metrics.total - linkResult.metrics.unresolvableExcluded,
    rate: linkResult.metrics.rate,
    unresolvableExcluded: linkResult.metrics.unresolvableExcluded,
  };
}
