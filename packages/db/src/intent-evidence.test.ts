import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentAuthority, IntentKind, IntentSourceKind, type CodeAnchor, type IntentItem } from '@coredoc/core';
import { NodeType, type GraphNode, type IGraphReadRepository } from './types.js';
import { closeAllDrivers, closeProjectDatabases, openProjectDatabase } from './backend-factory.js';
import {
  AnchorMismatchReason,
  AnchorStatus,
  SnapshotFreshness,
  readObservedCheckout,
  resolveIntentEvidence,
  type ObservedCheckout,
} from './intent-evidence.js';

const API_HASH = 'aaaa11112222';
const WEB_HASH = 'bbbb33334444';
const HANDLER_ID = `${API_HASH}:function:src/handler.ts:handle`;
const GRAPH_COMMIT = '1111111111111111111111111111111111111111';
const OTHER_COMMIT = '2222222222222222222222222222222222222222';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'intent-evidence-'));
});

afterEach(async () => {
  await Promise.allSettled([closeAllDrivers(), closeProjectDatabases()]);
  rmSync(workspace, { recursive: true, force: true });
});

function repoNode(hash: string, name: string, commit?: string): GraphNode {
  return {
    id: hash,
    type: NodeType.Repository,
    name,
    repoId: hash,
    filePath: '',
    properties: {
      type: 'backend',
      parsedAt: '2026-08-26T00:00:00Z',
      ...(commit ? { gitCommitHash: commit } : {}),
    },
  };
}

function codeNode(overrides: Partial<GraphNode> & Pick<GraphNode, 'id' | 'name'>): GraphNode {
  return {
    type: NodeType.Function,
    name: 'handle',
    repoId: API_HASH,
    filePath: 'src/handler.ts',
    startLine: 1,
    endLine: 10,
    properties: { versionedId: 'v1' },
    ...overrides,
  } as GraphNode;
}

/** A minimal business-rule item; only `id` and `codeAnchors` drive evidence resolution. */
function item(id: string, codeAnchors?: CodeAnchor[]): IntentItem {
  return {
    id,
    kind: IntentKind.BusinessRule,
    title: 'Orders are charged once',
    statement: 'An order is charged exactly once.',
    authority: IntentAuthority.Accepted,
    payload: {
      condition: 'An order is submitted',
      requiredOutcome: 'Exactly one charge is created',
      observer: 'billing',
    },
    sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/billing', localId: 'BR-1' }],
    ...(codeAnchors ? { codeAnchors } : {}),
  } as IntentItem;
}

function anchor(overrides: Partial<CodeAnchor> = {}): CodeAnchor {
  return {
    repo: 'api',
    nodeId: HANDLER_ID,
    nodeType: NodeType.Function,
    capturedVersionedId: 'v1',
    rationale: 'charge is created here',
    ...overrides,
  };
}

async function seed(projectId: string, nodes: GraphNode[]): Promise<IGraphReadRepository> {
  const project = await openProjectDatabase(workspace, projectId);
  await project.graph.pushNodes(nodes);
  return project.graph;
}

const CLEAN_AT_GRAPH_COMMIT: Record<string, ObservedCheckout> = {
  api: { commit: GRAPH_COMMIT, dirty: false },
};

describe('resolveIntentEvidence — anchor status (AC-6)', () => {
  it('reports matched when the current versionedId equals the captured one', async () => {
    const graph = await seed('p', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle' }),
    ]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(result.items[0]?.anchors[0]?.currentVersionedId).toBe('v1');
    expect(result.items[0]?.anchors[0]?.mismatchReason).toBeUndefined();
  });

  it('reports changed when the node exists with a different versionedId', async () => {
    const graph = await seed('p', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle', properties: { versionedId: 'v2' } }),
    ]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Changed);
    expect(result.items[0]?.anchors[0]?.currentVersionedId).toBe('v2');
  });

  it('reports changed with an absent-versionedId reason when the stored node carries no versionedId', async () => {
    const graph = await seed('p', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle', properties: {} }),
    ]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Changed);
    expect(result.items[0]?.anchors[0]?.mismatchReason).toBe(AnchorMismatchReason.VersionedIdAbsent);
    expect(result.items[0]?.anchors[0]?.currentVersionedId).toBeUndefined();
  });

  it('reports missing when the stable node is absent from the active graph', async () => {
    const graph = await seed('p', [repoNode(API_HASH, 'api', GRAPH_COMMIT)]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Missing);
  });

  it('reports item-level unmapped and no anchors when the item has none', async () => {
    const graph = await seed('p', [repoNode(API_HASH, 'api', GRAPH_COMMIT)]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1')],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    expect(result.items[0]?.itemStatus).toBe(AnchorStatus.Unmapped);
    expect(result.items[0]?.anchors).toEqual([]);
  });
});

describe('resolveIntentEvidence — project and repo isolation (AC-5)', () => {
  it('does not let a byte-identical node in another project satisfy an anchor', async () => {
    const projectA = await seed('project-a', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle', properties: { versionedId: 'v1' } }),
    ]);
    const projectB = await seed('project-b', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle', properties: { versionedId: 'other-project' } }),
    ]);

    const input = {
      items: [item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    };

    const fromA = await resolveIntentEvidence({ ...input, repository: projectA });
    const fromB = await resolveIntentEvidence({ ...input, repository: projectB });

    expect(fromA.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(fromB.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Changed);
    expect(fromB.items[0]?.anchors[0]?.currentVersionedId).toBe('other-project');
  });

  it('reports missing when the node lives under another repo hash in the same project', async () => {
    const graph = await seed('p', [
      repoNode(WEB_HASH, 'web', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle', repoId: WEB_HASH }),
    ]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH, web: WEB_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Missing);
  });

  it('reports missing without querying when the declared repo is not part of the project', async () => {
    const graph = await seed('p', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle' }),
    ]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor({ repo: 'not-in-project' })])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    const evidence = result.items[0]?.anchors[0];
    expect(evidence?.status).toBe(AnchorStatus.Missing);
    expect(evidence?.mismatchReason).toBe(AnchorMismatchReason.RepoNotInProject);
    // No observation was supplied for THAT repo (the caller's checkout map
    // covers `api` only), so nothing was compared: `unverified`, not `unknown`.
    expect(evidence?.snapshotFreshness).toBe(SnapshotFreshness.Unverified);
  });

  it('never matches when the resolved node type differs from the declared anchor type', async () => {
    const graph = await seed('p', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle', type: NodeType.Class, properties: { versionedId: 'v1' } }),
    ]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    const evidence = result.items[0]?.anchors[0];
    expect(evidence?.status).toBe(AnchorStatus.Missing);
    expect(evidence?.mismatchReason).toBe(AnchorMismatchReason.NodeTypeMismatch);
    expect(evidence?.actualNodeType).toBe(NodeType.Class);
  });
});

describe('resolveIntentEvidence — snapshot freshness (AC-7)', () => {
  async function resolveWith(
    checkout: ObservedCheckout | undefined,
    opts: { graphCommit?: string | null; versionedId?: string } = {},
  ) {
    const graph = await seed('p', [
      repoNode(API_HASH, 'api', opts.graphCommit === null ? undefined : (opts.graphCommit ?? GRAPH_COMMIT)),
      codeNode({ id: HANDLER_ID, name: 'handle', properties: { versionedId: opts.versionedId ?? 'v1' } }),
    ]);
    return resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: checkout ? { api: checkout } : {},
    });
  }

  it('pairs matched with current for a clean checkout at the parsed commit', async () => {
    const result = await resolveWith({ commit: GRAPH_COMMIT, dirty: false });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Current);
    expect(result.repos[0]).toMatchObject({
      repo: 'api',
      repoHash: API_HASH,
      snapshotFreshness: SnapshotFreshness.Current,
      graphCommit: GRAPH_COMMIT,
      observedCommit: GRAPH_COMMIT,
    });
  });

  it('reports matched + stale when the graph represents a different commit', async () => {
    const result = await resolveWith({ commit: OTHER_COMMIT, dirty: false });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Stale);
  });

  it('reports matched + unknown for a dirty checkout at the parsed commit', async () => {
    const result = await resolveWith({ commit: GRAPH_COMMIT, dirty: true });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Unknown);
  });

  it('reports unverified when no observed checkout was supplied', async () => {
    const result = await resolveWith(undefined);

    // Nothing was compared, so the answer is "not verifiable from what you gave
    // me" — never `current`, and never the `unknown` of a failed comparison.
    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Unverified);
    expect(result.repos[0]?.observedCommit).toBeUndefined();
  });

  it('reports unknown when the caller supplied an observation git could not resolve', async () => {
    // `readObservedCheckout` degrades an unreadable checkout to `{ dirty: true }`
    // with no commit — a comparison that WAS attempted and could not conclude.
    const result = await resolveWith({ dirty: true });

    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Unknown);
  });

  it('reports unknown when the graph carries no parsed commit', async () => {
    const result = await resolveWith({ commit: GRAPH_COMMIT, dirty: false }, { graphCommit: null });

    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Unknown);
    expect(result.repos[0]?.graphCommit).toBeUndefined();
  });

  it('still reports stale for a dirty checkout whose HEAD differs from the parsed commit', async () => {
    const result = await resolveWith({ commit: OTHER_COMMIT, dirty: true });

    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Stale);
  });

  it('reports current for an abbreviated observed commit that prefixes the parsed commit', async () => {
    const result = await resolveWith({ commit: GRAPH_COMMIT.slice(0, 7), dirty: false });

    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Current);
    // The echoed observation stays exactly as the caller supplied it.
    expect(result.repos[0]?.observedCommit).toBe(GRAPH_COMMIT.slice(0, 7));
  });

  it('degrades a dirty abbreviated prefix to unknown, exactly as it degrades an exact match', async () => {
    const result = await resolveWith({ commit: GRAPH_COMMIT.slice(0, 12), dirty: true });

    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Unknown);
  });

  it('reports stale for an abbreviated observed commit that does not prefix the parsed commit', async () => {
    const result = await resolveWith({ commit: OTHER_COMMIT.slice(0, 7), dirty: false });

    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Stale);
  });

  it('still requires equality for a full-length observed hash', async () => {
    const equal = await resolveWith({ commit: GRAPH_COMMIT, dirty: false });
    const different = await resolveWith({ commit: OTHER_COMMIT, dirty: false });

    expect(equal.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Current);
    expect(different.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Stale);
  });

  it('reports stale for an observed commit shorter than an abbreviation can name', async () => {
    const result = await resolveWith({ commit: GRAPH_COMMIT.slice(0, 6), dirty: false });

    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Stale);
  });

  it('matches an abbreviated prefix case-insensitively', async () => {
    const hexCommit = 'abcdef1234567890abcdef1234567890abcdef12';
    const result = await resolveWith({ commit: 'ABCDEF1', dirty: false }, { graphCommit: hexCommit });

    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Current);
  });

  it('computes freshness independently of anchor status (changed + current)', async () => {
    const result = await resolveWith({ commit: GRAPH_COMMIT, dirty: false }, { versionedId: 'v9' });

    expect(result.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Changed);
    expect(result.items[0]?.anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Current);
  });
});

describe('readObservedCheckout', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  it('reports the HEAD commit of a clean checkout', async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'intent-checkout-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repoDir });
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('commit', '-q', '--allow-empty', '-m', 'init');

    const observed = await readObservedCheckout(repoDir);

    expect(observed.dirty).toBe(false);
    expect(observed.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports dirty when the working tree has uncommitted changes', async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'intent-checkout-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repoDir });
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('commit', '-q', '--allow-empty', '-m', 'init');
    writeFileSync(join(repoDir, 'untracked.ts'), 'export const x = 1;');

    const observed = await readObservedCheckout(repoDir);

    expect(observed.dirty).toBe(true);
  });

  it('degrades to dirty with no commit when the path is not a git checkout', async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'intent-checkout-'));

    const observed = await readObservedCheckout(repoDir);

    expect(observed).toEqual({ dirty: true });
  });
});

describe('resolveIntentEvidence — untrusted anchor repo names', () => {
  // Anchor repo names come from a user-editable file, so a name that collides
  // with an Object.prototype member must not resolve through the prototype and
  // hand a function to a graph query (which would throw and degrade the whole
  // response).
  it.each([
    'constructor',
    'toString',
    '__proto__',
  ])('treats the prototype key %s as a repo outside the project', async (hostileRepo) => {
    const graph = await seed('p', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle' }),
    ]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-hostile', [anchor({ repo: hostileRepo })]), item('BR-1', [anchor()])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: CLEAN_AT_GRAPH_COMMIT,
    });

    const hostile = result.items[0]?.anchors[0];
    expect(hostile?.status).toBe(AnchorStatus.Missing);
    expect(hostile?.mismatchReason).toBe(AnchorMismatchReason.RepoNotInProject);
    expect(result.repos.find((repo) => repo.repo === hostileRepo)?.repoHash).toBeUndefined();

    // The legitimate anchor in the same request still resolves.
    expect(result.items[1]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
  });

  it('treats a prototype-keyed observed checkout as no observation rather than a checkout', async () => {
    const graph = await seed('p', [
      repoNode(API_HASH, 'api', GRAPH_COMMIT),
      codeNode({ id: HANDLER_ID, name: 'handle' }),
    ]);

    const result = await resolveIntentEvidence({
      repository: graph,
      items: [item('BR-1', [anchor({ repo: 'toString' })])],
      repoHashesByName: { api: API_HASH },
      observedCheckouts: {},
    });

    expect(result.repos[0]).toEqual({ repo: 'toString', snapshotFreshness: SnapshotFreshness.Unverified });
  });
});
