export enum PushJobPhase {
  LoadingArtifacts = 'loading_artifacts',
  ValidatingArtifacts = 'validating_artifacts',
  ReconcilingSnapshot = 'reconciling_snapshot',
  ComputingDiff = 'computing_diff',
  WaitingForGraphWrite = 'waiting_for_graph_write',
  WritingNodes = 'writing_nodes',
  WritingEdges = 'writing_edges',
  WritingMetadata = 'writing_metadata',
  FinalizingManifest = 'finalizing_manifest',
  UpdatingControlPlane = 'updating_control_plane',
  Resolving = 'resolving',
  Completed = 'completed',
}

export enum ProgressUnit {
  Bytes = 'bytes',
  Nodes = 'nodes',
  Edges = 'edges',
  Updates = 'updates',
  Steps = 'steps',
}

export interface JobProgress {
  phase: PushJobPhase;
  completed: number | null;
  total: number | null;
  unit: ProgressUnit | null;
  updatedAt: string;
}

/** Runtime-only execution controls. Lease tokens never enter public job results. */
export interface PushExecutionContext {
  jobId: string;
  executionToken: string;
  leaseOwnerToken?: string;
  signal?: AbortSignal;
  abort?(reason: Error): void;
  report(phase: PushJobPhase, completed?: number | null, total?: number | null, unit?: ProgressUnit | null): void;
}
