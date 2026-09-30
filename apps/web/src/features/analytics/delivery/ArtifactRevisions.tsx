/**
 * Checkpoint revisions for one artifact in the task trace. The body is
 * untrusted Markdown authored by a workflow run, so it is rendered as plain
 * preformatted text — no Markdown/HTML pipeline, no links, no remote images.
 */

import type { CanonicalArtifactRevisionsResponse } from '../types.js';
import { Chip } from './Chip.js';

/** UTC, like the gantt axis and the journey stream beside it. */
function stampUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function ArtifactRevisionList({ detail }: { detail: CanonicalArtifactRevisionsResponse }) {
  if (detail.revisions.length === 0) {
    return <p className="text-[12px] text-ink-4">No checkpoint revisions are recorded for this artifact.</p>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {detail.revisions.map((revision) => (
        <div key={revision.id} className="rounded-lg border border-border-soft bg-surface px-3 py-2.5">
          <div className="num mb-2 flex flex-wrap items-center gap-2 text-[10.5px] text-ink-4">
            <Chip mono>{revision.checkpoint}</Chip>
            <span>{stampUtc(revision.createdAt)}</span>
            {/* Exact bytes, grouped: a compacted "1k" is the wrong claim for a checkpoint size. */}
            <span>{`${revision.byteCount.toLocaleString('en-US')} bytes`}</span>
            <span className="font-mono">{`run ${revision.runId ?? '—'}`}</span>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11.5px] leading-[1.5] text-ink-2">
            {revision.markdown}
          </pre>
        </div>
      ))}
    </div>
  );
}
