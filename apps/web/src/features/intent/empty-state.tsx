/**
 * The invitation a workspace with no domains gets.
 *
 * NEVER AN ERROR TONE. A knowledge base nobody has started is the normal first
 * state of every workspace, so the card explains what the thing is in one
 * sentence and offers the two ways to start it: create the first domain here
 * (maintainers), or import an existing repo-local overlay with the CLI. A
 * member, whose writes the server would refuse anyway, is told who can do it
 * instead of being handed a button.
 *
 * A WORKSPACE WHOSE DOMAINS ARE ALL ARCHIVED lands here too — the default tree
 * read hides archived nodes, so it returns nothing. That is not an empty
 * knowledge base, so the archived count and the toggle are offered right here.
 */

import { Button } from '@/components/ui/button';

export interface IntentEmptyStateProps {
  /** Admin/owner only; a member sees the explanation without the button (spec §5). */
  canEdit: boolean;
  /** Domains that exist but are archived, so the default read did not show them. */
  archivedDomainCount?: number;
  onShowArchived?: () => void;
  onCreateFirstDomain: () => void;
}

export function IntentEmptyState({
  canEdit,
  archivedDomainCount = 0,
  onShowArchived,
  onCreateFirstDomain,
}: IntentEmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <h3 className="text-[14px] font-medium text-ink-1">Start the product knowledge base</h3>
      <p className="max-w-lg text-[12.5px] leading-relaxed text-ink-2">
        Product intent is what this product promises — its capabilities, use cases, flows, rules, limitations and
        decisions — kept as reviewed statements that agents read before they change the code.
      </p>
      {canEdit ? (
        <Button size="sm" onClick={onCreateFirstDomain}>
          Create the first domain
        </Button>
      ) : (
        <p className="max-w-lg text-[12px] text-ink-3">
          A workspace admin creates the first domain; after that anyone here can browse what is accepted.
        </p>
      )}
      <p className="max-w-lg text-[11px] text-ink-4">
        Already have a repo overlay? <span className="font-mono text-ink-2">coredoc intent import</span> pushes{' '}
        <span className="font-mono text-ink-2">.coredoc/intent.json</span> into this workspace.
      </p>

      {archivedDomainCount > 0 && onShowArchived && (
        <div className="flex flex-col items-center gap-1 border-t border-border-soft pt-3">
          <p className="num text-[11px] text-ink-3">
            {archivedDomainCount} archived {archivedDomainCount === 1 ? 'domain is' : 'domains are'} hidden.
          </p>
          <Button variant="outline" size="sm" onClick={onShowArchived}>
            Show archived
          </Button>
        </div>
      )}
    </div>
  );
}
