/**
 * Recording release-ledger evidence: prepare (read the head and the previews,
 * refuse what cannot be confirmed), review in a dialog, confirm. Shared by the
 * delivery history, an item's production state and the delivery selection bar;
 * each owns one recorder.
 *
 * A confirm goes through an {@link IntentWriter}, so an unchanged retry after a
 * transport failure or a conflict resends the exact request under the same key,
 * and a corrected form is a new attempt with a new key.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { newIntentIdempotencyKey } from '@/api/queries/intent';
import {
  intentReleaseTriggerOptions,
  readIntentReleasePreviews,
  readIntentReleases,
  writeIntentRelease,
} from '@/api/queries/intent-release';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { IntentWriteForm } from './intent-attempt-keys.js';
import { IntentDetails } from './intent-details.js';
import { IntentMarkdown } from './intent-markdown.js';
import { authorityLabel, authorityVariant, effectivityVariant, messageOf } from './intent-presentation.js';
import { useIntentWriter } from './intent-writer.js';
import {
  effectivityLabels,
  IntentReleaseTrigger,
  type IntentReleaseAction,
  type IntentReleasePreview,
  type IntentReleaseWrite,
} from './release-types.js';

export const releaseActionLabels: Record<IntentReleaseAction, string> = {
  release: 'Confirm delivery',
  baseline: 'Already in production',
  rollback: 'Record rollback',
  plan: 'Plan change',
  withdraw: 'Withdraw plan',
  reinstate: 'Reinstate plan',
};

export const deliveryLabel = (reference: string) =>
  reference.startsWith('initial-state-') ? 'Initial production state' : reference;

/**
 * A typed reason is required only where it carries information nothing else
 * does: a manual plan (roadmap intent with no PR yet) and a rollback (amendment
 * §3.2). Everywhere else the server stores its own default.
 */
const reasonRequired = (action: IntentReleaseAction) => action === 'plan' || action === 'rollback';
/** What the server records for a human write that omits the reason (`defaultReleaseReason`). */
const DEFAULT_REASON = 'manual';

interface Prepared {
  action: IntentReleaseAction;
  headSeq: number;
  previews: IntentReleasePreview[];
  retired: { id: string; title: string }[];
  releaseSeq?: number;
  deliveredRef?: string;
}

/** The rules an action is prepared for; a rollback takes none. */
export interface ReleaseTarget {
  included: string[];
  retired: { id: string; title: string }[];
}

const NO_TARGET: ReleaseTarget = { included: [], retired: [] };

export function useReleaseRecorder(workspaceId: string, onRecorded?: () => void) {
  const client = useQueryClient();
  const writer = useIntentWriter();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [reason, setReason] = useState('');
  const [deliveredRef, setDeliveredRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function prepare(action: IntentReleaseAction, target: ReleaseTarget = NO_TARGET) {
    if (writer.busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await writer.exclusive(async () => {
        const ids = action === 'rollback' ? [] : target.included;
        const retired = target.retired.map((item) => item.id);
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
          retired: action === 'release' ? target.retired : [],
          ...(action === 'rollback' && state.currentRelease
            ? { releaseSeq: state.currentRelease.seq, deliveredRef: state.currentRelease.deliveredRef }
            : {}),
        });
        setReason(action === 'baseline' ? 'Already running in production' : '');
        setDeliveredRef(action === 'baseline' ? `initial-state-${newIntentIdempotencyKey()}` : '');
        // A freshly prepared dialog is a new attempt, even with the same input.
        writer.reset(IntentWriteForm.Release);
      });
    } catch (e) {
      setError(messageOf(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!prepared || writer.busy || (reasonRequired(prepared.action) && !reason.trim())) return;
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
    setBusy(true);
    setError(null);
    try {
      await writer.exclusive(async () => {
        // The action is part of the attempt: the same body to another route is another write.
        await writer.send(IntentWriteForm.Release, { action, input }, ({ idempotencyKey }) =>
          writeIntentRelease(workspaceId, action, { ...input, idempotencyKey }),
        );
        setPrepared(null);
        onRecorded?.();
        setNotice(`${releaseActionLabels[action]} saved. Evidence has been updated.`);
        await client.invalidateQueries({ queryKey: ['intent'] });
      });
    } catch (e) {
      setError(messageOf(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setPrepared(null);
    setError(null);
  };

  return { prepared, reason, setReason, deliveredRef, setDeliveredRef, error, notice, busy, prepare, submit, close };
}

export type ReleaseRecorder = ReturnType<typeof useReleaseRecorder>;

/** The recorder's notice, its error outside the dialog, and the confirmation dialog. */
export function ReleaseRecordOutcome({ workspaceId, recorder }: { workspaceId: string; recorder: ReleaseRecorder }) {
  const { prepared, busy, error, notice } = recorder;
  return (
    <>
      {notice && <output className="block text-sm text-brand-text">{notice}</output>}
      {error && !prepared && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
      <Dialog
        open={prepared !== null}
        onOpenChange={(open) => {
          if (!open && !busy) recorder.close();
        }}
      >
        <DialogContent>
          {prepared ? (
            <ReleaseRecordForm workspaceId={workspaceId} recorder={recorder} prepared={prepared} />
          ) : (
            // Only on screen while the dialog animates closed.
            <DialogHeader>
              <DialogTitle>Record evidence</DialogTitle>
            </DialogHeader>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReleaseRecordForm({
  workspaceId,
  recorder,
  prepared,
}: {
  workspaceId: string;
  recorder: ReleaseRecorder;
  prepared: Prepared;
}) {
  const formId = useId();
  const { busy, error, reason, deliveredRef } = recorder;
  // Only a delivery dialog names the trigger, so only it reads it.
  const triggerQuery = useQuery({
    ...intentReleaseTriggerOptions(workspaceId),
    enabled: prepared.action === 'release',
  });
  const trigger = triggerQuery.data ?? IntentReleaseTrigger.Manual;
  const automatic = trigger !== IntentReleaseTrigger.Manual;
  const selected = prepared.previews.length + prepared.retired.length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{releaseActionLabels[prepared.action]}</DialogTitle>
        <DialogDescription>
          {prepared.action === 'rollback'
            ? `Record that delivery #${prepared.releaseSeq} (${prepared.deliveredRef}) was rolled back. This does not deploy code.`
            : prepared.action === 'baseline'
              ? 'Confirm that these rules already describe your live product. No historical deployment reference is needed. Unselected rules are unchanged.'
              : prepared.action === 'release'
                ? 'Review which rules became available or were removed. This records evidence; it does not deploy code.'
                : 'Record a planning decision. Production effectivity and approval remain separate.'}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="max-h-[65vh] space-y-3 overflow-auto">
        {selected > 0 && (
          <p className="text-sm text-ink-2">
            {selected} selected {selected === 1 ? 'rule' : 'rules'}.
            {prepared.previews.length > 0 && ' Expand a rule to inspect its exact content.'}
          </p>
        )}
        {(prepared.action === 'release' || prepared.action === 'baseline') && (
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
                      prepared.previews.flatMap((p) => p.deliveryImpact.replaces).map((item) => [item.itemId, item]),
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
        {prepared.previews.map((p) => (
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
            {p.content.body && p.content.body.length > 0 && (
              <IntentMarkdown text={p.content.body.join('\n')} className="text-ink-2" />
            )}
            {p.content.rationale && <p className="text-ink-3">{p.content.rationale}</p>}
            <div className="space-y-2 pt-2">
              <h4 className="text-xs uppercase tracking-wide text-ink-4">Details</h4>
              <IntentDetails payload={p.content.payload} />
            </div>
          </details>
        ))}
        {prepared.retired.length ? (
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
        {prepared.action === 'release' && automatic && (
          <p className="text-xs text-ink-3">
            Deliveries in this workspace are recorded by the{' '}
            {trigger === IntentReleaseTrigger.Deploy ? 'CI step after a deploy' : 'GitHub connector on merge'}. Use this
            form for exceptions it did not record.
          </p>
        )}
        {prepared.action === 'release' && (
          <label htmlFor={`${formId}-delivery`} className="block space-y-1 text-sm">
            Delivery reference
            <Input
              id={`${formId}-delivery`}
              value={deliveredRef}
              maxLength={256}
              disabled={busy}
              onChange={(e) => recorder.setDeliveredRef(e.target.value)}
              placeholder="Deployment ID, release tag or evidence reference"
            />
          </label>
        )}
        <label htmlFor={`${formId}-reason`} className="block space-y-1 text-sm">
          {prepared.action === 'baseline' ? 'Confirmation' : 'Reason'}
          <Input
            id={`${formId}-reason`}
            value={reason}
            maxLength={2000}
            disabled={busy}
            placeholder={!reasonRequired(prepared.action) ? DEFAULT_REASON : undefined}
            onChange={(e) => recorder.setReason(e.target.value)}
          />
        </label>
        {error && (
          <div role="alert" className="space-y-1 text-sm text-danger-text">
            <p>{error}</p>
            <p>
              For a version or release conflict, cancel and reopen to review current evidence. For a network failure,
              retry unchanged.
            </p>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={recorder.close}>
          Cancel
        </Button>
        <Button
          disabled={
            busy ||
            (reasonRequired(prepared.action) && !reason.trim()) ||
            ((prepared.action === 'release' || prepared.action === 'baseline') && !deliveredRef.trim())
          }
          onClick={() => void recorder.submit()}
        >
          {busy ? 'Saving…' : 'Confirm record'}
        </Button>
      </DialogFooter>
    </>
  );
}
