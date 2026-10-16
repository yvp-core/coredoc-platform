/**
 * The four Usage headline tiles: MCP calls, agent sessions, active developers,
 * assistant spend. `KpiCard` owns the tile surface; this adds the
 * period-over-period delta beside the value and the spend degrade caption.
 */

import { KpiCard } from '@/components/kpi-card';
import { formatNumber, formatUsd } from '@coredoc/core/browser/format';
import type { WorkspaceUsageAnalytics } from '../types.js';
import {
  type DeltaDirection,
  type DeltaPresentation,
  UNPRICED_MARKER,
  deltaPresentation,
  developersHint,
  sparkFromSeries,
  spendCaption,
} from './usage-presentation.js';

const TONE_CLASS = {
  up: 'text-brand-text',
  down: 'text-danger-text',
  flat: 'text-ink-4',
} as const;

function DeltaLine({ delta }: { delta: DeltaPresentation }) {
  if (delta.kind === 'no-prior') {
    return <span className="whitespace-nowrap text-[12.5px] text-ink-4">no prior data</span>;
  }
  return <span className={`num whitespace-nowrap text-[12.5px] ${TONE_CLASS[delta.tone]}`}>{delta.text}</span>;
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
  spark?: number[];
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
  const spark = (points: Parameters<typeof sparkFromSeries>[0]) => sparkFromSeries(points).map((point) => point.value);

  const spendValue = kpis.spend.currentUsd === null ? UNPRICED_MARKER : formatUsd(kpis.spend.currentUsd);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="MCP calls"
        value={formatNumber(kpis.mcpCalls.current)}
        delta={delta(kpis.mcpCalls.current, kpis.mcpCalls.previous, 'up-good')}
        spark={spark(series.mcpCalls)}
      />
      <Tile
        label="Agent sessions"
        value={formatNumber(kpis.sessions.current)}
        delta={delta(kpis.sessions.current, kpis.sessions.previous, 'up-good')}
        spark={spark(series.sessions)}
      />
      <Tile label="Active developers" value={String(kpis.developers.current)} hint={developersHint(kpis.developers)} />
      <Tile
        label="Assistant spend"
        value={spendValue}
        delta={delta(kpis.spend.currentUsd, kpis.spend.previousUsd, 'down-good')}
        hint={spendCaption(kpis.spend) ?? undefined}
        spark={spark(series.spendUsd)}
      />
    </div>
  );
}
