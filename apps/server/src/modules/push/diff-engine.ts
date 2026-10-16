/**
 * Diff Engine
 *
 * Compares two ParsedRepo versions and produces a minimal changeset
 * for incremental graph updates.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EdgeType, NodeType, type EmbeddingsOutput, type ParsedRepo, type SummaryOutput } from '@coredoc/core/types';
import type { GraphNode, GraphEdge } from '@coredoc/db';
import { isDeepStrictEqual } from 'node:util';

// =============================================================================
// Types
// =============================================================================

export interface Changeset {
  /** ParsedRepo.id — kept for cross-repo bookkeeping callers. */
  repoId: string;
  nodesToAdd: GraphNode[];
  nodesToUpdate: GraphNode[];
  nodeIdsToDelete: string[];
  edgeNodeIdsToWipe: string[]; // Node IDs whose edges should be deleted
  /** Server-derived edge kinds that parser snapshot replacement must leave intact. */
  edgeTypesToPreserve: string[];
  edgesToInsert: GraphEdge[];
  stats: ChangesetStats;
  totalNodeCount: number;
  totalEdgeCount: number;
}

export interface ChangesetStats {
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesUnchanged: number;
  nodesAdded: number;
  nodesUpdated: number;
  nodesDeleted: number;
  edgesWiped: number;
  edgesInserted: number;
}

/** Require an explicit rebuild before deleting this fraction of the old code graph. */
export const MASS_DELETE_THRESHOLD = 0.8;

/** Ignore tiny edge sets where ordinary code edits commonly remove the last relationship. */
export const EDGE_COLLAPSE_MIN_BASELINE = 5;

function isCodeNode(node: GraphNode): boolean {
  return node.type !== NodeType.Repository && node.type !== NodeType.Package && node.type !== NodeType.File;
}

// =============================================================================
// Diff Engine
// =============================================================================

@Injectable()
export class DiffEngine {
  private readonly logger = new Logger(DiffEngine.name);

  /**
   * Compute a changeset between old and new ParsedRepo.
   *
   * The node diff runs over the COMPLETE id sets of both versions, not just
   * nodes in changed files. File-scoped diffing had a blind spot: an engine or
   * profile upgrade can rotate node ids (e.g. http entrypoint ids gaining the
   * global route prefix) while source files — and their contentHashes — stay
   * identical. A file-scoped diff then saw "nothing changed", so the old-id
   * generation was never deleted and the new-id generation never inserted,
   * permanently drifting the workspace DB from its R2 baseline. Comparing full
   * id sets costs nothing extra: both transforms are needed for edges anyway.
   *
   * @param oldParsed - Previous version from R2
   * @param newParsed - New version just uploaded
   * @returns Changeset to apply atomically to the graph database
   */
  async computeChangeset(
    oldParsed: ParsedRepo,
    newParsed: ParsedRepo,
    summaryOutput: SummaryOutput | null = null,
    embeddingsOutput: EmbeddingsOutput | null = null,
    rebuildCommand = `coredoc push ${newParsed.name} --remote --workspace-id <workspace-id> --rebuild`,
  ): Promise<Changeset> {
    // Keep the DB package lazy: packaged server builds may not include every
    // optional backend driver until the push path is actually used.
    const { transformParsedRepo } = await import('@coredoc/db');

    // Step 1: File-level diff feeds response statistics only. Correctness does
    // not depend on file hashes: engine/profile changes can alter graph nodes or
    // edges while every source file remains byte-identical.
    const oldFileMap = new Map<string, string>(); // path → contentHash
    for (const f of oldParsed.files) {
      oldFileMap.set(f.path, f.contentHash ?? '');
    }

    const newFileMap = new Map<string, string>();
    for (const f of newParsed.files) {
      newFileMap.set(f.path, f.contentHash ?? '');
    }

    const addedFiles = new Set<string>();
    const modifiedFiles = new Set<string>();
    const deletedFiles = new Set<string>();
    const unchangedFiles = new Set<string>();

    // Files in new but not in old = added
    // Files in both but different checksum = modified
    // Files in both with same checksum = unchanged
    for (const [path, checksum] of newFileMap) {
      if (!oldFileMap.has(path)) {
        addedFiles.add(path);
      } else if (oldFileMap.get(path) !== checksum) {
        modifiedFiles.add(path);
      } else {
        unchangedFiles.add(path);
      }
    }

    // Files in old but not in new = deleted
    for (const path of oldFileMap.keys()) {
      if (!newFileMap.has(path)) {
        deletedFiles.add(path);
      }
    }

    this.logger.log(
      `File diff: +${addedFiles.size} ~${modifiedFiles.size} -${deletedFiles.size} =${unchangedFiles.size}`,
    );

    // Step 2: Graph transforms used for node diffing and edge computation.
    // Attach the current metadata snapshot to nodes actually written by the
    // changeset, but compare parser structure without metadata: the supplied
    // artifacts target the NEW version and must never be applied to the old
    // parse merely to normalize the comparison.
    const fullNewResult = transformParsedRepo(newParsed, summaryOutput, embeddingsOutput);
    const structuralNewResult = transformParsedRepo(newParsed);
    const fullOldResult = transformParsedRepo(oldParsed);

    // Complete node maps of both versions. Deliberately NOT filtered to changed
    // files or node kinds — repository/package/route metadata is part of the
    // persisted graph just as much as versioned code-node content.
    const oldNodesMap = new Map<string, GraphNode>();
    for (const node of fullOldResult.nodes) {
      oldNodesMap.set(node.id, node);
    }

    const newNodesMap = new Map<string, GraphNode>();
    for (const node of fullNewResult.nodes) {
      newNodesMap.set(node.id, node);
    }
    const structuralNewNodesMap = new Map<string, GraphNode>();
    for (const node of structuralNewResult.nodes) {
      structuralNewNodesMap.set(node.id, node);
    }

    // Step 2b: compare the complete persisted payload. versionedId is useful as
    // an extraction cache key, but it does not cover every persisted field and
    // several node kinds intentionally have no versionedId at all.
    const nodesToAdd: GraphNode[] = [];
    const nodesToUpdate: GraphNode[] = [];
    const nodeIdsToDelete: string[] = [];

    for (const [id, structuralNewNode] of structuralNewNodesMap) {
      const oldNode = oldNodesMap.get(id);
      const persistedNewNode = newNodesMap.get(id)!;
      if (!oldNode) {
        nodesToAdd.push(persistedNewNode);
      } else if (!isDeepStrictEqual(oldNode, structuralNewNode)) {
        nodesToUpdate.push(persistedNewNode);
      }
    }

    // Old nodes not in new = DELETE
    for (const id of oldNodesMap.keys()) {
      if (!newNodesMap.has(id)) {
        nodeIdsToDelete.push(id);
      }
    }

    // Compare deletions to the OLD code graph. Using the new graph as the
    // denominator makes a degraded 100 -> 30 parse look harmless after the new
    // generation has already been counted.
    const deletedCodeNodes = nodeIdsToDelete.filter((id) => {
      const old = oldNodesMap.get(id);
      return old ? isCodeNode(old) : true;
    }).length;
    const newCodeNodes = fullNewResult.nodes.filter(isCodeNode).length;
    const oldCodeNodes = fullOldResult.nodes.filter(isCodeNode).length;
    const deletionRatio = oldCodeNodes > 0 ? deletedCodeNodes / oldCodeNodes : 0;

    if (deletionRatio >= MASS_DELETE_THRESHOLD) {
      throw new BadRequestException(
        `Parse artifact for "${newParsed.name}" would delete ${deletedCodeNodes}/${oldCodeNodes} previous code nodes ` +
          `and leave ${newCodeNodes}. Refusing a potentially degraded parse. Re-parse the repo, or, if this replacement ` +
          `is intentional, run \`${rebuildCommand}\`.`,
      );
    }

    // A parser/profile regression can leave every node id stable while dropping
    // one whole relationship family. The node guard above cannot see that, and
    // the edge snapshot replacement below would otherwise commit the degraded
    // artifact. Compare counts rather than edge ids so legitimate re-targeting
    // with the same cardinality remains incremental. Tiny sets are excluded:
    // removing the only call/import in a small repo is routine source evolution,
    // not a reliable collapse signal.
    const guardedOldEdges = fullOldResult.edges.filter(
      (edge) => !edge.type.startsWith('CONTAINS_') && edge.type !== EdgeType.ResolvesTo,
    );
    const guardedNewEdges = fullNewResult.edges.filter(
      (edge) => !edge.type.startsWith('CONTAINS_') && edge.type !== EdgeType.ResolvesTo,
    );
    const oldEdgesByType = new Map<string, number>();
    const newEdgesByType = new Map<string, number>();
    for (const edge of guardedOldEdges) {
      oldEdgesByType.set(edge.type, (oldEdgesByType.get(edge.type) ?? 0) + 1);
    }
    for (const edge of guardedNewEdges) {
      newEdgesByType.set(edge.type, (newEdgesByType.get(edge.type) ?? 0) + 1);
    }

    const edgeBaselines: Array<{ label: string; oldCount: number; newCount: number }> = [
      ...Array.from(oldEdgesByType, ([type, oldCount]) => ({
        label: `${type} edges`,
        oldCount,
        newCount: newEdgesByType.get(type) ?? 0,
      })),
      {
        label: 'semantic parser edges',
        oldCount: guardedOldEdges.length,
        newCount: guardedNewEdges.length,
      },
    ];
    const collapsedEdgeSet = edgeBaselines.find(({ oldCount, newCount }) => {
      if (oldCount < EDGE_COLLAPSE_MIN_BASELINE || newCount >= oldCount) return false;
      return (oldCount - newCount) / oldCount >= MASS_DELETE_THRESHOLD;
    });
    if (collapsedEdgeSet) {
      throw new BadRequestException(
        `Parse artifact for "${newParsed.name}" would reduce ${collapsedEdgeSet.label} from ` +
          `${collapsedEdgeSet.oldCount} to ${collapsedEdgeSet.newCount}. Refusing a potentially degraded edge ` +
          `snapshot. Re-parse the repo, or, if this replacement is intentional, run \`${rebuildCommand}\`.`,
      );
    }

    // Step 3: replace this repo's edge snapshot on every changed artifact.
    // This deliberately trades extra edge writes for a simple invariant: edge-
    // only engine/profile changes cannot be missed because file and node hashes
    // happened to remain stable. applyChangeset performs the wipe + insert in
    // the same transaction as the node delta.
    const affectedNodeIds = new Set<string>();
    for (const id of oldNodesMap.keys()) affectedNodeIds.add(id);
    for (const id of newNodesMap.keys()) affectedNodeIds.add(id);
    const edgesToInsert: GraphEdge[] = fullNewResult.edges;

    this.logger.log(
      `Node diff: +${nodesToAdd.length} ~${nodesToUpdate.length} -${nodeIdsToDelete.length} | ` +
        `Edges: wipe ${affectedNodeIds.size} node scope, insert ${edgesToInsert.length}`,
    );

    return {
      repoId: newParsed.id,
      nodesToAdd,
      nodesToUpdate,
      nodeIdsToDelete,
      edgeNodeIdsToWipe: [...affectedNodeIds],
      edgeTypesToPreserve: [EdgeType.ResolvesTo],
      edgesToInsert,
      totalNodeCount: fullNewResult.nodes.length,
      totalEdgeCount: fullNewResult.edges.length,
      stats: {
        filesAdded: addedFiles.size,
        filesModified: modifiedFiles.size,
        filesDeleted: deletedFiles.size,
        filesUnchanged: unchangedFiles.size,
        nodesAdded: nodesToAdd.length,
        nodesUpdated: nodesToUpdate.length,
        nodesDeleted: nodeIdsToDelete.length,
        edgesWiped: affectedNodeIds.size,
        edgesInserted: edgesToInsert.length,
      },
    };
  }
}
