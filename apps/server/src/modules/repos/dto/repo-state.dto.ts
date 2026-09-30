export interface RepoStateResponse {
  repoKey: string;
  repoName: string;
  lastParseHash: string | null;
  lastPushedAt: string | null;
  lastPushedByUserId: string | null;
  nodeCount: number | null;
  edgeCount: number | null;
  /** Versions applied to the currently served graph, not merely uploaded to R2. */
  currentSummaryVersion: string | null;
  currentEmbeddingsVersion: string | null;
  summaryUploadedAt: string | null;
}
