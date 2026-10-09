import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '@/api/client';
import { acceptAgentRunScope, requestAgentRunScopeChanges } from '@/api/queries/agent-runs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { IntentMarkdown } from '@/features/intent/intent-markdown';

import type { AgentRunSpec } from './types';

export const SPEC_STATUS_LABELS: Record<AgentRunSpec['status'], string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  changes_requested: 'Changes requested',
  superseded: 'Superseded',
};

export const SPEC_STATUS_TONES = {
  proposed: 'info',
  accepted: 'ok',
  changes_requested: 'warn',
  superseded: 'neutral',
} as const satisfies Record<AgentRunSpec['status'], string>;

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
 * One spec version as the reviewer reads it: the reviewer's feedback when it
 * was sent back, the summary, repositories with reasons, eligibility and merge
 * order, dropped seeds, candidates for the PRD, risks, assumptions and the
 * specification. Agent-written text is rendered with remote content disabled.
 */
export function SpecDocument({ spec }: { spec: AgentRunSpec }) {
  const ordered = [...spec.repositories].sort((a, b) => a.mergeOrder - b.mergeOrder);
  return (
    <article aria-label={`Spec v${spec.version}`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <Badge variant={SPEC_STATUS_TONES[spec.status]}>{SPEC_STATUS_LABELS[spec.status]}</Badge>
        {spec.autoAccepted && <span>accepted automatically</span>}
      </div>
      {spec.reviewText && (
        <div className="rounded-lg bg-blue-wash px-3 py-2 text-[13px] text-ink-2">
          <div className="text-[12px] font-medium text-blue">Requested changes</div>
          <IntentMarkdown noRemote text={spec.reviewText} />
        </div>
      )}
      <h3 className="text-[16px] font-semibold text-ink-1 [text-wrap:balance]">{spec.title}</h3>
      <IntentMarkdown noRemote text={spec.summary} className="text-[13.5px] text-ink-2" />

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

      {spec.droppedSeeds.length > 0 && (
        <Section title="Named repositories left out">
          <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
            {spec.droppedSeeds.map((seed) => (
              <li key={seed.key}>
                <span className="font-mono text-[12.5px]">{seed.key}</span>:{' '}
                <IntentMarkdown inline noRemote text={seed.reason} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {spec.candidates.length > 0 && (
        <Section title="Candidates for the PRD (open product questions)">
          <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
            {spec.candidates.map((candidate) => (
              <li key={candidate.question}>
                <IntentMarkdown inline noRemote text={candidate.question} />
                <span className="text-ink-4"> — blocks: </span>
                <IntentMarkdown inline noRemote text={candidate.blocks} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {spec.risks.length > 0 && (
        <Section title="Risks">
          <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
            {spec.risks.map((risk) => (
              <li key={risk}>
                <IntentMarkdown inline noRemote text={risk} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {spec.assumptions.length > 0 && (
        <Section title="Assumptions">
          <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
            {spec.assumptions.map((assumption) => (
              <li key={assumption}>
                <IntentMarkdown inline noRemote text={assumption} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Specification">
        <IntentMarkdown
          noRemote
          text={spec.markdown}
          className="rounded-lg border border-border-soft p-3 text-[13.5px] text-ink-2"
        />
      </Section>
    </article>
  );
}

/**
 * Accept or request changes on the version the reviewer is looking at; the
 * server refuses anything but the latest proposed version, so a stale review
 * is told so rather than applied.
 */
export function ScopeReviewActions({ wsId, runId, version }: { wsId: string; runId: string; version: number }) {
  const queryClient = useQueryClient();
  const feedbackId = useId();
  const [feedback, setFeedback] = useState('');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', runId] });
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
  const busy = accept.isPending || requestChanges.isPending;

  return (
    <section aria-label="Scope review" className="flex flex-col gap-3 border-t border-border-soft pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => accept.mutate({ wsId, runId, version })}>
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
          if (feedback.trim()) requestChanges.mutate({ wsId, runId, version, text: feedback.trim() });
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
          <Button type="submit" size="sm" variant="outline" disabled={!feedback.trim() || busy}>
            {requestChanges.isPending ? 'Sending…' : 'Request changes'}
          </Button>
          {requestChanges.error && (
            <span className="text-[13px] text-danger-text">
              {errorText(requestChanges.error, 'Failed to request changes')}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
