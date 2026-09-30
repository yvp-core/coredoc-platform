/**
 * Tree editing for admins and owners, in one dialog: create/rename/archive/
 * delete a domain or a feature, and add or remove a feature's seeds.
 *
 * Rendered only when `canEdit` — a member's knowledge base is read-only (spec
 * §5), and this surface is hidden rather than disabled so nothing implies an
 * affordance the server would refuse anyway.
 *
 * Refusals are shown as the server sent them (its code and message), because a
 * refused seed write in particular answers with the actionable part — the
 * registered repo keys, the covered node types — and paraphrasing throws it away.
 */

import { SLUG_PATTERN } from '@/api/queries/workspaces';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { formatIntentTimestamp } from './intent-presentation.js';
import type { IntentFeatureSeed, IntentTreeDomain } from './types.js';

const EMPTY_NODE_DRAFT = { id: '', title: '', statement: '' };
const EMPTY_SEED_DRAFT = { repoKey: '', nodeId: '', note: '' };

/** The server's optional text fields are optional OR non-empty, so a blank one is omitted, not sent as `''`. */
function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface IntentTreeEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every tree page the browser has loaded, already flattened. */
  domains: IntentTreeDomain[] | null;
  selectedDomainId: string | null;
  selectedFeatureId: string | null;
  seeds: IntentFeatureSeed[] | null;
  /** The seed walk hit its page ceiling — this list is not every seed. */
  seedsTruncated?: boolean;
  /** True while ANY tree write is in flight; every control is disabled then. */
  busy: boolean;
  errorMessage?: string;
  /** Every write answers whether it landed, so a form clears its draft only on success. */
  onCreateDomain: (input: { id: string; title: string; statement?: string }) => Promise<boolean>;
  onCreateFeature: (input: { id: string; domainId: string; title: string; statement?: string }) => Promise<boolean>;
  onRenameDomain: (input: { id: string; title: string }) => Promise<boolean>;
  onRenameFeature: (input: { id: string; title: string }) => Promise<boolean>;
  onArchiveDomain: (input: { id: string; archived: boolean }) => void;
  onArchiveFeature: (input: { id: string; archived: boolean }) => void;
  onDeleteDomain: (input: { id: string }) => void;
  onDeleteFeature: (input: { id: string }) => void;
  onAddSeed: (input: { featureId: string; repoKey: string; nodeId: string; note?: string }) => Promise<boolean>;
  onRemoveSeed: (input: { featureId: string; repoKey: string; nodeId: string }) => void;
}

export function IntentTreeEditor({
  open,
  onOpenChange,
  domains: domainPages,
  selectedDomainId,
  selectedFeatureId,
  seeds,
  seedsTruncated = false,
  busy,
  errorMessage,
  onCreateDomain,
  onCreateFeature,
  onRenameDomain,
  onRenameFeature,
  onArchiveDomain,
  onArchiveFeature,
  onDeleteDomain,
  onDeleteFeature,
  onAddSeed,
  onRemoveSeed,
}: IntentTreeEditorProps) {
  const [domainDraft, setDomainDraft] = useState(EMPTY_NODE_DRAFT);
  const [featureDraft, setFeatureDraft] = useState(EMPTY_NODE_DRAFT);
  const [renameDraft, setRenameDraft] = useState('');
  const [seedDraft, setSeedDraft] = useState(EMPTY_SEED_DRAFT);
  /** Deleting a node is not reversible, so it takes a second press. */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const domains = domainPages ?? [];
  const selectedDomain = domains.find((domain) => domain.id === selectedDomainId) ?? null;
  const selectedFeature = selectedDomain?.features.find((feature) => feature.id === selectedFeatureId) ?? null;
  const selectedNode = selectedFeature ?? selectedDomain;

  // Selecting another node abandons the rename and the pending delete confirmation.
  const [editedNodeId, setEditedNodeId] = useState(selectedNode?.id ?? null);
  if (editedNodeId !== (selectedNode?.id ?? null)) {
    setEditedNodeId(selectedNode?.id ?? null);
    setRenameDraft('');
    setConfirmDelete(false);
  }

  const domainId = domainDraft.id.trim();
  const domainTitle = domainDraft.title.trim();
  const featureId = featureDraft.id.trim();
  const featureTitle = featureDraft.title.trim();
  const renameTitle = renameDraft.trim();
  const seedRepoKey = seedDraft.repoKey.trim();
  const seedNodeId = seedDraft.nodeId.trim();

  const submitCreateDomain = async () => {
    const created = await onCreateDomain({
      id: domainId,
      title: domainTitle,
      statement: optionalText(domainDraft.statement),
    });
    if (created) setDomainDraft(EMPTY_NODE_DRAFT);
  };

  const submitCreateFeature = async () => {
    if (selectedDomainId === null) return;
    const created = await onCreateFeature({
      id: featureId,
      domainId: selectedDomainId,
      title: featureTitle,
      statement: optionalText(featureDraft.statement),
    });
    if (created) setFeatureDraft(EMPTY_NODE_DRAFT);
  };

  const submitRename = async () => {
    const renamed = selectedFeature
      ? await onRenameFeature({ id: selectedFeature.id, title: renameTitle })
      : selectedDomain !== null && (await onRenameDomain({ id: selectedDomain.id, title: renameTitle }));
    if (renamed) setRenameDraft('');
  };

  const submitAddSeed = async () => {
    if (selectedFeatureId === null) return;
    const added = await onAddSeed({
      featureId: selectedFeatureId,
      repoKey: seedRepoKey,
      nodeId: seedNodeId,
      note: optionalText(seedDraft.note),
    });
    if (added) setSeedDraft(EMPTY_SEED_DRAFT);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage structure</DialogTitle>
          <DialogDescription>
            Domains and features are the tree items hang from. Archiving keeps a node readable; deleting does not.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {errorMessage && (
            <p className="rounded-lg bg-danger-wash px-2.5 py-2 text-[11.5px] text-danger-text">{errorMessage}</p>
          )}

          <Group legend="New domain">
            <Field label="Id (slug)" htmlFor="intent-domain-id">
              <Input
                id="intent-domain-id"
                value={domainDraft.id}
                placeholder="payments"
                onChange={(event) => setDomainDraft({ ...domainDraft, id: event.target.value })}
              />
            </Field>
            <Field label="Title" htmlFor="intent-domain-title">
              <Input
                id="intent-domain-title"
                value={domainDraft.title}
                onChange={(event) => setDomainDraft({ ...domainDraft, title: event.target.value })}
              />
            </Field>
            <Field label="Statement" htmlFor="intent-domain-statement">
              <Input
                id="intent-domain-statement"
                value={domainDraft.statement}
                onChange={(event) => setDomainDraft({ ...domainDraft, statement: event.target.value })}
              />
            </Field>
            <Button
              size="sm"
              className="self-start"
              disabled={busy || !SLUG_PATTERN.test(domainId) || domainTitle === ''}
              onClick={() => void submitCreateDomain()}
            >
              Create domain
            </Button>
          </Group>

          <Group legend={selectedDomainId ? `New feature in ${selectedDomainId}` : 'New feature'}>
            {selectedDomainId === null ? (
              <p className="text-[11px] text-ink-4">Select a domain in the tree to add a feature to it.</p>
            ) : (
              <>
                <Field label="Id (slug)" htmlFor="intent-feature-id">
                  <Input
                    id="intent-feature-id"
                    value={featureDraft.id}
                    placeholder="refunds"
                    onChange={(event) => setFeatureDraft({ ...featureDraft, id: event.target.value })}
                  />
                </Field>
                <Field label="Title" htmlFor="intent-feature-title">
                  <Input
                    id="intent-feature-title"
                    value={featureDraft.title}
                    onChange={(event) => setFeatureDraft({ ...featureDraft, title: event.target.value })}
                  />
                </Field>
                <Field label="Statement" htmlFor="intent-feature-statement">
                  <Input
                    id="intent-feature-statement"
                    value={featureDraft.statement}
                    onChange={(event) => setFeatureDraft({ ...featureDraft, statement: event.target.value })}
                  />
                </Field>
                <Button
                  size="sm"
                  className="self-start"
                  disabled={busy || !SLUG_PATTERN.test(featureId) || featureTitle === ''}
                  onClick={() => void submitCreateFeature()}
                >
                  Create feature
                </Button>
              </>
            )}
          </Group>

          <Group legend="Selected node">
            {selectedNode === null ? (
              <p className="text-[11px] text-ink-4">Select a domain or feature in the tree to rename it.</p>
            ) : (
              <>
                <p className="font-mono text-[11px] text-ink-4">{selectedNode.id}</p>
                <Field label="Title" htmlFor="intent-rename-title">
                  <Input
                    id="intent-rename-title"
                    value={renameDraft}
                    placeholder={selectedNode.title}
                    onChange={(event) => setRenameDraft(event.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" disabled={busy || renameTitle === ''} onClick={() => void submitRename()}>
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      selectedFeature
                        ? onArchiveFeature({ id: selectedFeature.id, archived: !selectedFeature.archived })
                        : selectedDomain &&
                          onArchiveDomain({ id: selectedDomain.id, archived: !selectedDomain.archived })
                    }
                  >
                    {selectedNode.archived ? 'Unarchive' : 'Archive'}
                  </Button>
                  <Button
                    size="sm"
                    variant={confirmDelete ? 'destructive' : 'ghost'}
                    disabled={busy}
                    onClick={() => {
                      if (!confirmDelete) {
                        setConfirmDelete(true);
                        return;
                      }
                      setConfirmDelete(false);
                      if (selectedFeature) onDeleteFeature({ id: selectedFeature.id });
                      else if (selectedDomain) onDeleteDomain({ id: selectedDomain.id });
                    }}
                  >
                    {confirmDelete ? 'Delete — press again' : 'Delete'}
                  </Button>
                </div>
              </>
            )}
          </Group>

          <Group legend="Seeds">
            {selectedFeatureId === null ? (
              <p className="text-[11px] text-ink-4">
                Seeds declare a feature's code area. Select a feature in the tree to manage them.
              </p>
            ) : (
              <>
                {(seeds ?? []).map((seed) => (
                  <div
                    key={`${seed.repoKey}\n${seed.nodeId}`}
                    className="flex items-start justify-between gap-2 rounded-lg border border-border-soft p-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] text-ink-2" title={seed.nodeId}>
                        {seed.repoKey} · {seed.nodeId}
                      </span>
                      <span className="block text-[10.5px] text-ink-4">
                        added {formatIntentTimestamp(seed.createdAt)}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        onRemoveSeed({ featureId: selectedFeatureId, repoKey: seed.repoKey, nodeId: seed.nodeId })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                {(seeds?.length ?? 0) === 0 && <p className="text-[11px] text-ink-4">No seeds on this feature.</p>}
                {seedsTruncated && (
                  <p className="text-[11px] text-warn-text">
                    This feature has more seeds than one exhaustive read returns; the rest are not listed here.
                  </p>
                )}
                <Field label="Repo key" htmlFor="intent-seed-repo-key">
                  <Input
                    id="intent-seed-repo-key"
                    value={seedDraft.repoKey}
                    onChange={(event) => setSeedDraft({ ...seedDraft, repoKey: event.target.value })}
                  />
                </Field>
                <Field label="Node id" htmlFor="intent-seed-node-id">
                  <Input
                    id="intent-seed-node-id"
                    value={seedDraft.nodeId}
                    onChange={(event) => setSeedDraft({ ...seedDraft, nodeId: event.target.value })}
                  />
                </Field>
                <Field label="Note (optional)" htmlFor="intent-seed-note">
                  <Input
                    id="intent-seed-note"
                    value={seedDraft.note}
                    onChange={(event) => setSeedDraft({ ...seedDraft, note: event.target.value })}
                  />
                </Field>
                <Button
                  size="sm"
                  className="self-start"
                  disabled={busy || seedRepoKey === '' || seedNodeId === ''}
                  onClick={() => void submitAddSeed()}
                >
                  Add seed
                </Button>
              </>
            )}
          </Group>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-border-soft p-3">
      <legend className="px-1 text-[10.5px] uppercase tracking-[0.04em] text-ink-4">{legend}</legend>
      {children}
    </fieldset>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={htmlFor} className="text-[10.5px] text-ink-4">
        {label}
      </label>
      {children}
    </div>
  );
}
