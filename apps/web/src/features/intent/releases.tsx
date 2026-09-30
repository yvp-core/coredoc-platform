import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { httpUrl } from './source-label.js';
import {
  effectivityLabels,
  IntentReleaseTrigger,
  releaseTriggerExplain,
  releaseTriggerLabels,
} from './release-types.js';
import { ChevronRight } from 'lucide-react';
import { IntentDetails } from './intent-details.js';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { newIntentIdempotencyKey } from '@/api/queries/intent';
import {
  intentReleaseHistoryOptions,
  intentReleasePreviewOptions,
  intentReleaseTriggerOptions,
  readIntentReleasePreviews,
  readIntentReleases,
  writeIntentRelease,
} from '@/api/queries/intent-release';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { hasAdminAccess } from '@/lib/roles';
import { effectivityVariant, authorityLabel, authorityVariant, formatIntentTimestamp } from './intent-presentation.js';
import type {
  IntentReleaseAction,
  IntentReleaseEntry,
  IntentReleasePreview,
  IntentReleaseWrite,
} from './release-types.js';

const labels: Record<IntentReleaseAction, string> = {
  release: 'Confirm delivery',
  baseline: 'Already in production',
  rollback: 'Record rollback',
  plan: 'Plan change',
  withdraw: 'Withdraw plan',
  reinstate: 'Reinstate plan',
};
const deliveryLabel = (reference: string) =>
  reference.startsWith('initial-state-') ? 'Initial production state' : reference;
const explain: Record<string, string> = {
  effective: 'Effective according to recorded delivery evidence.',
  planned: 'Planned for a future delivery. Applies only to tasks that explicitly include this change.',
  withdrawn: 'This plan was withdrawn. Do not implement it.',
  not_effective: 'This rule is excluded from the recorded production state. It may have been replaced before delivery.',
  unknown: 'No recorded evidence establishes delivery or an active plan.',
};
interface Prepared {
  action: IntentReleaseAction;
  headSeq: number;
  previews: IntentReleasePreview[];
  retired: { id: string; title: string }[];
  releaseSeq?: number;
  deliveredRef?: string;
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/**
 * A typed reason is required only where it carries information nothing else
 * does: a manual plan (roadmap intent with no PR yet) and a rollback (amendment
 * §3.2). Everywhere else the server stores its own default.
 */
const reasonRequired = (action: IntentReleaseAction) => action === 'plan' || action === 'rollback';
/** What the server records for a human write that omits the reason (`defaultReleaseReason`). */
const DEFAULT_REASON = 'manual';

export interface ReleaseSelectionItem {
  id: string;
  title: string;
  removed?: boolean;
}
export interface IntentReleasesProps {
  workspaceId: string;
  role: string;
  view: 'history' | 'item' | 'selection';
  itemId?: string;
  selection?: ReleaseSelectionItem[];
  onSelectionChange?: (items: ReleaseSelectionItem[]) => void;
  onOpenItem?: (id: string) => void;
}
export function IntentReleases({
  workspaceId,
  role,
  view,
  itemId,
  selection = [],
  onSelectionChange,
  onOpenItem,
}: IntentReleasesProps) {
  const client = useQueryClient();
  const formId = useId();
  const canEdit = hasAdminAccess(role);
  const history = useInfiniteQuery({ ...intentReleaseHistoryOptions(workspaceId), enabled: view === 'history' });
  const selectedId = itemId ?? null;
  const preview = useQuery(intentReleasePreviewOptions(workspaceId, selectedId));
  const triggerQuery = useQuery(intentReleaseTriggerOptions(workspaceId));
  // Three states, not two: a value, an absent field (old server) reading as
  // manual, and a failed read — which must not be dressed up as `Manual`.
  const triggerUnavailable = triggerQuery.isError;
  const trigger = triggerQuery.data ?? IntentReleaseTrigger.Manual;
  const automatic = trigger !== IntentReleaseTrigger.Manual;
  const included =
    view === 'item' ? (itemId ? [itemId] : []) : selection.filter((item) => !item.removed).map((item) => item.id);
  const retired = selection.filter((item) => item.removed).map((item) => item.id);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [reason, setReason] = useState('');
  const [deliveredRef, setDeliveredRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latch = useRef(false);
  // Preserve the exact request across uncertain transport failures. A changed
  // form is a new attempt; a background refetch never advances its head.
  const attempt = useRef<{ signature: string; body: IntentReleaseWrite } | null>(null);
  const head = history.data?.pages[0];
  const events = history.data?.pages.flatMap((p) => p.entries) ?? [];

  async function prepare(action: IntentReleaseAction) {
    if (latch.current) return;
    latch.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const ids =
        action === 'release' || action === 'baseline'
          ? included
          : action === 'rollback'
            ? []
            : selectedId
              ? [selectedId]
              : [];
      if (ids.length + retired.length > 200) throw new Error('Select at most 200 items per delivery.');
      const state = await readIntentReleases(workspaceId);
      const previews = ids.length ? await readIntentReleasePreviews(workspaceId, ids) : [];
      if (previews.some((p) => p.headSeq !== state.headSeq))
        throw new Error('Release evidence changed while preparing. Refresh and review again.');
      if (action === 'release' || action === 'baseline') {
        for (const p of previews) {
          if (!p.deliveryImpact)
            throw new Error('Update the server to preview delivery consequences before confirming.');
          if (p.deliveryImpact.ancestors.some((id) => ids.includes(id)))
            throw new Error(
              'The selection contains multiple revisions of one rule. Keep only the revision actually delivered.',
            );
          const blockers = p.deliveryImpact.blockingSuccessors.filter((item) => !retired.includes(item.itemId));
          if (blockers.length)
            throw new Error(
              `“${p.content.title}” has a newer rule in production: ${blockers.map((item) => item.title).join(', ')}. Review the current delivery before restoring an older rule.`,
            );
        }
      }
      if (action === 'rollback' && state.currentReleaseSeq === null)
        throw new Error('No current delivery to roll back.');
      setPrepared({
        action,
        headSeq: state.headSeq,
        previews,
        retired:
          action === 'release' ? selection.filter((item) => item.removed).map(({ id, title }) => ({ id, title })) : [],
        ...(action === 'rollback' && state.currentRelease
          ? { releaseSeq: state.currentRelease.seq, deliveredRef: state.currentRelease.deliveredRef }
          : {}),
      });
      setReason(action === 'baseline' ? 'Already running in production' : '');
      setDeliveredRef(action === 'baseline' ? `initial-state-${newIntentIdempotencyKey()}` : '');
      attempt.current = null;
    } catch (e) {
      setError(errorText(e));
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }

  async function submit() {
    if (!prepared || latch.current || (reasonRequired(prepared.action) && !reason.trim())) return;
    const { action, previews } = prepared;
    const input: Omit<IntentReleaseWrite, 'idempotencyKey'> = {
      expectedHeadSeq: prepared.headSeq,
      // Omitted rather than blank: an absent reason is what tells the server to
      // store its own default, and a blank string is not a reason.
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    if (action === 'release' || action === 'baseline') {
      Object.assign(input, {
        kind: action,
        deliveredRef: deliveredRef.trim(),
        included: previews.map((p) => ({ itemId: p.itemId, contentHash: p.contentHash })),
        retired: prepared.retired.map((item) => item.id),
      });
    } else if (action === 'rollback') input.releaseSeq = prepared.releaseSeq;
    else {
      input.itemId = previews[0]?.itemId;
      if (action === 'plan') input.expectedVersion = previews[0]?.version;
    }
    const signature = JSON.stringify({ action, input });
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, body: { ...input, idempotencyKey: newIntentIdempotencyKey() } };
    latch.current = true;
    setBusy(true);
    setError(null);
    try {
      await writeIntentRelease(workspaceId, action, attempt.current.body);
      setPrepared(null);
      if (view === 'selection') onSelectionChange?.([]);
      attempt.current = null;
      setNotice(`${labels[action]} saved. Evidence has been updated.`);
      await client.invalidateQueries({ queryKey: ['intent'] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {view === 'selection' && selection.length > 0 && (
        <Card className="space-y-3 border-brand-text bg-surface p-4 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-medium text-ink-1">
                {selection.length} {selection.length === 1 ? 'rule' : 'rules'} selected
              </h3>
              <p className="text-xs text-ink-3">
                Selection stays with you when you search or switch domains. Maximum 200 per confirmation.
              </p>
            </div>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onSelectionChange?.([])}>
              Clear selection
            </Button>
          </div>
          <details className="group/disclosure">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded focus-visible:outline focus-visible:outline-2 [&::-webkit-details-marker]:hidden text-sm text-ink-2">
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 transition-transform group-open/disclosure:rotate-90"
              />
              Review or edit selected rules ({selection.length})
            </summary>
            <ul className="mt-2 max-h-48 space-y-2 overflow-auto">
              {selection.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2 border-b border-border-soft pb-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left text-sm text-ink-1"
                    onClick={() => onOpenItem?.(item.id)}
                  >
                    {item.title}
                  </button>
                  <Select
                    disabled={busy}
                    value={item.removed ? 'removed' : 'delivered'}
                    onValueChange={(value) =>
                      onSelectionChange?.(
                        selection.map((row) => (row.id === item.id ? { ...row, removed: value === 'removed' } : row)),
                      )
                    }
                  >
                    <SelectTrigger aria-label={`Delivery outcome for ${item.title}`} className="w-[210px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="delivered">Now available</SelectItem>
                      <SelectItem value="removed">Removed from production</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove ${item.title} from selection`}
                    onClick={() => onSelectionChange?.(selection.filter((row) => row.id !== item.id))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </details>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || selection.length > 200} onClick={() => void prepare('release')}>
                Confirm delivery
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || selection.length > 200 || retired.length > 0}
                onClick={() => void prepare('baseline')}
              >
                Already in production
              </Button>
            </div>
          )}
        </Card>
      )}
      {view === 'item' && (
        <section className="space-y-2 border-b border-border-soft p-4" aria-label="Production state">
          <h4 className="text-xs font-medium uppercase tracking-wide text-ink-3">Production state</h4>
          {preview.isLoading && <p className="text-sm text-ink-3">Checking recorded state…</p>}
          {preview.error && (
            <div role="alert">
              <p>{errorText(preview.error)}</p>
              <Button variant="outline" size="sm" onClick={() => void preview.refetch()}>
                Retry status
              </Button>
            </div>
          )}
          {preview.data && (
            <>
              <Badge variant={effectivityVariant(preview.data.effectivity)}>
                {effectivityLabels[preview.data.effectivity]}
              </Badge>
              <p className="text-xs text-ink-3">{explain[preview.data.effectivity]}</p>
              {preview.data.currentRelease && (
                <p className="text-xs text-ink-3">
                  Latest workspace delivery evidence: {deliveryLabel(preview.data.currentRelease.deliveredRef)} ·{' '}
                  {formatIntentTimestamp(preview.data.currentRelease.recordedAt)}
                </p>
              )}
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  {preview.data.planState === 'active' && preview.data.effectivity !== 'effective' && (
                    <Button size="sm" disabled={busy} onClick={() => void prepare('release')}>
                      Confirm delivery
                    </Button>
                  )}
                  {preview.data.planState === 'active' && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void prepare('withdraw')}>
                      Withdraw plan
                    </Button>
                  )}
                  {preview.data.authority === 'accepted' && preview.data.planState === 'withdrawn' && (
                    <Button size="sm" disabled={busy} onClick={() => void prepare('reinstate')}>
                      Reinstate plan
                    </Button>
                  )}
                  {(preview.data.authority === 'accepted' || preview.data.authority === 'superseded') &&
                    preview.data.effectivity !== 'effective' && (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void prepare('baseline')}>
                        Already in production
                      </Button>
                    )}
                  {/* Planning is no longer the first affordance (amendment §5): recording what
                      already shipped is the common act, planning the exception. */}
                  {preview.data.authority === 'accepted' &&
                    preview.data.planState === 'none' &&
                    preview.data.effectivity !== 'effective' && (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void prepare('plan')}>
                        Plan change
                      </Button>
                    )}
                </div>
              )}
            </>
          )}
        </section>
      )}
      {view === 'history' && (
        <>
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
                      Release trigger: <strong>{releaseTriggerLabels[trigger]}</strong> —{' '}
                      {releaseTriggerExplain[trigger]}
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
              <p role="alert">{errorText(history.error)}</p>
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
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void prepare('rollback')}>
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
        </>
      )}
      {notice && <output className="block text-sm text-brand-text">{notice}</output>}
      {error && !prepared && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
      <Dialog
        open={prepared !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPrepared(null);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{prepared ? labels[prepared.action] : 'Record evidence'}</DialogTitle>
            <DialogDescription>
              {prepared?.action === 'rollback'
                ? `Record that delivery #${prepared.releaseSeq} (${prepared.deliveredRef}) was rolled back. This does not deploy code.`
                : prepared?.action === 'baseline'
                  ? 'Confirm that these rules already describe your live product. No historical deployment reference is needed. Unselected rules are unchanged.'
                  : prepared?.action === 'release'
                    ? 'Review which rules became available or were removed. This records evidence; it does not deploy code.'
                    : 'Record a planning decision. Production effectivity and approval remain separate.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="max-h-[65vh] space-y-3 overflow-auto">
            {prepared && prepared.previews.length + prepared.retired.length > 0 && (
              <p className="text-sm text-ink-2">
                {prepared.previews.length + prepared.retired.length} selected{' '}
                {prepared.previews.length + prepared.retired.length === 1 ? 'rule' : 'rules'}.
                {prepared.previews.length > 0 && ' Expand a rule to inspect its exact content.'}
              </p>
            )}
            {prepared && (prepared.action === 'release' || prepared.action === 'baseline') && (
              <div className="space-y-3 rounded-lg border border-border-soft p-3 text-sm">
                <h4 className="font-medium text-ink-1">What this confirmation records</h4>
                <p className="text-xs text-ink-3">Based on evidence #{prepared.headSeq}. Other rules stay unchanged.</p>
                {(
                  [
                    [
                      'Will be in production',
                      prepared.previews
                        .filter((p) => p.effectivity !== 'effective')
                        .map((p) => ({ itemId: p.itemId, title: p.content.title })),
                    ],
                    [
                      'Already in production',
                      prepared.previews
                        .filter((p) => p.effectivity === 'effective')
                        .map((p) => ({ itemId: p.itemId, title: p.content.title })),
                    ],
                    [
                      'Will be replaced',
                      [
                        ...new Map(
                          prepared.previews
                            .flatMap((p) => p.deliveryImpact.replaces)
                            .map((item) => [item.itemId, item]),
                        ).values(),
                      ],
                    ],
                  ] as const
                ).map(
                  ([label, items]) =>
                    items.length > 0 && (
                      <div key={label}>
                        <p className="text-xs font-medium text-ink-3">
                          {label} · {items.length}
                        </p>
                        <ul className="max-h-32 list-disc overflow-y-auto pl-4 text-ink-1">
                          {items.map((item) => (
                            <li key={item.itemId} className="break-words">
                              {item.title}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ),
                )}
              </div>
            )}
            {prepared?.previews.map((p) => (
              <details
                key={p.itemId}
                open={prepared.previews.length === 1}
                className="group/rule space-y-2 border-b border-border-soft pb-3 text-sm"
              >
                <summary className="flex cursor-pointer list-none items-start gap-2 rounded py-1 font-medium focus-visible:outline focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 transition-transform group-open/rule:rotate-90"
                  />
                  <span className="min-w-0">
                    <span className="block break-words">{p.content.title}</span>
                    <span className="mt-1 flex flex-wrap gap-1.5 text-xs font-normal text-ink-3">
                      <span>v{p.version}</span>
                      <Badge variant={authorityVariant(p.authority)}>{authorityLabel(p.authority)}</Badge>
                      <Badge variant={effectivityVariant(p.effectivity)}>{effectivityLabels[p.effectivity]}</Badge>
                    </span>
                  </span>
                </summary>
                <p>{p.content.statement}</p>
                {p.content.rationale && <p className="text-ink-3">{p.content.rationale}</p>}
                <div className="space-y-2 pt-2">
                  <h4 className="text-xs uppercase tracking-wide text-ink-4">Details</h4>
                  <IntentDetails payload={p.content.payload} />
                </div>
              </details>
            ))}
            {prepared?.retired.length ? (
              <section className="space-y-2 text-sm">
                <h4 className="font-medium">Will be removed from production · {prepared.retired.length}</h4>
                <ul className="space-y-1">
                  {prepared.retired.map((item) => (
                    <li key={item.id} className="break-words">
                      {item.title}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {prepared?.action === 'release' && automatic && (
              <p className="text-xs text-ink-3">
                Deliveries in this workspace are recorded by the{' '}
                {trigger === IntentReleaseTrigger.Deploy ? 'CI step after a deploy' : 'GitHub connector on merge'}. Use
                this form for exceptions it did not record.
              </p>
            )}
            {prepared?.action === 'release' && (
              <label htmlFor={`${formId}-delivery`} className="block space-y-1 text-sm">
                Delivery reference
                <Input
                  id={`${formId}-delivery`}
                  value={deliveredRef}
                  maxLength={256}
                  disabled={busy}
                  onChange={(e) => setDeliveredRef(e.target.value)}
                  placeholder="Deployment ID, release tag or evidence reference"
                />
              </label>
            )}
            <label htmlFor={`${formId}-reason`} className="block space-y-1 text-sm">
              {prepared?.action === 'baseline' ? 'Confirmation' : 'Reason'}
              <Input
                id={`${formId}-reason`}
                value={reason}
                maxLength={2000}
                disabled={busy}
                placeholder={prepared && !reasonRequired(prepared.action) ? DEFAULT_REASON : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {error && (
              <div role="alert" className="space-y-1 text-sm text-danger-text">
                <p>{error}</p>
                <p>
                  For a version or release conflict, cancel and reopen to review current evidence. For a network
                  failure, retry unchanged.
                </p>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setPrepared(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                (prepared !== null && reasonRequired(prepared.action) && !reason.trim()) ||
                ((prepared?.action === 'release' || prepared?.action === 'baseline') && !deliveredRef.trim())
              }
              onClick={() => void submit()}
            >
              {busy ? 'Saving…' : 'Confirm record'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
