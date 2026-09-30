// =============================================================================
// cluster-report — unclaimed-site miss clusters for the coverage scorer.
//
// Joins a category's source-signal grep hits against the emitted nodes'
// provenance locations: hits not claimed by any emitted node (±2 lines) are
// the residue the profile missed. The residue is grouped by normalized
// syntactic shape so the Refine loop reads "12× em.getRepository(" instead of
// re-grepping the repo. Pure join + group-by over data the scorer already
// holds — no new parsing.
// =============================================================================
import type { SourceLocation } from '@coredoc/core/types';

/** One grep hit behind a source-signal count. `file` is repo-relative. */
export interface SignalHit {
  file: string;
  line: number;
  text: string;
}

/** One group of syntactically identical unclaimed sites. */
export interface MissCluster {
  /** Normalized shape token, e.g. `@EventPattern(`, `new UsersApi(`, `em.getRepository(`. */
  shape: string;
  count: number;
  /** `file:line: <trimmed text>` of the first unclaimed hit in the cluster. */
  sample: string;
}

/** A hit within ±2 lines of an emitted span counts as claimed (decorators sit just above handlers). */
const CLAIM_LINE_TOLERANCE = 2;
const TOP_CLUSTERS = 5;
const SAMPLE_TEXT_MAX = 100;

/**
 * Normalized shape of a hit line — the salient token, by first matching form:
 * decorator `@Name(`, constructor `new Name(`, receiver chain kept to its last
 * two segments (`this.em.getRepository(` → `em.getRepository(`), else the
 * first word of the trimmed text.
 */
export function hitShape(text: string): string {
  const t = text.trim();
  const decorator = t.match(/@([A-Za-z_$][\w$]*)\s*\(/);
  if (decorator) return `@${decorator[1]}(`;
  const constructed = t.match(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (constructed) return `new ${constructed[1]}(`;
  const chain = t.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?=\s*\()/);
  if (chain) return `${chain[0].split('.').slice(-2).join('.')}(`;
  return t.match(/[\w$]+/)?.[0] ?? t;
}

/**
 * The residue join: hits whose `{file, line}` falls within no emitted location
 * span (±2 lines, same file) are unclaimed; group them by `hitShape` and return
 * the top 5 clusters by count, each with the first hit as its sample.
 */
export function unclaimedClusters(hits: SignalHit[], emitted: SourceLocation[]): MissCluster[] {
  const spansByFile = new Map<string, { start: number; end: number }[]>();
  for (const l of emitted) {
    const spans = spansByFile.get(l.filePath) ?? [];
    spans.push({ start: l.startLine - CLAIM_LINE_TOLERANCE, end: l.endLine + CLAIM_LINE_TOLERANCE });
    spansByFile.set(l.filePath, spans);
  }
  const claimed = (h: SignalHit): boolean =>
    (spansByFile.get(h.file) ?? []).some((s) => h.line >= s.start && h.line <= s.end);

  const groups = new Map<string, MissCluster>();
  for (const h of hits) {
    if (claimed(h)) continue;
    const shape = hitShape(h.text);
    const existing = groups.get(shape);
    if (existing) existing.count++;
    else
      groups.set(shape, { shape, count: 1, sample: `${h.file}:${h.line}: ${h.text.trim().slice(0, SAMPLE_TEXT_MAX)}` });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, TOP_CLUSTERS);
}

/** Print one category's cluster block (nothing when there is no residue). */
export function renderMissClusters(category: string, clusters: MissCluster[]): void {
  if (clusters.length === 0) return;
  console.log(`\nUnclaimed ${category} sites (top clusters):`);
  for (const c of clusters) console.log(`  - ${c.count}× ${c.shape} — ${c.sample}`);
}
