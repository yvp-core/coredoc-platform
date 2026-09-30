import { describe, expect, it } from 'vitest';
import * as cg from './index.js';

describe('substrate facts public surface', () => {
  it('exports the substrate-facts API', () => {
    expect(typeof cg.buildBaseline).toBe('function');
    expect(typeof cg.assemble).toBe('function');
    expect(typeof cg.CodeGraph).toBe('function');
    expect(typeof cg.decodeRange).toBe('function');
    expect(typeof cg.isDefinition).toBe('function');
  });
});
