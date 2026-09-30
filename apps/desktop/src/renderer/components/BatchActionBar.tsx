import { Check } from 'lucide-react';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import {
  WORKFLOW_STEPS,
  type WorkflowStep,
  getApplicableRepos,
  getReviewApproveLabel,
  type ReviewFlowNext,
} from '../stores/project-detail-store';
import type { RepoDetailState } from '../../shared/ipc-types';
import type { RunningCommand } from '../stores/project-detail-store';

interface BatchActionBarProps {
  currentStep: WorkflowStep | null;
  repoStates: Map<string, RepoDetailState>;
  runningCommands: Map<string, RunningCommand>;
  onRunBatch: (step: WorkflowStep) => void;
  onStopAll: () => void;
  runActionLabel?: string;
  // Review-mode props
  reviewingRepo?: string | null;
  canApprove?: boolean;
  isApproved?: boolean;
  isApproving?: boolean;
  flowNext?: ReviewFlowNext | null;
  onBack?: () => void;
  onReparse?: () => void;
  onApproveAndNext?: () => void;
}

export function BatchActionBar({
  currentStep,
  repoStates,
  runningCommands,
  onRunBatch,
  onStopAll,
  runActionLabel,
  reviewingRepo,
  canApprove,
  isApproved,
  isApproving,
  flowNext,
  onBack,
  onReparse,
  onApproveAndNext,
}: BatchActionBarProps) {
  const isRunning = runningCommands.size > 0;
  const allDone = currentStep === null && repoStates.size > 0;

  const applicableCount = currentStep !== null ? getApplicableRepos(repoStates, currentStep).length : 0;
  const totalRepos = repoStates.size;

  // Review mode layout
  if (reviewingRepo) {
    const approveLabel = flowNext ? getReviewApproveLabel(flowNext, !!isApproved) : isApproved ? 'Continue' : 'Approve';

    return (
      <div className="px-4 py-3 bg-bg-overlay flex items-center justify-between gap-3 ">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-content-tertiary">
            {applicableCount} of {totalRepos} {applicableCount === 1 ? 'repository requires' : 'repositories require'}{' '}
            this step
          </span>
          <Button variant="secondary" onClick={onReparse}>
            Re-parse Repository
          </Button>
          <Button variant="brand" onClick={onApproveAndNext} disabled={!canApprove || isApproving}>
            {isApproving && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
            {approveLabel}
          </Button>
        </div>
      </div>
    );
  }

  // Default batch layout
  return (
    <div className="px-4 py-3 bg-bg-overlay flex items-center justify-end gap-3">
      {/* Left: info text */}
      <span className="text-xs text-content-tertiary">
        {allDone
          ? 'All repositories are up to date'
          : currentStep !== null
            ? `${applicableCount} of ${totalRepos} ${applicableCount === 1 ? 'repository requires' : 'repositories require'} this step`
            : 'Add repositories to get started'}
      </span>

      {/* Right: action buttons */}
      <div className="flex items-center gap-2">
        {isRunning ? (
          <>
            <Button variant="destructive" onClick={onStopAll}>
              Stop Parsing
            </Button>
          </>
        ) : allDone && !runActionLabel ? (
          <Button variant="outline" disabled className="gap-2">
            <Check className="h-3.5 w-3.5" />
            Up to date
          </Button>
        ) : currentStep !== null || runActionLabel ? (
          <Button
            variant="brand"
            size="lg"
            onClick={() => onRunBatch(currentStep ?? 0)}
            className="gap-2 text-sm font-medium"
          >
            {runActionLabel ?? (currentStep !== null ? WORKFLOW_STEPS[currentStep].btnLabel : '')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
