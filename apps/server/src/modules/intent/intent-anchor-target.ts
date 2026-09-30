/**
 * Server-side resolution of the graph facts an anchor carries (spec §4.6, §6.5).
 *
 * THE RULE THIS FILE EXISTS FOR: a caller supplies `repoKey` + `nodeId` and
 * nothing else. `nodeType` and `capturedVersionedId` are read out of the
 * workspace's current graph snapshot, here, every time. An anchor's
 * `capturedVersionedId` is a DRIFT BASELINE — `anchorStatus` (§6.4) is computed
 * by comparing it to what the graph says later — so a baseline taken from the
 * request instead of from the graph would make `matched` mean nothing.
 *
 * Salvaged from the archive's `packages/db/src/intent-anchor-target.ts` (same
 * four failure modes, same order), with two changes the cloud surface needs:
 * its `Error` subclass becomes the §12 structured refusal, and the repo-identity
 * gate (§6.5) runs first so an unknown key is refused with the workspace's
 * registered identities rather than as a missing node.
 *
 * PREVIEW AND COMMIT SHARE THIS PATH. There is exactly one resolver, so a
 * preview cannot promise a resolution the write would not reproduce; the only
 * difference downstream is whether a row is written.
 *
 * A WRITE NEVER DEGRADES. Read-time derivation treats an unreadable graph as
 * degradation (§6.3) because an answer without anchor evidence is still an
 * honest answer. Capturing a baseline has no such fallback: with no snapshot
 * there is nothing to observe, so this refuses with a retry instruction instead
 * of inventing one.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { IGraphReadRepository } from '@coredoc/db';
import { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { IntentGraphUnavailableCode, graphRemediation, graphUnavailableCode } from './derivation/index.js';
import { INTENT_ANCHOR_NODE_TYPES } from './intent-node-types.js';
import {
  readWorkspaceIntentRepoIdentities,
  unknownRepoKeyError,
  type WorkspaceRepoReader,
} from './intent-repo-keys.js';
import { intentStateError } from './intent-state-errors.js';

/**
 * The refusal vocabulary is `IntentErrorCode` (contract/intent-errors.ts) —
 * anchor codes included. This file once carried its own `IntentErrorCode`
 * because it did not own the state-error module; that reason is gone with the
 * enum merge, and with it the widening cast every anchor refusal used to pass
 * through. A refusal here is built exactly as a state refusal is:
 * {@link intentStateError} with the anchor code and its status.
 */

/**
 * The covered node types, as a runtime set and as the list a refusal names.
 *
 * MESSAGE BUDGET: `INTENT_PUBLIC_ERROR_LIMITS.messageChars` is 200 and the list
 * alone is ~120, so every message in this file states its RULE first and puts
 * caller-supplied identifiers last — truncation then eats an id the caller
 * already has, never the instruction it needs.
 */
const COVERED_NODE_TYPES: ReadonlySet<string> = new Set<string>(INTENT_ANCHOR_NODE_TYPES);
const COVERED_NODE_TYPE_LIST = [...INTENT_ANCHOR_NODE_TYPES].sort().join(', ');

/** One anchor to resolve, with the request path its refusal must point at. */
export interface IntentAnchorTargetRequest {
  repoKey: string;
  nodeId: string;
  /** Error path of the field that named this anchor (`items.2.anchorSuggestions.1`). */
  path: string[];
}

/** Graph-owned anchor facts. Never authored by a caller. */
export interface ResolvedAnchorTarget {
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
}

export interface IntentAnchorResolution {
  targets: ResolvedAnchorTarget[];
  /** The immutable snapshot the facts were read from; null on the legacy plane. */
  graphVersionId: string | null;
}

/** The narrowest graph capability anchor resolution needs. */
export type AnchorGraphReader = Pick<IGraphReadRepository, 'getNodeWithProperties'>;

/**
 * Resolve every requested target against one open snapshot.
 *
 * Exported for tests and for callers that already hold a leased repository; the
 * ordinary path is {@link IntentAnchorTargetService.resolve}, which owns the
 * lease and the identity gate.
 */
export async function resolveAnchorTargets(
  reader: AnchorGraphReader,
  graphKeyByDurableKey: ReadonlyMap<string, string>,
  requests: readonly IntentAnchorTargetRequest[],
): Promise<ResolvedAnchorTarget[]> {
  const targets: ResolvedAnchorTarget[] = [];
  for (const request of requests) {
    const graphRepoHash = graphKeyByDurableKey.get(request.repoKey);
    // The identity gate ran before the lease; a key missing here means the
    // registry changed underneath the request, which is still the same refusal.
    if (!graphRepoHash) {
      throw intentStateError(
        IntentErrorCode.UnknownRepoKey,
        `Repo key '${request.repoKey}' is not registered in this workspace graph.`,
        [...request.path, 'repoKey'],
      );
    }

    const found = await reader.getNodeWithProperties(request.nodeId, [graphRepoHash]);
    if (!found) {
      throw intentStateError(
        IntentErrorCode.AnchorNodeMissing,
        'An anchor records a baseline observed in the graph, and the current snapshot has no such node in repository ' +
          `'${request.repoKey}'.`,
        [...request.path, 'nodeId'],
        HttpStatus.NOT_FOUND,
      );
    }

    if (!COVERED_NODE_TYPES.has(found.node.type)) {
      throw intentStateError(
        IntentErrorCode.AnchorNodeTypeUnsupported,
        `Anchoring does not cover node type '${found.node.type}'. Covered: ${COVERED_NODE_TYPE_LIST}.`,
        [...request.path, 'nodeId'],
      );
    }

    const capturedVersionedId = found.properties.versionedId;
    if (typeof capturedVersionedId !== 'string' || capturedVersionedId.length === 0) {
      throw intentStateError(
        IntentErrorCode.AnchorVersionedIdAbsent,
        'This node carries no versioned id in the current snapshot, so anchor drift could never be detected. ' +
          'Re-parse and republish the repository, then retry.',
        [...request.path, 'nodeId'],
      );
    }

    targets.push({
      repoKey: request.repoKey,
      nodeId: request.nodeId,
      nodeType: found.node.type,
      capturedVersionedId,
    });
  }
  return targets;
}

/**
 * The lease-owning resolver: identity gate, snapshot lease, graph facts.
 *
 * The identity gate reads the control plane BEFORE the lease and outside any
 * write transaction, because a graph lease must never be held open across a
 * PostgreSQL transaction — the lease is the slow, network-bound half and the
 * transaction is the one holding row locks.
 */
@Injectable()
export class IntentAnchorTargetService {
  private readonly logger = new Logger(IntentAnchorTargetService.name);

  constructor(private readonly workspaceContext: WorkspaceMcpContextService) {}

  async resolve(
    reader: WorkspaceRepoReader,
    workspaceId: string,
    requests: readonly IntentAnchorTargetRequest[],
  ): Promise<IntentAnchorResolution> {
    if (requests.length === 0) return { targets: [], graphVersionId: null };

    const identities = await readWorkspaceIntentRepoIdentities(reader, workspaceId);
    for (const request of requests) {
      if (!identities.graphKeyByDurableKey.has(request.repoKey)) {
        throw unknownRepoKeyError(identities, [request.repoKey], [...request.path, 'repoKey']);
      }
    }

    try {
      return await this.workspaceContext.withContextByWorkspaceId(workspaceId, async (context) => {
        try {
          const targets = await resolveAnchorTargets(context.repository, identities.graphKeyByDurableKey, requests);
          return { targets, graphVersionId: context.versionId };
        } catch (error) {
          if (error instanceof IntentPublicException) throw error;
          // The snapshot opened and a query failed. Logged with its cause, so a
          // resolver bug is findable rather than laundered into "graph unavailable".
          this.logger.error(`Intent anchor resolution query failed for workspace ${workspaceId}`, error);
          throw this.graphUnavailable(IntentGraphUnavailableCode.GraphQueryFailed, requests);
        }
      });
    } catch (error) {
      if (error instanceof IntentPublicException) throw error;
      const code = graphUnavailableCode(error);
      // Not a known graph-plane failure: a bug must surface as a bug.
      if (!code) throw error;
      throw this.graphUnavailable(code, requests);
    }
  }

  private graphUnavailable(
    code: IntentGraphUnavailableCode,
    requests: readonly IntentAnchorTargetRequest[],
  ): IntentPublicException {
    return intentStateError(
      IntentErrorCode.AnchorGraphUnavailable,
      `No anchor baseline can be observed: the workspace graph could not be read (${code}). ` +
        `Retry once a snapshot is available. ${graphRemediation(code)}`,
      requests[0]?.path ?? [],
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
