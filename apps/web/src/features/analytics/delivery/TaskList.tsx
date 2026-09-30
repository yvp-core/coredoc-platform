/**
 * Cursor-paged task list for the Delivery view. The server applies the same
 * `(window, lifecycle, member scope)` predicate as the summary, so this list and the KPIs
 * describe one population; the text field filters only what is already loaded
 * and says so through the empty state.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { CANONICAL_PAGE_SIZE, canonicalTaskSummariesQueryOptions } from '@/api/queries/analytics';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { AnalyticsWindow, CanonicalTaskSummary, DeliveryLifecycleFilter } from '../types.js';
import { Chip, lifecycleTone } from './Chip.js';
import {
  filterCanonicalTasks,
  formatDurationShort,
  leadTimeOf,
  lifecycleLabel,
  partialShipLabel,
  windowLabel,
} from './delivery-presentation.js';

function authorityChip(task: CanonicalTaskSummary): string | null {
  if (task.authority.kind !== 'external_ref') return null;
  return task.authority.externalKey ?? task.authority.externalId ?? null;
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: CanonicalTaskSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const lead = leadTimeOf(task);
  const authority = authorityChip(task);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col items-start gap-1 px-3.5 py-2.5 text-left transition-colors',
        selected ? 'bg-brand-wash shadow-[inset_2px_0_0_var(--color-brand)]' : 'hover:bg-surface-2',
      )}
    >
      <span className="text-[12.5px] font-normal leading-[1.35] text-ink-1">{task.title ?? task.id}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone={lifecycleTone(task.lifecycle)}>{task.lifecycle}</Chip>
        {authority === null ? null : (
          <Chip mono title={authority}>
            {authority}
          </Chip>
        )}
        {task.shipState === 'partial' ? <Chip tone="partial">{partialShipLabel(task)}</Chip> : null}
        {task.counts.reworkSignals > 0 ? <Chip tone="rework">{`${task.counts.reworkSignals} rework`}</Chip> : null}
      </span>
      <span className="num flex gap-2.5 text-[11px] text-ink-4">
        <span
          title={
            lead !== null && lead < 0
              ? 'Ship evidence predates the task; lead time unmeasurable'
              : 'Lead time: issue created (or task created) → last ship evidence'
          }
        >
          {lead === null ? (
            'not shipped'
          ) : (
            <>
              {'lead '}
              <strong className="font-normal text-ink-2">{formatDurationShort(lead)}</strong>
            </>
          )}
        </span>
        <span>
          {'runs '}
          <strong className="font-normal text-ink-2">{task.counts.workflowRuns}</strong>
        </span>
      </span>
    </button>
  );
}

export function TaskList({
  workspaceId,
  analyticsWindow,
  lifecycle,
  mine,
  userId,
  scope,
  query,
  onQueryChange,
  selectedTaskId,
  onSelect,
  onSelectionDropped,
}: {
  workspaceId: string;
  analyticsWindow: AnalyticsWindow;
  lifecycle: DeliveryLifecycleFilter;
  mine: boolean;
  userId: string | null;
  /** The member scope in prose ("your tasks", "tasks of Ada"); null = the whole workspace. */
  scope: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
  onSelectionDropped: () => void;
}) {
  const tasksQuery = useInfiniteQuery(
    canonicalTaskSummariesQueryOptions(workspaceId, analyticsWindow, lifecycle, mine, userId),
  );
  const loaded = tasksQuery.data?.pages.flatMap((page) => page.tasks) ?? [];
  const visible = filterCanonicalTasks(loaded, query);

  // The selection is made from this list, so it can only fall out of it when the
  // filter (and therefore the population) changed underneath it.
  const stillLoaded = selectedTaskId === null || loaded.some((task) => task.id === selectedTaskId);
  useEffect(() => {
    if (!stillLoaded && !tasksQuery.isFetching) onSelectionDropped();
  }, [stillLoaded, tasksQuery.isFetching, onSelectionDropped]);

  return (
    <Card>
      <CardHead title="Tasks" sub={`${loaded.length} loaded · cursor-paged, ${CANONICAL_PAGE_SIZE} per page`} />

      <div className="border-b border-border-soft px-3.5 py-2.5">
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Filter loaded tasks by title, key…"
          aria-label="Filter loaded tasks"
          className="h-7 py-0 text-[12px]"
        />
      </div>

      {tasksQuery.isPending ? (
        <div className="flex items-center justify-center py-6">
          <Spinner className="text-ink-4" />
        </div>
      ) : tasksQuery.isError ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-[12px] text-ink-2">Couldn't load the task list.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void tasksQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-ink-4">
          {loaded.length === 0
            ? `Nothing matched "${lifecycleLabel(lifecycle)}" ${windowLabel(analyticsWindow)}${scope === null ? '' : ` in ${scope}`}.`
            : `No loaded task matches "${query}" under "${lifecycleLabel(lifecycle)}".`}
        </div>
      ) : (
        <div className="flex max-h-[900px] flex-col overflow-y-auto">
          {visible.map((task) => (
            <div key={task.id} className="border-b border-border-soft last:border-b-0">
              <TaskRow task={task} selected={task.id === selectedTaskId} onSelect={() => onSelect(task.id)} />
            </div>
          ))}
        </div>
      )}

      {tasksQuery.hasNextPage ? (
        <div className="border-t border-border-soft px-3.5 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={tasksQuery.isFetchingNextPage}
            onClick={() => void tasksQuery.fetchNextPage()}
          >
            {tasksQuery.isFetchingNextPage ? 'Loading…' : 'Load more tasks'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
