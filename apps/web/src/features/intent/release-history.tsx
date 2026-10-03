/**
 * The workspace's delivery history: the release trigger, the latest recorded
 * delivery, a rollback correction, and every ledger event, newest first.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { intentReleaseHistoryOptions, intentReleaseTriggerOptions } from '@/api/queries/intent-release';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { hasIntentAccess } from '@/lib/roles';
import { formatIntentTimestamp, messageOf } from './intent-presentation.js';
import { deliveryLabel, ReleaseRecordOutcome, useReleaseRecorder } from './release-record.js';
import {
  IntentReleaseTrigger,
  releaseTriggerExplain,
  releaseTriggerLabels,
  type IntentReleaseEntry,
} from './release-types.js';
import { httpUrl } from './source-label.js';

export interface ReleaseHistoryProps {
  workspaceId: string;
  role: string;
  onOpenItem?: (id: string) => void;
}

export function ReleaseHistory({ workspaceId, role, onOpenItem }: ReleaseHistoryProps) {
  const canEdit = hasIntentAccess(role);
  const history = useInfiniteQuery(intentReleaseHistoryOptions(workspaceId));
  const triggerQuery = useQuery(intentReleaseTriggerOptions(workspaceId));
  // A failed read must not be dressed up as `Manual`; only the pending read
  // shows the manual default until the value arrives.
  const triggerUnavailable = triggerQuery.isError;
  const trigger = triggerQuery.data ?? IntentReleaseTrigger.Manual;
  const recorder = useReleaseRecorder(workspaceId);
  const head = history.data?.pages[0];
  const events = history.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-medium text-ink-1">Delivery history</h2>
            <p className="text-sm text-ink-3">
              What became available, what was removed, and who confirmed it. Select rules in Browse to record a
              delivery.
            </p>
            <p className="mt-1 text-xs text-ink-3">
              {triggerUnavailable ? (
                'Release trigger unavailable'
              ) : (
                <>
                  Release trigger: <strong>{releaseTriggerLabels[trigger]}</strong> — {releaseTriggerExplain[trigger]}
                </>
              )}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={history.isFetching} onClick={() => void history.refetch()}>
            Refresh
          </Button>
        </div>
        {history.isLoading ? (
          <p>Loading history…</p>
        ) : history.error ? (
          <p role="alert">{messageOf(history.error)}</p>
        ) : head?.currentRelease ? (
          <p className="text-sm text-ink-2">
            Latest recorded delivery: <strong>{deliveryLabel(head.currentRelease.deliveredRef)}</strong> ·{' '}
            {formatIntentTimestamp(head.currentRelease.recordedAt)}
          </p>
        ) : (
          <p className="text-sm text-ink-3">
            No delivery recorded yet. For an existing product, select its rules in Browse and choose “Already in
            production”.
          </p>
        )}
        {canEdit && head?.currentRelease && (
          <details className="group/disclosure">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded focus-visible:outline focus-visible:outline-2 [&::-webkit-details-marker]:hidden text-xs text-ink-3">
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 transition-transform group-open/disclosure:rotate-90"
              />
              Correct a rolled-back delivery
            </summary>
            <p className="my-2 text-xs text-ink-3">Use this only after the actual deployment was rolled back.</p>
            <Button
              variant="outline"
              size="sm"
              disabled={recorder.busy}
              onClick={() => void recorder.prepare('rollback')}
            >
              Record rollback
            </Button>
          </details>
        )}
      </Card>
      {events.map((event) => (
        <ReleaseHistoryEvent key={event.seq} event={event} onOpenItem={onOpenItem} />
      ))}
      {history.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Load older events
        </Button>
      )}
      <ReleaseRecordOutcome workspaceId={workspaceId} recorder={recorder} />
    </div>
  );
}

function ReleaseHistoryEvent({ event, onOpenItem }: { event: IntentReleaseEntry; onOpenItem?: (id: string) => void }) {
  const prUrl = httpUrl(event.pr?.url);
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(20);
  const changes = [
    ...(event.data.included ?? []).map((id) => ({ id, label: 'Available' })),
    ...(event.data.retired ?? []).map((id) => ({ id, label: 'Removed' })),
    ...(event.data.ancestors ?? []).map((id) => ({ id, label: 'Replaced' })),
    ...(event.data.itemId ? [{ id: event.data.itemId, label: 'Plan' }] : []),
  ];
  const affectedCount = new Set(changes.map((change) => change.id)).size;
  const title =
    event.kind === 'baseline'
      ? 'Initial production state confirmed'
      : event.kind === 'release'
        ? 'Delivery confirmed'
        : event.kind === 'rollback'
          ? 'Delivery rolled back'
          : event.kind === 'withdraw'
            ? 'Plan withdrawn'
            : event.kind === 'reinstate'
              ? 'Plan reinstated'
              : 'Change planned';
  return (
    <Card className="p-4">
      <details className="group/disclosure" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded focus-visible:outline focus-visible:outline-2 [&::-webkit-details-marker]:hidden text-sm text-ink-1">
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-open/disclosure:rotate-90"
          />
          <strong>{title}</strong>
          {event.kind !== 'rollback' && (
            <>
              {' '}
              · {affectedCount} {affectedCount === 1 ? 'rule' : 'rules'}
            </>
          )}{' '}
          {/* Only when the server stamped it: events written before the automatic
              actors carry no actor, and inventing one is a lie. */}
          {event.actorKind && <Badge variant="neutral">{event.actorKind}</Badge>}
          {event.rolledBack && <Badge variant="warn">Rolled back</Badge>}
          <span className="ml-2 text-xs text-ink-3">{formatIntentTimestamp(event.recordedAt)}</span>
        </summary>
        <p className="mt-2 text-sm text-ink-2">{event.reason}</p>
        {(event.pr || event.orderingToken || event.data.deployId) && (
          <p className="mt-1 break-all text-xs text-ink-3">
            {event.pr &&
              (prUrl ? (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-text underline underline-offset-2"
                >
                  {event.pr.repoKey}#{event.pr.number}
                </a>
              ) : (
                <span>
                  {event.pr.repoKey}#{event.pr.number}
                </span>
              ))}
            {event.orderingToken && <span> · ordered at {event.orderingToken}</span>}
            {event.data.deployId && <span> · deploy {event.data.deployId}</span>}
          </p>
        )}
        {open && (
          <div className="mt-3 space-y-2">
            <p className="break-all text-xs text-ink-3">
              Confirmed by {event.recordedBy}
              {event.deliveredRef ? ` · ${event.deliveredRef}` : ''}
            </p>
            {event.data.releaseSeq && (
              <p className="text-xs text-ink-2">Restores the state before delivery #{event.data.releaseSeq}.</p>
            )}
            {changes.slice(0, limit).map((change) => (
              <HistoryRule
                key={`${change.label}:${change.id}`}
                title={event.titles?.[change.id]}
                id={change.id}
                label={change.label}
                onOpenItem={onOpenItem}
              />
            ))}
            {changes.length > limit && (
              <Button variant="outline" size="sm" onClick={() => setLimit(limit + 20)}>
                Show more rules ({changes.length - limit} remaining)
              </Button>
            )}
          </div>
        )}
      </details>
    </Card>
  );
}
function HistoryRule({
  title,
  id,
  label,
  onOpenItem,
}: {
  title?: string;
  id: string;
  label: string;
  onOpenItem?: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-2 rounded border border-border-soft p-2 text-left text-sm hover:bg-surface-2"
      onClick={() => onOpenItem?.(id)}
    >
      <Badge>{label}</Badge>
      <span className="break-all">
        {title ?? id}
        <span className="ml-2 text-xs text-ink-3">Open in Browse →</span>
      </span>
    </button>
  );
}
