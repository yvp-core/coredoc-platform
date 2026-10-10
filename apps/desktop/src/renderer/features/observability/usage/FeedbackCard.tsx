/**
 * Session feedback (UC-1). With every dev session writing a record, the raw
 * records — not the aggregates — are the body: a summary strip on top, a filter
 * row, the paged list, and the old roadmap columns collapsed underneath.
 *
 * `FeedbackCardBody` is the whole card as a pure function of its props (the
 * desktop renderer suite runs without a DOM, LIM-6); `FeedbackCard` is the thin
 * container that owns the two reads and the filter/expansion state.
 *
 * The rating line in the aggregates is drawn on a fixed 1..5 scale so two windows
 * are comparable; an auto-scaled 3.4→4.2 line would read as a much larger swing.
 */

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_FEEDBACK_RECORDS_FILTER,
  type AnalyticsWindow,
  type FeedbackRatingTrendPoint,
  type FeedbackRecord,
  type FeedbackRecordsFilter,
  type FeedbackRecordsPage,
  type FeedbackRoadmap,
  type FeedbackSessionIssueArea,
} from '../../../../shared/ipc-types.js';
import { Button } from '../../../components/ui/button';
import { Checkbox } from '../../../components/ui/checkbox';
import { Label } from '../../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select';
import { MagnitudeBar } from '../charts/MagnitudeBar';
import { linePath, linearScale } from '@coredoc/core/browser/chart-geometry';
import { Chip } from '../delivery/Chip';
import { memberOptions } from '../delivery/delivery-presentation';
import { formatNumber } from '@coredoc/core/browser/format';
import { feedbackRecordsQueryOptions, workspaceMembersQueryOptions } from '../observability-api';
import { UsageCard } from './UsageCard';
import {
  ALL,
  AREA_OPTIONS,
  SESSION_AREA_LABELS,
  SORT_OPTIONS,
  activeFilterSummary,
  countChips,
  decodeSort,
  encodeSort,
  hasNextPage,
  nextFilter,
  pageRange,
  ratingPair,
  recordDate,
  recordWho,
  reviewTone,
  summaryStrip,
  type FilterOption,
} from './feedback-presentation';
import { humanizeIssueType } from './usage-presentation';

const TOP_N = 5;

const RATING_W = 220;
const RATING_H = 84;
const RATING_PAD = { left: 20, right: 14, top: 10, bottom: 18 };
const RATING_GRIDLINES = [1, 3, 5];

function RatingLine({ trend }: { trend: ReadonlyArray<FeedbackRatingTrendPoint> }) {
  const x = linearScale([0, Math.max(1, trend.length - 1)], [RATING_PAD.left, RATING_W - RATING_PAD.right]);
  const y = linearScale([1, 5], [RATING_H - RATING_PAD.bottom, RATING_PAD.top]);
  // A month with no agent self-rating has nothing to plot: it keeps its x slot and
  // its label, but the line skips it rather than drawing an invented value.
  const points = trend.flatMap((point, index) =>
    point.avgRating === null ? [] : [{ x: x(index), y: y(point.avgRating) }],
  );
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${RATING_W} ${RATING_H}`}
      role="img"
      aria-label="Average session rating by month"
      className="mt-1.5 block w-full"
    >
      {RATING_GRIDLINES.map((value) => (
        <g key={value}>
          <line
            x1={RATING_PAD.left}
            x2={RATING_W - RATING_PAD.right}
            y1={y(value)}
            y2={y(value)}
            stroke="var(--color-chart-grid)"
            strokeWidth={1}
          />
          <text
            x={RATING_PAD.left - 5}
            y={y(value) + 3}
            textAnchor="end"
            fontSize={8.5}
            fill="var(--color-content-quaternary)"
          >
            {value}
          </text>
        </g>
      ))}
      {points.length > 1 ? (
        <path
          d={linePath(points)}
          fill="none"
          stroke="var(--color-content-brand)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {last ? (
        <circle
          cx={last.x}
          cy={last.y}
          r={3.5}
          fill="var(--color-content-brand)"
          stroke="var(--color-bg-primary)"
          strokeWidth={2}
        />
      ) : null}
      {trend.map((point, index) => (
        <text
          key={point.month}
          x={x(index)}
          y={RATING_H - 4}
          textAnchor="middle"
          fontSize={8.5}
          fill="var(--color-content-quaternary)"
        >
          {point.month}
        </text>
      ))}
    </svg>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border-input pt-3 first:border-t-0 first:pt-0 lg:border-l lg:border-t-0 lg:px-[18px] lg:pt-0 lg:first:border-l-0 lg:first:pl-0 lg:last:pr-0">
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-content-quaternary">{title}</h4>
      {children}
    </div>
  );
}

const FEEDBACK_SUB = (
  <>
    From <span className="font-mono">submit_session_feedback</span> · agent draft reviewed by the user
  </>
);

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-xs text-content-quaternary">{children}</p>;
}

/** The roadmap aggregates, unchanged — now a disclosure under the records list. */
function Aggregates({ feedback }: { feedback: FeedbackRoadmap }) {
  const issues = feedback.topIssues.slice(0, TOP_N);
  const sessionIssues = feedback.topSessionIssues.slice(0, TOP_N);
  const needs = feedback.topMissingTools.slice(0, TOP_N);
  const trend = feedback.ratingTrend;
  const latest = trend[trend.length - 1] ?? null;
  const maxSeverity = Math.max(1, ...issues.map((issue) => issue.severityScore));
  const maxSessionSeverity = Math.max(1, ...sessionIssues.map((issue) => issue.severityScore));
  const reviewed = feedback.reviews.confirmed + feedback.reviews.amended;
  const gap = feedback.reviews.avgSelfAssessmentGap;

  return (
    <details className="mt-3 border-t border-border-input pt-2">
      <summary className="cursor-pointer text-[11.5px] text-content-tertiary">Aggregates</summary>
      <div className="mt-3 grid gap-0 lg:grid-cols-[1.2fr_1.2fr_1fr_0.9fr]">
        <Column title="Top issues">
          {issues.length === 0 ? (
            <Empty>No per-tool issues reported in this window.</Empty>
          ) : (
            <ul className="flex flex-col divide-y divide-border-input">
              {issues.map((issue) => (
                <li key={`${issue.tool}::${issue.issueType}`} className="flex items-center gap-2.5 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-content-primary">{issue.tool}</span>
                    <span className="block text-[11px] text-content-quaternary">
                      {humanizeIssueType(issue.issueType)}
                    </span>
                  </span>
                  <MagnitudeBar
                    value={issue.severityScore}
                    max={maxSeverity}
                    tone="danger"
                    height={5}
                    className="w-14 shrink-0"
                  />
                  <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-content-secondary">
                    {formatNumber(issue.count)} reports
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Column>

        <Column title="Session issues">
          {sessionIssues.length === 0 ? (
            <Empty>No workflow or session issues reported in this window.</Empty>
          ) : (
            <ul className="flex flex-col divide-y divide-border-input">
              {sessionIssues.map((issue) => (
                <li key={`${issue.area}::${issue.issueType}`} className="flex items-center gap-2.5 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-content-primary">
                      {SESSION_AREA_LABELS[issue.area]}
                    </span>
                    <span className="block text-[11px] text-content-quaternary">
                      {humanizeIssueType(issue.issueType)}
                    </span>
                  </span>
                  <MagnitudeBar
                    value={issue.severityScore}
                    max={maxSessionSeverity}
                    tone="danger"
                    height={5}
                    className="w-14 shrink-0"
                  />
                  <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-content-secondary">
                    {formatNumber(issue.count)} reports
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Column>

        <Column title="Most-requested capabilities">
          {needs.length === 0 ? (
            <Empty>No missing capabilities reported in this window.</Empty>
          ) : (
            <ul className="flex flex-col divide-y divide-border-input">
              {needs.map((need) => (
                <li key={need.need} className="flex items-baseline justify-between gap-2.5 py-1.5">
                  <span className="min-w-0 text-xs text-content-secondary">{need.need}</span>
                  <span className="shrink-0 whitespace-nowrap text-[11.5px] tabular-nums text-content-quaternary">
                    {formatNumber(need.count)} asks
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Column>

        <Column title="Session rating">
          {latest === null ? (
            <Empty>No session ratings submitted yet.</Empty>
          ) : (
            <>
              {latest.avgRating === null ? (
                <p className="text-xs text-content-quaternary">No agent self-rating in {latest.month}.</p>
              ) : (
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tracking-[-0.02em] tabular-nums text-content-primary">
                    {latest.avgRating.toFixed(1)}
                  </span>
                  <span className="text-xs text-content-quaternary">/ 5 · agent · trailing {latest.month}</span>
                </div>
              )}
              {latest.avgUserRating !== null ? (
                <p className="text-xs tabular-nums text-content-secondary">
                  {latest.avgUserRating.toFixed(1)} / 5 · user
                  {gap !== null ? (
                    <span className="text-content-quaternary">
                      {' '}
                      · self-assessment gap {gap >= 0 ? '+' : ''}
                      {gap.toFixed(1)}
                    </span>
                  ) : null}
                </p>
              ) : null}
              <p className="text-[11px] text-content-quaternary">
                {formatNumber(reviewed)} of {formatNumber(feedback.feedbackCount)} reviewed by a user
              </p>
              <RatingLine trend={trend} />
            </>
          )}
        </Column>
      </div>
    </details>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<FilterOption>;
  onChange: (next: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} title={option.title}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DetailList({ title, items }: { title: string; items: ReadonlyArray<{ head: string; body: string }> }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h5 className="text-[10.5px] font-medium uppercase tracking-[0.04em] text-content-quaternary">{title}</h5>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={`${item.head}::${item.body}`} className="text-xs text-content-secondary">
            <span className="text-content-primary">{item.head}</span>
            {item.body === '' ? null : <span> — {item.body}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function joinMeta(parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

function RecordDetail({ record }: { record: FeedbackRecord }) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-border-input bg-bg-primary-hover px-3 py-2.5">
      <DetailList
        title="Tool issues"
        items={record.perToolIssues.map((issue) => ({
          head: joinMeta([issue.tool, humanizeIssueType(issue.issueType), `severity ${issue.severity}`]),
          body: issue.description,
        }))}
      />
      <DetailList
        title="Session issues"
        items={record.sessionIssues.map((issue) => ({
          head: joinMeta([
            SESSION_AREA_LABELS[issue.area],
            humanizeIssueType(issue.issueType),
            `severity ${issue.severity}`,
            issue.skill,
            issue.stageId,
          ]),
          body: issue.description,
        }))}
      />
      <DetailList
        title="Missing capabilities"
        items={record.missingCapabilities.map((capability) => ({
          head: capability.need,
          body: capability.useCase ?? '',
        }))}
      />
      <DetailList
        title="Misleading metadata"
        items={record.misleadingMetadata.map((entry) => ({ head: entry.toolOrAttr, body: entry.why }))}
      />
      {record.userNotes === null ? null : (
        <blockquote className="border-l-2 border-border-input pl-2.5 text-xs italic text-content-secondary">
          {record.userNotes}
        </blockquote>
      )}
    </div>
  );
}

function RecordRow({
  record,
  who,
  expanded,
  onToggle,
}: {
  record: FeedbackRecord;
  who: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const chips = countChips(record);
  return (
    <li className="border-b border-border-input last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer flex-wrap items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-primary-hover"
      >
        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-content-quaternary">
          {recordDate(record.createdAt)}
        </span>
        <span className="min-w-0 max-w-[160px] shrink-0 truncate text-xs text-content-secondary">{who}</span>
        <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-content-tertiary">
          {ratingPair(record)}
        </span>
        <Chip tone={reviewTone(record.reviewStatus)}>{record.reviewStatus}</Chip>
        <span className="min-w-0 flex-1 truncate text-xs text-content-primary">
          {record.summary ?? <span className="text-content-quaternary">No summary</span>}
        </span>
        {chips.map((chip) => (
          <Chip key={chip}>{chip}</Chip>
        ))}
      </button>
      {expanded ? <RecordDetail record={record} /> : null}
    </li>
  );
}

export interface FeedbackCardBodyProps {
  feedback: FeedbackRoadmap;
  filter: FeedbackRecordsFilter;
  onFilterChange: (patch: Partial<FeedbackRecordsFilter>) => void;
  /** Empty (and the member picker hidden) for a non-admin caller. */
  members: ReadonlyArray<{ userId: string; label: string }>;
  /** Admin/owner: the member picker. Otherwise the self-scope checkbox. */
  isTeam: boolean;
  /** null while the read is in flight or failed. */
  page: FeedbackRecordsPage | null;
  error: string | null;
  onRetry: () => void;
  expandedId: string | null;
  onToggleExpanded: (id: string) => void;
}

export function FeedbackCardBody({
  feedback,
  filter,
  onFilterChange,
  members,
  isTeam,
  page,
  error,
  onRetry,
  expandedId,
  onToggleExpanded,
}: FeedbackCardBodyProps) {
  const memberName = members.find((member) => member.userId === filter.userId)?.label ?? null;
  const narrowed = activeFilterSummary(filter, memberName);

  // Nothing was submitted at all: one card-level statement, not a filter row over
  // an empty list plus four empty aggregate columns.
  if (feedback.feedbackCount === 0) {
    return (
      <UsageCard title="Session feedback" sub={FEEDBACK_SUB}>
        <Empty>No feedback submitted in this window yet.</Empty>
      </UsageCard>
    );
  }

  return (
    <UsageCard title="Session feedback" sub={FEEDBACK_SUB}>
      <p className="text-[11.5px] tabular-nums text-content-tertiary">{summaryStrip(feedback)}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Area"
          value={filter.area ?? ALL}
          options={AREA_OPTIONS}
          onChange={(next) => onFilterChange({ area: next === ALL ? null : (next as FeedbackSessionIssueArea) })}
        />
        <FilterSelect
          label="Sort"
          value={encodeSort(filter)}
          options={SORT_OPTIONS}
          onChange={(next) => onFilterChange(decodeSort(next))}
        />
        {isTeam ? (
          <FilterSelect
            label="Member"
            value={filter.userId ?? ALL}
            options={[
              { value: ALL, label: 'All members' },
              ...members.map((member) => ({ value: member.userId, label: member.label })),
            ]}
            onChange={(next) => onFilterChange({ userId: next === ALL ? null : next })}
          />
        ) : (
          <Label htmlFor="feedback-mine" className="gap-1.5">
            <Checkbox
              id="feedback-mine"
              checked={filter.mine}
              onCheckedChange={(next) => onFilterChange({ mine: next === true })}
            />
            Only mine
          </Label>
        )}
      </div>

      {error !== null ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-xs text-content-secondary">Feedback records are currently unavailable.</p>
          <Button type="button" variant="outline" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : page === null ? (
        <Empty>Loading records…</Empty>
      ) : page.items.length === 0 ? (
        <Empty>{narrowed === null ? 'No records in this window.' : `No records match this filter: ${narrowed}.`}</Empty>
      ) : (
        <>
          <ul className="mt-2.5 flex flex-col border-t border-border-input">
            {page.items.map((record) => (
              <RecordRow
                key={record.id}
                record={record}
                who={recordWho(record, members)}
                expanded={expandedId === record.id}
                onToggle={() => onToggleExpanded(record.id)}
              />
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11.5px] tabular-nums text-content-quaternary">{pageRange(page)}</span>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={page.page <= 1}
                onClick={() => onFilterChange({ page: page.page - 1 })}
              >
                Prev
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!hasNextPage(page)}
                onClick={() => onFilterChange({ page: page.page + 1 })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <Aggregates feedback={feedback} />
    </UsageCard>
  );
}

export function FeedbackCard({
  workspaceId,
  window: analyticsWindow,
  feedback,
  isTeam,
}: {
  workspaceId: string;
  window: AnalyticsWindow;
  feedback: FeedbackRoadmap;
  isTeam: boolean;
}) {
  const [filter, setFilter] = useState<FeedbackRecordsFilter>(DEFAULT_FEEDBACK_RECORDS_FILTER);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Any filter change resets to page 1: page N of the previous filter is not a
  // page of this one, and the server would answer it with unrelated rows.
  const onFilterChange = useCallback((patch: Partial<FeedbackRecordsFilter>) => {
    setFilter((current) => nextFilter(current, patch));
    setExpandedId(null);
  }, []);

  const recordsQuery = useQuery(feedbackRecordsQueryOptions(workspaceId, analyticsWindow, filter));
  // The member picker is an admin/owner surface; a member keeps the self-scope
  // toggle, and the server refuses any other id from them regardless.
  const membersQuery = useQuery({ ...workspaceMembersQueryOptions(workspaceId), enabled: isTeam });

  return (
    <FeedbackCardBody
      feedback={feedback}
      filter={filter}
      onFilterChange={onFilterChange}
      members={memberOptions(membersQuery.data ?? [])}
      isTeam={isTeam}
      page={recordsQuery.data ?? null}
      error={recordsQuery.isError ? String(recordsQuery.error) : null}
      onRetry={() => void recordsQuery.refetch()}
      expandedId={expandedId}
      onToggleExpanded={(id) => setExpandedId((current) => (current === id ? null : id))}
    />
  );
}
