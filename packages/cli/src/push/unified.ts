/**
 * Unified Push Command
 *
 * Pushes parsed repository data to the configured database backend (Neo4j, SQLite, or Ladybug).
 * Uses the database abstraction layer for backend-agnostic operations.
 */

import * as fs from 'fs';
import { StableIdGenerator } from '@coredoc/core';
import type { ParsedRepo } from '@coredoc/core/types';
import type { RuntimeConfig } from '@coredoc/core/types';
import type { SummaryOutput } from '../summarize/types.js';
import type { EmbeddingsOutput } from '../embed/types.js';
import {
  getDriver,
  getRepository,
  closeDriver,
  getConfiguredBackend,
  transformParsedRepo,
  normalizeMetadataForParsedRepo,
  getTransformStats,
  createVectorIndexes as createNeo4jVectorIndexes,
  ensureGraphIndexes as ensureNeo4jGraphIndexes,
  type DatabaseBackend,
} from '@coredoc/db';
import { findParsedRepo, findSummariesFile, loadSummaries, findEmbeddingsFile, loadEmbeddings } from './helpers.js';
import { resolveProjectCrossRepo } from './cross-repo.js';
import { trackOperation } from '../operations-tracker.js';
import { bindProjectDatabase } from '../db-scope.js';

// =============================================================================
// Types
// =============================================================================

export interface UnifiedPushOptions {
  config: string;
  backend?: DatabaseBackend;
  includeSummaries?: boolean;
  summaries?: boolean;
  includeEmbeddings?: boolean;
  embeddings?: boolean;
  /** Neo4j only: create vector indexes for embedding similarity search after push. */
  createVectorIndexes?: boolean;
  /**
   * Run cross-repo resolution after pushing this repo (default true). Set false
   * to push repos fast and resolve the whole workspace once via `coredoc resolve`.
   */
  crossRepo?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  /** Compatibility alias locally: every local push already replaces the repo. */
  rebuild?: boolean;
  /** When true, skip closeDriver() in finally — caller manages the driver lifecycle. */
  skipClose?: boolean;
}

export interface UnifiedPushResult {
  success: boolean;
  backend: DatabaseBackend;
  repositoryName: string;
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  nodesWithSummaries: number;
  nodesWithEmbeddings: number;
  durationMs: number;
  errors: string[];
}

export function resolveMetadataInclusion(
  options: Pick<UnifiedPushOptions, 'includeSummaries' | 'summaries' | 'includeEmbeddings' | 'embeddings'>,
): { includeSummaries: boolean; includeEmbeddings: boolean } {
  return {
    // Commander stores `--no-summaries` as `summaries: false`. It must win
    // over the positive alias even when an older caller supplied both fields.
    includeSummaries: options.summaries === false ? false : (options.includeSummaries ?? options.summaries ?? true),
    includeEmbeddings: options.embeddings === false ? false : (options.includeEmbeddings ?? options.embeddings ?? true),
  };
}

interface ExpectedArtifactIdentity {
  projectId: string;
  repoName: string;
  repoId: string;
  regenerateCommand: string;
}

function assertArtifactIdentity(
  kind: string,
  artifactPath: string,
  actualRepoId: string,
  actualRepoName: string,
  expected: ExpectedArtifactIdentity,
): void {
  if (actualRepoId === expected.repoId && actualRepoName === expected.repoName) return;

  throw new Error(
    `${kind} artifact "${artifactPath}" belongs to repo "${actualRepoName}" (id ${actualRepoId}); ` +
      `expected project/repo "${expected.projectId}/${expected.repoName}" (id ${expected.repoId}). ` +
      `Refusing to mix project artifacts. Regenerate it with '${expected.regenerateCommand}' and retry.`,
  );
}

// =============================================================================
// Main Push Function
// =============================================================================

/**
 * Push parsed repository data to the database.
 *
 * @param repoName - Configured repository name
 * @param options - Push command options
 * @param config - Runtime configuration
 * @returns Push result with statistics
 */
// NOTE: This path pushes into a local database (SQLite or Neo4j) on the user's
// own machine. Unlike the remote push in `./remote.ts`, it intentionally does
// NOT call `stripSourceCode` — source code stays local, and removing it would
// break local MCP queries that rely on `BaseNode.sourceCode`. The strip rule
// only applies when bytes leave the client for Coredoc server infrastructure.
export async function runUnifiedPush(
  projectId: string,
  repoName: string,
  options: UnifiedPushOptions,
  config: RuntimeConfig,
): Promise<UnifiedPushResult> {
  const startTime = Date.now();
  const verbose = options.verbose ?? false;
  const dryRun = options.dryRun ?? false;
  const { includeSummaries, includeEmbeddings } = resolveMetadataInclusion(options);
  const backend = options.backend || getConfiguredBackend();

  const errors: string[] = [];

  console.log(`\nDatabase Push (${backend})`);
  console.log('='.repeat(20 + backend.length) + '\n');

  const projectMatches = config.projects.filter((project) => project.id === projectId);
  if (projectMatches.length === 0) {
    throw new Error(`Project "${projectId}" not found.`);
  }
  if (projectMatches.length > 1) {
    throw new Error(`Project id "${projectId}" is duplicated in the config; push ownership is ambiguous.`);
  }

  const selectedProject = projectMatches[0];
  const repoNameMatches = selectedProject.repos.filter((repo) => repo.name === repoName);
  if (repoNameMatches.length === 0) {
    const hint = repoName.endsWith('.json')
      ? 'Local push accepts configured repo names, not JSON paths.'
      : `Repos in this project: ${selectedProject.repos.map((repo) => repo.name).join(', ') || '(none)'}.`;
    throw new Error(`Repo "${repoName}" is not configured in project "${projectId}". ${hint}`);
  }
  if (repoNameMatches.length > 1) {
    throw new Error(
      `Repo name "${repoName}" is duplicated in project "${projectId}"; ` +
        'local commands cannot choose a unique repository.',
    );
  }
  const selectedRepo = repoNameMatches[0];

  const repoKey = selectedRepo.key ?? selectedRepo.name;
  const keyOwners = selectedProject.repos.filter((repo) => (repo.key ?? repo.name) === repoKey);
  if (keyOwners.length > 1) {
    throw new Error(
      `Repo key "${repoKey}" is duplicated in project "${projectId}" ` +
        `(${keyOwners.map((repo) => repo.name).join(', ')}). Each repo in a project must have a unique key.`,
    );
  }

  const expectedRepoId = new StableIdGenerator(selectedRepo.path, repoKey).getRepoHash();

  const parsedRepoPath = findParsedRepo(projectId, selectedRepo.name, config, { allowDirectPath: false });
  if (!parsedRepoPath) {
    throw new Error(`Parsed repo not found for: ${projectId}/${selectedRepo.name}. Run 'coredoc parse' first.`);
  }

  // Ladybug's local write path is deliberately file-oriented: rebuild available
  // parsed repos through the bulk COPY builder, validate the candidate, and
  // atomically publish it. A single giant row-by-row transaction exhausts the
  // native buffer pool on large repositories and cannot reliably roll back.
  if (backend === 'ladybug') {
    const executeLadybugPush = async (): Promise<UnifiedPushResult> => {
      try {
        const { runLadybugProjectPush } = await import('./ladybug-project.js');
        const outcome = await runLadybugProjectPush(projectId, config, {
          includeSummaries,
          includeEmbeddings,
          crossRepo: options.crossRepo,
          verbose,
          dryRun,
        });
        const stats = outcome.repositories.find(
          (candidate) => candidate.repositoryId === expectedRepoId && candidate.repositoryName === selectedRepo.name,
        );
        if (!stats) {
          throw new Error(`Staged Ladybug build omitted configured repo "${selectedRepo.name}" (${expectedRepoId}).`);
        }
        const result: UnifiedPushResult = {
          success: true,
          backend,
          repositoryName: stats.repositoryName,
          totalNodes: stats.totalNodes,
          totalEdges: outcome.repositories.length === 1 && outcome.build ? outcome.build.edgeCount : stats.totalEdges,
          nodesByType: stats.nodesByType,
          edgesByType: stats.edgesByType,
          nodesWithSummaries: stats.nodesWithSummaries,
          nodesWithEmbeddings: stats.nodesWithEmbeddings,
          durationMs: outcome.durationMs,
          errors: [],
        };
        console.log(`\nPush completed in ${result.durationMs}ms`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Push failed: ${message}`);
      }
    };

    if (dryRun) return executeLadybugPush();
    // The staged builder owns the graph file directly, but operation tracking
    // still needs the selected project's SQLite sidecar rather than an ambient
    // project from an earlier SDK/desktop call.
    await bindProjectDatabase(config, projectId);
    return trackOperation(projectId, selectedRepo.name, 'push', executeLadybugPush, buildPushMetadata);
  }

  if (verbose) {
    console.log(`Loading parsed repo from: ${parsedRepoPath}`);
  }

  const parsedRepo: ParsedRepo = JSON.parse(fs.readFileSync(parsedRepoPath, 'utf-8'));
  assertArtifactIdentity('Parsed', parsedRepoPath, parsedRepo.id, parsedRepo.name, {
    projectId,
    repoName: selectedRepo.name,
    repoId: expectedRepoId,
    regenerateCommand: `coredoc parse ${selectedRepo.name} --project ${projectId}`,
  });
  console.log(`Repository: ${parsedRepo.name}`);
  console.log(`  Files: ${parsedRepo.files.length}`);
  console.log(`  Functions: ${parsedRepo.functions.length}`);
  console.log(`  Classes: ${parsedRepo.classes.length}`);

  // Step 2: Optionally load summaries
  let summaryOutput: SummaryOutput | null = null;
  if (includeSummaries) {
    const summariesPath = findSummariesFile(projectId, parsedRepo.name, config, parsedRepoPath);
    if (summariesPath) {
      summaryOutput = loadSummaries(summariesPath);
      if (summaryOutput) {
        assertArtifactIdentity('Summary', summariesPath, summaryOutput.repoId, summaryOutput.repoName, {
          projectId,
          repoName: selectedRepo.name,
          repoId: expectedRepoId,
          regenerateCommand: `coredoc summarize ${selectedRepo.name} --project ${projectId}`,
        });
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

  // Step 3: Optionally load embeddings
  let embeddingsOutput: EmbeddingsOutput | null = null;
  if (includeEmbeddings) {
    const embeddingsPath = findEmbeddingsFile(projectId, parsedRepo.name, config, parsedRepoPath);
    if (embeddingsPath) {
      embeddingsOutput = loadEmbeddings(embeddingsPath);
      if (embeddingsOutput) {
        assertArtifactIdentity('Embeddings', embeddingsPath, embeddingsOutput.repoId, embeddingsOutput.repoName, {
          projectId,
          repoName: selectedRepo.name,
          repoId: expectedRepoId,
          regenerateCommand: `coredoc embed ${selectedRepo.name} --project ${projectId}`,
        });
        const totalEmbeddings = (embeddingsOutput.functions?.length || 0) + (embeddingsOutput.endpoints?.length || 0);
        console.log(`  Embeddings: ${totalEmbeddings} loaded (${embeddingsOutput.provider}/${embeddingsOutput.model})`);
      } else {
        console.log('  Embeddings: failed to load');
      }
    } else {
      console.log('  Embeddings: not found (run "coredoc embed" to generate)');
    }
  } else {
    console.log('  Embeddings: skipped (--no-embeddings)');
  }

  const normalizedMetadata = normalizeMetadataForParsedRepo(parsedRepo, summaryOutput, embeddingsOutput);
  summaryOutput = normalizedMetadata.summaryOutput;
  embeddingsOutput = normalizedMetadata.embeddingsOutput;
  if (normalizedMetadata.dropped.total > 0) {
    const { summaries, functionEmbeddings, endpointEmbeddings } = normalizedMetadata.dropped;
    console.warn(
      `  Metadata: skipped ${normalizedMetadata.dropped.total} stale entr${
        normalizedMetadata.dropped.total === 1 ? 'y' : 'ies'
      } (${summaries} summaries, ${functionEmbeddings} function embeddings, ` +
        `${endpointEmbeddings} endpoint embeddings). Regenerate metadata when convenient.`,
    );
  }

  // Step 4: Transform to unified graph format
  console.log('\nTransforming to graph format...');
  const transformResult = transformParsedRepo(parsedRepo, summaryOutput, embeddingsOutput);

  // Apply package summaries to package nodes (AI purpose overwrites package.json description)
  if (summaryOutput?.packageSummaries) {
    for (const pkgSummary of summaryOutput.packageSummaries) {
      const pkgNode = transformResult.nodes.find((n) => n.id === pkgSummary.packageId && n.type === 'package');
      if (pkgNode) {
        (pkgNode.properties as Record<string, unknown>).description = pkgSummary.purpose;
      }
    }
  }
  const stats = getTransformStats(transformResult);

  if (verbose) {
    console.log('  Nodes by type:');
    for (const [type, count] of Object.entries(stats.nodesByType)) {
      console.log(`    ${type}: ${count}`);
    }
    console.log('  Edges by type:');
    for (const [type, count] of Object.entries(stats.edgesByType)) {
      console.log(`    ${type}: ${count}`);
    }
  }

  console.log(`  Total nodes: ${stats.totalNodes}`);
  console.log(`  Total edges: ${stats.totalEdges}`);
  if (stats.nodesWithSummaries > 0) {
    console.log(`  Nodes with summaries: ${stats.nodesWithSummaries}`);
  }
  if (stats.nodesWithEmbeddings > 0) {
    console.log(`  Nodes with embeddings: ${stats.nodesWithEmbeddings}`);
  }

  // Step 5: Dry run or actual push
  if (dryRun) {
    console.log('\n[DRY RUN] Would push the above data to the database.');
    return {
      success: true,
      backend,
      repositoryName: parsedRepo.name,
      totalNodes: stats.totalNodes,
      totalEdges: stats.totalEdges,
      nodesByType: stats.nodesByType,
      edgesByType: stats.edgesByType,
      nodesWithSummaries: stats.nodesWithSummaries,
      nodesWithEmbeddings: stats.nodesWithEmbeddings,
      durationMs: Date.now() - startTime,
      errors: [],
    };
  }

  // Bind here, not only in the Commander wrapper: the desktop and public SDK
  // call this function directly and must land in the selected project's file.
  await bindProjectDatabase(config, projectId);

  if (backend === 'neo4j') {
    const owners = config.projects.filter((project) =>
      project.repos.some((repo) => (repo.key ?? repo.name) === repoKey),
    );
    if (owners.length > 1) {
      throw new Error(
        `Neo4j stores one shared graph, and repo key "${repoKey}" exists in multiple projects ` +
          `(${owners.map((project) => project.id).join(', ')}). Refusing a push that could overwrite another project. ` +
          'Use project-scoped SQLite, assign distinct repo keys, or run one project per Neo4j deployment.',
      );
    }
  }

  // Step 6: Initialize database and push (tracked as an operation)
  return trackOperation(
    projectId,
    parsedRepo.name,
    'push',
    async () => {
      try {
        console.log(`\nConnecting to ${backend}...`);
        await getDriver(backend); // Initialize driver
        const repository = await getRepository(backend);

        if (verbose) {
          console.log('  Connection established');
        }

        // Ensure id indexes exist before writing — without them pushNodes' MERGE
        // and pushEdges' endpoint MATCH are full label scans that make a
        // multi-repo push slow down super-linearly as the graph grows. Idempotent
        // and non-fatal (e.g. read-only role): a warning, not a failed push.
        if (backend === 'neo4j') {
          try {
            await ensureNeo4jGraphIndexes();
          } catch (err) {
            console.warn(`  Index setup warning: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Local graph state is disposable and cheap to recreate. In a
        // project-owned SQLite file it is also safe to remove an older hash for
        // the same configured repo name: changing `repo.key` rotates every node
        // id, so deleting only the new hash would leave the old generation next
        // to it. Neo4j is shared and therefore deletes by exact id only.
        const repoIdsToDelete = new Set<string>();
        if (backend === 'sqlite') {
          const existingRepos = await repository.listAllRepositories([parsedRepo.name]);
          for (const existing of existingRepos) repoIdsToDelete.add(existing.hash);
        }
        repoIdsToDelete.add(parsedRepo.id);

        if (typeof repository.applyChangeset !== 'function') {
          throw new Error(
            `Configured ${backend} backend cannot atomically replace repo "${parsedRepo.name}". ` +
              'Refusing a delete-then-insert push.',
          );
        }

        console.log(`\nAtomically replacing existing graph for repo ${parsedRepo.id}...`);
        const replacement = await repository.applyChangeset({
          repoId: parsedRepo.id,
          repoIdsToDelete: [...repoIdsToDelete],
          nodesToAdd: transformResult.nodes,
          nodesToUpdate: [],
          nodeIdsToDelete: [],
          edgeNodeIdsToWipe: [],
          edgeTypesToPreserve: [],
          edgesToInsert: transformResult.edges,
          unresolvedCalls: transformResult.unresolvedCalls,
        });

        const nodesCount = replacement.nodesAdded;
        console.log(`  Pushed ${nodesCount} nodes`);
        const edgesCount = replacement.edgesInserted;
        console.log(`  Pushed ${edgesCount} edges`);

        // Cross-repo resolution. By default each push re-links the whole
        // workspace, but that is O(N²) across a multi-repo push (every push
        // reloads all siblings, recomputes all hops, and wipes+rewrites every
        // RESOLVES_TO edge — only the final pass matters). Pass --no-cross-repo
        // to skip it here and run `coredoc resolve <project>` once at the end.
        if (options.crossRepo !== false && projectId) {
          console.log('\nResolving cross-repo calls...');
          try {
            const m = await resolveProjectCrossRepo(projectId, config, repository);
            if (m) {
              console.log(
                `  Linked ${m.resolved}/${m.resolvable} resolvable calls ` +
                  `(${(m.rate * 100).toFixed(1)}%; ${m.unresolvableExcluded} excluded as unresolvable)`,
              );
            }
          } catch (err) {
            console.warn(`  Resolution warning: ${err instanceof Error ? err.message : err}`);
            errors.push(`Resolution: ${err instanceof Error ? err.message : err}`);
          }
        } else if (options.crossRepo === false) {
          console.log(
            '\nSkipping cross-repo resolution (--no-cross-repo); run `coredoc link <project>` after all pushes.',
          );
        }

        // Neo4j vector indexes (similarity search). Only meaningful for the Neo4j
        // backend with embeddings present; SQLite uses its own vector path.
        if (backend === 'neo4j' && options.createVectorIndexes && embeddingsOutput) {
          console.log('\nCreating Neo4j vector indexes...');
          try {
            await createNeo4jVectorIndexes(embeddingsOutput.dimensions);
            console.log(`  Vector indexes created (${embeddingsOutput.dimensions} dimensions)`);
          } catch (err) {
            console.warn(`  Vector index warning: ${err instanceof Error ? err.message : err}`);
            errors.push(`Vector indexes: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Summary
        const durationMs = Date.now() - startTime;
        console.log(`\nPush completed in ${durationMs}ms`);

        return {
          success: true,
          backend,
          repositoryName: parsedRepo.name,
          totalNodes: nodesCount,
          totalEdges: edgesCount,
          nodesByType: stats.nodesByType,
          edgesByType: stats.edgesByType,
          nodesWithSummaries: stats.nodesWithSummaries,
          nodesWithEmbeddings: stats.nodesWithEmbeddings,
          durationMs,
          errors,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        throw new Error(`Push failed: ${message}`);
      } finally {
        if (!options.skipClose) await closeDriver();
      }
    },
    buildPushMetadata,
  );
}

/**
 * Builds the `push_completed` telemetry/metadata props for the LOCAL push path
 * (P1.T3). Exported for unit testing (mirrors `buildParseScorecardProps`).
 *
 * `target` is hardcoded `'local'`: `runUnifiedPush` is the local push only —
 * cloud push (`push/remote.ts`, which strips source) is a separate, deferred
 * telemetry attach. `duration_ms` is the push's own `durationMs`.
 */
export function buildPushMetadata(result: UnifiedPushResult): Record<string, unknown> {
  return {
    backend: result.backend,
    totalNodes: result.totalNodes,
    totalEdges: result.totalEdges,
    target: 'local',
    duration_ms: result.durationMs,
  };
}
