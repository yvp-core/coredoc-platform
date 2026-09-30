/**
 * First-page reads behind the task trace (UC-4, LIM-8). The trace composes the
 * existing bounded per-collection routes instead of a server trace route
 * (ADR-8), and each collection is read exactly once at the page maximum: these
 * are plain `queryOptions`, not the infinite variants in `../observability-api`,
 * because there is no "load more" on the trace — a truncated page is captioned
 * instead (BR-12).
 */

import { queryOptions } from '@tanstack/react-query';
import type {
  CanonicalArtifactItem,
  CanonicalArtifactRevisionsResponse,
  CanonicalCodeChangeItem,
  CanonicalCursorPage,
  CanonicalExternalRefItem,
  CanonicalExternalRefStateFactItem,
  CanonicalReworkSignalItem,
  CanonicalRunItem,
  CanonicalShipEvidenceItem,
  CanonicalStageOccurrenceItem,
} from '../../../../shared/ipc-types.js';
import { CANONICAL_PAGE_SIZE } from '../observability-api';

/**
 * Local copy of the envelope unwrap: `../observability-api` keeps its own
 * private one, and exporting it only to share four lines would widen that
 * module's surface for no caller outside this file.
 */
async function unwrap<T>(p: Promise<{ success: boolean; data?: T; error?: string }>): Promise<T> {
  const res = await p;
  if (!res.success || res.data === undefined) throw new Error(res.error ?? 'Observability query failed');
  return res.data;
}

const STALE_TIME = 60_000;

export const traceExternalRefsQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'external-refs', workspaceId, taskId] as const,
    queryFn: () =>
      unwrap<CanonicalCursorPage<CanonicalExternalRefItem>>(
        window.electronAPI.getCanonicalTaskExternalRefs(workspaceId, taskId, CANONICAL_PAGE_SIZE),
      ),
    staleTime: STALE_TIME,
  });

export const traceRunsQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'runs', workspaceId, taskId] as const,
    queryFn: () =>
      unwrap<CanonicalCursorPage<CanonicalRunItem>>(
        window.electronAPI.getCanonicalTaskRuns(workspaceId, taskId, CANONICAL_PAGE_SIZE),
      ),
    staleTime: STALE_TIME,
  });

export const traceCodeChangesQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'code-changes', workspaceId, taskId] as const,
    queryFn: () =>
      unwrap<CanonicalCursorPage<CanonicalCodeChangeItem>>(
        window.electronAPI.getCanonicalTaskCodeChanges(workspaceId, taskId, CANONICAL_PAGE_SIZE),
      ),
    staleTime: STALE_TIME,
  });

export const traceShipEvidenceQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'ship-evidence', workspaceId, taskId] as const,
    queryFn: () =>
      unwrap<CanonicalCursorPage<CanonicalShipEvidenceItem>>(
        window.electronAPI.getCanonicalTaskShipEvidence(workspaceId, taskId, CANONICAL_PAGE_SIZE),
      ),
    staleTime: STALE_TIME,
  });

export const traceReworkSignalsQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'rework-signals', workspaceId, taskId] as const,
    queryFn: () =>
      unwrap<CanonicalCursorPage<CanonicalReworkSignalItem>>(
        window.electronAPI.getCanonicalTaskReworkSignals(workspaceId, taskId, CANONICAL_PAGE_SIZE),
      ),
    staleTime: STALE_TIME,
  });

export const traceArtifactsQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'artifacts', workspaceId, taskId] as const,
    queryFn: () =>
      unwrap<CanonicalCursorPage<CanonicalArtifactItem>>(
        window.electronAPI.getCanonicalTaskArtifacts(workspaceId, taskId, CANONICAL_PAGE_SIZE),
      ),
    staleTime: STALE_TIME,
  });

/** Nested read, one per run on the runs first page (BR-12). */
export const traceRunStagesQueryOptions = (workspaceId: string, taskId: string, runId: string) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'run-stages', workspaceId, taskId, runId] as const,
    queryFn: () =>
      unwrap<CanonicalCursorPage<CanonicalStageOccurrenceItem>>(
        window.electronAPI.getCanonicalRunStageOccurrences(workspaceId, taskId, runId, CANONICAL_PAGE_SIZE),
      ),
    staleTime: STALE_TIME,
  });

/** Nested read, one per external ref on the refs first page (BR-12). */
export const traceRefHistoryQueryOptions = (workspaceId: string, taskId: string, externalRefId: string) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'ref-history', workspaceId, taskId, externalRefId] as const,
    queryFn: () =>
      unwrap<CanonicalCursorPage<CanonicalExternalRefStateFactItem>>(
        window.electronAPI.getCanonicalExternalRefStateHistory(workspaceId, taskId, externalRefId, CANONICAL_PAGE_SIZE),
      ),
    staleTime: STALE_TIME,
  });

/**
 * Checkpoint Markdown for one artifact (UC-4). Artifact bodies are untrusted and
 * far heavier than the trace's other reads, so this one is demand-only: it stays
 * disabled until a chip is expanded, and `artifactId` is the open chip's id.
 */
export const traceArtifactRevisionsQueryOptions = (workspaceId: string, artifactId: string | null) =>
  queryOptions({
    queryKey: ['observability', 'trace', 'artifact-revisions', workspaceId, artifactId] as const,
    queryFn: () => {
      if (artifactId === null) throw new Error('No artifact selected');
      return unwrap<CanonicalArtifactRevisionsResponse>(
        window.electronAPI.getCanonicalArtifactRevisions(workspaceId, artifactId),
      );
    },
    enabled: artifactId !== null,
    staleTime: STALE_TIME,
  });
