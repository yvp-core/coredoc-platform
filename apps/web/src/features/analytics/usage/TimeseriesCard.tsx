/**
 * Daily timeseries with a metric switch and a chart/table toggle. The table is
 * the accessible readout of the same points the chart draws — hover is
 * visual-only, so the numbers must be reachable without it.
 */

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { LineChart } from '../charts/LineChart.js';
import type { WorkspaceUsageAnalytics } from '../types.js';
import { METRIC_OPTIONS, type UsageMetric, metricDefs, spendSeriesCaption } from './usage-presentation.js';

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

const TH =
  'sticky top-0 bg-surface-2 px-3 py-1.5 text-[12px] font-normal uppercase tracking-[0.04em] text-ink-4 text-left';

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
    <Card>
      <CardHead
        title={def.title}
        sub={def.subtitle}
        right={
          <>
            <Segmented value={metric} onChange={setMetric} items={[...METRIC_OPTIONS]} />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={asTable}
              onClick={() => setAsTable((v) => !v)}
            >
              {asTable ? 'View as chart' : 'View as table'}
            </Button>
          </>
        }
      />
      <CardBody>
        {asTable ? (
          <div className="max-h-64 overflow-auto rounded-lg border border-border-soft">
            <table className="num w-full text-[13px]">
              <thead>
                <tr>
                  <th className={TH}>Date</th>
                  <th className={`${TH} text-right`}>{def.column}</th>
                </tr>
              </thead>
              <tbody>
                {[...points].reverse().map((point) => (
                  <tr key={point.date} className="border-t border-border-soft">
                    <td className="px-3 py-1.5 text-left text-ink-2">{point.date.slice(0, 10)}</td>
                    <td className="px-3 py-1.5 text-right text-ink-2">
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
                  <div className="font-medium">
                    {point.value === null ? 'no data' : `${def.column} · ${def.format(point.value)}`}
                  </div>
                  <div className="text-tooltip-ink/70">{tooltipDate(point.date)}</div>
                  {metric === 'spend' && (unpricedByDate.get(point.date) ?? 0) > 0 ? (
                    <div className="text-tooltip-ink/70">{unpricedByDate.get(point.date)} unpriced</div>
                  ) : null}
                  {metric === 'spend' && (withoutUsageByDate.get(point.date) ?? 0) > 0 ? (
                    <div className="text-tooltip-ink/70">{withoutUsageByDate.get(point.date)} without usage data</div>
                  ) : null}
                </>
              )}
            />
            {metric === 'spend' && spendCaption !== null ? (
              <p className="text-[12.5px] text-ink-4">{spendCaption}</p>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
