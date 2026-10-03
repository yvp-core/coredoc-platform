/**
 * The invitation a workspace with no domains gets (issue v1.1-01, spec §4).
 *
 * NEVER AN ERROR TONE. A knowledge base nobody has started is the normal first
 * state of every workspace, not a failure, so the card explains what the thing
 * is in one sentence and offers the way to start it: create the first domain
 * here (the tree editor's create form).
 *
 * A WORKSPACE WHOSE DOMAINS ARE ALL ARCHIVED lands here too — the default tree
 * read hides archived nodes, so it returns nothing. That is not an empty
 * knowledge base, and the invitation alone would be a dead end with no way back
 * to the work, so the archived count and the toggle are offered right here.
 */

import { Archive, Notebook } from '@solar-icons/react';
import { Button } from '../../components/ui/button';

export interface IntentEmptyStateProps {
  /**
   * Domains that exist but are archived, so the default read did not show them.
   * Zero — the ordinary first state — offers no toggle.
   */
  archivedDomainCount?: number;
  onShowArchived?: () => void;
  onCreateFirstDomain: () => void;
}

export function IntentEmptyState({
  archivedDomainCount = 0,
  onShowArchived,
  onCreateFirstDomain,
}: IntentEmptyStateProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="surface-b flex max-w-lg flex-col items-center gap-3 rounded-xl border border-border-secondary px-6 py-7 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-bg-tertiary text-content-brand">
          <Notebook weight="Bold" className="size-5" />
        </div>
        <h3 className="text-sm font-semibold text-content-primary">Start the product knowledge base</h3>
        <p className="text-xs leading-5 text-content-secondary">
          Product intent is what this product promises — its capabilities, use cases, flows, rules, limitations and
          decisions — kept as reviewed statements that agents read before they change the code.
        </p>
        <Button type="button" variant="brand" size="sm" onClick={onCreateFirstDomain}>
          Create the first domain
        </Button>

        {archivedDomainCount > 0 && onShowArchived && (
          <div className="flex flex-col items-center gap-1 border-t border-border-input pt-3">
            <p className="text-[11px] leading-4 text-content-secondary tabular-nums">
              {archivedDomainCount} archived {archivedDomainCount === 1 ? 'domain is' : 'domains are'} hidden.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onShowArchived}>
              <Archive className="size-3.5" />
              Show archived
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
