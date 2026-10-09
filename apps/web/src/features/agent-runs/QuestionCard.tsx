import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '@/api/client';
import { answerAgentRunQuestion } from '@/api/queries/agent-runs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { IntentMarkdown } from '@/features/intent/intent-markdown';
import { formatRelativeTime } from '@/lib/time';

import type { AgentRunDetail, AgentRunQuestion, AskedQuestion, QuestionAnswer } from './types';

/** One question's draft: chosen labels, free text, and (single choice) whether "Other" is the choice. */
interface Draft {
  labels: string[];
  other: string;
  otherChosen: boolean;
}

const EMPTY: Draft = { labels: [], other: '', otherChosen: false };

function isAnswered(question: AskedQuestion, draft: Draft): boolean {
  if (question.multiSelect) return draft.labels.length > 0 || draft.other.trim() !== '';
  return draft.otherChosen ? draft.other.trim() !== '' : draft.labels.length === 1;
}

function toAnswer(question: AskedQuestion, draft: Draft): QuestionAnswer {
  const other = draft.other.trim();
  if (!question.multiSelect) return draft.otherChosen ? { labels: [], other } : { labels: draft.labels };
  return other ? { labels: draft.labels, other } : { labels: draft.labels };
}

function QuestionFields({
  question,
  draft,
  onChange,
  freeText,
}: {
  question: AskedQuestion;
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** Repository requests take one of their fixed options only. */
  freeText: boolean;
}) {
  const name = useId();
  const otherId = useId();
  const type = question.multiSelect ? 'checkbox' : 'radio';
  const toggle = (label: string) => {
    if (!question.multiSelect) return onChange({ ...draft, labels: [label], otherChosen: false });
    const labels = draft.labels.includes(label) ? draft.labels.filter((l) => l !== label) : [...draft.labels, label];
    onChange({ ...draft, labels });
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-1">
        <Badge variant="neutral">{question.header}</Badge>
        <IntentMarkdown inline noRemote text={question.question} />
        {question.multiSelect && <span className="text-[12px] text-ink-4">Choose any</span>}
      </legend>
      {question.options.map((option) => (
        <label
          key={option.label}
          className="flex cursor-pointer gap-2 rounded-lg border border-border-soft px-3 py-2 text-[13.5px]"
        >
          <input
            type={type}
            name={name}
            className="mt-1"
            checked={draft.labels.includes(option.label)}
            onChange={() => toggle(option.label)}
          />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-ink-1">{option.label}</span>
            <span className="text-ink-3">{option.description}</span>
            {option.preview && (
              // Agent-written; shown as text, never rendered.
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 font-mono text-[12px] text-ink-3">
                {option.preview}
              </pre>
            )}
          </span>
        </label>
      ))}
      {freeText && (
        <div className="flex items-center gap-2 px-3 text-[13.5px]">
          {!question.multiSelect && (
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                checked={draft.otherChosen}
                onChange={() => onChange({ ...draft, labels: [], otherChosen: true })}
              />
              Other
            </label>
          )}
          <label htmlFor={otherId} className="sr-only">
            Other answer
          </label>
          <Input
            id={otherId}
            value={draft.other}
            placeholder={question.multiSelect ? 'Something else (optional)' : 'Your own answer'}
            onChange={(event) =>
              onChange({
                ...draft,
                other: event.target.value,
                ...(question.multiSelect ? {} : { labels: [], otherChosen: true }),
              })
            }
          />
        </div>
      )}
    </fieldset>
  );
}

function OpenQuestion({ wsId, run, open }: { wsId: string; run: AgentRunDetail; open: AgentRunQuestion }) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Draft[]>(() => open.questions.map(() => EMPTY));
  const answer = useMutation({
    mutationFn: answerAgentRunQuestion,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', run.id] });
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', 'list'] });
    },
  });
  const ready = open.questions.every((question, index) => isAnswered(question, drafts[index]!));
  const repositoryRequest = open.kind === 'repository_request';

  return (
    <Card
      role="region"
      aria-label={repositoryRequest ? 'Repository request from the agent' : 'Question from the agent'}
    >
      <CardHead
        title={repositoryRequest ? 'The agent asks to add a repository' : 'The agent is waiting for an answer'}
        sub={
          repositoryRequest
            ? `Asked ${formatRelativeTime(open.askedAt)}, while implementing. Adding it widens the accepted scope; your decision resumes the same session.`
            : `Asked ${formatRelativeTime(open.askedAt)}, while ${open.phase === 'scope' ? 'scoping' : 'implementing'}. Your answer resumes the same session.`
        }
      />
      <CardBody>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            answer.mutate({
              wsId,
              runId: run.id,
              requestId: open.requestId,
              answers: open.questions.map((question, index) => toAnswer(question, drafts[index]!)),
            });
          }}
        >
          {open.questions.map((question, index) => (
            <QuestionFields
              key={question.question}
              question={question}
              draft={drafts[index]!}
              onChange={(draft) => setDrafts((current) => current.map((d, i) => (i === index ? draft : d)))}
              freeText={!repositoryRequest}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!ready || answer.isPending}>
              {answer.isPending ? 'Sending…' : repositoryRequest ? 'Send decision' : 'Send answer'}
            </Button>
            {answer.error && (
              <span className="text-[13px] text-danger-text">
                {answer.error instanceof ApiError ? answer.error.message : 'Failed to send the answer'}
              </span>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/**
 * The question card: the agent's open question with headers, options,
 * descriptions, previews, single or multiple choice and a free-text "Other".
 * A repository request offers only its fixed "Add" and "Don't add".
 * Exactly one answer is accepted; a reviewer who answers second is told so.
 */
export function QuestionCard({
  wsId,
  run,
  question,
}: {
  wsId: string;
  run: AgentRunDetail;
  question: AgentRunQuestion;
}) {
  return <OpenQuestion key={question.requestId} wsId={wsId} run={run} open={question} />;
}

const RESOLUTION: Record<Exclude<AgentRunQuestion['state'], 'open'>, string> = {
  answered: 'Answered',
  auto_answered: 'Answered automatically (assume policy)',
  cancelled: 'Cancelled: the run ended',
};

/** A question that is no longer open, each part with its options and the chosen ones marked. */
export function AnsweredQuestion({ question }: { question: AgentRunQuestion }) {
  return (
    <div className="flex flex-col gap-3">
      {question.questions.map((asked, index) => {
        const answer = question.answers?.[index];
        return (
          <div key={asked.question} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-1">
              <Badge variant="neutral">{asked.header}</Badge>
              <IntentMarkdown inline noRemote text={asked.question} />
            </div>
            <ul aria-label={`Options: ${asked.header}`} className="flex flex-col gap-1 text-[13px]">
              {asked.options.map((option) => {
                const picked = answer?.labels.includes(option.label) ?? false;
                return (
                  <li
                    key={option.label}
                    aria-current={picked ? 'true' : undefined}
                    className={
                      picked
                        ? 'rounded-md border border-brand bg-brand-wash px-2 py-1 font-medium text-brand-text'
                        : 'rounded-md border border-border-soft px-2 py-1 text-ink-3'
                    }
                  >
                    {option.label}
                  </li>
                );
              })}
              {answer?.other && (
                <li
                  aria-current="true"
                  className="rounded-md border border-brand bg-brand-wash px-2 py-1 text-brand-text"
                >
                  <span className="font-medium">Other: </span>
                  {answer.other}
                </li>
              )}
            </ul>
          </div>
        );
      })}
      {question.state !== 'open' && (
        <p className="text-[12.5px] text-ink-4">
          {RESOLUTION[question.state]}
          {question.answeredAt ? ` ${formatRelativeTime(question.answeredAt)}` : ''}
        </p>
      )}
    </div>
  );
}
