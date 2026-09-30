/**
 * Dynamic-boundary assembly — the shared "name the stopping site" surface
 * behind `find_callers`, `analyze_change_impact`, and (via the sentinel
 * rendering in response-formatter.ts) `explain`.
 *
 * A statically unresolved call (`this.client.emit(getTopicInNamespace('x'))`)
 * has no callee id, so it can never become a graph edge — presenting one as a
 * caller/dependency would fabricate a relationship (spec BR-1, the single
 * invariant this feature must never break). Instead each tool appends a
 * clearly separated, clearly labeled section of CANDIDATE sites: statically
 * unresolved call text that name/file-matches the thing being asked about.
 * Silence when there is nothing to show — an absent section is itself
 * meaningful (a strongly-resolved repo should stay near-silent, spec AC-6).
 */
import type { IGraphReadRepository } from '@coredoc/db';
// `UnresolvedCallRecord` is not (yet) in @coredoc/db's root export list —
// imported from the `./types` subpath, the established pattern for this repo
// (see type-usage.ts) since the root re-export list has drifted before.
import type { UnresolvedCallRecord } from '@coredoc/db/types';
import { DETAIL_ESCALATION_HINT } from './detail-level.js';
import type { McpResponse } from './types.js';

/** Sites rendered per boundary section — the rest collapse into an "omitted" count. */
export const BOUNDARY_SITE_CAP = 5;

/**
 * Fetch limit for the two boundary queries — the documented hard cap
 * (see UNRESOLVED_CALL_DEFAULT_LIMIT in @coredoc/db's graph-query-defaults.ts,
 * whose default of 50 is what these fetchers would otherwise silently inherit
 * and undercount "…and N more omitted" against).
 */
const BOUNDARY_FETCH_LIMIT = 1000;

/** Unresolved call sites whose callee text tail matches `name` — candidates for "who calls this?". */
export async function boundariesForSymbolName(
  repo: IGraphReadRepository,
  name: string,
  repoHashes: string[],
): Promise<UnresolvedCallRecord[]> {
  if (!name) return [];
  return repo.findUnresolvedCallsByNameTail(name, repoHashes, { limit: BOUNDARY_FETCH_LIMIT });
}

/** Unresolved call sites inside the given files — candidates for "impact may extend through". */
export async function boundariesInFiles(
  repo: IGraphReadRepository,
  filePaths: string[],
  repoHashes: string[],
): Promise<UnresolvedCallRecord[]> {
  if (filePaths.length === 0) return [];
  return repo.findUnresolvedCallsInFiles(filePaths, repoHashes, { limit: BOUNDARY_FETCH_LIMIT });
}

/** One rendered boundary line: `file:line — \`expression\` (caller: id)`. */
function formatBoundaryLine(record: UnresolvedCallRecord): string {
  // calleeExpression is verbatim repo source and can contain backticks
  // (e.g. a tagged template `sql\`select 1\``) — a raw backtick would break out
  // of this inline code span, so it's display-substituted with a quote.
  const expression = record.calleeExpression.replace(/`/g, "'");
  return `- ${record.filePath}:${record.line} — \`${expression}\` (caller: ${record.callerId})`;
}

/**
 * Markdown block for a boundary section, or `[]` when there is nothing to show
 * (callers must skip appending anything in that case — absence stays meaningful).
 *
 * `note` is an optional trailing `>` line — e.g. analyze_change_impact's
 * file-scope-cap disclosure — rendered even when `records` is empty, because
 * the note itself (not the site list) is what makes the section worth
 * showing in that case.
 */
export function formatBoundarySection(title: string, records: UnresolvedCallRecord[], note?: string): string[] {
  if (records.length === 0 && !note) return [];
  const lines: string[] = ['', `### ${title}`];
  if (records.length > 0) {
    const shown = records.slice(0, BOUNDARY_SITE_CAP);
    lines.push(...shown.map(formatBoundaryLine));
    const omitted = records.length - shown.length;
    if (omitted > 0) {
      // At the fetch cap, `records.length` is itself a floor, not the true
      // match count — say so with a `+` rather than implying an exact number.
      const isLowerBound = records.length >= BOUNDARY_FETCH_LIMIT;
      lines.push(`- …and ${omitted}${isLowerBound ? '+' : ''} more omitted`);
    }
  }
  if (note) lines.push(`> ${note}`);
  return lines;
}

/** Raw-format boundary payload: capped sites plus how many were left out. */
export interface BoundaryPayload {
  sites: UnresolvedCallRecord[];
  omittedCount: number;
  /** True when `omittedCount` is a floor, not an exact count (fetch hit BOUNDARY_FETCH_LIMIT). */
  omittedIsLowerBound?: boolean;
}

function toBoundaryPayload(records: UnresolvedCallRecord[]): BoundaryPayload {
  const sites = records.slice(0, BOUNDARY_SITE_CAP);
  const omittedCount = records.length - sites.length;
  return {
    sites,
    omittedCount,
    ...(records.length >= BOUNDARY_FETCH_LIMIT ? { omittedIsLowerBound: true as const } : {}),
  };
}

/**
 * Append a boundary section to an already-built tool response, additively:
 * a `boundaries` field on raw JSON data, a new markdown section on summary
 * text. No-op when `records` is empty AND `note` is absent (BR-1: never
 * merged into the existing callers/impact lists or counts — this only ever
 * adds a separate section; absence stays meaningful per spec AC-6).
 */
export function appendBoundarySection(
  response: McpResponse<unknown>,
  records: UnresolvedCallRecord[],
  title: string,
  note?: string,
): void {
  if (records.length === 0 && !note) return;
  if (response.metadata.format === 'raw') {
    if (records.length === 0) return; // raw stays a plain empty shape; the note is summary-only prose
    if (response.data && typeof response.data === 'object') {
      (response.data as Record<string, unknown>).boundaries = toBoundaryPayload(records);
    }
    return;
  }
  if (typeof response.data !== 'string') return;
  const section = formatBoundarySection(title, records, note).join('\n');
  // The basic-detail escalation footer (detail-level.ts) must stay the LAST
  // line of the response — insert the boundary section before it instead of
  // after, mirroring appendLowCoverageCaveat's prepend in coverage.ts.
  const footerSuffix = `\n\n${DETAIL_ESCALATION_HINT}`;
  if (response.data.endsWith(footerSuffix)) {
    const base = response.data.slice(0, -footerSuffix.length);
    response.data = `${base}\n${section}${footerSuffix}`;
    return;
  }
  response.data = `${response.data}\n${section}`;
}
