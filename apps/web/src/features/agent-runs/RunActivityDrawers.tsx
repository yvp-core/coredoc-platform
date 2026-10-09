/**
 * What the agent did, for debugging: the Trace drawer (every turn's tool
 * calls with their results, failures with their output, and the agent's
 * messages, plus the transcript download) and the Skills and tools drawer
 * (counts). Both read the timeline and activity queries the page already polls.
 * `RunActivityDrawer` opens these and the spec and intent drawers.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import {
  agentRunActivityQueryOptions,
  agentRunTimelineQueryOptions,
  agentRunTranscriptUrl,
} from '@/api/queries/agent-runs';
import { EmptyNote } from '@/components/empty-note';
import { cn } from '@/lib/utils';

import { clockTime, skillLabel, type TraceRow, type TraceTone, traceTurns, transcriptPhases } from './agent-run-trace';
import { IntentDrawer, SpecDrawer } from './RunArtifactDrawers';
import { RunDrawer } from './RunDrawer';
import type { AgentRunDetail, AgentRunQuestion } from './types';

/**
 * Which drawer is open; a trace opened from a turn line expands only that
 * turn, and the spec opens at a version when one is named.
 */
export type ActivityDrawer =
  | { kind: 'trace'; turnId?: string }
  | { kind: 'skills' }
  | { kind: 'spec'; version?: number }
  | { kind: 'intent' }
  | null;

const TONES: Record<TraceTone, string> = {
  edit: 'bg-violet-wash text-violet-text',
  bash: 'bg-warn-wash text-warn-text',
  mcp: 'bg-blue-wash text-blue',
  run: 'bg-brand-wash text-brand-text',
  plain: 'bg-surface-2 text-ink-2',
};

const QUESTION_STATES: Record<AgentRunQuestion['state'], string> = {
  open: 'waiting for an answer',
  answered: 'answered',
  auto_answered: 'answered automatically',
  cancelled: 'cancelled',
};

/** Each part's chosen options and free text, or a dash before an answer. */
function chosen(question: AgentRunQuestion, index: number): string {
  const answer = question.answers?.[index];
  if (!answer) return '—';
  return [...answer.labels, ...(answer.other ? [`Other: ${answer.other}`] : [])].join(', ') || '—';
}

function QuestionRow({ row }: { row: Extract<TraceRow, { kind: 'question' }> }) {
  const { question } = row;
  const state = `${QUESTION_STATES[question.state]}${question.answeredAt ? ` ${clockTime(question.answeredAt)}` : ''}`;
  return (
    <li
      data-question={question.requestId}
      className="grid grid-cols-[40px_auto_minmax(0,1fr)_auto] items-center gap-2 py-[3px] text-[12.5px]"
    >
      <span className="tabular-nums text-ink-4">{clockTime(row.at)}</span>
      <span
        className={cn(
          'inline-flex min-w-11 justify-center rounded-[5px] px-1.5 py-px font-mono text-[11px] font-semibold',
          TONES.bash,
        )}
      >
        {question.kind === 'repository_request' ? 'Repo' : 'Ask'}
      </span>
      <span className="truncate text-ink-2" title={question.questions.map((part) => part.question).join('\n')}>
        {question.questions.map((part) => part.header).join(' · ')}
      </span>
      <span className="text-ink-4">{state}</span>
      <dl className="col-[3/-1] mb-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-md bg-surface-2 px-2 py-1.5">
        {question.questions.map((part, index) => (
          <div key={part.question} className="contents">
            <dt className="text-ink-4">{part.header}</dt>
            <dd className={question.answers ? 'font-medium text-brand-text' : 'text-ink-4'}>
              {chosen(question, index)}
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

function Row({ row }: { row: TraceRow }) {
  if (row.kind === 'question') return <QuestionRow row={row} />;
  const time = <span className="tabular-nums text-ink-4">{clockTime(row.at)}</span>;
  if (row.kind !== 'call') {
    return (
      <li className="grid grid-cols-[40px_minmax(0,1fr)] gap-2 py-[3px] text-[12.5px]">
        {time}
        <span className={cn('whitespace-pre-wrap', row.kind === 'line' ? 'font-mono text-ink-3' : 'text-ink-2')}>
          {row.text}
        </span>
      </li>
    );
  }
  return (
    <li
      data-failed={row.failed ? 'true' : undefined}
      className={cn(
        'grid grid-cols-[40px_auto_minmax(0,1fr)_auto] items-center gap-2 py-[3px] text-[12.5px]',
        row.failed && 'rounded-md bg-danger-wash',
      )}
    >
      {time}
      <span
        className={cn(
          'inline-flex min-w-11 justify-center rounded-[5px] px-1.5 py-px font-mono text-[11px] font-semibold',
          TONES[row.tone],
        )}
      >
        {row.label}
      </span>
      <span className="truncate font-mono text-ink-2" title={row.target ?? undefined}>
        {row.target}
      </span>
      <span className={cn('tabular-nums', row.failed ? 'font-semibold text-danger-text' : 'text-ink-4')}>
        {row.summary}
      </span>
      {row.result && (
        <span className="col-[3/-1] -mt-0.5 truncate font-mono text-[12px] text-ink-4" title={row.result}>
          {row.result}
        </span>
      )}
      {row.output && (
        <pre className="col-[3/-1] mb-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-ink-2">
          {row.output}
        </pre>
      )}
    </li>
  );
}

function TraceDrawer({
  wsId,
  run,
  turnId,
  onClose,
}: {
  wsId: string;
  run: AgentRunDetail;
  turnId?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const timeline = useQuery(agentRunTimelineQueryOptions(queryClient, wsId, run.id, run.status));
  const activity = useQuery(agentRunActivityQueryOptions(wsId, run.id, run.status));
  const turns = traceTurns(timeline.data ?? [], activity.data?.turns ?? [], run.questions ?? []);
  const chosen = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    chosen.current?.scrollIntoView?.({ block: 'start' });
  }, []);

  const downloads = transcriptPhases(activity.data).map((phase) => (
    <a
      key={phase}
      href={agentRunTranscriptUrl(wsId, run.id, phase)}
      download
      aria-label={`Download transcript: ${phase} phase`}
      title={`Download the ${phase} session transcript (JSONL)`}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-ink-2 hover:bg-surface-2"
    >
      <DownloadIcon className="size-3.5" />
      {phase}.jsonl
    </a>
  ));

  return (
    <RunDrawer title="Trace" actions={downloads} onClose={onClose}>
      {turns.length === 0 ? (
        <EmptyNote>No agent activity yet.</EmptyNote>
      ) : (
        turns.map((turn) => (
          <details key={turn.id} ref={turn.id === turnId ? chosen : undefined} open={!turnId || turn.id === turnId}>
            <summary className="flex cursor-pointer list-none items-baseline gap-2 py-1.5 text-[13px] font-semibold text-ink-1">
              {turn.title}
              <span className="font-normal tabular-nums text-ink-4">{clockTime(turn.startedAt)}</span>
            </summary>
            {turn.rows.length === 0 ? (
              <p className="pb-2 text-[12.5px] text-ink-4">Nothing reported for this turn.</p>
            ) : (
              <ol aria-label={`${turn.title} trace`} className="flex flex-col">
                {turn.rows.map((row) => (
                  <Row key={row.kind === 'question' ? `q-${row.question.requestId}` : row.seq} row={row} />
                ))}
              </ol>
            )}
          </details>
        ))
      )}
    </RunDrawer>
  );
}

function Counts({
  label,
  rows,
}: {
  label: string;
  rows: Array<{ key: string; name: string; title?: string; count: number }>;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="mt-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-3">{label}</h3>
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-4">None reported.</p>
      ) : (
        <ul aria-label={label} className="flex flex-col gap-1.5 text-[13px]">
          {rows.map((row) => (
            <li key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <span className="truncate font-mono text-ink-2" title={row.title}>
                {row.name}
              </span>
              <span className="tabular-nums text-ink-4">{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillsDrawer({ wsId, run, onClose }: { wsId: string; run: AgentRunDetail; onClose: () => void }) {
  const activity = useQuery(agentRunActivityQueryOptions(wsId, run.id, run.status));
  const skills = (activity.data?.skills ?? []).map((skill) => ({
    key: skill.name,
    name: skillLabel(skill.name),
    title: skill.name,
    count: skill.count,
  }));
  const tools = (activity.data?.tools ?? []).map((tool) => ({
    key: `${tool.server ?? ''}:${tool.name}`,
    name: tool.name,
    title: tool.server ? `${tool.server} MCP server` : undefined,
    count: tool.count,
  }));
  return (
    <RunDrawer title="Skills and tools" onClose={onClose}>
      <Counts label="Skills" rows={skills} />
      <Counts label="Tools" rows={tools} />
    </RunDrawer>
  );
}

export function RunActivityDrawer({
  wsId,
  slug,
  run,
  drawer,
  onClose,
}: {
  wsId: string;
  slug: string;
  run: AgentRunDetail;
  drawer: ActivityDrawer;
  onClose: () => void;
}) {
  switch (drawer?.kind) {
    case 'trace':
      return <TraceDrawer wsId={wsId} run={run} turnId={drawer.turnId} onClose={onClose} />;
    case 'skills':
      return <SkillsDrawer wsId={wsId} run={run} onClose={onClose} />;
    case 'spec':
      return <SpecDrawer wsId={wsId} run={run} version={drawer.version} onClose={onClose} />;
    case 'intent':
      return <IntentDrawer wsId={wsId} slug={slug} run={run} onClose={onClose} />;
    default:
      return null;
  }
}
