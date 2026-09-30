export type WorkspaceRepoArtifactKind = 'parsed' | 'summary' | 'embeddings';

export interface WorkspaceRepoArtifactDescriptor {
  workspaceId: string;
  repoKey: string;
  repoName: string;
  kind: WorkspaceRepoArtifactKind;
  version: string;
  r2Key: string;
  sha256: string;
  sizeBytes: string;
}

export interface GraphSnapshotRepositoryManifest {
  repoKey: string;
  repoName: string;
  repoType: string | null;
  httpPrefix: string | null;
  commitSha: string | null;
  parsed: WorkspaceRepoArtifactDescriptor;
  summary: WorkspaceRepoArtifactDescriptor | null;
  embeddings: WorkspaceRepoArtifactDescriptor | null;
}

export interface GraphSnapshotMapperDescriptor {
  r2Key: string;
  sha256: string;
  sizeBytes: string;
}

export interface GraphSnapshotManifestV1 {
  manifestVersion: 1;
  workspaceId: string;
  parentVersionId: string | null;
  engine: 'ladybug';
  engineVersion: string;
  graphSchemaVersion: number;
  builderVersion: string;
  storageFormatVersion: number;
  sourcePolicy: 'strip';
  repositories: GraphSnapshotRepositoryManifest[];
  mapper: GraphSnapshotMapperDescriptor | null;
}

export interface GraphSnapshotIdentity {
  manifest: GraphSnapshotManifestV1;
  canonicalJson: string;
  versionId: string;
}
