import { createHash } from 'node:crypto';
import { GRAPH_FILE_FORMAT_COMPATIBILITY } from '@coredoc/db';
import { GraphSnapshotError } from './graph-snapshot.errors.js';
import type {
  GraphSnapshotIdentity,
  GraphSnapshotManifestV1,
  GraphSnapshotMapperDescriptor,
  GraphSnapshotRepositoryManifest,
  WorkspaceRepoArtifactDescriptor,
  WorkspaceRepoArtifactKind,
} from './graph-snapshot.types.js';

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_REPO_NAME = /^[a-zA-Z0-9._-]+$/;
const VERSION_PATTERNS: Readonly<Record<WorkspaceRepoArtifactKind, RegExp>> = {
  parsed: /^[0-9a-f]{16}$/,
  summary: /^sum_[0-9a-f]{16}$/,
  embeddings: /^emb_[0-9a-f]{16}$/,
};

const MANIFEST_KEYS = [
  'manifestVersion',
  'workspaceId',
  'parentVersionId',
  'engine',
  'engineVersion',
  'graphSchemaVersion',
  'builderVersion',
  'storageFormatVersion',
  'sourcePolicy',
  'repositories',
  'mapper',
] as const;
const REPOSITORY_KEYS = [
  'repoKey',
  'repoName',
  'repoType',
  'httpPrefix',
  'commitSha',
  'parsed',
  'summary',
  'embeddings',
] as const;
const ARTIFACT_KEYS = [
  'workspaceId',
  'repoKey',
  'repoName',
  'kind',
  'version',
  'r2Key',
  'sha256',
  'sizeBytes',
] as const;
const MAPPER_KEYS = ['r2Key', 'sha256', 'sizeBytes'] as const;

function invalid(message: string): never {
  throw new GraphSnapshotError('artifact_identity_conflict', message);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${label} must be a plain object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${label} has unknown or missing fields`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a non-empty string`);
}

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertNonEmptyString(value, label);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${label} must be a positive safe integer`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !LOWER_SHA256.test(value)) {
    invalid(`${label} must be a lowercase SHA-256`);
  }
}

function assertSize(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL.test(value)) {
    invalid(`${label} must be a positive canonical decimal string`);
  }
}

function compareCanonicalString(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertWorkspaceId(workspaceId: unknown): asserts workspaceId is string {
  if (typeof workspaceId !== 'string' || !SAFE_WORKSPACE_ID.test(workspaceId)) {
    throw new GraphSnapshotError('artifact_tenant_mismatch', 'Workspace identity is not safe for object storage');
  }
}

export function assertWorkspaceScopedR2Key(workspaceId: string, r2Key: string): void {
  assertWorkspaceId(workspaceId);
  if (typeof r2Key !== 'string' || !r2Key.startsWith(`${workspaceId}/`)) {
    throw new GraphSnapshotError('artifact_tenant_mismatch', 'Artifact key is outside the workspace prefix');
  }

  const segments = r2Key.split('/');
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\'))
  ) {
    throw new GraphSnapshotError('artifact_tenant_mismatch', 'Artifact key contains an unsafe path segment');
  }
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new GraphSnapshotError('artifact_tenant_mismatch', 'Artifact key contains invalid encoding');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new GraphSnapshotError('artifact_tenant_mismatch', 'Artifact key contains encoded path traversal');
    }
  }
}

export function graphSnapshotR2Key(workspaceId: string, versionId: string): string {
  assertWorkspaceId(workspaceId);
  assertDigest(versionId, 'versionId');
  return `${workspaceId}/graphs/${versionId}.ladybug`;
}

function validateArtifact(
  value: unknown,
  workspaceId: string,
  repository: Pick<GraphSnapshotRepositoryManifest, 'repoKey' | 'repoName'>,
  expectedKind: WorkspaceRepoArtifactKind,
  label: string,
): WorkspaceRepoArtifactDescriptor {
  assertPlainObject(value, label);
  assertExactKeys(value, ARTIFACT_KEYS, label);
  assertNonEmptyString(value.workspaceId, `${label}.workspaceId`);
  assertNonEmptyString(value.repoKey, `${label}.repoKey`);
  assertNonEmptyString(value.repoName, `${label}.repoName`);
  assertNonEmptyString(value.kind, `${label}.kind`);
  assertNonEmptyString(value.version, `${label}.version`);
  assertNonEmptyString(value.r2Key, `${label}.r2Key`);
  assertDigest(value.sha256, `${label}.sha256`);
  assertSize(value.sizeBytes, `${label}.sizeBytes`);

  if (
    value.workspaceId !== workspaceId ||
    value.repoKey !== repository.repoKey ||
    value.repoName !== repository.repoName
  ) {
    invalid(`${label} does not match its workspace repository identity`);
  }
  if (value.kind !== expectedKind || !VERSION_PATTERNS[expectedKind].test(value.version)) {
    invalid(`${label} has an invalid kind or opaque route version`);
  }
  assertWorkspaceScopedR2Key(workspaceId, value.r2Key);
  return {
    workspaceId: value.workspaceId,
    repoKey: value.repoKey,
    repoName: value.repoName,
    kind: expectedKind,
    version: value.version,
    r2Key: value.r2Key,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
  };
}

function validateMapper(value: unknown, workspaceId: string): GraphSnapshotMapperDescriptor | null {
  if (value === null) return null;
  assertPlainObject(value, 'manifest.mapper');
  assertExactKeys(value, MAPPER_KEYS, 'manifest.mapper');
  assertNonEmptyString(value.r2Key, 'manifest.mapper.r2Key');
  assertDigest(value.sha256, 'manifest.mapper.sha256');
  assertSize(value.sizeBytes, 'manifest.mapper.sizeBytes');
  assertWorkspaceScopedR2Key(workspaceId, value.r2Key);
  return {
    r2Key: value.r2Key,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
  };
}

function validateRepository(value: unknown, workspaceId: string, index: number): GraphSnapshotRepositoryManifest {
  const label = `manifest.repositories[${index}]`;
  assertPlainObject(value, label);
  assertExactKeys(value, REPOSITORY_KEYS, label);
  assertNonEmptyString(value.repoKey, `${label}.repoKey`);
  assertNonEmptyString(value.repoName, `${label}.repoName`);
  if (!SAFE_REPO_NAME.test(value.repoName)) invalid(`${label}.repoName is not safe for object storage`);
  assertNullableString(value.repoType, `${label}.repoType`);
  assertNullableString(value.httpPrefix, `${label}.httpPrefix`);
  assertNullableString(value.commitSha, `${label}.commitSha`);

  const identity = { repoKey: value.repoKey, repoName: value.repoName };
  return {
    repoKey: value.repoKey,
    repoName: value.repoName,
    repoType: value.repoType,
    httpPrefix: value.httpPrefix,
    commitSha: value.commitSha,
    parsed: validateArtifact(value.parsed, workspaceId, identity, 'parsed', `${label}.parsed`),
    summary:
      value.summary === null
        ? null
        : validateArtifact(value.summary, workspaceId, identity, 'summary', `${label}.summary`),
    embeddings:
      value.embeddings === null
        ? null
        : validateArtifact(value.embeddings, workspaceId, identity, 'embeddings', `${label}.embeddings`),
  };
}

export function canonicalizeGraphSnapshotManifest(input: unknown): GraphSnapshotManifestV1 {
  assertPlainObject(input, 'manifest');
  assertExactKeys(input, MANIFEST_KEYS, 'manifest');
  if (input.manifestVersion !== 1) invalid('manifest.manifestVersion must be 1');
  const workspaceId = input.workspaceId;
  assertWorkspaceId(workspaceId);
  if (input.parentVersionId !== null) assertDigest(input.parentVersionId, 'manifest.parentVersionId');
  if (input.engine !== 'ladybug') invalid('manifest.engine must be ladybug');
  assertNonEmptyString(input.engineVersion, 'manifest.engineVersion');
  assertPositiveInteger(input.graphSchemaVersion, 'manifest.graphSchemaVersion');
  assertNonEmptyString(input.builderVersion, 'manifest.builderVersion');
  assertPositiveInteger(input.storageFormatVersion, 'manifest.storageFormatVersion');
  if (input.sourcePolicy !== 'strip') invalid('manifest.sourcePolicy must be strip');
  if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
    invalid('manifest.repositories must contain at least one selected repository');
  }

  const repositories = input.repositories.map((value, index) => validateRepository(value, workspaceId, index));
  const seen = new Set<string>();
  for (const repository of repositories) {
    if (seen.has(repository.repoKey)) invalid(`manifest has duplicate repoKey ${repository.repoKey}`);
    seen.add(repository.repoKey);
  }
  repositories.sort(
    (left, right) =>
      compareCanonicalString(left.repoKey, right.repoKey) || compareCanonicalString(left.repoName, right.repoName),
  );

  return {
    manifestVersion: 1,
    workspaceId,
    parentVersionId: input.parentVersionId,
    engine: 'ladybug',
    engineVersion: input.engineVersion,
    graphSchemaVersion: input.graphSchemaVersion,
    builderVersion: input.builderVersion,
    storageFormatVersion: input.storageFormatVersion,
    sourcePolicy: 'strip',
    repositories,
    mapper: validateMapper(input.mapper, workspaceId),
  };
}

function normalizeCanonicalJson(value: unknown, path: string): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid(`${path} contains a non-canonical number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalizeCanonicalJson(entry, `${path}[${index}]`));
  assertPlainObject(value, path);
  const result: { [key: string]: CanonicalJsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = normalizeCanonicalJson(value[key], `${path}.${key}`);
  }
  return result;
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value, 'value'));
}

export function createGraphSnapshotIdentity(input: unknown): GraphSnapshotIdentity {
  const manifest = canonicalizeGraphSnapshotManifest(input);
  const canonicalJson = canonicalizeJson(manifest);
  return {
    manifest,
    canonicalJson,
    versionId: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
  };
}

export function hasCurrentGraphSnapshotCompatibility(manifest: GraphSnapshotManifestV1): boolean {
  return (
    manifest.engine === GRAPH_FILE_FORMAT_COMPATIBILITY.engine &&
    manifest.engineVersion === GRAPH_FILE_FORMAT_COMPATIBILITY.engineVersion &&
    manifest.graphSchemaVersion === GRAPH_FILE_FORMAT_COMPATIBILITY.graphSchemaVersion &&
    manifest.builderVersion === GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion &&
    manifest.storageFormatVersion === GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion
  );
}
