import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import type { EmbeddingsOutput, ParsedRepo, RuntimeConfig, SummaryOutput } from '@coredoc/core/types';
import {
  getTransformStats,
  normalizeMetadataForParsedRepo,
  openGraphFile,
  replaceProjectLadybugGraphFile,
  transformParsedRepo,
} from '@coredoc/db';
import { buildGraphFile, type GraphFileBuildResult, type VerifiedGraphBuildComponent } from '@coredoc/db/file-builder';
import { findEmbeddingsFile, findParsedRepo, findSummariesFile, loadEmbeddings, loadSummaries } from './helpers.js';
import { resolveProjectCrossRepo, type CrossRepoResult } from './cross-repo.js';
import { compareCodeUnits } from '@coredoc/core/utils';

const LOCAL_GRAPH_VALIDATION_BUDGETS = {
  maxDbSizeBytes: 16 * 1024 * 1024 * 1024,
  bufferPoolBytes: 256 * 1024 * 1024,
  queryTimeoutMs: 30_000,
} as const;

type TransformStats = ReturnType<typeof getTransformStats>;

export interface LadybugRepositoryBuildStats extends TransformStats {
  repositoryId: string;
  repositoryName: string;
}

export interface LadybugProjectPushOptions {
  includeSummaries: boolean;
  includeEmbeddings: boolean;
  crossRepo?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
}

export interface LadybugProjectPushResult {
  graphPath?: string;
  build?: GraphFileBuildResult;
  repositories: LadybugRepositoryBuildStats[];
  resolution: CrossRepoResult | null;
  durationMs: number;
}

interface PreparedProjectRepo {
  name: string;
  key: string;
  expectedId: string;
  parsedPath: string;
}

function assertArtifactIdentity(
  kind: string,
  artifactPath: string,
  actualRepoId: string,
  actualRepoName: string,
  expected: PreparedProjectRepo,
  projectId: string,
): void {
  if (actualRepoId === expected.expectedId && actualRepoName === expected.name) return;

  const command =
    kind === 'Parsed'
      ? `coredoc parse ${expected.name} --project ${projectId}`
      : kind === 'Summary'
        ? `coredoc summarize ${expected.name} --project ${projectId}`
        : `coredoc embed ${expected.name} --project ${projectId}`;
  throw new Error(
    `${kind} artifact "${artifactPath}" belongs to repo "${actualRepoName}" (id ${actualRepoId}); ` +
      `expected project/repo "${projectId}/${expected.name}" (id ${expected.expectedId}). ` +
      `Refusing to mix project artifacts. Regenerate it with '${command}' and retry.`,
  );
}

function prepareProjectRepos(projectId: string, config: RuntimeConfig): PreparedProjectRepo[] {
  const matches = config.projects.filter((project) => project.id === projectId);
  if (matches.length === 0) throw new Error(`Project "${projectId}" not found.`);
  if (matches.length > 1) {
    throw new Error(`Project id "${projectId}" is duplicated in the config; push ownership is ambiguous.`);
  }
  const project = matches[0];
  if (project.repos.length === 0) throw new Error(`Project '${projectId}' has no repos to push.`);

  const names = new Set<string>();
  const keys = new Set<string>();
  const prepared: PreparedProjectRepo[] = [];
  for (const repo of project.repos) {
    if (names.has(repo.name)) {
      throw new Error(`Repo name "${repo.name}" is duplicated in project "${projectId}".`);
    }
    names.add(repo.name);
    const key = repo.key ?? repo.name;
    if (keys.has(key)) {
      throw new Error(`Repo key "${key}" is duplicated in project "${projectId}".`);
    }
    keys.add(key);
    const parsedPath = findParsedRepo(projectId, repo.name, config, { allowDirectPath: false });
    if (!parsedPath) {
      console.log(`  Skipping unparsed repository: ${repo.name}`);
      continue;
    }
    prepared.push({
      name: repo.name,
      key,
      expectedId: new StableIdGenerator(repo.path, key).getRepoHash(),
      parsedPath,
    });
  }

  if (prepared.length === 0) {
    throw new Error(
      `No parsed repo artifacts for project "${projectId}". Run 'coredoc parse --project ${projectId}' first; ` +
        'the existing Ladybug graph was not changed.',
    );
  }
  return prepared;
}

function readParsedRepo(prepared: PreparedProjectRepo, projectId: string): ParsedRepo {
  let parsedRepo: ParsedRepo;
  try {
    parsedRepo = JSON.parse(readFileSync(prepared.parsedPath, 'utf8')) as ParsedRepo;
  } catch (error) {
    throw new Error(
      `Parsed artifact "${prepared.parsedPath}" is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  assertArtifactIdentity('Parsed', prepared.parsedPath, parsedRepo.id, parsedRepo.name, prepared, projectId);
  return parsedRepo;
}

function applyPackageSummaries(parsedRepo: ParsedRepo, summaryOutput: SummaryOutput | null): ParsedRepo {
  if (!summaryOutput?.packageSummaries?.length) return parsedRepo;
  const purposes = new Map(summaryOutput.packageSummaries.map((summary) => [summary.packageId, summary.purpose]));
  return {
    ...parsedRepo,
    packages: parsedRepo.packages.map((pkg) =>
      purposes.has(pkg.id) ? { ...pkg, description: purposes.get(pkg.id) } : pkg,
    ),
  };
}

function printMetadataDrops(
  repoName: string,
  dropped: ReturnType<typeof normalizeMetadataForParsedRepo>['dropped'],
): void {
  if (dropped.total === 0) return;
  const { summaries, functionEmbeddings, endpointEmbeddings } = dropped;
  console.warn(
    `  ${repoName}: skipped ${dropped.total} stale entr${dropped.total === 1 ? 'y' : 'ies'} ` +
      `(${summaries} summaries, ${functionEmbeddings} function embeddings, ` +
      `${endpointEmbeddings} endpoint embeddings). Regenerate metadata when convenient.`,
  );
}

function printStats(stats: LadybugRepositoryBuildStats, verbose: boolean): void {
  console.log(`  Total nodes: ${stats.totalNodes}`);
  console.log(`  Total edges: ${stats.totalEdges}`);
  if (stats.nodesWithSummaries > 0) console.log(`  Nodes with summaries: ${stats.nodesWithSummaries}`);
  if (stats.nodesWithEmbeddings > 0) console.log(`  Nodes with embeddings: ${stats.nodesWithEmbeddings}`);
  if (!verbose) return;
  console.log('  Nodes by type:');
  for (const [type, count] of Object.entries(stats.nodesByType)) console.log(`    ${type}: ${count}`);
  console.log('  Edges by type:');
  for (const [type, count] of Object.entries(stats.edgesByType)) console.log(`    ${type}: ${count}`);
}

async function loadComponent(
  prepared: PreparedProjectRepo,
  projectId: string,
  config: RuntimeConfig,
  options: LadybugProjectPushOptions,
): Promise<VerifiedGraphBuildComponent> {
  const parsedRepo = readParsedRepo(prepared, projectId);
  console.log(`\n=== ${prepared.name} ===`);
  console.log(`Repository: ${parsedRepo.name}`);
  console.log(`  Files: ${parsedRepo.files.length}`);
  console.log(`  Functions: ${parsedRepo.functions.length}`);
  console.log(`  Classes: ${parsedRepo.classes.length}`);

  let summaryOutput: SummaryOutput | null = null;
  if (options.includeSummaries) {
    const summaryPath = findSummariesFile(projectId, prepared.name, config, prepared.parsedPath);
    if (summaryPath) {
      summaryOutput = loadSummaries(summaryPath);
      if (summaryOutput) {
        assertArtifactIdentity(
          'Summary',
          summaryPath,
          summaryOutput.repoId,
          summaryOutput.repoName,
          prepared,
          projectId,
        );
        console.log(`  Summaries: ${summaryOutput.summaries.length} loaded`);
      } else {
        console.log('  Summaries: failed to load');
      }
    } else {
      console.log('  Summaries: not found (run "coredoc summarize" to generate)');
    }
  } else {
    console.log('  Summaries: skipped (--no-summaries)');
  }

  let embeddingsOutput: EmbeddingsOutput | null = null;
  if (options.includeEmbeddings) {
    const embeddingsPath = findEmbeddingsFile(projectId, prepared.name, config, prepared.parsedPath);
    if (embeddingsPath) {
      embeddingsOutput = loadEmbeddings(embeddingsPath);
      if (embeddingsOutput) {
        assertArtifactIdentity(
          'Embeddings',
          embeddingsPath,
          embeddingsOutput.repoId,
          embeddingsOutput.repoName,
          prepared,
          projectId,
        );
        const count = (embeddingsOutput.functions?.length ?? 0) + (embeddingsOutput.endpoints?.length ?? 0);
        console.log(`  Embeddings: ${count} loaded (${embeddingsOutput.provider}/${embeddingsOutput.model})`);
      } else {
        console.log('  Embeddings: failed to load');
      }
    } else {
      console.log('  Embeddings: not found (run "coredoc embed" to generate)');
    }
  } else {
    console.log('  Embeddings: skipped (--no-embeddings)');
  }

  const normalized = normalizeMetadataForParsedRepo(parsedRepo, summaryOutput, embeddingsOutput);
  printMetadataDrops(prepared.name, normalized.dropped);
  return {
    parsedRepo: applyPackageSummaries(parsedRepo, normalized.summaryOutput),
    summaryOutput: normalized.summaryOutput,
    embeddingsOutput: normalized.embeddingsOutput,
  };
}

function componentsForProject(
  preparedRepos: PreparedProjectRepo[],
  projectId: string,
  config: RuntimeConfig,
  options: LadybugProjectPushOptions,
): AsyncGenerator<VerifiedGraphBuildComponent> {
  return (async function* () {
    for (const prepared of preparedRepos) yield await loadComponent(prepared, projectId, config, options);
  })();
}

function orderedStats(
  preparedRepos: PreparedProjectRepo[],
  statsByName: Map<string, LadybugRepositoryBuildStats>,
): LadybugRepositoryBuildStats[] {
  return preparedRepos.map((prepared) => {
    const stats = statsByName.get(prepared.name);
    if (!stats) throw new Error(`Ladybug build produced no transform statistics for repo "${prepared.name}"`);
    return stats;
  });
}

async function validateCandidate(candidatePath: string, preparedRepos: PreparedProjectRepo[]): Promise<void> {
  const handle = await openGraphFile({ path: candidatePath, budgets: LOCAL_GRAPH_VALIDATION_BUDGETS });
  try {
    const actual = (await handle.repository.listAllRepositories())
      .map(({ hash, name }) => `${hash}:${name}`)
      .sort(compareCodeUnits);
    const expected = preparedRepos.map(({ expectedId, name }) => `${expectedId}:${name}`).sort(compareCodeUnits);
    if (actual.length !== expected.length || actual.some((identity, index) => identity !== expected[index])) {
      throw new Error(
        `Built Ladybug graph repository set does not match parsed inputs: expected [${expected.join(', ')}], ` +
          `got [${actual.join(', ')}]`,
      );
    }
  } finally {
    await handle.close();
  }
}

export async function runLadybugProjectPush(
  projectId: string,
  config: RuntimeConfig,
  options: LadybugProjectPushOptions,
): Promise<LadybugProjectPushResult> {
  const startedAt = Date.now();
  const preparedRepos = prepareProjectRepos(projectId, config);
  const statsByName = new Map<string, LadybugRepositoryBuildStats>();
  let resolution: CrossRepoResult | null = null;

  console.log(`\nTransforming ${preparedRepos.length} repo(s) into a staged Ladybug graph...`);
  if (options.dryRun) {
    for await (const component of componentsForProject(preparedRepos, projectId, config, options)) {
      const transformed = transformParsedRepo(
        component.parsedRepo,
        component.summaryOutput ?? null,
        component.embeddingsOutput ?? null,
      );
      const stats: LadybugRepositoryBuildStats = {
        repositoryId: transformed.repositoryId,
        repositoryName: transformed.repositoryName,
        ...getTransformStats(transformed),
      };
      statsByName.set(stats.repositoryName, stats);
      printStats(stats, options.verbose ?? false);
    }
    console.log('\n[DRY RUN] Would rebuild and atomically replace the complete project Ladybug graph.');
    return {
      repositories: orderedStats(preparedRepos, statsByName),
      resolution,
      durationMs: Date.now() - startedAt,
    };
  }

  const replacement = await replaceProjectLadybugGraphFile(config.configDir, projectId, async (candidatePath) => {
    // Local first use may provision FTS; the shared artifact builder stays load-only for cloud/offline callers.
    // Use a separate in-memory database so provisioning never opens or mutates the published graph.
    const { LadybugDriver } = await import('@coredoc/db/ladybug');
    const bootstrap = new LadybugDriver(':memory:', {
      readOnly: false,
      initializeSchema: false,
      ftsMode: 'bootstrap',
      budgets: { bufferPoolBytes: LOCAL_GRAPH_VALIDATION_BUDGETS.bufferPoolBytes },
    });
    try {
      await bootstrap.initialize();
    } finally {
      await bootstrap.close();
    }
    const build = await buildGraphFile({
      outputPath: candidatePath,
      workDir: dirname(candidatePath),
      components: componentsForProject(preparedRepos, projectId, config, options),
      sourcePolicy: 'preserve',
      onComponentTransformed(transformed) {
        const stats: LadybugRepositoryBuildStats = {
          repositoryId: transformed.repositoryId,
          repositoryName: transformed.repositoryName,
          ...getTransformStats(transformed),
        };
        statsByName.set(stats.repositoryName, stats);
        printStats(stats, options.verbose ?? false);
      },
      beforeFinalize:
        options.crossRepo === false
          ? undefined
          : async (repository) => {
              console.log('\nResolving cross-repo calls inside the staged graph...');
              resolution = await resolveProjectCrossRepo(projectId, config, repository);
              if (!resolution || resolution.repos !== preparedRepos.length) {
                throw new Error(
                  `Cross-repo resolution loaded ${resolution?.repos ?? 0}/${preparedRepos.length} project repositories; ` +
                    'refusing to publish an incomplete Ladybug graph.',
                );
              }
              console.log(
                `  Linked ${resolution.resolved}/${resolution.resolvable} resolvable calls ` +
                  `(${(resolution.rate * 100).toFixed(1)}%; ${resolution.unresolvableExcluded} excluded as unresolvable)`,
              );
            },
    });
    await validateCandidate(candidatePath, preparedRepos);
    return build;
  });

  if (options.crossRepo === false) {
    console.log('\nSkipping cross-repo resolution (--no-cross-repo); run `coredoc link <project>` when ready.');
  }
  const build = { ...replacement.result, artifactPath: replacement.graphPath };
  console.log(
    `\nPublished complete Ladybug graph: ${build.nodeCount} nodes, ${build.edgeCount} edges, ` +
      `${(build.fileSizeBytes / (1024 * 1024)).toFixed(1)} MiB`,
  );
  return {
    graphPath: replacement.graphPath,
    build,
    repositories: orderedStats(preparedRepos, statsByName),
    resolution,
    durationMs: Date.now() - startedAt,
  };
}
