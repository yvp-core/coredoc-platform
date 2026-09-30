import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';
import type { AgentRunQuestion } from '../../../shared/agent-run-types';

interface QuestionState {
  selected: string[]; // option labels chosen from the list
  other: string; // free-text "Other" entry
}

/** Effective answer for a question: the free-text entry wins/augments the list selection. */
function effectiveAnswer(q: AgentRunQuestion, s: QuestionState): string[] {
  const other = s.other.trim();
  if (q.multiSelect) return other ? [...s.selected, other] : s.selected;
  return other ? [other] : s.selected;
}

export function QuestionCard({
  questions,
  onSubmit,
  disabled,
}: {
  questions: AgentRunQuestion[];
  onSubmit: (answers: string[][]) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<QuestionState[]>(() => questions.map(() => ({ selected: [], other: '' })));

  const setQuestion = (i: number, patch: Partial<QuestionState>) =>
    setState((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const toggle = (i: number, label: string, multi: boolean) => {
    setState((prev) =>
      prev.map((s, idx) => {
        if (idx !== i) return s;
        if (!multi) return { ...s, selected: [label], other: '' };
        const has = s.selected.includes(label);
        return { ...s, selected: has ? s.selected.filter((l) => l !== label) : [...s.selected, label] };
      }),
    );
  };

  const answers = questions.map((q, i) => effectiveAnswer(q, state[i]));
  const canSubmit = !disabled && answers.every((a) => a.length > 0);

  return (
    <div className="flex flex-col gap-5 rounded-xl border border-border-action bg-bg-primary p-4 shadow-surface">
      {questions.map((q, i) => {
        const s = state[i];
        return (
          <div key={`${q.question}-${i}`} className="flex flex-col gap-2.5">
            <span className="w-fit rounded-full bg-bg-primary-selected px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-content-tertiary">
              {q.header}
            </span>
            <p className="text-sm font-medium text-content-primary">{q.question}</p>
            <div className="flex flex-col gap-1.5">
              {q.options.map((opt) => {
                const checked = s.selected.includes(opt.label);
                return (
                  <button
                    type="button"
                    key={opt.label}
                    disabled={disabled}
                    onClick={() => toggle(i, opt.label, q.multiSelect)}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors',
                      checked
                        ? 'border-border-action bg-bg-primary-selected'
                        : 'border-border-input hover:bg-bg-primary-hover',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                        q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                      )}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm text-content-primary">{opt.label}</span>
                      {opt.description && <span className="text-xs text-content-tertiary">{opt.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <Input
              value={s.other}
              disabled={disabled}
              placeholder="Other… (type a custom answer)"
              onChange={(e) => setQuestion(i, { other: e.target.value })}
              className="h-8 text-sm"
            />
          </div>
        );
      })}
      <div className="flex justify-end">
        <Button size="sm" disabled={!canSubmit} onClick={() => onSubmit(answers)}>
          Send answer
        </Button>
      </div>
    </div>
  );
}
