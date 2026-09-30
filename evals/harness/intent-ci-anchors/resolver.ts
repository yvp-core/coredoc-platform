import type { ParsedRepo, ParsedRepoGraphSnapshot } from '@coredoc/core';
import { transformParsedRepo } from '@coredoc/db';
export { resolveAnchorEnvelope, type EnvelopeResolution } from '@coredoc/core';

export function parsedRepoSnapshot(
  parsed: ParsedRepo,
  repoKey: string,
  graphVersionId: string,
): ParsedRepoGraphSnapshot {
  const nodes = transformParsedRepo(parsed).nodes;
  const repoHash = parsed.files[0]?.id.split(':', 1)[0] ?? parsed.id.split(':', 1)[0] ?? '';
  return {
    graphVersionId,
    commit: parsed.git?.commitHash ?? null,
    repoKey,
    repoHash,
    nodes,
  };
}

