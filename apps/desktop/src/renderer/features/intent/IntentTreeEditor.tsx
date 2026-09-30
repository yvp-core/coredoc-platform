/**
 * Tree editing: create/rename/archive a domain or a feature, and add or
 * remove a feature's seeds.
 *
 * Refusals are shown VERBATIM: the code, the bounded message and the exact
 * failing field paths the server sent (spec §12). Seed writes in particular
 * answer with named lists — an unregistered repo key comes back with every
 * registered identity, and an unsupported node type with the covered types — and
 * paraphrasing those would throw away the only actionable part.
 */

import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { IntentErrorEnvelope, IntentFeatureSeed, IntentTreeDomain } from '../../../shared/intent-types.js';
import { formatIntentTimestamp } from './intent-presentation';

export interface IntentTreeEditorProps {
  /** Every tree page the browser has loaded, already flattened. */
  domains: IntentTreeDomain[] | null;
  selectedDomainId: string | null;
  selectedFeatureId: string | null;
  seeds: IntentFeatureSeed[] | null;
  /** The seed walk hit its page ceiling — this list is not every seed. */
  seedsTruncated?: boolean;
  /** True while ANY tree write is in flight; every control is disabled then. */
  busy: boolean;
  /** The last refusal, forwarded from the server without summarization. */
  error: IntentErrorEnvelope | null;
  errorMessage?: string;
  onCreateDomain: (input: { id: string; title: string; statement: string }) => void;
  onCreateFeature: (input: { id: string; domainId: string; title: string; statement: string }) => void;
  onRenameDomain: (input: { id: string; title: string }) => void;
  onRenameFeature: (input: { id: string; title: string }) => void;
  onArchiveDomain: (input: { id: string; archived: boolean }) => void;
  onArchiveFeature: (input: { id: string; archived: boolean }) => void;
  onAddSeed: (input: { featureId: string; repoKey: string; nodeId: string; note: string }) => void;
  onRemoveSeed: (input: { featureId: string; repoKey: string; nodeId: string }) => void;
  onClose: () => void;
}

export function IntentTreeEditor(props: IntentTreeEditorProps) {
  const {
    domains: domainPages,
    selectedDomainId,
    selectedFeatureId,
    seeds,
    seedsTruncated = false,
    busy,
    error,
    errorMessage,
    onCreateDomain,
    onCreateFeature,
    onRenameDomain,
    onRenameFeature,
    onArchiveDomain,
    onArchiveFeature,
    onAddSeed,
    onRemoveSeed,
    onClose,
  } = props;

  const [domainDraft, setDomainDraft] = useState({ id: '', title: '', statement: '' });
  const [featureDraft, setFeatureDraft] = useState({ id: '', title: '', statement: '' });
  const [renameDraft, setRenameDraft] = useState('');
  const [seedDraft, setSeedDraft] = useState({ repoKey: '', nodeId: '', note: '' });

  const domains = domainPages ?? [];
  const selectedDomain = domains.find((domain) => domain.id === selectedDomainId) ?? null;
  const selectedFeature = selectedDomain?.features.find((feature) => feature.id === selectedFeatureId) ?? null;

  return (
    <section className="surface-b flex w-80 shrink-0 flex-col gap-4 overflow-y-auto rounded-xl border border-border-secondary p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-content-primary">Edit tree</h3>
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          Close
        </Button>
      </div>

      {(error || errorMessage) && (
        <div className="flex flex-col gap-1 rounded-lg border border-border-input bg-bg-tag-warning p-2">
          {error ? (
            <>
              <span className="font-mono text-[11px] text-content-primary">{error.code}</span>
              <span className="text-[11px] leading-4 text-content-primary">{error.message}</span>
              {error.path.length > 0 && (
                <span className="font-mono text-[11px] text-content-secondary">at {error.path.join('.')}</span>
              )}
              {(error.details ?? []).map((detail) => (
                <span
                  key={`${detail.code}\n${detail.path.join('.')}\n${detail.message}`}
                  className="text-[11px] leading-4 text-content-secondary"
                >
                  {detail.code}: {detail.message}
                  {detail.path.length > 0 ? ` (${detail.path.join('.')})` : ''}
                </span>
              ))}
            </>
          ) : (
            <span className="text-[11px] leading-4 text-content-primary">{errorMessage}</span>
          )}
        </div>
      )}

      <Fieldset legend="New domain">
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
        <Button type="button" size="xs" variant="brand" disabled={busy} onClick={() => onCreateDomain(domainDraft)}>
          Create domain
        </Button>
      </Fieldset>

      <Fieldset legend={selectedDomainId ? `New feature in ${selectedDomainId}` : 'New feature'}>
        {selectedDomainId === null ? (
          <p className="text-[11px] leading-4 text-content-tertiary">Select a domain to add a feature to it.</p>
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
              type="button"
              size="xs"
              variant="brand"
              disabled={busy}
              onClick={() => onCreateFeature({ ...featureDraft, domainId: selectedDomainId })}
            >
              Create feature
            </Button>
          </>
        )}
      </Fieldset>

      <Fieldset legend="Selected node">
        {selectedFeature === null && selectedDomain === null ? (
          <p className="text-[11px] leading-4 text-content-tertiary">Select a domain or feature to rename it.</p>
        ) : (
          <>
            <p className="font-mono text-[11px] text-content-quaternary">
              {selectedFeature ? selectedFeature.id : selectedDomain?.id}
            </p>
            <Field label="Title" htmlFor="intent-rename-title">
              <Input
                id="intent-rename-title"
                value={renameDraft}
                placeholder={selectedFeature ? selectedFeature.title : selectedDomain?.title}
                onChange={(event) => setRenameDraft(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-1">
              <Button
                type="button"
                size="xs"
                disabled={busy}
                onClick={() =>
                  selectedFeature
                    ? onRenameFeature({ id: selectedFeature.id, title: renameDraft })
                    : selectedDomain && onRenameDomain({ id: selectedDomain.id, title: renameDraft })
                }
              >
                Rename
              </Button>
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  selectedFeature
                    ? onArchiveFeature({ id: selectedFeature.id, archived: !selectedFeature.archived })
                    : selectedDomain && onArchiveDomain({ id: selectedDomain.id, archived: !selectedDomain.archived })
                }
              >
                {(selectedFeature ?? selectedDomain)?.archived ? 'Unarchive' : 'Archive'}
              </Button>
            </div>
          </>
        )}
      </Fieldset>

      <Fieldset legend="Seeds">
        {selectedFeatureId === null ? (
          <p className="text-[11px] leading-4 text-content-tertiary">
            Seeds declare a feature's code area. Select a feature to manage them.
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {(seeds ?? []).map((seed) => (
                <li
                  key={`${seed.repoKey}\n${seed.nodeId}`}
                  className="flex items-start justify-between gap-2 rounded-md border border-border-input p-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[11px] text-content-secondary" title={seed.nodeId}>
                      {seed.repoKey} · {seed.nodeId}
                    </span>
                    <span className="block text-[11px] leading-4 text-content-quaternary">
                      added {formatIntentTimestamp(seed.createdAt)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      onRemoveSeed({ featureId: selectedFeatureId, repoKey: seed.repoKey, nodeId: seed.nodeId })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
              {(seeds?.length ?? 0) === 0 && (
                <li className="text-[11px] leading-4 text-content-quaternary">No seeds on this feature.</li>
              )}
              {seedsTruncated && (
                <li className="text-[11px] leading-4 text-content-warning">
                  This feature has more seeds than one exhaustive read returns; the rest are not listed here.
                </li>
              )}
            </ul>
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
              type="button"
              size="xs"
              variant="brand"
              disabled={busy}
              onClick={() => onAddSeed({ ...seedDraft, featureId: selectedFeatureId })}
            >
              Add seed
            </Button>
          </>
        )}
      </Fieldset>
    </section>
  );
}

function Fieldset({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-border-input p-3">
      <legend className="px-1 text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * A labelled field. The control's id is passed in and repeated on the label's
 * `htmlFor` rather than nesting the input: `Input` is a component, so a nested
 * control is invisible to static analysis and to some assistive technology.
 */
function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-[11px] text-content-secondary">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
