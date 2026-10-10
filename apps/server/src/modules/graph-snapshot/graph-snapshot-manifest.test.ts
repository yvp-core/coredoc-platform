import { describe, expect, it } from 'vitest';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';
import {
  canonicalizeGraphSnapshotManifest,
  canonicalizeJson,
  createGraphSnapshotIdentity,
  graphSnapshotR2Key,
} from './graph-snapshot-manifest.js';
import type {
  GraphSnapshotManifestV1,
  GraphSnapshotRepositoryManifest,
  WorkspaceRepoArtifactDescriptor,
  WorkspaceRepoArtifactKind,
} from '../../libs/pipeline/graph-snapshot.types.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

function artifact(
  repoKey: string,
  repoName: string,
  kind: WorkspaceRepoArtifactKind,
  seed: string,
): WorkspaceRepoArtifactDescriptor {
  const directory = kind === 'parsed' ? 'parsed' : kind === 'summary' ? 'summaries' : 'embeddings';
  const version = kind === 'parsed' ? seed.repeat(16) : `${kind === 'summary' ? 'sum' : 'emb'}_${seed.repeat(16)}`;
  return {
    workspaceId: WORKSPACE_ID,
    repoKey,
    repoName,
    kind,
    version,
    r2Key: `${WORKSPACE_ID}/${repoName}/results/${directory}/${version}.json`,
    sha256: seed.repeat(64),
    sizeBytes: '42',
  };
}

function repository(repoKey: string, repoName: string, seed: string): GraphSnapshotRepositoryManifest {
  return {
    repoKey,
    repoName,
    repoType: 'service',
    httpPrefix: `/${repoName}`,
    commitSha: seed.repeat(40),
    parsed: artifact(repoKey, repoName, 'parsed', seed),
    summary: artifact(repoKey, repoName, 'summary', seed),
    embeddings: artifact(repoKey, repoName, 'embeddings', seed),
  };
}

function manifest(): GraphSnapshotManifestV1 {
  return {
    manifestVersion: 1,
    workspaceId: WORKSPACE_ID,
    parentVersionId: null,
    engine: 'ladybug',
    engineVersion: '0.12.0',
    graphSchemaVersion: 9,
    builderVersion: 'phase2-v1',
    storageFormatVersion: 2,
    sourcePolicy: 'strip',
    repositories: [repository('repo-b', 'billing', 'b'), repository('repo-a', 'api', 'a')],
    mapper: {
      r2Key: `${WORKSPACE_ID}/mapper/mapper-${'c'.repeat(64)}.yaml`,
      sha256: 'c'.repeat(64),
      sizeBytes: '21',
    },
  };
}

describe('graph snapshot manifest identity', () => {
  it('is independent of object-key insertion order while one descriptor byte changes the version', () => {
    const original = manifest();
    const reverseInserted = JSON.parse(
      JSON.stringify(original, (_key, value) => {
        if (!value || Array.isArray(value) || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).reverse());
      }),
    ) as GraphSnapshotManifestV1;

    const first = createGraphSnapshotIdentity(original);
    const reordered = createGraphSnapshotIdentity(reverseInserted);
    expect(reordered.canonicalJson).toBe(first.canonicalJson);
    expect(reordered.versionId).toBe(first.versionId);

    const changed = structuredClone(original);
    changed.repositories[0].parsed.sha256 = `${'b'.repeat(63)}a`;
    expect(createGraphSnapshotIdentity(changed).versionId).not.toBe(first.versionId);
  });

  it('sorts repositories by repoKey then repoName without mutating the caller', () => {
    const input = manifest();
    const result = canonicalizeGraphSnapshotManifest(input);

    expect(result.repositories.map(({ repoKey }) => repoKey)).toEqual(['repo-a', 'repo-b']);
    expect(input.repositories.map(({ repoKey }) => repoKey)).toEqual(['repo-b', 'repo-a']);
  });

  it('uses recursive lexicographic object-key ordering and preserves array order', () => {
    expect(canonicalizeJson({ z: [{ b: 2, a: 1 }, 3], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2},3]}');
  });

  it('rejects unsafe tenant prefixes and traversal before a caller can access storage', () => {
    const wrongTenant = manifest();
    wrongTenant.repositories[0].parsed.r2Key = '22222222-2222-4222-8222-222222222222/api/result.json';
    expect(() => createGraphSnapshotIdentity(wrongTenant)).toThrowError(
      expect.objectContaining<Partial<GraphSnapshotError>>({ code: 'artifact_tenant_mismatch', retryable: false }),
    );

    const traversal = manifest();
    traversal.mapper = {
      r2Key: `${WORKSPACE_ID}/mapper/../other-workspace/mapper.yaml`,
      sha256: 'd'.repeat(64),
      sizeBytes: '12',
    };
    expect(() => createGraphSnapshotIdentity(traversal)).toThrowError(
      expect.objectContaining<Partial<GraphSnapshotError>>({ code: 'artifact_tenant_mismatch' }),
    );
  });

  it('builds the one canonical graph-object key and rejects unsafe workspace identities', () => {
    const versionId = 'f'.repeat(64);
    expect(graphSnapshotR2Key(WORKSPACE_ID, versionId)).toBe(`${WORKSPACE_ID}/graphs/${versionId}.ladybug`);
    expect(() => graphSnapshotR2Key('../other', versionId)).toThrowError(
      expect.objectContaining<Partial<GraphSnapshotError>>({ code: 'artifact_tenant_mismatch' }),
    );
  });
});
