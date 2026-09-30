/**
 * describe_repository Tool Handler
 *
 * Returns codebase summary: language, framework, file/function counts, entrypoint types, and connected services.
 */

import { type IGraphReadRepository } from '@coredoc/db';
import { debug, debugResult } from '../../debug-logger.js';
import { formatRepoOverview, createMetadata } from '../../response-formatter.js';
import { buildRepoProjectMap } from '../../scope-resolver.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  RepoOverviewResult,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';

/**
 * Handle describe_repository tool
 */
export async function handleDescribeRepository(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  _detailLevel: DetailLevel | undefined,
  _detailConfig: DetailLevelConfig | undefined,
  repository: IGraphReadRepository,
): Promise<McpResponse<RepoOverviewResult | string>> {
  const repo = repository;

  debug('getRepoOverview', `hashes=${scope.repoHashes.join(',')}`);

  // Get repository overview from the database
  const repoInfos = scope.repoHashes.length > 0 ? await repo.getRepoOverview(scope.repoHashes) : [];

  debugResult('getRepoOverview', repoInfos.length);

  if (args.mode === 'inventory' && scope.resolvedRepos.length > 0) {
    const parsedByName = new Map(repoInfos.map((info) => [info.name, info]));
    const result: RepoOverviewResult = {
      name: scope.project ?? 'Repository inventory',
      type: 'project',
      parsedAt:
        repoInfos
          .map((info) => info.parsedAt)
          .filter(Boolean)
          .sort()
          .pop() ?? '',
      stats: { files: 0, functions: 0, classes: 0, entrypoints: 0, entities: 0 },
      frameworks: [],
      packages: [],
      entrypointsByType: {},
      repos: scope.resolvedRepos.map((name) => {
        const info = parsedByName.get(name);
        return {
          name,
          type: info?.type ?? 'unparsed',
          parsedAt: info?.parsedAt ?? '',
          fileCount: info?.fileCount ?? 0,
          functionCount: info?.functionCount ?? 0,
          classCount: info?.classCount ?? 0,
          entityCount: info?.entityCount ?? 0,
          entrypointTypes: info?.entrypointTypes ?? [],
          parsed: info !== undefined,
        };
      }),
    };
    return formatRepoOverview(result, await createMetadata(scope, format, undefined, undefined, repository));
  }

  // No scope resolved → discovery flow. Reached when the caller invokes
  // `describe_repository` with no `scope` arg and no project binding pinned
  // the cwd to a repo. Return a discovery response filtered to the current
  // project context so agents see the sibling repos they care about, not
  // every repo across every unrelated workspace ever parsed.
  if (repoInfos.length === 0) {
    const metadata = await createMetadata(scope, format, undefined, undefined, repository);
    const projectBoundary = scope.projectBoundedRepos;
    // Push the filter down to SQL when the boundary is known (defense for
    // cloud MCP workspace isolation) — falls back to the full list only in
    // the genuine bootstrap case where no project context exists.
    const parsedRepos = await repo.listAllRepositories(projectBoundary);
    // Projects live in config, not the graph — build the name→project map so
    // each discovery row carries a copy-pasteable `project/repo` scope token.
    // Empty map (config-less bootstrap) → fall back to the bare name.
    const repoProjectMap = buildRepoProjectMap();
    const discoveryRepos = parsedRepos.map((r) => {
      const projectInfo = repoProjectMap.get(r.name);
      return {
        name: r.name,
        type: r.type,
        parsedAt: r.parsedAt,
        ...(args.mode !== 'inventory' && format === 'raw' && r.summary && { summary: r.summary }),
        ...(projectInfo && { project: projectInfo.projectId, scopeToken: projectInfo.scopeToken }),
      };
    });

    if (discoveryRepos.length === 0) {
      // Two sub-cases: nothing parsed at all, or the project boundary
      // excludes everything the graph knows. Spell out which.
      const hint = projectBoundary
        ? `No parsed repositories in the current project. Project repos: ${projectBoundary.join(', ')}.`
        : 'No repositories parsed yet.';
      return {
        data: format === 'raw' ? {} : hint,
        metadata,
      } as McpResponse<RepoOverviewResult | string>;
    }

    const discovery: RepoOverviewResult = {
      name: projectBoundary
        ? `Project repositories (${discoveryRepos.length})`
        : `All parsed repositories (${discoveryRepos.length})`,
      type: 'discovery',
      parsedAt:
        discoveryRepos
          .map((r) => r.parsedAt)
          .filter(Boolean)
          .sort()
          .pop() || '',
      stats: { files: 0, functions: 0, classes: 0, entrypoints: 0, entities: 0 },
      frameworks: [],
      packages: [],
      entrypointsByType: {},
      allKnownRepos: discoveryRepos,
    };
    return formatRepoOverview(discovery, metadata);
  }

  let result: RepoOverviewResult;

  if (repoInfos.length === 1) {
    // Single repo: keep the full deep-dive response. Packages, entrypoints,
    // and stats are useful here — the user picked this repo.
    const repoInfo = repoInfos[0]!;
    const entrypoints = await repo.listEntrypoints({}, scope.repoHashes);
    const entrypointsByType: Record<string, number> = {};
    for (const ep of entrypoints) {
      entrypointsByType[ep.type] = (entrypointsByType[ep.type] || 0) + 1;
    }
    const frameworks = detectFrameworks(entrypointsByType);
    const packageInfos = await repo.getPackages(scope.repoHashes);
    const packages = packageInfos.map((p) => ({
      name: p.name,
      path: p.path,
      type: p.type,
      language: p.language,
      description: p.description,
    }));
    const stats = {
      files: repoInfo.fileCount,
      functions: repoInfo.functionCount,
      classes: repoInfo.classCount,
      entrypoints: entrypoints.length,
      entities: repoInfo.entityCount,
    };

    let repoType = repoInfo.type;
    if (!repoType || repoType === 'unknown') {
      if (packages.length > 1) {
        repoType = 'monorepo';
      } else if (entrypointsByType['http'] || entrypointsByType['graphql'] || entrypointsByType['grpc']) {
        repoType = 'backend';
      } else if (entrypointsByType['cli']) {
        repoType = 'cli';
      }
    }

    result = {
      name: repoInfo.name,
      type: repoType,
      parsedAt: repoInfo.parsedAt,
      stats,
      frameworks,
      packages,
      entrypointsByType,
      ...(format === 'raw' && repoInfo.summary && { summary: repoInfo.summary }),
      ...(repoType !== 'monorepo' && repoInfo.dataModel && { dataModel: repoInfo.dataModel }),
      ...(repoType !== 'monorepo' &&
        repoInfo.externalIntegrations && { externalIntegrations: repoInfo.externalIntegrations }),
      ...(repoInfo.gitRemoteUrl && { gitRemoteUrl: repoInfo.gitRemoteUrl }),
    };
  } else {
    // Multi-repo project view. Render each repo as a row with its OWN stats.
    // Aggregations are deliberately dropped:
    //   - summed file/function/class counts conflate one monorepo's shared
    //     packages with another repo's single service
    //   - a flat cross-repo `packages` list mixes three abstraction levels
    //     (monorepo internals like @sample/protocols, monorepo service
    //     subdirs like services/api-gateway, and repo-root services)
    // The per-repo table IS the answer; monorepo internals get a dedicated
    // section below so the abstraction levels don't collide.
    const allPackages = await repo.getPackages(scope.repoHashes);
    const packagesByRepo = new Map<string, typeof allPackages>();
    for (const pkg of allPackages) {
      if (!pkg.repoId) continue;
      const arr = packagesByRepo.get(pkg.repoId) ?? [];
      arr.push(pkg);
      packagesByRepo.set(pkg.repoId, arr);
    }

    // Map repoInfo (name-keyed) to its hash so we can look up packages.
    // generateRepoHash is the canonical name→hash, but we already have the
    // scope's repoHashes aligned to resolvedRepos by index — use that to
    // avoid re-deriving hashes here.
    const hashByName = new Map<string, string>();
    scope.resolvedRepos.forEach((n, i) => {
      const h = scope.repoHashes[i];
      if (h) hashByName.set(n, h);
    });

    const parsedByName = new Map(repoInfos.map((r) => [r.name, r] as const));
    const orderedNames = scope.resolvedRepos.length > 0 ? scope.resolvedRepos : repoInfos.map((r) => r.name);
    const repos = orderedNames.map((name) => {
      const info = parsedByName.get(name);
      if (!info) {
        // In config / scope but not in the graph yet — visible parse gap.
        return {
          name,
          type: 'unparsed',
          parsedAt: '',
          fileCount: 0,
          functionCount: 0,
          classCount: 0,
          entityCount: 0,
          entrypointTypes: [] as string[],
          parsed: false,
        };
      }

      const repoHash = hashByName.get(name);
      const pkgs = repoHash ? (packagesByRepo.get(repoHash) ?? []) : [];

      // Derive a meaningful type when the repository node didn't set one
      // ('unknown' is the default for parsers that don't tag repo type):
      //   - >1 package → it's a monorepo
      //   - exactly 1 package → adopt the package's role (backend / library / frontend / ...)
      let derivedType = info.type;
      if (!derivedType || derivedType === 'unknown') {
        if (pkgs.length > 1) {
          derivedType = 'monorepo';
        } else if (pkgs.length === 1 && pkgs[0]!.type) {
          derivedType = pkgs[0]!.type;
        }
      }

      const isMonorepo = derivedType === 'monorepo' || pkgs.length > 1;
      return {
        name: info.name,
        type: derivedType || 'unknown',
        parsedAt: info.parsedAt,
        fileCount: info.fileCount,
        functionCount: info.functionCount,
        classCount: info.classCount,
        entityCount: info.entityCount,
        entrypointTypes: info.entrypointTypes,
        ...(format === 'raw' && info.summary && { summary: info.summary }),
        parsed: true,
        ...(isMonorepo &&
          pkgs.length > 0 && {
            packages: pkgs.map((p) => ({
              name: p.name,
              path: p.path,
              ...(p.type && { type: p.type }),
              ...(p.description && { description: p.description }),
            })),
          }),
      };
    });

    const latestParsedAt =
      repoInfos
        .map((r) => r.parsedAt)
        .filter(Boolean)
        .sort()
        .pop() || '';

    result = {
      // Use just the project name; the formatter adds the "Project: " prefix
      // and the X/Y parsed annotation. Keeps the data shape clean.
      name: scope.project ?? 'Project',
      type: 'project',
      parsedAt: latestParsedAt,
      repos,
      // Stats / packages / entrypointsByType intentionally zeroed at the
      // project level — the per-repo table carries the real numbers. Keeping
      // the fields non-undefined preserves the type contract; the formatter
      // elides these sections for projects.
      stats: { files: 0, functions: 0, classes: 0, entrypoints: 0, entities: 0 },
      frameworks: [],
      packages: [],
      entrypointsByType: {},
    };
  }

  const metadata = await createMetadata(scope, format, undefined, undefined, repository);
  return formatRepoOverview(result, metadata);
}

/**
 * Detect frameworks based on codebase patterns
 */
function detectFrameworks(entrypointsByType: Record<string, number>): string[] {
  const frameworks: string[] = [];

  if ((entrypointsByType['graphql'] ?? 0) > 0) {
    frameworks.push('GraphQL');
  }
  if ((entrypointsByType['grpc'] ?? 0) > 0) {
    frameworks.push('gRPC');
  }
  return frameworks;
}
