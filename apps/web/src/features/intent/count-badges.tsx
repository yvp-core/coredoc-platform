/**
 * The waiting-proposal, open-question and open-comment badges a node row carries,
 * shared by the Structure tree and the product root's domain list so the two read
 * alike. A zero or unread (`undefined`) count draws nothing.
 */

import { Badge } from '@/components/ui/badge';
import { CircleHelp, MessagesSquare } from 'lucide-react';
import { openCommentsLabel } from './intent-presentation.js';

export function IntentCountBadges({ pending, open, comments }: { pending?: number; open?: number; comments?: number }) {
  return (
    <>
      {pending !== undefined && pending > 0 && (
        <span
          title={`${pending} waiting for review`}
          className="num shrink-0 rounded-full bg-blue-wash px-1.5 text-[11px] text-blue"
        >
          <span aria-hidden="true">{pending}</span>
          <span className="sr-only">{pending} waiting for review</span>
        </span>
      )}
      {open !== undefined && open > 0 && (
        <span
          title={`${open} open ${open === 1 ? 'question' : 'questions'}`}
          className="num inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warn-wash px-1.5 text-[11px] text-warn-text"
        >
          <CircleHelp aria-hidden="true" className="size-2.5" />
          <span aria-hidden="true">{open}</span>
          <span className="sr-only">
            {open} open {open === 1 ? 'question' : 'questions'}
          </span>
        </span>
      )}
      {comments !== undefined && comments > 0 && (
        <span
          title={openCommentsLabel(comments) ?? undefined}
          className="num inline-flex shrink-0 items-center gap-0.5 rounded-full bg-blue-wash px-1.5 text-[11px] text-blue"
        >
          <MessagesSquare aria-hidden="true" className="size-2.5" />
          <span aria-hidden="true">{comments}</span>
          <span className="sr-only">{openCommentsLabel(comments)}</span>
        </span>
      )}
    </>
  );
}

export function IntentOpenCommentsBadge({ count }: { count: number | undefined }) {
  const label = openCommentsLabel(count);
  if (label === null) return null;
  return (
    <Badge variant="info" className="gap-1">
      <MessagesSquare aria-hidden="true" className="size-3" />
      {label}
    </Badge>
  );
}
