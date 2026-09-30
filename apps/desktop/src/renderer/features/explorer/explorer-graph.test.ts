import { describe, expect, it } from 'vitest';
import { EdgeType, NodeType, type NeighborCount, type VizEdge, type VizNode } from '@coredoc/core';
import {
  CANVAS_NODE_CAP,
  canvasBannerMessage,
  type ExplorerState,
  canvasIsFull,
  deriveVisible,
  expansionKey,
  explorerReducer,
  initialExplorerState,
  presentRepos,
  seedKey,
  visibleCountOfType,
} from './explorer-graph.js';

function node(id: string, over: Partial<VizNode> = {}): VizNode {
  return { id, type: NodeType.Function, name: id, repoName: 'api', ...over };
}
function edge(id: string, sourceId: string, targetId: string, over: Partial<VizEdge> = {}): VizEdge {
  return { id, sourceId, targetId, type: EdgeType.Calls, confidence: 1, createdBy: 'parser', ...over };
}
function stateWith(over: Partial<ExplorerState>): ExplorerState {
  return { ...initialExplorerState, ...over };
}

describe('explorerReducer', () => {
  it('addFocus adds the node and selects it', () => {
    const counts: NeighborCount[] = [{ edgeType: EdgeType.Calls, direction: 'out', count: 2 }];
    const s = explorerReducer(initialExplorerState, { kind: 'addFocus', node: node('a'), counts });
    expect(s.nodes.get('a')?.name).toBe('a');
    expect(s.selectedId).toBe('a');
    expect(s.counts.get('a')).toEqual(counts);
  });

  it('addNeighbors merges nodes/edges, marks the group + the source node expanded', () => {
    const base = explorerReducer(initialExplorerState, { kind: 'addFocus', node: node('a') });
    const key = expansionKey('a', 'out', EdgeType.Calls);
    const s = explorerReducer(base, {
      kind: 'addNeighbors',
      nodes: [node('b')],
      edges: [edge('a->b', 'a', 'b')],
      expansionKey: key,
    });
    expect([...s.nodes.keys()]).toEqual(['a', 'b']);
    expect(s.edges.has('a->b')).toBe(true);
    expect(s.expanded.has(key)).toBe(true);
  });

  it('addNeighbors does not overwrite an existing node or edge', () => {
    const base = stateWith({ nodes: new Map([['a', node('a', { name: 'original' })]]) });
    const s = explorerReducer(base, {
      kind: 'addNeighbors',
      nodes: [node('a', { name: 'replacement' })],
      edges: [],
      expansionKey: 'k',
    });
    expect(s.nodes.get('a')?.name).toBe('original');
  });

  it('addSubgraph merges the subgraph nodes/edges and anchors the source node', () => {
    const base = explorerReducer(initialExplorerState, { kind: 'addFocus', node: node('a') });
    const s = explorerReducer(base, {
      kind: 'addSubgraph',
      nodes: [node('a', { name: 'ignored-dupe' }), node('b'), node('c')],
      edges: [edge('a->b', 'a', 'b'), edge('b->c', 'b', 'c')],
    });
    expect([...s.nodes.keys()]).toEqual(['a', 'b', 'c']);
    expect(s.nodes.get('a')?.name).toBe('a'); // existing node not overwritten
    expect([...s.edges.keys()]).toEqual(['a->b', 'b->c']);
    // the source becomes an expanded anchor so the focus mask grows to the subgraph.
  });

  it('addSubgraph merges a Cypher query result onto the canvas (the NL→Cypher render path)', () => {
    // runCypher dispatches the CypherGraphResult through this same action, so a
    // fresh (nodes, edges) result lands on the canvas exactly like a traverse.
    const result = { nodes: [node('x'), node('y')], edges: [edge('x->y', 'x', 'y')], truncated: false };
    const s = explorerReducer(initialExplorerState, {
      kind: 'addSubgraph',
      nodes: result.nodes,
      edges: result.edges,
    });
    expect([...s.nodes.keys()]).toEqual(['x', 'y']);
    expect([...s.edges.keys()]).toEqual(['x->y']);
  });

  it('toggle actions flip membership in the right hidden set', () => {
    let s = explorerReducer(initialExplorerState, { kind: 'toggleType', type: 'function' });
    expect(s.hiddenTypes.has('function')).toBe(true);
    s = explorerReducer(s, { kind: 'toggleType', type: 'function' });
    expect(s.hiddenTypes.has('function')).toBe(false);

    s = explorerReducer(initialExplorerState, { kind: 'toggleRepo', repo: 'api' });
    expect(s.hiddenRepos.has('api')).toBe(true);
  });

  it('select updates the selection', () => {
    expect(explorerReducer(initialExplorerState, { kind: 'select', id: 'a' }).selectedId).toBe('a');
  });

  it('addEdges merges edges and never grows the node set', () => {
    // Load-bearing: the auto-link effect keys on the node ids, so an action
    // that added nodes here would re-trigger it forever.
    const base = stateWith({
      nodes: new Map([
        ['a', node('a')],
        ['b', node('b')],
      ]),
    });
    const s = explorerReducer(base, { kind: 'addEdges', edges: [edge('a->b', 'a', 'b')] });
    expect(s.edges.has('a->b')).toBe(true);
    expect([...s.nodes.keys()]).toEqual(['a', 'b']);
  });

  it('addEdges returns the same state when nothing is new', () => {
    // Identity matters: a new object every poll would re-render the canvas.
    const base = stateWith({ edges: new Map([['a->b', edge('a->b', 'a', 'b')]]) });
    expect(explorerReducer(base, { kind: 'addEdges', edges: [edge('a->b', 'a', 'b')] })).toBe(base);
  });

  it('seedType marks the type seeded and un-hides it', () => {
    // Un-hiding matters: a chip click that fetched into a hidden layer would
    // look like a broken button.
    const base = stateWith({ hiddenTypes: new Set(['function']) });
    const s = explorerReducer(base, { kind: 'seedType', type: 'function' });
    expect(s.seededTypes.has('function')).toBe(true);
    expect(s.hiddenTypes.has('function')).toBe(false);
  });

  it('addNodes records the seed key so that repo is never refetched', () => {
    const s = explorerReducer(initialExplorerState, {
      kind: 'addNodes',
      nodes: [node('a')],
      seedKey: seedKey('function', 'api'),
    });
    expect(s.seededTypeRepos.has('function|api')).toBe(true);
  });

  it('addNodes without a seed key leaves the filter sets alone', () => {
    const base = stateWith({ hiddenTypes: new Set(['function']) });
    const s = explorerReducer(base, { kind: 'addNodes', nodes: [node('a')] });
    expect(s.seededTypes.size).toBe(0);
    expect(s.seededTypeRepos.size).toBe(0);
    expect(s.hiddenTypes.has('function')).toBe(true);
  });

  it('a repo seeded for one type is not seeded for another', () => {
    // The whole point of keying by pair: showing `class` must still pull `class`
    // nodes from a repo whose `function` nodes are already on the canvas.
    let s = explorerReducer(initialExplorerState, { kind: 'seedType', type: 'function' });
    s = explorerReducer(s, { kind: 'addNodes', nodes: [node('a')], seedKey: seedKey('function', 'api') });
    expect(s.seededTypeRepos.has(seedKey('class', 'api'))).toBe(false);
  });

  it('toggleType hides a seeded type without un-seeding it', () => {
    const seeded = explorerReducer(initialExplorerState, { kind: 'seedType', type: 'function' });
    const withNodes = explorerReducer(seeded, {
      kind: 'addNodes',
      nodes: [node('a')],
      seedKey: seedKey('function', 'api'),
    });
    const hidden = explorerReducer(withNodes, { kind: 'toggleType', type: 'function' });
    expect(hidden.hiddenTypes.has('function')).toBe(true);
    expect(hidden.seededTypes.has('function')).toBe(true);
    expect(hidden.nodes.has('a')).toBe(true); // nodes stay; re-showing is free
  });

  it('hiding a repo keeps its seed, so re-showing it costs no fetch', () => {
    let s = explorerReducer(initialExplorerState, { kind: 'seedType', type: 'function' });
    s = explorerReducer(s, { kind: 'addNodes', nodes: [node('a')], seedKey: seedKey('function', 'api') });
    s = explorerReducer(s, { kind: 'toggleRepo', repo: 'api' });
    expect(s.seededTypeRepos.has(seedKey('function', 'api'))).toBe(true);
    expect(s.nodes.has('a')).toBe(true);
  });

  it('clear resets to a fresh empty state', () => {
    const base = stateWith({
      nodes: new Map([['a', node('a')]]),
      seededTypes: new Set(['function']),
      seededTypeRepos: new Set([seedKey('function', 'api')]),
    });
    const s = explorerReducer(base, { kind: 'clear' });
    expect(s.nodes.size).toBe(0);
    expect(s.seededTypes.size).toBe(0);
    expect(s.seededTypeRepos.size).toBe(0);
  });
});

describe('deriveVisible', () => {
  // a -CALLS-> b, b -CONTAINS_FILE-> c, plus an isolated node d.
  const base = stateWith({
    nodes: new Map([
      ['a', node('a', { type: NodeType.Function, repoName: 'api' })],
      ['b', node('b', { type: NodeType.Class, repoName: 'api' })],
      ['c', node('c', { type: NodeType.File, repoName: 'web' })],
      ['d', node('d', { type: NodeType.Variable, repoName: 'api' })],
    ]),
    edges: new Map([
      ['a->b', edge('a->b', 'a', 'b', { type: EdgeType.Calls })],
      ['b->c', edge('b->c', 'b', 'c', { type: EdgeType.ContainsFile })],
    ]),
  });

  it('returns everything when no filter is active', () => {
    const { nodes, edges } = deriveVisible(base);
    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(edges.map((e) => e.id).sort()).toEqual(['a->b', 'b->c']);
  });

  it('drops an edge when the node-type filter hides one of its endpoints', () => {
    const { nodes, edges } = deriveVisible(stateWith({ ...base, hiddenTypes: new Set(['class']) }));
    expect(nodes.map((n) => n.id)).not.toContain('b');
    expect(edges).toHaveLength(0); // both edges lose an endpoint
  });

  it('applies the repo filter by repoName', () => {
    const { nodes, edges } = deriveVisible(stateWith({ ...base, hiddenRepos: new Set(['web']) }));
    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'd']);
    expect(edges.map((e) => e.id)).toEqual(['a->b']); // b->c lost its target
  });
});

describe('the canvas node cap', () => {
  /** A state holding `n` distinct nodes. */
  const withNodes = (n: number, prefix = 'n') =>
    stateWith({ nodes: new Map(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, node(`${prefix}${i}`)])) });

  const fresh = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => node(`${prefix}${i}`));

  it('stops a chip seed at the cap instead of blowing past it', () => {
    // The reported freeze: ten type chips, each within its own budget, together
    // burying the canvas. No single action can cross the ceiling now.
    const s = explorerReducer(withNodes(CANVAS_NODE_CAP - 10, 'old'), {
      kind: 'addNodes',
      nodes: fresh(500, 'new'),
      seedKey: seedKey('function', 'api'),
    });
    expect(s.nodes.size).toBe(CANVAS_NODE_CAP);
  });

  it('holds the line across repeated adds', () => {
    let s = withNodes(CANVAS_NODE_CAP - 5, 'old');
    for (let round = 0; round < 4; round += 1) {
      s = explorerReducer(s, { kind: 'addSubgraph', nodes: fresh(150, `r${round}-`), edges: [] });
    }
    expect(s.nodes.size).toBe(CANVAS_NODE_CAP);
  });

  it('applies to a traverse the same as to a chip', () => {
    const s = explorerReducer(withNodes(CANVAS_NODE_CAP, 'old'), {
      kind: 'addSubgraph',
      nodes: fresh(150, 'walk'),
      edges: [edge('x->y', 'walk0', 'walk1')],
    });
    expect(s.nodes.has('walk0')).toBe(false);
  });

  it('never refuses a node already on the canvas', () => {
    // Re-adding what is on screen must not be rationed — it costs no headroom.
    const s = explorerReducer(withNodes(CANVAS_NODE_CAP, 'old'), {
      kind: 'addNeighbors',
      nodes: [node('old0', { name: 'dupe' })],
      edges: [],
      expansionKey: 'k',
    });
    expect(s.nodes.size).toBe(CANVAS_NODE_CAP);
    expect(s.expanded.has('k')).toBe(true);
  });

  it('leaves the selection alone when the cap refuses a search seed', () => {
    // Selecting a node that never landed would dock the detail panel over
    // nothing at all.
    const base = { ...withNodes(CANVAS_NODE_CAP, 'old'), selectedId: 'old0' };
    const s = explorerReducer(base, { kind: 'addFocus', node: node('brand-new') });
    expect(s.nodes.has('brand-new')).toBe(false);
    expect(s.selectedId).toBe('old0');
  });

  it('selects a search seed that did fit', () => {
    const s = explorerReducer(withNodes(10, 'old'), { kind: 'addFocus', node: node('brand-new') });
    expect(s.selectedId).toBe('brand-new');
  });

  it('reports fullness so the canvas can say why adds are being dropped', () => {
    expect(canvasIsFull(withNodes(CANVAS_NODE_CAP - 1, 'old'))).toBe(false);
    expect(canvasIsFull(withNodes(CANVAS_NODE_CAP, 'old'))).toBe(true);
  });

  it('frees the canvas again on clear', () => {
    expect(canvasIsFull(explorerReducer(withNodes(CANVAS_NODE_CAP, 'old'), { kind: 'clear' }))).toBe(false);
  });
});

describe('visibleCountOfType', () => {
  // Two repos hold `function` nodes; `web` also holds a class.
  const base = stateWith({
    nodes: new Map([
      ['a', node('a', { type: NodeType.Function, repoName: 'api' })],
      ['b', node('b', { type: NodeType.Function, repoName: 'web' })],
      ['c', node('c', { type: NodeType.Class, repoName: 'web' })],
    ]),
  });

  it('counts every repo when none is hidden', () => {
    expect(visibleCountOfType(base, NodeType.Function)).toBe(2);
  });

  it('excludes hidden repos, so the chip stays comparable with its count', () => {
    // The chip's total is summed over the *selected* repos, so counting nodes
    // from a hidden one would claim coverage the canvas is not showing.
    expect(visibleCountOfType(stateWith({ ...base, hiddenRepos: new Set(['web']) }), NodeType.Function)).toBe(1);
  });
});

describe('presentRepos', () => {
  it('lists distinct sorted repos', () => {
    const s = stateWith({
      nodes: new Map([
        ['a', node('a', { type: NodeType.Function, repoName: 'api' })],
        ['b', node('b', { type: NodeType.Class, repoName: 'web' })],
      ]),
    });
    expect(presentRepos(s)).toEqual(['api', 'web']);
  });
});

describe('canvasBannerMessage', () => {
  const none = { isFull: false, linkingUnavailable: false, linkFetchFailed: false, edgesTruncated: false };

  it('says nothing when the picture is complete', () => {
    expect(canvasBannerMessage(none)).toBeUndefined();
  });

  it('reports a failed link fetch instead of leaving the nodes silently unlinked', () => {
    expect(canvasBannerMessage({ ...none, linkFetchFailed: true })).toMatch(
      /Couldn't load relationships between these nodes\./,
    );
  });

  it('ranks a full canvas over an unavailable/failed/partial link-up (it is why the picture looks wrong)', () => {
    const msg = canvasBannerMessage({
      isFull: true,
      linkingUnavailable: true,
      linkFetchFailed: true,
      edgesTruncated: true,
    });
    expect(msg).toMatch(new RegExp(`Canvas is full at ${CANVAS_NODE_CAP.toLocaleString()} nodes`));
  });

  it('ranks "cannot link at all" over a failed fetch, and a failed fetch over truncation', () => {
    expect(canvasBannerMessage({ ...none, linkingUnavailable: true, linkFetchFailed: true })).toMatch(
      /not available on the cloud graph yet/,
    );
    expect(canvasBannerMessage({ ...none, linkFetchFailed: true, edgesTruncated: true })).toMatch(
      /Couldn't load relationships/,
    );
    expect(canvasBannerMessage({ ...none, edgesTruncated: true })).toMatch(/some links are hidden/);
  });
});
