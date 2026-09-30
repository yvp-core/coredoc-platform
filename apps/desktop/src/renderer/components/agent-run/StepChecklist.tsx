import { Check } from 'lucide-react';
import { Spinner } from '../ui/spinner';
import { cn } from '../../lib/utils';
import { AgentTodoStatus, type AgentTodoItem } from '../../../shared/agent-run-types';
import { buildChecklist, currentActivityLabel, type ChecklistRow } from './checklist';

function RowIcon({ status }: { status: AgentTodoStatus }) {
  if (status === AgentTodoStatus.Completed) {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-brand-600 text-white">
        <Check className="size-3" />
      </span>
    );
  }
  if (status === AgentTodoStatus.InProgress) {
    return (
      <span className="flex size-5 items-center justify-center rounded-full border border-border-action text-content-primary">
        <Spinner className="size-3" />
      </span>
    );
  }
  return <span className="size-5 rounded-full border border-border-input" aria-hidden />;
}

function Row({ row }: { row: ChecklistRow }) {
  const done = row.status === AgentTodoStatus.Completed;
  const active = row.status === AgentTodoStatus.InProgress;
  return (
    <li className={cn('flex items-center gap-2.5', row.kind === 'subtask' && 'pl-7')}>
      <RowIcon status={row.status} />
      <span
        className={cn(
          row.kind === 'subtask' ? 'text-xs' : 'text-sm',
          done && 'text-content-tertiary line-through',
          active && 'font-medium text-content-primary',
          !done && !active && 'text-content-secondary',
        )}
      >
        {row.text}
      </span>
    </li>
  );
}

export function StepChecklist({ todos }: { todos: AgentTodoItem[] }) {
  const rows = buildChecklist(todos);
  const label = currentActivityLabel(rows);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-content-secondary">
        <Spinner className="size-4" />
        <span className="truncate">{label}</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row, i) => (
          <Row key={`${row.kind}-${row.text}-${i}`} row={row} />
        ))}
      </ul>
    </div>
  );
}
