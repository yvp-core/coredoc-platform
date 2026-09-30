import { Check } from 'lucide-react';
import { Button } from './ui/button';
import { WORKFLOW_STEPS, getApplicableRepos, type WorkflowStep } from '../stores/project-detail-store';
import type { RepoDetailState } from '../../shared/ipc-types';
import type { RunningCommand } from '../stores/project-detail-store';

interface TerminalBatchActionBarProps {
  currentStep: WorkflowStep | null;
  repoStates: Map<string, RepoDetailState>;
  runningCommands: Map<string, RunningCommand>;
  onRunBatch: (step: WorkflowStep) => void;
  onStopAll: () => void;
  runActionLabel?: string;
}

export function TerminalBatchActionBar({
  currentStep,
  repoStates,
  runningCommands,
  onRunBatch,
  onStopAll,
  runActionLabel,
}: TerminalBatchActionBarProps) {
  const isRunning = runningCommands.size > 0;
  const allDone = currentStep === null && repoStates.size > 0;

  const pendingCount = currentStep === null ? 0 : getApplicableRepos(repoStates, currentStep).length;

  const showRun = !isRunning && (currentStep !== null || runActionLabel);
  const showUpToDate = !isRunning && allDone && !runActionLabel;
  if (!isRunning && !showRun && !showUpToDate) return null;

  return (
    <div className="flex items-center justify-end rounded-b-xl bg-gray-50 px-4 pt-2 pb-2.5 shadow-foundation">
      {pendingCount > 0 && (
        <span className="flex-1 px-2 text-right text-xs leading-4 text-content-tertiary">
          {pendingCount === 1 ? '1 repository requires' : `${pendingCount} repositories require`} this step
        </span>
      )}
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Button variant="destructive" size="sm" onClick={onStopAll}>
            Stop Update
          </Button>
        ) : showUpToDate ? (
          <Button variant="outline" disabled className="gap-2">
            <Check className="h-3.5 w-3.5" />
            Up to date
          </Button>
        ) : showRun ? (
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
