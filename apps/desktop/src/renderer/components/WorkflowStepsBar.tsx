import { Check, InfoIcon } from 'lucide-react';
import { WORKFLOW_STEPS, type WorkflowStep, getRepoStep } from '../stores/project-detail-store';
import type { RepoDetailState } from '../../shared/ipc-types';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { cn } from '../lib/utils';

// Render only the wizard steps (0–2). Step 3 ("Update Graph") is post-wizard
// maintenance, driven from the completed view's stale-graph banner.
const WIZARD_STEPS = WORKFLOW_STEPS.slice(0, 3);

interface WorkflowStepsBarProps {
  currentStep: WorkflowStep | null;
  repoStates: Map<string, RepoDetailState>;
  compact?: boolean;
}

/**
 * Determines if a workflow step is fully completed across all repos.
 * A step is "completed" when every repo has progressed past it.
 */
function isStepCompleted(stepIndex: WorkflowStep, repoStates: Map<string, RepoDetailState>): boolean {
  if (repoStates.size === 0) return false;
  for (const state of repoStates.values()) {
    const repoStep = getRepoStep(state);
    // If repo is still on this step or earlier, it's not completed
    if (repoStep !== null && repoStep <= stepIndex) return false;
  }
  return true;
}

export function WorkflowStepsBar({ currentStep, repoStates, compact }: WorkflowStepsBarProps) {
  const allDone = currentStep === null && repoStates.size > 0;

  const circleSize = compact ? 'w-5 h-5' : 'w-8 h-8';
  const circleText = compact ? 'text-xs font-semibold' : 'text-sm font-semibold';
  const checkSize = compact ? 'w-3 h-3' : 'w-4 h-4';
  const lineTop = compact ? 'top-2.5' : 'top-4';
  const lineGap = compact ? '22px' : '28px';

  return (
    <div className={cn('px-4', compact ? 'pb-2 pt-1 shadow-scroll' : 'py-2')}>
      <div className="relative">
        {/* Connecting lines between step circles */}
        {[0, 1].map((i) => {
          return (
            <div
              key={`line-${i}`}
              className={`absolute ${lineTop} h-px bg-bg-supportive`}
              style={{
                left: i === 0 ? `calc(16.667% + ${lineGap})` : `calc(50% + ${lineGap})`,
                right: i === 0 ? `calc(50% + ${lineGap})` : `calc(16.667% + ${lineGap})`,
              }}
            />
          );
        })}

        {/* Steps grid: circle + label per column */}
        <div className="grid grid-cols-3">
          {WIZARD_STEPS.map((step, index) => {
            const completed = allDone || isStepCompleted(index as WorkflowStep, repoStates);
            const isCurrent = currentStep === index;
            return (
              <div key={index} className="flex flex-col items-center relative gap-0.5">
                <div
                  className={cn(
                    `relative shadow-card ${circleText} z-10 ${circleSize} border bg-bg-primary border-transparent ring-1 ring-transparent rounded-full flex items-center justify-center shrink-0`,
                    completed && 'border-bg-tag-success bg-bg-tag-success text-content-tag-success',
                    isCurrent && !completed && 'border-border-action text-content-primary',
                    !isCurrent && !completed && 'text-content-quaternary',
                  )}
                >
                  {completed ? <Check className={checkSize} /> : index + 1}
                </div>

                {!compact && (
                  <span
                    className={cn(
                      'text-xs',
                      completed || isCurrent ? 'text-content-primary' : 'text-content-quaternary',
                    )}
                  >
                    {step.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {!compact && (
        <Alert variant="amber" className="max-w-full mt-2">
          <InfoIcon className="size-4" />
          <AlertTitle>
            {WORKFLOW_STEPS[currentStep || 0].alertTitle || WORKFLOW_STEPS[currentStep || 0].label}
          </AlertTitle>
          <AlertDescription className="text-content-secondary">
            {allDone
              ? 'All repositories are up to date.'
              : currentStep !== null
                ? WORKFLOW_STEPS[currentStep].description
                : 'Add repositories to get started.'}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
