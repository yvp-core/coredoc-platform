/**
 * Owns the explorer's canvas model and every fetch that mutates it.
 *
 * This used to live inside DesktopExplorer, which was fine while the explorer
 * was one self-contained tab. It is a provider now because the redesigned shell
 * splits the explorer across three sibling regions — the left panel seeds the
 * graph, the canvas renders it, and the docked right panel inspects the
 * selected node — and none of them is an ancestor of the others.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GraphCapabilities, NeighborCount, VizEdge, VizNode } from '@coredoc/core';
import type { GraphScope } from '../../../shared/ipc-types.js';
import {
  fetchCypher,
  fetchEdgesAmong,
  fetchGenerateCypher,
  graphCapabilitiesQueryOptions,
  graphNeighborsQueryOptions,
  graphNodeQueryOptions,
  graphReposQueryOptions,
  graphSubgraphQueryOptions,
} from '../../api/graph.js';
import {
  deriveVisible,
  expansionKey,
  explorerReducer,
  initialExplorerState,
  presentRepos,
  type ExplorerAction,
  type ExplorerState,
} from './explorer-graph.js';
import type { ExplorerCanvasHandle } from './explorer-canvas.js';

/**
 * Edge kinds a depth-N traverse follows. Broader than the DB's default
 * SUBGRAPH_FLOW_EDGE_TYPES (execution-flow only: CALLS/HANDLES/…), which leaves
 * non-function nodes — class/interface/enum/entity — with no traversable edges
 * because their relationships are structural (HAS_METHOD/USES_TYPE/EXTENDS/…).
 * This set adds those semantic/type edges so every node kind traverses like
 * functions do, while still excluding the dense CONTAINS_* containment
 * scaffolding so a depth-5 walk can't explode into the whole file/type graph
 * (the nodeCap bounds the result either way). Kept as string literals so the
 * @coredoc/core EdgeType enum is never value-imported into the renderer bundle
 * (that break is documented in the port's notes).
 */
const TRAVERSE_EDGE_TYPES = [
  'CALLS',
  'HANDLES',
  'MAKES_EXTERNAL_CALL',
  'RESOLVES_TO',
  'REFERENCES_VARIABLE',
  'USES_TYPE',
  'HAS_METHOD',
  'EXTENDS',
  'IMPLEMENTS_INTERFACE',
  'OPERATES_ON',
  'IMPORTS',
  'RENDERS_COMPONENT',
  'USES_COMPONENT',
];

/**
 * Nodes one traverse may bring back.
 *
 * A traverse lands on a canvas the user has already built, so it has to behave
 * like an addition rather than a replacement — and at depth 5 over the edge set
 * above it will happily return everything the walk can reach. Asked explicitly
 * instead of taking the main process's SUBGRAPH_NODE_CAP, so the number that
 * governs how much a Traverse click grows the canvas is stated here, next to the
 * click, rather than inherited from a transport-layer default.
 */
const TRAVERSE_NODE_LIMIT = 150;

export type GraphSource = 'local' | 'cloud';

/**
 * State of the "Ask the graph" NL→Cypher flow (a sibling seeding path to search
 * and type chips). Held here, not in the box, because the generated query is the
 * context's to own: the box seeds a local editable draft from `query` and hands
 * the edited text back to `runCypher`, whose result merges onto the same canvas.
 */
export interface CypherUiState {
  /** The generated Cypher, shown+editable in the box. Empty before first generate. */
  query: string;
  /** Increments on every successful generation so an identical query still re-seeds the editable draft. */
  generationRevision: number;
  /** A one-shot LLM generation is in flight. */
  generating: boolean;
  /** A generated (or edited) query is executing. */
  running: boolean;
  /** The last generate or run failed — surfaced in the box's banner. */
  error: string | null;
  /** The last run hit the server cap — the box hints "refine with LIMIT". */
  truncated: boolean;
}

const initialCypherState: CypherUiState = {
  query: '',
  generationRevision: 0,
  generating: false,
  running: false,
  error: null,
  truncated: false,
};

export interface ExplorerApi {
  scope: GraphScope;
  source: GraphSource;
  /** True when this project has a cloud graph to switch to. */
  canUseCloud: boolean;
  /** True when this project has a local graph at all — false for a cloud-only member project. */
  canUseLocal: boolean;
  setSource: (source: GraphSource) => void;

  state: ExplorerState;
  dispatch: Dispatch<ExplorerAction>;
  /** Nodes and edges surviving the filter passes. */
  visible: { nodes: VizNode[]; edges: VizEdge[] };
  /** Every workspace repo, unioned with any repo already on the canvas. */
  allRepos: string[];
  caps: GraphCapabilities | undefined;
  selectedNode: VizNode | undefined;
  /** The backend could not return every edge among the canvas — picture is partial. */
  edgesTruncated: boolean;
  /** This backend cannot link on-canvas nodes at all. */
  linkingUnavailable: boolean;
  /** The last link-up request failed — the canvas is unlinked, not unrelated. */
  linkFetchFailed: boolean;
  canvasRef: RefObject<ExplorerCanvasHandle>;

  selectNode: (nodeId: string) => void;
  deselect: () => void;
  loadCounts: (nodeId: string) => Promise<NeighborCount[]>;
  addSeed: (nodeId: string) => Promise<void>;
  expandGroup: (nodeId: string, count: NeighborCount) => Promise<void>;
  expandAll: (nodeId: string) => Promise<void>;
  traverseSubgraph: (nodeId: string, depth: number) => Promise<void>;

  /** NL→Cypher flow state + drivers (see CypherUiState). */
  cypher: CypherUiState;
  /** One-shot: turn `text` into a Cypher query, stored in `cypher.query` to show+edit. */
  generateCypher: (text: string) => Promise<void>;
  /** Execute `query` (the user-edited draft) and merge its result onto the canvas. */
  runCypher: (query: string) => Promise<void>;
}

const ExplorerContext = createContext<ExplorerApi | null>(null);

export function useExplorer(): ExplorerApi {
  const api = useContext(ExplorerContext);
  if (!api) throw new Error('useExplorer must be used inside an ExplorerProvider');
  return api;
}

export interface ExplorerProviderProps {
  projectId: string;
  cloudWorkspaceId?: string;
  isCloud?: boolean;
  /**
   * False for a project with no local graph — a cloud-only member project, whose
   * `projectId` is a synthetic `cloud:<wsId>` that no local backend can resolve.
   * Such a project opens on cloud and never offers the local source.
   */
  canUseLocal?: boolean;
  children: ReactNode;
}

export function ExplorerProvider({
  projectId,
  cloudWorkspaceId,
  isCloud,
  canUseLocal = true,
  children,
}: ExplorerProviderProps) {
  const [source, setSourceState] = useState<GraphSource>(canUseLocal ? 'local' : 'cloud');
  const [state, dispatch] = useReducer(explorerReducer, initialExplorerState);
  // NL→Cypher flow state (see CypherUiState). Held here, not in the box, because the
  // generated query is the context's to own — the box seeds a local editable draft
  // from it and hands the edited text back to runCypher.
  const [cypher, setCypher] = useState<CypherUiState>(initialCypherState);
  const canvasRef = useRef<ExplorerCanvasHandle>(null);
  const queryClient = useQueryClient();

  const scope: GraphScope = useMemo(
    () =>
      source === 'cloud' && cloudWorkspaceId
        ? { source: 'cloud', id: cloudWorkspaceId }
        : { source: 'local', id: projectId },
    [source, cloudWorkspaceId, projectId],
  );

  // Switching backends mid-canvas would mix node/edge ids from two different
  // graphs — clear so the new source starts from a blank canvas.
  const setSource = useCallback((next: GraphSource) => {
    setSourceState(next);
    dispatch({ kind: 'clear' });
    // Drop any stale generated query with the canvas — a Ladybug-authored query
    // must not linger over a cloud scope (or vice versa). scope only changes via
    // this path in practice (projectId/cloudWorkspaceId are fixed for a session).
    setCypher(initialCypherState);
  }, []);

  const { data: reposData } = useQuery(graphReposQueryOptions(scope));
  const { data: caps } = useQuery(graphCapabilitiesQueryOptions(scope));

  const visible = useMemo(() => deriveVisible(state), [state]);

  const [edgesTruncated, setEdgesTruncated] = useState(false);
  const [linkFetchFailed, setLinkFetchFailed] = useState(false);

  // Auto-link the canvas.
  //
  // Every node-adding path (type chips, search seed, dead code, browse) adds
  // nodes WITHOUT edges, so the canvas would otherwise be a field of isolated
  // dots. After any change to the node set, ask the backend for the induced
  // subgraph over exactly those ids and merge it.
  //
  // This cannot loop: merging edges never changes the node set, and the effect
  // keys on the node ids alone.
  const nodeIdKey = useMemo(() => [...state.nodes.keys()].sort().join('|'), [state.nodes]);
  const canLink = caps?.edgesAmong === true;

  useEffect(() => {
    if (!canLink || nodeIdKey === '') {
      setEdgesTruncated(false);
      setLinkFetchFailed(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchEdgesAmong(scope, nodeIdKey.split('|'));
        if (cancelled) return;
        setEdgesTruncated(page.truncated);
        setLinkFetchFailed(false);
        if (page.edges.length > 0) dispatch({ kind: 'addEdges', edges: page.edges });
      } catch {
        // Non-fatal: the nodes are still usable unlinked — but a swallowed
        // failure would render as "these nodes are unrelated", so record it and
        // let the canvas say so. Cleared by the next successful fetch above.
        if (cancelled) return;
        setEdgesTruncated(false);
        setLinkFetchFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeIdKey, scope, canLink]);

  // The repo filter shows every workspace repo (not just canvas), unioned with
  // any repo already on the canvas so a freshly-seeded node's repo can't be
  // missing while the repos query is still loading.
  const allRepos = useMemo(
    () => [...new Set([...(reposData?.repos.map((r) => r.name) ?? []), ...presentRepos(state)])].sort(),
    [reposData, state],
  );

  const loadCounts = useCallback(
    async (nodeId: string) => {
      const cached = state.counts.get(nodeId);
      if (cached) return cached;
      const detail = await queryClient.fetchQuery(graphNodeQueryOptions(scope, nodeId));
      dispatch({ kind: 'setCounts', nodeId, counts: detail.neighborCounts });
      return detail.neighborCounts;
    },
    [queryClient, scope, state.counts],
  );

  const expandGroup = useCallback(
    async (nodeId: string, count: NeighborCount) => {
      const page = await queryClient.fetchQuery(
        graphNeighborsQueryOptions(scope, nodeId, { direction: count.direction, edgeType: count.edgeType }),
      );
      dispatch({
        kind: 'addNeighbors',
        nodes: page.nodes,
        edges: page.edges,
        expansionKey: expansionKey(nodeId, count.direction, count.edgeType),
      });
    },
    [queryClient, scope],
  );

  // Double-click on a node = expand every neighbor group at once (skipping
  // already-expanded groups). The node panel offers the surgical per-group variant.
  const expandAll = useCallback(
    async (nodeId: string) => {
      const counts = await loadCounts(nodeId);
      await Promise.all(
        counts
          .filter((c) => !state.expanded.has(expansionKey(nodeId, c.direction, c.edgeType)))
          .map((c) => expandGroup(nodeId, c)),
      );
    },
    [loadCounts, expandGroup, state.expanded],
  );

  const selectNode = useCallback(
    (nodeId: string) => {
      dispatch({ kind: 'select', id: nodeId });
      void loadCounts(nodeId);
    },
    [loadCounts],
  );

  const deselect = useCallback(() => dispatch({ kind: 'select', id: null }), []);

  // Depth-N traverse from a node — one server-side subgraph walk (vs. repeated
  // depth-1 expansion). Merged onto the canvas; the source becomes an anchor.
  const traverseSubgraph = useCallback(
    async (nodeId: string, depth: number) => {
      const page = await queryClient.fetchQuery(
        graphSubgraphQueryOptions(scope, nodeId, {
          depth,
          edgeTypes: TRAVERSE_EDGE_TYPES,
          limit: TRAVERSE_NODE_LIMIT,
        }),
      );
      dispatch({ kind: 'addSubgraph', nodes: page.nodes, edges: page.edges });
    },
    [queryClient, scope],
  );

  const addSeed = useCallback(
    async (nodeId: string) => {
      const detail = await queryClient.fetchQuery(graphNodeQueryOptions(scope, nodeId));
      dispatch({ kind: 'addFocus', node: detail.node, counts: detail.neighborCounts });
    },
    [queryClient, scope],
  );

  // NL→Cypher: a one-shot generation, then execution of the (possibly edited)
  // query. Both are imperative — user-triggered, not cache-keyable — so they hold
  // their own loading/error state (declared above) rather than going through
  // TanStack Query.
  const generateCypher = useCallback(
    async (text: string) => {
      setCypher((c) => ({ ...c, generating: true, error: null }));
      try {
        const { cypher: query } = await fetchGenerateCypher(scope, text);
        setCypher((c) => ({
          ...c,
          query,
          generationRevision: c.generationRevision + 1,
          generating: false,
        }));
      } catch (err) {
        // Fail loudly: a swallowed generation error makes Generate a dead button.
        setCypher((c) => ({ ...c, generating: false, error: (err as Error).message }));
      }
    },
    [scope],
  );

  const runCypher = useCallback(
    async (query: string) => {
      setCypher((c) => ({ ...c, running: true, error: null }));
      try {
        const result = await fetchCypher(scope, query);
        // Merge like a traverse: additive nodes+edges, no expansion tracking. The
        // canvas reads visible.nodes/edges, so this render is automatic.
        dispatch({ kind: 'addSubgraph', nodes: result.nodes, edges: result.edges });
        setCypher((c) => ({ ...c, running: false, truncated: result.truncated }));
      } catch (err) {
        setCypher((c) => ({ ...c, running: false, error: (err as Error).message }));
      }
    },
    [scope],
  );

  const api = useMemo<ExplorerApi>(
    () => ({
      scope,
      source,
      canUseCloud: !!isCloud && !!cloudWorkspaceId,
      canUseLocal,
      setSource,
      state,
      dispatch,
      visible,
      allRepos,
      caps,
      selectedNode: state.selectedId ? state.nodes.get(state.selectedId) : undefined,
      edgesTruncated,
      linkingUnavailable: caps !== undefined && !caps.edgesAmong,
      linkFetchFailed,
      canvasRef,
      selectNode,
      deselect,
      loadCounts,
      addSeed,
      expandGroup,
      expandAll,
      traverseSubgraph,
      cypher,
      generateCypher,
      runCypher,
    }),
    [
      scope,
      source,
      isCloud,
      cloudWorkspaceId,
      canUseLocal,
      setSource,
      state,
      visible,
      allRepos,
      caps,
      edgesTruncated,
      linkFetchFailed,
      selectNode,
      deselect,
      loadCounts,
      addSeed,
      expandGroup,
      expandAll,
      traverseSubgraph,
      cypher,
      generateCypher,
      runCypher,
    ],
  );

  return <ExplorerContext.Provider value={api}>{children}</ExplorerContext.Provider>;
}
