/**
 * One task's full trace, composed from the existing bounded reads — detail plus
 * the first page of six collections, then one nested page per run and per
 * external ref — instead of a server trace route. Lanes render progressively: a
 * collection that fails takes down its own row, not the chart.
 */

import { useQueries, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import {
  canonicalTaskDetailQueryOptions,
  traceArtifactRevisionsQueryOptions,
  traceArtifactsQueryOptions,
  traceCodeChangesQueryOptions,
  traceExternalRefsQueryOptions,
  traceRefHistoryQueryOptions,
  traceReworkSignalsQueryOptions,
  traceRunStagesQueryOptions,
  traceRunsQueryOptions,
  traceShipEvidenceQueryOptions,
} from '@/api/queries/analytics';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { GanttChart } from '../charts/GanttChart.js';
import { plural } from '../format.js';
import type {
  CanonicalArtifactItem,
  CanonicalExternalRefStateFactItem,
  CanonicalStageOccurrenceItem,
} from '../types.js';
import { ArtifactRevisionList } from './ArtifactRevisions.js';
import { Chip, lifecycleTone } from './Chip.js';
import { JourneyView } from './JourneyView.js';
import { RetentionNotice } from './RetentionNotice.js';
import { StageBars } from './StageBars.js';
import { UNCLAIMED_COLOR, estimatedCostLine, partialShipLabel, stageColor } from './delivery-presentation.js';
import {
  type TraceSources,
  buildGanttLanes,
  claimedByStage,
  journeyEvents,
  stageOrderOf,
  taskStageEntries,
} from './trace-presentation.js';

const COLLECTION_LABELS = ['external refs', 'runs', 'code changes', 'ship evidence', 'rework signals', 'artifacts'];

/** Retry only the pages that actually failed; the settled ones keep their data. */
function retryFailed(queries: ReadonlyArray<{ isError: boolean; refetch: () => unknown }>): void {
  for (const query of queries) if (query.isError) void query.refetch();
}

function Subcard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border-soft bg-surface-2 p-3">
      <h3 className="mb-2 text-[12px] uppercase tracking-[0.04em] text-ink-4">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A meta chip that links to its tracker item / PR when the contract carries a
 * URL, and stays an inert pill when it does not.
 */
function ExternalChip({ url, title, children }: { url: string | null; title?: string; children: ReactNode }) {
  if (url === null) {
    return (
      <Chip mono title={title}>
        {children}
      </Chip>
    );
  }
  return (
    <a
      href={url}
      title={title}
      target="_blank"
      rel="noreferrer"
      className="num inline-flex items-center font-mono text-[11.5px] text-brand-text underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  );
}

function LegendSwatch({
  color,
  round,
  label,
  mono,
}: {
  color: string;
  round?: boolean;
  label: string;
  mono?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={round ? 'size-2 rounded-full' : 'size-2.5 rounded-[3px]'}
        style={{ background: color }}
      />
      <span className={mono ? 'font-mono' : undefined}>{label}</span>
    </span>
  );
}

/**
 * Artifact chips with an on-demand checkpoint drilldown. The body is read only
 * for the expanded chip, so a trace never pulls every artifact's content just to
 * show that artifacts exist.
 */
function ArtifactChips({
  workspaceId,
  artifacts,
}: {
  workspaceId: string;
  artifacts: ReadonlyArray<CanonicalArtifactItem>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const revisionsQuery = useQuery(traceArtifactRevisionsQueryOptions(workspaceId, openId));
  const open = artifacts.find((artifact) => artifact.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {artifacts.map((artifact) => {
          const expanded = artifact.id === openId;
          return (
            <button
              key={artifact.id}
              type="button"
              aria-expanded={expanded}
              title={artifact.id}
              className="cursor-pointer rounded-full"
              onClick={() => setOpenId((current) => (current === artifact.id ? null : artifact.id))}
            >
              <Chip tone={expanded ? 'active' : 'default'}>
                {`${artifact.kind} · ${plural(artifact.revisionCount, 'revision')}`}
              </Chip>
            </button>
          );
        })}
      </div>
      {open === null ? null : (
        <Subcard title={`Checkpoint content · ${open.kind}`}>
          {revisionsQuery.isPending ? (
            <div className="flex items-center gap-2 text-[13px] text-ink-4">
              <Spinner /> Loading checkpoint content…
            </div>
          ) : null}
          {revisionsQuery.isError ? (
            <div className="flex items-center justify-between gap-2 text-[13px] text-ink-2">
              <span>Checkpoint content is unavailable.</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void revisionsQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : null}
          {revisionsQuery.data ? <ArtifactRevisionList detail={revisionsQuery.data} /> : null}
        </Subcard>
      )}
    </div>
  );
}

export function TaskTrace({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
  const detailQuery = useQuery(canonicalTaskDetailQueryOptions(workspaceId, taskId));

  const collections = useQueries({
    queries: [
      traceExternalRefsQueryOptions(workspaceId, taskId),
      traceRunsQueryOptions(workspaceId, taskId),
      traceCodeChangesQueryOptions(workspaceId, taskId),
      traceShipEvidenceQueryOptions(workspaceId, taskId),
      traceReworkSignalsQueryOptions(workspaceId, taskId),
      traceArtifactsQueryOptions(workspaceId, taskId),
    ],
  });
  const [refsQuery, runsQuery, codeChangesQuery, shipQuery, reworkQuery, artifactsQuery] = collections;

  const externalRefs = refsQuery?.data?.items ?? [];
  const runs = runsQuery?.data?.items ?? [];

  const stageQueries = useQueries({
    queries: runs.map((run) => traceRunStagesQueryOptions(workspaceId, taskId, run.runId)),
  });
  const historyQueries = useQueries({
    queries: externalRefs.map((ref) => traceRefHistoryQueryOptions(workspaceId, taskId, ref.id)),
  });

  if (detailQuery.isPending) {
    return (
      <div className="flex min-h-[160px] items-center justify-center">
        <Spinner className="size-5 text-ink-4" />
      </div>
    );
  }
  if (detailQuery.isError || detailQuery.data === undefined) {
    return (
      <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 text-center">
        <p className="text-[13px] text-ink-2">This task's detail is unavailable.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const detail = detailQuery.data;
  const runStages: Record<string, CanonicalStageOccurrenceItem[]> = {};
  runs.forEach((run, index) => {
    const page = stageQueries[index]?.data;
    if (page !== undefined) runStages[run.runId] = page.items;
  });
  const refHistory: Record<string, CanonicalExternalRefStateFactItem[]> = {};
  externalRefs.forEach((ref, index) => {
    const page = historyQueries[index]?.data;
    if (page !== undefined) refHistory[ref.id] = page.items;
  });

  const sources: TraceSources = {
    task: detail,
    externalRefs,
    refHistory,
    runs,
    runStages,
    codeChanges: codeChangesQuery?.data?.items ?? [],
    artifacts: artifactsQuery?.data?.items ?? [],
    shipEvidence: shipQuery?.data?.items ?? [],
    reworkSignals: reworkQuery?.data?.items ?? [],
  };

  const { lanes, start, end } = buildGanttLanes(sources);
  const stageOrder = stageOrderOf(lanes);
  const claimed = claimedByStage(Object.values(runStages).flat());
  const stages = taskStageEntries(detail, claimed, stageOrder);
  const events = journeyEvents(sources);

  const failed: Array<{ label: string; retry: () => void }> = collections.flatMap((query, index) =>
    query.isError ? [{ label: COLLECTION_LABELS[index] ?? 'facts', retry: () => void query.refetch() }] : [],
  );
  // The nested per-run/per-ref pages are part of the same trace: a failed one
  // must say so, not draw a bare lane that reads as "no stages recorded".
  if (stageQueries.some((query) => query.isError)) {
    failed.push({ label: 'run stages', retry: () => retryFailed(stageQueries) });
  }
  if (historyQueries.some((query) => query.isError)) {
    failed.push({ label: 'ref history', retry: () => retryFailed(historyQueries) });
  }
  const truncated = collections
    .map((query, index) => (query.data?.nextCursor ? COLLECTION_LABELS[index] : null))
    .filter((label): label is string => label !== undefined && label !== null);
  if (stageQueries.some((query) => query.data?.nextCursor)) truncated.push('run stages');
  if (historyQueries.some((query) => query.data?.nextCursor)) truncated.push('ref history');
  const loadingCollections = collections.some((query) => query.isPending);

  const authority = detail.authority;
  // The authority carries its own human key; only the deep link lives on the ref's row.
  const authorityRef =
    authority.kind === 'external_ref' ? (externalRefs.find((ref) => ref.id === authority.externalRefId) ?? null) : null;
  const authorityLabel =
    authority.kind === 'external_ref'
      ? `${authority.externalKey ?? authority.externalId} · ${authority.provider}`
      : 'coredoc-tracked';
  const authorityTitle =
    authority.kind === 'external_ref'
      ? "Lifecycle authority: this tracker issue drives the task's lifecycle state"
      : "Lifecycle authority: Coredoc workflow runs drive this task's lifecycle";

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-[15px] font-medium tracking-[-0.01em] text-ink-1">{detail.title ?? detail.id}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={lifecycleTone(detail.lifecycle)}>{detail.lifecycle}</Chip>
          <Chip mono title={detail.id}>
            {detail.id}
          </Chip>
          <ExternalChip url={authorityRef?.externalUrl ?? null} title={authorityTitle}>
            {authorityLabel}
          </ExternalChip>
          {detail.repositoryKey === null ? null : <Chip mono>{detail.repositoryKey}</Chip>}
          {sources.codeChanges.map((change) => (
            <ExternalChip key={change.id} url={change.externalUrl}>
              {`${change.number === null ? change.externalId : `PR #${change.number}`} · ${change.state}`}
            </ExternalChip>
          ))}
          {detail.shipState === 'partial' ? <Chip tone="partial">{partialShipLabel(detail)}</Chip> : null}
          {detail.counts.reworkSignals > 0 ? (
            <Chip tone="rework">{`${detail.counts.reworkSignals} rework`}</Chip>
          ) : null}
        </div>
        <p className="text-[12.5px] text-ink-3">{estimatedCostLine(detail.estimatedCost)}</p>
        <RetentionNotice retention={detail.fineEventRetention} />
      </header>

      {failed.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border-soft px-3 py-2">
          {failed.map((entry) => (
            <div key={entry.label} className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="text-ink-2">{`${entry.label}: unavailable`}</span>
              <Button type="button" variant="outline" size="sm" onClick={entry.retry}>
                Retry
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {lanes.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-ink-4">
          {loadingCollections ? 'Loading this task’s facts…' : 'No time-placeable facts are recorded for this task.'}
        </p>
      ) : (
        <GanttChart lanes={lanes} start={start} end={end} ariaLabel={`Trace for ${detail.title ?? detail.id}`} />
      )}

      <div className="flex flex-wrap items-center gap-3.5 text-[12px] text-ink-3">
        {stageOrder.map((stageId, index) => (
          <LegendSwatch key={stageId} color={stageColor(index)} label={stageId} mono />
        ))}
        <LegendSwatch color="var(--color-rework)" round label="re-entry / reopen marker" />
        <LegendSwatch color="var(--color-danger)" label="failed" />
        <LegendSwatch color={UNCLAIMED_COLOR} label="unclaimed gap" />
      </div>

      {truncated.length > 0 ? (
        <p className="text-[11.5px] text-ink-4">
          {`First page shown · older facts not loaded (${truncated.join(', ')})`}
        </p>
      ) : null}

      {sources.artifacts.length > 0 ? <ArtifactChips workspaceId={workspaceId} artifacts={sources.artifacts} /> : null}

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[1fr_1.2fr]">
        <Subcard title="Time by stage · this task">
          <StageBars entries={stages.entries} ariaLabel="Claimed time by stage for this task" />
          <p className="mt-2 text-[11.5px] text-ink-4">{stages.footnote}</p>
        </Subcard>
        <Subcard title="Journey · merged fact stream">
          <JourneyView events={events} />
        </Subcard>
      </div>
    </div>
  );
}
