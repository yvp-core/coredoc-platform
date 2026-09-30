/**
 * The four Usage headline tiles (UC-1): MCP calls, agent sessions, active
 * developers, assistant spend. `KpiCard` owns the tile surface; this adds the
 * period-over-period delta line beside the value (BR-2) and the spend degrade
 * caption (BR-1/LIM-1).
 */

import type { WorkspaceUsageAnalytics } from '../../../../shared/ipc-types.js';
import { KpiCard } from '../KpiCard';
import { formatNumber, formatUsd } from '../observability-format';
import {
  type DeltaDirection,
  type DeltaPresentation,
  UNPRICED_MARKER,
  deltaPresentation,
  developersHint,
  sparkFromSeries,
  spendCaption,
} from './usage-presentation';

const TONE_CLASS = {
  up: 'text-brand-600',
  down: 'text-content-warning',
  flat: 'text-content-quaternary',
} as const;

function DeltaLine({ delta }: { delta: DeltaPresentation }) {
  if (delta.kind === 'no-prior') {
    return <span className="whitespace-nowrap text-[11.5px] text-content-quaternary">no prior data</span>;
  }
  return <span className={`whitespace-nowrap text-[11.5px] tabular-nums ${TONE_CLASS[delta.tone]}`}>{delta.text}</span>;
}

function Tile({
  label,
  value,
  delta,
  hint,
  spark,
}: {
  label: string;
  value: string;
  delta?: DeltaPresentation;
  hint?: string;
  spark?: { date: string; value: number }[];
}) {
  return (
    <KpiCard
      label={label}
      value={
        /* Wrapping keeps the delta inside the tile at narrow widths; a clipped
           "vs prev" would silently drop the comparison the value depends on. */
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span>{value}</span>
          {delta ? <DeltaLine delta={delta} /> : null}
        </span>
      }
      hint={hint}
      spark={spark}
    />
  );
}

export function KpiRow({ usage }: { usage: WorkspaceUsageAnalytics }) {
  const { window, kpis, series } = usage;
  const days = window.days;
  const delta = (current: number | null, previous: number | null, direction: DeltaDirection) =>
    deltaPresentation(current, previous, direction, days);

  const spendValue = kpis.spend.currentUsd === null ? UNPRICED_MARKER : formatUsd(kpis.spend.currentUsd);
  const spendHint = spendCaption(kpis.spend) ?? undefined;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="MCP calls"
        value={formatNumber(kpis.mcpCalls.current)}
        delta={delta(kpis.mcpCalls.current, kpis.mcpCalls.previous, 'up-good')}
        spark={sparkFromSeries(series.mcpCalls)}
      />
      <Tile
        label="Agent sessions"
        value={formatNumber(kpis.sessions.current)}
        delta={delta(kpis.sessions.current, kpis.sessions.previous, 'up-good')}
        spark={sparkFromSeries(series.sessions)}
      />
      <Tile label="Active developers" value={String(kpis.developers.current)} hint={developersHint(kpis.developers)} />
      <Tile
        label="Assistant spend"
        value={spendValue}
        delta={delta(kpis.spend.currentUsd, kpis.spend.previousUsd, 'down-good')}
        hint={spendHint}
        spark={sparkFromSeries(series.spendUsd)}
      />
    </div>
  );
}
