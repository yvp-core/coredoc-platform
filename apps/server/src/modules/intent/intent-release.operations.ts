import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  INTENT_CONTRACT_LIMITS,
  externalUrl,
  idempotencyKey,
  itemVersion,
  repoKey,
  slugId,
  text,
} from './contract/intent-primitives.js';
import { HandoffDeclarationsSchema } from './intent-handoff.operations.js';

const head = z.number().int().min(0).max(2_147_483_646);
const reason = text(2000);
const common = { idempotencyKey, expectedHeadSeq: head.default(0) };
/**
 * A typed reason is REQUIRED only where it carries information nothing else
 * does: manual `plan` (roadmap intent with no PR yet) and `rollback` (a
 * destructive act). Everywhere else it is optional and the service fills a
 * system default (amendment §3.2, decision 1) — five modals asking a maintainer
 * to re-type "deployed" was the e2e run's finding F5.
 */
const optionalReason = reason.optional();
const included = z
  .array(z.object({ itemId: slugId(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
  .max(200);

/** The maintainer's own delivery record — byte-identical to what it always accepted, minus the required reason. */
export const HumanRecordIntentReleaseSchema = z
  .object({
    ...common,
    reason: optionalReason,
    kind: z.enum(['baseline', 'release']).default('release'),
    deliveredRef: text(256),
    included,
    retired: z.array(slugId()).max(200).default([]),
  })
  .strict()
  .refine((v) => v.included.length + v.retired.length > 0, 'a delivery must name at least one item')
  .refine((v) => v.kind !== 'baseline' || v.retired.length === 0, 'a baseline only includes items');

/** `{ repoKey, number, url? }` — a PR is never identified by number alone (amendment §1). */
export const IntentReleasePrSchema = z
  .object({ repoKey, number: z.number().int().positive(), url: externalUrl.optional() })
  .strict();

/** Internal ledger command, produced only by the verified handoff processor.
 * The legacy `trailers` field name is retained in request hashes for durable replay;
 * its value is structured declarations, never Markdown. Public CI input instead uses
 * IntentDeploymentSchema and cannot supply these sets. Deployment identity/time remain
 * properties of the original deployment, with no server-clock defaults.
 */
export const AutomaticRecordIntentReleaseSchema = z
  .object({
    kind: z.literal('release'),
    repoKey,
    deliveredRef: text(256),
    deployId: text(INTENT_CONTRACT_LIMITS.id),
    deployedAt: z.iso.datetime({ offset: true }),
    trailers: HandoffDeclarationsSchema,
    pr: IntentReleasePrSchema.optional(),
    reason: optionalReason,
  })
  .strict();

export const RollbackIntentReleaseSchema = z.object({ ...common, reason, releaseSeq: head.min(1) }).strict();
export const PlanIntentReleaseSchema = z
  .object({ ...common, reason, itemId: slugId(), expectedVersion: itemVersion })
  .strict();
export const ChangeIntentPlanSchema = z.object({ ...common, reason: optionalReason, itemId: slugId() }).strict();
export const PreviewIntentReleaseSchema = z.object({ itemId: slugId() }).strict();
export const ListIntentReleasesSchema = z
  .object({
    beforeSeq: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export const IntentReleaseToolSchema = z
  .object({
    action: z
      .enum(['preview', 'record', 'rollback', 'plan', 'withdraw', 'reinstate', 'list'])
      .describe('Read evidence with preview/list, or explicitly record a delivery or plan decision.'),
    request: z
      .record(z.string(), z.unknown())
      .default({})
      .describe(
        'Action-specific fields described by this tool. May be omitted for list; preview requires itemId and writes require their complete command.',
      ),
  })
  .strict();
export type AutomaticRecordIntentRelease = z.infer<typeof AutomaticRecordIntentReleaseSchema>;
export type HumanRecordIntentRelease = z.infer<typeof HumanRecordIntentReleaseSchema>;
/**
 * `pr` is provenance, never authorisation (amendment §3.1): the connector stamps the
 * pull request its plan decision came from so a human reading history sees WHY an item
 * became `planned`. It is on the COMMAND TYPE only — the connector calls the service
 * in-process — and deliberately not on the public plan schemas, because no REST or MCP
 * client produces it.
 */
type PlanProvenance = { pr?: z.infer<typeof IntentReleasePrSchema> };
export type ReleaseCommand =
  | AutomaticRecordIntentRelease
  | HumanRecordIntentRelease
  | (z.infer<typeof RollbackIntentReleaseSchema> & { kind: 'rollback' })
  | (z.infer<typeof PlanIntentReleaseSchema> & PlanProvenance & { kind: 'plan' })
  | (z.infer<typeof ChangeIntentPlanSchema> & PlanProvenance & { kind: 'withdraw' })
  | (z.infer<typeof ChangeIntentPlanSchema> & PlanProvenance & { kind: 'reinstate' });

/** What the write path actually validates: the automatic body resolved into the maintainer's own shape. */
export type ResolvedReleaseCommand = Exclude<ReleaseCommand, AutomaticRecordIntentRelease>;

/** The automatic body is the one command shape with trailers; nothing else can carry them (`.strict()`). */
export function isAutomaticRecord(input: ReleaseCommand): input is AutomaticRecordIntentRelease {
  return 'trailers' in input;
}

/**
 * `<repoKey>:<deliveredRef>:<deployId>:<pr>` — stable across retries of ONE delivery,
 * new for a new delivery of the same artifact, so "deploy A → rollback → deploy
 * A again" records a second release instead of replaying the first.
 *
 * The column is VARCHAR(200) and the plain composition can exceed it (a
 * 120-character repo key plus two 40-character shas is 202), so an over-long
 * identity folds into `<repoKey truncated to fit>:<sha256(FULL identity) first 32>`.
 * The digest covers the repo key too, so two long repo keys that share the truncated
 * prefix do not collide. Deterministic, so a retry of the same delivery still replays;
 * the repo key stays readable in the prefix. This is composed HERE and nowhere else — the REST schema
 * used to refuse the over-long case, but the connector calls the service directly.
 */
export function automaticIdempotencyKey(input: {
  repoKey: string;
  deliveredRef: string;
  deployId: string;
  pr?: { number: number };
}): string {
  // One deploy ships several PRs (BR-5), so the PR is part of the identity.
  // Without a PR this is the pre-BR-5 key, which `record` also probes to recognise old events.
  const key = `${input.repoKey}:${input.deliveredRef}:${input.deployId}${input.pr ? `:${input.pr.number}` : ''}`;
  if (key.length <= INTENT_CONTRACT_LIMITS.id) return key;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `${input.repoKey.slice(0, INTENT_CONTRACT_LIMITS.id - digest.length - 1)}:${digest}`;
}

/** The system default for an omitted reason (amendment §3.2). */
export function defaultReleaseReason(input: ReleaseCommand): string {
  if (input.reason !== undefined) return input.reason;
  if ('pr' in input && input.pr) return `PR ${input.pr.repoKey}#${input.pr.number}`;
  if (isAutomaticRecord(input)) return `deploy ${input.deliveredRef}`;
  return 'manual';
}

export const BatchPreviewIntentReleaseSchema = z.object({ itemIds: z.array(slugId()).min(1).max(200) }).strict();
