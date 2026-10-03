import { describe, it, expect } from 'vitest';
import {
  ARTIFACT_REVISION_BODY_LIMIT,
  bodyLimitFor,
  DEFAULT_BODY_LIMIT,
  INTENT_IMPORT_BODY_LIMIT,
  LARGE_UPLOAD_LIMIT,
  MAPPER_BODY_LIMIT,
  OTLP_BODY_LIMIT,
} from './body-limits.js';

describe('bodyLimitFor', () => {
  it('caps unauthenticated / ordinary routes at the small default', () => {
    expect(bodyLimitFor('/api/v1/auth/callback')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/auth/refresh')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/tokens')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/members/invites')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/robots.txt')).toBe(DEFAULT_BODY_LIMIT);
  });

  it('allows the large limit for parser-result / summary / embeddings uploads', () => {
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/repos/my-repo/results/upload')).toBe(LARGE_UPLOAD_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/repos/my-repo/summaries/upload')).toBe(LARGE_UPLOAD_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/repos/my-repo/embeddings/upload')).toBe(LARGE_UPLOAD_LIMIT);
  });

  it('allows the large limit for parser tarball upload', () => {
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/parsers/my-repo')).toBe(LARGE_UPLOAD_LIMIT);
  });

  it('caps the mapper route at its dedicated limit', () => {
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/mapper')).toBe(MAPPER_BODY_LIMIT);
  });

  it('matches with a trailing slash or query string', () => {
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/repos/r/results/upload?foo=1')).toBe(LARGE_UPLOAD_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/mapper/')).toBe(MAPPER_BODY_LIMIT);
  });

  it('does not let a non-upload sub-path inherit the large limit', () => {
    // The `push` route under repos is NOT an upload endpoint — must stay at default.
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/repos/my-repo/push')).toBe(DEFAULT_BODY_LIMIT);
    // A path that merely contains the word "results" elsewhere must not match.
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/results/upload')).toBe(DEFAULT_BODY_LIMIT);
  });

  it('keeps the small default ordered below the large limit', () => {
    expect(DEFAULT_BODY_LIMIT).toBeLessThan(MAPPER_BODY_LIMIT);
    expect(MAPPER_BODY_LIMIT).toBeLessThan(LARGE_UPLOAD_LIMIT);
  });

  it('grants the OTLP limit only to the anchored otel ingest routes', () => {
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/otel/v1/metrics')).toBe(OTLP_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/otel/v1/logs')).toBe(OTLP_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/otel/v1/logs?x=1')).toBe(OTLP_BODY_LIMIT);
    // A path merely containing /otel/ elsewhere must NOT inherit the large limit.
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/repos/otel/results-x')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/otel/v1/logs')).toBe(DEFAULT_BODY_LIMIT);
  });

  it('grants 3 MiB only to artifact revision PUT while leaving canonical reads and capture unchanged', () => {
    const artifactPath =
      '/api/v1/workspaces/ws_1/delivery/v2/artifacts/cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/revisions';
    expect(bodyLimitFor(artifactPath, 'PUT')).toBe(ARTIFACT_REVISION_BODY_LIMIT);
    expect(bodyLimitFor(`${artifactPath}?retry=1`, 'PUT')).toBe(ARTIFACT_REVISION_BODY_LIMIT);
    expect(bodyLimitFor(`${artifactPath}/`, 'PUT')).toBe(ARTIFACT_REVISION_BODY_LIMIT);
    expect(bodyLimitFor(artifactPath, 'GET')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor(`${artifactPath}/unexpected`, 'PUT')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/delivery/v2/tasks/cdt_1', 'PUT')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/capture/v1/events', 'POST')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/otel/v1/logs', 'POST')).toBe(OTLP_BODY_LIMIT);
  });

  it('grants the intent import ceiling only to the workspace import POST', () => {
    const importPath = '/api/v1/workspaces/ws_1/intent/import/workspace';
    expect(bodyLimitFor(importPath, 'POST')).toBe(INTENT_IMPORT_BODY_LIMIT);
    expect(bodyLimitFor(`${importPath}/`, 'POST')).toBe(INTENT_IMPORT_BODY_LIMIT);
    expect(bodyLimitFor(`${importPath}?retry=1`, 'POST')).toBe(INTENT_IMPORT_BODY_LIMIT);
    // The retired overlay route and every other intent route stay on the default.
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/intent/import', 'POST')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/intent/items/review', 'POST')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('/api/v1/workspaces/ws_1/intent/tree', 'GET')).toBe(DEFAULT_BODY_LIMIT);
  });

  it('keeps the import ceiling above the default', () => {
    expect(DEFAULT_BODY_LIMIT).toBeLessThan(INTENT_IMPORT_BODY_LIMIT);
  });

  it('fits maximally JSON-escaped legal one-MiB Markdown under the artifact ingress ceiling', () => {
    const markdown = '"'.repeat(1024 * 1024);
    const encoded = JSON.stringify({
      taskId: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repositoryKey: 'coredoc/coredoc-parser',
      kind: 'spec',
      checkpoint: 'run-finish',
      markdown,
    });
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(DEFAULT_BODY_LIMIT);
    expect(Buffer.byteLength(encoded)).toBeLessThan(ARTIFACT_REVISION_BODY_LIMIT);
  });
});
