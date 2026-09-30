/**
 * Mirrors `RepoStateResponse` in
 * apps/server/src/modules/repos/dto/repo-state.dto.ts, served by
 * `GET /api/v1/workspaces/:id/repos/:repoName/state`. Versions here are the
 * ones applied to the currently *served* graph, not merely uploaded to R2 —
 * which is why the repos table reads them from this endpoint rather than from
 * the control-plane `WorkspaceRepo.lastSummaryVersion` column.
 */
export interface RepoStateResponse {
  repoKey: string;
  repoName: string;
  lastParseHash: string | null;
  lastPushedAt: string | null;
  lastPushedByUserId: string | null;
  nodeCount: number | null;
  edgeCount: number | null;
  currentSummaryVersion: string | null;
  currentEmbeddingsVersion: string | null;
  summaryUploadedAt: string | null;
}
