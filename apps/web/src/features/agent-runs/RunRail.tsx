import {
  AlignLeftIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  FileTextIcon,
  GitPullRequestIcon,
  LightbulbIcon,
  TicketIcon,
  WrenchIcon,
} from 'lucide-react';

import { plural } from '@coredoc/core/browser/format';
import { cn } from '@/lib/utils';

import { durationText, jiraOutcomeLines, type RunStage } from './agent-run-page';
import { clockTime } from './agent-run-trace';
import type { ActivityDrawer } from './RunActivityDrawers';
import { SPEC_STATUS_LABELS } from './ScopeReview';
import type { AgentRunActivity, AgentRunDetail, AgentRunSpec } from './types';

export function StageRail({
  stages,
  span,
  running,
  onJump,
}: {
  stages: RunStage[];
  span: { startedAt: string; endedAt: string | null; durationSeconds: number };
  running: boolean;
  onJump: (stage: RunStage) => void;
}) {
  return (
    <nav aria-label="Stages" className="rounded-xl border border-border bg-surface px-3 pt-3 shadow-card">
      {stages.length === 0 ? (
        <p className="pb-3 text-[13px] text-ink-4">Not started yet.</p>
      ) : (
        <ol className="flex flex-col">
          {stages.map((stage, index) => {
            const last = index === stages.length - 1;
            const live = last && running && stage.endedAt === null;
            const waiting =
              stage.kind === 'review'
                ? 'waiting for a review'
                : stage.waitingSeconds > 0
                  ? `${durationText(stage.waitingSeconds)} waiting for an answer`
                  : null;
            return (
              <li key={stage.key} className="relative">
                {!last && <span aria-hidden className="absolute top-4 bottom-0 left-[6px] w-0.5 bg-border" />}
                <button
                  type="button"
                  onClick={() => onJump(stage)}
                  className="grid w-full grid-cols-[14px_minmax(0,1fr)] gap-2.5 pb-3 text-left"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'z-[1] mt-[3px] size-3.5 rounded-full',
                      stage.kind === 'review' ? 'bg-blue' : 'bg-brand',
                      live && 'ring-4 ring-brand-wash',
                    )}
                  />
                  <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2">
                    <span className="text-[13px] font-semibold text-ink-1">{stage.name}</span>
                    <span className="text-[12px] tabular-nums text-ink-3">{clockTime(stage.startedAt)}</span>
                    <span className="col-span-2 text-[12px] tabular-nums text-ink-3">
                      {live ? `${durationText(stage.durationSeconds)} so far` : durationText(stage.durationSeconds)}
                      {waiting ? ` · ${waiting}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex justify-between gap-2 border-t border-border-soft px-0.5 pt-2 pb-2.5 text-[12px] tabular-nums text-ink-3">
        <span className="font-semibold text-ink-2">Total</span>
        <span>
          {clockTime(span.startedAt)} – {span.endedAt ? clockTime(span.endedAt) : 'now'} ·{' '}
          {durationText(span.durationSeconds)}
        </span>
      </div>
    </nav>
  );
}

const ICON_TONES = {
  pr: 'bg-brand-wash text-brand-text',
  jira: 'bg-blue-wash text-blue',
  spec: 'bg-violet-wash text-violet-text',
  intent: 'bg-warn-wash text-warn-text',
  plain: 'bg-surface-2 text-ink-2',
} as const;

const CARD =
  'grid w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5 text-left shadow-card transition-colors hover:border-ink-4';

function CardInner({
  icon: Icon,
  tone,
  label,
  name,
  sub,
  external,
}: {
  icon: typeof FileTextIcon;
  tone: keyof typeof ICON_TONES;
  label: string;
  name: string;
  sub: string | null;
  external: boolean;
}) {
  return (
    <>
      <span className={cn('grid size-8 place-items-center rounded-lg', ICON_TONES[tone])}>
        <Icon className="size-[17px]" />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">{label}</span>
        <span className="block truncate text-[13.5px] font-semibold text-ink-1">{name}</span>
        {sub && <span className="block truncate text-[12px] text-ink-3">{sub}</span>}
      </span>
      {external ? (
        <ArrowUpRightIcon aria-hidden className="size-3.5 text-ink-4" />
      ) : (
        <ChevronRightIcon aria-hidden className="size-3.5 text-ink-4" />
      )}
    </>
  );
}

function specSub(latest: AgentRunSpec, versions: readonly AgentRunSpec[]): string | null {
  const previous = versions.filter((spec) => spec.version < latest.version).sort((a, b) => b.version - a.version)[0];
  return previous ? `v${previous.version} ${SPEC_STATUS_LABELS[previous.status].toLowerCase()}` : latest.title;
}

export function ArtifactCards({
  run,
  specs,
  activity,
  onOpen,
}: {
  run: AgentRunDetail;
  specs: readonly AgentRunSpec[];
  activity: AgentRunActivity | undefined;
  onOpen: (drawer: ActivityDrawer) => void;
}) {
  const pulls = run.pullRequests ?? [];
  const jira = jiraOutcomeLines(run.jiraOutcome).find((line) => line.text.startsWith('Jira'))?.text ?? null;
  const turns = activity?.turns ?? [];
  const calls = turns.reduce((sum, turn) => sum + turn.toolCalls, 0);
  const intent = activity?.intent ?? { read: [], proposed: [] };
  const drawers = [
    run.latestSpec && {
      key: 'spec',
      icon: FileTextIcon,
      tone: 'spec' as const,
      label: 'Spec',
      name: `v${run.latestSpec.version} · ${SPEC_STATUS_LABELS[run.latestSpec.status]}`,
      sub: specSub(run.latestSpec, specs),
      drawer: { kind: 'spec' } as const,
    },
    turns.length > 0 && {
      key: 'intent',
      icon: LightbulbIcon,
      tone: 'intent' as const,
      label: 'Product intent',
      name: `${plural(intent.read.length, 'item', 'items')} read`,
      sub: `${plural(intent.proposed.length, 'candidate', 'candidates')} proposed`,
      drawer: { kind: 'intent' } as const,
    },
    turns.length > 0 && {
      key: 'skills',
      icon: WrenchIcon,
      tone: 'plain' as const,
      label: 'Skills and tools',
      name: `${plural(activity?.skills.length ?? 0, 'skill', 'skills')} · ${plural(activity?.tools.length ?? 0, 'tool', 'tools')}`,
      sub: plural(calls, 'call', 'calls'),
      drawer: { kind: 'skills' } as const,
    },
    turns.length > 0 && {
      key: 'trace',
      icon: AlignLeftIcon,
      tone: 'plain' as const,
      label: 'Trace',
      name: plural(turns.length, 'turn', 'turns'),
      sub: 'with the session transcripts',
      drawer: { kind: 'trace' } as const,
    },
  ].filter((card) => Boolean(card)) as Array<{
    key: string;
    icon: typeof FileTextIcon;
    tone: keyof typeof ICON_TONES;
    label: string;
    name: string;
    sub: string | null;
    drawer: ActivityDrawer;
  }>;

  return (
    <div className="flex flex-col gap-2">
      {pulls.map((pull) => (
        <a
          key={pull.repository}
          href={pull.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Pull request #${pull.number} in ${pull.repository}`}
          className={CARD}
        >
          <CardInner
            icon={GitPullRequestIcon}
            tone="pr"
            label="Pull request"
            name={`#${pull.number} · ${pull.state === 'open' && pull.draft ? 'Draft' : pull.state[0]!.toUpperCase() + pull.state.slice(1)}`}
            sub={pull.repository}
            external
          />
        </a>
      ))}
      {run.issueUrl ? (
        <a
          href={run.issueUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${run.issueKey} in Jira`}
          className={CARD}
        >
          <CardInner icon={TicketIcon} tone="jira" label="Jira" name={run.issueKey} sub={jira} external />
        </a>
      ) : null}
      {drawers.length > 0 && <div aria-hidden className="mx-0.5 my-1 h-px bg-border" />}
      {drawers.map(({ key, drawer, ...card }) => (
        <button
          key={key}
          type="button"
          aria-label={`${card.label}: ${card.name}`}
          onClick={() => onOpen(drawer)}
          className={CARD}
        >
          <CardInner {...card} external={false} />
        </button>
      ))}
    </div>
  );
}
