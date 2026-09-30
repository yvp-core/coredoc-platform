import { DangerTriangle } from '@solar-icons/react';
import { cn } from '../../lib/utils';
import { AgentRunPhase } from '../../../shared/agent-run-types';
import { useAgentRunStore, initialAgentRun } from '../../stores/agent-run-store';
import { StepChecklist } from './StepChecklist';
import { QuestionCard } from './QuestionCard';
import { RawLogPanel } from './RawLogPanel';

const PHASE_META: Record<AgentRunPhase, { label: string; className: string }> = {
  [AgentRunPhase.Starting]: { label: 'Starting', className: 'bg-bg-primary-selected text-content-tertiary' },
  [AgentRunPhase.Running]: { label: 'Authoring', className: 'bg-bg-primary-selected text-content-secondary' },
  [AgentRunPhase.Done]: { label: 'Done', className: 'bg-brand-600/15 text-brand-600' },
  [AgentRunPhase.Error]: { label: 'Error', className: 'bg-bg-warning/15 text-content-warning' },
};

/**
 * Native profile-authoring progress panel — replaces the embedded xterm terminal for the generate
 * step. Shows a minimal phase checklist, a native question card when the agent asks something, and
 * a collapsible raw log for debugging. Out-of-policy actions are auto-denied in the main process,
 * so there is no approval UI here.
 */
export function AgentRunPanel({ commandId, repoName }: { commandId: string; repoName: string }) {
  const run = useAgentRunStore((s) => s.runs.get(commandId)) ?? initialAgentRun();
  const answerQuestion = useAgentRunStore((s) => s.answerQuestion);
  const phase = PHASE_META[run.phase];

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h3 className="text-sm font-semibold text-content-primary">Authoring profile · {repoName}</h3>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', phase.className)}>{phase.label}</span>
        </div>
      </div>

      {run.phase === AgentRunPhase.Error && (
        <div className="flex items-start gap-2 rounded-lg border border-border-warning bg-bg-warning/10 p-3 text-sm text-content-primary">
          <DangerTriangle className="mt-0.5 size-4 shrink-0 text-content-warning" />
          <span>{run.error || 'The authoring session ended with an error. See the raw log for details.'}</span>
        </div>
      )}

      <StepChecklist todos={run.todos} />

      {run.pendingQuestion && (
        <QuestionCard
          questions={run.pendingQuestion.questions}
          onSubmit={(answers) => {
            if (run.pendingQuestion) answerQuestion(commandId, run.pendingQuestion.requestId, answers);
          }}
        />
      )}

      <div className="mt-auto">
        <RawLogPanel rawLog={run.rawLog} defaultOpen={run.phase === AgentRunPhase.Error} />
      </div>
    </div>
  );
}
