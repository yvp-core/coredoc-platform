import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { VizEdge, VizNode } from '@coredoc/core';
import { NODE_SIZE, toGraphEdge, toGraphNode } from '../../lib/graph-adapters.js';
import { captionColor, selectionColor } from '../../lib/viz-style.js';

cytoscape.use(fcose);

const FIT_PADDING = 40;

/**
 * Force-directed layout. `randomize: false` after the first run starts from the
 * current positions, so an expand settles the new neighbors around the existing
 * picture instead of reshuffling it.
 */
function layoutOptions(randomize: boolean): cytoscape.LayoutOptions {
  return {
    name: 'fcose',
    randomize,
    animate: !randomize,
    animationDuration: 300,
    fit: true,
    padding: FIT_PADDING,
    nodeDimensionsIncludeLabels: true,
  } as cytoscape.LayoutOptions;
}

/** Stylesheet over the adapter's `data()` fields. */
function stylesheet(): cytoscape.StylesheetJson {
  const caption = captionColor();
  return [
    {
      selector: 'node',
      style: {
        width: NODE_SIZE,
        height: NODE_SIZE,
        'background-color': 'data(color)',
        label: 'data(caption)',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'font-size': 11,
        color: caption,
      },
    },
    { selector: 'node[?selected]', style: { 'border-width': 3, 'border-color': selectionColor() } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 'data(width)',
        'line-color': 'data(color)',
        'line-style': 'data(lineStyle)' as cytoscape.Css.LineStyle,
        opacity: 'data(opacity)' as unknown as number,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': 'data(color)',
        label: 'data(caption)',
        'font-size': 9,
        color: caption,
        'text-rotation': 'autorotate',
        'text-background-color': '#FFFFFF',
        'text-background-opacity': 0.8,
        'text-background-padding': '1px',
      },
    },
  ];
}

/** Imperative handle the toolbar's Fit button reaches through. */
export interface ExplorerCanvasHandle {
  fitView: () => void;
}

export interface ExplorerCanvasProps {
  nodes: VizNode[];
  edges: VizEdge[];
  selectedId: string | null;
  onNodeClick: (id: string) => void;
  onNodeDoubleClick: (id: string) => void;
  onCanvasClick: () => void;
}

/**
 * The graph canvas (Cytoscape, canvas renderer). Owns the Cytoscape instance and
 * syncs the visible VizNode/VizEdge sets into it. Pure rendering + local
 * renderer lifecycle only — all graph state lives in the route's reducer.
 */
export const ExplorerCanvas = forwardRef<ExplorerCanvasHandle, ExplorerCanvasProps>(function ExplorerCanvas(
  { nodes, edges, selectedId, onNodeClick, onNodeDoubleClick, onCanvasClick },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  // Latest callbacks for the listeners bound once at mount.
  const callbacks = useRef({ onNodeClick, onNodeDoubleClick, onCanvasClick });
  callbacks.current = { onNodeClick, onNodeDoubleClick, onCanvasClick };

  const graphNodes = useMemo(() => nodes.map((n) => toGraphNode(n, selectedId)), [nodes, selectedId]);
  // A RESOLVES_TO edge whose two ends resolve to different repos is a cross-repo
  // bridge → amber. Look up each end's repo from the visible node set.
  const repoById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.repoName);
    return m;
  }, [nodes]);
  const graphEdges = useMemo(
    () =>
      edges
        // Cytoscape rejects an edge whose endpoint is not in the graph.
        .filter((e) => repoById.has(e.sourceId) && repoById.has(e.targetId))
        .map((e) => toGraphEdge(e, e.type === 'RESOLVES_TO' && repoById.get(e.sourceId) !== repoById.get(e.targetId))),
    [edges, repoById],
  );

  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      style: stylesheet(),
      minZoom: 0.05,
      maxZoom: 3,
      boxSelectionEnabled: false,
      // Selection is reducer state (the `selected` data flag), not Cytoscape's.
      autounselectify: true,
    });
    cy.on('tap', 'node', (e) => callbacks.current.onNodeClick(e.target.id()));
    cy.on('dbltap', 'node', (e) => callbacks.current.onNodeDoubleClick(e.target.id()));
    cy.on('tap', (e) => {
      if (e.target === cy) callbacks.current.onCanvasClick();
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Sync elements: drop what left, update what stayed, add what arrived. Only a
  // change in the element set re-runs the layout — a selection or palette change
  // restyles in place without moving anything.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const wanted = new Set<string>([...graphNodes.map((n) => n.id), ...graphEdges.map((e) => e.id)]);
    const firstLayout = cy.nodes().length === 0;
    let structureChanged = false;
    cy.batch(() => {
      const gone = cy.elements().filter((el) => !wanted.has(el.id()));
      if (gone.length > 0) {
        gone.remove();
        structureChanged = true;
      }
      for (const data of graphNodes) {
        const existing = cy.getElementById(data.id);
        if (existing.nonempty()) {
          existing.data(data);
          continue;
        }
        // Seed a new node at an already-placed neighbor so the incremental
        // layout grows the picture outward instead of from the origin.
        const neighbor = graphEdges.find(
          (e) =>
            (e.source === data.id && cy.getElementById(e.target).nonempty()) ||
            (e.target === data.id && cy.getElementById(e.source).nonempty()),
        );
        const anchor = neighbor && cy.getElementById(neighbor.source === data.id ? neighbor.target : neighbor.source);
        cy.add({ group: 'nodes', data, position: anchor ? { ...anchor.position() } : undefined });
        structureChanged = true;
      }
      for (const data of graphEdges) {
        const existing = cy.getElementById(data.id);
        if (existing.nonempty()) {
          existing.data(data);
          continue;
        }
        cy.add({ group: 'edges', data });
        structureChanged = true;
      }
    });
    if (structureChanged && cy.nodes().length > 0) cy.layout(layoutOptions(firstLayout)).run();
  }, [graphNodes, graphEdges]);

  const fitView = useCallback(() => {
    cyRef.current?.fit(undefined, FIT_PADDING);
  }, []);

  useImperativeHandle(ref, () => ({ fitView }), [fitView]);

  return <div ref={containerRef} className="h-full w-full" />;
});
