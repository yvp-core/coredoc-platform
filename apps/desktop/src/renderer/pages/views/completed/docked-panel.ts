/**
 * The docked right panel is one slot with mutually exclusive modes. This module
 * is the whole policy for what may occupy it.
 *
 * Two invariants keep it predictable, and both live here rather than in the view:
 *
 *  1. Every transition is requested from a call site — a click, or a handler
 *     that just started work. Nothing opens the panel from a `useEffect`.
 *     Mount-time catch-up (returning to a project mid-push) is `initialPanel`.
 *  2. A `user` request always wins outright. An `auto` request wins only when
 *     it ranks at least as high as what is already open, so a long-running
 *     push cannot keep stealing the panel back from someone reading Team MCP.
 */
import { GRAPH_MUTATING_ACTIONS, type RunningCommand, type WorkflowAction } from '../../../stores/project-detail-store';

export type DockedPanel =
  | { kind: 'closed' }
  /** Content comes from the explorer's selected node — deliberately no id here. */
  | { kind: 'node-detail' }
  | { kind: 'workspace-graph' }
  | { kind: 'local-mcp' }
  | { kind: 'team-mcp' }
  | { kind: 'terminal'; repoName: string }
  /**
   * The workspace drawer and the terminal side by side while the graph is being
   * rebuilt. The terminal column is dismissible on its own, which leaves the
   * drawer open with its running indicators — hence the sub-state here rather
   * than two kinds. `repoName` is the tab to focus; a batch that has not picked
   * a repo yet leaves it undefined and the terminal falls back to its own list.
   */
  | { kind: 'workspace-running'; repoName?: string; terminalVisible: boolean }
  | { kind: 'review'; repoName: string };

export type PanelKind = DockedPanel['kind'];

export interface PanelRequest {
  /** `user` bypasses the priority ladder entirely; `auto` must outrank. */
  source: 'user' | 'auto';
  panel: DockedPanel;
}

/**
 * Higher wins when two *automatic* opens collide.
 *
 * `review` tops the ladder because a step-1 repo blocks the pipeline on a human
 * decision — nothing downstream proceeds until it is approved. `terminal` and
 * `workspace-running` share a rank — they are the same live output seen through
 * different chrome — and sit above the information panels because they are the
 * only modes showing a live,
 * non-replayable stream; a config panel reads the same five minutes later, a
 * parse log does not. `node-detail` is last because re-opening it costs exactly
 * one click on the node.
 */
export const PANEL_PRIORITY: Record<PanelKind, number> = {
  closed: 0,
  'node-detail': 1,
  'workspace-graph': 2,
  'local-mcp': 2,
  'team-mcp': 2,
  terminal: 3,
  'workspace-running': 3,
  review: 4,
};

export const CLOSED: DockedPanel = { kind: 'closed' };

/** Apply a request to the current panel. */
export function nextPanel(current: DockedPanel, req: PanelRequest): DockedPanel {
  if (req.source === 'user') return req.panel;
  return PANEL_PRIORITY[req.panel.kind] >= PANEL_PRIORITY[current.kind] ? req.panel : current;
}

/**
 * Close the panel only if it is currently showing `kind`. Used by callers that
 * own one mode and must not clobber another — deselecting a graph node closes
 * `node-detail` but must leave a running terminal alone.
 */
export function closeIfKind(current: DockedPanel, kind: PanelKind): DockedPanel {
  return current.kind === kind ? CLOSED : current;
}

/**
 * Toggle a singleton mode: open it, or close it if it is already showing.
 * This is what the top-bar icon buttons do.
 */
export function togglePanel(current: DockedPanel, panel: DockedPanel): DockedPanel {
  return current.kind === panel.kind ? CLOSED : panel;
}

/**
 * Show or hide the terminal column of the running drawer. A no-op on every
 * other kind, so the terminal's own close button can be wired unconditionally.
 */
export function setTerminalVisible(current: DockedPanel, visible: boolean): DockedPanel {
  return current.kind === 'workspace-running' ? { ...current, terminalVisible: visible } : current;
}

/**
 * The three graph-building stages run inside the running drawer. `generate` is
 * graph-mutating too, but its output is an agent transcript rather than a PTY
 * stream, so it keeps the plain terminal and the panel that renders it.
 */
export const RUNNING_DRAWER_ACTIONS: ReadonlySet<WorkflowAction> = new Set<WorkflowAction>([
  'parse',
  'summarize',
  'push',
]);

/** Which panel a freshly started command should claim, if any. */
export function panelForAction(action: WorkflowAction, repoName: string): DockedPanel | null {
  if (RUNNING_DRAWER_ACTIONS.has(action)) return { kind: 'workspace-running', repoName, terminalVisible: true };
  return GRAPH_MUTATING_ACTIONS.has(action) ? { kind: 'terminal', repoName } : null;
}

/**
 * What the panel should show on mount. Covers the "navigated away mid-push and
 * came back" case without an effect — if a graph-mutating command is in flight,
 * its output is the thing worth showing.
 */
export function initialPanel(runningCommands: Map<string, RunningCommand>): DockedPanel {
  for (const command of runningCommands.values()) {
    const panel = panelForAction(command.action, command.repoName);
    if (panel) return panel;
  }
  return CLOSED;
}
