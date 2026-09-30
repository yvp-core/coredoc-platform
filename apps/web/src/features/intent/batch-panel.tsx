/**
 * The decision batch panel: the ONE authorizing source a review batch is
 * submitted under, what is staged against it, and the submit.
 *
 * Deliberately dumb — every value is a prop and every edit goes out through a
 * callback — because the two behaviours it offers (the manual preset and the
 * shared-source prefill) are decided in pure functions
 * (`intent-review-request.ts`) that a reader can follow without a DOM.
 *
 * The counts arrive already labelled: the queue owns the action vocabulary, so
 * this file carries none and cannot drift from the cards.
 */

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ReactNode } from 'react';
import { outcomeLabel } from './intent-presentation.js';
import {
  INTENT_REVIEW_BATCH_LIMIT,
  type IntentProvenanceField,
  type IntentProvenanceForm,
  type IntentSharedSource,
} from './intent-review-request.js';
import { IntentSourceKind, type IntentReviewDecisionResult } from './types.js';

/** One staged action, already named by the queue. */
export interface IntentStagedCount {
  label: string;
  count: number;
}

export interface IntentBatchPanelProps {
  /** Staged actions in card order, zero counts already dropped. */
  stagedCounts: readonly IntentStagedCount[];
  stagedTotal: number;
  /** The EFFECTIVE form — prefill applied, reviewer edits winning. */
  provenance: IntentProvenanceForm;
  /** What the staged candidates say about their own source. */
  sharedSource: IntentSharedSource;
  batchReason: string;
  /** Local shape refusals from `buildReviewRequest`, before anything is sent. */
  issues: readonly string[];
  submitting: boolean;
  submitErrorMessage?: string;
  results: IntentReviewDecisionResult[] | null;
  onProvenanceChange: (patch: Partial<IntentProvenanceForm>, field?: IntentProvenanceField) => void;
  onBatchReasonChange: (value: string) => void;
  /** Fill kind/ref/localId for a decision that cites no spec. */
  onManualPreset: () => void;
  /** Take the offered source when the staged candidates disagree. */
  onUseSharedSource: () => void;
  onSubmit: () => void;
}

/** "2 accepted · 1 refused" — what the last submitted batch actually did. */
function resultSummary(results: readonly IntentReviewDecisionResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  return [...counts.entries()]
    .map(
      ([outcome, count]) => `${count} ${outcomeLabel(outcome as IntentReviewDecisionResult['outcome']).toLowerCase()}`,
    )
    .join(' · ');
}

export function IntentBatchPanel({
  stagedCounts,
  stagedTotal,
  provenance,
  sharedSource,
  batchReason,
  issues,
  submitting,
  submitErrorMessage,
  results,
  onProvenanceChange,
  onBatchReasonChange,
  onManualPreset,
  onUseSharedSource,
  onSubmit,
}: IntentBatchPanelProps) {
  return (
    <Card className="sticky top-4">
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        <h3 className="text-[11px] uppercase tracking-[0.04em] text-ink-4">Decision batch</h3>

        {stagedCounts.length === 0 ? (
          <p className="text-[10.5px] text-ink-4">
            Stage decisions on the cards; provenance applies to the whole batch.
          </p>
        ) : (
          <div className="flex flex-col">
            {stagedCounts.map((row) => (
              <div
                key={row.label}
                className="flex items-baseline justify-between gap-2.5 border-b border-border-soft py-[5px] text-[12px] last:border-b-0"
              >
                <span className="text-ink-2">{row.label}</span>
                <span className="num font-medium text-ink-1">{row.count}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] uppercase tracking-[0.04em] text-ink-4">Authorizing source · one per batch</h3>
            <Button variant="outline" size="sm" className="shrink-0" disabled={submitting} onClick={onManualPreset}>
              Manual
            </Button>
          </div>

          {sharedSource.state === 'mixed' && (
            <div className="flex flex-col items-start gap-1 rounded-lg bg-warn-wash px-2 py-1.5">
              <span className="text-[11px] text-warn-text">Staged candidates cite different sources</span>
              <Button variant="ghost" size="sm" className="px-2" disabled={submitting} onClick={onUseSharedSource}>
                Use {sharedSource.first.ref}#{sharedSource.first.localId}
              </Button>
            </div>
          )}

          <Field label="Kind">
            <Select
              value={provenance.kind}
              disabled={submitting}
              onValueChange={(value) => onProvenanceChange({ kind: value as IntentSourceKind }, 'kind')}
            >
              <SelectTrigger aria-label="Authorizing source kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(IntentSourceKind).map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Reference" htmlFor="intent-provenance-ref">
            <Input
              id="intent-provenance-ref"
              value={provenance.ref}
              spellCheck={false}
              placeholder="spec/my-feature or PROJ-123"
              disabled={submitting}
              onChange={(event) => onProvenanceChange({ ref: event.target.value }, 'ref')}
            />
          </Field>

          <Field label="Section / local id" htmlFor="intent-provenance-local-id">
            <Input
              id="intent-provenance-local-id"
              value={provenance.localId}
              spellCheck={false}
              placeholder="§5 or acceptance-criteria"
              disabled={submitting}
              onChange={(event) => onProvenanceChange({ localId: event.target.value }, 'localId')}
            />
          </Field>

          <Field
            label={provenance.kind === IntentSourceKind.Spec ? 'Revision (required)' : 'Revision (optional)'}
            htmlFor="intent-provenance-revision"
          >
            <Input
              id="intent-provenance-revision"
              value={provenance.revision}
              placeholder="Approved commit or content digest"
              disabled={submitting}
              onChange={(event) => onProvenanceChange({ revision: event.target.value }, 'revision')}
            />
          </Field>

          <Field label="Work item provider (optional)" htmlFor="intent-provenance-work-provider">
            <Input
              id="intent-provenance-work-provider"
              value={provenance.workItemProvider}
              placeholder="jira"
              disabled={submitting}
              onChange={(event) => onProvenanceChange({ workItemProvider: event.target.value })}
            />
          </Field>

          <Field label="Work item id (optional)" htmlFor="intent-provenance-work-id">
            <Input
              id="intent-provenance-work-id"
              value={provenance.workItemId}
              placeholder="CORE-841"
              disabled={submitting}
              onChange={(event) => onProvenanceChange({ workItemId: event.target.value })}
            />
          </Field>
        </div>

        <Field label="Batch reason — used for every decision with no reason of its own" htmlFor="intent-batch-reason">
          <Textarea
            id="intent-batch-reason"
            value={batchReason}
            placeholder="Why this review pass"
            disabled={submitting}
            onChange={(event) => onBatchReasonChange(event.target.value)}
          />
        </Field>

        {issues.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-lg border border-border-soft bg-surface-2 p-2">
            {issues.map((issue) => (
              <li key={issue} className="text-[11px] text-warn-text">
                {issue}
              </li>
            ))}
          </ul>
        )}

        <Button disabled={submitting || stagedTotal === 0} onClick={onSubmit}>
          {submitting ? 'Submitting…' : `Submit ${stagedTotal} decision${stagedTotal === 1 ? '' : 's'}`}
        </Button>

        {submitErrorMessage && (
          // Beside the submit, never instead of the queue: the drafts below are
          // the reviewer's typed work and a failed submit must not discard them.
          <p className="rounded-lg bg-danger-wash px-2 py-1.5 text-[11px] text-danger-text">
            The batch was not submitted: {submitErrorMessage} Your decisions are kept — fix the cause and submit again.
          </p>
        )}

        {results !== null && results.length > 0 && (
          <p className="num text-[12px] text-brand-text">Last batch: {resultSummary(results)}</p>
        )}

        <p className="text-[10.5px] text-ink-4">
          One authorizing source per batch · at most {INTENT_REVIEW_BATCH_LIMIT} decisions · versions are checked on
          every item
        </p>
      </div>
    </Card>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      {/* The control's id is repeated on `htmlFor` rather than nesting it: the
          inputs are components, so a nested control is invisible to static
          analysis and to some assistive technology. */}
      <label htmlFor={htmlFor} className="text-[10.5px] text-ink-4">
        {label}
      </label>
      {children}
    </div>
  );
}
