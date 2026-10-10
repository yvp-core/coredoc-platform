/**
 * Request bodies for the delivery admin routes (settings, connectors, status map, actor merge).
 * The canonical delivery v2 write bodies live in `canonical-delivery.contract.ts`.
 */
import { z } from 'zod';
import {
  arrayField,
  booleanField,
  intField,
  isoDateField,
  oneOfField,
  stringField,
  uuidField,
} from '../../common/validators/field.js';
import type { DeliveryTaskLifecycle } from './canonical-delivery.contract.js';

/** Toggle L4 delivery intelligence for a workspace (closed-beta gate). */
export const UpdateDeliverySettingsSchema = z.object({
  enabled: booleanField('enabled'),
});

/**
 * Admin-only connector provisioning for a polled provider (github | jira). The `token` is a
 * secret credential (GitHub PAT or Jira API token): capped hard and never echoed back — the
 * service encrypts it at rest and no response ever includes it. Provider-specific fields are all
 * optional here; the service enforces the per-provider requirements (jira needs `email` +
 * `baseUrl`).
 */
export const CreateConnectorSchema = z.object({
  provider: oneOfField('provider', ['github', 'jira'] as const),
  token: stringField('token', { max: 4096 }), // github PAT | jira API token
  email: stringField('email', { max: 320 }).optional(), // jira only — the Basic-auth user
  repos: arrayField('repos', stringField('repos', { max: 256 }), { max: 200 }).optional(), // github 'owner/repo'
  projects: arrayField('projects', stringField('projects', { max: 32 }), { max: 50 }).optional(), // jira keys
  baseUrl: stringField('baseUrl', { max: 512 }).optional(), // github: optional GHE host; jira: REQUIRED
  // The ingest floor both importers apply on the FIRST/backfill sync, so a repo with years of PRs
  // — or a Jira project with tens of thousands of issues — isn't pulled whole. Two mutually
  // exclusive forms (the service rejects a body setting both), persisted into the connector's
  // `config` JSON and inert once a cursor exists. Both are declared here because an undeclared
  // body field is stripped, not passed through.

  // Absolute cutoff: ingest nothing updated before this instant. Preferred — the floor is the
  // same on every sync no matter when the first one runs. Stored normalized to ISO, so a
  // date-only '2026-08-01' means 2026-08-01T00:00:00.000Z.
  since: isoDateField('since').optional(),
  // Relative window in days from `now` (default 30). Convenient, but the floor slides until the
  // first sync lands — prefer `since` when the cutoff must be exact.
  lookbackDays: intField('lookbackDays', { min: 1, max: 3650 }).optional(),
});

const StatusMapEntrySchema = z.object({
  status: stringField('status', { max: 128 }),
  lifecycle: oneOfField('lifecycle', ['active', 'completed', 'abandoned', null] as const)
    .optional()
    .transform((value) => value as DeliveryTaskLifecycle | null | undefined),
  createsShipEvidence: booleanField('createsShipEvidence').optional(),
});

export const UpdateStatusMapSchema = z.object({
  entries: arrayField('entries', StatusMapEntrySchema, { max: 200 }),
});

/**
 * Admin merge of a duplicate actor: the source actorId is the path param; this body carries the
 * target actor to merge INTO. A UUID is required so a malformed id is rejected at the boundary
 * before any FK repointing runs.
 */
export const MergeActorSchema = z.object({
  intoActorId: uuidField('intoActorId'),
});

export type UpdateDeliverySettingsInput = z.infer<typeof UpdateDeliverySettingsSchema>;
export type CreateConnectorInput = z.infer<typeof CreateConnectorSchema>;
export type UpdateStatusMapInput = z.infer<typeof UpdateStatusMapSchema>;
export type MergeActorInput = z.infer<typeof MergeActorSchema>;
