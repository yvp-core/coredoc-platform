import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '@/api/client';
import { acceptAgentRunScope, agentRunSpecsQueryOptions, requestAgentRunScopeChanges } from '@/api/queries/agent-runs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { IntentMarkdown } from '@/features/intent/intent-markdown';

import type { AgentRunDetail, AgentRunSpec } from './types';

const SPEC_STATUS_LABELS: Record<AgentRunSpec['status'], string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  changes_requested: 'Changes requested',
  superseded: 'Superseded',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-[12px] font-medium uppercase tracking-[0.04em] text-ink-4">{title}</h4>
      {children}
    </section>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * The scope review: a proposal's spec, its repositories with reasons and
 * eligibility, merge order, dropped seeds and candidates for the PRD, with a
 * version selector. Accept and request changes send the displayed version, so
 * the server refuses anything a reviewer has not seen. Agent-written text is
 * rendered with remote content disabled.
 */
export function ScopeReview({ wsId, run }: { wsId: string; run: AgentRunDetail }) {
  const queryClient = useQueryClient();
  const versionId = useId();
  const feedbackId = useId();
  const latest = run.latestSpec;
  const versions = useQuery(agentRunSpecsQueryOptions(wsId, run.id, latest?.version));
  const [selected, setSelected] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', run.id] });
    void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', 'list'] });
  };
  const accept = useMutation({ mutationFn: acceptAgentRunScope, onSuccess: refresh });
  const requestChanges = useMutation({
    mutationFn: requestAgentRunScopeChanges,
    onSuccess: () => {
      setFeedback('');
      refresh();
    },
  });

  if (!latest) return null;
  const all = versions.data ?? [latest];
  const shown = all.find((version) => version.version === (selected ?? latest.version)) ?? latest;
  const reviewable = run.status === 'awaiting_scope_acceptance' && shown.status === 'proposed';
  const ordered = [...shown.repositories].sort((a, b) => a.mergeOrder - b.mergeOrder);

  return (
    <Card role="region" aria-label="Scope review">
      <CardHead
        title={shown.title}
        sub={
          <>
            Version {shown.version} · <Badge variant="neutral">{SPEC_STATUS_LABELS[shown.status]}</Badge>
            {shown.autoAccepted ? ' · accepted automatically' : ''}
          </>
        }
        right={
          all.length > 1 ? (
            <label htmlFor={versionId} className="flex items-center gap-2 text-[12.5px] text-ink-3">
              Version
              <select
                id={versionId}
                value={shown.version}
                onChange={(event) => setSelected(Number(event.target.value))}
                className="rounded-md border border-border-soft bg-surface-2 px-2 py-1 text-[12.5px]"
              >
                {all.map((version) => (
                  <option key={version.version} value={version.version}>
                    {version.version} — {SPEC_STATUS_LABELS[version.status]}
                  </option>
                ))}
              </select>
            </label>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        <IntentMarkdown noRemote text={shown.summary} className="text-[13.5px] text-ink-2" />

        {shown.reviewText && (
          <Section title="Requested changes">
            <IntentMarkdown noRemote text={shown.reviewText} className="text-[13.5px] text-ink-2" />
          </Section>
        )}

        <Section title="Repositories, in merge order">
          <div className="overflow-x-auto">
            <table aria-label="Repositories" className="min-w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-ink-4">
                  <th className="py-1 pr-3 font-medium">#</th>
                  <th className="py-1 pr-3 font-medium">Repository</th>
                  <th className="py-1 pr-3 font-medium">Why</th>
                  <th className="py-1 pr-3 font-medium">What changes</th>
                  <th className="py-1 font-medium">Eligibility</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((repository, index) => (
                  <tr key={repository.key} className="border-t border-border-soft align-top">
                    <td className="py-1.5 pr-3 text-ink-4">{index + 1}</td>
                    <td className="py-1.5 pr-3 font-mono text-[12.5px]">{repository.key}</td>
                    <td className="py-1.5 pr-3">
                      <IntentMarkdown inline noRemote text={repository.reason} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <IntentMarkdown inline noRemote text={repository.changes} />
                    </td>
                    <td className="py-1.5">
                      {repository.eligible ? (
                        'Eligible'
                      ) : (
                        <span className="text-danger-text">Not eligible ({repository.ineligibleReason})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {shown.droppedSeeds.length > 0 && (
          <Section title="Named repositories left out">
            <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
              {shown.droppedSeeds.map((seed) => (
                <li key={seed.key}>
                  <span className="font-mono text-[12.5px]">{seed.key}</span>:{' '}
                  <IntentMarkdown inline noRemote text={seed.reason} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {shown.candidates.length > 0 && (
          <Section title="Candidates for the PRD (open product questions)">
            <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
              {shown.candidates.map((candidate) => (
                <li key={candidate.question}>
                  <IntentMarkdown inline noRemote text={candidate.question} />
                  <span className="text-ink-4"> — blocks: </span>
                  <IntentMarkdown inline noRemote text={candidate.blocks} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {(shown.risks.length > 0 || shown.assumptions.length > 0) && (
          <div className="grid gap-4 sm:grid-cols-2">
            {shown.risks.length > 0 && (
              <Section title="Risks">
                <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
                  {shown.risks.map((risk) => (
                    <li key={risk}>
                      <IntentMarkdown inline noRemote text={risk} />
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {shown.assumptions.length > 0 && (
              <Section title="Assumptions">
                <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
                  {shown.assumptions.map((assumption) => (
                    <li key={assumption}>
                      <IntentMarkdown inline noRemote text={assumption} />
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        )}

        <Section title="Specification">
          <IntentMarkdown
            noRemote
            text={shown.markdown}
            className="rounded-lg border border-border-soft p-3 text-[13.5px] text-ink-2"
          />
        </Section>

        {reviewable && (
          <div className="flex flex-col gap-3 border-t border-border-soft pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={accept.isPending || requestChanges.isPending}
                onClick={() => accept.mutate({ wsId, runId: run.id, version: shown.version })}
              >
                {accept.isPending ? 'Accepting…' : 'Accept scope'}
              </Button>
              {accept.error && (
                <span className="text-[13px] text-danger-text">{errorText(accept.error, 'Failed to accept')}</span>
              )}
            </div>
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (feedback.trim()) {
                  requestChanges.mutate({ wsId, runId: run.id, version: shown.version, text: feedback.trim() });
                }
              }}
            >
              <label htmlFor={feedbackId} className="text-[12.5px] text-ink-3">
                Changes to request
              </label>
              <Textarea
                id={feedbackId}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder="What should the agent change in the scope or the specification?"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={!feedback.trim() || accept.isPending || requestChanges.isPending}
                >
                  {requestChanges.isPending ? 'Sending…' : 'Request changes'}
                </Button>
                {requestChanges.error && (
                  <span className="text-[13px] text-danger-text">
                    {errorText(requestChanges.error, 'Failed to request changes')}
                  </span>
                )}
              </div>
            </form>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
