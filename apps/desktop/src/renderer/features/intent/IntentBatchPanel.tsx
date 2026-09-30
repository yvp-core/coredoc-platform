import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
/**
 * The decision batch panel: the ONE authorizing source a review batch is
 * submitted under, what is staged against it, and the submit.
 *
 * It is deliberately dumb — every value is a prop and every edit goes out
 * through a callback — because the two behaviours issue v1.1-01 asked for are
 * decided in pure functions (`manualProvenancePreset`, `sharedProvenanceSource`,
 * `applyProvenanceSource`) that a test pins without a DOM. The panel only shows
 * their result and offers the gesture.
 *
 * The counts arrive already labelled: the queue owns the action vocabulary, so
 * this file carries none and cannot drift from the cards.
 */

import { Danger } from '@solar-icons/react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { IntentSourceKind, type IntentReviewDecisionResult } from '../../../shared/intent-types.js';
import { outcomeLabel } from './intent-presentation';
import {
  INTENT_REVIEW_BATCH_LIMIT,
  type IntentProvenanceField,
  type IntentProvenanceForm,
  type IntentSharedSource,
} from './intent-review-request';

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
  /** What the staged candidates say about their own source (issue v1.1-01). */
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

const OUTCOME_ORDER_KEY = (result: IntentReviewDecisionResult): string => result.outcome;

/** "2 accepted · 1 refused" — what the last submitted batch actually did. */
function resultSummary(results: readonly IntentReviewDecisionResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = OUTCOME_ORDER_KEY(result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
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
    <aside className="surface-a flex w-full shrink-0 flex-col gap-3 rounded-xl border border-border-tertiary p-4 min-[1100px]:sticky min-[1100px]:top-4 min-[1100px]:w-80">
      <h3 className="text-xs/relaxed font-semibold text-content-primary">Decision batch</h3>

      {stagedCounts.length === 0 ? (
        <p className="text-[11px] leading-4 text-content-quaternary">Nothing staged yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {stagedCounts.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-2 text-[11px] leading-4">
              <span className="text-content-secondary">{row.label}</span>
              <span className="tabular-nums text-content-primary">{row.count}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 border-t border-border-tertiary pt-3">
        <div className="flex items-center justify-between gap-2">
          {/* One line: the "one per batch" rule is stated in the note under
              Submit, and carrying it here wrapped the label into the button. */}
          <span className="whitespace-nowrap text-[11px] font-medium uppercase leading-4 tracking-[0.02em] text-content-tertiary">
            Authorizing source
          </span>
          {/* `outline` — the shipped white/tertiary recipe (border + white fill).
              As a `ghost` this preset painted nothing but text beside a label that
              is also text, so the one gesture on the row read as part of the
              caption. It stays `shrink-0` and the base variant is already
              `whitespace-nowrap`, so it cannot wrap at the 320px panel width. */}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            disabled={submitting}
            onClick={onManualPreset}
          >
            Manual decision
          </Button>
        </div>

        {sharedSource.state === 'mixed' && (
          <div className="flex flex-col items-start gap-1 rounded-lg bg-bg-tag-warning px-2 py-1.5">
            <span className="text-[11px] leading-4 text-content-secondary">
              Staged candidates cite different sources
            </span>
            <Button type="button" variant="ghost" size="xs" disabled={submitting} onClick={onUseSharedSource}>
              Use {sharedSource.first.ref}#{sharedSource.first.localId}
            </Button>
          </div>
        )}

        <Field label="Kind" htmlFor="intent-provenance-kind">
          <Select
            value={provenance.kind}
            disabled={submitting}
            onValueChange={(value) => onProvenanceChange({ kind: value as IntentSourceKind }, 'kind')}
          >
            <SelectTrigger id="intent-provenance-kind" className="w-full">
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

        <Field label="Reference (required)" htmlFor="intent-provenance-ref">
          <Input
            id="intent-provenance-ref"
            value={provenance.ref}
            placeholder="e.g. spec/my-feature or PROJ-123"
            disabled={submitting}
            onChange={(event) => onProvenanceChange({ ref: event.target.value }, 'ref')}
          />
        </Field>

        <Field label="Section / anchor (required)" htmlFor="intent-provenance-local-id">
          <Input
            id="intent-provenance-local-id"
            value={provenance.localId}
            placeholder="e.g. §5 or acceptance-criteria"
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
            placeholder="e.g. jira"
            disabled={submitting}
            onChange={(event) => onProvenanceChange({ workItemProvider: event.target.value })}
          />
        </Field>

        <Field label="Work item id (optional)" htmlFor="intent-provenance-work-id">
          <Input
            id="intent-provenance-work-id"
            value={provenance.workItemId}
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
          className="border-border-input bg-bg-input"
          onChange={(event) => onBatchReasonChange(event.target.value)}
        />
      </Field>

      {issues.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-border-input bg-bg-input p-2">
          {issues.map((issue) => (
            <li key={issue} className="text-[11px] leading-4 text-content-warning">
              {issue}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 border-t border-border-tertiary pt-3">
        <Button type="button" variant="brand" size="sm" disabled={submitting || stagedTotal === 0} onClick={onSubmit}>
          {submitting
            ? 'Submitting…'
            : stagedTotal === 0
              ? 'Submit decisions'
              : `Submit ${stagedTotal} decision${stagedTotal === 1 ? '' : 's'}`}
        </Button>

        {submitErrorMessage && (
          // Beside the submit, never instead of the queue: the drafts below are
          // the reviewer's typed work and a failed submit must not discard them.
          <p className="flex items-start gap-2 rounded-lg border border-border-input bg-bg-tag-warning px-2 py-1.5 text-[11px] leading-4 text-content-primary">
            <Danger className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The batch was not submitted: {submitErrorMessage} Your decisions are kept — fix the cause and submit
              again.
            </span>
          </p>
        )}

        {results !== null && results.length > 0 && (
          <p className="text-[11px] leading-4 text-content-secondary tabular-nums">
            Last batch: {resultSummary(results)}
          </p>
        )}

        <p className="text-[11px] leading-4 text-content-quaternary">
          One authorizing source per batch · versions are checked on every item · at most {INTENT_REVIEW_BATCH_LIMIT}{' '}
          decisions.
        </p>
      </div>
    </aside>
  );
}

/**
 * The control's id is repeated on the label's `htmlFor` rather than nesting it:
 * `Input` is a component, so a nested control is invisible to static analysis
 * and to some assistive technology.
 */
function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-[11px] leading-4 text-content-secondary">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
