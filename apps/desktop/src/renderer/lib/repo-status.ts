import type { RepoStatusState } from '../../shared/ipc-types';
import type { RepositoryStatus } from '../types/project';
import type { WorkflowAction } from '../stores/project-detail-store';

/**
 * Derive a RepositoryStatus from repo state + optional running action.
 * Running commands take priority over static state.
 */
export function deriveRepoStatus(
  state: Omit<RepoStatusState, 'name'> | undefined | null,
  runningAction?: WorkflowAction,
): RepositoryStatus {
  // Running command takes priority
  if (runningAction) {
    switch (runningAction) {
      case 'generate':
        return 'parser_creation';
      case 'parse':
        return 'parsing';
      case 'summarize':
        return 'summarising';
      case 'push':
        return state?.neo4jSynced.synced ? 'updating_graph' : 'creating_graph';
      // 'docs' has no corresponding status — fall through to static state
    }
  }

  // Static derivation from state
  if (!state) return 'not_started';

  // The profile + parsed artifact are the foundation every later status describes:
  // approval, summaries and the graph all refer to *that* snapshot. Without them the
  // repo is back at step 0 no matter what the operations DB remembers — a `push` row
  // from an earlier workspace generation must not report "graph up to date" while
  // getRepoStep() (the wizard's own source of truth) puts the repo at step 0. That
  // disagreement is what made the wizard open the chat panel for an unparsed repo.
  if (!state.parserExists || !state.parsed.exists) return 'not_started';

  if (state.neo4jSynced.synced) {
    return state.staleness?.isStale ? 'graph_needs_update' : 'graph_up_to_date';
  }
  if (state.summarized.exists) return 'summarised';
  if (!state.approval) return 'parsed_pending_review';
  if (state.approval.isStale) return 'approval_stale';
  if (state.approval.approved) return 'approved';
  return 'parsed_pending_review';
}
