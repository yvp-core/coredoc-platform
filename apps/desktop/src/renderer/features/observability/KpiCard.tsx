/**
 * KPI stat tile — a big-number card on the ui/card surface. Per the dataviz form
 * heuristic a single headline magnitude is *not a chart*: it's a stat tile (label
 * + value + optional hint), with an optional decorative sparkline as a band along
 * the bottom edge. The band is the last child in normal flow, not an absolutely
 * positioned overlay: an overlay needs reserved bottom padding, and any caption
 * that outgrows that reserve paints over the curve. Dumb by design — callers own
 * data fetching and formatting.
 */

import type { ReactNode } from 'react';
import { Card } from '../../components/ui/card';
import { Sparkline, type SparklinePoint } from './Sparkline';

export function KpiCard({
  label,
  value,
  hint,
  spark,
  sparkColor,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  spark?: SparklinePoint[];
  sparkColor?: string;
}) {
  return (
    <Card
      size="sm"
      role="group"
      aria-label={label}
      className="min-h-[92px] justify-start gap-1.5 overflow-hidden px-4 py-3"
    >
      <span className="text-[11.5px] tracking-[0.02em] text-content-quaternary">{label}</span>
      <div className="text-2xl font-semibold leading-none tracking-[-0.02em] text-content-primary">{value}</div>
      {hint ? <div className="text-[11.5px] text-content-quaternary">{hint}</div> : null}
      {spark && spark.length > 1 ? (
        /* Last child, pushed to the bottom by `mt-auto`: the negative margins let the
           band span the card's full width without the text sharing its inset. */
        <Sparkline
          points={spark}
          color={sparkColor}
          className="pointer-events-none -mx-4 -mb-3 mt-auto h-[34px] w-[calc(100%+2rem)] opacity-80"
        />
      ) : null}
    </Card>
  );
}
