/**
 * One rule's production state in the item detail pane: the recorded
 * effectivity, the latest delivery evidence, and the record actions that fit it.
 */

import { useQuery } from '@tanstack/react-query';
import { intentReleasePreviewOptions } from '@/api/queries/intent-release';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { hasIntentAccess } from '@/lib/roles';
import { effectivityVariant, formatIntentTimestamp, messageOf } from './intent-presentation.js';
import { deliveryLabel, ReleaseRecordOutcome, useReleaseRecorder } from './release-record.js';
import { effectivityLabels, type IntentReleaseAction } from './release-types.js';

const explain: Record<string, string> = {
  effective: 'Effective according to recorded delivery evidence.',
  planned: 'Planned for a future delivery. Applies only to tasks that explicitly include this change.',
  withdrawn: 'This plan was withdrawn. Do not implement it.',
  not_effective: 'This rule is excluded from the recorded production state. It may have been replaced before delivery.',
  unknown: 'No recorded evidence establishes delivery or an active plan.',
};

interface ItemProductionStateProps {
  workspaceId: string;
  role: string;
  itemId: string;
}

export function ItemProductionState({ workspaceId, role, itemId }: ItemProductionStateProps) {
  const canEdit = hasIntentAccess(role);
  const preview = useQuery(intentReleasePreviewOptions(workspaceId, itemId));
  const recorder = useReleaseRecorder(workspaceId);
  const { busy } = recorder;
  const prepare = (action: IntentReleaseAction) => void recorder.prepare(action, { included: [itemId], retired: [] });

  return (
    <div className="space-y-3">
      <section className="space-y-2 border-b border-border-soft p-4" aria-label="Production state">
        <h4 className="text-xs font-medium uppercase tracking-wide text-ink-3">Production state</h4>
        {preview.isLoading && <p className="text-sm text-ink-3">Checking recorded state…</p>}
        {preview.error && (
          <div role="alert">
            <p>{messageOf(preview.error)}</p>
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
                  <Button size="sm" disabled={busy} onClick={() => prepare('release')}>
                    Confirm delivery
                  </Button>
                )}
                {preview.data.planState === 'active' && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => prepare('withdraw')}>
                    Withdraw plan
                  </Button>
                )}
                {preview.data.authority === 'accepted' && preview.data.planState === 'withdrawn' && (
                  <Button size="sm" disabled={busy} onClick={() => prepare('reinstate')}>
                    Reinstate plan
                  </Button>
                )}
                {(preview.data.authority === 'accepted' || preview.data.authority === 'superseded') &&
                  preview.data.effectivity !== 'effective' && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => prepare('baseline')}>
                      Already in production
                    </Button>
                  )}
                {/* Planning is no longer the first affordance (amendment §5): recording what
                    already shipped is the common act, planning the exception. */}
                {preview.data.authority === 'accepted' &&
                  preview.data.planState === 'none' &&
                  preview.data.effectivity !== 'effective' && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => prepare('plan')}>
                      Plan change
                    </Button>
                  )}
              </div>
            )}
          </>
        )}
      </section>
      <ReleaseRecordOutcome workspaceId={workspaceId} recorder={recorder} />
    </div>
  );
}
