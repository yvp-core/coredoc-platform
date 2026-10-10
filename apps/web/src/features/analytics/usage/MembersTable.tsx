/**
 * Usage by member — adoption reach, sortable. This table exists on the Usage
 * view only: per-person *delivery* aggregates are deliberately absent, and
 * nothing here is a delivery figure.
 *
 * A member sees a single row (the server self-scopes the read), so the subtitle
 * drops the "N members" count in that case.
 */

import { useState } from 'react';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { MagnitudeBar } from '../charts/MagnitudeBar.js';
import { NO_DATA, formatNumber, plural } from '@coredoc/core/browser/format';
import type { UsageMemberRow } from '../types.js';
import {
  DEFAULT_MEMBER_SORT,
  type MemberSort,
  type MemberSortKey,
  UNPRICED_MARKER,
  memberDisplayName,
  memberInitials,
  memberSpendPresentation,
  nextMemberSort,
  relativeDayLabel,
  sortMembers,
} from './usage-presentation.js';

// Per-person spend is hidden for now (product call 2026-09-08); the cell, sort key
// and presentation helpers stay so flipping this back is a one-line change.
const SHOW_SPEND = false;

const COLUMNS: ReadonlyArray<{ key: MemberSortKey | 'topTool' | 'lastActive'; label: string; sortable: boolean }> = [
  { key: 'member', label: 'Member', sortable: true },
  { key: 'sessions', label: 'Sessions', sortable: true },
  { key: 'tokens', label: 'Tokens', sortable: true },
  ...(SHOW_SPEND ? [{ key: 'spend' as const, label: 'Spend', sortable: true }] : []),
  { key: 'coredocCalls', label: 'Coredoc calls', sortable: true },
  { key: 'topTool', label: 'Top tool', sortable: false },
  { key: 'lastActive', label: 'Last active', sortable: false },
];

const TH =
  'border-b border-border-soft px-3 pb-1.5 text-right text-[11.5px] uppercase tracking-[0.04em] text-ink-4 whitespace-nowrap first:pl-0 first:text-left';
// Form controls do not inherit `text-transform`, so a sort button has to carry the
// label recipe itself or the sortable headers read as sentence case beside the static ones.
const TH_BUTTON = 'cursor-pointer rounded-sm px-1 py-0.5 text-[11.5px] uppercase tracking-[0.04em]';
const TD = 'border-b border-border-soft px-3 py-2 text-right text-ink-2 whitespace-nowrap first:pl-0 first:text-left';

function SpendCell({ row }: { row: UsageMemberRow }) {
  const spend = memberSpendPresentation(row);
  if (spend.kind === 'amount') return <>{spend.text}</>;
  if (spend.kind === 'unpriced') return <span className="text-ink-4">{UNPRICED_MARKER}</span>;
  return <span className="text-ink-4">{NO_DATA}</span>;
}

export function MembersTable({
  members,
  days,
  isTeam,
  now,
}: {
  members: ReadonlyArray<UsageMemberRow>;
  days: number;
  isTeam: boolean;
  /** Taken from the window end so the relative "last active" labels match the window. */
  now: Date;
}) {
  const [sort, setSort] = useState<MemberSort>(DEFAULT_MEMBER_SORT);
  const rows = sortMembers(members, sort.key, sort.dir);
  const maxCalls = Math.max(1, ...members.map((m) => m.coredocCalls));
  const sub = isTeam
    ? `${plural(rows.length, 'member')} active in the last ${days}d · click a column to sort`
    : 'Your usage';

  return (
    <Card>
      <CardHead title="Usage by member" sub={sub} />
      <CardBody>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-ink-4">No attributed activity in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[780px] border-collapse text-[13.5px]">
              <thead>
                <tr>
                  {COLUMNS.map((column) => {
                    const active = column.sortable && sort.key === column.key;
                    return (
                      <th
                        key={column.key}
                        scope="col"
                        className={TH}
                        aria-sort={
                          column.sortable
                            ? active
                              ? sort.dir === -1
                                ? 'descending'
                                : 'ascending'
                              : 'none'
                            : undefined
                        }
                      >
                        {column.sortable ? (
                          <button
                            type="button"
                            className={`${TH_BUTTON} ${active ? 'text-ink-1' : ''}`}
                            onClick={() => setSort((current) => nextMemberSort(current, column.key as MemberSortKey))}
                          >
                            {column.label}{' '}
                            <span className="text-[9px]">{active ? (sort.dir === -1 ? '▼' : '▲') : ''}</span>
                          </button>
                        ) : (
                          column.label
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const lastActive = relativeDayLabel(row.lastActiveAt, now);
                  return (
                    <tr key={row.userId ?? row.userEmail ?? memberDisplayName(row)} className="hover:bg-surface-2">
                      <td className={TD}>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            aria-hidden="true"
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-track text-[10.5px] tracking-[0.02em] text-ink-2"
                          >
                            {memberInitials(row)}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate leading-[1.3] text-ink-1">{memberDisplayName(row)}</span>
                            {row.userEmail ? (
                              <span className="block truncate text-[12px] leading-[1.3] text-ink-4">
                                {row.userEmail}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      </td>
                      <td className={TD}>{formatNumber(row.sessions)}</td>
                      <td className={TD}>{formatNumber(row.tokens)}</td>
                      {SHOW_SPEND ? (
                        <td className={TD}>
                          <SpendCell row={row} />
                        </td>
                      ) : null}
                      <td className={TD}>
                        {row.coredocCalls > 0 ? (
                          <span className="inline-flex items-center justify-end gap-2">
                            {formatNumber(row.coredocCalls)}
                            <MagnitudeBar value={row.coredocCalls} max={maxCalls} height={5} className="w-16" />
                          </span>
                        ) : (
                          <span className="text-ink-4">{NO_DATA}</span>
                        )}
                      </td>
                      <td className={TD}>
                        {row.topTool ? (
                          <span className="rounded-md border border-border-soft bg-surface-2 px-[7px] font-mono text-[12px] text-ink-2">
                            {row.topTool}
                          </span>
                        ) : (
                          <span className="text-ink-4">{NO_DATA}</span>
                        )}
                      </td>
                      <td className={`${TD}${lastActive.isToday ? '' : ' text-ink-4'}`}>{lastActive.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
