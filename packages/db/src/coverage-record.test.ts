import { describe, expect, it } from 'vitest';
import { analysisFrom, callResolutionFrom, dbOpResolutionFrom } from './coverage-record.js';

describe('analysisFrom', () => {
  it('keeps old, malformed and unknown records unreported', () => {
    for (const input of [undefined, null, '', '{', '[]', '{}', '[{"mode":"enhanced"}]']) {
      expect(analysisFrom(input)).toBeUndefined();
    }
  });
  it('returns only portable capability fields from a persisted record', () => {
    const record = {
      language: 'csharp',
      target: 'api',
      mode: 'enhanced',
      compilerReceiverTypes: false,
      fallback: false,
    };
    expect(analysisFrom(JSON.stringify([{ ...record, diagnostic: 'raw compiler output' }]))).toEqual([record]);
  });
});

/** A Neo4j Integer as the driver hands it over: an object, not a number. */
const neoInt = (n: number) => ({ toNumber: () => n, toBigInt: () => BigInt(n) });

describe('callResolutionFrom', () => {
  it('accepts plain numbers', () => {
    expect(callResolutionFrom(440, 130, 300)).toEqual({ callSites: 440, resolvedCalls: 130, outOfScopeCalls: 300 });
  });

  it('accepts bigints', () => {
    expect(callResolutionFrom(10n, 4n, 1n)).toEqual({ callSites: 10, resolvedCalls: 4, outOfScopeCalls: 1 });
  });

  it('accepts Neo4j Integer objects', () => {
    expect(callResolutionFrom(neoInt(10), neoInt(4), neoInt(1))).toEqual({
      callSites: 10,
      resolvedCalls: 4,
      outOfScopeCalls: 1,
    });
  });

  // Everything below must be ABSENT, never a measured 0/0/0 (spec LIM-3/BR-6).
  it.each([
    ['null', null],
    ['undefined', undefined],
    ["the string '12'", '12'],
    ['a boolean', true],
    ['a list', [1, 2]],
    ['a map', { callSites: 1 }],
    ['NaN', Number.NaN],
  ])('reports not measured when a property is %s', (_label, value) => {
    expect(callResolutionFrom(value, 4, 1)).toBeUndefined();
    expect(callResolutionFrom(10, value, 1)).toBeUndefined();
    expect(callResolutionFrom(10, 4, value)).toBeUndefined();
  });

  // An arithmetically impossible record is corruption, not a measurement: reporting it
  // renders "150/100 counted sites bound (150%)".
  it.each([
    ['a negative site count', [-1, 0, 0]],
    ['a negative resolved count', [10, -1, 0]],
    ['a negative out-of-scope count', [10, 0, -1]],
    ['resolved alone over the site count', [10, 11, 0]],
    ['resolved + out of scope over the site count', [10, 6, 5]],
  ] as [string, [number, number, number]][])('reports not measured for %s', (_label, [a, b, c]) => {
    expect(callResolutionFrom(a, b, c)).toBeUndefined();
  });

  // The must-NOT twin: a record that exactly saturates the invariant is still a measurement.
  it('accepts a triple that exactly saturates the invariant', () => {
    expect(callResolutionFrom(10, 6, 4)).toEqual({ callSites: 10, resolvedCalls: 6, outOfScopeCalls: 4 });
    expect(callResolutionFrom(0, 0, 0)).toEqual({ callSites: 0, resolvedCalls: 0, outOfScopeCalls: 0 });
  });
});

describe('dbOpResolutionFrom', () => {
  it('accepts plain numbers, bigints and Neo4j Integer objects', () => {
    expect(dbOpResolutionFrom(9, 5, 2)).toEqual({ dbOpSites: 9, boundDbOps: 5, outOfScopeDbOps: 2 });
    expect(dbOpResolutionFrom(9n, 5n, 2n)).toEqual({ dbOpSites: 9, boundDbOps: 5, outOfScopeDbOps: 2 });
    expect(dbOpResolutionFrom(neoInt(9), neoInt(5), neoInt(2))).toEqual({
      dbOpSites: 9,
      boundDbOps: 5,
      outOfScopeDbOps: 2,
    });
  });

  // Absent, never a measured 0/0/0 (spec LIM-4/BR-6).
  it.each([
    ['null', null],
    ['undefined', undefined],
    ["the string '12'", '12'],
    ['a boolean', true],
    ['a list', [1, 2]],
    ['a map', { dbOpSites: 1 }],
    ['NaN', Number.NaN],
  ])('reports not measured when a property is %s', (_label, value) => {
    expect(dbOpResolutionFrom(value, 5, 2)).toBeUndefined();
    expect(dbOpResolutionFrom(9, value, 2)).toBeUndefined();
    expect(dbOpResolutionFrom(9, 5, value)).toBeUndefined();
  });

  it.each([
    ['a negative site count', [-1, 0, 0]],
    ['a negative bound count', [9, -1, 0]],
    ['bound + out of scope over the site count', [9, 5, 5]],
  ] as [string, [number, number, number]][])('reports not measured for %s', (_label, [a, b, c]) => {
    expect(dbOpResolutionFrom(a, b, c)).toBeUndefined();
  });

  it('accepts a triple that exactly saturates the invariant', () => {
    expect(dbOpResolutionFrom(9, 5, 4)).toEqual({ dbOpSites: 9, boundDbOps: 5, outOfScopeDbOps: 4 });
  });
});
