/**
 * The parse-review flow: which repo is under review, and where the user goes
 * after approving it.
 *
 * All of this used to sit inline in CompletedView. It is grouped here because
 * the routing decision (`getReviewFlowNext`) has to be re-derived from *live*
 * store state after an await, not from the props the component closed over —
 * the guards below are the whole reason this is fiddly, and they belong next to
 * each other rather than scattered through a 900-line view.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  getApplicableRepos,
  getReviewFlowNext,
  useProjectDetailStore,
  type ContextSelection,
  type ReviewFlowNext,
  type RunningCommand,
  type WorkflowStep,
} from '../../../stores/project-detail-store';
import type { RepoDetailState } from '../../../../shared/ipc-types';
import type { Project, ProjectRepository } from '../../../types/project';

export interface UseReviewFlowArgs {
  project: Project;
  repoStates: Map<string, RepoDetailState>;
  runningCommands: Map<string, RunningCommand>;
  incompleteRepos: ProjectRepository[];
  incompleteStep: WorkflowStep | null;
  runBatchCommand: (step: WorkflowStep) => Promise<void>;
  setContextSelection: (ctx: ContextSelection) => void;
  setActiveTerminalRepo: (repoName: string | null) => void;
  /**
   * Claim the docked slot for a repo's terminal. Required: clearing
   * reviewingRepo releases the slot, so a branch that starts work without also
   * asking for the terminal would leave the panel blank.
   */
  requestTerminal: (repoName: string) => void;
}

export interface ReviewFlow {
  reviewingRepo: string | null;
  flowNext: ReviewFlowNext | null;
  /** Open review for a specific repo, bypassing the review-readiness check. */
  openReviewFor: (repoName: string) => void;
  closeReview: () => void;
  /** Run the batch for the current outstanding step, or open review if that step is review. */
  runIncompleteBatch: () => void;
  approveAndNext: () => Promise<void>;
}

export function useReviewFlow({
  project,
  repoStates,
  runningCommands,
  incompleteRepos,
  incompleteStep,
  runBatchCommand,
  setContextSelection,
  setActiveTerminalRepo,
  requestTerminal,
}: UseReviewFlowArgs): ReviewFlow {
  const [reviewingRepo, setReviewingRepo] = useState<string | null>(null);

  // pushQueue subscription — see note in WizardView.
  const pushQueue = useProjectDetailStore((s) => s.pushQueue);

  const flowNext = useMemo(() => {
    if (!reviewingRepo) return null;
    if (!repoStates.has(reviewingRepo)) return null;
    return getReviewFlowNext(reviewingRepo, repoStates, runningCommands, pushQueue);
  }, [reviewingRepo, repoStates, runningCommands, pushQueue]);

  // Live-value ref for async-handler reentry checks (see WizardView/ReviewPanel).
  const reviewingRepoRef = useRef(reviewingRepo);
  useLayoutEffect(() => {
    reviewingRepoRef.current = reviewingRepo;
  }, [reviewingRepo]);

  // Mount guard. `useRef(false)` initial survives StrictMode dev cycle.
  const reviewMountedRef = useRef(false);
  useEffect(() => {
    reviewMountedRef.current = true;
    return () => {
      reviewMountedRef.current = false;
    };
  }, []);

  const firstReviewable = useCallback((): string | undefined => {
    const states = new Map<string, RepoDetailState>();
    for (const repo of incompleteRepos) {
      const state = repoStates.get(repo.name);
      if (state) states.set(repo.name, state);
    }
    return getApplicableRepos(states, 1)[0];
  }, [incompleteRepos, repoStates]);

  const openReviewFor = useCallback((repoName: string) => setReviewingRepo(repoName), []);
  const closeReview = useCallback(() => setReviewingRepo(null), []);

  const runIncompleteBatch = useCallback(() => {
    if (incompleteStep === null) return;
    if (incompleteStep === 1) {
      const next = firstReviewable();
      if (next) setReviewingRepo(next);
      return;
    }
    void runBatchCommand(incompleteStep);
  }, [incompleteStep, firstReviewable, runBatchCommand]);

  const approveAndNext = useCallback(async () => {
    if (!reviewingRepo) return;
    const repoAtClick = reviewingRepo;
    const projectIdAtClick = project.id;
    // ReviewPanel already ran approveParser, refresh, and the {success:false}
    // guard before invoking us. Just route here.
    if (!reviewMountedRef.current) return;
    if (reviewingRepoRef.current !== repoAtClick) return;
    const storeNow = useProjectDetailStore.getState();
    if (storeNow.projectId !== projectIdAtClick) return;
    if (!storeNow.repoStates.has(repoAtClick)) {
      setReviewingRepo(null);
      return;
    }
    const liveFlow = getReviewFlowNext(repoAtClick, storeNow.repoStates, storeNow.runningCommands, storeNow.pushQueue);
    switch (liveFlow.kind) {
      case 'review-next':
        setReviewingRepo(liveFlow.nextRepo);
        setContextSelection({ kind: 'repo', repoName: liveFlow.nextRepo });
        break;
      case 'wait-parsing':
        setReviewingRepo(null);
        setContextSelection({ kind: 'repo', repoName: liveFlow.terminalRepo });
        setActiveTerminalRepo(liveFlow.terminalRepo);
        requestTerminal(liveFlow.terminalRepo);
        break;
      case 'build-graph': {
        setReviewingRepo(null);
        const first = getApplicableRepos(storeNow.repoStates, 2)[0] ?? repoAtClick;
        setActiveTerminalRepo(first);
        requestTerminal(first);
        await runBatchCommand(2);
        break;
      }
      case 'done':
        setReviewingRepo(null);
        break;
    }
  }, [reviewingRepo, project.id, runBatchCommand, setContextSelection, setActiveTerminalRepo, requestTerminal]);

  return {
    reviewingRepo,
    flowNext,
    openReviewFor,
    closeReview,
    runIncompleteBatch,
    approveAndNext,
  };
}
