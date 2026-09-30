import { describe, it, expect } from 'vitest';
import { detectParseAnomalies } from './parse-anomaly.js';
import { ErrorCode } from './events.js';
import type { ParseStats } from '../types/index.js';

describe('detectParseAnomalies', () => {
  it('flags zero_calls_nonzero_functions and error_rate_gt_20pct for the WASM incident fixture', () => {
    const stats = {
      totalFunctions: 601,
      totalCalls: 0,
      parsedFiles: 601,
    } as ParseStats;

    expect(detectParseAnomalies({ stats, errorCount: 888 })).toEqual([
      ErrorCode.ZeroCallsNonzeroFunctions,
      ErrorCode.ErrorRateGt20Pct,
    ]);
  });

  it('returns no anomalies for a healthy repo', () => {
    const stats = {
      totalFunctions: 100,
      totalCalls: 500,
      parsedFiles: 50,
    } as ParseStats;

    expect(detectParseAnomalies({ stats, errorCount: 0 })).toEqual([]);
  });

  it('flags wasm_missing when errors dominate and both calls and functions are zero', () => {
    const stats = {
      totalFunctions: 0,
      totalCalls: 0,
      parsedFiles: 601,
    } as ParseStats;

    expect(detectParseAnomalies({ stats, errorCount: 1 })).toEqual([ErrorCode.WasmMissing]);
  });
});
