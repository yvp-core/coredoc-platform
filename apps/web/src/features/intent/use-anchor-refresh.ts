/**
 * Re-capturing one anchor's baseline from the item detail pane: which confirm
 * is open, which write is in flight, what each landed refresh moved, and the one
 * refusal on screen. Returns the detail pane's `anchorRefresh` prop whole.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { refreshIntentAnchor } from '@/api/queries/intent';
import type { IntentAnchorRefreshOutcome } from './anchor-row.js';
import { IntentWriteForm } from '@coredoc/core/browser/intent-attempt-keys';
import { intentAnchorKey } from './intent-panel-state.js';
import { messageOf } from './intent-presentation.js';
import type { IntentWriter } from './intent-writer.js';
import type { IntentItemAnchor } from './types.js';

interface AnchorRefreshInput {
  workspaceId: string;
  selectedItemId: string | null;
  canRefresh: boolean;
  writer: IntentWriter;
}

export function useAnchorRefresh({ workspaceId: id, selectedItemId, canRefresh, writer }: AnchorRefreshInput) {
  const queryClient = useQueryClient();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, IntentAnchorRefreshOutcome>>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  /**
   * Two clicks — the button opens the confirm, the confirm writes — because a
   * refresh asserts that the code moved and the intent still holds, which only a
   * human can say.
   */
  const onConfirmRefresh = async (anchor: IntentItemAnchor) => {
    if (writer.busy || selectedItemId === null) return;
    const key = intentAnchorKey(anchor);
    const itemId = selectedItemId;
    setRefreshingKey(key);
    setErrorKey(null);
    setError(null);
    try {
      await writer.exclusive(async () => {
        const response = await writer.send(
          IntentWriteForm.RefreshAnchor,
          { itemId, repoKey: anchor.repoKey, nodeId: anchor.nodeId },
          (body) => refreshIntentAnchor(id, body),
        );
        setOutcomes((current) => ({
          ...current,
          [key]: {
            previousCapturedVersionedId: response.previousCapturedVersionedId,
            capturedVersionedId: response.anchor.capturedVersionedId,
            changed: response.changed,
          },
        }));
        setConfirmingKey(null);
        // The new status comes from the server, not from an optimistic guess: the
        // mark is a read-time verdict against the snapshot (§6.4).
        await queryClient.invalidateQueries({ queryKey: ['intent', 'item-context', id, itemId] });
      });
    } catch (failure) {
      // Rendered BESIDE the anchor row; the pane and its other anchors survive.
      setErrorKey(key);
      setError(failure);
    } finally {
      setRefreshingKey(null);
    }
  };

  return {
    canRefresh,
    confirmingKey,
    refreshingKey,
    outcomes,
    errorKey,
    errorMessage: messageOf(error),
    onRequestRefresh: (anchor: IntentItemAnchor) => setConfirmingKey(intentAnchorKey(anchor)),
    onCancelRefresh: () => setConfirmingKey(null),
    onConfirmRefresh: (anchor: IntentItemAnchor) => void onConfirmRefresh(anchor),
  };
}
