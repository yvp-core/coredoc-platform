export const OFFLINE_FTS_NEEDLE = 'OfflineFtsNeedle';
export const OFFLINE_FTS_REPO_ID = '0123456789ab';

/** Real FTS proof through the repository owned by openGraphFile. */
export async function queryOfflineFts(repository) {
  if (typeof repository.queryFtsIndex !== 'function') {
    throw new Error('Opened Ladybug repository does not expose its FTS read capability');
  }
  return repository.queryFtsIndex(OFFLINE_FTS_NEEDLE, [OFFLINE_FTS_REPO_ID], 5);
}
