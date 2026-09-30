/**
 * Shared visual vocabulary for the graph explorer. One color legend keyed by
 * NodeType string value, plus edge styling derived from confidence +
 * provenance (solid = parser 1.0, dashed = AI-inferred, opacity ∝ confidence —
 * docs/web-ui-plan-2026-07.md §3.3). Keyed by the raw string values so nothing
 * runtime enters from @coredoc/core (types stay erased).
 *
 * Colors are theme-aware: each lookup reads the `--n-*` / `--edge-*` custom
 * properties from the token layer (styles.css) at paint time, falling back to
 * the static dark-theme palette below. The explorer renders to canvas, which needs a
 * resolved literal color — `var()` strings can't be painted — hence
 * getComputedStyle rather than utility classes. In tests (happy-dom, no app
 * CSS loaded) unset properties resolve to '' and the fallbacks win, so
 * assertions stay deterministic.
 */

/** NodeType string value → accent color (dark-theme fallbacks; the live value
 *  comes from the `--n-<type>` token so `.light` can re-tune the palette). */
export const NODE_TYPE_COLORS: Record<string, string> = {
  repository: '#8A97A6',
  package: '#6E7C90',
  file: '#586576',
  function: '#5B9DFF',
  class: '#A78BFA',
  interface: '#8C7BF0',
  type_alias: '#7FB6A6',
  enum: '#C7B36B',
  variable: '#9AA6B4',
  entrypoint: '#FF7A66',
  entity: '#F2C14E',
  external_call: '#F26FB3',
  component: '#3DD6C4',
  route: '#4FC3FF',
  state_store: '#E08AF0',
};

/** Idle grey — deliberately NOT the repository grey, so an unknown type never
 *  masquerades as a repository in the legend. */
export const DEFAULT_NODE_COLOR = '#66727F';

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function nodeColor(type: string): string {
  return cssVar(`--n-${type}`, NODE_TYPE_COLORS[type] ?? DEFAULT_NODE_COLOR);
}

/** Node/edge caption text color on the explorer canvas. */
export function captionColor(): string {
  return cssVar('--graph-caption', '#27272A');
}

/** Ring color of the selected node on the explorer canvas. */
export function selectionColor(): string {
  return cssVar('--graph-selection', '#2563EB');
}

/** Human label for a NodeType/EdgeType string value ('state_store' → 'state store'). */
export function humanizeType(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase();
}

export interface EdgeVisualStyle {
  /** SVG dash pattern — undefined (solid) for parser facts, dashed for AI. */
  strokeDasharray?: string;
  /** Stroke opacity ∝ confidence, floored so faint edges stay visible. */
  opacity: number;
  /** Stroke color. */
  stroke: string;
}

const PARSER_EDGE = '#546074';
const AI_EDGE = '#5B9DFF';
const HUMAN_EDGE = '#3FB950';
const CROSS_REPO_EDGE = '#F5B841';

/**
 * Cross-repo bridge color (gold). A RESOLVES_TO edge is the one edge kind that
 * spans a repo boundary (external_call → downstream entrypoint), so it gets a
 * distinct, heavier stroke to stand out from intra-repo edges on the canvas.
 */
export function crossRepoEdgeColor(): string {
  return cssVar('--edge-crossrepo', CROSS_REPO_EDGE);
}

/**
 * Derive an edge's stroke from its provenance + confidence. Parser edges (1.0)
 * render solid grey; AI-inferred edges render dashed blue with opacity scaled
 * to confidence; human edges render solid green.
 */
export function edgeStyle(confidence: number, createdBy: 'parser' | 'ai' | 'human'): EdgeVisualStyle {
  const opacity = Math.max(0.35, Math.min(1, confidence));
  if (createdBy === 'human') return { stroke: cssVar('--edge-human', HUMAN_EDGE), opacity };
  if (createdBy === 'ai') return { stroke: cssVar('--edge-ai', AI_EDGE), opacity, strokeDasharray: '6 4' };
  return { stroke: cssVar('--edge-parser', PARSER_EDGE), opacity };
}
