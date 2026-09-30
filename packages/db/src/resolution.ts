/**
 * Cross-Repo Resolution Bridge
 *
 * Persists the workspace linker's LinkResult (from @coredoc/core `linkWorkspace`)
 * into the graph as RESOLVES_TO edges. Pure persistence — resolution already ran
 * in the linker. Idempotent: stale RESOLVES_TO edges for affected repos are wiped
 * first, then the linker's end-edges are written and `resolvedTargetId` on
 * external_call nodes is reconciled (set for resolved calls, cleared for the rest).
 */

import type { LinkResult } from '@coredoc/core';
import { EdgeType } from './types.js';
import type { IGraphRepository, GraphEdge } from './types.js';
import { compareCodeUnits } from '@coredoc/core/utils';

type PersistableLinkResult = LinkResult & {
  packageImportEdges?: Array<LinkResult['edges'][number] & { createdBy: 'cross-repo-linker' }>;
};

export type LinkResultMutationRepository = Pick<
  IGraphRepository,
  'deleteEdgesByType' | 'updateResolvedTargetIds' | 'clearResolvedTargetIds'
> & {
  pushEdges(
    edges: GraphEdge[],
    options?: {
      /** Existing relationship types that can conflict with this trusted batch. */
      collisionTypes: readonly EdgeType[];
    },
  ): Promise<number>;
};

export interface PersistLinkResult {
  /** Number of protocol RESOLVES_TO edges written (existing return semantics). */
  crossRepoEdgesPushed: number;
  /** Number of package-import RESOLVES_TO edges written. */
  packageImportEdgesPushed: number;
}

/**
 * Minimal repo shape needed for stale-clearing: the repo id (for the
 * RESOLVES_TO wipe scope) and the full set of external-call ids (so calls the
 * linker did NOT resolve get their `resolvedTargetId` cleared).
 */
export interface PersistRepoRef {
  id: string;
  name: string;
  externalCalls: { id: string }[];
}

export async function persistLinkResult(
  repository: LinkResultMutationRepository,
  repos: readonly PersistRepoRef[],
  result: PersistableLinkResult,
  signal?: AbortSignal,
): Promise<PersistLinkResult> {
  signal?.throwIfAborted();
  // Wipe stale RESOLVES_TO edges for affected repos — always, even when the
  // linker produced zero edges, so newly-unresolvable calls drop their edges.
  const affectedRepoIds = [...new Set(repos.map((r) => r.id))].sort();
  await repository.deleteEdgesByType(EdgeType.ResolvesTo, affectedRepoIds);
  signal?.throwIfAborted();

  // The linker already namespaced each edge id; write it straight through.
  // GraphEdge.createdBy remains 'ai' because every cross-repo link is inferred.
  // Package-import provenance is retained in properties without broadening the
  // graph storage contract.
  const sortedProtocolEdges = [...result.edges].sort((left, right) => compareCodeUnits(left.id, right.id));
  const sortedPackageImportEdges = [...(result.packageImportEdges ?? [])].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  const sortedEdges = [...sortedProtocolEdges, ...sortedPackageImportEdges].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  const graphEdges: GraphEdge[] = sortedEdges.map((e) => ({
    id: e.id,
    sourceId: e.sourceId,
    targetId: e.targetId,
    type: EdgeType.ResolvesTo,
    confidence: e.confidence,
    createdBy: 'ai',
    properties:
      'createdBy' in e && e.createdBy === 'cross-repo-linker'
        ? { ...e.properties, createdBy: e.createdBy }
        : e.properties,
  }));

  if (graphEdges.length > 0) {
    await repository.pushEdges(graphEdges, { collisionTypes: [EdgeType.ResolvesTo] });
    signal?.throwIfAborted();
  }

  // Reconcile resolvedTargetId: set for resolved calls, clear for everything else.
  const resolvedCallIds = new Set(sortedProtocolEdges.map((e) => e.sourceId));

  if (sortedProtocolEdges.length > 0) {
    const updates = new Map<string, string>();
    for (const e of sortedProtocolEdges) updates.set(e.sourceId, e.targetId);
    await repository.updateResolvedTargetIds(updates);
    signal?.throwIfAborted();
  }

  const unresolvedCallIds: string[] = [];
  for (const repo of repos) {
    for (const call of repo.externalCalls) {
      if (!resolvedCallIds.has(call.id)) unresolvedCallIds.push(call.id);
    }
  }
  const uniqueUnresolvedCallIds = [...new Set(unresolvedCallIds)].sort();
  if (uniqueUnresolvedCallIds.length > 0) {
    await repository.clearResolvedTargetIds(uniqueUnresolvedCallIds);
    signal?.throwIfAborted();
  }

  return {
    crossRepoEdgesPushed: sortedProtocolEdges.length,
    packageImportEdgesPushed: sortedPackageImportEdges.length,
  };
}
