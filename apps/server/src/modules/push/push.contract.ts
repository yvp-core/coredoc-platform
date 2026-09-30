/**
 * Request bodies for the push endpoints.
 */
import { z } from 'zod';
import { booleanField, stringField } from '../../common/validators/field.js';

/**
 * Version reference: parsed version plus optional metadata versions or explicit metadata
 * exclusions. Does not carry a ParsedRepo body — the server reads from R2 by version key.
 */
export const VersionPushSchema = z.object({
  parsedVersion: stringField('parsedVersion'),
  commitSha: stringField('commitSha').optional(),
  summaryVersion: stringField('summaryVersion').optional(),
  embeddingsVersion: stringField('embeddingsVersion').optional(),
  /** Do not reuse the manifest-current summary when no summaryVersion is supplied. */
  excludeSummaries: booleanField('excludeSummaries').optional(),
  /** Do not reuse the manifest-current embeddings when no embeddingsVersion is supplied. */
  excludeEmbeddings: booleanField('excludeEmbeddings').optional(),
});

export type VersionPushInput = z.infer<typeof VersionPushSchema>;
