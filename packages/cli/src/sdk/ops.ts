/**
 * SDK Ops — in-process operation timestamp queries.
 *
 * readOpsTimestamps throws on database failure; getOpsTimestamps is the
 * never-throws wrapper (10s race, null on failure) for polling hosts.
 */

export interface OpsGitRevision {
  commitHash: string;
  commitShortHash: string;
  branch: string;
  isDirty: boolean;
}

export interface OpsTimestamps {
  lastGenerated?: string;
  lastParsed?: string;
  lastSummarized?: string;
  lastPushed?: string;
  lastDocs?: string;
  parsedRevision?: OpsGitRevision;
}

/**
 * Query operation timestamps for a repository.
 *
 * @param projectId - Project ID
 * @param repoName - Repository name
 * @param configDir - Directory containing coredoc.config.json. The database
 *   path is derived from this and projectId; callers cannot supply a mismatched
 *   URL.
 * @returns Timestamps or null if unavailable
 */
export async function readOpsTimestamps(
  projectId: string,
  repoName: string,
  configDir: string,
): Promise<OpsTimestamps | null> {
  if (!repoName) return null;

  // Reuse the process-lifetime singleton drivers. Closing them per-call
  // races against any concurrent caller sharing the same SqliteDriver:
  // the close nulls `client`, and the other in-flight query throws and
  // gets swallowed by getOpsTimestamps — surfacing as `operations: undefined`
  // in getRepoDetailState. Callers (the desktop main process, the `ops`
  // command) are responsible for shutdown.
  const { openProjectDatabase } = await import('@coredoc/db');
  const database = await openProjectDatabase(configDir, projectId, { mode: 'read' });
  const summary = await database.operations.getOperationSummary(projectId, repoName);
  const toISO = (epoch?: number) => (epoch ? new Date(epoch).toISOString() : undefined);
  const parseMeta = summary.lastParsed?.metadata as Record<string, unknown> | undefined;

  return {
    lastGenerated: toISO(summary.lastGenerated?.completedAt),
    lastParsed: toISO(summary.lastParsed?.completedAt),
    lastSummarized: toISO(summary.lastSummarized?.completedAt),
    lastPushed: toISO(summary.lastPushed?.completedAt),
    lastDocs: toISO(summary.lastDocs?.completedAt),
    parsedRevision: parseMeta?.gitCommitHash
      ? {
          commitHash: parseMeta.gitCommitHash as string,
          commitShortHash: parseMeta.gitCommitShortHash as string,
          branch: parseMeta.gitBranch as string,
          isDirty: parseMeta.gitIsDirty as boolean,
        }
      : undefined,
  };
}

/**
 * Never-throws wrapper for polling hosts (the desktop status poll): the 10s
 * race plus null on any error. Surfaces that must fail loud (`coredoc ops`)
 * call {@link readOpsTimestamps} directly.
 */
export async function getOpsTimestamps(
  projectId: string,
  repoName: string,
  configDir: string,
): Promise<OpsTimestamps | null> {
  const work = async (): Promise<OpsTimestamps | null> => {
    try {
      return await readOpsTimestamps(projectId, repoName, configDir);
    } catch {
      return null;
    }
  };

  // Non-intrusive: timeout after 10s, return null on failure. The handle is
  // cleared once the race settles, or a short CLI run would idle until the
  // timer fires (`coredoc ops` exited ~10s late).
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    handle = setTimeout(() => resolve(null), 10_000);
    handle.unref?.();
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}
