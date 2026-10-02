/**
 * One submitted feedback record. The row is the button: clicking or pressing
 * Enter expands the already-fetched detail in place — the list read carries the
 * nested arrays, so an expansion never costs a request.
 */

import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Chip } from '../delivery/Chip.js';
import { NO_DATA } from '../format.js';
import type { FeedbackRecord, FeedbackReviewStatus } from '../types.js';
import { formatUtcMinute, humanizeArea, humanizeIssueType, recordCountChips } from './usage-presentation.js';

const REVIEW_VARIANT: Record<FeedbackReviewStatus, 'neutral' | 'ok' | 'warn'> = {
  unreviewed: 'neutral',
  confirmed: 'ok',
  amended: 'warn',
};

function rating(value: number | null): string {
  return value === null ? NO_DATA : String(value);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2 first:mt-0">
      <h5 className="text-[11.5px] uppercase tracking-[0.04em] text-ink-4">{title}</h5>
      <ul className="mt-1 flex flex-col gap-1">{children}</ul>
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="text-ink-4">{children}</span>;
}

export function FeedbackRecordRow({
  record,
  who,
  expanded,
  onToggle,
}: {
  record: FeedbackRecord;
  /** Display name resolved through the members list, or the email/id the record carries. */
  who: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const chips = recordCountChips(record);

  return (
    <li className="border-t border-border-soft first:border-t-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-1 py-2 text-left hover:bg-surface-2"
      >
        <span className="num shrink-0 text-[12.5px] text-ink-4">{formatUtcMinute(record.createdAt)}</span>
        <span className="max-w-[160px] shrink-0 truncate text-[13px] text-ink-2">{who}</span>
        <span className="num shrink-0 whitespace-nowrap text-[12.5px] text-ink-3">
          agent {rating(record.overallRating)} → user {rating(record.userRating)}
        </span>
        <Badge variant={REVIEW_VARIANT[record.reviewStatus]}>{record.reviewStatus}</Badge>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{record.summary ?? 'No summary'}</span>
        {chips.map((chip) => (
          <Chip key={chip}>{chip}</Chip>
        ))}
      </button>

      {expanded ? (
        <div className="px-1 pb-3 text-[12.5px] text-ink-2">
          {record.perToolIssues.length > 0 ? (
            <Section title="Tool issues">
              {record.perToolIssues.map((issue) => (
                <li key={`${issue.tool}::${issue.issueType}::${issue.description}`}>
                  <span className="font-mono">{issue.tool}</span> <Meta>· {humanizeIssueType(issue.issueType)}</Meta>{' '}
                  <Meta>· severity {issue.severity}</Meta>
                  <span className="block text-ink-3">{issue.description}</span>
                </li>
              ))}
            </Section>
          ) : null}

          {record.sessionIssues.length > 0 ? (
            <Section title="Session issues">
              {record.sessionIssues.map((issue) => (
                <li key={`${issue.area}::${issue.issueType}::${issue.description}`}>
                  {humanizeArea(issue.area)} <Meta>· {humanizeIssueType(issue.issueType)}</Meta>{' '}
                  <Meta>· severity {issue.severity}</Meta>
                  {issue.skill === undefined ? null : <Meta> · {issue.skill}</Meta>}
                  {issue.stageId === undefined ? null : <Meta> · {issue.stageId}</Meta>}
                  <span className="block text-ink-3">{issue.description}</span>
                </li>
              ))}
            </Section>
          ) : null}

          {record.missingCapabilities.length > 0 ? (
            <Section title="Missing capabilities">
              {record.missingCapabilities.map((capability) => (
                <li key={capability.need}>
                  {capability.need}
                  {capability.useCase === undefined ? null : <Meta> · {capability.useCase}</Meta>}
                </li>
              ))}
            </Section>
          ) : null}

          {record.misleadingMetadata.length > 0 ? (
            <Section title="Misleading metadata">
              {record.misleadingMetadata.map((item) => (
                <li key={`${item.toolOrAttr}::${item.why}`}>
                  <span className="font-mono">{item.toolOrAttr}</span> <Meta>· {item.why}</Meta>
                </li>
              ))}
            </Section>
          ) : null}

          {record.userNotes === null ? null : (
            <blockquote className="mt-2 border-l-2 border-border-soft pl-2 text-ink-3">{record.userNotes}</blockquote>
          )}
        </div>
      ) : null}
    </li>
  );
}
