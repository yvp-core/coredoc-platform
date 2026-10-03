/**
 * The operation schemas issue 03 needs that the Phase A contract does not
 * define: the two tree DELETES, and the query shapes of the list endpoints.
 *
 * They live here rather than in `contract/` because `contract/` is the shared
 * REST+MCP operation surface (spec §7/§11) and these are not on it: deleting a
 * domain or a feature is a KB-UI action with no MCP tool behind it, and list
 * query parameters are a REST transport concern that the MCP selectors express
 * differently. Everything is still built from the contract's own primitives, so
 * bounds and the slug shape cannot drift.
 */
import { IntentKind } from '@coredoc/core';
import { z } from 'zod';
import { IntentItemAuthority } from '../../generated/prisma/client.js';
import { idempotencyKey, slugId } from './contract/index.js';

/**
 * Deleting a domain or feature is refused while it still holds children or
 * attached items (spec §4.1/§4.2), so the request needs nothing but the id —
 * there is no cascade to opt into and no force flag to add.
 */
export const DeleteIntentDomainSchema = z.object({ idempotencyKey, id: slugId() }).strict();
export const DeleteIntentFeatureSchema = z.object({ idempotencyKey, id: slugId() }).strict();

export type DeleteIntentDomainInput = z.infer<typeof DeleteIntentDomainSchema>;
export type DeleteIntentFeatureInput = z.infer<typeof DeleteIntentFeatureSchema>;

/**
 * Shared list parameters. `limit` and `cursor` are parsed by the cursor codec
 * (they carry their own refusals), so they are strings here.
 */
const listQuery = {
  cursor: z.string().optional(),
  limit: z.string().optional(),
};

/**
 * Archived nodes are hidden from browse defaults and stay readable on request
 * (spec §4.1). An explicit `'true'` opts in — archiving is a visibility state,
 * never a deletion, and the KB must be able to show it.
 */
const includeArchived = z.enum(['true', 'false']).optional();

export const ListIntentTreeQuerySchema = z.object({ ...listQuery, includeArchived }).strict();

export const ListIntentFeaturesQuerySchema = z
  .object({ ...listQuery, includeArchived, domainId: slugId().optional() })
  .strict();

/** One node's document: the product root with neither id, a domain, or a feature. */
export const IntentNodeDocumentQuerySchema = z
  .object({
    domainId: slugId().optional(),
    featureId: slugId().optional(),
    includeCandidates: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const ListIntentFeatureSeedsQuerySchema = z.object({ ...listQuery }).strict();

/**
 * The browse INDEX of items — ids, titles, kinds, attachment, authority,
 * version. Deliberately not the agent context read (issue 07): no selectors, no
 * derivation, no evidence. It is what a KB list view and a paging client need.
 */
export const ListIntentItemsQuerySchema = z
  .object({
    ...listQuery,
    production: z.enum(['true', 'false']).optional(),
    effectivity: z.enum(['effective', 'planned', 'withdrawn', 'not_effective', 'unknown']).optional(),
    sourceRef: z.string().min(1).max(2048).optional(),
    sourceKind: z.enum(['spec', 'issue', 'adr', 'manual']).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    authorities: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(IntentItemAuthority)).min(1).max(4))
      .optional(),
    kinds: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(IntentKind)).min(1).max(6))
      .optional(),
    scopeFeatureId: slugId().optional(),
    authority: z.enum(IntentItemAuthority).optional(),
    kind: z.enum(IntentKind).optional(),
    domainId: slugId().optional(),
    featureId: slugId().optional(),
  })
  .strict();

/**
 * The REVIEW QUEUE read (issue v1.1-04): the candidates-only slice of the item
 * index, plus the counts a reviewer surface needs before it pages anything.
 *
 * There is no `authority` parameter, deliberately: the queue IS the candidate
 * set, and a filter that could widen it to accepted items would make the badge
 * and the list disagree. The three filters are the ones a reviewer works
 * through — a domain, one feature inside it, or one kind of statement.
 */
export const ListIntentReviewQueueQuerySchema = z
  .object({
    ...listQuery,
    kind: z.enum(IntentKind).optional(),
    domainId: slugId().optional(),
    featureId: slugId().optional(),
  })
  .strict();

export type ListIntentTreeQuery = z.infer<typeof ListIntentTreeQuerySchema>;
export type ListIntentFeaturesQuery = z.infer<typeof ListIntentFeaturesQuerySchema>;
export type ListIntentFeatureSeedsQuery = z.infer<typeof ListIntentFeatureSeedsQuerySchema>;
export type ListIntentItemsQuery = z.infer<typeof ListIntentItemsQuerySchema>;
export type ListIntentReviewQueueQuery = z.infer<typeof ListIntentReviewQueueQuerySchema>;

export const ListIntentSourcesQuerySchema = z.object({ search: z.string().trim().max(200).optional() }).strict();
