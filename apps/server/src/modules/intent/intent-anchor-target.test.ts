/**
 * The anchor resolver's gates, against a stub repository (spec §4.6, §6.5).
 *
 * Two levels, deliberately separated:
 *
 * - {@link resolveAnchorTargets} — the pure per-node decision: covered type,
 *   present node, present versioned id. A stub repository lets every branch be
 *   asserted without a graph file.
 * - {@link IntentAnchorTargetService} — the identity gate and the "a write never
 *   degrades" rule around it.
 *
 * The same resolver runs against a REAL Ladybug snapshot in
 * `intent-anchor.service.test.ts`; these tests own the refusal shapes.
 */

import { NodeType } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { WorkspaceFileCacheError } from '../../database/workspace-file-cache.service.js';
import {
  WorkspaceGraphContextError,
  type WorkspaceMcpContextService,
} from '../../mcp/workspace-mcp-context.service.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { IntentAnchorTargetService, resolveAnchorTargets, type AnchorGraphReader } from './intent-anchor-target.js';

const REPO_KEY = 'github.com/acme/orders-api';
const REPO_HASH = 'aaaa1111aaaa';
const HASHES = new Map([[REPO_KEY, REPO_HASH]]);

interface StubNode {
  type: string;
  properties: Record<string, unknown>;
}

function reader(nodes: Record<string, StubNode>): AnchorGraphReader {
  return {
    async getNodeWithProperties(id: string, repoHashes: string[]) {
      const found = nodes[id];
      if (!found || !repoHashes.includes(REPO_HASH)) return null;
      return {
        node: { id, type: found.type, name: id } as never,
        properties: found.properties,
      };
    },
  };
}

function request(nodeId: string, repoKey = REPO_KEY) {
  return { repoKey, nodeId, path: ['items', '0', 'anchorSuggestions', '0'] };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(IntentPublicException);
  return (error as IntentPublicException).publicError;
}

describe('resolveAnchorTargets', () => {
  const FUNCTION_ID = `${REPO_HASH}:function:src/app/handlers.ts:handleRequest`;
  const ROUTE_ID = `${REPO_HASH}:route:src/app/routes.ts:GET /orders`;
  const nodes = {
    [FUNCTION_ID]: { type: NodeType.Function, properties: { versionedId: `${FUNCTION_ID}@abcd1234` } },
    [ROUTE_ID]: { type: NodeType.Route, properties: {} },
    [`${REPO_HASH}:function:src/app/handlers.ts:unversioned`]: { type: NodeType.Function, properties: {} },
  };

  it('reads node type and drift baseline out of the graph, never out of the request', async () => {
    await expect(resolveAnchorTargets(reader(nodes), HASHES, [request(FUNCTION_ID)])).resolves.toEqual([
      {
        repoKey: REPO_KEY,
        nodeId: FUNCTION_ID,
        nodeType: NodeType.Function,
        capturedVersionedId: `${FUNCTION_ID}@abcd1234`,
      },
    ]);
  });

  it('refuses an uncovered node type and names the covered list', async () => {
    const error = await refusal(resolveAnchorTargets(reader(nodes), HASHES, [request(ROUTE_ID)]));
    expect(error.code).toBe(IntentErrorCode.AnchorNodeTypeUnsupported);
    expect(error.message).toContain(`type '${NodeType.Route}'`);
    // The covered list, so the caller can fix it without a second round trip.
    expect(error.message).toContain(NodeType.Function);
    expect(error.message).toContain(NodeType.Entity);
    // Route and Package are SEEDABLE, never anchorable — two allowlists.
    expect(error.message).not.toContain(`${NodeType.Route},`);
    expect(error.path).toEqual(['items', '0', 'anchorSuggestions', '0', 'nodeId']);
  });

  it('refuses a node the snapshot does not contain: an anchor needs an observed baseline', async () => {
    const error = await refusal(
      resolveAnchorTargets(reader(nodes), HASHES, [request(`${REPO_HASH}:function:x.ts:no`)]),
    );
    expect(error.code).toBe(IntentErrorCode.AnchorNodeMissing);
  });

  it('refuses a covered node with no versioned id: drift could never be detected', async () => {
    const error = await refusal(
      resolveAnchorTargets(reader(nodes), HASHES, [request(`${REPO_HASH}:function:src/app/handlers.ts:unversioned`)]),
    );
    expect(error.code).toBe(IntentErrorCode.AnchorVersionedIdAbsent);
  });

  it('refuses a repo key that is not in the resolved identity map', async () => {
    const error = await refusal(
      resolveAnchorTargets(reader(nodes), HASHES, [request(FUNCTION_ID, 'github.com/acme/other')]),
    );
    expect(error.code).toBe(IntentErrorCode.UnknownRepoKey);
  });

  it('resolves a batch in request order, so callers can key results back by position', async () => {
    const second = `${REPO_HASH}:class:src/app/handlers.ts:Handler`;
    const withClass = { ...nodes, [second]: { type: NodeType.Class, properties: { versionedId: `${second}@ff` } } };
    const resolved = await resolveAnchorTargets(reader(withClass), HASHES, [request(FUNCTION_ID), request(second)]);
    expect(resolved.map((target) => target.nodeId)).toEqual([FUNCTION_ID, second]);
  });
});

describe('IntentAnchorTargetService', () => {
  const NODE_ID = `${REPO_HASH}:function:src/app/handlers.ts:handleRequest`;

  function repoReader(repos: { intentRepoKey: string | null; repoKey: string; repoName: string }[]) {
    return { workspaceRepo: { findMany: async () => repos } } as never;
  }

  function service(behaviour: { error?: unknown; nodes?: Record<string, StubNode> } = {}) {
    const workspaceContext = {
      async withContextByWorkspaceId<T>(_workspaceId: string, callback: (context: never) => Promise<T>) {
        if (behaviour.error) throw behaviour.error;
        return callback({
          repository: reader(behaviour.nodes ?? {}),
          repos: [],
          versionId: 'v-1',
          graphBackend: 'file_snapshot',
        } as never);
      },
    } as unknown as WorkspaceMcpContextService;
    return new IntentAnchorTargetService(workspaceContext);
  }

  it('enumerates the workspace identities when a repo key is unregistered', async () => {
    const error = await refusal(
      service().resolve(
        repoReader([
          { intentRepoKey: REPO_KEY, repoKey: REPO_HASH, repoName: 'orders-api' },
          { intentRepoKey: null, repoKey: 'bbbb2222bbbb', repoName: 'reports-web' },
        ]),
        'ws-1',
        [request(NODE_ID, 'github.com/acme/ghost')],
      ),
    );
    expect(error.code).toBe(IntentErrorCode.UnknownRepoKey);
    expect(error.message).toContain('github.com/acme/ghost');
    expect(error.message).toContain(`${REPO_KEY} (orders-api)`);
    // A registered repo with no durable identity yet is named as unbound, not omitted.
    expect(error.message).toContain('unbound (reports-web, bbbb2222bbbb)');
    expect(error.path).toEqual(['items', '0', 'anchorSuggestions', '0', 'repoKey']);
  });

  it('reports "none" when the workspace has no repos at all', async () => {
    const error = await refusal(service().resolve(repoReader([]), 'ws-1', [request(NODE_ID)]));
    expect(error.message).toContain('Registered identities: none.');
  });

  it('never leases the graph when there is nothing to resolve', async () => {
    const context = { withContextByWorkspaceId: () => Promise.reject(new Error('leased')) };
    const resolver = new IntentAnchorTargetService(context as unknown as WorkspaceMcpContextService);
    await expect(resolver.resolve(repoReader([]), 'ws-1', [])).resolves.toEqual({ targets: [], graphVersionId: null });
  });

  it('refuses with a retry instruction when the graph cannot be leased — a write cannot degrade', async () => {
    const error = await refusal(
      service({ error: new WorkspaceGraphContextError('ACTIVE_VERSION_MISSING', 'no version') }).resolve(
        repoReader([{ intentRepoKey: REPO_KEY, repoKey: REPO_HASH, repoName: 'orders-api' }]),
        'ws-1',
        [request(NODE_ID)],
      ),
    );
    expect(error.code).toBe(IntentErrorCode.AnchorGraphUnavailable);
    // The instruction survives the 200-char message bound; the remediation tail
    // is what truncates, which is the ordering this file's messages are built for.
    expect(error.message).toContain('Retry once a snapshot is available');
    expect(error.message).toContain('active_version_missing');
  });

  it('maps a file-cache failure to the same typed refusal', async () => {
    const error = await refusal(
      service({ error: new WorkspaceFileCacheError('DOWNLOAD_TIMEOUT', 'slow') }).resolve(
        repoReader([{ intentRepoKey: REPO_KEY, repoKey: REPO_HASH, repoName: 'orders-api' }]),
        'ws-1',
        [request(NODE_ID)],
      ),
    );
    expect(error.code).toBe(IntentErrorCode.AnchorGraphUnavailable);
  });

  it('lets a non-graph failure surface as itself: a bug must not become a degradation', async () => {
    const boom = new Error('programming error');
    await expect(
      service({ error: boom }).resolve(
        repoReader([{ intentRepoKey: REPO_KEY, repoKey: REPO_HASH, repoName: 'orders-api' }]),
        'ws-1',
        [request(NODE_ID)],
      ),
    ).rejects.toBe(boom);
  });

  it('carries the snapshot version alongside the resolved facts', async () => {
    const resolved = await service({
      nodes: { [NODE_ID]: { type: NodeType.Function, properties: { versionedId: `${NODE_ID}@1` } } },
    }).resolve(repoReader([{ intentRepoKey: REPO_KEY, repoKey: REPO_HASH, repoName: 'orders-api' }]), 'ws-1', [
      request(NODE_ID),
    ]);
    expect(resolved.graphVersionId).toBe('v-1');
    expect(resolved.targets[0]?.capturedVersionedId).toBe(`${NODE_ID}@1`);
  });
});
