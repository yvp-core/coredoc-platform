/**
 * Desktop additions to the intent wire contract. The shared shapes (mirroring
 * `apps/server/src/modules/intent/*`) live in `@coredoc/core/browser/intent`,
 * a browser-safe subpath, so this module stays safe on both sides of the IPC
 * bridge; what remains here is the IPC envelope and the reads only desktop makes.
 */
import type { DimensionValueSelection, IntentErrorDetail } from '@coredoc/core/browser/intent';

export * from '@coredoc/core/browser/intent';

/**
 * The one refusal code the review UI branches on: the reviewer decided against a
 * version that is no longer current, so the decision must be re-made against
 * what the item says now. Every other code is displayed verbatim.
 */
export const INTENT_VERSION_CONFLICT_CODE = 'version_conflict';

/** `IntentExceptionFilter`'s public error body — surfaced verbatim, never summarized. */
export interface IntentErrorEnvelope extends IntentErrorDetail {
  statusCode: number;
  timestamp: string;
  requestPath?: string;
  details?: IntentErrorDetail[];
}

/**
 * IPC envelope for every intent channel. `detail` carries the server's
 * structured error when the failure had one, so the renderer can show the exact
 * code and failing field paths instead of a generic hint (spec §12).
 */
export interface IntentResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  detail?: IntentErrorEnvelope;
}

export interface IntentDimensionsQuery {
  includeArchived?: boolean;
}

/** A `business_rule` payload variant: an outcome for one slice of context. */
export interface RuleVariant {
  /** Absent means the default variant. A list names alternatives, not a conjunction. */
  when?: DimensionValueSelection;
  /** Text; may be a formula over `inputs`. */
  outcome: string;
  /** Runtime values a formula reads. Not dimensions, never enumerated. */
  inputs?: string[];
}

export interface IntentContextQuery {
  intentIds?: string[];
  includeCandidates?: boolean;
  limit?: number;
  /**
   * Observed local checkouts, one `"<repoKey>@<commit>[:dirty]"` entry per repo
   * (spec §6.3). MAIN-PROCESS ONLY: the renderer never sends this and never
   * learns git state — `intent-observed-checkout.ts` resolves it and the
   * `intent:getContext` handler appends it. A repo the caller says nothing about
   * stays `unverified`, so omission is the honest answer, never a claim.
   */
  observed?: string[];
  /**
   * "The user asked for this again." Main drops its per-session checkout cache
   * and re-reads git before the call; it is not sent to the server, and it is
   * the whole reason there is no separate invalidate channel — the renderer's
   * refresh gesture already carries the meaning.
   */
  refresh?: boolean;
}

export interface IntentSourceOption {
  kind: string;
  ref: string;
  title: string | null;
  url: string | null;
}
export interface IntentSourcesResponse {
  sources: IntentSourceOption[];
  truncated: boolean;
}
