/**
 * The four Delivery KPI tiles (UC-3). Same stat-tile form as `KpiCard`, but with
 * the sample caption BR-11 requires under the hint — a delivery median without
 * its sample size is exactly the "number that lies" ADR-explicit-degrade forbids.
 */

import type { CanonicalDeliverySummary } from '../../../../shared/ipc-types.js';
import { Card } from '../../../components/ui/card';
import { deliveryKpis } from './delivery-presentation';

export function DeliveryKpis({ summary }: { summary: CanonicalDeliverySummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {deliveryKpis(summary).map((kpi) => (
        <Card key={kpi.label} size="sm" role="group" aria-label={kpi.label} className="min-h-[92px] gap-1 px-4 py-3">
          <span className="text-[11.5px] text-content-quaternary">{kpi.label}</span>
          <span className="text-2xl font-semibold leading-none tracking-[-0.02em] text-content-primary">
            {kpi.value}
          </span>
          <span className="text-[11px] text-content-quaternary">{kpi.hint}</span>
          {kpi.caption === null ? null : <span className="text-[11px] text-content-tertiary">{kpi.caption}</span>}
        </Card>
      ))}
    </div>
  );
}
