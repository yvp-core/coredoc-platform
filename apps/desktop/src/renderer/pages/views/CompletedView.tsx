import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getApplicableRepos,
  type ContextSelection,
  type RunningCommand,
  type WorkflowAction,
  type WorkflowStep,
} from '../../stores/project-detail-store';
import { useAuthStore } from '../../stores/auth-store';
import { useCloudProjectDetailStore } from '../../stores/cloud-project-detail-store';
import { RegenerateDialog } from '../../components/RegenerateDialog';
import { Button } from '../../components/ui/button';
import { ChatPanel } from '../../components/ChatPanel';
import { ContextSourceDropdown } from '../../components/ContextSourceDropdown';
import { ConnectTeamMcpWizard } from '../../components/ConnectTeamMcpWizard';
import { IntentPanel } from '../../features/intent/IntentPanel';
import { useIntentPendingCount } from '../../features/intent/use-intent-pending-review';
import { AnalyticsPanel } from '../../features/observability/AnalyticsPanel';
import { ExplorerProvider } from '../../features/explorer/explorer-context';
import { ExplorerLeftPanelBody } from '../../features/explorer/left-panel/ExplorerLeftPanelBody';
import { GraphQueryProvider } from '../../lib/graph-query-client';
import { cn } from '../../lib/utils';
import type { ChatSessionMeta, RepoDetailState } from '../../../shared/ipc-types';
import type { Project } from '../../types/project';

import { CompletedTab, CompletedTopBar, type CompletedTopBarProps } from './completed/CompletedTopBar';
import { CompletedLeftPanel } from './completed/CompletedLeftPanel';
import { StaleGraphBanner } from './completed/StaleGraphBanner';
import { DockedPanelHost } from './completed/DockedPanelHost';
import { ChatLeftPanelBody } from './completed/left/ChatLeftPanelBody';
import { GraphTab } from './completed/tabs/GraphTab';
import {
  CLOSED,
  closeIfKind,
  type DockedPanel,
  initialPanel,
  nextPanel,
  panelForAction,
  togglePanel,
} from './completed/docked-panel';
import { bannerVisibility, deriveWorkspaceFacts } from './completed/workspace-facts';
import { useCloudSync } from './completed/use-cloud-sync';
import { useReviewFlow } from './completed/use-review-flow';

export interface CompletedViewProps {
  project: Project;
  repoStates: Map<string, RepoDetailState>;
  runningCommands: Map<string, RunningCommand>;
  canceledRepos: Set<string>;
  activeTerminalRepo: string | null;
  terminalClearCounter: Map<string, number>;
  isLoading: boolean;
  contextSelection: ContextSelection;
  setContextSelection: (ctx: ContextSelection) => void;
  runCommand: (
    repoName: string,
    action: WorkflowAction,
    args?: Record<string, unknown>,
    origin?: 'single' | 'batch',
  ) => Promise<void>;
  cancelCommand: (commandId: string) => Promise<void>;
  cancelAllCommands: () => Promise<void>;
  runBatchCommand: (step: WorkflowStep) => Promise<void>;
  setActiveTerminalRepo: (repoName: string | null) => void;
  onAddRepo: () => void;
  onRemoveRepo: (repoName: string) => void;
  sessions: ChatSessionMeta[];
  sessionId: string | null;
  onNewSession: () => Promise<void>;
  onSelectSession: (id: string) => Promise<void>;
  onRenameSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNavigateHome: () => void;
  onRenameProject: (newName: string) => Promise<void>;
  isCloudMember?: boolean;
  cloudWorkspaceId?: string;
}

/** Tabs that have a contextual left panel. Analytics and Intent are full-bleed. */
const TAB_HAS_LEFT_PANEL: Record<CompletedTab, boolean> = {
  [CompletedTab.Graph]: true,
  [CompletedTab.Chat]: true,
  [CompletedTab.Intent]: false,
  [CompletedTab.Analytics]: false,
};

export function CompletedView({
  project,
  repoStates,
  runningCommands,
  activeTerminalRepo,
  terminalClearCounter,
  contextSelection,
  setContextSelection,
  runCommand,
  cancelCommand,
  cancelAllCommands,
  runBatchCommand,
  setActiveTerminalRepo,
  onAddRepo,
  onRemoveRepo,
  sessions,
  sessionId,
  onNewSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onRenameProject,
  isCloudMember,
  cloudWorkspaceId,
}: CompletedViewProps) {
  // Graph, not Chat: entering a workspace should land on the thing the workspace IS.
  // Chat is an action taken against the graph, so it cannot be the resting state.
  const [activeTab, setActiveTab] = useState<CompletedTab>(CompletedTab.Graph);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [panel, setPanel] = useState<DockedPanel>(() => initialPanel(runningCommands));
  const [staleDismissed, setStaleDismissed] = useState(false);
  const [regenerateRepo, setRegenerateRepo] = useState<string | null>(null);
  const [teamMcpWizardOpen, setTeamMcpWizardOpen] = useState(false);
  // Set when a Team MCP click had to detour through login; the effect below
  // resumes the flow once auth lands.
  const [pendingTeamMcp, setPendingTeamMcp] = useState(false);

  const { isLoggedIn, login, email } = useAuthStore();
  const cloudStore = useCloudProjectDetailStore();

  const facts = useMemo(
    () => deriveWorkspaceFacts(project, repoStates, runningCommands),
    [project, repoStates, runningCommands],
  );
  const {
    incompleteRepos,
    incompleteStep,
    isGraphUpdating,
    runningRepoNames,
    runningStageByRepo,
    allSynced,
    anySynced,
    staleRepos,
    latestPush,
  } = facts;

  const cloudEnabled = project.cloud?.enabled === true;
  // Always the project's own workspace — never the global selection. Cloud
  // members carry it on cloudMember, owners on cloud.
  const projectWorkspaceId = project.cloudMember?.workspaceId ?? project.cloud?.workspaceId ?? null;
  const explorerIsCloud = cloudEnabled || !!isCloudMember;

  const {
    cloudOutdated,
    syncing,
    ciCdEnabled,
    workspace: projectWorkspace,
    syncToCloud,
  } = useCloudSync({
    project,
    allSynced,
    latestPush,
    projectWorkspaceId,
    cloudEnabled,
    isCloudMember: !!isCloudMember,
    isLoggedIn,
  });

  /** Every panel transition goes through here — see docked-panel.ts. */
  const openPanel = useCallback((next: DockedPanel, source: 'user' | 'auto' = 'user') => {
    setPanel((current) => nextPanel(current, { source, panel: next }));
  }, []);
  const reviewFlow = useReviewFlow({
    project,
    repoStates,
    runningCommands,
    incompleteRepos,
    incompleteStep,
    runBatchCommand,
    setContextSelection,
    setActiveTerminalRepo,
    // Same reasoning as startRepoWork: approve/regenerate are user gestures,
    // and the review they are leaving is still committed when this runs. Which
    // chrome to open follows the command actually blocking the flow — a
    // `generate` transcript belongs in the plain terminal, not the running
    // drawer — with the terminal as the fallback when nothing is in flight yet.
    requestTerminal: (repoName) => {
      const cmd = Array.from(runningCommands.values()).find((c) => c.repoName === repoName);
      openPanel((cmd && panelForAction(cmd.action, repoName)) || { kind: 'terminal', repoName });
    },
  });

  // The review flow owns *which* repo is under review; the panel owns whether it
  // is on screen. Mirroring one into the other here keeps both call sites honest
  // without a second source of truth.
  const closeReview = reviewFlow.closeReview;
  const closePanel = useCallback(() => {
    // Closing the review panel must also end the review, or the mirror effect
    // below would re-open it on the next render.
    setPanel((current) => {
      if (current.kind === 'review') closeReview();
      return CLOSED;
    });
  }, [closeReview]);

  /**
   * node-detail is the one panel mode that belongs to a single tab: it inspects
   * the graph canvas's selection, and Chat/Analytics have no canvas to inspect.
   * Leaving it docked there would strand a panel describing something offscreen,
   * so switching tabs releases the slot. Every other mode (a running terminal, a
   * review, an MCP config) is workspace-scoped and survives the switch.
   */
  const changeTab = useCallback((tab: CompletedTab) => {
    setActiveTab(tab);
    if (tab !== CompletedTab.Graph) setPanel((current) => closeIfKind(current, 'node-detail'));
  }, []);

  // Analytics is gated per workspace while the surface is unstable (pre-redesign,
  // no connector UI). Fail closed: no workspace row (local-only project, list not
  // loaded yet) means disabled.
  const analyticsAvailable = projectWorkspace?.deliveryEnabled === true;
  useEffect(() => {
    // Only reachable when the flag flips off mid-session (the trigger is
    // disabled otherwise); snap back so the tab never renders gated content.
    if (!analyticsAvailable && activeTab === CompletedTab.Analytics) setActiveTab(CompletedTab.Graph);
  }, [analyticsAvailable, activeTab]);

  // Intent is workspace-scoped AND gated per workspace, so the tab exists exactly
  // when this project has a cloud workspace and that workspace has intentEnabled.
  // Fail closed like Analytics: no workspace row (local-only project, list not
  // loaded yet) or the flag off means disabled. Same snap-back reason too: the
  // workspace row can disappear mid-session (sign-out, workspace deleted, flag
  // flipped) and the tab must not be left rendering a surface it may not read.
  const intentAvailable = projectWorkspace?.intentEnabled === true;
  useEffect(() => {
    if (!intentAvailable && activeTab === CompletedTab.Intent) setActiveTab(CompletedTab.Graph);
  }, [intentAvailable, activeTab]);

  const reviewingRepo = reviewFlow.reviewingRepo;
  useEffect(() => {
    if (reviewingRepo === null) {
      setPanel((current) => closeIfKind(current, 'review'));
      return;
    }
    setPanel((current) => nextPanel(current, { source: 'auto', panel: { kind: 'review', repoName: reviewingRepo } }));
  }, [reviewingRepo]);

  // A command can start from OUTSIDE this view — the add-repository dialog kicks one
  // off the moment it closes — and until now only mount-time `initialPanel` ever
  // looked at the running set. A run started while this view was already open
  // produced no visible output at all: the dialog shut, work began, and the UI said
  // nothing. Watching the set covers every such entry point at once instead of
  // patching each caller. Requested as 'auto', so a panel the user opened
  // deliberately still outranks it on the priority ladder.
  const announcedCommandIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const [id, command] of runningCommands) {
      if (announcedCommandIds.current.has(id)) continue;
      announcedCommandIds.current.add(id);
      const next = panelForAction(command.action, command.repoName);
      if (next) openPanel(next, 'auto');
    }
    // Drop finished ids so re-running the same repo opens its panel again.
    for (const id of announcedCommandIds.current) {
      if (!runningCommands.has(id)) announcedCommandIds.current.delete(id);
    }
  }, [runningCommands, openPanel]);

  // Reset the context selection if the selected repo leaves the project.
  useEffect(() => {
    if (contextSelection.kind !== 'repo') return;
    if (!project.repositories.some((r) => r.name === contextSelection.repoName)) {
      setContextSelection({ kind: 'project' });
    }
  }, [project.repositories, contextSelection, setContextSelection]);

  // Auto-continue after login completes (Team MCP flow).
  useEffect(() => {
    if (isCloudMember || !isLoggedIn || !pendingTeamMcp) return;
    setPendingTeamMcp(false);
    if (cloudEnabled && projectWorkspaceId) {
      setPanel({ kind: 'team-mcp' });
      return;
    }
    setTeamMcpWizardOpen(true);
  }, [isLoggedIn, pendingTeamMcp, isCloudMember, cloudEnabled, projectWorkspaceId]);

  // Cloud members link a workspace repo to a local folder; without this the
  // Analytics tab has no repo paths and cloud chat has no file tools.
  const handleLinkRepo = useCallback(
    async (repoName: string) => {
      if (!cloudWorkspaceId) return;
      const result = await window.electronAPI.linkRepo(cloudWorkspaceId, repoName);
      if (result.success && !result.canceled) {
        await cloudStore.refreshLinkedRepos();
      }
    },
    [cloudWorkspaceId, cloudStore],
  );

  const handleUnlinkRepo = useCallback(
    async (repoName: string) => {
      if (!cloudWorkspaceId) return;
      await window.electronAPI.removeLinkedRepo(cloudWorkspaceId, repoName);
      await cloudStore.refreshLinkedRepos();
    },
    [cloudWorkspaceId, cloudStore],
  );

  const startRepoWork = useCallback(
    (repoName: string, action: WorkflowAction, args?: Record<string, unknown>) => {
      const panelForWork = panelForAction(action, repoName);
      if (panelForWork) {
        setActiveTerminalRepo(repoName);
        // 'user', not 'auto': the click that started this work is the same
        // click that should surface its output. An 'auto' request would lose
        // the priority comparison to a review panel that is closing in this
        // very batch — closeReview() only queues its state update, so the
        // updater still sees {kind:'review'} — and the mirror effect would
        // then close the slot, leaving a blank panel over a running command.
        openPanel(panelForWork);
      }
      void runCommand(repoName, action, args);
    },
    [runCommand, setActiveTerminalRepo, openPanel],
  );

  // runBatchCommand(3) only touches repos whose outstanding step is 3, so that
  // is the predicate for "the Update-graph CTA will actually do something".
  const canUpdateGraph = !isCloudMember && getApplicableRepos(repoStates, 3).length > 0;

  const handleUpdateGraph = useCallback(() => {
    if (!canUpdateGraph) return;
    const target = staleRepos[0]?.name;
    if (target) setActiveTerminalRepo(target);
    openPanel({ kind: 'workspace-running', repoName: target, terminalVisible: true });
    void runBatchCommand(3);
  }, [canUpdateGraph, staleRepos, runBatchCommand, setActiveTerminalRepo, openPanel]);

  const handleTeamMcpClick = useCallback(async () => {
    if (!isLoggedIn) {
      setPendingTeamMcp(true);
      await login();
      return;
    }
    if ((isCloudMember || cloudEnabled) && projectWorkspaceId) {
      // The panel selects the workspace itself on mount.
      setPanel({ kind: 'team-mcp' });
      return;
    }
    // No cloud workspace yet — first-time setup stays a guided wizard.
    setTeamMcpWizardOpen(true);
  }, [isLoggedIn, login, isCloudMember, cloudEnabled, projectWorkspaceId]);

  // node-detail carries no node id — the explorer owns the selection. If the
  // selection is gone (cleared graph, source switch) the mode has nothing to
  // render, so collapse it here rather than leaving an empty 340px card.
  const leftPanelAvailable = TAB_HAS_LEFT_PANEL[activeTab];
  const leftPanelVisible = leftPanelOpen && leftPanelAvailable;
  const { showStaleBanner, showCloudBanner } = bannerVisibility({
    ciCdEnabled,
    staleRepoCount: staleRepos.length,
    staleDismissed,
    cloudEnabled,
    cloudOutdated,
  });
  // The graph canvas is pannable, so the panel overlays it. Chat and Analytics
  // are read top-to-bottom and would sit under the panel, so they inset instead.
  const insetForPanel = panel.kind !== 'closed' && activeTab !== CompletedTab.Graph;

  return (
    <GraphQueryProvider>
      <ExplorerProvider
        projectId={project.id}
        cloudWorkspaceId={projectWorkspaceId ?? undefined}
        isCloud={explorerIsCloud}
        canUseLocal={!isCloudMember}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TopBarWithIntentCount
            intentWorkspaceId={intentAvailable ? projectWorkspaceId : null}
            projectName={project.name}
            isCloudMember={!!isCloudMember}
            activeTab={activeTab}
            onTabChange={changeTab}
            onRenameProject={onRenameProject}
            leftPanelOpen={leftPanelOpen}
            leftPanelAvailable={leftPanelAvailable}
            onToggleLeftPanel={() => setLeftPanelOpen((v) => !v)}
            onOpenWorkspaceGraph={() => setPanel((c) => togglePanel(c, { kind: 'workspace-graph' }))}
            onOpenLocalMcp={isCloudMember ? undefined : () => setPanel((c) => togglePanel(c, { kind: 'local-mcp' }))}
            onConnectTeamMcp={handleTeamMcpClick}
            teamMcpConnected={cloudEnabled || !!isCloudMember}
            teamMcpAvailable={anySynced || cloudEnabled || !!isCloudMember}
            analyticsAvailable={analyticsAvailable}
            intentAvailable={intentAvailable}
          />

          {showStaleBanner && (
            <StaleGraphBanner
              staleRepos={staleRepos}
              isUpdating={isGraphUpdating}
              onUpdate={handleUpdateGraph}
              onRemindLater={() => setStaleDismissed(true)}
            />
          )}

          {showCloudBanner && (
            <div className="mx-4 mb-2 flex shrink-0 items-center justify-between gap-3 rounded-xl bg-bg-tag-progress px-4 py-2">
              <span className="text-xs leading-4 text-content-primary">The cloud copy of this graph is behind.</span>
              <Button size="sm" className="h-8 rounded-full" disabled={syncing} onClick={syncToCloud}>
                {syncing ? 'Syncing…' : 'Sync with Cloud'}
              </Button>
            </div>
          )}

          {/* The dot ornament is the GROUND of the graph surface, so it lives on the row
              that spans the filter panel and the canvas — not on the canvas alone, which
              is what made the dots stop at the panel's edge. The panel is Surface B and
              translucent, so they read through it. Graph tab only: Chat and Analytics
              float on the plain content underlay. */}
          <div
            className={cn(
              'relative flex min-h-0 flex-1 overflow-hidden px-4 pb-3',
              activeTab === CompletedTab.Graph && 'graph-canvas-bg',
            )}
          >
            <CompletedLeftPanel open={leftPanelVisible}>
              {activeTab === CompletedTab.Chat ? (
                <ChatLeftPanelBody
                  sessions={sessions}
                  sessionId={sessionId}
                  onNewSession={() => void onNewSession()}
                  onSelectSession={(id) => void onSelectSession(id)}
                  onRenameSession={onRenameSession}
                  onDeleteSession={onDeleteSession}
                />
              ) : (
                <ExplorerLeftPanelBody workspaceRepoNames={project.repositories.map((r) => r.name)} />
              )}
            </CompletedLeftPanel>

            <div
              className={cn(
                'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
                // The 352↔776 inset follows the drawer's own 344↔768 width
                // switch, which is unanimated on purpose (perf rule 5) — the
                // terminal's ResizeObserver would otherwise fire once per frame.
                panel.kind === 'workspace-running' ? '' : 'transition-[padding] duration-300',
                insetForPanel
                  ? panel.kind === 'workspace-running' && panel.terminalVisible
                    ? 'pr-[776px]'
                    : 'pr-[352px]'
                  : 'pr-0',
              )}
            >
              {activeTab === CompletedTab.Graph && (
                <GraphTab
                  onNodeSelected={() => openPanel({ kind: 'node-detail' })}
                  onNodeDeselected={() => setPanel((c) => closeIfKind(c, 'node-detail'))}
                />
              )}

              {activeTab === CompletedTab.Chat && (
                <ChatPanel
                  projectId={project.id}
                  contextRepo={contextSelection.kind === 'repo' ? contextSelection.repoName : null}
                  isFullScreen={!leftPanelVisible}
                  isCloudMember={isCloudMember}
                  cloudWorkspaceId={cloudWorkspaceId}
                  cloudRepoNames={isCloudMember ? project.repositories.map((r) => r.name) : undefined}
                  onNewSession={() => void onNewSession()}
                  contextSourceSlot={
                    <ContextSourceDropdown
                      repoNames={project.repositories.map((r) => r.name)}
                      contextSelection={contextSelection}
                      onSelect={setContextSelection}
                    />
                  }
                />
              )}

              {activeTab === CompletedTab.Intent && intentAvailable && (
                <IntentPanel
                  workspaceId={projectWorkspaceId}
                  workspaceSlug={projectWorkspace?.slug}
                  role={projectWorkspace?.role}
                  {...(email === null ? {} : { reviewerHandle: email })}
                />
              )}

              {activeTab === CompletedTab.Analytics && analyticsAvailable && (
                <AnalyticsPanel workspaceId={projectWorkspaceId} role={projectWorkspace?.role} />
              )}
            </div>

            <DockedPanelHost
              panel={panel}
              onClose={closePanel}
              localMcp={{
                projectId: project.id,
                onConnectTeamMcp: () => void handleTeamMcpClick(),
              }}
              teamMcpWorkspaceId={projectWorkspaceId}
              workspaceGraph={{
                repositories: project.repositories,
                repoStates,
                runningRepoNames,
                latestPush,
                isCloudMember: !!isCloudMember,
                runningStageByRepo,
                onAddRepo,
                // Omitted (drops the CTA) when the viewer can't run it or there
                // is nothing for runBatchCommand(3) to pick up.
                onUpdateGraph: canUpdateGraph ? handleUpdateGraph : undefined,
                onRunAction: (repoName, action, args) => {
                  // 'generate' routes through the feedback dialog only when there IS a
                  // parser to regenerate. The dialog asks what needs to CHANGE about
                  // the existing profile, so on a repo that has none it demanded a
                  // critique of a file that does not exist yet — authoring starts
                  // immediately instead.
                  if (action === 'generate' && repoStates.get(repoName)?.parserExists) {
                    setRegenerateRepo(repoName);
                    return;
                  }
                  startRepoWork(repoName, action, args);
                },
                onShowTerminal: (repoName) => {
                  setActiveTerminalRepo(repoName);
                  const cmd = Array.from(runningCommands.values()).find((c) => c.repoName === repoName);
                  openPanel((cmd && panelForAction(cmd.action, repoName)) || { kind: 'terminal', repoName });
                },
                onStopRepo: (repoName) => {
                  const cmd = Array.from(runningCommands.values()).find((c) => c.repoName === repoName);
                  if (cmd) void cancelCommand(cmd.id);
                },
                onReviewRepo: (repoName) => {
                  // Claim the slot here as well as via the mirror effect: the
                  // effect only fires when reviewingRepo *changes*, so asking
                  // for the same repo again after the panel was replaced would
                  // otherwise do nothing.
                  reviewFlow.openReviewFor(repoName);
                  openPanel({ kind: 'review', repoName });
                },
                onRemoveRepo,
                getLinkedPath: isCloudMember ? (name) => cloudStore.getLinkedPath(name) : undefined,
                onLinkRepo: isCloudMember ? (name) => void handleLinkRepo(name) : undefined,
                onUnlinkRepo: isCloudMember ? (name) => void handleUnlinkRepo(name) : undefined,
              }}
              terminal={{
                repoNames: runningRepoNames,
                activeTerminalRepo,
                runningCommands,
                terminalClearCounter,
                onSetActiveRepo: setActiveTerminalRepo,
                incompleteStep,
                repoStates,
                onRunBatch: reviewFlow.runIncompleteBatch,
                onStopCommand: (commandId) => void cancelCommand(commandId),
                onStopAll: () => void cancelAllCommands(),
              }}
              review={{
                flowNext: reviewFlow.flowNext,
                onApproved: reviewFlow.closeReview,
                onApproveAndNext: reviewFlow.approveAndNext,
                onRegenerate: (repoName, feedback) => {
                  // Order matters: closeReview() clears reviewingRepo, which lets the
                  // mirror effect release the slot; startRepoWork then claims it for
                  // the terminal. Requesting the terminal first would lose to the
                  // still-open review in the priority ladder.
                  reviewFlow.closeReview();
                  startRepoWork(repoName, 'generate', { feedback });
                },
              }}
            />
          </div>
        </div>
      </ExplorerProvider>

      <ConnectTeamMcpWizard
        key={project.id}
        open={teamMcpWizardOpen}
        onClose={() => setTeamMcpWizardOpen(false)}
        project={project}
      />
      <RegenerateDialog
        open={regenerateRepo !== null}
        onOpenChange={(open) => {
          if (!open) setRegenerateRepo(null);
        }}
        onSubmit={(feedback) => {
          if (!regenerateRepo) return;
          const repo = regenerateRepo;
          setRegenerateRepo(null);
          startRepoWork(repo, 'generate', { feedback });
        }}
      />
    </GraphQueryProvider>
  );
}

/**
 * The top bar plus the one query it needs, so `CompletedTopBar` stays pure-props.
 *
 * It exists because `CompletedView`'s own body runs OUTSIDE the
 * `GraphQueryProvider` it renders — a react-query hook called there has no
 * client — while everything it returns is inside. One child component is the
 * whole bridge; the count is a prop by the time the bar sees it.
 */
function TopBarWithIntentCount({
  intentWorkspaceId,
  ...bar
}: Omit<CompletedTopBarProps, 'intentPendingCount'> & {
  intentWorkspaceId: string | null;
}) {
  const pending = useIntentPendingCount(intentWorkspaceId);
  return <CompletedTopBar {...bar} intentPendingCount={pending} />;
}
