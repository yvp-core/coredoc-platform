import type { AppliedGraphSnapshot } from './types.js';

/**
 * Parse a stored graph_meta / :CoredocMeta snapshot blob. The value comes from
 * the per-workspace data plane, so it is untrusted for control-plane decisions:
 * a corrupted or hand-edited row must degrade to "no snapshot" (the caller's
 * fail-closed legacy path) instead of wedging every push with a SyntaxError or
 * a type-confused resume.
 */
export function parseAppliedGraphSnapshot(raw: string, repoId: string): AppliedGraphSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[coredoc/db] ignoring unparseable graph snapshot for ${repoId}`);
    return null;
  }
  const snapshot = parsed as Partial<AppliedGraphSnapshot> | null;
  const receipt = snapshot?.receipt as Partial<AppliedGraphSnapshot['receipt']> | null | undefined;
  const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
  const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    typeof snapshot.parsedVersion !== 'string' ||
    typeof snapshot.executionToken !== 'string' ||
    !['full', 'incremental', 'metadata'].includes(String(snapshot.mode)) ||
    typeof snapshot.appliedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.appliedAt)) ||
    !isNullableString(snapshot.summaryVersion) ||
    !isNullableString(snapshot.embeddingsVersion) ||
    !isNullableString(snapshot.commitSha) ||
    !isCount(snapshot.nodeCount) ||
    !isCount(snapshot.edgeCount) ||
    !receipt ||
    !isCount(receipt.nodesAdded) ||
    !isCount(receipt.nodesUpdated) ||
    !isCount(receipt.nodesDeleted) ||
    !isCount(receipt.edgesDeleted) ||
    !isCount(receipt.edgesInserted)
  ) {
    console.warn(`[coredoc/db] ignoring malformed graph snapshot for ${repoId}`);
    return null;
  }
  return snapshot as AppliedGraphSnapshot;
}
