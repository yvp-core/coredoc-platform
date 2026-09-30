import { describe, expect, it } from 'vitest';
import type { RunningCommand, WorkflowAction } from '../../../stores/project-detail-store';
import {
  CLOSED,
  PANEL_PRIORITY,
  type DockedPanel,
  closeIfKind,
  initialPanel,
  nextPanel,
  panelForAction,
  RUNNING_DRAWER_ACTIONS,
  setTerminalVisible,
  togglePanel,
} from './docked-panel.js';

const TEAM_MCP: DockedPanel = { kind: 'team-mcp' };
const NODE: DockedPanel = { kind: 'node-detail' };
const TERMINAL: DockedPanel = { kind: 'terminal', repoName: 'api' };
const REVIEW: DockedPanel = { kind: 'review', repoName: 'api' };
const RUNNING: DockedPanel = { kind: 'workspace-running', repoName: 'api', terminalVisible: true };

const ALL: DockedPanel[] = [
  CLOSED,
  NODE,
  { kind: 'workspace-graph' },
  { kind: 'local-mcp' },
  TEAM_MCP,
  TERMINAL,
  RUNNING,
  REVIEW,
];

function command(repoName: string, action: WorkflowAction): RunningCommand {
  return { id: `${repoName}:${action}`, repoName, action, startedAt: '2026-07-26T00:00:00Z', origin: 'single' };
}

describe('nextPanel', () => {
  it('lets a user request win from every state', () => {
    for (const current of ALL) {
      expect(nextPanel(current, { source: 'user', panel: TEAM_MCP })).toEqual(TEAM_MCP);
    }
  });

  it('lets a user request close the panel even while a review is open', () => {
    expect(nextPanel(REVIEW, { source: 'user', panel: CLOSED })).toEqual(CLOSED);
  });

  it('promotes an auto request over a lower-ranked panel', () => {
    expect(nextPanel(TEAM_MCP, { source: 'auto', panel: TERMINAL })).toEqual(TERMINAL);
    expect(nextPanel(TERMINAL, { source: 'auto', panel: REVIEW })).toEqual(REVIEW);
  });

  it('refuses an auto request that ranks below what is open', () => {
    expect(nextPanel(REVIEW, { source: 'auto', panel: TERMINAL })).toEqual(REVIEW);
    expect(nextPanel(TERMINAL, { source: 'auto', panel: NODE })).toEqual(TERMINAL);
    expect(nextPanel(TEAM_MCP, { source: 'auto', panel: NODE })).toEqual(TEAM_MCP);
  });

  it('is idempotent for repeated auto requests of the same kind', () => {
    const once = nextPanel(CLOSED, { source: 'auto', panel: TERMINAL });
    const twice = nextPanel(once, { source: 'auto', panel: TERMINAL });
    expect(twice).toEqual(once);
  });

  it('lets an auto request of equal rank replace the current panel', () => {
    // A second repo starting a push retargets the terminal rather than being dropped.
    const other: DockedPanel = { kind: 'terminal', repoName: 'web' };
    expect(nextPanel(TERMINAL, { source: 'auto', panel: other })).toEqual(other);
  });

  it('never re-opens a panel the user closed, when the auto request outranks nothing', () => {
    expect(nextPanel(CLOSED, { source: 'auto', panel: NODE })).toEqual(NODE);
  });
});

describe('priority ladder regressions', () => {
  // Three review findings traced back to the same shape: a caller cleared the
  // review and asked for the terminal in one batch, so the auto request was
  // compared against the still-open review and refused.
  it('refuses an auto terminal while a review is still open', () => {
    expect(nextPanel(REVIEW, { source: 'auto', panel: TERMINAL })).toEqual(REVIEW);
  });

  it('hands off review -> terminal in one batch, because the handoff is a user gesture', () => {
    // The real sequence: closing the review only QUEUES its state update, so a
    // request issued in the same batch still sees {kind:'review'} committed. An
    // 'auto' request would lose the comparison and the mirror effect would then
    // close the slot, leaving a blank panel over a running command. The click
    // that starts the work is a user gesture, so it bypasses the ladder.
    expect(nextPanel(REVIEW, { source: 'auto', panel: TERMINAL })).toEqual(REVIEW);
    expect(nextPanel(REVIEW, { source: 'user', panel: TERMINAL })).toEqual(TERMINAL);
  });

  it('survives the mirror effect that runs after the handoff', () => {
    // reviewingRepo is now null, so the effect calls closeIfKind(_, 'review').
    // It must not close a terminal that already claimed the slot.
    const afterHandoff = nextPanel(REVIEW, { source: 'user', panel: TERMINAL });
    expect(closeIfKind(afterHandoff, 'review')).toEqual(TERMINAL);
  });

  it('lets a user re-request the same review after the panel was replaced', () => {
    // The mirror effect only fires when reviewingRepo *changes*, so the call
    // site has to claim the slot itself — as a user request, which always wins.
    const replaced = nextPanel(REVIEW, { source: 'user', panel: TEAM_MCP });
    expect(nextPanel(replaced, { source: 'user', panel: REVIEW })).toEqual(REVIEW);
  });

  it('lets a user reopen a terminal they dismissed while the run continues', () => {
    const dismissed = nextPanel(TERMINAL, { source: 'user', panel: CLOSED });
    expect(nextPanel(dismissed, { source: 'user', panel: TERMINAL })).toEqual(TERMINAL);
  });
});

describe('closeIfKind', () => {
  it('closes only the matching kind', () => {
    expect(closeIfKind(NODE, 'node-detail')).toEqual(CLOSED);
    expect(closeIfKind(TERMINAL, 'node-detail')).toEqual(TERMINAL);
    expect(closeIfKind(CLOSED, 'node-detail')).toEqual(CLOSED);
  });

  it('leaves a running drawer alone when another kind is asked to close', () => {
    expect(closeIfKind(RUNNING, 'review')).toEqual(RUNNING);
    expect(closeIfKind(RUNNING, 'workspace-running')).toEqual(CLOSED);
  });
});

describe('workspace-running', () => {
  it('ranks at least as high as the terminal, so a run in flight is never outranked by it', () => {
    expect(PANEL_PRIORITY['workspace-running']).toBeGreaterThanOrEqual(PANEL_PRIORITY.terminal);
  });

  it('takes the slot from the information panels on an auto request', () => {
    expect(nextPanel(TEAM_MCP, { source: 'auto', panel: RUNNING })).toEqual(RUNNING);
    expect(nextPanel({ kind: 'workspace-graph' }, { source: 'auto', panel: RUNNING })).toEqual(RUNNING);
  });

  it('still yields the slot to a review, which blocks the pipeline on a human', () => {
    expect(nextPanel(REVIEW, { source: 'auto', panel: RUNNING })).toEqual(REVIEW);
  });

  it('dismisses the terminal column without closing the drawer', () => {
    expect(setTerminalVisible(RUNNING, false)).toEqual({
      kind: 'workspace-running',
      repoName: 'api',
      terminalVisible: false,
    });
  });

  it('re-opens the terminal column it dismissed', () => {
    const hidden = setTerminalVisible(RUNNING, false);
    expect(setTerminalVisible(hidden, true)).toEqual(RUNNING);
  });

  it('ignores a terminal-visibility change on any other kind', () => {
    expect(setTerminalVisible(TERMINAL, false)).toEqual(TERMINAL);
    expect(setTerminalVisible(CLOSED, true)).toEqual(CLOSED);
  });

  it('is closed by a user request like any other kind', () => {
    expect(nextPanel(RUNNING, { source: 'user', panel: CLOSED })).toEqual(CLOSED);
    expect(togglePanel(RUNNING, RUNNING)).toEqual(CLOSED);
  });
});

describe('RUNNING_DRAWER_ACTIONS', () => {
  // The view derives its running-stage label from this set, so it has to stay
  // exactly the actions the drawer renders — `generate` leaking in would put the
  // drawer in a running state whose output lives in the agent-run terminal.
  it('is the three graph-building stages and nothing else', () => {
    expect([...RUNNING_DRAWER_ACTIONS].sort()).toEqual(['parse', 'push', 'summarize']);
  });

  it('agrees with panelForAction on which actions claim the running drawer', () => {
    for (const action of ['parse', 'summarize', 'push', 'generate', 'docs'] as const) {
      expect(panelForAction(action, 'api')?.kind === 'workspace-running').toBe(RUNNING_DRAWER_ACTIONS.has(action));
    }
  });
});

describe('panelForAction', () => {
  it('opens the running drawer for the graph-building actions', () => {
    for (const action of ['parse', 'summarize', 'push'] as const) {
      expect(panelForAction(action, 'api')).toEqual({
        kind: 'workspace-running',
        repoName: 'api',
        terminalVisible: true,
      });
    }
  });

  it('keeps the plain terminal for generate, whose output is the agent-run panel', () => {
    expect(panelForAction('generate', 'api')).toEqual(TERMINAL);
  });

  it('claims nothing for actions that do not mutate the graph', () => {
    expect(panelForAction('docs', 'api')).toBeNull();
    expect(panelForAction('cloud-docs', 'api')).toBeNull();
  });
});

describe('togglePanel', () => {
  it('opens when closed and closes when already showing that kind', () => {
    expect(togglePanel(CLOSED, TEAM_MCP)).toEqual(TEAM_MCP);
    expect(togglePanel(TEAM_MCP, TEAM_MCP)).toEqual(CLOSED);
  });

  it('switches when a different kind is showing', () => {
    expect(togglePanel(NODE, TEAM_MCP)).toEqual(TEAM_MCP);
  });
});

describe('initialPanel', () => {
  it('is closed when nothing is running', () => {
    expect(initialPanel(new Map())).toEqual(CLOSED);
  });

  it('opens the running drawer for a graph-building command in flight', () => {
    const running = new Map([['1', command('api', 'push')]]);
    expect(initialPanel(running)).toEqual({ kind: 'workspace-running', repoName: 'api', terminalVisible: true });
  });

  it('opens the plain terminal for a generate in flight', () => {
    const running = new Map([['1', command('api', 'generate')]]);
    expect(initialPanel(running)).toEqual({ kind: 'terminal', repoName: 'api' });
  });

  it('ignores docs commands, which do not mutate the graph', () => {
    const running = new Map([['1', command('api', 'docs')]]);
    expect(initialPanel(running)).toEqual(CLOSED);
  });
});
