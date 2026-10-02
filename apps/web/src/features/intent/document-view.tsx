/**
 * The selected node read as one document: its layout's headings and prose in
 * order, each item in its slot, items without a slot under their kind, and
 * open questions last — the same document an agent reads through `intent_read`.
 *
 * Every item opens the detail pane when clicked. What is not approved yet
 * is marked in place rather than listed elsewhere, so a reader always sees a
 * proposal next to the text it would change.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { useEffect, useRef, useState } from 'react';
import { Chip } from './items-list.js';
import { IntentMarkdown } from './intent-markdown.js';
import { contextConditionText, stripSourceRefs } from './intent-presentation.js';
import { IntentAuthority, type IntentDocumentItem, type IntentNodeDocument } from './types.js';

export interface IntentDocumentViewProps {
  document: IntentNodeDocument | null;
  loading: boolean;
  errorMessage?: string;
  includeCandidates: boolean;
  selectedItemId: string | null;
  onToggleCandidates: (include: boolean) => void;
  onSelectItem: (id: string) => void;
  onOpenNode: (kind: 'domain' | 'feature', id: string) => void;
  onRetry: () => void;
  /** Proposals waiting in the whole workspace, and a jump to the next one (oldest first). */
  waiting?: number;
  onNextProposal?: () => void;
  /** Proposals shown in this document, approvable as one decision. */
  proposalCount?: number;
  approveAll?: IntentApproveAll;
}

export interface IntentApproveAll {
  canReview: boolean;
  busy: boolean;
  /** Resolves with what happened, in one sentence. */
  onApprove: (input: { reason: string; ticket: string }) => Promise<string>;
}

export function IntentDocumentView({
  document,
  loading,
  errorMessage,
  includeCandidates,
  selectedItemId,
  onToggleCandidates,
  onSelectItem,
  onOpenNode,
  onRetry,
  waiting = 0,
  onNextProposal,
  proposalCount = 0,
  approveAll,
}: IntentDocumentViewProps) {
  const [showRefs, setShowRefs] = useState(false);
  const text = (value: string) => (showRefs ? value : stripSourceRefs(value));
  const scroller = useRef<HTMLDivElement>(null);

  // Bring the selected item into view — after "Next proposal" it may be far down the page.
  useEffect(() => {
    if (selectedItemId === null || document === null) return;
    const target = scroller.current?.querySelector(`[data-item-id="${CSS.escape(selectedItemId)}"]`);
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedItemId, document]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border-soft px-3.5 py-2">
        <Chip pressed={includeCandidates} label="Approved + proposed" onClick={() => onToggleCandidates(true)} />
        <Chip pressed={!includeCandidates} label="Approved only" onClick={() => onToggleCandidates(false)} />
        <span className="mx-1 h-4 w-px bg-border-soft" />
        <Chip pressed={showRefs} label="Source refs" onClick={() => setShowRefs((value) => !value)} />
        <span className="flex-1" />
        {onNextProposal && waiting > 0 && (
          <Button variant="outline" size="sm" onClick={onNextProposal} title="Oldest waiting proposals first">
            <span className="num text-blue">{waiting}</span> waiting · Next proposal ›
          </Button>
        )}
      </div>
      {approveAll && includeCandidates && proposalCount > 0 && (
        <ApproveAllBar count={proposalCount} approveAll={approveAll} />
      )}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner className="text-ink-4" />
          </div>
        ) : errorMessage || document === null ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <p className="text-[13.5px] text-ink-2">Couldn't load this document.</p>
            {errorMessage && <p className="text-[12px] text-ink-4">{errorMessage}</p>}
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <article className="max-w-[1080px] px-7 pb-10 pt-6">
            <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink-1">
              {document.node.title}
            </h1>
            {document.sections.map((section, index) => (
              <section key={`${section.heading ?? ''}-${index}`}>
                {section.heading !== null && (
                  <h2 className="mb-1.5 mt-6 border-b border-border-soft pb-1 text-[15px] font-semibold text-ink-1">
                    {section.heading}
                  </h2>
                )}
                {section.blocks.map((block, blockIndex) => {
                  const key = `${index}-${blockIndex}`;
                  if (block.type === 'heading')
                    return (
                      <h3 key={key} className="mb-1 mt-4 text-[14.5px] font-semibold text-ink-1">
                        {block.text}
                      </h3>
                    );
                  if (block.type === 'prose')
                    return (
                      <IntentMarkdown
                        key={key}
                        text={text(block.lines.join('\n'))}
                        className="text-[14.5px] leading-relaxed text-ink-2"
                      />
                    );
                  return (
                    <DocumentItem
                      key={block.item.id}
                      item={block.item}
                      style={block.style}
                      text={text}
                      selectedItemId={selectedItemId}
                      onSelect={onSelectItem}
                    />
                  );
                })}
              </section>
            ))}
            {document.sections.every((section) => section.blocks.every((block) => block.type !== 'item')) && (
              <p className="mt-4 text-[13.5px] text-ink-4">
                {includeCandidates ? 'No items are attached here.' : 'No approved items are attached here.'}
              </p>
            )}
            {document.truncated && (
              <p className="mt-4 text-[13px] text-warn-text">
                This node holds more items than one document shows; use the List view to see the rest.
              </p>
            )}
            <DocumentFooter document={document} onOpenNode={onOpenNode} />
          </article>
        )}
      </div>
    </>
  );
}

function DocumentItem({
  item,
  style,
  text,
  selectedItemId,
  onSelect,
}: {
  item: IntentDocumentItem;
  style: 'bullet' | 'heading' | 'prose';
  text: (value: string) => string;
  selectedItemId: string | null;
  onSelect: (id: string) => void;
}) {
  const candidate = item.authority === IntentAuthority.Candidate;
  const selected = selectedItemId === item.id || selectedItemId === item.pendingSuccessor?.id;
  const conditions = item.appliesWhen.map(contextConditionText);

  return (
    <div
      className={cn(
        'relative -ml-2.5 my-0.5 rounded-lg border-l-[3px] border-transparent transition-colors',
        candidate && 'border-blue bg-blue-wash/40',
        item.pendingSuccessor && 'border-warn-text',
        item.openQuestion && 'border-rework',
        selected ? 'bg-brand-wash' : 'hover:bg-surface-2',
      )}
    >
      {/* A div, not a button: the body may hold Markdown blocks and diagrams. */}
      <div
        role="button"
        tabIndex={0}
        data-item-id={item.id}
        aria-pressed={selectedItemId === item.id}
        onClick={() => onSelect(item.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(item.id);
          }
        }}
        className={cn(
          'block w-full cursor-pointer py-1 pr-2.5 text-left text-[14.5px] leading-relaxed text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand',
          style === 'bullet' ? 'pl-6' : 'pl-2.5',
        )}
      >
        {style === 'bullet' && (
          <span aria-hidden="true" className="absolute left-3 top-1 text-ink-4">
            •
          </span>
        )}
        {style === 'heading' && <span className="block font-semibold">{item.title}</span>}
        <IntentMarkdown inline text={text(item.statement)} />
        {conditions.length > 0 && (
          <span className="text-[13px] text-ink-3"> — only when {conditions.join(' and ')}</span>
        )}
        <ItemMarks item={item} />
        {item.body.length > 0 && (
          <IntentMarkdown text={text(item.body.join('\n'))} className="mt-0.5 text-[14px] text-ink-2" />
        )}
      </div>
      {item.pendingSuccessor && (
        <button
          type="button"
          data-item-id={item.pendingSuccessor.id}
          aria-pressed={selectedItemId === item.pendingSuccessor.id}
          onClick={() => onSelect(item.pendingSuccessor?.id ?? item.id)}
          className={cn(
            'mb-1 ml-6 mr-2.5 block rounded-md border border-dashed border-warn-text/50 px-2 py-1 text-left text-[13.5px] text-ink-2',
            selectedItemId === item.pendingSuccessor.id ? 'bg-warn-wash' : 'hover:bg-warn-wash',
          )}
        >
          <Badge variant="warn" className="mr-1.5">
            Change proposed
          </Badge>
          <IntentMarkdown inline text={text(item.pendingSuccessor.statement)} />
        </button>
      )}
    </div>
  );
}

function ItemMarks({ item }: { item: IntentDocumentItem }) {
  const marks: { label: string; variant: 'candidate' | 'replace' | 'warn' | 'neutral' | 'info' }[] = [];
  if (item.openQuestion) marks.push({ label: 'Open question', variant: 'warn' });
  if (item.authority === IntentAuthority.Candidate)
    marks.push({ label: item.proposedSuccessorOfId ? 'Proposed replacement' : 'Proposed', variant: 'candidate' });
  if (item.authority === IntentAuthority.Superseded) marks.push({ label: 'Being replaced', variant: 'neutral' });
  if (item.effectivity === 'planned') marks.push({ label: 'Planned', variant: 'replace' });
  if (marks.length === 0) return null;
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-[1px]">
      {marks.map((mark) => (
        <Badge key={mark.label} variant={mark.variant}>
          {mark.label}
        </Badge>
      ))}
    </span>
  );
}

function DocumentFooter({
  document,
  onOpenNode,
}: {
  document: IntentNodeDocument;
  onOpenNode: (kind: 'domain' | 'feature', id: string) => void;
}) {
  const { delivery } = document;
  return (
    <div className="mt-8 grid gap-2 border-t border-dashed border-border pt-3 text-[13.5px] text-ink-2">
      {document.features.length > 0 && (
        <FooterRow label={document.node.kind === 'feature' ? 'Sub-features' : 'Features'}>
          {document.features.map((feature) => (
            <NodeLink key={feature.id} title={feature.title} onClick={() => onOpenNode('feature', feature.id)} />
          ))}
        </FooterRow>
      )}
      {document.related.length > 0 && (
        <FooterRow label="Related">
          {document.related.map((relation) => (
            <span key={`${relation.kind}:${relation.id}`} className="block">
              <NodeLink title={relation.title} onClick={() => onOpenNode(relation.kind, relation.id)} />
              <span className="text-ink-3">{relation.why}</span>
            </span>
          ))}
        </FooterRow>
      )}
      <FooterRow label="Delivery">
        {delivery.effective} in production
        {delivery.planned > 0 ? `, ${delivery.planned} planned` : ''}
        {delivery.unrecorded > 0 ? `, ${delivery.unrecorded} with no delivery record` : ''}
      </FooterRow>
    </div>
  );
}

function FooterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2.5">
      <span className="pt-0.5 text-[11.5px] uppercase tracking-[0.04em] text-ink-4">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function NodeLink({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1 mr-1.5 inline-flex rounded-full border border-border px-2 py-px text-[13px] text-ink-1 hover:bg-surface-2"
    >
      {title}
    </button>
  );
}

function ApproveAllBar({ count, approveAll }: { count: number; approveAll: IntentApproveAll }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [ticket, setTicket] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);

  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border-soft bg-blue-wash/40 px-3.5 py-1.5 text-[13px] text-ink-2">
        <span>
          {count} proposal{count === 1 ? '' : 's'} in this document
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!approveAll.canReview}
          title={approveAll.canReview ? undefined : 'Deciding needs the admin, owner or product role'}
          onClick={() => {
            setOutcome(null);
            setOpen(true);
          }}
        >
          Approve all proposed here…
        </Button>
        {outcome && <span className="text-ink-3">{outcome}</span>}
      </div>
    );

  return (
    <div className="flex flex-col gap-2 border-b border-border-soft bg-blue-wash/40 px-3.5 py-2.5 text-[13px]">
      <span className="font-medium text-ink-1">
        Approve {count} proposal{count === 1 ? '' : 's'} as one decision
      </span>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Reason"
          placeholder="Reason (optional)"
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="h-7 w-[280px] bg-surface text-[13px]"
        />
        <Input
          aria-label="Ticket"
          placeholder="Decided in ticket, e.g. jira:PROD-412 (optional)"
          maxLength={200}
          value={ticket}
          onChange={(event) => setTicket(event.target.value)}
          className="h-7 w-[300px] bg-surface text-[13px]"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={approveAll.busy}
          onClick={() =>
            void approveAll.onApprove({ reason, ticket }).then((message) => {
              setOutcome(message);
              setOpen(false);
            })
          }
        >
          {approveAll.busy ? 'Approving…' : `Approve ${count}`}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
