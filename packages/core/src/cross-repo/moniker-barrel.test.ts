import { describe, expect, it } from 'vitest';
import * as crossRepo from './index.js';

describe('cross-repo barrel exposes the symbol hop', () => {
  it('re-exports normalizeMonikerDescriptor, buildSdkSymbolIndex and matchSymbolHop', () => {
    expect(typeof crossRepo.normalizeMonikerDescriptor).toBe('function');
    expect(typeof crossRepo.buildSdkSymbolIndex).toBe('function');
    expect(typeof crossRepo.matchSymbolHop).toBe('function');
    expect(typeof crossRepo.structuralFallbackKey).toBe('function');
  });
});
