/**
 * The delivery selection above the catalogue list: the selected rules, each
 * one's outcome (now available, or removed from production), and the two
 * confirmations. The selection lives with the panel, so it survives search and
 * scope changes.
 */

import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { hasIntentAccess } from '@/lib/roles';
import { ReleaseRecordOutcome, useReleaseRecorder } from './release-record.js';
import type { IntentReleaseAction, ReleaseSelectionItem } from './release-types.js';

interface DeliverySelectionBarProps {
  workspaceId: string;
  role: string;
  selection: ReleaseSelectionItem[];
  onSelectionChange: (items: ReleaseSelectionItem[]) => void;
  onOpenItem?: (id: string) => void;
}

export function DeliverySelectionBar({
  workspaceId,
  role,
  selection,
  onSelectionChange,
  onOpenItem,
}: DeliverySelectionBarProps) {
  const canEdit = hasIntentAccess(role);
  const recorder = useReleaseRecorder(workspaceId, () => onSelectionChange([]));
  const { busy } = recorder;
  const retired = selection.filter((item) => item.removed);
  const prepare = (action: IntentReleaseAction) =>
    void recorder.prepare(action, {
      included: selection.filter((item) => !item.removed).map((item) => item.id),
      retired: retired.map(({ id, title }) => ({ id, title })),
    });

  return (
    <div className="space-y-3">
      {selection.length > 0 && (
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
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onSelectionChange([])}>
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
                      onSelectionChange(
                        selection.map((row) => (row.id === item.id ? { ...row, removed: value === 'removed' } : row)),
                      )
                    }
                    aria-label={`Delivery outcome for ${item.title}`}
                    className="w-[210px]"
                  >
                    <option value="delivered">Now available</option>
                    <option value="removed">Removed from production</option>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove ${item.title} from selection`}
                    onClick={() => onSelectionChange(selection.filter((row) => row.id !== item.id))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </details>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || selection.length > 200} onClick={() => prepare('release')}>
                Confirm delivery
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || selection.length > 200 || retired.length > 0}
                onClick={() => prepare('baseline')}
              >
                Already in production
              </Button>
            </div>
          )}
        </Card>
      )}
      <ReleaseRecordOutcome workspaceId={workspaceId} recorder={recorder} />
    </div>
  );
}
