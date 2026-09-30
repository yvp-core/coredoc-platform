import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { CloseCircle } from '@solar-icons/react';
import { RepoTerminalTabs } from '../../../components/RepoTerminalTabs';
import { TerminalBatchActionBar } from '../../../components/TerminalBatchActionBar';
import { ReviewPanel } from '../../../components/ReviewPanel';
import { AgentRunPanel } from '../../../components/agent-run/AgentRunPanel';
import { WorkspaceGraphPanel, type WorkspaceGraphPanelProps } from './panels/WorkspaceGraphPanel';
import { LocalMcpPanel, type LocalMcpPanelProps } from './panels/LocalMcpPanel';
import { TeamMcpPanel } from './panels/TeamMcpPanel';
import { NodeDetailPanel } from '../../../features/explorer/node-detail/NodeDetailPanel';
import { useExplorer } from '../../../features/explorer/explorer-context';
import { useAgentRunStore, type AgentRun } from '../../../stores/agent-run-store';
import type { DockedPanel } from './docked-panel';
import { findAgentRunCommandId } from './agent-run';
import type { RepoDetailState } from '../../../../shared/ipc-types';
import type { ReviewFlowNext, RunningCommand, WorkflowStep } from '../../../stores/project-detail-store';

export interface DockedPanelHostProps {
  panel: DockedPanel;
  onClose: () => void;

  workspaceGraph: WorkspaceGraphPanelProps;
  localMcp: LocalMcpPanelProps;
  /** null when this project has no cloud workspace — the panel is unreachable. */
  teamMcpWorkspaceId: string | null;

  terminal: {
    repoNames: string[];
    activeTerminalRepo: string | null;
    runningCommands: Map<string, RunningCommand>;
    terminalClearCounter: Map<string, number>;
    onSetActiveRepo: (repoName: string | null) => void;
    incompleteStep: WorkflowStep | null;
    repoStates: Map<string, RepoDetailState>;
    onRunBatch: () => void;
    onStopCommand: (commandId: string) => void;
    onStopAll: () => void;
  };

  review: {
    flowNext: ReviewFlowNext | null;
    onApproved: () => void;
    onApproveAndNext: () => Promise<void>;
    onRegenerate: (repoName: string, feedback: string) => void;
  };
}

/**
 * The single docked slot on the right.
 *
 * Absolutely positioned so it overlays the tab body rather than reflowing it —
 * the graph canvas is pannable and should stay put when the panel opens.
 */
/** ReviewPanel carries data tables and a multi-button footer; 344px clips it. */
const PANEL_WIDTH: Partial<Record<DockedPanel['kind'], string>> = { review: 'w-[512px]' };

export function DockedPanelHost({
  panel,
  onClose,
  workspaceGraph,
  localMcp,
  teamMcpWorkspaceId,
  terminal,
  review,
}: DockedPanelHostProps) {
  const agentRuns = useAgentRunStore((state) => state.runs);

  if (panel.kind === 'closed') return null;

  if (panel.kind === 'workspace-running') {
    return <RunningPanel panel={panel} onClose={onClose} {...{ workspaceGraph, terminal }} />;
  }

  return (
    // Glass per the design: an 8px backdrop blur under a white gradient that
    // fades 0.80 → 0.66 top-to-bottom, hairline zinc-50 border, and the flattest
    // of the six elevations. It reads as a pane lifted just off the canvas — a
    // heavier blur or a near-opaque fill would sever it from the graph beneath,
    // which is the thing it is describing.
    <div
      className={cn(
        'surface-a absolute inset-y-0 right-0 z-20 flex flex-col gap-0.5 overflow-clip rounded-xl border border-border-secondary pt-1.5 pb-4',
        PANEL_WIDTH[panel.kind] ?? 'w-[344px]',
      )}
    >
      <CloseBar label="Close panel" onClose={onClose} />
      <PanelBody
        panel={panel}
        workspaceGraph={workspaceGraph}
        localMcp={localMcp}
        teamMcpWorkspaceId={teamMcpWorkspaceId}
        terminal={terminal}
        review={review}
        agentRuns={agentRuns}
      />
    </div>
  );
}

function CloseBar({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div className="flex shrink-0 justify-end px-3.5 pt-2.5">
      <button
        type="button"
        aria-label={label}
        onClick={onClose}
        className="cursor-pointer text-content-tertiary transition-colors hover:text-content-primary"
      >
        <CloseCircle className="size-6" />
      </button>
    </div>
  );
}

/**
 * The graph-update drawer: the workspace column and the terminal side by side
 * under one sticky footer.
 *
 * Deliberately not the shared shell above. The terminal column has to sit
 * *outside* the blurred surface — a backdrop-filter over a 60fps PTY stream
 * repaints the whole pane on every frame — so the glass is scoped to the left
 * column and the terminal is an opaque sibling. The 344↔768 width switch is
 * also unanimated on purpose: animating it would fire the terminal's
 * ResizeObserver once per frame of the transition.
 */
function RunningPanel({
  panel,
  onClose,
  workspaceGraph,
  terminal,
}: {
  panel: Extract<DockedPanel, { kind: 'workspace-running' }>;
  onClose: () => void;
  workspaceGraph: WorkspaceGraphPanelProps;
  terminal: DockedPanelHostProps['terminal'];
}) {
  const repoNames = terminal.repoNames.length > 0 ? terminal.repoNames : panel.repoName ? [panel.repoName] : [];

  return (
    <div
      className={cn(
        'absolute inset-y-0 right-0 z-20 flex gap-0.5 rounded-xl border border-border-secondary',
        // ONE drawer that widens, not two panels side by side. With the terminal open
        // the drawer is a single OPAQUE white surface: perf rule 4 forbids the terminal
        // sitting under a backdrop-filter, and an opaque fill has none — so the glass is
        // dropped in this state rather than the drawer being split into two chromes,
        // each with its own background and its own close button.
        panel.terminalVisible ? 'w-[768px] bg-bg-primary shadow-foundation' : 'surface-a w-[344px]',
      )}
    >
      <div
        className={cn(
          'flex w-[344px] shrink-0 flex-col gap-0.5 overflow-clip pt-1.5 pb-[46px]',
          // The column carries the drawer's chrome only when it IS the drawer.
          panel.terminalVisible ? '' : 'rounded-xl',
        )}
      >
        {panel.terminalVisible ? (
          // The single close button lives at the drawer's top-right, which is over the
          // terminal column. This spacer keeps both columns' content on the same
          // baseline under it — the height matches CloseBar's 24px glyph + 10px pad.
          <div aria-hidden className="h-[34px] shrink-0" />
        ) : (
          <CloseBar label="Close panel" onClose={onClose} />
        )}
        {/* This is the one host with a footer Stop — see WorkspaceGraphPanel. */}
        <WorkspaceGraphPanel {...workspaceGraph} stopInFooter />
      </div>

      {panel.terminalVisible && (
        <div className="flex min-w-0 flex-1 flex-col gap-2 pr-5 pb-[46px]">
          <CloseBar label="Close panel" onClose={onClose} />
          <div className="flex min-h-0 flex-1 flex-col">
            <RepoTerminalTabs
              repoNames={repoNames}
              activeTerminalRepo={terminal.activeTerminalRepo}
              runningCommands={terminal.runningCommands}
              terminalClearCounter={terminal.terminalClearCounter}
              onSetActiveRepo={terminal.onSetActiveRepo}
              hideTabs={repoNames.length <= 1}
            />
          </div>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0">
        <TerminalBatchActionBar
          currentStep={terminal.incompleteStep}
          repoStates={terminal.repoStates}
          runningCommands={terminal.runningCommands}
          onRunBatch={terminal.onRunBatch}
          onStopAll={terminal.onStopAll}
        />
      </div>
    </div>
  );
}

/**
 * Reads the selected node from the explorer rather than carrying an id on the
 * panel state — one source of truth, so deselect / removal / source-switch all
 * collapse the panel for free instead of needing a reconciliation effect.
 */
function SelectedNodeDetail() {
  const { scope, selectedNode, traverseSubgraph } = useExplorer();
  if (!selectedNode) {
    return (
      <p className="px-4 pb-4 text-xs leading-4 text-content-quaternary">Select a node on the canvas to inspect it.</p>
    );
  }
  return (
    <NodeDetailPanel
      scope={scope}
      node={selectedNode}
      onTraverse={(depth) => void traverseSubgraph(selectedNode.id, depth)}
    />
  );
}

function PanelBody({
  panel,
  workspaceGraph,
  localMcp,
  teamMcpWorkspaceId,
  terminal,
  review,
  agentRuns,
}: Omit<DockedPanelHostProps, 'onClose'> & { agentRuns: Map<string, AgentRun> }): ReactNode {
  switch (panel.kind) {
    case 'workspace-graph':
      return <WorkspaceGraphPanel {...workspaceGraph} />;

    case 'terminal': {
      const agentRunCommandId = findAgentRunCommandId(panel.repoName, terminal.runningCommands, agentRuns);
      if (agentRunCommandId) {
        return <AgentRunPanel commandId={agentRunCommandId} repoName={panel.repoName} />;
      }

      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-1.5">
            <RepoTerminalTabs
              repoNames={terminal.repoNames.length > 0 ? terminal.repoNames : [panel.repoName]}
              activeTerminalRepo={terminal.activeTerminalRepo}
              runningCommands={terminal.runningCommands}
              terminalClearCounter={terminal.terminalClearCounter}
              onSetActiveRepo={terminal.onSetActiveRepo}
              hideTabs={terminal.repoNames.length <= 1}
            />
          </div>
          <TerminalBatchActionBar
            currentStep={terminal.incompleteStep}
            repoStates={terminal.repoStates}
            runningCommands={terminal.runningCommands}
            onRunBatch={terminal.onRunBatch}
            onStopAll={terminal.onStopAll}
          />
        </div>
      );
    }

    case 'review':
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2">
          <ReviewPanel
            repoName={panel.repoName}
            flowNext={review.flowNext}
            onApproved={review.onApproved}
            onApproveAndNext={review.onApproveAndNext}
            onRegenerate={(feedback) => review.onRegenerate(panel.repoName, feedback)}
          />
        </div>
      );

    case 'local-mcp':
      return <LocalMcpPanel {...localMcp} />;

    case 'team-mcp':
      return teamMcpWorkspaceId ? <TeamMcpPanel workspaceId={teamMcpWorkspaceId} /> : null;

    case 'node-detail':
      return <SelectedNodeDetail />;

    default:
      return null;
  }
}
