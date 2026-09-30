/**
 * Keeping a summary artifact byte-identical when the summaries themselves did not change.
 *
 * The server stores summaries content-addressed: the version is a sha256 over the uploaded
 * bytes (`sum_<hash>`, apps/server result-storage.service.ts), and push short-circuits the
 * metadata merge when the incoming `summaryVersion` matches the stored snapshot.
 *
 * That dedup never fired. `generatedAt` and `stats` describe the RUN, not the code, so a push
 * that re-summarized nothing still produced a payload differing from the previous one — same
 * size (an ISO timestamp is fixed width), different hash. Every push therefore re-uploaded the
 * whole artifact and accreted another R2 object: on coredoc-parser, 7.4 MB per push for a run
 * reporting "0 new, 4471 cached". It also kept `snapshotMatches` (push.service.ts) from ever
 * recognising a genuine no-op push, since `summaryVersion` differed every time.
 *
 * What this does NOT fix: the per-node metadata writes during a push. `buildMetadataUpdates`
 * selects nodes by "has a summary", not by whether `summaryVersion` changed, so a push whose
 * PARSE changed still rewrites every summarized node's metadata. Suppressing that needs a
 * server-side guard keyed on the stored snapshot's `summaryVersion`.
 *
 * So when the content-bearing fields match, hand back the PREVIOUS artifact untouched —
 * including its `generatedAt` and `stats`. Its bytes hash to the version already stored,
 * and the existing equality checks do the rest. Run statistics are still reported on stdout;
 * they just stop being baked into a content-addressed artifact.
 */

import type { SummaryOutput } from '@coredoc/core';

/**
 * The parts of the artifact that describe the CODE rather than the run that produced it.
 *
 * `generatedAt` and `stats` are deliberately excluded — they are the volatile pair. Every
 * other field is included, so a genuine change (a re-summarized function, a dropped orphan,
 * a new repository or package summary, a summarizer-version bump) still yields a new
 * artifact. Nested `generatedAt` values inside `packageSummaries` stay in the comparison:
 * they only move when those summaries are actually regenerated.
 */
function contentFingerprint(output: SummaryOutput): string {
  return JSON.stringify({
    repoId: output.repoId,
    repoName: output.repoName,
    summarizerVersion: output.summarizerVersion,
    summaries: output.summaries,
    repositorySummary: output.repositorySummary ?? null,
    packageSummaries: output.packageSummaries ?? null,
  });
}

/**
 * Return `previous` when it carries exactly the same summary content as `next`, so the
 * artifact keeps its identity across no-op runs. Returns `next` whenever anything about the
 * content differs, or when there is no previous artifact to reuse.
 */
export function reusePreviousIfUnchanged(
  next: SummaryOutput,
  previous: SummaryOutput | null | undefined,
): SummaryOutput {
  if (!previous) return next;
  return contentFingerprint(next) === contentFingerprint(previous) ? previous : next;
}
