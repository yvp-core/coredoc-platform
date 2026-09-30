/**
 * MCP tool quality (UC-1, BR-3): calls, average latency and the error / empty
 * pills, ranked by calls. A tool with no classified calls has no empty rate, so
 * it renders no "empty" pill rather than a fabricated 0% (AC-3).
 */

import { useState } from 'react';
import type { UsageToolRow } from '../../../../shared/ipc-types.js';
import { Button } from '../../../components/ui/button';
import { MagnitudeBar } from '../charts/MagnitudeBar';
import { formatNumber } from '../observability-format';
import { UsageCard } from './UsageCard';
import { formatMs, toolPills } from './usage-presentation';

const TOP_N = 8;
const GRID = 'grid grid-cols-[minmax(190px,1.4fr)_2fr_max-content_max-content_max-content] items-center gap-x-3.5';
/**
 * Two pill columns so error and empty read as columns rather than a ragged pair.
 * The tracks are FIXED widths, not `auto`: every row is its own grid container,
 * so an `auto` track resolves per row and the error column drifted by up to
 * 13px between rows. Fixed tracks sized to the widest pill ("10.0% err",
 * "100% empty") give one straight right edge per column down the table, and an
 * absent empty pill leaves its slot empty.
 */
const PILL_SLOTS = 'grid grid-cols-[76px_84px] items-center justify-items-end gap-1.5';
const HEADER_CELL =
  'border-b border-border-input pb-1.5 text-[10.5px] uppercase tracking-[0.04em] text-content-quaternary';

const PILL_TONE = {
  danger: 'bg-bg-warning/10 text-content-warning',
  warn: 'bg-bg-tag-warning text-content-tag-warning',
  ok: 'bg-bg-primary-hover text-content-quaternary',
} as const;

function Pill({ tone, text }: { tone: 'danger' | 'warn' | 'ok'; text: string }) {
  return (
    <span className={`inline-block rounded-full px-[7px] text-[10.5px] tabular-nums ${PILL_TONE[tone]}`}>{text}</span>
  );
}

function ToolRow({ row, max, last }: { row: UsageToolRow; max: number; last: boolean }) {
  const pills = toolPills(row);
  const cell = `min-w-0 py-1.5${last ? '' : ' border-b border-border-input'}`;
  return (
    <>
      <div className={`${cell} truncate font-mono text-xs text-content-secondary`} title={row.toolName}>
        {row.toolName}
      </div>
      <div className={cell}>
        <MagnitudeBar value={row.calls} max={max} tone="brand" />
      </div>
      <div className={`${cell} text-right tabular-nums text-xs font-semibold text-content-primary`}>
        {formatNumber(row.calls)}
      </div>
      <div className={`${cell} text-right tabular-nums text-xs text-content-secondary`}>{formatMs(row.avgMs)}</div>
      <div className={`${cell} ${PILL_SLOTS}`}>
        <Pill tone={pills.error.tone} text={pills.error.text} />
        <span>{pills.empty.tone === 'absent' ? null : <Pill tone={pills.empty.tone} text={pills.empty.text} />}</span>
      </div>
    </>
  );
}

export function ToolUsageCard({ tools }: { tools: ReadonlyArray<UsageToolRow> }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? tools : tools.slice(0, TOP_N);
  const max = Math.max(1, ...tools.map((t) => t.calls));

  return (
    <UsageCard title="MCP tool usage" sub="Calls, latency and result quality by tool">
      {tools.length === 0 ? (
        <p className="py-6 text-center text-sm text-content-quaternary">No MCP tool calls observed in this window.</p>
      ) : (
        <>
          <div className={GRID}>
            {/* The second header cell is intentionally blank: it labels the magnitude bar,
                which is a proportion cue for the Calls column beside it, not its own series. */}
            {['Tool', '', 'Calls', 'Avg', 'Errors · empty'].map((label, index) => (
              <div key={label || 'bar'} className={`${HEADER_CELL}${index >= 2 ? ' text-right' : ''}`}>
                {label}
              </div>
            ))}
            {shown.map((row, index) => (
              <ToolRow key={row.toolName} row={row} max={max} last={index === shown.length - 1} />
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 pt-2.5">
            <span className="text-[11px] text-content-quaternary">
              {shown.length} of {tools.length} tools · “empty” = calls returning zero results
            </span>
            {tools.length > TOP_N ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? `Show top ${TOP_N}` : 'Show all tools'}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </UsageCard>
  );
}
