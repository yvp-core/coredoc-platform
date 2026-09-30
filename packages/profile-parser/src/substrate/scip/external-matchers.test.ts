import { describe, expect, it } from 'vitest';
import type { StructuralCall } from '../../facts/index.js';
import { egressTraversableCaller } from './external-matchers.js';

/**
 * Egress must be attributed inside object-literal-property arrow methods — the react-admin
 * dataProvider pattern `const dp = { getList: () => fetchJson(url) }`. The internal call graph
 * already attributes these callers; egress now matches it. Constructors stay excluded (their
 * calls are construction-time wiring, not request-time service egress).
 */
function call(partial: Partial<StructuralCall>): StructuralCall {
  return { methodName: 'fetchJson', startLine: 1, endLine: 1, ...partial } as StructuralCall;
}

describe('egressTraversableCaller', () => {
  it('attributes egress inside object-literal-property methods (react-admin dataProvider)', () => {
    const c = call({ enclosingObjectMethod: true, enclosingKind: 'function', enclosingName: 'getList' });
    expect(egressTraversableCaller(c)).toBe(true);
  });

  it('still excludes constructor egress', () => {
    expect(egressTraversableCaller(call({ enclosingKind: 'method', enclosingName: 'constructor' }))).toBe(false);
  });

  it('attributes top-level function and non-constructor class-method egress', () => {
    expect(egressTraversableCaller(call({ enclosingKind: 'function', enclosingName: 'getCerts' }))).toBe(true);
    expect(egressTraversableCaller(call({ enclosingKind: 'method', enclosingName: 'fetchUser' }))).toBe(true);
  });
});
