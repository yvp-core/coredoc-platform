/**
 * Extraction-coverage helpers — single source for coverage semantics.
 *
 * The profile-driven parser can under-capture a category (sparse dbOps, missed
 * egress), making an empty tool result indistinguishable from "the code
 * genuinely has none". This module turns the raw per-repo counts stored in the
 * graph (IGraphReadRepository.getCoverageCounts) into the reported facts —
 * in-repo call resolution over counted sites, entity operations, the external
 * resolution rate — plus the trust guidance for `get_extraction_coverage` and
 * the one-line caveat appended to empty impact results. Only external
 * resolution carries a threshold; the rest are counts, never verdicts.
 *
 * Caching: the CAVEAT path (lowCoverageCaveat) memoizes counts per repository
 * capability and repo-hash set for a short TTL — it decorates every empty
 * impact result, so a burst of misses would otherwise re-run the same aggregate
 * counting query each time. Repository identity is part of the boundary: an
 * immutable snapshot pointer flip or another workspace must never reuse counts
 * from a different graph. The
 * `get_extraction_coverage` tool path (computeCoverageStats) stays UNCACHED:
 * it is the explicit "measure my coverage now" surface agents consult right
 * after a re-push.
 */

import type { IGraphReadRepository, RepoCoverageCounts } from '@coredoc/db';
import type { AnalysisRecord } from '@coredoc/core/types';
import {
  CALL_RESOLUTION_TEXT,
  DB_OP_RESOLUTION_TEXT,
  ResolutionRecordState,
  classifyResolution,
  type ResolutionCounts,
  type ResolutionPhrases,
} from '@coredoc/core';
import { debug } from './debug-logger.js';
import type { McpResponse } from './types.js';

// Keep the optional memoization protocol mock-safe: many tool unit tests
// replace @coredoc/db with a narrow repository-only module. Symbol.for gives
// this package the same process-wide key without requiring that runtime export.
const GRAPH_READ_CAPABILITY_IDENTITY = Symbol.for('@coredoc/db/graph-read-capability-identity');

// The ONE surviving threshold. External-call resolution is a true rate: every
// counted external call has a target the extractor either resolved or did not.
// Call resolution and entity operations are reported as COUNTS with no
// threshold: a repo of small leaf functions is not an extraction defect, and a
// verdict on a density invites tuning toward the metric instead of the graph.
export const EXTERNAL_RESOLUTION_LOW_THRESHOLD = 0.2;

/** Coverage category an empty tool result maps onto. */
export type CoverageCategory = 'dbOp' | 'call' | 'externalResolution';

/** Per-repo coverage stats: raw counts + external resolution rate + trust guidance. */
export interface RepoCoverageStats {
  analysis?: AnalysisRecord[];
  repoName: string;
  /** Raw node counts by kind (NodeType string values). */
  nodeCountsByType: Record<string, number>;
  entityCount: number;
  entitiesWithDbOps: number;
  functionCount: number;
  functionsWithCalls: number;
  /**
   * In-repo call resolution as the parser measured it, when this graph carries it. ABSENT (not
   * zeroed) for a graph pushed by a parser that did not record it — "not measured" and "nothing
   * bound" are different facts.
   */
  callResolution?: { callSites: number; resolvedCalls: number; outOfScopeCalls: number };
  /**
   * DB-operation resolution as the parser measured it, when this graph carries it. ABSENT (not
   * zeroed) for a graph pushed by a parser that did not record it — same discipline as
   * {@link RepoCoverageStats.callResolution}.
   */
  dbOpResolution?: { dbOpSites: number; boundDbOps: number; outOfScopeDbOps: number };
  externalCallCount: number;
  resolvedExternalCallCount: number;
  /** resolvedExternalCallCount / externalCallCount; 0 when none were extracted. */
  externalResolutionRate: number;
  /**
   * Dominant language of the repo's packages, when the graph reports one. It is the substrate
   * signal the language-conditional blind categories gate on (see {@link BlindCategoryContext});
   * absent whenever no package carries a language — unknown is never guessed either way.
   */
  primaryLanguage?: string;
  /** Plain-language trust-guidance lines — today only the externalResolution LOW line. */
  guidance: string[];
}

/** The one LOW trust-guidance line: external-call resolution is the only category with a rate. */
const externalResolutionGuidance = (percent: string) =>
  `external-call resolution LOW (${percent} of external calls resolved) — treat empty list_service_dependencies results as inconclusive; verify with grep`;

/**
 * Resolution-rate-independent caveat for caller/closure questions.
 *
 * A repo where nearly every counted call site bound says nothing about the
 * dispatch shapes the substrate cannot resolve statically (proxy objects, DI
 * containers, handler registries, reflection). Those edges are missing however
 * high the rate is, so the coverage tool must never tell an agent that an empty
 * caller result is a real absence. Deliberately phrased on dispatch SHAPE, not
 * on framework identity (a detected framework is not a guarantee of conventions
 * — see AGENTS.md).
 *
 * NARROWED, not retired, and not language-scoped: interface-typed dispatch is
 * bound when the interface has exactly ONE implementation in the analyzed scope
 * — from a TS/JS `implements` clause or a Kotlin supertype list (provenance
 * `iface-impl`) — at reduced confidence, because it is an inference about the
 * value the receiver holds. Everything else in the category (several
 * implementations, event/registry indirection, reflection, substrates that
 * record no supertype) is still absent.
 */
export const DYNAMIC_DISPATCH_CAVEAT =
  'Call-graph caveat (applies at any resolution rate): CALLS edges cover statically resolvable dispatch only — ' +
  'calls made through proxies, DI containers, handler registries or reflection can be absent. ' +
  'One exception, on every substrate that records a declared supertype: a call on a value typed by an in-repo interface IS bound ' +
  'when exactly one declaration in scope implements that interface (a TypeScript/JavaScript `implements` clause, a Kotlin supertype list) — ' +
  'such an edge is inferred (stored at reduced ' +
  'confidence), not compiler-proven, and dispatch with two or more implementations stays unresolved. ' +
  'A 0-caller/0-usage result for a symbol that plausibly has framework wiring deserves one targeted source check (grep) before you treat it as unused.';

/**
 * What is known about the repos in scope, for entries whose blindness is not global. Today the
 * only characteristic any entry gates on is the substrate LANGUAGE, because an emission gap can be
 * real on one substrate and closed on another.
 */
export interface BlindCategoryContext {
  /** Languages OBSERVED for the repos in scope. Empty means the graph reported none — not "TS". */
  languages: string[];
}

/** Substrate languages the TS/JS structural layer covers — the one that emits hierarchy edges. */
const TS_JS_LANGUAGES = new Set(['typescript', 'javascript', 'tsx', 'jsx', 'vue']);

/** One category the graph does not model (at all, or under common profiles) — see the registry below. */
export interface StructurallyBlindCategory {
  /** Stable slug. */
  id: string;
  /** Observed code shape the graph does not model — never a framework name. */
  shape: string;
  /** Trust-guidance line rendered once per get_extraction_coverage response. */
  guidance: string;
  /** Roadmap issue (.scratch/eval-uplift-roadmap/issues/…) whose landing must retire this entry. */
  retiredBy: string;
  /**
   * Present only on an entry whose blindness depends on the repos in scope. It must return true
   * ONLY on proof that the gap applies: an unknown characteristic keeps the entry silent, because
   * a warning nobody can act on is the same false signal in the other direction.
   */
  appliesWhen?: (context: BlindCategoryContext) => boolean;
}

/**
 * Categories whose recall is structurally ZERO — the graph has no edge for
 * them, so no density can ever flag them. Some are zero unconditionally (no
 * edge kind exists); others are zero unless the repo's extraction profile
 * opts into the shape, and their guidance says so rather than claiming a
 * global absence.
 *
 * Two properties define this list:
 *
 * (a) It is DECLARED, never inferred from counts. A category the engine cannot
 *     emit produces no counts to infer from — that is exactly the failure mode
 *     this registry exists for. An agent consulted the coverage tool, saw every
 *     density healthy and no flag, and concluded a graph-shaped answer was
 *     complete while the missing half lived in a category with no edge at all.
 *
 * (b) Every entry must be RETIRED by the issue that closes its gap. A blindness
 *     registry that outlives its gap becomes the next false signal, in the
 *     opposite direction: telling an agent to distrust results that are in fact
 *     now complete. When `retiredBy` lands, delete the entry in that change.
 *
 * Phrased on observed code SHAPE, never on framework identity — a detected
 * framework is not a guarantee of conventions (see AGENTS.md).
 */
export const STRUCTURALLY_BLIND_CATEGORIES: readonly StructurallyBlindCategory[] = [
  {
    id: 'test-callback-calls',
    shape: 'calls made inside test callbacks',
    guidance:
      "attribution to an enclosing caller is absent unless the repo's profile promotes callbacks to citable functions, so impact roll-ups may not name the tests a change breaks — grep the test files before treating an empty affected-tests list as evidence that no test covers the symbol",
    retiredBy: 'eval-uplift roadmap issue 11 (test-body call attribution)',
  },
  {
    id: 'dynamic-queue-destinations',
    shape: 'producer-side queue publication whose destination is not a statically resolvable wrapped member',
    guidance:
      "no egress edge is produced unless the repo's profile recognizes that publish shape, so egress can read near-empty while every density looks healthy — grep the publish call sites before asserting a queue has no producers",
    retiredBy: 'eval-uplift roadmap issue 10 (queue-topic resolution)',
  },
  {
    id: 'non-ts-declaration-hierarchy',
    shape: 'class/interface heritage (`extends` / `implements`) outside the TypeScript/JavaScript substrate',
    guidance:
      'EXTENDS and IMPLEMENTS_INTERFACE edges are bound by the TypeScript/JavaScript substrate only — other substrates capture the base NAME without resolving it, so enumerating implementors or subclasses there returns nothing however many the code has; grep the base name before treating an empty implementors or subclasses list as evidence that nothing extends it',
    retiredBy: 'eval-uplift roadmap issue 07 (interface dispatch — hierarchy on non-TS substrates)',
    // Fires only on a language the graph actually reports and that the TS/JS substrate does not
    // cover. A repo whose packages report no language leaves this silent: unproven, not proven TS.
    appliesWhen: (context) => context.languages.some((l) => !TS_JS_LANGUAGES.has(l.toLowerCase())),
  },
];

/**
 * The blind categories that apply to the repos in scope: every unconditional entry, plus the
 * conditional ones the context PROVES applicable. Called without a context (nothing known about
 * the scope) it returns the unconditional entries alone.
 */
export function structurallyBlindCategoriesFor(context?: BlindCategoryContext): StructurallyBlindCategory[] {
  return STRUCTURALLY_BLIND_CATEGORIES.filter(
    (c) => !c.appliesWhen || (context !== undefined && c.appliesWhen(context)),
  );
}

/**
 * One rendered trust-guidance line per APPLICABLE structurally blind category. Shape
 * matches the density guidance lines above: plain language, ending in what to
 * do instead of trusting the empty result.
 */
export function structurallyBlindGuidanceLines(context?: BlindCategoryContext): string[] {
  return structurallyBlindCategoriesFor(context).map((c) => `${c.shape}: ${c.guidance}`);
}

/** Heading for the blind-category block (rendered once per response). */
export const STRUCTURALLY_BLIND_HEADING =
  '**Structurally blind categories** (not modelled — at all, or under common profiles; no resolution count can flag these, so empty results in them are never evidence of absence):';

/** Per-repo line printed when nothing is flagged. */
export const NO_LOW_COVERAGE_FLAGS =
  'No external-call resolution flag; call resolution and entity operations are reported as counts above, not verdicts.';

/**
 * Numerator / denominator, defined as 0 when the denominator is 0: a category
 * with nothing extracted has zero evidence of coverage, which must read as
 * LOW, never as NaN.
 */
function density(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Rounded whole-percent formatter shared with formatExtractionCoverage. */
export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Compute per-repo coverage stats (raw counts, the call-resolution record when the
 * graph carries one, and the external-resolution trust line) for the given repo
 * scope. Backs the `get_extraction_coverage` tool.
 */
export async function computeCoverageStats(
  repository: IGraphReadRepository,
  repoHashes: string[],
): Promise<RepoCoverageStats[]> {
  const counts = await repository.getCoverageCounts(repoHashes);
  const languageByRepoName = await primaryLanguages(repository, repoHashes);

  return counts.map((c) => {
    const externalRate = density(c.resolvedExternalCallCount, c.externalCallCount);
    const guidance =
      externalRate < EXTERNAL_RESOLUTION_LOW_THRESHOLD ? [externalResolutionGuidance(formatPercent(externalRate))] : [];
    return {
      repoName: c.repoName,
      nodeCountsByType: c.nodeCountsByType,
      entityCount: c.entityCount,
      entitiesWithDbOps: c.entitiesWithDbOps,
      functionCount: c.functionCount,
      functionsWithCalls: c.functionsWithCalls,
      ...(c.callResolution ? { callResolution: c.callResolution } : {}),
      ...(c.analysis ? { analysis: c.analysis } : {}),
      ...(c.dbOpResolution ? { dbOpResolution: c.dbOpResolution } : {}),
      externalCallCount: c.externalCallCount,
      resolvedExternalCallCount: c.resolvedExternalCallCount,
      externalResolutionRate: externalRate,
      ...(languageByRepoName.get(c.repoName) ? { primaryLanguage: languageByRepoName.get(c.repoName) } : {}),
      guidance,
    };
  });
}

/**
 * Repo name → dominant package language, for the repos in scope. Packages are the only place the
 * graph records a language, and they carry the repo HASH, so the repository-name rows supply the
 * join back onto the coverage counts.
 *
 * Advisory, exactly like the caveat path: a language nobody could read leaves every repo unset,
 * which keeps the language-conditional blind entries silent rather than turning a diagnostic
 * lookup into a failed coverage report.
 */
async function primaryLanguages(repository: IGraphReadRepository, repoHashes: string[]): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  try {
    const [names, packages] = await Promise.all([
      repository.getRepositoryNames(repoHashes),
      repository.getPackages(repoHashes),
    ]);
    const nameByHash = new Map(names.map((r) => [r.hash, r.name]));
    const counts = new Map<string, Map<string, number>>();
    for (const p of packages) {
      const repoName = p.repoId === undefined ? undefined : nameByHash.get(p.repoId);
      if (!repoName || !p.language) continue;
      const perRepo = counts.get(repoName) ?? new Map<string, number>();
      perRepo.set(p.language, (perRepo.get(p.language) ?? 0) + 1);
      counts.set(repoName, perRepo);
    }
    for (const [repoName, perRepo] of counts) {
      // Ties resolve by language name so the same graph always reports the same answer.
      const [dominant] = [...perRepo.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      byName.set(repoName, dominant);
    }
  } catch (error) {
    debug('computeCoverageStats', `language lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return byName;
}

/** How long a caveat-path counts entry stays fresh. */
export const COVERAGE_CACHE_TTL_MS = 5 * 60_000;

/** Caveat-path memo: graph capability identity → sorted repo-hash key → counts. */
let caveatCountsCache = new WeakMap<object, Map<string, { counts: RepoCoverageCounts[]; at: number }>>();

/** Drop every memoized caveat-path counts entry (tests). */
export function resetCoverageCaveatCache(): void {
  caveatCountsCache = new WeakMap();
}

function graphReadCapabilityIdentity(repository: IGraphReadRepository): object {
  return (
    (
      repository as IGraphReadRepository & {
        readonly [GRAPH_READ_CAPABILITY_IDENTITY]?: object;
      }
    )[GRAPH_READ_CAPABILITY_IDENTITY] ?? repository
  );
}

/**
 * One-line coverage caveat for an EMPTY tool result, or null when the scope has
 * nothing to qualify. Counts are aggregated across the scope's repos — the
 * caveat qualifies the scope that was actually queried, and a scope mixing
 * measured and unmeasured repositories says so instead of summing the measured
 * ones as if they were the whole answer. Counts are memoized per
 * repository capability and repo-hash set for {@link COVERAGE_CACHE_TTL_MS}
 * (see the module header).
 *
 * Never throws: the caveat is advisory decoration on an already-valid empty
 * answer, so a failed diagnostic count falls back to "no caveat" instead of
 * turning "not found" into a hard error (same rationale as getStalenessInfo
 * and the MCP metrics path).
 */
export async function lowCoverageCaveat(
  repository: IGraphReadRepository,
  repoHashes: string[],
  category: CoverageCategory,
): Promise<string | null> {
  const cacheKey = [...repoHashes].sort().join(',');
  const capabilityIdentity = graphReadCapabilityIdentity(repository);
  const repositoryCache = caveatCountsCache.get(capabilityIdentity);
  const cached = repositoryCache?.get(cacheKey);
  let counts: RepoCoverageCounts[];
  if (cached && Date.now() - cached.at < COVERAGE_CACHE_TTL_MS) {
    counts = cached.counts;
  } else {
    try {
      counts = await repository.getCoverageCounts(repoHashes);
    } catch (error) {
      // Advisory decoration only — log for observability, then degrade to "no caveat".
      debug('lowCoverageCaveat', `getCoverageCounts failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const cache = repositoryCache ?? new Map<string, { counts: RepoCoverageCounts[]; at: number }>();
    cache.set(cacheKey, { counts, at: Date.now() });
    if (!repositoryCache) caveatCountsCache.set(capabilityIdentity, cache);
  }
  if (counts.length === 0) return null;

  if (category === 'call') return resolutionCaveat(counts, pickCallResolution, CALL_CAVEAT);
  if (category === 'dbOp') return resolutionCaveat(counts, pickDbOpResolution, DB_OP_CAVEAT);

  const rate = density(
    counts.reduce((sum, c) => sum + c.resolvedExternalCallCount, 0),
    counts.reduce((sum, c) => sum + c.externalCallCount, 0),
  );
  if (rate >= EXTERNAL_RESOLUTION_LOW_THRESHOLD) return null;
  return `Note: this repo's external-call extraction density is low (${formatPercent(rate)}) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.`;
}

/**
 * The phrases one category's caveat renders around the shared classification. The classification
 * itself (and the three sentences that state a non-rate outcome) lives in @coredoc/core, so this
 * tool, `get_extraction_coverage` and `coredoc parse` cannot drift apart on what a record says.
 */
interface CaveatPhrases {
  /** Whole sentence for "no repo in scope measured this category", closing clause included. */
  notMeasured: string;
  /** Closing clause appended to every counted rendering. */
  closing: string;
  /** The shared non-rate sentences. */
  text: ResolutionPhrases;
  /** What the unbound count counts, e.g. 'counted in-repo call sites'. */
  unboundSubject: string;
}

const CAVEAT_TAIL = ' Verify with source (grep) before asserting nonexistence.';

const CALL_CAVEAT: CaveatPhrases = {
  notMeasured:
    'call resolution is not measured for this scope (re-parse and re-push to measure) — an empty result may be a gap, not a code fact.',
  closing: ' — an empty result here may be an unbound call, not a code fact.',
  text: CALL_RESOLUTION_TEXT,
  unboundSubject: 'counted in-repo call sites',
};

const DB_OP_CAVEAT: CaveatPhrases = {
  notMeasured:
    'db-operation resolution is not measured for this scope (re-parse and re-push to measure) — absence here may be a profile gap, not a code fact.',
  closing: ' — absence here may be a profile gap, not a code fact.',
  text: DB_OP_RESOLUTION_TEXT,
  unboundSubject: 'counted db-operation sites',
};

const pickCallResolution = (c: RepoCoverageCounts): ResolutionCounts | undefined =>
  c.callResolution && {
    sites: c.callResolution.callSites,
    bound: c.callResolution.resolvedCalls,
    outOfScope: c.callResolution.outOfScopeCalls,
  };

const pickDbOpResolution = (c: RepoCoverageCounts): ResolutionCounts | undefined =>
  c.dbOpResolution && {
    sites: c.dbOpResolution.dbOpSites,
    bound: c.dbOpResolution.boundDbOps,
    outOfScope: c.dbOpResolution.outOfScopeDbOps,
  };

/**
 * Name at most three unmeasured repos. On a project-wide scope the full list is longer than the
 * caveat it qualifies, and the agent's next move is the same whichever repos are named.
 */
function nameList(names: string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/**
 * The caveat for one resolution category: counts over the repos that MEASURED it, the unmeasured
 * ones named. Deliberately NOT gated on how much the scope contains — a scope with no entity and
 * no measurement must still say "not measured", because "nothing to cover" and "this parser never
 * counted" are different facts (spec BR-6). Silence is reserved for the one case it is honest in:
 * every repo measured, every counted in-scope site bound.
 */
function resolutionCaveat(
  counts: RepoCoverageCounts[],
  pick: (c: RepoCoverageCounts) => ResolutionCounts | undefined,
  phrases: CaveatPhrases,
): string | null {
  const records: ResolutionCounts[] = [];
  const unmeasured: string[] = [];
  for (const c of counts) {
    const record = pick(c);
    if (record) records.push(record);
    else unmeasured.push(c.repoName);
  }
  if (records.length === 0) return `Note: ${phrases.notMeasured}${CAVEAT_TAIL}`;

  const notMeasured = unmeasured.length > 0 ? `; not measured for ${nameList(unmeasured)}` : '';
  const total = records.reduce(
    (sum, r) => ({ sites: sum.sites + r.sites, bound: sum.bound + r.bound, outOfScope: sum.outOfScope + r.outOfScope }),
    { sites: 0, bound: 0, outOfScope: 0 },
  );
  // One repo's impossible record must not be averaged away by the others: classify per record
  // first, and only then the sum. A record that cannot be true is reported as such rather than
  // clamped, which would render a corrupt count as a perfectly bound graph.
  const state = records.some((r) => classifyResolution(r) === ResolutionRecordState.Inconsistent)
    ? ResolutionRecordState.Inconsistent
    : classifyResolution(total);

  switch (state) {
    case ResolutionRecordState.Inconsistent:
      return `Note: ${phrases.text.inconsistent} (${total.bound} bound, ${total.outOfScope} out of scope over ${total.sites} counted sites)${notMeasured}${phrases.closing}${CAVEAT_TAIL}`;
    case ResolutionRecordState.NoSitesCounted:
      return `Note: ${phrases.text.noSitesCounted}${notMeasured}${phrases.closing}${CAVEAT_TAIL}`;
    case ResolutionRecordState.AllOutOfScope:
      return `Note: ${phrases.text.allOutOfScope(total.sites)}${notMeasured}${phrases.closing}${CAVEAT_TAIL}`;
    default: {
      const inScope = total.sites - total.outOfScope;
      const unbound = inScope - total.bound;
      if (unbound === 0 && unmeasured.length === 0) return null;
      return `Note: ${unbound} of ${inScope} ${phrases.unboundSubject} are unbound across ${records.length} measured repo(s)${notMeasured}${phrases.closing}${CAVEAT_TAIL}`;
    }
  }
}

/**
 * Qualify an empty result before its summary and in raw metadata. Keep data's
 * shape intact so existing callers can still iterate the result array.
 */
export async function appendLowCoverageCaveat(
  response: McpResponse<unknown>,
  repository: IGraphReadRepository,
  repoHashes: string[],
  category: CoverageCategory,
): Promise<void> {
  const caveat = await lowCoverageCaveat(repository, repoHashes, category);
  if (!caveat) return;
  response.metadata = { ...response.metadata, warnings: [...(response.metadata.warnings ?? []), caveat] };
  if (typeof response.data === 'string') response.data = `${caveat}\n\n${response.data}`;
}
