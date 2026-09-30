/**
 * Pure mapping from the viz graph model (VizNode/VizEdge) to Cytoscape element
 * definitions. Split out from the canvas component so the shape + styling logic
 * is unit-testable without mounting a renderer (which needs a real canvas).
 *
 * Type-only imports from @coredoc/core by design — no enum enters the browser
 * bundle. Colors are keyed by the raw NodeType/EdgeType string values, and edge
 * styling reuses the shared provenance/confidence vocabulary in viz-style:
 * provenance rides on COLOR and dash (AI edges dashed), confidence on stroke
 * WIDTH and opacity.
 *
 * Styles read these `data()` fields (see explorer-canvas.tsx); resolved literal
 * colors go into data because the canvas renderer can't paint `var()` strings.
 */

import type { VizEdge, VizNode } from '@coredoc/core';
import { crossRepoEdgeColor, edgeStyle, humanizeType, nodeColor } from './viz-style.js';

export interface GraphNodeData {
  id: string;
  caption: string;
  color: string;
  selected: boolean;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  caption: string;
  color: string;
  width: number;
  opacity: number;
  lineStyle: 'solid' | 'dashed';
}

/** Uniform node diameter — every node renders the same size; type is conveyed by
 *  color + caption, not size. */
export const NODE_SIZE = 40;

/**
 * Edge stroke width ∝ confidence: 1.0px at confidence 0 up to 4.0px at
 * confidence 1.0. Clamped so out-of-range scores stay in the visible band.
 */
export function edgeWidth(confidence: number): number {
  const c = Math.max(0, Math.min(1, confidence));
  return Math.round((1 + c * 3) * 10) / 10;
}

export function toGraphNode(node: VizNode, selectedId: string | null): GraphNodeData {
  return {
    id: node.id,
    caption: node.name,
    color: nodeColor(node.type),
    selected: node.id === selectedId,
  };
}

/**
 * Map a VizEdge to a graph edge. `crossRepo` (a RESOLVES_TO edge whose ends live
 * in different repos) overrides the provenance color with the gold bridge color,
 * draws it solid and opaque, and floors the width so the cross-service link
 * stands out.
 */
export function toGraphEdge(edge: VizEdge, crossRepo = false): GraphEdgeData {
  const { stroke, opacity, strokeDasharray } = edgeStyle(edge.confidence, edge.createdBy);
  const width = edgeWidth(edge.confidence);
  return {
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    caption: humanizeType(edge.type),
    color: crossRepo ? crossRepoEdgeColor() : stroke,
    width: crossRepo ? Math.max(width, 2.5) : width,
    opacity: crossRepo ? 1 : opacity,
    lineStyle: !crossRepo && strokeDasharray ? 'dashed' : 'solid',
  };
}
