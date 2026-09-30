// evals/harness/pairwise-aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { aggregatePairwise } from './pairwise-aggregate.js';
import type { PairwiseVerdict } from './planning-types.js';

const v = (left: 'A'|'B'|'C'|'D', right: 'A'|'B'|'C'|'D', winner: 'A'|'B'|'C'|'D'|'tie'|'invalid'): PairwiseVerdict =>
  ({ taskId: 't', left, right, rep: 0, order: 'LR', winner, reason: '' });

describe('aggregatePairwise', () => {
  it('computes win/loss/tie and winRate per arm', () => {
    const { standings } = aggregatePairwise([v('C', 'A', 'C'), v('C', 'A', 'C'), v('C', 'A', 'tie')]);
    const C = standings.find((s) => s.arm === 'C')!;
    const A = standings.find((s) => s.arm === 'A')!;
    expect(C.wins).toBe(2);
    expect(C.ties).toBe(1);
    expect(C.comparisons).toBe(3);
    expect(C.winRate).toBeCloseTo((2 + 0.5) / 3);
    expect(A.losses).toBe(2);
    expect(A.winRate).toBeCloseTo(0.5 / 3);
  });

  it('matrix[C][A] reflects C beating A', () => {
    const { matrix } = aggregatePairwise([v('C', 'A', 'C'), v('A', 'C', 'C')]);
    expect(matrix.C.A).toBeCloseTo(1); // C won both head-to-heads vs A
    expect(matrix.A.C).toBeCloseTo(0);
  });

  it('excludes invalid verdicts from comparisons/winRate but counts them', () => {
    const { standings, invalidCount } = aggregatePairwise([
      v('C', 'A', 'C'),
      v('C', 'A', 'invalid'),
    ]);
    const C = standings.find((s) => s.arm === 'C')!;
    const A = standings.find((s) => s.arm === 'A')!;
    expect(invalidCount).toBe(1);
    expect(C.invalid).toBe(1);
    expect(A.invalid).toBe(1);
    expect(C.comparisons).toBe(1); // the invalid verdict is not a comparison
    expect(C.wins).toBe(1);
    expect(C.winRate).toBeCloseTo(1); // computed only over the real comparison
    expect(A.losses).toBe(1);
  });
});
