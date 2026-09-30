// evals/harness/pairwise-aggregate.ts
import { ARMS, type ArmId, type PairwiseVerdict } from './planning-types.js';

export interface ArmStanding {
  arm: ArmId;
  wins: number;
  losses: number;
  ties: number;
  /** Verdicts the judge could not produce. Excluded from comparisons/winRate. */
  invalid: number;
  comparisons: number;
  winRate: number;
}

const ARM_IDS = ARMS.map((a) => a.id);

function emptyMatrix(): Record<ArmId, Record<ArmId, number>> {
  const m = {} as Record<ArmId, Record<ArmId, number>>;
  for (const x of ARM_IDS) {
    m[x] = {} as Record<ArmId, number>;
    for (const y of ARM_IDS) m[x][y] = 0;
  }
  return m;
}

export function aggregatePairwise(verdicts: PairwiseVerdict[]): {
  standings: ArmStanding[];
  matrix: Record<ArmId, Record<ArmId, number>>;
  /** Verdicts the judge could not produce — surfaced so a degraded run fails loud. */
  invalidCount: number;
} {
  const tally: Record<ArmId, { wins: number; losses: number; ties: number; invalid: number }> =
    {} as never;
  for (const id of ARM_IDS) tally[id] = { wins: 0, losses: 0, ties: 0, invalid: 0 };

  // headWins[x][y] = times x beat y; headN[x][y] = total x-vs-y comparisons.
  const headWins = emptyMatrix();
  const headN = emptyMatrix();
  let invalidCount = 0;

  for (const verd of verdicts) {
    const { left, right, winner } = verd;
    if (winner === 'invalid') {
      // Not a comparison: never enters headN/winRate. Counted so the run can
      // refuse to publish standings when too many verdicts are missing.
      tally[left].invalid += 1;
      tally[right].invalid += 1;
      invalidCount += 1;
      continue;
    }
    headN[left][right] += 1;
    headN[right][left] += 1;
    if (winner === 'tie') {
      tally[left].ties += 1;
      tally[right].ties += 1;
    } else {
      const loser = winner === left ? right : left;
      tally[winner].wins += 1;
      tally[loser].losses += 1;
      headWins[winner][loser] += 1;
    }
  }

  const matrix = emptyMatrix();
  for (const x of ARM_IDS) {
    for (const y of ARM_IDS) {
      matrix[x][y] = headN[x][y] === 0 ? 0 : headWins[x][y] / headN[x][y];
    }
  }

  const standings: ArmStanding[] = ARM_IDS.map((arm) => {
    const t = tally[arm];
    const comparisons = t.wins + t.losses + t.ties;
    return {
      arm,
      ...t,
      comparisons,
      winRate: comparisons === 0 ? 0 : (t.wins + 0.5 * t.ties) / comparisons,
    };
  }).sort((a, b) => b.winRate - a.winRate);

  return { standings, matrix, invalidCount };
}
