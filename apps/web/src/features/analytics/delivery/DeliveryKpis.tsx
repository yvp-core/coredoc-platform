/**
 * The four Delivery KPI tiles. Same stat-tile form as `KpiCard`, but with the
 * sample caption under the hint — a delivery median without its sample size is a
 * number that lies.
 */

import type { CanonicalDeliverySummary } from '../types.js';
import { deliveryKpis } from './delivery-presentation.js';

export function DeliveryKpis({ summary }: { summary: CanonicalDeliverySummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {deliveryKpis(summary).map((kpi) => (
        <section
          key={kpi.label}
          aria-label={kpi.label}
          className="flex min-h-[108px] flex-col gap-0.5 rounded-xl border border-border bg-surface px-3.5 py-3 shadow-card"
        >
          <span className="text-[11.5px] text-ink-4">{kpi.label}</span>
          <span className="num text-[24px] font-medium leading-none tracking-[-0.02em] text-ink-1">{kpi.value}</span>
          <span className="text-[11px] text-ink-4">{kpi.hint}</span>
          {kpi.caption === null ? null : <span className="text-[11px] text-ink-3">{kpi.caption}</span>}
        </section>
      ))}
    </div>
  );
}
