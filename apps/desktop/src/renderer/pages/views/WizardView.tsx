import { useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { Button } from '../../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Badge } from '../../components/ui/badge';
import {
  getProjectStep,
  getApplicableRepos,
  getReviewFlowNext,
  GRAPH_MUTATING_ACTIONS,
  useProjectDetailStore,
  type ReviewFlowNext,
  type WorkflowStep,
  type WorkflowAction,
  type RunningCommand,
} from '../../stores/project-detail-store';
import { useReviewStore } from '../../stores/review-store';
import { toast } from '../../hooks/use-toast';
import { RegenerateDialog } from '../../components/RegenerateDialog';
import { SessionSelector } from '../../components/SessionSelector';
import { WorkflowStepsBar } from '../../components/WorkflowStepsBar';
import { RepoTerminalTabs } from '../../components/RepoTerminalTabs';
import { AgentRunPanel } from '../../components/agent-run/AgentRunPanel';
import { useAgentRunStore } from '../../stores/agent-run-store';
import { BatchActionBar } from '../../components/BatchActionBar';
import { ProjectRepoCard, OperationTimestampsRow } from '../../components/ProjectRepoCard';
import { ChatPanel } from '../../components/ChatPanel';
import { ReviewPanel } from '../../components/ReviewPanel';
import { ProjectNameEditor } from '../../components/ProjectNameEditor';
import {
  CheckCircle,
  DangerTriangle,
  AddFolder,
  ShareCircle,
  House,
  WindowFrame,
  AddCircle,
  HamburgerMenu,
  ChatLine,
} from '@solar-icons/react';
import { deriveRepoStatus } from '../../lib/repo-status';
import { Card, CardContent } from '../../components/ui/card';
import type { Project } from '../../types/project';
import type { RepoDetailState, ChatSessionMeta } from '../../../shared/ipc-types';
import type { RepositoryStatus } from '../../types/project';
import { cn } from '../../lib/utils';

type RightPanelMode =
  | { kind: 'review'; repoName: string }
  | { kind: 'agent-run'; repoName: string; commandId: string }
  | { kind: 'terminal-single'; repoName: string }
  | { kind: 'chat-docs' }
  | { kind: 'terminal-all' };

const AT_GRAPH_STATUSES: RepositoryStatus[] = ['graph_up_to_date', 'graph_needs_update'];
const PENDING_REVIEW_STATUSES: RepositoryStatus[] = ['parsed_pending_review', 'approval_stale'];

/** The running generate command for a repo whose run is live in the agent-run store, if any. */
function agentRunFor(
  repoName: string,
  runningCommands: Map<string, RunningCommand>,
  agentRunIds: Set<string>,
): string | null {
  const cmd = Array.from(runningCommands.values()).find((c) => c.repoName === repoName && c.action === 'generate');
  return cmd && agentRunIds.has(cmd.id) ? cmd.id : null;
}

function deriveRightPanelMode(
  focusedRepoName: string | null,
  reviewingRepo: string | null,
  repoStates: Map<string, RepoDetailState>,
  runningCommands: Map<string, RunningCommand>,
  repositories: { name: string }[],
  pendingRunRepos: Set<string>,
  agentRunIds: Set<string>,
): RightPanelMode {
  if (reviewingRepo) return { kind: 'review', repoName: reviewingRepo };

  if (focusedRepoName) {
    // A live SDK authoring run takes over the panel. Store presence guards the short startup window
    // before the first structured run event arrives.
    const agentCmd = agentRunFor(focusedRepoName, runningCommands, agentRunIds);
    if (agentCmd) return { kind: 'agent-run', repoName: focusedRepoName, commandId: agentCmd };

    if (pendingRunRepos.has(focusedRepoName)) return { kind: 'terminal-single', repoName: focusedRepoName };

    const state = repoStates.get(focusedRepoName);
    const runningForRepo = Array.from(runningCommands.values()).find((c) => c.repoName === focusedRepoName);
    const status = deriveRepoStatus(state, runningForRepo?.action);

    if (AT_GRAPH_STATUSES.includes(status)) return { kind: 'chat-docs' };
    if (PENDING_REVIEW_STATUSES.includes(status)) return { kind: 'review', repoName: focusedRepoName };
    return { kind: 'terminal-single', repoName: focusedRepoName };
  }

  // No focus, but a generate run is live somewhere → surface it rather than the raw terminal.
  for (const r of repositories) {
    const agentCmd = agentRunFor(r.name, runningCommands, agentRunIds);
    if (agentCmd) return { kind: 'agent-run', repoName: r.name, commandId: agentCmd };
  }

  const allAtGraph =
    repositories.length > 0 &&
    repositories.every((r) => {
      const state = repoStates.get(r.name);
      const running = Array.from(runningCommands.values()).find((c) => c.repoName === r.name);
      return AT_GRAPH_STATUSES.includes(deriveRepoStatus(state, running?.action));
    });

  if (allAtGraph) return { kind: 'chat-docs' };
  return { kind: 'terminal-all' };
}

export interface WizardViewProps {
  project: Project;
  repoStates: Map<string, RepoDetailState>;
  runningCommands: Map<string, RunningCommand>;
  canceledRepos: Set<string>;
  activeTerminalRepo: string | null;
  terminalClearCounter: Map<string, number>;
  terminalRepoNames: string[];
  isLoading: boolean;
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
}

export function WizardView({
  project,
  repoStates,
  runningCommands,
  canceledRepos,
  activeTerminalRepo,
  terminalClearCounter,
  terminalRepoNames,
  isLoading,
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
  onNavigateHome,
  onRenameProject,
}: WizardViewProps) {
  const [isRepoListCollapsed, setIsRepoListCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState('terminal');
  const [reviewingRepo, setReviewingRepo] = useState<string | null>(null);
  const [focusedRepoName, setFocusedRepoName] = useState<string | null>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [pendingRunRepos, setPendingRunRepos] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  /** After "Back" from review, do not immediately re-open the auto-selected review panel. */
  const dismissedAutoReviewRef = useRef(false);

  const approveParser = useReviewStore((s) => s.approveParser);
  // Read approval state per-repo from `RepoDetailState.approval` (keyed map)
  // rather than from the global `useReviewStore.approvalStatus` field, which
  // is not keyed by repoName and can bleed stale data across repo switches.
  const reviewingState = reviewingRepo ? repoStates.get(reviewingRepo) : undefined;
  const canApprove = reviewingState?.approval?.outputMatchesParser !== false;
  const isApproved = !!reviewingState?.approval?.approved && !reviewingState.approval.isStale;

  const handleLeftPanelScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setIsScrolled(e.currentTarget.scrollTop > 10);
  };

  const handleRepoCardClick = (repoName: string) => {
    if (focusedRepoName === repoName) return;
    setFocusedRepoName((prev) => (prev === repoName ? null : repoName));
    setActiveTerminalRepo(repoName);
    setReviewingRepo(null);
  };

  const handleTerminalTabClick = (repoName: string) => {
    setActiveTerminalRepo(repoName);
    setFocusedRepoName(repoName);
    setReviewingRepo(null);
  };

  // Clear focus if repo removed from project
  useEffect(() => {
    if (focusedRepoName && !project.repositories.some((r) => r.name === focusedRepoName)) {
      setFocusedRepoName(null);
    }
  }, [project.repositories, focusedRepoName]);

  // New project / navigation: allow auto-opening review again
  useEffect(() => {
    dismissedAutoReviewRef.current = false;
  }, [project.id]);

  // Reopen / first paint: when the project is waiting on Review (step 1) but
  // nothing is focused yet, jump straight to the first reviewable repo instead
  // of an empty "all terminals" view with the batch bar stuck on Review.
  useEffect(() => {
    if (isLoading || repoStates.size === 0) return;
    if (focusedRepoName !== null || reviewingRepo !== null) return;
    if (dismissedAutoReviewRef.current) return;
    if (getProjectStep(repoStates) !== 1) return;

    const applicable = getApplicableRepos(repoStates, 1).filter(
      (name) =>
        !Array.from(runningCommands.values()).some((c) => c.repoName === name && GRAPH_MUTATING_ACTIONS.has(c.action)),
    );
    if (applicable.length === 0) return;

    const first = applicable[0];
    setReviewingRepo(first);
    setFocusedRepoName(first);
    setActiveTerminalRepo(first);
  }, [isLoading, repoStates, runningCommands, focusedRepoName, reviewingRepo]);

  // Live agent-run command ids (drives the native progress panel; absence = PTY fallback).
  const agentRuns = useAgentRunStore((s) => s.runs);
  const dismissAgentRun = useAgentRunStore((s) => s.dismissRun);
  const agentRunIds = useMemo(() => new Set(agentRuns.keys()), [agentRuns]);

  // Drop finished runs once their command leaves the running set (it has chained on to parse).
  useEffect(() => {
    const liveIds = new Set(Array.from(runningCommands.values()).map((c) => c.id));
    for (const id of agentRunIds) {
      if (!liveIds.has(id)) dismissAgentRun(id);
    }
  }, [runningCommands, agentRunIds, dismissAgentRun]);

  // Derive panel mode
  const panelMode = useMemo(
    () =>
      deriveRightPanelMode(
        focusedRepoName,
        reviewingRepo,
        repoStates,
        runningCommands,
        project.repositories,
        pendingRunRepos,
        agentRunIds,
      ),
    [focusedRepoName, reviewingRepo, repoStates, runningCommands, project.repositories, pendingRunRepos, agentRunIds],
  );

  // Auto-set reviewingRepo when focused repo triggers review mode
  useEffect(() => {
    if (panelMode.kind === 'review' && panelMode.repoName !== reviewingRepo && focusedRepoName) {
      setReviewingRepo(panelMode.repoName);
    }
  }, [panelMode, reviewingRepo, focusedRepoName]);

  // Auto-correct activeTab when entering chat-docs mode
  useEffect(() => {
    if (panelMode.kind === 'chat-docs' && activeTab === 'terminal') {
      setActiveTab('chat');
    }
  }, [panelMode.kind, activeTab]);

  const currentStep = getProjectStep(repoStates);

  const isGraphUpdating = useMemo(
    () => Array.from(runningCommands.values()).some((cmd) => cmd.action === 'push'),
    [runningCommands],
  );

  const handleRunBatch = (step: WorkflowStep) => {
    if (step === 1) {
      const applicable = getApplicableRepos(repoStates, step);
      if (applicable.length > 0) {
        setReviewingRepo(applicable[0]);
        setFocusedRepoName(applicable[0]);
      }
      return;
    }
    runBatchCommand(step);
  };

  // pushQueue subscription — needed so flowNext re-runs when a push is enqueued
  // even if runningCommands hasn't changed yet.
  const pushQueue = useProjectDetailStore((s) => s.pushQueue);

  // Review navigation
  const flowNext: ReviewFlowNext | null = useMemo(() => {
    if (!reviewingRepo) return null;
    if (!repoStates.has(reviewingRepo)) return null;
    return getReviewFlowNext(reviewingRepo, repoStates, runningCommands, pushQueue);
  }, [reviewingRepo, repoStates, runningCommands, pushQueue]);

  // Live-value ref for async-handler reentry checks. useLayoutEffect closes
  // the post-commit / pre-passive-effect microtask gap.
  const reviewingRepoRef = useRef(reviewingRepo);
  useLayoutEffect(() => {
    reviewingRepoRef.current = reviewingRepo;
  }, [reviewingRepo]);

  // Mount guard. `useRef(false)` initial survives StrictMode's
  // setup→cleanup→setup dev cycle.
  const reviewMountedRef = useRef(false);
  useEffect(() => {
    reviewMountedRef.current = true;
    return () => {
      reviewMountedRef.current = false;
    };
  }, []);

  // Synchronous double-click latch (approve and re-parse).
  const approvingRef = useRef(false);
  const reparsingRef = useRef(false);

  const handleApproveAndNext = async () => {
    if (approvingRef.current) return;
    if (!reviewingRepo) return;
    const repoAtClick = reviewingRepo;
    const projectIdAtClick = project.id;
    approvingRef.current = true;
    setApproving(true);
    try {
      if (!isApproved) {
        const result = await approveParser(projectIdAtClick, repoAtClick);
        // approveParser returns `{ success: false }` on failure (does NOT
        // throw) — see review-store.ts. Bail before routing.
        if (!result.success) {
          toast({
            title: 'Approve failed',
            description: result.error ?? 'Could not save approval — try again.',
            variant: 'destructive',
          });
          return;
        }
        // Force a refresh of the repo state. approveParser's internal refresh
        // is wrapped in a "Non-critical" try/catch — without our own refresh,
        // liveStates can show this repo at Step 1 and runBatchCommand(2) ends
        // up a silent no-op.
        try {
          await useProjectDetailStore.getState().refreshRepoState(repoAtClick);
        } catch {
          toast({
            title: 'Approve saved, but refresh failed',
            description: 'Local state is stale — restart the app to recover.',
            variant: 'destructive',
          });
          return;
        }
        const refreshedApproval = useProjectDetailStore.getState().repoStates.get(repoAtClick)?.approval;
        if (!refreshedApproval?.approved || refreshedApproval.isStale) {
          toast({
            title: 'Approve did not propagate',
            description: 'Try again or refresh the workspace.',
            variant: 'destructive',
          });
          return;
        }
      }
      // Guards (closure-trap-free):
      if (!reviewMountedRef.current) return;
      if (reviewingRepoRef.current !== repoAtClick) return;
      const storeNow = useProjectDetailStore.getState();
      if (storeNow.projectId !== projectIdAtClick) return;
      if (!storeNow.repoStates.has(repoAtClick)) return;
      const liveFlow = getReviewFlowNext(
        repoAtClick,
        storeNow.repoStates,
        storeNow.runningCommands,
        storeNow.pushQueue,
      );
      switch (liveFlow.kind) {
        case 'review-next':
          setReviewingRepo(liveFlow.nextRepo);
          setFocusedRepoName(liveFlow.nextRepo);
          break;
        case 'wait-parsing':
          setReviewingRepo(null);
          setFocusedRepoName(liveFlow.terminalRepo);
          setActiveTerminalRepo(liveFlow.terminalRepo);
          break;
        case 'build-graph':
          setReviewingRepo(null);
          setFocusedRepoName(null);
          await runBatchCommand(2);
          break;
        case 'done':
          setReviewingRepo(null);
          setFocusedRepoName(null);
          break;
      }
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  };

  const handleReviewBack = () => {
    dismissedAutoReviewRef.current = true;
    setReviewingRepo(null);
    setFocusedRepoName(null);
  };

  const handleReparse = () => {
    setRegenerateOpen(true);
  };

  // Per-card "Re-parse Repository" — runs generate with feedback and switches the
  // right panel to that repo's terminal so the user sees parser output instead of
  // the now-stale review panel. `reparsingRef` is the synchronous double-submit
  // latch — runCommand has no internal idempotency, so a fast double-click would
  // dispatch two parallel agent runs without it.
  const handleCardReparse = (repoName: string) => (feedback: string) => {
    if (reparsingRef.current) return;
    reparsingRef.current = true;
    setReviewingRepo(null);
    setFocusedRepoName(repoName);
    setActiveTerminalRepo(repoName);
    setActiveTab('terminal');
    setPendingRunRepos((prev) => new Set(prev).add(repoName));
    runCommand(repoName, 'generate', { feedback }).finally(() => {
      reparsingRef.current = false;
      setPendingRunRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoName);
        return next;
      });
    });
  };

  // Graph card stats. "At graph" is the derived status, not the raw push timestamp,
  // so the card cannot claim a graph for a repo whose profile or parsed artifact is
  // gone — the repo cards and the workflow bar would say step 0 right underneath it.
  // Derived without the running action so an in-flight push doesn't flip the card.
  const repoStatesArray = Array.from(repoStates.values());
  const isAtGraph = (s: RepoDetailState) => AT_GRAPH_STATUSES.includes(deriveRepoStatus(s));
  const syncedCount = repoStatesArray.filter(isAtGraph).length;
  const totalCount = repoStatesArray.length;
  const allSynced = totalCount > 0 && syncedCount === totalCount;
  const noneSynced = syncedCount === 0;
  const staleRepos = repoStatesArray.filter((s) => isAtGraph(s) && s.staleness?.reason === 'new_commits');
  const unsyncedRepos = repoStatesArray.filter((s) => !isAtGraph(s));
  const latestPush = repoStatesArray
    .map((s) => s.operations?.lastPushed)
    .filter(Boolean)
    .sort()
    .pop();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left panel - Workflow + Repos list */}
        <div
          className={cn(
            'w-2/5 min-w-[468px] flex flex-col relative shrink-0 transition-[margin,opacity] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
            isRepoListCollapsed ? '-ml-[50%] opacity-0 pointer-events-none' : 'ml-0 opacity-100',
          )}
        >
          {/* Left panel header */}
          <div className="pt-3.5 pb-2.5 px-4 shrink-0 flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="no-drag h-8 w-8 shadow-action rounded-full border-controls flex items-center justify-center p-0"
              onClick={onNavigateHome}
            >
              <div className="size-7 rounded-full flex items-center justify-center transition-all duration-300 hover:bg-bg-primary-hover">
                <House className="size-4" />
              </div>
            </Button>
            <ProjectNameEditor initialName={project.name} onSave={onRenameProject} />
          </div>

          {isScrolled && (
            <div className="absolute top-14 left-0 right-0 z-20 bg-bg-overlay">
              <WorkflowStepsBar compact currentStep={currentStep} repoStates={repoStates} />
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-auto flex flex-col" onScroll={handleLeftPanelScroll}>
            <WorkflowStepsBar currentStep={currentStep} repoStates={repoStates} />

            <div className="mx-4 mb-0 border-t border-x border-border-tertiary rounded-t-2xl flex flex-col gap-0.5 overflow-clip pt-1 pb-4 flex-1">
              {/* Workspace graph section */}
              <div className="flex flex-col gap-2">
                <div className="pt-2.5 px-3">
                  <div className="text-content-primary font-extrabold text-base leading-6 h-7 flex items-center">
                    Workspace Graph:
                  </div>
                </div>
                <div className="px-3">
                  <Card
                    className={cn('gradient-1 pt-2 pb-3 gap-1.5', noneSynced && 'shadow-none! border-transparent!')}
                  >
                    <CardContent className="px-4">
                      <div className="flex items-center gap-1">
                        <div className="flex items-center py-0.5">
                          <ShareCircle weight="Bold" className="size-4" />
                        </div>
                        <span className="text-content-primary text-sm font-semibold leading-5">Workspace graph</span>
                      </div>
                    </CardContent>
                    {noneSynced && (
                      <div className="px-4">
                        <Badge variant="initial" className="shrink-0 text-xs leading-4">
                          <span className="text-xs leading-4 text-content-secondary w-3 text-center">•</span>
                          No Graph
                        </Badge>
                      </div>
                    )}
                    {allSynced && staleRepos.length === 0 && (
                      <div className="flex items-center gap-3 px-4">
                        <Badge variant="success" className="shrink-0">
                          <CheckCircle weight="Bold" className="size-3 text-content-tag-success" />
                          Graph up to date
                        </Badge>
                        {latestPush && <OperationTimestampsRow operations={{ lastPushed: latestPush }} />}
                      </div>
                    )}
                    {!noneSynced && !(allSynced && staleRepos.length === 0) && (
                      <div className="space-y-1 px-4">
                        <div className="flex items-center gap-3">
                          <Badge variant="warning" className="shrink-0">
                            <DangerTriangle weight="Bold" className="size-3 text-content-tag-warning" />
                            Graph needs update
                          </Badge>
                          {latestPush && <OperationTimestampsRow operations={{ lastPushed: latestPush }} />}
                        </div>
                        <div className="text-xs text-content-quaternary">
                          {unsyncedRepos.length > 0 && <span>{unsyncedRepos.length} repo(s) not pushed</span>}
                          {unsyncedRepos.length > 0 && staleRepos.length > 0 && <span> · </span>}
                          {staleRepos.length > 0 && <span>{staleRepos.length} repo(s) stale</span>}
                        </div>
                      </div>
                    )}
                  </Card>
                </div>
              </div>
              {/* Repository source section */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between pt-2.5 px-3">
                  <div className="text-content-primary font-extrabold text-base leading-6 h-7 flex items-center">
                    Repository source:
                  </div>
                  {!isGraphUpdating && (
                    <Button variant="outline" size="sm" className="gap-2" onClick={onAddRepo}>
                      <AddFolder className="size-4" />
                      Add new repository
                    </Button>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 px-3">
                  {project.repositories.map((repo) => {
                    const state = repoStates.get(repo.name);
                    const runningForRepo = Array.from(runningCommands.values()).find((c) => c.repoName === repo.name);
                    const status = deriveRepoStatus(state, runningForRepo?.action);

                    return (
                      <ProjectRepoCard
                        key={repo.id}
                        repoName={repo.name}
                        repoUrl={repo.path}
                        state={state}
                        status={status}
                        isLoading={isLoading}
                        isRunning={!!runningForRepo}
                        wasCanceled={canceledRepos.has(repo.name)}
                        onRunAction={(action, args) => runCommand(repo.name, action, args)}
                        onStop={runningForRepo ? () => cancelCommand(runningForRepo.id) : undefined}
                        onRemove={() => onRemoveRepo(repo.name)}
                        onReview={() => setReviewingRepo(repo.name)}
                        onReparse={handleCardReparse(repo.name)}
                        isSelected={focusedRepoName === repo.name}
                        onClick={() => handleRepoCardClick(repo.name)}
                        graphUpdating={isGraphUpdating}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div
          className={cn(
            'flex flex-col pt-3.5 pr-1.5 transition-[width] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
            isRepoListCollapsed ? 'w-full' : 'w-3/5',
          )}
        >
          {/* Review mode */}
          {panelMode.kind === 'review' && <ReviewPanel repoName={panelMode.repoName} hideFooter />}

          {/* Agent-run mode (native profile-authoring progress) */}
          {panelMode.kind === 'agent-run' && (
            <AgentRunPanel commandId={panelMode.commandId} repoName={panelMode.repoName} />
          )}

          {/* Terminal modes */}
          <div
            className={
              panelMode.kind === 'terminal-single' || panelMode.kind === 'terminal-all'
                ? 'flex-1 flex flex-col min-h-0'
                : 'hidden'
            }
          >
            <RepoTerminalTabs
              repoNames={terminalRepoNames}
              activeTerminalRepo={activeTerminalRepo}
              runningCommands={runningCommands}
              terminalClearCounter={terminalClearCounter}
              onSetActiveRepo={handleTerminalTabClick}
              hideTabs={panelMode.kind === 'terminal-single' && terminalRepoNames.length <= 1}
            />
          </div>

          {/* Chat mode */}
          <Tabs
            value={activeTab === 'terminal' ? 'chat' : activeTab}
            onValueChange={setActiveTab}
            className={panelMode.kind === 'chat-docs' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}
          >
            <div className="flex shrink-0 items-center justify-between px-4 py-1.5">
              <div className="flex items-center gap-2">
                {isRepoListCollapsed && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="no-drag h-8 w-8 shadow-action rounded-full border-controls flex items-center justify-center p-0"
                    onClick={onNavigateHome}
                  >
                    <div className="size-7 rounded-full flex items-center justify-center transition-all duration-300 hover:bg-bg-primary-hover">
                      <House className="size-4" />
                    </div>
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="no-drag h-8 w-8 shadow-action rounded-full border-controls flex items-center justify-center p-0"
                  onClick={() => setIsRepoListCollapsed(!isRepoListCollapsed)}
                >
                  <div className="size-7 rounded-full flex items-center justify-center transition-all duration-300 hover:bg-bg-primary-hover">
                    <WindowFrame className="size-4" />
                  </div>
                </Button>

                <TabsList variant="pill" className="min-w-[150px] max-w-[780px]">
                  <TabsTrigger value="chat">
                    <ChatLine className="size-4" />
                    Chat
                  </TabsTrigger>
                </TabsList>
              </div>

              {activeTab === 'chat' && (
                <div className="flex items-center px-[1px] rounded-full border-controls shadow-action">
                  <button
                    type="button"
                    className="size-8 rounded-full flex items-center justify-center p-[2px] cursor-pointer group"
                    onClick={() => {
                      onNewSession();
                    }}
                  >
                    <div className="size-7 rounded-full flex items-center justify-center p-1.5 transition-colors group-hover:bg-bg-primary-hover">
                      <AddCircle className="size-4 text-content-primary" />
                    </div>
                  </button>
                  <SessionSelector
                    sessions={sessions}
                    currentSessionId={sessionId}
                    onSelect={onSelectSession}
                    onRename={onRenameSession}
                    onDelete={onDeleteSession}
                    showNewChat={false}
                    trigger={
                      <button
                        type="button"
                        className="size-8 rounded-full flex items-center justify-center p-[2px] cursor-pointer group"
                      >
                        <div className="size-7 rounded-full flex items-center justify-center p-1.5 transition-colors group-hover:bg-bg-primary-hover group-data-[state=open]:bg-bg-primary-selected">
                          <HamburgerMenu className="size-4 text-content-primary" />
                        </div>
                      </button>
                    }
                  />
                </div>
              )}
            </div>

            <TabsContent value="chat" className="flex-1 m-0 min-h-0 data-[state=active]:flex flex-col">
              <ChatPanel projectId={project.id} onNewSession={onNewSession} />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Full-width batch action bar */}
      <BatchActionBar
        currentStep={currentStep}
        repoStates={repoStates}
        runningCommands={runningCommands}
        onRunBatch={handleRunBatch}
        onStopAll={cancelAllCommands}
        reviewingRepo={reviewingRepo}
        canApprove={canApprove}
        isApproved={isApproved}
        isApproving={approving}
        flowNext={flowNext}
        onBack={handleReviewBack}
        onReparse={handleReparse}
        onApproveAndNext={handleApproveAndNext}
      />

      <RegenerateDialog
        open={regenerateOpen}
        onOpenChange={setRegenerateOpen}
        onSubmit={(feedback) => {
          if (!reviewingRepo) return;
          // Reuse the unified per-card handler: closes review, switches the
          // right panel to the repo's terminal, applies the double-submit
          // latch, and dispatches generate with chain.
          handleCardReparse(reviewingRepo)(feedback);
        }}
      />
    </div>
  );
}
