import { describe, expect, it } from 'vitest';
import { fBeta } from './component-decision.js';

describe('fBeta', () => {
  it('β=2 recovers full F1 when precision == recall', () => {
    const r = fBeta(['a', 'b'], ['a', 'b'], 2);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.fBeta).toBe(1);
  });

  it('β=2 favors recall over precision', () => {
    // Truth has 5 items, agent cites all 5 + 5 unrelated → recall=1, precision=0.5.
    // F1 would be 0.667; F2 should be higher because recall is weighted more.
    const r = fBeta(
      ['RequestsPage', 'DownloadControlWithEvents', 'downloadFile', 'GenericPopup', 'useCompany', 'x1', 'x2', 'x3', 'x4', 'x5'],
      ['RequestsPage', 'DownloadControlWithEvents', 'downloadFile', 'GenericPopup', 'useCompany'],
      2,
    );
    expect(r.recall).toBe(1);
    expect(r.precision).toBeCloseTo(0.5, 5);
    // F1 = 0.667, F2 ≈ 0.833
    expect(r.fBeta).toBeGreaterThan(0.8);
  });

  it('zero recall scores zero regardless of precision', () => {
    const r = fBeta(['x', 'y'], ['a', 'b'], 2);
    expect(r.recall).toBe(0);
    expect(r.fBeta).toBe(0);
  });

  it('empty truth → zero', () => {
    expect(fBeta(['a'], [], 2).fBeta).toBe(0);
  });

  it('empty cited → zero', () => {
    expect(fBeta([], ['a'], 2).fBeta).toBe(0);
  });

  it('matches the eval’s real run-0 shape', () => {
    // run-0 component-decision withMcp: recall=1.0, precision≈0.116. F1=0.21.
    // F2 should be roughly recall-weighted, lifting the score meaningfully.
    const truth = ['RequestsPage', 'DownloadControlWithEvents', 'downloadFile', 'GenericPopup', 'useCompany'];
    const cited = [
      ...truth,
      // 38 extra plausible reusables the agent cited (rough count)
      ...Array.from({ length: 38 }, (_, i) => `extra${i}`),
    ];
    const r = fBeta(cited, truth, 2);
    expect(r.recall).toBe(1);
    expect(r.fBeta).toBeGreaterThan(0.35); // up from F1 ≈ 0.21
    expect(r.fBeta).toBeLessThan(0.7); // still penalized for low precision
  });
});
