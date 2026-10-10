/** Only what a person needs to follow the run; raw agent activity stays in the trace. */
import { Button } from '@/components/ui/button';
import { IntentMarkdown } from '@/features/intent/intent-markdown';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

import { type ConversationItem, durationText } from './agent-run-page';
import { type AgentTask, TASK_STATUS_LABELS } from './agent-run-presentation';
import { clockTime } from './agent-run-trace';
import { AnsweredQuestion, QuestionCard } from './QuestionCard';
import type { ActivityDrawer } from './RunActivityDrawers';
import { ScopeReviewActions } from './ScopeReview';
import type { AgentRunDetail, AgentRunTurnActivity } from './types';

const OUTCOME_NOTES: Record<string, string> = {
  no_outcome: 'no outcome',
  checkpoint: 'checkpoint, continued in a new turn',
  runner_lost: 'runner stopped responding',
  model_unavailable: 'model unavailable, retried',
  repository_requested: 'asked for a repository',
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function turnMeta(turn: AgentRunTurnActivity, now: Date): string {
  const parts: string[] = [];
  if (turn.state === 'claimed') {
    parts.push(
      turn.startedAt
        ? `running for ${durationText(Math.max(0, Math.round((now.getTime() - new Date(turn.startedAt).getTime()) / 1000)))}`
        : 'running',
    );
  } else if (turn.durationSeconds !== null) {
    parts.push(durationText(turn.durationSeconds));
  }
  parts.push(plural(turn.toolCalls, 'tool call', 'tool calls'));
  if (turn.failedToolCalls > 0) parts.push(`${turn.failedToolCalls} failed`);
  if (turn.state === 'abandoned') parts.push('abandoned');
  const note = turn.outcome
    ? (OUTCOME_NOTES[turn.outcome] ?? (turn.state === 'completed' ? null : turn.outcome))
    : null;
  if (note) parts.push(note);
  return parts.join(' · ');
}

function Avatar({ tone, children }: { tone: 'agent' | 'you' | 'ask'; children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        'z-[1] grid size-7 place-items-center rounded-full border-2 bg-surface text-[10px] font-bold',
        tone === 'agent' && 'border-brand text-brand-text',
        tone === 'you' && 'border-blue text-blue',
        tone === 'ask' && 'border-warn-text text-warn-text',
      )}
    >
      {children}
    </span>
  );
}

function Who({ label, at }: { label: string; at: string }) {
  return (
    <div className="mb-1 text-[12px] text-ink-3">
      <b className="font-semibold text-ink-1">{label}</b> · <span className="tabular-nums">{clockTime(at)}</span>
    </div>
  );
}

function Message({
  id,
  tone,
  avatar,
  className,
  children,
}: {
  id: string;
  tone: 'agent' | 'you' | 'ask';
  avatar: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <li id={`run-${id}`} className="grid scroll-mt-6 grid-cols-[28px_minmax(0,1fr)] gap-3">
      <Avatar tone={tone}>{avatar}</Avatar>
      <div
        className={cn(
          'min-w-0 max-w-[66ch] rounded-xl border px-3.5 py-2.5 text-[13.5px] text-ink-2',
          tone === 'you' ? 'border-transparent bg-blue-wash' : 'border-border bg-surface shadow-card',
          tone === 'ask' && 'border-warn-text',
          className,
        )}
      >
        {children}
      </div>
    </li>
  );
}

function Event({
  id,
  at,
  tone,
  children,
  detail,
}: {
  id: string;
  at: string;
  tone: 'ok' | 'plain' | 'err' | 'warn';
  children: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <li id={`run-${id}`} className="grid scroll-mt-6 grid-cols-[28px_minmax(0,1fr)] items-start gap-3">
      <span
        aria-hidden
        className={cn(
          'z-[1] mt-1 size-3 justify-self-center rounded-full shadow-[0_0_0_4px_var(--color-ground)]',
          tone === 'ok' && 'bg-brand',
          tone === 'plain' && 'bg-ink-4',
          tone === 'err' && 'bg-danger',
          tone === 'warn' && 'bg-warn-text',
        )}
      />
      <div className="min-w-0 text-[13px] font-semibold text-ink-1">
        {children}
        <span className="ml-1.5 font-normal tabular-nums text-ink-3">{clockTime(at)}</span>
        {detail && <div className="font-normal">{detail}</div>}
      </div>
    </li>
  );
}

const TASK_MARKERS = { completed: 'bg-brand', in_progress: 'bg-blue', pending: 'border border-border-soft' } as const;

function Item({
  wsId,
  run,
  item,
  now,
  onOpen,
}: {
  wsId: string;
  run: AgentRunDetail;
  item: ConversationItem;
  now: Date;
  onOpen: (drawer: ActivityDrawer) => void;
}) {
  switch (item.kind) {
    case 'started':
      return (
        <Event id={item.id} at={item.at} tone="plain">
          {item.text}
        </Event>
      );
    case 'turn': {
      const { turn } = item;
      return (
        <li
          id={`run-${item.id}`}
          className="grid max-w-[calc(66ch+40px)] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 text-[13.5px]"
        >
          <span
            aria-hidden
            className={cn(
              'z-[1] size-2.5 justify-self-center rounded-full shadow-[0_0_0_4px_var(--color-ground)]',
              turn.state === 'claimed' ? 'bg-brand' : 'bg-ink-4',
            )}
          />
          <span className="min-w-0 text-[13px] text-ink-2">
            {capitalize(turn.kind)} {turn.ordinal} <span className="text-ink-3">· {turnMeta(turn, now)}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[12px]"
            aria-label={`Trace of turn ${turn.ordinal}`}
            onClick={() => onOpen({ kind: 'trace', turnId: turn.id })}
          >
            Trace
          </Button>
        </li>
      );
    }
    case 'proposal': {
      const { spec } = item;
      return (
        <Message id={item.id} tone="agent" avatar="AI">
          <Who label={`Scope v${spec.version}`} at={item.at} />
          <div className="font-semibold text-ink-1">{spec.title}</div>
          <IntentMarkdown noRemote text={spec.summary} className="mt-1" />
          <p className="mt-1.5 text-[12.5px] text-ink-3">
            {plural(spec.repositories.length, 'repository', 'repositories')}:{' '}
            <span className="font-mono text-[12px]">
              {spec.repositories.map((repository) => repository.key).join(', ')}
            </span>
            {spec.candidates.length > 0 &&
              ` · ${plural(spec.candidates.length, 'candidate', 'candidates')} for the PRD`}
          </p>
          <button
            type="button"
            onClick={() => onOpen({ kind: 'spec', version: spec.version })}
            className="mt-1.5 text-[13px] text-blue hover:underline"
          >
            Open spec v{spec.version}
          </button>
          {item.reviewable && <ScopeReviewActions wsId={wsId} runId={run.id} version={spec.version} />}
        </Message>
      );
    }
    case 'review':
      return (
        <Message id={item.id} tone="you" avatar="YOU">
          <Who label={`Changes requested on v${item.spec.version}`} at={item.at} />
          <IntentMarkdown noRemote text={item.spec.reviewText ?? ''} />
        </Message>
      );
    case 'accepted':
      return (
        <Event id={item.id} at={item.at} tone="ok">
          Spec v{item.spec.version} {item.spec.autoAccepted ? 'accepted automatically' : 'accepted'}
        </Event>
      );
    case 'question':
      if (item.open) {
        return (
          <li id={`run-${item.id}`} className="grid scroll-mt-6 grid-cols-[28px_minmax(0,1fr)] gap-3">
            <Avatar tone="ask">?</Avatar>
            <div className="min-w-0 max-w-[66ch]">
              <QuestionCard wsId={wsId} run={run} question={item.question} />
            </div>
          </li>
        );
      }
      return (
        <Message id={item.id} tone="ask" avatar="?">
          <Who label={item.question.kind === 'repository_request' ? 'Repository request' : 'Question'} at={item.at} />
          <AnsweredQuestion question={item.question} />
        </Message>
      );
    case 'withheld':
      return (
        <Event
          id={item.id}
          at={item.at}
          tone="warn"
          detail={
            <details className="text-ink-2">
              <summary className="cursor-pointer text-[12.5px] text-blue">Paths and diff for a person to apply</summary>
              <p className="mt-1 font-mono text-[12px] text-ink-3">{item.paths.join(', ')}</p>
              {item.diff ? (
                <pre className="mt-1 overflow-x-auto whitespace-pre rounded-lg bg-surface-2 p-2 font-mono text-[12px] text-ink-3">
                  {item.diff}
                </pre>
              ) : (
                item.note && <p className="mt-1 text-[12.5px] text-ink-4">{item.note}</p>
              )}
            </details>
          }
        >
          {item.text}
        </Event>
      );
    case 'result': {
      const assumptions = (run.assumptions ?? []).filter((assumption) => assumption.phase !== 'scope');
      return (
        <Message id={item.id} tone="agent" avatar="AI" className="border-brand">
          <Who label="Result" at={item.at} />
          <IntentMarkdown noRemote text={item.result.summary} className="font-semibold text-ink-1" />
          {item.points.length > 0 && (
            <ul className="mt-1.5 list-disc pl-5">
              {item.points.map((point) => (
                <li key={point}>
                  <IntentMarkdown inline noRemote text={point} />
                </li>
              ))}
            </ul>
          )}
          {assumptions.length > 0 && (
            <>
              <div className="mt-2 text-[12px] font-medium uppercase tracking-[0.04em] text-ink-4">
                Assumed without asking
              </div>
              <ul className="list-disc pl-5">
                {assumptions.map((assumption) => (
                  <li key={assumption.text}>
                    <IntentMarkdown inline noRemote text={assumption.text} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {item.pulls.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-3.5 text-[13px]">
              {item.pulls.map((pull) => (
                <a
                  key={pull.repository}
                  href={pull.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue hover:underline"
                >
                  Pull request #{pull.number} ↗
                </a>
              ))}
            </div>
          )}
        </Message>
      );
    }
    case 'delivery':
      return (
        <Event
          id={item.id}
          at={item.at}
          tone={item.lines.some((line) => line.warning) ? 'warn' : 'ok'}
          detail={item.lines.map((line) => (
            <span key={line.text} className={cn('block text-[12.5px]', line.warning ? 'text-warn-text' : 'text-ink-3')}>
              {line.text}
            </span>
          ))}
        >
          {item.pulls.length > 0 ? item.pulls.map((pull) => `PR #${pull.number}`).join(', ') : 'Delivery'}
        </Event>
      );
    case 'ended':
      return (
        <Event
          id={item.id}
          at={item.at}
          tone={item.status === 'done' ? 'ok' : item.status === 'failed' ? 'err' : 'plain'}
        >
          <span className={item.status === 'failed' ? 'text-danger-text' : undefined}>{item.text}</span>
        </Event>
      );
  }
}

export function RunConversation({
  wsId,
  run,
  items,
  tasks,
  waitingSince,
  now,
  onOpen,
}: {
  wsId: string;
  run: AgentRunDetail;
  items: ConversationItem[];
  tasks: AgentTask[];
  waitingSince: string | null;
  now: Date;
  onOpen: (drawer: ActivityDrawer) => void;
}) {
  return (
    <section aria-label="Conversation" className="relative min-w-0 pl-1">
      <span aria-hidden className="absolute top-2 bottom-2 left-[17px] w-0.5 bg-border" />
      <ol className="relative flex flex-col gap-3">
        {items.map((item) => (
          <Item key={item.id} wsId={wsId} run={run} item={item} now={now} onOpen={onOpen} />
        ))}
        {tasks.length > 0 && (
          <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
            <span />
            <ul
              aria-label="Agent tasks"
              className="flex flex-col gap-1 rounded-xl border border-border-soft bg-surface px-3 py-2"
            >
              {tasks.map((task) => (
                <li key={`${task.status}:${task.text}`} className="flex items-start gap-2 text-[13px] text-ink-2">
                  <span
                    aria-hidden
                    className={`mt-[5px] size-2.5 shrink-0 rounded-full ${TASK_MARKERS[task.status]}`}
                  />
                  <span className="sr-only">{TASK_STATUS_LABELS[task.status]}: </span>
                  <span className={task.status === 'completed' ? 'text-ink-4 line-through' : undefined}>
                    {task.text}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        )}
        {waitingSince && (
          <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
            <span />
            <p className="rounded-lg bg-warn-wash px-3 py-2 text-[13px] text-warn-text">
              Waiting for an agent runner since {formatRelativeTime(waitingSince)}.
            </p>
          </li>
        )}
      </ol>
    </section>
  );
}
