// =============================================================================
// score-core — the language-neutral coverage-scoring math shared by every
// provider's scorer. The verdict thresholds, category policy, the
// emitted-count reader, the scorecard renderer, and the overall verdict live here
// exactly once; each provider supplies only its language-specific source signals
// (and, optionally, structural checks).
// =============================================================================
import type { ParsedRepo, SourceLocation } from '@coredoc/core/types';
import { isSentinelEntityName } from '../entity-sentinels.js';
import type { BaseProfile } from '../types/profile-base.js';
import { Verdict } from '../score-verdict.js';
import type { SignalHit } from './cluster-report.js';

export type Category = 'http' | 'queue' | 'entities' | 'dbOperations' | 'externalCalls' | 'cli' | 'grpc' | 'graphql';

/**
 * Emitted counts read off a ParsedRepo — the scorer numerators. The original five
 * categories are always present; the additional entrypoint kinds (cli/grpc/graphql)
 * are optional, so callers that only build the core five still satisfy the type.
 */
export type CategoryCounts = Record<'http' | 'queue' | 'entities' | 'dbOperations' | 'externalCalls', number> &
  Partial<Record<'cli' | 'grpc' | 'graphql', number>>;

/**
 * Source-signal denominators a provider derives from the repo on disk. `http` and
 * `entities` are always external (grepped / schema-counted). `queue` is optional:
 * when a provider supplies it (TS counts queue decorators), it is used; when omitted
 * (Ruby), the queue category is self-relative (source = emitted). `externalCalls` is
 * optional the same way: when supplied (TS counts HTTP-client call sites from the
 * manifest + greps), it is the denominator; when omitted, self-relative.
 * `dbOperations` is the distinct operated-entity denominator, supplied only when the
 * profile declares `schemaMirror`; when omitted, dbOperations scores against the
 * emitted entity count as before.
 */
export interface SourceSignals {
  http: number;
  entities: number;
  queue?: number;
  externalCalls?: number;
  dbOperations?: number;
  /**
   * Additional entrypoint-kind denominators, supplied only when the profile
   * declares that kind of rule (the TS provider counts the rule's own decorator /
   * command call sites). Omitted → the category is self-relative (like queue), so a
   * repo without that surface scores `not_applicable`.
   */
  cli?: number;
  grpc?: number;
  graphql?: number;
  /**
   * Basis disclosure for the dbOperations row when `dbOperations` is OMITTED —
   * e.g. the TS provider ignoring a `schemaMirror` flag that lacks
   * entity-generator evidence. Rendered in the scorecard's `basis` column so
   * the ignore is visible, never silent.
   */
  dbOperationsNote?: string;
  /**
   * Per-category `{file, line, text}` hit lists behind the grep-derived counts
   * (repo-relative files) — the join input for the unclaimed-site cluster report.
   * Optional: providers without hit lists (Ruby) omit it and the report is skipped.
   */
  hits?: Partial<Record<Category, SignalHit[]>>;
}

export interface CategoryScore {
  category: Category;
  source: number;
  emitted: number;
  ratio: number | null;
  status: 'required' | 'not_applicable';
  verdict: Verdict;
  /** Basis disclosure rendered on the scorecard row (e.g. `operated-entity basis (raw 39/92 = 42%)`). */
  note?: string;
}

/** Whether a failed score may be explicitly accepted as a documented coverage gap. */
export type ProfileCompletion = 'PASS' | 'ACCEPTABLE_GAP' | 'BLOCKED';

/** Context handed to a provider's scoring hooks. */
export interface ScoreContext {
  repoRoot: string;
  /** Exact repo-relative source set selected by provider.sourceFiles for this target. */
  sourceFiles: readonly string[];
  /** Path to the written ParsedRepo JSON (pre-scan / validate-output read it). */
  outPath: string;
  profile: BaseProfile;
  parsed: ParsedRepo;
}

/** TS-only structural integrity result (validate errors + consistency red flags). */
export interface StructuralResult {
  errors: string[];
  redFlags: string[];
}

/**
 * externalCalls scores against a coarse grep denominator (HTTP-client call sites), so
 * its PASS bar is 0.5 — the goal is catching order-of-magnitude misses (2/45), not
 * precision at the default 0.8.
 */
const EXTERNAL_CALLS_PASS_RATIO = 0.5;

/** Verdict thresholds (PASS bar per-category-overridable; PARTIAL floor fixed at 0.5). */
export function categoryVerdict(status: CategoryScore['status'], ratio: number, passRatio = 0.8): Verdict {
  if (status === 'not_applicable') return Verdict.PASS;
  if (ratio >= passRatio) return Verdict.PASS;
  if (ratio >= 0.5) return Verdict.PARTIAL;
  return Verdict.FAIL;
}

/** Build one category's score (status + capped ratio + verdict). */
export function categoryScore(category: Category, source: number, emitted: number, passRatio?: number): CategoryScore {
  const status: CategoryScore['status'] = source > 0 ? 'required' : 'not_applicable';
  const ratio = source > 0 ? Math.min(1, emitted / source) : null;
  return { category, source, emitted, ratio, status, verdict: categoryVerdict(status, ratio ?? 0, passRatio) };
}

/** Read the 5 scorer numerators off a ParsedRepo. */
export function emittedCountsFromRepo(parsed: ParsedRepo): CategoryCounts {
  const eps = parsed.entrypoints ?? [];
  return {
    http: eps.filter((e) => e.type === 'http').length,
    queue: eps.filter((e) => e.type === 'queue').length,
    entities: (parsed.entities ?? []).length,
    dbOperations: (parsed.dbOperations ?? []).length,
    externalCalls: (parsed.externalCalls ?? []).length,
    cli: eps.filter((e) => e.type === 'cli').length,
    grpc: eps.filter((e) => e.type === 'grpc').length,
    graphql: eps.filter((e) => e.type === 'graphql').length,
  };
}

/**
 * Emitted-node provenance locations per cluster-report category — the claim
 * side of the unclaimed-site join (every emitted node carries a SourceLocation).
 */
export function emittedLocationsFromRepo(parsed: ParsedRepo): Partial<Record<Category, SourceLocation[]>> {
  const eps = parsed.entrypoints ?? [];
  return {
    http: eps.filter((e) => e.type === 'http').map((e) => e.location),
    queue: eps.filter((e) => e.type === 'queue').map((e) => e.location),
    dbOperations: (parsed.dbOperations ?? []).map((op) => op.location),
    externalCalls: (parsed.externalCalls ?? []).map((c) => c.location),
  };
}

/**
 * Distinct entities actually operated on — the dbOperations denominator for
 * schema-mirror repos. Excludes the engine's sentinel entityNames (see
 * entity-sentinels.ts), mirroring the engine's own entityId-lookup exclusion.
 */
export function operatedEntityCount(parsed: ParsedRepo): number {
  return new Set((parsed.dbOperations ?? []).map((op) => op.entityName).filter((n) => !isSentinelEntityName(n))).size;
}

/**
 * Score the 5 categories against the source signals. Policy: http/entities from
 * external signals; queue from signals.queue when supplied else self-relative;
 * dbOperations relative to emitted entities (≥1 op/entity → PASS), or to the
 * operated-entity count when signals.dbOperations is supplied (schemaMirror repos —
 * the row then discloses the basis and keeps the raw all-entities ratio visible);
 * externalCalls from signals.externalCalls when supplied (0.5 bar) else self-relative.
 */
export function scoreCategories(emitted: CategoryCounts, signals: SourceSignals): CategoryScore[] {
  const dbOperations = categoryScore('dbOperations', signals.dbOperations ?? emitted.entities, emitted.dbOperations);
  if (signals.dbOperations !== undefined) {
    const rawPct = emitted.entities > 0 ? `${Math.round((emitted.dbOperations / emitted.entities) * 100)}%` : 'n/a';
    dbOperations.note = `operated-entity basis (raw ${emitted.dbOperations}/${emitted.entities} = ${rawPct})`;
  } else if (signals.dbOperationsNote !== undefined) {
    // The provider declined the operated-entity basis (e.g. schemaMirror
    // without generator evidence) — disclose why on the row.
    dbOperations.note = signals.dbOperationsNote;
  }
  const rows: CategoryScore[] = [
    categoryScore('http', signals.http, emitted.http),
    categoryScore('queue', signals.queue ?? emitted.queue, emitted.queue),
    categoryScore('entities', signals.entities, emitted.entities),
    dbOperations,
    categoryScore(
      'externalCalls',
      signals.externalCalls ?? emitted.externalCalls,
      emitted.externalCalls,
      EXTERNAL_CALLS_PASS_RATIO,
    ),
  ];
  // Additional entrypoint kinds — self-relative when the profile supplies no source
  // signal (like queue). A row appears only when the profile declares the rule
  // (signal present) or the kind was emitted, so unrelated repos stay uncluttered.
  for (const cat of ['cli', 'grpc', 'graphql'] as const) {
    const source = signals[cat];
    const emittedN = emitted[cat] ?? 0;
    if (source === undefined && emittedN === 0) continue;
    rows.push(categoryScore(cat, source ?? emittedN, emittedN));
  }
  return rows;
}

/**
 * Coverage red flags shared by all languages (entities-but-0-ops,
 * egress-signal-but-0-emitted, schemaMirror-basis disparity).
 */
export function coverageRedFlags(emitted: CategoryCounts, signals?: SourceSignals): string[] {
  const flags: string[] = [];
  if (emitted.entities > 0 && emitted.dbOperations === 0) {
    flags.push('entities present but 0 dbOperations (linked category dropped)');
  }
  const externalSignal = signals?.externalCalls;
  // ≥5 keeps a couple of grep false positives from failing a repo with genuinely no egress.
  if (externalSignal !== undefined && externalSignal >= 5 && emitted.externalCalls === 0) {
    flags.push(
      `${externalSignal} call sites resolve into HTTP-client packages but 0 externalCalls emitted — the profile is missing an egress matcher`,
    );
  }
  // The operated-entity basis is circular (≥1 op ⇒ ratio 1), so a schemaMirror
  // repo where almost nothing is operated AND almost nothing is emitted is far
  // more likely an under-extracting profile than a genuine schema mirror —
  // this disparity check is what makes blatant gaming fail.
  const operated = signals?.dbOperations;
  if (
    operated !== undefined &&
    emitted.entities > 0 &&
    operated / emitted.entities < 0.05 &&
    emitted.dbOperations < 10
  ) {
    flags.push(
      `schemaMirror basis with <5% of entities operated and only ${emitted.dbOperations} dbOperations — likely under-extraction, not a schema mirror`,
    );
  }
  return flags;
}

/** Render the coverage scorecard table (a `basis` column appears when any row has a note). */
export function renderScorecard(categories: CategoryScore[]): void {
  const withBasis = categories.some((s) => s.note !== undefined);
  console.table(
    Object.fromEntries(
      categories.map((s) => [
        s.category,
        {
          source: s.source,
          emitted: s.emitted,
          coverage: s.ratio == null ? 'n/a' : `${Math.round(s.ratio * 100)}%`,
          status: s.status,
          verdict: s.verdict,
          ...(withBasis ? { basis: s.note ?? '' } : {}),
        },
      ]),
    ),
  );
}

/** Overall pass: every required category PASS, plus no red flags / structural errors. */
export function isOverallPass(categories: CategoryScore[], errors: string[], redFlags: string[]): boolean {
  const requiredFails = categories.filter((s) => s.status === 'required' && s.verdict !== Verdict.PASS);
  return requiredFails.length === 0 && errors.length === 0 && redFlags.length === 0;
}

/**
 * Only a PARTIAL coverage row is a documentable gap. A category FAIL, structural error, or
 * consistency red flag means the graph is known to be materially incomplete and must fail closed.
 */
export function profileCompletion(
  categories: CategoryScore[],
  errors: string[],
  redFlags: string[],
): ProfileCompletion {
  if (errors.length > 0 || redFlags.length > 0) return 'BLOCKED';
  const required = categories.filter((score) => score.status === 'required');
  if (required.some((score) => score.verdict === Verdict.FAIL)) return 'BLOCKED';
  if (required.some((score) => score.verdict === Verdict.PARTIAL)) return 'ACCEPTABLE_GAP';
  return 'PASS';
}
