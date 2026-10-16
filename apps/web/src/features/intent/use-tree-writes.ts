/**
 * The tree editor's writes: create, rename, archive and delete a domain or a
 * feature, and add or remove a seed. Each one goes through the panel's
 * {@link IntentWriter} under its own form, so a double-click or a retry after a
 * transport error replays the same attempt instead of writing twice.
 */

import { useState } from 'react';
import {
  archiveIntentDomain,
  archiveIntentFeature,
  createIntentDomain,
  createIntentFeature,
  deleteIntentDomain,
  deleteIntentFeature,
  deleteIntentSeed,
  putIntentSeed,
  updateIntentDomain,
  updateIntentFeature,
} from '@/api/queries/intent';
import { IntentWriteForm } from '@coredoc/core/browser/intent-attempt-keys';
import { messageOf } from './intent-presentation.js';
import type { IntentWriter } from './intent-writer.js';
import type { IntentTreeEditorProps } from './tree-editor.js';

/** What the editor hands one of its callbacks. */
type Input<K extends keyof IntentTreeEditorProps> = IntentTreeEditorProps[K] extends (input: infer I) => unknown
  ? I
  : never;

interface TreeWritesInput {
  workspaceId: string;
  writer: IntentWriter;
  /** Rows are the truth: after any write, everything intent-scoped is re-read. */
  invalidateIntent: () => Promise<unknown>;
}

export function useTreeWrites({ workspaceId: id, writer, invalidateIntent }: TreeWritesInput) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const runWrite = async <T extends object>(
    form: IntentWriteForm,
    input: T,
    write: (body: T & { idempotencyKey: string }) => Promise<unknown>,
  ): Promise<boolean> => {
    if (writer.busy) return false;
    setBusy(true);
    setError(null);
    try {
      await writer.exclusive(async () => {
        await writer.send(form, input, write);
        await invalidateIntent();
      });
      return true;
    } catch (failure) {
      // The writer keeps the key: pressing again with the same input replays
      // this attempt rather than starting a second one.
      setError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    errorMessage: messageOf(error),
    onCreateDomain: (input: Input<'onCreateDomain'>) =>
      runWrite(IntentWriteForm.CreateDomain, input, (body) => createIntentDomain(id, body)),
    onCreateFeature: (input: Input<'onCreateFeature'>) =>
      runWrite(IntentWriteForm.CreateFeature, input, (body) => createIntentFeature(id, body)),
    onRenameDomain: (input: Input<'onRenameDomain'>) =>
      runWrite(IntentWriteForm.RenameDomain, input, (body) => updateIntentDomain(id, body)),
    onRenameFeature: (input: Input<'onRenameFeature'>) =>
      runWrite(IntentWriteForm.RenameFeature, input, (body) => updateIntentFeature(id, body)),
    onArchiveDomain: (input: Input<'onArchiveDomain'>) =>
      void runWrite(IntentWriteForm.ArchiveDomain, input, (body) => archiveIntentDomain(id, body)),
    onArchiveFeature: (input: Input<'onArchiveFeature'>) =>
      void runWrite(IntentWriteForm.ArchiveFeature, input, (body) => archiveIntentFeature(id, body)),
    onDeleteDomain: (input: Input<'onDeleteDomain'>) =>
      void runWrite(IntentWriteForm.DeleteDomain, input, (body) => deleteIntentDomain(id, body)),
    onDeleteFeature: (input: Input<'onDeleteFeature'>) =>
      void runWrite(IntentWriteForm.DeleteFeature, input, (body) => deleteIntentFeature(id, body)),
    onAddSeed: (input: Input<'onAddSeed'>) =>
      runWrite(IntentWriteForm.AddSeed, input, (body) => putIntentSeed(id, body)),
    onRemoveSeed: (input: Input<'onRemoveSeed'>) =>
      void runWrite(IntentWriteForm.RemoveSeed, input, (body) => deleteIntentSeed(id, body)),
  };
}
