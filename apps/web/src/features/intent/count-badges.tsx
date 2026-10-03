/**
 * The waiting-proposal and open-question badges a node row carries, shared by
 * the Structure tree and the product root's domain list so the two read alike.
 * A zero or unread (`undefined`) count draws nothing.
 */

import { CircleHelp } from 'lucide-react';

export function IntentCountBadges({ pending, open }: { pending?: number; open?: number }) {
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
    </>
  );
}
