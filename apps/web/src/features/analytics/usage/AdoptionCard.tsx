/**
 * Adoption meter + facts: how much of the team's work runs through Coredoc.
 * Every null the server sends stays a dash with no bar movement — an
 * unavailable rate is not zero.
 */

import { Card, CardBody, CardHead } from '@/components/ui/card';
import type { UsageAdoption } from '../types.js';
import { adoptionFacts, adoptionMeter } from './usage-presentation.js';

export function AdoptionCard({ adoption }: { adoption: UsageAdoption }) {
  const meter = adoptionMeter(adoption);
  const facts = adoptionFacts(adoption);

  return (
    <Card>
      <CardHead title="Adoption" sub="Server-observed MCP calls · session medians from host telemetry" />
      <CardBody>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="text-[13.5px] text-ink-2">Developers using Coredoc</span>
          <span className="num text-[18px] font-medium tracking-[-0.01em] text-ink-1">{meter.text}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-track" aria-hidden="true">
          <div className="h-full rounded-full bg-brand" style={{ width: `${meter.widthPct}%` }} />
        </div>
        <dl className="mt-2.5 flex flex-col">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="flex items-baseline justify-between gap-3 border-t border-border-soft py-1.5 first:border-t-0"
            >
              <dt className="text-[13px] text-ink-3">{fact.label}</dt>
              <dd className="num whitespace-nowrap text-[13.5px] font-medium text-ink-1">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}
