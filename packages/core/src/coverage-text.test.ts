import { describe, expect, it } from 'vitest';
import {
  CALL_RESOLUTION_TEXT,
  DB_OP_RESOLUTION_TEXT,
  ResolutionRecordState,
  classifyResolution,
} from './coverage-text.js';

describe('classifyResolution', () => {
  it('separates a zero-site record from one where everything is out of scope', () => {
    expect(classifyResolution({ sites: 0, bound: 0, outOfScope: 0 })).toBe(ResolutionRecordState.NoSitesCounted);
    expect(classifyResolution({ sites: 12, bound: 0, outOfScope: 12 })).toBe(ResolutionRecordState.AllOutOfScope);
  });

  it('reports a real denominator as measured', () => {
    expect(classifyResolution({ sites: 100, bound: 60, outOfScope: 20 })).toBe(ResolutionRecordState.Measured);
    // Everything bound is still MEASURED — the caller decides whether that is worth a sentence.
    expect(classifyResolution({ sites: 10, bound: 10, outOfScope: 0 })).toBe(ResolutionRecordState.Measured);
  });

  // Each of these used to be clamped into a silent or "all out of scope" reading, which reports a
  // corrupt record as a measured fact.
  it('names every impossible record as inconsistent', () => {
    expect(classifyResolution({ sites: 10, bound: 0, outOfScope: 40 })).toBe(ResolutionRecordState.Inconsistent);
    expect(classifyResolution({ sites: 100, bound: 150, outOfScope: 0 })).toBe(ResolutionRecordState.Inconsistent);
    expect(classifyResolution({ sites: -1, bound: 0, outOfScope: 0 })).toBe(ResolutionRecordState.Inconsistent);
    expect(classifyResolution({ sites: 10, bound: -1, outOfScope: 0 })).toBe(ResolutionRecordState.Inconsistent);
    expect(classifyResolution({ sites: 10, bound: 0, outOfScope: -1 })).toBe(ResolutionRecordState.Inconsistent);
  });
});

describe('resolution phrases', () => {
  // The three consumers render these strings; drift between them is the defect this module exists
  // to prevent, so the spelling is pinned once here.
  it('states the out-of-scope sentence in counted sites, for one repository', () => {
    expect(CALL_RESOLUTION_TEXT.allOutOfScope(12)).toBe(
      'no counted call site names a declaration in this repository (12 counted sites, all out of scope)',
    );
    expect(DB_OP_RESOLUTION_TEXT.allOutOfScope(9)).toBe(
      'no counted db-operation site names an entity or table declared in this repository (9 counted sites, all out of scope)',
    );
  });

  it('gives a zero-site record and a broken record their own sentences', () => {
    expect(CALL_RESOLUTION_TEXT.noSitesCounted).toBe('no call site was counted for this scope');
    expect(DB_OP_RESOLUTION_TEXT.noSitesCounted).toBe('no db-operation site was counted for this scope');
    expect(CALL_RESOLUTION_TEXT.inconsistent).toContain('re-parse');
    expect(DB_OP_RESOLUTION_TEXT.inconsistent).toContain('re-parse');
  });
});
