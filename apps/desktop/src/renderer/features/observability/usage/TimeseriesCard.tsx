/**
 * Daily timeseries with a metric switch and a chart/table toggle (UC-1). The
 * table is the accessible readout of the same points the chart draws — hover is
 * visual-only in the node test environment (LIM-6), so the numbers must be
 * reachable without it.
 */

import { useMemo, useState } from 'react';
import type { WorkspaceUsageAnalytics } from '../../../../shared/ipc-types.js';
import { Button } from '../../../components/ui/button';
import { SegmentedControl } from '../SegmentedControl';
import { LineChart } from '../charts/LineChart';
import { UsageCard } from './UsageCard';
import { METRIC_OPTIONS, type UsageMetric, metricDefs, spendSeriesCaption } from './usage-presentation';

const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** One unambiguous date per tooltip — the ISO echo beside it was the same fact twice. */
function tooltipDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : MONTH_DAY_YEAR.format(at);
}

export function TimeseriesCard({ usage }: { usage: WorkspaceUsageAnalytics }) {
  const [metric, setMetric] = useState<UsageMetric>('calls');
  const [asTable, setAsTable] = useState(false);

  const def = metricDefs[metric];
  // Both feed LineChart's memoised layout: rebuilding them every render would
  // change their identity and defeat it.
  const points = useMemo(() => def.points(usage), [def, usage]);
  const unpricedByDate = useMemo(
    () => new Map(usage.series.spendUsd.map((p) => [p.date, p.unpricedSessions])),
    [usage.series.spendUsd],
  );
  const withoutUsageByDate = useMemo(
    () => new Map(usage.series.spendUsd.map((p) => [p.date, p.sessionsWithoutUsage])),
    [usage.series.spendUsd],
  );
  const spendCaption = spendSeriesCaption(
    usage.series.spendUsd,
    usage.kpis.spend.unpricedSessions,
    usage.kpis.spend.sessionsWithoutUsage,
  );

  return (
    <UsageCard
      title={def.title}
      sub={def.subtitle}
      action={
        <>
          <SegmentedControl options={METRIC_OPTIONS} value={metric} onChange={setMetric} ariaLabel="Metric" />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={asTable}
            onClick={() => setAsTable((value) => !value)}
          >
            {asTable ? 'View as chart' : 'View as table'}
          </Button>
        </>
      }
    >
      {asTable ? (
        <div className="max-h-64 overflow-auto rounded-lg border border-border-input">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr>
                <th className="sticky top-0 bg-bg-primary-hover px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.03em] text-content-tertiary">
                  Date
                </th>
                <th className="sticky top-0 bg-bg-primary-hover px-3 py-1.5 text-right text-[11px] font-medium uppercase tracking-[0.03em] text-content-tertiary">
                  {def.column}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-input">
              {[...points].reverse().map((point) => (
                <tr key={point.date}>
                  <td className="px-3 py-1.5 text-left text-content-secondary">{point.date.slice(0, 10)}</td>
                  <td className="px-3 py-1.5 text-right text-content-secondary">
                    {point.value === null ? 'no data' : def.format(point.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <LineChart
            points={points}
            format={def.format}
            axisFormat={def.axisFormat}
            ariaLabel={def.title}
            renderTooltip={(point) => (
              <>
                <div className="font-semibold">
                  {point.value === null ? 'no data' : `${def.column} · ${def.format(point.value)}`}
                </div>
                <div className="text-content-inverted/70">{tooltipDate(point.date)}</div>
                {metric === 'spend' && (unpricedByDate.get(point.date) ?? 0) > 0 ? (
                  <div className="text-content-inverted/70">{unpricedByDate.get(point.date)} unpriced</div>
                ) : null}
                {metric === 'spend' && (withoutUsageByDate.get(point.date) ?? 0) > 0 ? (
                  <div className="text-content-inverted/70">
                    {withoutUsageByDate.get(point.date)} without usage data
                  </div>
                ) : null}
              </>
            )}
          />
          {metric === 'spend' && spendCaption !== null ? (
            <p className="text-[11.5px] text-content-quaternary">{spendCaption}</p>
          ) : null}
        </div>
      )}
    </UsageCard>
  );
}
