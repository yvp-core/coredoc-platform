/**
 * Everything CompletedView derives from (project, repoStates, runningCommands).
 *
 * Pure and selection-free on purpose: nothing here reads the context selection,
 * the active tab, or the docked panel, so the whole set can be recomputed in a
 * single `useMemo` and unit-tested without React. Anything that depends on what
 * the user has *selected* stays in the view.
 */
import {
  getProjectStep,
  getRepoStep,
  GRAPH_MUTATING_ACTIONS,
  type RunningCommand,
  type WorkflowAction,
  type WorkflowStep,
} from '../../../stores/project-detail-store';
import { RUNNING_DRAWER_ACTIONS } from './docked-panel';
import type { RepoDetailState } from '../../../../shared/ipc-types';
import type { Project, ProjectRepository } from '../../../types/project';

export interface WorkspaceFacts {
  /** Repos that still have a workflow step outstanding. */
  incompleteRepos: ProjectRepository[];
  /** The lowest outstanding step across `incompleteRepos`, or null when none. */
  incompleteStep: WorkflowStep | null;
  /** A summarize or push is in flight — the graph itself is being rewritten. */
  isGraphUpdating: boolean;
  /** Distinct repos running a graph-mutating command, in command order. */
  runningRepoNames: string[];
  /**
   * The graph-building stage each repo is on, for repos running one. Scoped to
   * the actions the running drawer renders — `generate` mutates the graph too,
   * but its output is an agent transcript with no stage label — so a repo absent
   * from this map is not in the drawer's running state even if it is busy.
   */
  runningStageByRepo: Map<string, WorkflowAction>;
  /** Every repo has been pushed to the graph at least once. */
  allSynced: boolean;
  /**
   * At least one repo has been pushed. Gates affordances that only need
   * *something* in the graph (the Team MCP button) — `allSynced` stays the gate
   * for cloud comparison/auto-sync, which is only meaningful on a full push.
   */
  anySynced: boolean;
  /** Pushed repos whose worktree has moved on since the parse. */
  staleRepos: RepoDetailState[];
  /** Most recent `lastPushed` across all repos, or undefined if nothing was pushed. */
  latestPush: string | undefined;
}

export interface BannerVisibilityArgs {
  /** Tri-state: `undefined` while the workspace list hasn't loaded yet — see D6. */
  ciCdEnabled: boolean | undefined;
  staleRepoCount: number;
  staleDismissed: boolean;
  cloudEnabled: boolean;
  cloudOutdated: boolean;
}

export interface BannerVisibility {
  showStaleBanner: boolean;
  showCloudBanner: boolean;
}

/**
 * CI/CD-managed workspaces re-parse on push, so the local staleness signals
 * are noise there. `true` and `undefined` (not yet known) both suppress —
 * only a confirmed `false` falls back to today's per-signal conditions.
 */
export function bannerVisibility({
  ciCdEnabled,
  staleRepoCount,
  staleDismissed,
  cloudEnabled,
  cloudOutdated,
}: BannerVisibilityArgs): BannerVisibility {
  if (ciCdEnabled !== false) {
    return { showStaleBanner: false, showCloudBanner: false };
  }
  return {
    showStaleBanner: staleRepoCount > 0 && !staleDismissed,
    showCloudBanner: cloudEnabled && cloudOutdated,
  };
}

export function deriveWorkspaceFacts(
  project: Project,
  repoStates: Map<string, RepoDetailState>,
  runningCommands: Map<string, RunningCommand>,
): WorkspaceFacts {
  const commands = Array.from(runningCommands.values());
  const repoStatesArray = Array.from(repoStates.values());

  const incompleteRepos = project.repositories.filter((repo) => {
    const state = repoStates.get(repo.name);
    return state !== undefined && getRepoStep(state) !== null;
  });

  // getProjectStep takes the minimum across the map it is given, so scope it to
  // the incomplete repos — a finished repo would otherwise contribute null and
  // a wizard-stage repo would drag the whole project back to its step.
  const incompleteStates = new Map<string, RepoDetailState>();
  for (const repo of incompleteRepos) {
    const state = repoStates.get(repo.name);
    if (state) incompleteStates.set(repo.name, state);
  }

  const syncedCount = repoStatesArray.filter((s) => s.neo4jSynced.synced).length;

  // First command wins per repo: the chain runs one stage at a time, so the
  // earliest in flight is the stage the repo is actually on.
  const runningStageByRepo = new Map<string, WorkflowAction>();
  for (const command of commands) {
    if (!RUNNING_DRAWER_ACTIONS.has(command.action)) continue;
    if (!runningStageByRepo.has(command.repoName)) runningStageByRepo.set(command.repoName, command.action);
  }

  return {
    incompleteRepos,
    incompleteStep: incompleteRepos.length === 0 ? null : getProjectStep(incompleteStates),
    isGraphUpdating: commands.some((c) => c.action === 'summarize' || c.action === 'push'),
    runningRepoNames: [...new Set(commands.filter((c) => GRAPH_MUTATING_ACTIONS.has(c.action)).map((c) => c.repoName))],
    runningStageByRepo,
    allSynced: repoStatesArray.length > 0 && syncedCount === repoStatesArray.length,
    anySynced: syncedCount > 0,
    staleRepos: repoStatesArray.filter((s) => s.neo4jSynced.synced && s.staleness?.reason === 'new_commits'),
    latestPush: repoStatesArray
      .map((s) => s.operations?.lastPushed)
      .filter((t): t is string => typeof t === 'string')
      .sort()
      .pop(),
  };
}
