import { describe, expect, it } from 'vitest';
import {
  ArtifactRevisionBodySchema,
  MAX_ARTIFACT_MARKDOWN_BYTES,
  validateCanonicalArtifactId,
} from './canonical-artifact.contract.js';

const ARTIFACT_ID = 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    repositoryKey: 'coredoc/coredoc-parser',
    kind: 'spec',
    checkpoint: 'run-finish',
    markdown: '# Delivery specification\n',
    ...overrides,
  };
}

/**
 * The upload the controller and service assemble: the body through the zod schema
 * (`ZodValidationPipe`), then the `:artifactId` path segment and the server-side byte count.
 */
function validateArtifactRevisionUpload(rawArtifactId: unknown, body: unknown) {
  const parsed = ArtifactRevisionBodySchema.safeParse(body);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return {
    ...parsed.data,
    artifactId: validateCanonicalArtifactId(rawArtifactId),
    byteCount: Buffer.byteLength(parsed.data.markdown, 'utf8'),
  };
}

describe('artifact revision upload', () => {
  it('accepts the exact bounded wire and normalizes canonical client IDs', () => {
    expect(
      validateArtifactRevisionUpload(ARTIFACT_ID.toUpperCase(), validBody({ runId: 'cdr-20260816-a1b2c3' })),
    ).toEqual({
      artifactId: ARTIFACT_ID,
      taskId: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
      kind: 'spec',
      runId: 'cdr-20260816-a1b2c3',
      checkpoint: 'run-finish',
      markdown: '# Delivery specification\n',
      byteCount: 25,
    });
  });

  it.each(['spec', 'design', 'implementation_issue'])('accepts artifact kind %s', (kind) => {
    expect(validateArtifactRevisionUpload(ARTIFACT_ID, validBody({ kind })).kind).toBe(kind);
  });

  it.each(['run-finish', 'session-end', 'session-start-reconcile'])('accepts checkpoint %s', (checkpoint) => {
    expect(validateArtifactRevisionUpload(ARTIFACT_ID, validBody({ checkpoint })).checkpoint).toBe(checkpoint);
  });

  it('allows exactly one MiB by UTF-8 byte count, including multibyte Markdown', () => {
    const markdown = 'é'.repeat(MAX_ARTIFACT_MARKDOWN_BYTES / 2);
    expect(validateArtifactRevisionUpload(ARTIFACT_ID, validBody({ markdown })).byteCount).toBe(
      MAX_ARTIFACT_MARKDOWN_BYTES,
    );
  });

  it('rejects Markdown above one MiB by UTF-8 byte count', () => {
    const markdown = `${'é'.repeat(MAX_ARTIFACT_MARKDOWN_BYTES / 2)}a`;
    expect(() => validateArtifactRevisionUpload(ARTIFACT_ID, validBody({ markdown }))).toThrow(
      'markdown must not exceed 1048576 UTF-8 bytes',
    );
  });

  it.each(['\u0000', '\u0008', '\u000b', '\u001f', '\u007f', '\u0085'])('rejects control character %j', (control) => {
    expect(() => validateArtifactRevisionUpload(ARTIFACT_ID, validBody({ markdown: `safe${control}unsafe` }))).toThrow(
      'markdown contains an unsupported control character',
    );
  });

  it.each(['\ud800', '\udfff', 'valid\ud800tail'])('rejects unpaired UTF-16 surrogate %j', (markdown) => {
    expect(() => validateArtifactRevisionUpload(ARTIFACT_ID, validBody({ markdown }))).toThrow(
      'markdown must be well-formed Unicode',
    );
  });

  it('allows Markdown line structure controls', () => {
    expect(() =>
      validateArtifactRevisionUpload(ARTIFACT_ID, validBody({ markdown: 'one\ttwo\r\nthree\n' })),
    ).not.toThrow();
  });

  it.each([
    ['artifact id', 'artifact-1', validBody()],
    ['task id', ARTIFACT_ID, validBody({ taskId: 'task-1' })],
    ['repository key', ARTIFACT_ID, validBody({ repositoryKey: '../outside' })],
    ['kind', ARTIFACT_ID, validBody({ kind: 'prompt' })],
    ['checkpoint', ARTIFACT_ID, validBody({ checkpoint: 'edit' })],
    ['run id', ARTIFACT_ID, validBody({ runId: 'run-1' })],
    ['nullable run id', ARTIFACT_ID, validBody({ runId: null })],
    ['markdown', ARTIFACT_ID, validBody({ markdown: 42 })],
    ['unknown field', ARTIFACT_ID, validBody({ path: '.scratch/spec.md' })],
  ])('rejects an invalid %s before persistence', (_label, artifactId, body) => {
    expect(() => validateArtifactRevisionUpload(artifactId, body)).toThrow();
  });
});
