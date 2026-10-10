import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { agentRunActivityQueryOptions, agentRunSpecsQueryOptions } from '@/api/queries/agent-runs';
import { EmptyNote } from '@/components/empty-note';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';

import { specVersions } from './agent-run-page';
import { RunDrawer } from './RunDrawer';
import { SpecDocument } from './ScopeReview';
import type { AgentRunDetail, AgentRunIntentRef } from './types';

export function SpecDrawer({
  wsId,
  run,
  version,
  onClose,
}: {
  wsId: string;
  run: AgentRunDetail;
  version?: number;
  onClose: () => void;
}) {
  const latest = run.latestSpec;
  const versions = useQuery(agentRunSpecsQueryOptions(wsId, run.id, latest?.version));
  const [selected, setSelected] = useState<number | undefined>(version);
  const all = specVersions(run, versions.data ?? []).reverse();
  const shown = all.find((spec) => spec.version === (selected ?? latest?.version)) ?? all[0];

  return (
    <RunDrawer
      title="Spec"
      actions={
        all.length > 1 && shown ? (
          <Segmented
            value={String(shown.version)}
            onChange={(value) => setSelected(Number(value))}
            items={all.map((spec) => ({ value: String(spec.version), label: `v${spec.version}` }))}
          />
        ) : null
      }
      onClose={onClose}
    >
      {shown ? <SpecDocument spec={shown} /> : <EmptyNote>The agent has not proposed a scope yet.</EmptyNote>}
    </RunDrawer>
  );
}

const AUTHORITY = {
  candidate: { label: 'Waiting for Intent review', tone: 'candidate' },
  accepted: { label: 'Accepted', tone: 'accepted' },
  rejected: { label: 'Rejected', tone: 'rejected' },
  superseded: { label: 'Superseded', tone: 'superseded' },
} as const;

function IntentRows({
  label,
  refs,
  showAuthority,
}: {
  label: string;
  refs: AgentRunIntentRef[];
  showAuthority: boolean;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="mt-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-3">{label}</h3>
      {refs.length === 0 ? (
        <p className="text-[13px] text-ink-4">None.</p>
      ) : (
        <ul aria-label={label} className="flex flex-col gap-1.5">
          {refs.map((ref) => {
            const authority = ref.authority ? AUTHORITY[ref.authority] : null;
            return (
              <li
                key={ref.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border-soft px-2.5 py-2"
              >
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium text-ink-1">{ref.title ?? ref.id}</span>
                  <span className="block truncate text-[12px] text-ink-4">
                    {ref.title === null ? 'No longer in the product intent' : (ref.location ?? 'Product')}
                  </span>
                </span>
                {showAuthority && authority && <Badge variant={authority.tone}>{authority.label}</Badge>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function IntentDrawer({
  wsId,
  slug,
  run,
  onClose,
}: {
  wsId: string;
  slug: string;
  run: AgentRunDetail;
  onClose: () => void;
}) {
  const activity = useQuery(agentRunActivityQueryOptions(wsId, run.id, run.status));
  const intent = activity.data?.intent ?? { read: [], proposed: [] };
  return (
    <RunDrawer title="Product intent" onClose={onClose}>
      <IntentRows label="Read by the agent" refs={intent.read} showAuthority={false} />
      <IntentRows label="Proposed" refs={intent.proposed} showAuthority />
      {intent.proposed.length > 0 && (
        <Link to="/w/$slug/intent" params={{ slug }} className="mt-1 text-[13px] text-blue hover:underline">
          Open Intent review
        </Link>
      )}
    </RunDrawer>
  );
}
