/**
 * Tests for the topological sort algorithm
 */

import { describe, it, expect } from 'vitest';
import { topologicalSort, groupByDepth, getMaxDepth, SortedFunction } from './topological-sort';
import { FunctionNode, CallEdge, SourceLocation } from '@coredoc/core/types';

// Helper to create test fixtures
function createFn(id: string, name: string): FunctionNode {
  const location: SourceLocation = {
    filePath: 'test.ts',
    startLine: 1,
    endLine: 10,
  };

  return {
    id,
    versionedId: `${id}@abc123`,
    name,
    kind: 'function',
    fileId: 'file1',
    location,
    isAsync: false,
    isGenerator: false,
    parameters: [],
    sourceCode: `function ${name}() {}`,
  };
}

function createCall(callerId: string, calleeId: string): CallEdge {
  return {
    id: `call:${callerId}:${calleeId}`,
    callerId,
    calleeId,
    calleeExpression: `${calleeId.split(':').pop()}()`,
    isMethodCall: false,
    location: {
      filePath: 'test.ts',
      startLine: 5,
      endLine: 5,
    },
  };
}

describe('topologicalSort', () => {
  describe('basic sorting', () => {
    it('should return items in leaf-first order', () => {
      // A calls B, B calls C
      // Expected order: C (leaf), B, A (root)
      const fns = [createFn('fn:a', 'fnA'), createFn('fn:b', 'fnB'), createFn('fn:c', 'fnC')];

      const calls = [createCall('fn:a', 'fn:b'), createCall('fn:b', 'fn:c')];

      const result = topologicalSort(fns, calls);

      expect(result.sorted).toHaveLength(3);
      expect(result.sorted[0].function.name).toBe('fnC');
      expect(result.sorted[1].function.name).toBe('fnB');
      expect(result.sorted[2].function.name).toBe('fnA');

      expect(result.sorted[0].depth).toBe(0); // leaf
      expect(result.sorted[1].depth).toBe(1);
      expect(result.sorted[2].depth).toBe(2);

      expect(result.cyclicFunctions.size).toBe(0);
    });

    it('should handle items with no calls', () => {
      const fns = [createFn('fn:a', 'fnA'), createFn('fn:b', 'fnB')];

      const result = topologicalSort(fns, []);

      expect(result.sorted).toHaveLength(2);
      expect(result.cyclicFunctions.size).toBe(0);
      // All are leaves with depth 0
      expect(result.sorted.every((s) => s.depth === 0)).toBe(true);
    });

    it('should handle diamond dependency pattern', () => {
      // A calls B and C, both B and C call D
      // Expected: D first (leaf), then B and C (same depth), then A
      const fns = [createFn('fn:a', 'fnA'), createFn('fn:b', 'fnB'), createFn('fn:c', 'fnC'), createFn('fn:d', 'fnD')];

      const calls = [
        createCall('fn:a', 'fn:b'),
        createCall('fn:a', 'fn:c'),
        createCall('fn:b', 'fn:d'),
        createCall('fn:c', 'fn:d'),
      ];

      const result = topologicalSort(fns, calls);

      expect(result.sorted).toHaveLength(4);
      expect(result.cyclicFunctions.size).toBe(0);

      // D should be first (depth 0)
      expect(result.sorted[0].function.name).toBe('fnD');
      expect(result.sorted[0].depth).toBe(0);

      // B and C should be next (depth 1)
      const depth1 = result.sorted.filter((s) => s.depth === 1);
      expect(depth1).toHaveLength(2);
      expect(depth1.map((s) => s.function.name).sort()).toEqual(['fnB', 'fnC']);

      // A should be last (depth 2)
      expect(result.sorted[3].function.name).toBe('fnA');
      expect(result.sorted[3].depth).toBe(2);
    });
  });

  describe('cycle detection', () => {
    it('should detect simple cycles', () => {
      // A calls B, B calls A
      const fns = [createFn('fn:a', 'fnA'), createFn('fn:b', 'fnB')];

      const calls = [createCall('fn:a', 'fn:b'), createCall('fn:b', 'fn:a')];

      const result = topologicalSort(fns, calls);

      expect(result.cyclicFunctions.size).toBe(2);
      expect(result.cyclicFunctions.has('fn:a')).toBe(true);
      expect(result.cyclicFunctions.has('fn:b')).toBe(true);

      // Still includes all items
      expect(result.sorted).toHaveLength(2);
      // Cyclic items have depth -1
      expect(result.sorted.every((s) => s.depth === -1)).toBe(true);
    });

    it('should detect indirect cycles', () => {
      // A -> B -> C -> A
      const fns = [createFn('fn:a', 'fnA'), createFn('fn:b', 'fnB'), createFn('fn:c', 'fnC')];

      const calls = [createCall('fn:a', 'fn:b'), createCall('fn:b', 'fn:c'), createCall('fn:c', 'fn:a')];

      const result = topologicalSort(fns, calls);

      expect(result.cyclicFunctions.size).toBe(3);
      expect(result.sorted).toHaveLength(3);
    });

    it('should handle partial cycles with non-cyclic items', () => {
      // A -> B, B -> C, C -> B (cycle between B and C, A is not part of cycle)
      // D is standalone leaf
      const fns = [createFn('fn:a', 'fnA'), createFn('fn:b', 'fnB'), createFn('fn:c', 'fnC'), createFn('fn:d', 'fnD')];

      const calls = [createCall('fn:a', 'fn:b'), createCall('fn:b', 'fn:c'), createCall('fn:c', 'fn:b')];

      const result = topologicalSort(fns, calls);

      // D is leaf (depth 0)
      const fnD = result.sorted.find((s) => s.function.name === 'fnD');
      expect(fnD?.depth).toBe(0);

      // B and C are cyclic
      expect(result.cyclicFunctions.has('fn:b')).toBe(true);
      expect(result.cyclicFunctions.has('fn:c')).toBe(true);

      // A depends on cyclic B, so A is also blocked
      expect(result.cyclicFunctions.has('fn:a')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      const result = topologicalSort([], []);

      expect(result.sorted).toHaveLength(0);
      expect(result.cyclicFunctions.size).toBe(0);
    });

    it('should handle self-calls (recursion)', () => {
      // A calls itself (recursion) - should not create a cycle since we skip self-calls
      const fns = [createFn('fn:a', 'fnA')];
      const calls = [createCall('fn:a', 'fn:a')];

      const result = topologicalSort(fns, calls);

      expect(result.sorted).toHaveLength(1);
      expect(result.cyclicFunctions.size).toBe(0);
      expect(result.sorted[0].depth).toBe(0); // treated as leaf
    });

    it('should skip calls to items not in the items list', () => {
      // A calls B, but B is not in the items list (external)
      const fns = [createFn('fn:a', 'fnA')];
      const calls = [createCall('fn:a', 'fn:external')];

      const result = topologicalSort(fns, calls);

      expect(result.sorted).toHaveLength(1);
      expect(result.sorted[0].depth).toBe(0); // A is a leaf since external call is ignored
      expect(result.sorted[0].calleeIds).toHaveLength(0); // calleeIds only includes resolved internal calls
    });

    it('should skip calls with undefined calleeId', () => {
      const fns = [createFn('fn:a', 'fnA')];
      const calls: CallEdge[] = [
        {
          id: 'call:1',
          callerId: 'fn:a',
          calleeId: undefined,
          calleeExpression: 'someUnknown()',
          isMethodCall: false,
          location: { filePath: 'test.ts', startLine: 1, endLine: 1 },
        },
      ];

      const result = topologicalSort(fns, calls);

      expect(result.sorted).toHaveLength(1);
      expect(result.sorted[0].depth).toBe(0);
    });
  });

  describe('calleeIds tracking', () => {
    it('should correctly track calleeIds for each item', () => {
      const fns = [createFn('fn:a', 'fnA'), createFn('fn:b', 'fnB'), createFn('fn:c', 'fnC')];

      const calls = [createCall('fn:a', 'fn:b'), createCall('fn:a', 'fn:c')];

      const result = topologicalSort(fns, calls);

      const fnA = result.sorted.find((s) => s.function.name === 'fnA');
      expect(fnA?.calleeIds.sort()).toEqual(['fn:b', 'fn:c']);

      const fnB = result.sorted.find((s) => s.function.name === 'fnB');
      expect(fnB?.calleeIds).toHaveLength(0);

      const fnC = result.sorted.find((s) => s.function.name === 'fnC');
      expect(fnC?.calleeIds).toHaveLength(0);
    });
  });
});

describe('groupByDepth', () => {
  it('should group items by depth', () => {
    const fns = [createFn('fn:a', 'fnA'), createFn('fn:b', 'fnB'), createFn('fn:c', 'fnC'), createFn('fn:d', 'fnD')];

    const calls = [
      createCall('fn:a', 'fn:b'),
      createCall('fn:a', 'fn:c'),
      createCall('fn:b', 'fn:d'),
      createCall('fn:c', 'fn:d'),
    ];

    const { sorted } = topologicalSort(fns, calls);
    const groups = groupByDepth(sorted);

    expect(groups.get(0)?.map((s) => s.function.name)).toEqual(['fnD']);
    expect(
      groups
        .get(1)
        ?.map((s) => s.function.name)
        .sort(),
    ).toEqual(['fnB', 'fnC']);
    expect(groups.get(2)?.map((s) => s.function.name)).toEqual(['fnA']);
  });
});

describe('getMaxDepth', () => {
  it('should return max depth', () => {
    const sorted: SortedFunction[] = [
      { function: createFn('fn:a', 'a'), calleeIds: [], depth: 0 },
      { function: createFn('fn:b', 'b'), calleeIds: [], depth: 1 },
      { function: createFn('fn:c', 'c'), calleeIds: [], depth: 3 },
    ];

    expect(getMaxDepth(sorted)).toBe(3);
  });

  it('should return 0 for empty input', () => {
    expect(getMaxDepth([])).toBe(0);
  });
});
