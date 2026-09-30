/**
 * The explorer's client-side graph model — a PURE reducer over the set of nodes
 * the user has pulled onto the canvas, plus the filter state that derives what
 * canvas actually renders. This is genuinely ephemeral UI state (a user-built view,
 * not server cache), so it lives here, not in TanStack Query. Kept pure +
 * Map-based so the merge/dedup/expansion + `deriveVisible` filtering is
 * unit-testable without React or the canvas renderer.
 *
 * Forked from `apps/web/src/features/explorer/explorer-graph.ts` on 2026-07-26,
 * where the two files were byte-identical. The desktop redesign drops focus mode
 * and per-node removal, and adds `seededTypes` for the left panel's type chips.
 * The apps/web copy is NOT kept in sync — do not port these changes back.
 */

import type { NeighborCount, VizEdge, VizNode } from '@coredoc/core';

/**
 * The most nodes the canvas will ever hold, from every source combined.
 *
 * The canvas freezes well before the graph runs out of interesting nodes, and the
 * per-source budgets alone cannot prevent it: ten type chips at 500 each, or a
 * handful of traverses, each stay within their own limit while together burying
 * the canvas. So the ceiling lives here, at the one place every add path passes
 * through, rather than being re-derived by each caller.
 *
 * Adds that would cross it are dropped, not queued — and `canvasIsFull` lets the
 * UI say so, because a silently ignored click is worse than a refused one.
 */
export const CANVAS_NODE_CAP = 3000;

/**
 * Merge nodes into the canvas, stopping at the cap.
 *
 * Nodes already present are skipped BEFORE the cap is consulted, so re-adding
 * what is on screen can never be refused, and an existing node never spends
 * headroom twice.
 */
function mergeNodes(existing: Map<string, VizNode>, incoming: VizNode[]): Map<string, VizNode> {
  const nodes = new Map(existing);
  for (const n of incoming) {
    if (nodes.has(n.id)) continue;
    if (nodes.size >= CANVAS_NODE_CAP) break;
    nodes.set(n.id, n);
  }
  return nodes;
}

function mergeEdges(existing: Map<string, VizEdge>, incoming: VizEdge[]): Map<string, VizEdge> {
  const edges = new Map(existing);
  for (const e of incoming) if (!edges.has(e.id)) edges.set(e.id, e);
  return edges;
}

/** The canvas cannot take any more nodes — every further add will be dropped. */
export function canvasIsFull(state: ExplorerState): boolean {
  return state.nodes.size >= CANVAS_NODE_CAP;
}

/** The degraded canvas states the banner can report, in precedence order. */
export interface CanvasBannerFlags {
  /** The canvas is at CANVAS_NODE_CAP and is refusing further nodes. */
  isFull: boolean;
  /** This backend cannot link on-canvas nodes at all. */
  linkingUnavailable: boolean;
  /** The link-up request failed (offline, rate-limited, server error). */
  linkFetchFailed: boolean;
  /** The backend answered, but could not return every edge. */
  edgesTruncated: boolean;
}

/**
 * Which degraded-state message the canvas should show, if any.
 *
 * Never let a partial, failed, or absent link-up look like "these nodes are
 * unrelated" — say which it is. A full canvas outranks the link states: once it
 * is refusing nodes, that is why the picture looks wrong. A failed fetch
 * outranks truncation because it means NO edges arrived, not merely some.
 */
export function canvasBannerMessage(flags: CanvasBannerFlags): string | undefined {
  if (flags.isFull) {
    return `Canvas is full at ${CANVAS_NODE_CAP.toLocaleString()} nodes — anything further is dropped. Clear it or narrow the chips.`;
  }
  if (flags.linkingUnavailable) return 'Relationships between these nodes are not available on the cloud graph yet.';
  if (flags.linkFetchFailed) return "Couldn't load relationships between these nodes.";
  if (flags.edgesTruncated) return 'Too many relationships to draw them all — some links are hidden.';
  return undefined;
}

export interface ExplorerState {
  /** Focus nodes + expanded neighbors, keyed by node id. */
  nodes: Map<string, VizNode>;
  /** Edges among the on-canvas nodes, keyed by edge id. */
  edges: Map<string, VizEdge>;
  /** Per-node neighbor tallies (loaded lazily on select) → drawer expand groups. */
  counts: Map<string, NeighborCount[]>;
  /** `${nodeId}|${direction}|${edgeType}` groups already expanded (done state). */
  expanded: Set<string>;
  /** NodeType string values the user has pulled onto the canvas via a chip. */
  seededTypes: Set<string>;
  /**
   * `${type}|${repoName}` pairs already fetched.
   *
   * A chip seeds one repo at a time, so the page cap applies per repo instead of
   * being spent on whichever repos the backend happened to return first. Without
   * this, deselecting a repo left the canvas holding only that arbitrary slice of
   * the survivors — far fewer nodes than the chip's count promised.
   */
  seededTypeRepos: Set<string>;
  /** NodeType string values hidden by the node-type filter. */
  hiddenTypes: Set<string>;
  /** repoName values hidden by the repo filter. */
  hiddenRepos: Set<string>;
  /** The selected node (drives the docked node-detail panel). */
  selectedId: string | null;
}

function createInitial(): ExplorerState {
  return {
    nodes: new Map(),
    edges: new Map(),
    counts: new Map(),
    expanded: new Set(),
    seededTypes: new Set(),
    seededTypeRepos: new Set(),
    hiddenTypes: new Set(),
    hiddenRepos: new Set(),
    selectedId: null,
  };
}

export const initialExplorerState: ExplorerState = createInitial();

export function expansionKey(nodeId: string, direction: 'in' | 'out', edgeType: string): string {
  return `${nodeId}|${direction}|${edgeType}`;
}

/**
 * Key for one chip seed. `repo` is `''` when the graph reports no repo names at
 * all, which stands for the single unscoped fetch that case gets.
 */
export function seedKey(type: string, repo: string): string {
  return `${type}|${repo}`;
}

export type ExplorerAction =
  | { kind: 'addFocus'; node: VizNode; counts?: NeighborCount[] }
  | { kind: 'addNeighbors'; nodes: VizNode[]; edges: VizEdge[]; expansionKey: string }
  | { kind: 'addSubgraph'; nodes: VizNode[]; edges: VizEdge[] }
  /** Marks a type chip as loaded and un-hides it — the fetches follow per repo. */
  | { kind: 'seedType'; type: string }
  /** `seedKey` records which (type, repo) pair these nodes satisfy. */
  | { kind: 'addNodes'; nodes: VizNode[]; seedKey?: string }
  /** Edges only — the induced subgraph over nodes already on the canvas. */
  | { kind: 'addEdges'; edges: VizEdge[] }
  | { kind: 'setCounts'; nodeId: string; counts: NeighborCount[] }
  | { kind: 'toggleType'; type: string }
  | { kind: 'toggleRepo'; repo: string }
  | { kind: 'select'; id: string | null }
  | { kind: 'clear' };

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function explorerReducer(state: ExplorerState, action: ExplorerAction): ExplorerState {
  switch (action.kind) {
    case 'addFocus': {
      const nodes = mergeNodes(state.nodes, [action.node]);
      const counts = action.counts ? new Map(state.counts).set(action.node.id, action.counts) : state.counts;
      // Selecting a node the cap refused would dock a detail panel over nothing.
      const selectedId = nodes.has(action.node.id) ? action.node.id : state.selectedId;
      return { ...state, nodes, counts, selectedId };
    }
    case 'addNeighbors': {
      const expanded = new Set(state.expanded).add(action.expansionKey);
      return {
        ...state,
        nodes: mergeNodes(state.nodes, action.nodes),
        edges: mergeEdges(state.edges, action.edges),
        expanded,
      };
    }
    case 'addSubgraph': {
      // Depth-N traverse merge: nodes + edges, no expansion tracking.
      return {
        ...state,
        nodes: mergeNodes(state.nodes, action.nodes),
        edges: mergeEdges(state.edges, action.edges),
      };
    }
    case 'seedType': {
      // Un-hiding is load-bearing: without it a chip click can fetch hundreds of
      // nodes into a hidden layer, which looks like a broken button.
      const hiddenTypes = new Set(state.hiddenTypes);
      hiddenTypes.delete(action.type);
      return { ...state, hiddenTypes, seededTypes: new Set(state.seededTypes).add(action.type) };
    }
    case 'addNodes': {
      // Type-chip merge: nodes only, no edges.
      const nodes = mergeNodes(state.nodes, action.nodes);
      if (!action.seedKey) return { ...state, nodes };
      // The seed is recorded even if the cap swallowed the page: we did ask this
      // repo for this type, and re-asking would return the same refused nodes.
      return { ...state, nodes, seededTypeRepos: new Set(state.seededTypeRepos).add(action.seedKey) };
    }
    case 'addEdges': {
      // Auto-link fill. Nodes are untouched by design: this action must never
      // grow the canvas, or the effect that dispatches it would re-trigger.
      let changed = false;
      const edges = new Map(state.edges);
      for (const e of action.edges) {
        if (!edges.has(e.id)) {
          edges.set(e.id, e);
          changed = true;
        }
      }
      return changed ? { ...state, edges } : state;
    }
    case 'setCounts':
      return { ...state, counts: new Map(state.counts).set(action.nodeId, action.counts) };
    case 'toggleType':
      return { ...state, hiddenTypes: toggle(state.hiddenTypes, action.type) };
    case 'toggleRepo':
      return { ...state, hiddenRepos: toggle(state.hiddenRepos, action.repo) };
    case 'select':
      return { ...state, selectedId: action.id };
    case 'clear':
      return createInitial();
    default:
      return state;
  }
}

/**
 * The nodes+edges the canvas should render: the repo/type node filters, then the edges
 * whose endpoints both survived them.
 */
export function deriveVisible(state: ExplorerState): { nodes: VizNode[]; edges: VizEdge[] } {
  const nodes = [...state.nodes.values()].filter(
    (n) => !state.hiddenRepos.has(n.repoName) && !state.hiddenTypes.has(n.type),
  );
  const visibleIds = new Set(nodes.map((n) => n.id));
  const edges = [...state.edges.values()].filter((e) => visibleIds.has(e.sourceId) && visibleIds.has(e.targetId));
  return { nodes, edges };
}

/** How many on-canvas nodes of `type` sit in a repo the user has not hidden. */
export function visibleCountOfType(state: ExplorerState, type: string): number {
  let n = 0;
  for (const node of state.nodes.values()) {
    if (node.type === type && !state.hiddenRepos.has(node.repoName)) n += 1;
  }
  return n;
}

/** Distinct repo names on the canvas (for the repo filter; shown when > 1). */
export function presentRepos(state: ExplorerState): string[] {
  return [...new Set([...state.nodes.values()].map((n) => n.repoName).filter(Boolean))].sort();
}
