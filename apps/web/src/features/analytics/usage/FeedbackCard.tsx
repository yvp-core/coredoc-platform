/**
 * Session feedback: the submitted records themselves — filterable, sorted and
 * paged on the server — with the aggregate roadmap (top issues, requested
 * capabilities, rating trend) collapsed underneath.
 *
 * The rating line is drawn on a fixed 1..5 scale so two windows are comparable;
 * an auto-scaled 3.4→4.2 line would read as a much larger swing than it is.
 */

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { feedbackRecordsQueryOptions } from '@/api/queries/analytics';
import { membersQueryOptions } from '@/api/queries/members';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { MagnitudeBar } from '../charts/MagnitudeBar.js';
import { linePath, linearScale } from '../charts/chart-geometry.js';
import { formatNumber } from '../format.js';
import {
  type AnalyticsWindow,
  type FeedbackRatingTrendPoint,
  type FeedbackRecordsFilter,
  type FeedbackRoadmap,
  type FeedbackSessionIssueArea,
  FeedbackSort,
  SortOrder,
} from '../types.js';
import { FeedbackRecordRow } from './FeedbackRecordRow.js';
import {
  AREA_HINTS,
  activeFilterCaption,
  feedbackStrip,
  humanizeArea,
  humanizeIssueType,
} from './usage-presentation.js';

const TOP_N = 5;

const RATING_W = 220;
const RATING_H = 84;
const RATING_PAD = { left: 20, right: 14, top: 10, bottom: 18 };
const RATING_GRIDLINES = [1, 3, 5];

function RatingLine({ trend }: { trend: ReadonlyArray<FeedbackRatingTrendPoint> }) {
  const x = linearScale([0, Math.max(1, trend.length - 1)], [RATING_PAD.left, RATING_W - RATING_PAD.right]);
  const y = linearScale([1, 5], [RATING_H - RATING_PAD.bottom, RATING_PAD.top]);
  // A month with no agent rating has no point on the agent line: it is skipped
  // rather than drawn at some substitute value.
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
            stroke="var(--color-grid)"
            strokeWidth={1}
          />
          <text x={RATING_PAD.left - 5} y={y(value) + 3} textAnchor="end" fontSize={8.5} fill="var(--color-ink-4)">
            {value}
          </text>
        </g>
      ))}
      {points.length > 1 ? (
        <path
          d={linePath(points)}
          fill="none"
          stroke="var(--color-brand)"
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
          fill="var(--color-brand)"
          stroke="var(--color-surface)"
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
          fill="var(--color-ink-4)"
        >
          {point.month}
        </text>
      ))}
    </svg>
  );
}

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border-soft pt-3 first:border-t-0 first:pt-0 lg:border-l lg:border-t-0 lg:px-[18px] lg:pt-0 lg:first:border-l-0 lg:first:pl-0 lg:last:pr-0">
      <h4 className="mb-2 text-[11px] uppercase tracking-[0.04em] text-ink-4">{title}</h4>
      {children}
    </div>
  );
}

const FEEDBACK_SUB = (
  <>
    From <span className="font-mono">submit_session_feedback</span> · agent draft reviewed by the user
  </>
);

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-[12px] text-ink-4">{children}</p>;
}

/** The pre-records roadmap, unchanged — now folded away under the records list. */
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
    <div className="grid gap-0 lg:grid-cols-[1.2fr_1.2fr_1fr_0.9fr]">
      <Column title="Top issues">
        {issues.length === 0 ? (
          <Empty>No per-tool issues reported in this window.</Empty>
        ) : (
          <ul className="flex flex-col">
            {issues.map((issue) => (
              <li
                key={`${issue.tool}::${issue.issueType}`}
                className="flex items-center gap-2.5 border-t border-border-soft py-1.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11.5px] text-ink-1">{issue.tool}</span>
                  <span className="block text-[11px] text-ink-4">{humanizeIssueType(issue.issueType)}</span>
                </span>
                <MagnitudeBar
                  value={issue.severityScore}
                  max={maxSeverity}
                  tone="danger"
                  height={5}
                  className="w-14 shrink-0"
                />
                <span className="num shrink-0 whitespace-nowrap text-[12px] text-ink-2">
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
          <ul className="flex flex-col">
            {sessionIssues.map((issue) => (
              <li
                key={`${issue.area}::${issue.issueType}`}
                className="flex items-center gap-2.5 border-t border-border-soft py-1.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11.5px] text-ink-1">{issue.area}</span>
                  <span className="block text-[11px] text-ink-4">{humanizeIssueType(issue.issueType)}</span>
                </span>
                <MagnitudeBar
                  value={issue.severityScore}
                  max={maxSessionSeverity}
                  tone="danger"
                  height={5}
                  className="w-14 shrink-0"
                />
                <span className="num shrink-0 whitespace-nowrap text-[12px] text-ink-2">
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
          <ul className="flex flex-col">
            {needs.map((need) => (
              <li
                key={need.need}
                className="flex items-baseline justify-between gap-2.5 border-t border-border-soft py-1.5 first:border-t-0"
              >
                <span className="min-w-0 text-[12px] text-ink-2">{need.need}</span>
                <span className="num shrink-0 whitespace-nowrap text-[11.5px] text-ink-4">
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
            {latest.avgRating === null ? null : (
              <div className="flex items-baseline gap-2">
                <span className="num text-[24px] font-medium tracking-[-0.02em] text-ink-1">
                  {latest.avgRating.toFixed(1)}
                </span>
                <span className="text-[12px] text-ink-4">/ 5 · agent · trailing {latest.month}</span>
              </div>
            )}
            {latest.avgUserRating !== null ? (
              <p className="num text-[12px] text-ink-2">
                {latest.avgUserRating.toFixed(1)} / 5 · user
                {gap !== null ? (
                  <span className="text-ink-4">
                    {' '}
                    · self-assessment gap {gap >= 0 ? '+' : ''}
                    {gap.toFixed(1)}
                  </span>
                ) : null}
              </p>
            ) : null}
            <p className="text-[11px] text-ink-4">
              {formatNumber(reviewed)} of {formatNumber(feedback.feedbackCount)} reviewed by a user
            </p>
            <RatingLine trend={trend} />
          </>
        )}
      </Column>
    </div>
  );
}

/** Page size is fixed: the window already bounds the volume, so a size control is noise. */
const PAGE_SIZE = 25;

const DEFAULT_FILTER: FeedbackRecordsFilter = {
  area: null,
  userId: null,
  mine: false,
  sort: FeedbackSort.CreatedAt,
  order: SortOrder.Desc,
  page: 1,
  limit: PAGE_SIZE,
};

/** The "no filter" value: Radix Select has no empty-string item value. */
const ANY = 'any';

const AREAS: FeedbackSessionIssueArea[] = [
  'workflow-routing',
  'skill-instructions',
  'task-context',
  'mcp-transport',
  'agent-behavior',
  'host-environment',
  'capture',
  'other',
];

const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: `${FeedbackSort.CreatedAt}:${SortOrder.Desc}`, label: 'Newest' },
  { value: `${FeedbackSort.CreatedAt}:${SortOrder.Asc}`, label: 'Oldest' },
  { value: `${FeedbackSort.OverallRating}:${SortOrder.Asc}`, label: 'Lowest agent rating' },
  { value: `${FeedbackSort.OverallRating}:${SortOrder.Desc}`, label: 'Highest agent rating' },
  { value: `${FeedbackSort.UserRating}:${SortOrder.Asc}`, label: 'Lowest user rating' },
];

export function FeedbackCard({
  feedback,
  workspaceId,
  analyticsWindow,
  isTeam,
}: {
  feedback: FeedbackRoadmap;
  workspaceId: string;
  analyticsWindow: AnalyticsWindow;
  /** Admin/owner scope the list to any member; a member may only scope it to themselves. */
  isTeam: boolean;
}) {
  const [filter, setFilter] = useState<FeedbackRecordsFilter>(DEFAULT_FILTER);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // A window change re-bases the whole population: page 3 of the old window is
  // not page 3 of the new one, so the list goes back to the first page. Adjusted
  // during render (React's documented pattern) rather than in an effect, which
  // would render the stale page once first.
  const [lastWindow, setLastWindow] = useState(analyticsWindow);
  if (lastWindow !== analyticsWindow) {
    setLastWindow(analyticsWindow);
    setFilter((prev) => ({ ...prev, page: 1 }));
  }

  // Every filter change resets the page: the old offset points into a different list.
  const patch = (next: Partial<FeedbackRecordsFilter>) => setFilter((prev) => ({ ...prev, ...next, page: 1 }));

  const membersQuery = useQuery({ ...membersQueryOptions(workspaceId), enabled: isTeam });
  const members = (membersQuery.data ?? []).filter((member) => !member.userId.startsWith('pending:'));
  const nameByUserId = new Map(members.map((member) => [member.userId, member.displayName ?? member.email]));

  const recordsQuery = useQuery({
    ...feedbackRecordsQueryOptions(workspaceId, analyticsWindow, filter),
    enabled: feedback.feedbackCount > 0,
  });

  const page = recordsQuery.data ?? null;
  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : (filter.page - 1) * filter.limit + 1;
  const last = Math.min(filter.page * filter.limit, total);

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={filter.area ?? ANY}
        onValueChange={(value) => patch({ area: value === ANY ? null : (value as FeedbackSessionIssueArea) })}
      >
        <SelectTrigger className="w-[150px]" aria-label="Area">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All areas</SelectItem>
          {AREAS.map((area) => (
            <SelectItem key={area} value={area} title={AREA_HINTS[area]}>
              {humanizeArea(area)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={`${filter.sort}:${filter.order}`}
        onValueChange={(value) => {
          const [sort, order] = value.split(':');
          patch({ sort: sort as FeedbackSort, order: order as SortOrder });
        }}
      >
        <SelectTrigger className="w-[170px]" aria-label="Sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isTeam ? (
        <Select value={filter.userId ?? ANY} onValueChange={(value) => patch({ userId: value === ANY ? null : value })}>
          <SelectTrigger className="w-[170px]" aria-label="Member">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All members</SelectItem>
            {members.map((member) => (
              <SelectItem key={member.userId} value={member.userId}>
                {member.displayName ?? member.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Label className="gap-1.5" htmlFor="feedback-mine">
          <Switch id="feedback-mine" checked={filter.mine} onCheckedChange={(checked) => patch({ mine: checked })} />
          Only mine
        </Label>
      )}
    </div>
  );

  // Nothing was submitted at all: one card-level statement, not an empty list
  // under filters that cannot change it.
  if (feedback.feedbackCount === 0) {
    return (
      <Card>
        <CardHead title="Session feedback" sub={FEEDBACK_SUB} />
        <CardBody>
          <Empty>No feedback submitted in this window yet.</Empty>
        </CardBody>
      </Card>
    );
  }

  const memberLabel = filter.userId === null ? null : (nameByUserId.get(filter.userId) ?? filter.userId);
  const filterCaption = activeFilterCaption(filter, memberLabel);

  return (
    <Card>
      <CardHead title="Session feedback" sub={FEEDBACK_SUB} />
      <CardBody className="flex flex-col gap-3">
        <p className="num text-[12px] text-ink-2">{feedbackStrip(feedback)}</p>

        {filters}

        {recordsQuery.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner className="text-ink-4" />
          </div>
        ) : recordsQuery.isError ? (
          <div className="flex items-center justify-between gap-3 py-3">
            <span className="text-[12.5px] text-danger-text">
              {recordsQuery.error instanceof Error ? recordsQuery.error.message : 'Request failed'}
            </span>
            <Button variant="outline" size="sm" onClick={() => void recordsQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : page !== null && page.items.length === 0 ? (
          <Empty>
            {filterCaption === null
              ? 'No feedback records in this window.'
              : `No feedback records match ${filterCaption}.`}
          </Empty>
        ) : (
          <ul className="flex flex-col">
            {(page?.items ?? []).map((record) => (
              <FeedbackRecordRow
                key={record.id}
                record={record}
                who={
                  (record.userId === null ? null : (nameByUserId.get(record.userId) ?? null)) ??
                  record.userEmail ??
                  record.userId ??
                  'Unattributed'
                }
                expanded={expandedId === record.id}
                onToggle={() => setExpandedId((prev) => (prev === record.id ? null : record.id))}
              />
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border-soft pt-2.5">
          <span className="num text-[11.5px] text-ink-4">
            {first}–{last} of {formatNumber(total)}
          </span>
          <span className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={filter.page <= 1}
              onClick={() => setFilter((prev) => ({ ...prev, page: prev.page - 1 }))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={last >= total}
              onClick={() => setFilter((prev) => ({ ...prev, page: prev.page + 1 }))}
            >
              Next
            </Button>
          </span>
        </div>

        <details className="border-t border-border-soft pt-2.5">
          <summary className="cursor-pointer text-[11.5px] text-ink-3">Aggregates</summary>
          <div className="pt-3">
            <Aggregates feedback={feedback} />
          </div>
        </details>
      </CardBody>
    </Card>
  );
}
