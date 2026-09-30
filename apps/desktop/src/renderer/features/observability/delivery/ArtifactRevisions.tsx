/**
 * Checkpoint revisions for one artifact in the task trace (UC-4). Its own module
 * because the body is untrusted Markdown: keeping the render path small and
 * separately exercisable is what makes the safety property (no raw HTML, no
 * remote image, no link element) checkable without driving the whole trace.
 */

import type { CanonicalArtifactRevisionsResponse } from '../../../../shared/ipc-types.js';
import { SafeArtifactMarkdown } from '../SafeArtifactMarkdown';
import { Chip } from './Chip';

/** UTC, like the gantt axis and the journey stream beside it. */
function stampUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function ArtifactRevisionList({ detail }: { detail: CanonicalArtifactRevisionsResponse }) {
  if (detail.revisions.length === 0) {
    return <p className="text-xs text-content-quaternary">No checkpoint revisions are recorded for this artifact.</p>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {detail.revisions.map((revision) => (
        <div key={revision.id} className="rounded-lg border border-border-input bg-card px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[10.5px] text-content-quaternary">
            <Chip mono>{revision.checkpoint}</Chip>
            <span className="tabular-nums">{stampUtc(revision.createdAt)}</span>
            {/* Exact bytes, grouped: `formatNumber` compacts to "1k", which is the wrong
                claim for a checkpoint size. `en-US` keeps the grouping host-independent. */}
            <span className="tabular-nums">{`${revision.byteCount.toLocaleString('en-US')} bytes`}</span>
            <span className="font-mono">{`run ${revision.runId ?? '—'}`}</span>
          </div>
          {/* Checkpoint Markdown is untrusted content: the safe renderer, never the general one. */}
          <SafeArtifactMarkdown content={revision.markdown} />
        </div>
      ))}
    </div>
  );
}
