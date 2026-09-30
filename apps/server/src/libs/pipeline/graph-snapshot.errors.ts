export type GraphSnapshotErrorCode =
  | 'artifact_identity_conflict'
  | 'artifact_tenant_mismatch'
  | 'artifact_integrity_error'
  | 'graph_storage_timeout'
  | 'graph_storage_unavailable'
  | 'graph_build_failed'
  | 'graph_artifact_too_large'
  | 'graph_object_identity_conflict'
  | 'graph_pointer_timeout'
  | 'graph_parent_conflict'
  | 'graph_backend_conflict'
  | 'graph_resolution_inputs_changed'
  | 'graph_job_in_progress'
  | 'file_snapshot_requires_worker'
  | 'job_still_running';

export interface GraphSnapshotErrorPolicy {
  retryable: boolean;
  statusCode: number;
}

export const GRAPH_SNAPSHOT_ERROR_POLICY: Readonly<Record<GraphSnapshotErrorCode, GraphSnapshotErrorPolicy>> = {
  artifact_identity_conflict: { retryable: false, statusCode: 409 },
  artifact_tenant_mismatch: { retryable: false, statusCode: 400 },
  artifact_integrity_error: { retryable: false, statusCode: 422 },
  graph_storage_timeout: { retryable: true, statusCode: 504 },
  graph_storage_unavailable: { retryable: true, statusCode: 503 },
  graph_build_failed: { retryable: false, statusCode: 422 },
  graph_artifact_too_large: { retryable: false, statusCode: 413 },
  graph_object_identity_conflict: { retryable: false, statusCode: 409 },
  graph_pointer_timeout: { retryable: true, statusCode: 504 },
  graph_parent_conflict: { retryable: true, statusCode: 409 },
  graph_backend_conflict: { retryable: false, statusCode: 409 },
  graph_resolution_inputs_changed: { retryable: true, statusCode: 503 },
  graph_job_in_progress: { retryable: false, statusCode: 409 },
  file_snapshot_requires_worker: { retryable: false, statusCode: 409 },
  job_still_running: { retryable: false, statusCode: 504 },
};

export interface GraphSnapshotErrorShape {
  code: GraphSnapshotErrorCode;
  retryable: boolean;
  statusCode: number;
  message: string;
}

export class GraphSnapshotError extends Error implements GraphSnapshotErrorShape {
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    readonly code: GraphSnapshotErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GraphSnapshotError';
    const policy = GRAPH_SNAPSHOT_ERROR_POLICY[code];
    this.retryable = policy.retryable;
    this.statusCode = policy.statusCode;
  }
}

export function isGraphSnapshotError(value: unknown): value is GraphSnapshotErrorShape {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GraphSnapshotErrorShape>;
  return (
    typeof candidate.code === 'string' &&
    Object.hasOwn(GRAPH_SNAPSHOT_ERROR_POLICY, candidate.code) &&
    typeof candidate.retryable === 'boolean' &&
    typeof candidate.statusCode === 'number' &&
    typeof candidate.message === 'string'
  );
}
