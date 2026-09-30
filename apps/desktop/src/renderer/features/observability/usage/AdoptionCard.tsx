/**
 * Adoption meter + facts (UC-1): how much of the team's work runs through Coredoc.
 * Every figure but the token median is server-observed (`mcp_query_metrics`, BR-3) — host
 * session telemetry never reported Coredoc tool use, so it is not a source here. Every null
 * the server sends stays a dash with no bar movement: an unavailable rate is not zero (BR-11).
 */

import type { UsageAdoption } from '../../../../shared/ipc-types.js';
import { UsageCard } from './UsageCard';
import { adoptionFacts, adoptionMeter } from './usage-presentation';

export function AdoptionCard({ adoption }: { adoption: UsageAdoption }) {
  const meter = adoptionMeter(adoption);
  const facts = adoptionFacts(adoption);

  return (
    <UsageCard title="Adoption" sub="Server-observed MCP calls · session medians from host telemetry">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs text-content-secondary">Developers using Coredoc</span>
        <span className="text-lg font-semibold tracking-[-0.01em] tabular-nums text-content-primary">{meter.text}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg-tag-success" aria-hidden="true">
        <div className="h-full rounded-full bg-content-brand" style={{ width: `${meter.widthPct}%` }} />
      </div>
      <dl className="mt-2.5 flex flex-col divide-y divide-border-input">
        {facts.map((fact) => (
          <div key={fact.label} className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-xs text-content-tertiary">{fact.label}</dt>
            <dd className="whitespace-nowrap text-[12.5px] font-semibold tabular-nums text-content-primary">
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </UsageCard>
  );
}
