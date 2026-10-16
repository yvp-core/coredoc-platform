import { create } from 'zustand';
import type { RepoDetailState, CommandCompleted, RunningCommandInfo } from '../../shared/ipc-types';
import { deriveRepoStatus } from '../lib/repo-status';

export type WorkflowAction = 'generate' | 'parse' | 'summarize' | 'push' | 'docs' | 'cloud-docs';
// Steps 0–2 are the wizard. Step 3 is post-wizard maintenance: the graph was
// pushed before, but the source has new commits since the last parse — so we
// re-parse (which auto-chains summarize → push). It is NOT a wizard step
// (`WorkflowStepsBar` only renders the first three) but reuses the same
// `getRepoStep` / `runBatchCommand` machinery so the
// CompletedView gets an "Update Graph" action for free.
export type WorkflowStep = 0 | 1 | 2 | 3;

export interface WorkflowStepDef {
  label: string;
  alertTitle?: string;
  description: string;
  actions: WorkflowAction[];
  btnLabel: string;
}

export const WORKFLOW_STEPS: WorkflowStepDef[] = [
  {
    label: 'Parse Repositories',
    btnLabel: 'Parse Repositories',
    description: "We'll generate a parser for each repository, then parse the codebase.",
    actions: ['generate', 'parse'],
  },
  {
    label: 'Review Parse Results',
    alertTitle: 'Validate Parsed Data',
    btnLabel: 'Review',
    description:
      'Review the extracted entities, entrypoints and call graph for each repository before building the graph.',
    actions: [],
  },
  {
    label: 'Build Graph',
    btnLabel: 'Build Graph',
    description: 'Summarise all parsed elements and push into the knowledge graph.',
    actions: ['summarize', 'push'],
  },
  {
    label: 'Update Graph',
    btnLabel: 'Update Graph (Changed Repos)',
    description: 'Source has new commits since the last parse — re-parse and refresh the graph.',
    actions: ['parse'],
  },
];

export interface RunningCommand {
  id: string;
  repoName: string;
  action: WorkflowAction;
  startedAt: string;
  origin: 'single' | 'batch';
  args?: Record<string, unknown>;
}

export type ContextSelection = { kind: 'project' } | { kind: 'repo'; repoName: string };

// Pushes write to a single SQLite file with long write transactions (pushNodes,
// pushEdges, rebuildClosureTable, cross-repo resolution). Running them in
// parallel reliably exceeds SQLite's busy_timeout and produces "database is
// locked" errors, so all pushes for a project are funneled through a queue
// that runs them one at a time.
interface QueuedPush {
  repoName: string;
  args?: Record<string, unknown>;
  origin: 'single' | 'batch';
}

interface ProjectDetailState {
  projectId: string | null;
  repoStates: Map<string, RepoDetailState>;
  activeTerminalRepo: string | null;
  runningCommands: Map<string, RunningCommand>;
  terminalClearCounter: Map<string, number>;
  terminalRepoNames: string[];
  isLoading: boolean;
  wizardCompleted: boolean;
  isMarkingCompleted: boolean;
  expectedRepoCount: number;
  projectRepoNames: string[];
  contextSelection: ContextSelection;
  graphNeedsRebuild: boolean;
  pushQueue: QueuedPush[];
  pushInFlight: boolean;
  graphReadyModalShown: boolean;
  // Repos whose last user-initiated generate/parse run was canceled and never
  // followed by a successful parse. Drives the per-repo "Start parsing"
  // dropdown item in ProjectRepoCard. In-memory, project-scoped.
  canceledRepos: Set<string>;
  // Actions
  setProjectId: (projectId: string) => void;
  loadRepoStates: (repoNames: string[]) => Promise<void>;
  refreshRepoState: (repoName: string) => Promise<void>;
  runCommand: (
    repoName: string,
    action: WorkflowAction,
    args?: Record<string, unknown>,
    origin?: 'single' | 'batch',
  ) => Promise<void>;
  enqueuePush: (repoName: string, args?: Record<string, unknown>, origin?: 'single' | 'batch') => void;
  cancelCommand: (commandId: string) => Promise<void>;
  cancelAllCommands: () => Promise<void>;
  runBatchCommand: (step: WorkflowStep) => Promise<void>;
  setActiveTerminalRepo: (repoName: string | null) => void;
  clearTerminal: (repoName?: string) => void;
  openFile: (filePath: string) => Promise<void>;
  setContextSelection: (ctx: ContextSelection) => void;
  markWizardCompleted: () => Promise<void>;
  forgetRepo: (repoName: string) => void;
  // Internal handlers
  handleCommandCompleted: (result: CommandCompleted) => void;
  markGraphReadyModalShown: () => Promise<void>;
}

/**
 * Determine the workflow step a repo is currently at.
 * Returns null if all steps are done.
 */
export function getRepoStep(state: RepoDetailState): WorkflowStep | null {
  if (!state.parserExists || !state.parsed.exists) return 0;
  if (!state.approval?.approved || state.approval?.isStale) return 1;
  if (!state.neo4jSynced.synced) return 2;
  if (state.staleness?.isStale) return 3;
  return null;
}

/**
 * Get the overall project step (minimum across all repos).
 * Returns null if all repos are done.
 */
export function getProjectStep(repoStates: Map<string, RepoDetailState>): WorkflowStep | null {
  let minStep: WorkflowStep | null = null;
  for (const state of repoStates.values()) {
    const step = getRepoStep(state);
    if (step !== null) {
      if (minStep === null || step < minStep) {
        minStep = step;
      }
    }
  }
  return minStep;
}

/**
 * Get repos that need the given step.
 */
export function getApplicableRepos(repoStates: Map<string, RepoDetailState>, step: WorkflowStep): string[] {
  const repos: string[] = [];
  for (const [name, state] of repoStates) {
    const repoStep = getRepoStep(state);
    if (repoStep === step) {
      repos.push(name);
    }
  }
  return repos;
}

export type ReviewFlowNext =
  | { kind: 'review-next'; nextRepo: string }
  | { kind: 'wait-parsing'; terminalRepo: string }
  | { kind: 'build-graph' }
  | { kind: 'done' };

// Actions that mutate the graph state (parser → parsed.json → summary → graph).
// docs/cloud-docs are reads against the existing graph and do NOT block.
export const GRAPH_MUTATING_ACTIONS: ReadonlySet<WorkflowAction> = new Set<WorkflowAction>([
  'generate',
  'parse',
  'summarize',
  'push',
]);

/**
 * Decide what comes after the user approves the repo currently in review.
 *
 * Priority:
 *   1. Another Step-1 repo waiting for review (and NOT mid-mutation) → review-next
 *   2. Any Step-0 repo (parsing or never parsed) → wait-parsing
 *      (prefer a repo with a running command so the terminal isn't empty)
 *   3. Any repo running a graph-mutating command → wait-parsing
 *      (catches re-parse on already-approved repos and queue-draining pushes)
 *   4. Any push queued but not yet in flight → wait-parsing
 *   5. build-graph if the just-approved repo (or any other) will be at Step 2
 *   6. Defensive: nothing else applicable → done.
 *
 * Step-3 (stale) repos are intentionally ignored — that path is post-wizard
 * maintenance handled by the separate "Update Graph" CTA.
 *
 * Pure: no side effects; safe to call inside useMemo or after an await.
 */
export function getReviewFlowNext(
  reviewingRepo: string,
  repoStates: Map<string, RepoDetailState>,
  runningCommands: Map<string, RunningCommand>,
  pushQueue: ReadonlyArray<{ repoName: string }> = [],
): ReviewFlowNext {
  // A repo currently running generate/parse/summarize/push is mid-mutation —
  // its parsed output and approval may shift mid-reparse. Excluding it from
  // step-1 review-next prevents routing the user back to a stale review panel
  // for a repo whose parse is in flight (the running-blocker check below
  // surfaces it as wait-parsing instead).
  const mutatingRepoNames = new Set(
    Array.from(runningCommands.values())
      .filter((c) => GRAPH_MUTATING_ACTIONS.has(c.action))
      .map((c) => c.repoName),
  );

  const remainingStep1 = getApplicableRepos(repoStates, 1).filter(
    (r) => r !== reviewingRepo && !mutatingRepoNames.has(r),
  );
  if (remainingStep1.length > 0) {
    return { kind: 'review-next', nextRepo: remainingStep1[0] };
  }

  const step0 = getApplicableRepos(repoStates, 0);
  if (step0.length > 0) {
    const runningRepoNames = new Set(Array.from(runningCommands.values()).map((c) => c.repoName));
    const runningStep0 = step0.find((r) => runningRepoNames.has(r));
    return { kind: 'wait-parsing', terminalRepo: runningStep0 ?? step0[0] };
  }

  // Any repo running a graph-mutating command. We do NOT filter reviewingRepo:
  // if it's somehow both reviewed and running, the guard must still fire —
  // otherwise we fall through to build-graph while a parse is in flight.
  // Pointing terminalRepo at reviewingRepo is fine; the click handler closes
  // review and opens its terminal.
  const runningBlocker = Array.from(runningCommands.values()).find((c) => GRAPH_MUTATING_ACTIONS.has(c.action));
  if (runningBlocker) {
    return { kind: 'wait-parsing', terminalRepo: runningBlocker.repoName };
  }

  // Pushes can be queued but not yet promoted to runningCommands. Advertising
  // build-graph while the queue drains is a leaky abstraction.
  if (pushQueue.length > 0) {
    return { kind: 'wait-parsing', terminalRepo: pushQueue[0].repoName };
  }

  // build-graph is reachable only when the just-approved repo (or another)
  // will actually be at Step 2 after approval.
  const reviewingRepoIsStep1 = getApplicableRepos(repoStates, 1).includes(reviewingRepo);
  const reviewingRepoIsStep2 = getApplicableRepos(repoStates, 2).includes(reviewingRepo);
  const otherStep2 = getApplicableRepos(repoStates, 2).filter((r) => r !== reviewingRepo);
  if (otherStep2.length > 0 || reviewingRepoIsStep1 || reviewingRepoIsStep2) {
    return { kind: 'build-graph' };
  }

  return { kind: 'done' };
}

export function getReviewApproveLabel(flow: ReviewFlowNext, isApproved: boolean): string {
  const prefix = isApproved ? '' : 'Approve & ';
  switch (flow.kind) {
    case 'review-next':
      return `${prefix}Review Next Repo`;
    case 'wait-parsing':
      // Handler closes review and switches the right pane to the blocker
      // repo's terminal — the label must reflect that, not promise a review.
      return `${prefix}View Progress`;
    case 'build-graph':
      return `${prefix}Start Building Graph`;
    case 'done':
      return isApproved ? 'Done' : 'Approve';
  }
}

/**
 * Check if all repos in the project are complete from the wizard's perspective
 * (steps 0–2 done). Step 3 (stale graph) is post-wizard maintenance, so a stale
 * repo still counts as wizard-complete — otherwise the wizard flag would never
 * auto-flip for projects whose source has moved on since the last push.
 * Safe against empty/loading states.
 */
function isProjectComplete(repoStates: Map<string, RepoDetailState>, expectedCount: number): boolean {
  if (expectedCount === 0 || repoStates.size < expectedCount) return false;
  for (const state of repoStates.values()) {
    const step = getRepoStep(state);
    if (step !== null && step < 3) return false;
  }
  return true;
}

// Store cleanup function from IPC listener registration
let commandCompletedCleanup: (() => void) | null = null;

// HMR re-evaluates this module, so its next instance cannot see this instance's cleanup variable.
// Leaving the old listener alive would chain another parse when generation completes.
if (import.meta.hot) {
  import.meta.hot.dispose(() => commandCompletedCleanup?.());
}

export const useProjectDetailStore = create<ProjectDetailState>((set, get) => {
  // Set up IPC listeners on store creation
  if (typeof window !== 'undefined' && window.electronAPI) {
    // Clean up a previous listener if the store is recreated within this module instance.
    commandCompletedCleanup?.();
    commandCompletedCleanup = window.electronAPI.onCommandCompleted((result) => get().handleCommandCompleted(result));
  }

  // Drain one push from the queue if nothing is currently in flight. The
  // pushInFlight flag flips synchronously before runCommand's IPC await so
  // back-to-back enqueues (e.g. a wave of summarize completions) cannot race
  // past the gate.
  const advancePushQueue = async (): Promise<void> => {
    const { pushInFlight, pushQueue } = get();
    if (pushInFlight || pushQueue.length === 0) return;

    const [next, ...rest] = pushQueue;
    set({ pushQueue: rest, pushInFlight: true });

    await get().runCommand(next.repoName, 'push', next.args, next.origin);

    // runCommand resolves once the worker is dispatched. If dispatch failed
    // (e.g. no config), no command was added to runningCommands and no
    // CommandCompleted event will ever fire — release the gate so the queue
    // doesn't deadlock on subsequent items.
    const dispatched = Array.from(get().runningCommands.values()).some((c) => c.action === 'push');
    if (!dispatched) {
      set({ pushInFlight: false });
      void advancePushQueue();
    }
  };

  return {
    projectId: null,
    repoStates: new Map(),
    activeTerminalRepo: null,
    runningCommands: new Map(),
    terminalClearCounter: new Map(),
    terminalRepoNames: [],
    isLoading: false,
    wizardCompleted: false,
    isMarkingCompleted: false,
    expectedRepoCount: 0,
    projectRepoNames: [],
    contextSelection: { kind: 'project' },
    graphNeedsRebuild: false,
    pushQueue: [],
    pushInFlight: false,
    graphReadyModalShown: false,
    canceledRepos: new Set(),

    setProjectId: (projectId) => {
      if (get().projectId === projectId) return;
      set({
        projectId,
        repoStates: new Map(),
        activeTerminalRepo: null,
        runningCommands: new Map(),
        terminalClearCounter: new Map(),
        terminalRepoNames: [],
        wizardCompleted: false,
        isMarkingCompleted: false,
        graphReadyModalShown: false,
        expectedRepoCount: 0,
        projectRepoNames: [],
        contextSelection: { kind: 'project' },
        graphNeedsRebuild: false,
        pushQueue: [],
        pushInFlight: false,
        canceledRepos: new Set(),
      });
    },

    loadRepoStates: async (repoNames) => {
      const callerProjectId = get().projectId;
      if (!callerProjectId) return;
      set({ isLoading: true, expectedRepoCount: repoNames.length, projectRepoNames: repoNames });

      try {
        const states = new Map<string, RepoDetailState>();

        await Promise.all(
          repoNames.map(async (name) => {
            const state = await window.electronAPI.getRepoDetailState(callerProjectId, name);
            if (state) {
              states.set(name, state);
            }
          }),
        );

        // Bail if project changed during async work
        if (get().projectId !== callerProjectId) return;
        // Refresh the projects-store cache for this project's repo statuses in
        // a SINGLE batched update. The Sidebar's busy spinner reads this cache
        // for non-active projects; without this sync, statuses can drift after
        // navigation/reload and the spinner sticks. The batch helper bails out
        // if nothing actually changed, so this is a no-op when the cache is
        // already correct (no extra re-renders / dropdown flickers).
        try {
          const { useProjectsStore } = await import('./projects-store');
          const runningByRepo = new Map<string, WorkflowAction>();
          for (const cmd of get().runningCommands.values()) {
            runningByRepo.set(cmd.repoName, cmd.action);
          }
          const nextStatuses = new Map<string, ReturnType<typeof deriveRepoStatus>>();
          for (const name of repoNames) {
            nextStatuses.set(name, deriveRepoStatus(states.get(name), runningByRepo.get(name)));
          }
          useProjectsStore.getState().syncRepoStatusesBatch(callerProjectId, nextStatuses);
        } catch {
          // Non-critical
        }

        // Restore running commands from main process (survives renderer reload)
        try {
          const running: RunningCommandInfo[] = await window.electronAPI.getRunningCommands();
          if (get().projectId !== callerProjectId) return;
          // Filter to commands belonging to this project's repos
          const projectRunning = running.filter(
            (cmd) => cmd.projectId === callerProjectId && repoNames.includes(cmd.repoName),
          );
          if (projectRunning.length > 0) {
            // Merge with existing running commands to preserve args/origin from in-flight commands
            const existingCommands = get().runningCommands;
            const mergedCommands = new Map<string, RunningCommand>(existingCommands);
            const restoredRepoNames: string[] = [...get().terminalRepoNames];
            for (const cmd of projectRunning) {
              if (!mergedCommands.has(cmd.id)) {
                mergedCommands.set(cmd.id, {
                  id: cmd.id,
                  repoName: cmd.repoName,
                  action: cmd.action as WorkflowAction,
                  startedAt: cmd.startedAt,
                  origin: 'single', // origin unknown after reload, default to single
                });
              }
              if (!restoredRepoNames.includes(cmd.repoName)) {
                restoredRepoNames.push(cmd.repoName);
              }
            }
            set({
              repoStates: states,
              runningCommands: mergedCommands,
              terminalRepoNames: restoredRepoNames,
              activeTerminalRepo: get().activeTerminalRepo ?? restoredRepoNames[0] ?? null,
              isLoading: false,
            });
          } else {
            set({ repoStates: states, isLoading: false });
          }
        } catch {
          // getRunningCommands not available (older main process) — continue normally
          if (get().projectId !== callerProjectId) return;
          set({ repoStates: states, isLoading: false });
        }

        // Check wizardCompleted flag from config
        if (callerProjectId) {
          try {
            const configResult = await window.electronAPI.loadConfig();
            if (get().projectId !== callerProjectId) return;
            if (configResult.success && configResult.config) {
              const flagInConfig =
                configResult.config.projects.find((p) => p.id === callerProjectId)?.wizardCompleted === true;
              const projectInConfig = configResult.config.projects.find((p) => p.id === callerProjectId);
              const modalShownInConfig = projectInConfig?.graphReadyModalShown === true;
              if (flagInConfig) {
                set({ wizardCompleted: true });
                void import('./projects-store').then(({ useProjectsStore }) => {
                  if (get().projectId !== callerProjectId) return;
                  useProjectsStore.getState().syncWizardCompleted(callerProjectId, true);
                });
              } else if (isProjectComplete(states, repoNames.length)) {
                // Backfill: project is already complete but flag wasn't set
                get().markWizardCompleted();
              }
              set({ graphReadyModalShown: modalShownInConfig });
            }
          } catch {
            // Config load failed — continue without wizard flag
          }
        }
      } catch (error) {
        console.error('Failed to load repo states:', error);
        if (get().projectId === callerProjectId) {
          set({ isLoading: false });
        }
      }
    },

    refreshRepoState: async (repoName) => {
      const projectId = get().projectId;
      if (!projectId) return;
      // Throws on IPC failure so callers that depend on a successful refresh
      // (e.g. ReviewPanel before routing onApproveAndNext) can detect a stale
      // local state instead of proceeding on phantom data. The post-command
      // caller in handleCommandCompleted catches and logs.
      const state = await window.electronAPI.getRepoDetailState(projectId, repoName);
      // The request is bound to the project that was active when it started. A late
      // response after navigation must not write that project's repo into the newly
      // selected project store.
      if (get().projectId !== projectId) return;
      if (state) {
        set((prev) => {
          const newStates = new Map(prev.repoStates);
          newStates.set(repoName, state);
          return { repoStates: newStates };
        });
      }
    },

    runCommand: async (repoName, action, args, origin = 'single') => {
      const projectId = get().projectId;
      if (!projectId) {
        console.error(`Cannot run ${action}: no project loaded`);
        return;
      }
      try {
        const result = await window.electronAPI.runCommand({
          command: action,
          projectId,
          repo: repoName,
          args,
        });
        // Bind the renderer continuation to the project that dispatched the
        // command. The main process may answer after the user has navigated to
        // another project, whose store must remain untouched.
        if (get().projectId !== projectId) return;

        const { useProjectsStore } = await import('./projects-store');
        if (get().projectId !== projectId) return;
        if (result.started) {
          // Normalize cloud-docs → docs for downstream handling
          const normalizedAction = action === 'cloud-docs' ? 'docs' : action;

          set((prev) => {
            if (prev.projectId !== projectId) return prev;
            const newRunning = new Map(prev.runningCommands);
            newRunning.set(result.id, {
              id: result.id,
              repoName,
              action: normalizedAction,
              startedAt: new Date().toISOString(),
              origin,
              args,
            });

            // Track repo in terminal tabs
            const newRepoNames = prev.terminalRepoNames.includes(repoName)
              ? prev.terminalRepoNames
              : [...prev.terminalRepoNames, repoName];

            // Atomically clear the cancel flag for this repo when starting a
            // new generate/parse run, so the dropdown transitions in a single
            // render from "Start parsing" → "Stop parsing" without a flicker.
            let nextCanceled = prev.canceledRepos;
            if ((normalizedAction === 'generate' || normalizedAction === 'parse') && prev.canceledRepos.has(repoName)) {
              nextCanceled = new Set(prev.canceledRepos);
              nextCanceled.delete(repoName);
            }

            return {
              runningCommands: newRunning,
              activeTerminalRepo: repoName,
              terminalRepoNames: newRepoNames,
              canceledRepos: nextCanceled,
            };
          });

          // Sync in-progress status to projects-store
          const state = get().repoStates.get(repoName);
          const status = deriveRepoStatus(state, normalizedAction);
          useProjectsStore.getState().syncRepoStatus(projectId, repoName, status);

          // If this is a docs command, insert chat messages
          if (normalizedAction === 'docs') {
            const { useChatStore } = await import('./chat-store');
            if (get().projectId !== projectId) return;
            const promptName = (args?.prompt ?? args?.prompts ?? args?.promptName) as string | undefined;
            const label = promptName
              ? `Generate "${promptName}" documentation for ${repoName}`
              : `Generate documentation for ${repoName}`;
            useChatStore.getState().startDocsGeneration(label, result.id);
          }
        } else {
          console.error('Failed to start command:', result.error);
          const state = get().repoStates.get(repoName);
          const status = deriveRepoStatus(state);
          useProjectsStore.getState().syncRepoStatus(projectId, repoName, status);
        }
      } catch (error) {
        console.error(`Failed to run ${action} for ${repoName}:`, error);
      }
    },

    enqueuePush: (repoName, args, origin = 'single') => {
      set((prev) => ({ pushQueue: [...prev.pushQueue, { repoName, args, origin }] }));
      void advancePushQueue();
    },

    cancelCommand: async (commandId) => {
      // Capture context synchronously BEFORE the await — handleCommandCompleted
      // may fire and delete the entry from runningCommands while the IPC is in
      // flight, so reading after the await is racy.
      const cmd = get().runningCommands.get(commandId);
      const repoName = cmd?.repoName;
      const action = cmd?.action;
      try {
        await window.electronAPI.cancelCommand(commandId);
        set((prev) => {
          const newRunning = new Map(prev.runningCommands);
          newRunning.delete(commandId);

          // Mark the repo as user-canceled when the canceled run was a
          // generate or parse — this drives the per-repo "Start parsing"
          // dropdown item. Other actions don't affect the flag.
          let nextCanceled = prev.canceledRepos;
          if (repoName && (action === 'generate' || action === 'parse') && !prev.canceledRepos.has(repoName)) {
            nextCanceled = new Set(prev.canceledRepos);
            nextCanceled.add(repoName);
          }

          return { runningCommands: newRunning, canceledRepos: nextCanceled };
        });

        if (repoName) {
          const state = get().repoStates.get(repoName);
          const status = deriveRepoStatus(state, undefined);
          const { useProjectsStore } = await import('./projects-store');
          const syncProjectId = get().projectId;
          if (syncProjectId) {
            useProjectsStore.getState().syncRepoStatus(syncProjectId, repoName, status);
          }
        }

        if (action === 'docs' || action === 'cloud-docs') {
          const { useChatStore } = await import('./chat-store');
          useChatStore.getState().completeDocsGeneration(commandId, [], 'Cancelled');
        }
      } catch (error) {
        console.error(`Failed to cancel command ${commandId}:`, error);
      }
    },

    cancelAllCommands: async () => {
      const { runningCommands, cancelCommand } = get();
      // Drop queued pushes first so the in-flight cancellations below don't
      // re-trigger them via advancePushQueue.
      set({ pushQueue: [], pushInFlight: false });
      const ids = Array.from(runningCommands.keys());
      await Promise.all(ids.map((id) => cancelCommand(id)));
    },

    runBatchCommand: async (step) => {
      const { repoStates, runCommand: run, runningCommands, pushQueue, enqueuePush } = get();
      const busyRepos = new Set(Array.from(runningCommands.values()).map((c) => c.repoName));
      const queuedRepos = new Set(pushQueue.map((q) => q.repoName));
      const repos = getApplicableRepos(repoStates, step).filter((r) => !busyRepos.has(r) && !queuedRepos.has(r));

      for (const repoName of repos) {
        const state = repoStates.get(repoName);
        if (!state) continue;

        if (step === 0) {
          if (!state.parserExists) {
            await run(repoName, 'generate', undefined, 'batch');
          } else {
            await run(repoName, 'parse', undefined, 'batch');
          }
        } else if (step === 1) {
          // Review is manual — intercepted in the UI, no-op here
        } else if (step === 2) {
          if (!state.summarized.exists) {
            await run(repoName, 'summarize', { repoSummary: true }, 'batch');
          } else {
            enqueuePush(repoName, { repoSummary: true }, 'batch');
          }
        } else if (step === 3) {
          // Stale: re-parse with chain so handleCommandCompleted auto-runs
          // summarize → push (same path as the per-repo "Re-parse" action).
          await run(repoName, 'parse', { chain: true }, 'batch');
        }
      }
    },

    setActiveTerminalRepo: (repoName) => {
      set({ activeTerminalRepo: repoName });
    },

    clearTerminal: (repoName) => {
      if (repoName) {
        set((prev) => {
          const newCounter = new Map(prev.terminalClearCounter);
          newCounter.set(repoName, (newCounter.get(repoName) || 0) + 1);
          return { terminalClearCounter: newCounter };
        });
      } else {
        // Clear all
        set((prev) => {
          const newCounter = new Map<string, number>();
          for (const name of prev.terminalRepoNames) {
            newCounter.set(name, (prev.terminalClearCounter.get(name) || 0) + 1);
          }
          return { terminalClearCounter: newCounter };
        });
      }
    },

    openFile: async (filePath) => {
      try {
        await window.electronAPI.openPath(filePath);
      } catch (error) {
        console.error(`Failed to open file ${filePath}:`, error);
      }
    },

    setContextSelection: (ctx) => {
      set({ contextSelection: ctx });
    },

    forgetRepo: (repoName) => {
      set((prev) => {
        if (!prev.canceledRepos.has(repoName)) return prev;
        const next = new Set(prev.canceledRepos);
        next.delete(repoName);
        return { canceledRepos: next };
      });
    },

    markWizardCompleted: async () => {
      const { wizardCompleted, isMarkingCompleted, projectId } = get();
      if (wizardCompleted || isMarkingCompleted || !projectId) return;
      const targetProjectId = projectId;
      set({ isMarkingCompleted: true });
      try {
        const configResult = await window.electronAPI.loadConfig();
        if (configResult.success && configResult.config) {
          const config = configResult.config;
          const project = config.projects.find((p) => p.id === targetProjectId);
          if (project) {
            project.wizardCompleted = true;
          }
          const saveResult = await window.electronAPI.saveConfig(config);
          if (saveResult.success) {
            if (get().projectId === targetProjectId) {
              set({ wizardCompleted: true });
            }
            const { useProjectsStore } = await import('./projects-store');
            useProjectsStore.getState().syncWizardCompleted(targetProjectId, true);
          }
        }
      } finally {
        set({ isMarkingCompleted: false });
      }
    },

    markGraphReadyModalShown: async () => {
      const { graphReadyModalShown, projectId } = get();
      if (graphReadyModalShown || !projectId) return;
      // Optimistic set — UI hides the modal immediately; persistence is best-effort.
      set({ graphReadyModalShown: true });
      try {
        const configResult = await window.electronAPI.loadConfig();
        if (!configResult.success || !configResult.config) return;
        const config = configResult.config;
        const project = config.projects.find((p) => p.id === projectId);
        if (!project) return;
        project.graphReadyModalShown = true;
        await window.electronAPI.saveConfig(config);
      } catch (err) {
        console.error('Failed to persist graphReadyModalShown:', err);
      }
    },

    handleCommandCompleted: (result) => {
      const { runningCommands } = get();
      const command = runningCommands.get(result.id);
      if (!command) return;
      const commandProjectId = get().projectId;
      if (!commandProjectId) return;

      const removeCompletedCommand = () => {
        if (get().projectId !== commandProjectId) return;
        set((prev) => {
          if (!prev.runningCommands.has(result.id)) return prev;
          const newRunning = new Map(prev.runningCommands);
          newRunning.delete(result.id);
          return { runningCommands: newRunning };
        });
      };

      // Refresh the repo state after command completion, then sync to projects-store. Generate and
      // parse keep their completed command in the running map until this finishes, so Step 0 never
      // becomes clickable from stale parser/output facts during a generate→parse handoff.
      const refreshCompletedRepo = async (): Promise<boolean> => {
        try {
          await get().refreshRepoState(command.repoName);
          if (get().projectId !== commandProjectId) return false;
          const state = get().repoStates.get(command.repoName);
          const status = deriveRepoStatus(state, undefined);
          const { useProjectsStore } = await import('./projects-store');
          if (get().projectId !== commandProjectId) return false;
          useProjectsStore.getState().syncRepoStatus(commandProjectId, command.repoName, status);

          // Check if project is now complete
          const { repoStates, expectedRepoCount, wizardCompleted } = get();
          if (!wizardCompleted && isProjectComplete(repoStates, expectedRepoCount)) {
            get().markWizardCompleted();
          }
          return true;
        } catch (error) {
          console.error(`Failed to refresh state for ${command.repoName}:`, error);
          return get().projectId === commandProjectId;
        }
      };

      // A failed command used to vanish. It left `runningCommands`, the chain below
      // simply did not fire, and nothing else happened — so a run that died on a bad
      // token was indistinguishable from one that never started, unless the terminal
      // happened to be open. The transcript still holds the detail; this is the part
      // that reaches the user regardless of which panel they are looking at.
      if (!result.success) {
        void import('../hooks/use-toast').then(({ toast }) => {
          toast({
            title: `${command.action} failed for ${command.repoName}`,
            description:
              result.error?.trim() ||
              `Exited with code ${result.exitCode}. Open the repository's terminal for the full output.`,
            variant: 'destructive',
          });
        });
      }

      // A successful generate remains visibly busy through state refresh and parse dispatch. This
      // closes the window where stale `parserExists=false` made the Parse button start authoring a
      // second time. If the command was removed meanwhile (project switch or explicit cancel), do
      // not start the chained parse.
      if (result.success && command.action === 'generate') {
        void (async () => {
          const stillCurrent = await refreshCompletedRepo();
          if (!stillCurrent || !get().runningCommands.has(result.id)) return;
          await get().runCommand(command.repoName, 'parse', undefined, command.origin);
          removeCompletedCommand();
        })();
        return;
      }

      // Likewise, keep a successful parse busy until parsed-output facts are visible. Otherwise a
      // fast click after "Parsed successfully" can dispatch a duplicate Step-0 parse. Completed-mode
      // re-parses continue to summarize only after that refresh.
      if (result.success && command.action === 'parse' && command.args?.chain) {
        void (async () => {
          const stillCurrent = await refreshCompletedRepo();
          if (!stillCurrent || !get().runningCommands.has(result.id)) return;
          await get().runCommand(command.repoName, 'summarize', undefined, command.origin);
          removeCompletedCommand();
        })();
        return;
      }
      if (result.success && command.action === 'parse') {
        void refreshCompletedRepo().finally(removeCompletedCommand);
        return;
      }

      removeCompletedCommand();
      void refreshCompletedRepo();

      // Chain: summarize → push. Generate → parse and parse → summarize are handled above because
      // their transitional busy state is part of the correctness contract.
      if (result.success && command.action === 'summarize') {
        get().enqueuePush(command.repoName, undefined, command.origin);
      }

      // A push just finished — release the gate and start the next queued one.
      // Runs for both success and failure so a single failed push doesn't
      // wedge the queue for the rest of the project's repos.
      if (command.action === 'push') {
        set({ pushInFlight: false });
        void advancePushQueue();
      }

      // If docs command completed, update chat with doc cards
      if (command.action === 'docs') {
        (async () => {
          try {
            const { useChatStore } = await import('./chat-store');
            if (result.success) {
              const docsProjectId = get().projectId;
              if (!docsProjectId) return;
              const cloudWorkspaceId = command.args?.workspaceId as string | undefined;
              const docsResult = await window.electronAPI.listDocs(docsProjectId, [command.repoName], cloudWorkspaceId);
              if (!docsResult.success) {
                useChatStore.getState().completeDocsGeneration(result.id, [], 'Failed to load generated docs');
                return;
              }
              const docCards = (docsResult.docs ?? []).map((d) => ({
                id: d.id,
                repoName: d.repoName,
                title: d.title,
                category: d.category,
                generatedAt: d.generatedAt,
              }));
              useChatStore.getState().completeDocsGeneration(result.id, docCards);
            } else {
              useChatStore.getState().completeDocsGeneration(result.id, [], result.error);
            }
          } catch (e) {
            console.error('Failed to complete docs generation in chat:', e);
          }
        })();
      }
    },
  };
});
