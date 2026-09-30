/**
 * Turns a graph overview into the left panel's chip counts.
 *
 * Pure because the degrade rules are the interesting part and they need tests.
 * Per ADR-20260724-explicit-degrade-no-silent-zeros the three "no number"
 * situations are kept distinct:
 *
 *   - the query has not resolved → `null`, rendered as "—". Never 0.
 *   - a counted repo simply has none of that type → a real measured `0`
 *     (the GROUP BY behind getCoverageCounts covers every node row).
 *   - a workspace repo missing from the payload → excluded from the sum and
 *     flagged via `countedRepos < knownRepos`, because its nodes are unknown,
 *     not absent.
 */
import type { GraphOverview } from '../../../shared/ipc-types';

/**
 * The node types the design gives a chip. Same strings `getCoverageCounts`
 * emits and `nodeColor()` takes, so there is no mapping layer and no
 * @coredoc/core enum in the renderer bundle.
 */
export const CHIP_NODE_TYPES = [
  'entrypoint',
  'entity',
  'function',
  'class',
  'interface',
  'enum',
  'component',
  'route',
  'state_store',
  'external_call',
] as const;

export interface TypeChipCount {
  type: string;
  /** null when the tally is unknown — render "—", never 0. */
  count: number | null;
}

export interface ChipCountsResult {
  chips: TypeChipCount[];
  /** Repos that contributed a measured tally. */
  countedRepos: number;
  /** Repos the workspace knows about, from config rather than the graph. */
  knownRepos: number;
  /** Repos present in the workspace but absent from the graph. */
  missingRepos: string[];
}

export function chipCounts(
  overview: GraphOverview | undefined,
  workspaceRepoNames: string[],
  /** Empty means "all repos". */
  selectedRepoNames: string[] = [],
): ChipCountsResult {
  const known = [...new Set(workspaceRepoNames)];

  if (!overview) {
    return {
      chips: CHIP_NODE_TYPES.map((type) => ({ type, count: null })),
      countedRepos: 0,
      knownRepos: known.length,
      missingRepos: [],
    };
  }

  const byName = new Map(overview.repos.map((r) => [r.name, r]));
  const scope = selectedRepoNames.length > 0 ? selectedRepoNames : known;
  const counted = scope.filter((name) => byName.has(name));

  const totals = new Map<string, number>();
  for (const name of counted) {
    for (const [type, n] of Object.entries(byName.get(name)?.countsByType ?? {})) {
      totals.set(type, (totals.get(type) ?? 0) + n);
    }
  }

  return {
    // A repo in scope but absent from the graph makes every tally partial, so
    // the caller can caption it — but the numbers we do have are still real.
    chips: CHIP_NODE_TYPES.map((type) => ({ type, count: counted.length === 0 ? null : (totals.get(type) ?? 0) })),
    countedRepos: counted.length,
    knownRepos: known.length,
    missingRepos: known.filter((name) => !byName.has(name)),
  };
}

/**
 * Per-repo page size for one chip seed.
 *
 * The budget is a canvas-rendering limit, so it is split across the repos rather
 * than granted to each: N repos asking for the full budget each is how one chip
 * click turns into an N-thousand-node canvas.
 */
export function seedShare(budget: number, selectedRepoCount: number): number {
  return Math.max(1, Math.floor(budget / Math.max(1, selectedRepoCount)));
}

export interface ChipDisclosure {
  /** Nodes of this type on the canvas right now; null when the chip shows none. */
  shown: number | null;
  /** The canvas holds fewer than the tally promises — the chip must say so. */
  truncated: boolean;
}

/**
 * What a type chip may claim about the canvas.
 *
 * The rule that matters: `shown` counts only what is actually rendered. A chip
 * whose type is toggled off, or whose nodes all sit in hidden repos, shows
 * nothing — and a chip reading "1,000 shown" above a canvas holding 15 dots is
 * the bug this function exists to prevent. `visibleOnCanvas` must therefore be
 * counted over the un-hidden repos only (see `visibleCountOfType`).
 */
export function chipDisclosure(active: boolean, visibleOnCanvas: number, total: number | null): ChipDisclosure {
  if (!active) return { shown: null, truncated: false };
  // A null total is an unknown tally, not a zero — it cannot prove truncation.
  return { shown: visibleOnCanvas, truncated: total !== null && visibleOnCanvas < total };
}
