/**
 * Constants of the agent context contract shared by the cloud read surfaces
 * (server `get_intent_context`, desktop, web).
 */

/**
 * Response bound. The 1..20 range is the spec's; the default is deliberately
 * far below the maximum so an unqualified agent call stays cheap.
 */
export const INTENT_CONTEXT_LIMITS = {
  min: 1,
  max: 20,
  default: 5,
} as const;

/**
 * The fixed caveat every context response carries (LIM-2, spec "Agent context
 * contract"). Authored once so every surface states it identically; a consumer
 * that saw it on one surface and not another could read an unchanged anchor as
 * proof the intent is satisfied.
 */
export const INTENT_ANCHOR_WARNING =
  'Code anchors are implementation touchpoints, not conformance proof: an unchanged anchor does not show the intent is satisfied, and the anchor set is not a complete list of the code that implements it.';

/** Why an item is in the result. Reported so a consumer can weigh an exact routed ID against a search hit. */
export enum IntentMatchReason {
  /** Requested by exact intent ID (BR-8 routed handoff). */
  ExactId = 'exact_id',
  /** An item code anchor references a requested node id. */
  NodeAnchor = 'node_anchor',
  /** Lexical match on the item's text. */
  Text = 'text',
  /** No selector was supplied: the workspace's current accepted intent. */
  Default = 'default',
}

/**
 * The limit an OMITTED `limit` takes: the compact default, stretched to cover
 * exact ids.
 *
 * `intentIds` is an exact selector, not a page: a caller that named N ids asked
 * N answerable questions. Only the exact selector stretches — `query`,
 * `nodeIds`, and a bare read discover an unknown-sized set, which is what the
 * compact default exists to bound — and the same `max` still applies.
 */
export function defaultIntentLimit(intentIdCount = 0): number {
  return Math.min(INTENT_CONTEXT_LIMITS.max, Math.max(INTENT_CONTEXT_LIMITS.default, intentIdCount));
}
