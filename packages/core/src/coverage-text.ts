/**
 * Coverage sentences — ONE source for how a call/db-op resolution record reads.
 *
 * The same record is rendered in three places (`coredoc parse`'s integrity report, the MCP
 * `get_extraction_coverage` lines, the caveat appended to an empty impact result). Authored
 * per site the wording drifted — "this repository scope" vs "this repository", "sites" vs
 * "counted sites" — which reads as three different measurements of three different things.
 * The classifier decides WHICH fact a record states; the phrase bags state it.
 */

/** What a resolution record states once its counts are inspected. */
export enum ResolutionRecordState {
  /** Not one site was counted: nothing to resolve — never "everything bound". */
  NoSitesCounted = 'no-sites-counted',
  /** The counts contradict each other (bound above in-scope, out-of-scope above sites). */
  Inconsistent = 'inconsistent',
  /** Sites were counted and none of them could bind to anything declared here. */
  AllOutOfScope = 'all-out-of-scope',
  /** A real in-scope denominator — a rate may be printed. */
  Measured = 'measured',
}

/** A resolution record in neutral terms: sites counted, of those bound, of those out of scope. */
export interface ResolutionCounts {
  sites: number;
  bound: number;
  outOfScope: number;
}

/**
 * Classify a resolution record. An impossible record is named as impossible rather than clamped
 * into silence: clamping turns a corrupt count into "everything bound", which is the one reading
 * an agent must never get from a broken record.
 */
export function classifyResolution(counts: ResolutionCounts): ResolutionRecordState {
  const inScope = counts.sites - counts.outOfScope;
  if (
    counts.sites < 0 ||
    counts.bound < 0 ||
    counts.outOfScope < 0 ||
    counts.outOfScope > counts.sites ||
    counts.bound > inScope
  ) {
    return ResolutionRecordState.Inconsistent;
  }
  if (counts.sites === 0) return ResolutionRecordState.NoSitesCounted;
  if (inScope === 0) return ResolutionRecordState.AllOutOfScope;
  return ResolutionRecordState.Measured;
}

/** The sentences one resolution category renders — identical shape for calls and db operations. */
export interface ResolutionPhrases {
  /** A MEASURED record whose site count is zero. */
  noSitesCounted: string;
  /** A record whose counts cannot all be true. */
  inconsistent: string;
  /** Sites counted, none of them in scope. */
  allOutOfScope: (sites: number) => string;
}

export const CALL_RESOLUTION_TEXT: ResolutionPhrases = {
  noSitesCounted: 'no call site was counted for this scope',
  inconsistent: 'inconsistent call-resolution record — re-parse and re-push',
  allOutOfScope: (sites) =>
    `no counted call site names a declaration in this repository (${sites} counted sites, all out of scope)`,
};

export const DB_OP_RESOLUTION_TEXT: ResolutionPhrases = {
  noSitesCounted: 'no db-operation site was counted for this scope',
  inconsistent: 'inconsistent db-operation-resolution record — re-parse and re-push',
  allOutOfScope: (sites) =>
    `no counted db-operation site names an entity or table declared in this repository (${sites} counted sites, all out of scope)`,
};
