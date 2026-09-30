import { linkWorkspace, type LinkResult, type Mapper, type ParsedRepoLike } from '@coredoc/core';
import { persistLinkResult, type LinkResultMutationRepository, type RepoSummary } from '@coredoc/db';
import {
  parsedReposFromRepository,
  type PinnedResolverReadRepository,
  type PinnedResolverRepo,
} from './adapters/from-turso.js';
import { compareCodeUnits } from '@coredoc/core/utils';

export type { PinnedResolverReadRepository, PinnedResolverRepo } from './adapters/from-turso.js';

export type PinnedResolverRepository = PinnedResolverReadRepository & LinkResultMutationRepository;

export interface PinnedResolutionMetrics {
  resolved: number;
  total: number;
  rate: number;
  legacyEdges: number;
}

export interface PinnedResolutionComputation {
  repos: ParsedRepoLike[];
  result: LinkResult;
}

function compareById(left: { id: string }, right: { id: string }): number {
  return compareCodeUnits(left.id, right.id);
}

export async function computePinnedResolution(
  repository: PinnedResolverReadRepository,
  repos: readonly PinnedResolverRepo[],
  mapper: Mapper,
  signal?: AbortSignal,
  prefetchedRepos?: readonly RepoSummary[],
): Promise<PinnedResolutionComputation> {
  signal?.throwIfAborted();
  const parsedRepos = await parsedReposFromRepository(repository, repos, signal, prefetchedRepos);
  signal?.throwIfAborted();
  const result = linkWorkspace(parsedRepos, mapper);
  signal?.throwIfAborted();
  return {
    repos: parsedRepos,
    result: {
      ...result,
      edges: [...result.edges].sort(compareById),
      unresolved: [...result.unresolved].sort(
        (left, right) =>
          compareCodeUnits(left.sourceId, right.sourceId) ||
          compareCodeUnits(left.code, right.code) ||
          compareCodeUnits(left.detail ?? '', right.detail ?? ''),
      ),
    },
  };
}

export async function persistPinnedResolution(
  repository: LinkResultMutationRepository,
  repos: readonly ParsedRepoLike[],
  result: LinkResult,
  signal?: AbortSignal,
): Promise<PinnedResolutionMetrics> {
  signal?.throwIfAborted();
  await persistLinkResult(repository, repos, result, signal);
  signal?.throwIfAborted();
  return {
    resolved: result.metrics.resolved,
    total: result.metrics.total,
    rate: result.metrics.rate,
    legacyEdges: 0,
  };
}

export async function resolvePinnedCandidate(
  repository: PinnedResolverRepository,
  repos: readonly PinnedResolverRepo[],
  mapper: Mapper,
  signal?: AbortSignal,
): Promise<PinnedResolutionMetrics> {
  signal?.throwIfAborted();
  const computation = await computePinnedResolution(repository, repos, mapper, signal);
  signal?.throwIfAborted();
  return persistPinnedResolution(repository, computation.repos, computation.result, signal);
}
