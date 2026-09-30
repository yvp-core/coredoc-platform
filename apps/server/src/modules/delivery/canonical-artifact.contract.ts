/**
 * `PUT artifacts/:artifactId/revisions`. The body is a zod schema applied by `ZodValidationPipe`
 * at the controller boundary; the `:artifactId` path segment is validated in the service, which
 * is the order the hand-rolled validator used (body shape first, then the artifact identity).
 */
import { z } from 'zod';
import { validateCaptureRepositoryKey } from '../capture/capture-contract.js';
import { CanonicalTaskIdSchema } from './canonical-delivery.contract.js';

export const MAX_ARTIFACT_MARKDOWN_BYTES = 1024 * 1024;

const ARTIFACT_ID_RE = /^cda_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;
const ARTIFACT_KINDS = new Set(['spec', 'design', 'implementation_issue']);
const CHECKPOINTS = new Set(['run-finish', 'session-end', 'session-start-reconcile']);
const ALLOWED_FIELDS = new Set(['taskId', 'repositoryKey', 'kind', 'runId', 'checkpoint', 'markdown']);
const REQUIRED_FIELDS = ['taskId', 'repositoryKey', 'kind', 'checkpoint', 'markdown'];

export type DeliveryArtifactKind = 'spec' | 'design' | 'implementation_issue';
export type ArtifactCheckpoint = 'run-finish' | 'session-end' | 'session-start-reconcile';

/**
 * The shape gate the hand-rolled `exactBody` performed, kept as one leading stage so its three
 * messages still outrank every per-field message, in the same order.
 */
const artifactBodyGate = z.custom<Record<string, unknown>>().superRefine((value, ctx) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    ctx.addIssue({ code: 'custom', message: 'Artifact revision body must be an object' });
    return;
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
    ctx.addIssue({ code: 'custom', message: 'Artifact revision body contains an unsupported field' });
    return;
  }
  for (const required of REQUIRED_FIELDS) {
    if (!(required in body)) {
      ctx.addIssue({ code: 'custom', message: `Artifact revision body requires ${required}` });
      return;
    }
  }
});

function markdownIssue(value: string): string | null {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return 'markdown must be well-formed Unicode';
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return 'markdown must be well-formed Unicode';
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return 'markdown contains an unsupported control character';
    }
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_ARTIFACT_MARKDOWN_BYTES) {
    return `markdown must not exceed ${MAX_ARTIFACT_MARKDOWN_BYTES} UTF-8 bytes`;
  }
  return null;
}

const MarkdownSchema = z
  .custom<string>((value) => typeof value === 'string', 'markdown must be a string')
  .superRefine((value, ctx) => {
    const issue = markdownIssue(value);
    if (issue) ctx.addIssue({ code: 'custom', message: issue });
  });

export const ArtifactRevisionBodySchema = artifactBodyGate.pipe(
  // Field order mirrors the hand-rolled validator: kind, checkpoint and markdown were checked
  // before the identity fields it then assembled.
  z.object({
    kind: z.custom<DeliveryArtifactKind>(
      (value) => typeof value === 'string' && ARTIFACT_KINDS.has(value),
      'kind must be spec, design, or implementation_issue',
    ),
    checkpoint: z.custom<ArtifactCheckpoint>(
      (value) => typeof value === 'string' && CHECKPOINTS.has(value),
      'checkpoint must be run-finish, session-end, or session-start-reconcile',
    ),
    markdown: MarkdownSchema,
    taskId: CanonicalTaskIdSchema,
    repositoryKey: z.custom<string>((value) => {
      try {
        validateCaptureRepositoryKey(value);
        return true;
      } catch {
        return false;
      }
    }, 'repositoryKey must be a normalized repository identifier'),
    runId: z
      .custom<string | null>(
        (value) => value === undefined || (typeof value === 'string' && RUN_ID_RE.test(value)),
        'runId must use the canonical cdr-YYYYMMDD-xxxxxx format',
      )
      .transform((value) => value ?? null),
  }),
);

export type ArtifactRevisionBody = z.infer<typeof ArtifactRevisionBodySchema>;

export interface ArtifactRevisionUpload extends ArtifactRevisionBody {
  artifactId: string;
  byteCount: number;
}

export function validateCanonicalArtifactId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('artifactId must use the canonical cda_<UUID> format');
  const match = ARTIFACT_ID_RE.exec(value);
  if (!match) throw new Error('artifactId must use the canonical cda_<UUID> format');
  return `cda_${match[1].toLowerCase()}`;
}
