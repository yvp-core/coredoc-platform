/**
 * Request bodies for the workspace routes.
 */
import { z } from 'zod';
import { arrayField, booleanField, oneOfField, stringField } from '../../common/validators/field.js';
import { IntentReleaseTrigger } from '../../generated/prisma/client.js';

/**
 * Upper bound on one batch. Assembly loads up to three artifact rows per repository sequentially
 * inside a bounded control-plane transaction, so the cap must stay within what that transaction
 * can actually finish — not merely within how many repositories a workspace could theoretically
 * connect.
 */
export const RESOLVE_TARGETS_MAX = 100;

const WORKSPACE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateWorkspaceSchema = z.object({
  name: stringField('name', { notEmpty: true, min: 2, max: 50 }),
  slug: stringField('slug', {
    notEmpty: true,
    min: 2,
    max: 50,
    matches: {
      pattern: WORKSPACE_SLUG,
      message: 'slug must be lowercase alphanumeric with hyphens (e.g. my-workspace)',
    },
  }),
});

export const UpdateWorkspaceSchema = z.object({
  name: stringField('name', { min: 2, max: 50 }).optional(),
  ciCdEnabled: booleanField('ciCdEnabled').optional(),
  intentEnabled: booleanField('intentEnabled').optional(),
  /**
   * Who records intent releases (amendment §2). `manual` is today's behaviour; `merge`/`deploy`
   * hand the ledger to the connector or a CI step.
   */
  intentReleaseTrigger: oneOfField('intentReleaseTrigger', Object.values(IntentReleaseTrigger)).optional(),
});

export const EnableCloudSchema = z.object({
  ciCdEnabled: booleanField('ciCdEnabled').optional(),
});

const ResolveTargetSchema = z.object({
  repoName: stringField('repoName', {
    matches: { pattern: /^\S.*$/, message: 'repoName must be non-empty' },
  }),
  parsedVersion: stringField('parsedVersion', {
    matches: { pattern: /^[0-9a-f]{16}$/, message: 'parsedVersion must be a 16-hex artifact version' },
  }),
  summaryVersion: stringField('summaryVersion', {
    matches: { pattern: /^sum_[0-9a-f]{16}$/, message: 'summaryVersion must be a sum_-prefixed artifact version' },
  }).optional(),
  embeddingsVersion: stringField('embeddingsVersion', {
    matches: { pattern: /^emb_[0-9a-f]{16}$/, message: 'embeddingsVersion must be an emb_-prefixed artifact version' },
  }).optional(),
  commitSha: stringField('commitSha').optional(),
});

/**
 * Repositories to re-pin in the candidate this resolve publishes. Omitted, the resolve keeps its
 * historical meaning — recompute resolution over the current composition. Supplied, it makes one
 * resolve the finalizer of a batch: a client that has already uploaded every artifact names them
 * all here and pays for one build and one published object instead of one per repository.
 */
export const ResolveWorkspaceSchema = z.object({
  targets: arrayField('targets', ResolveTargetSchema, { max: RESOLVE_TARGETS_MAX }).optional(),
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;
export type EnableCloudInput = z.infer<typeof EnableCloudSchema>;
export type ResolveTargetInput = z.infer<typeof ResolveTargetSchema>;
export type ResolveWorkspaceInput = z.infer<typeof ResolveWorkspaceSchema>;
