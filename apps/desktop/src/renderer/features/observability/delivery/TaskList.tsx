/**
 * Cursor-paged task list for the Delivery view (UC-3, BR-14). The server applies
 * the same `(window, lifecycle, member scope)` predicate as the summary, so this list and the
 * KPIs describe one population; the text field filters only what is already
 * loaded and says so through the empty state.
 */

import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  type AnalyticsWindow,
  type CanonicalTaskSummary,
  type DeliveryLifecycleFilter,
} from '../../../../shared/ipc-types.js';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Spinner } from '../../../components/ui/spinner';
import { cn } from '../../../lib/utils';
import { CANONICAL_PAGE_SIZE, canonicalTaskSummariesQueryOptions } from '../observability-api';
import { Chip, lifecycleTone } from './Chip';
import { DeliveryCardHead } from './DeliveryCard';
import {
  filterCanonicalTasks,
  formatDurationShort,
  leadTimeOf,
  lifecycleLabel,
  partialShipChipText,
  windowLabel,
} from './delivery-presentation';

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
  const partialShip = partialShipChipText(task);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col items-start gap-1 px-3.5 py-2.5 text-left transition-colors',
        selected ? 'bg-bg-tag-success shadow-[inset_2px_0_0_var(--color-content-brand)]' : 'hover:bg-bg-primary-hover',
      )}
    >
      <span className="text-[12.5px] font-medium leading-[1.35] text-content-primary">{task.title ?? task.id}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone={lifecycleTone(task.lifecycle)}>{task.lifecycle}</Chip>
        {authority === null ? null : (
          <Chip mono title={authority}>
            {authority}
          </Chip>
        )}
        {partialShip === null ? null : <Chip tone="partial">{partialShip}</Chip>}
        {task.counts.reworkSignals > 0 ? <Chip tone="rework">{`${task.counts.reworkSignals} rework`}</Chip> : null}
      </span>
      <span className="flex gap-2.5 text-[11px] tabular-nums text-content-quaternary">
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
              <strong className="font-semibold text-content-secondary">{formatDurationShort(lead)}</strong>
            </>
          )}
        </span>
        <span>
          {'runs '}
          <strong className="font-semibold text-content-secondary">{task.counts.workflowRuns}</strong>
        </span>
      </span>
    </button>
  );
}

export function TaskList({
  workspaceId,
  window: analyticsWindow,
  lifecycle,
  mine,
  userId,
  scopeNoun,
  query,
  onQueryChange,
  selectedTaskId,
  onSelect,
  onSelectionDropped,
}: {
  workspaceId: string;
  window: AnalyticsWindow;
  lifecycle: DeliveryLifecycleFilter;
  mine: boolean;
  userId: string | null;
  /** How the empty state names the current member scope ("tasks", "tasks of yours", "tasks of Ada"). */
  scopeNoun: string;
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
    <Card size="sm" className="gap-0 overflow-hidden py-0">
      <DeliveryCardHead>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-content-primary">Tasks</div>
          <div className="mt-px text-[11.5px] text-content-quaternary">
            {`${loaded.length} loaded · cursor-paged, ${CANONICAL_PAGE_SIZE} per page`}
          </div>
        </div>
      </DeliveryCardHead>

      <div className="border-b border-border-input px-3.5 py-2.5">
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Filter loaded tasks by title, key…"
          aria-label="Filter loaded tasks"
          className="h-7 text-xs"
        />
      </div>

      {tasksQuery.isLoading ? (
        <CardContent className="flex items-center justify-center py-6">
          <Spinner className="size-4 text-content-quaternary" />
        </CardContent>
      ) : tasksQuery.isError ? (
        <CardContent className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-xs text-content-secondary">Couldn't load the task list.</p>
          <Button type="button" variant="outline" size="xs" onClick={() => void tasksQuery.refetch()}>
            Retry
          </Button>
        </CardContent>
      ) : visible.length === 0 ? (
        <CardContent className="py-6 text-center text-xs text-content-quaternary">
          {loaded.length === 0
            ? `No ${scopeNoun} matched "${lifecycleLabel(lifecycle)}" ${windowLabel(analyticsWindow)}.`
            : `No loaded task matches "${query}" under "${lifecycleLabel(lifecycle)}".`}
        </CardContent>
      ) : (
        <div className="flex max-h-[900px] flex-col divide-y divide-border-input overflow-y-auto">
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              selected={task.id === selectedTaskId}
              onSelect={() => onSelect(task.id)}
            />
          ))}
        </div>
      )}

      {tasksQuery.hasNextPage ? (
        <div className="border-t border-border-input px-3.5 py-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
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
