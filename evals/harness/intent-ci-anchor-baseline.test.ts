import { describe, expect, it } from 'vitest';
import { changedLineRanges, selectChangedNodes, replaceItemAnchors } from './intent-ci-anchor-baseline.js';

describe('T1 anchor baseline', () => {
  it('uses new-side hunks, including zero-count deletions without inventing changed nodes', () => {
    const diff =
      '+++ b/src/a.ts\n@@ -2 +2,2 @@\n-x\n+y\n+z\n@@ -10,2 +11,0 @@\n-x\n-y\ndiff --git a/deleted.ts b/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
    expect(changedLineRanges(diff)).toEqual([{ path: 'src/a.ts', ranges: [{ start: 2, end: 3 }], deletedLines: 2 }]);
  });
  it('does not broaden a hunk to unrelated symbols, accept unknown ranges or change file policy', () => {
    const nodes = [
      { id: 'edited', type: 'function', startLine: 10, endLine: 20 },
      { id: 'untouched', type: 'function', startLine: 21, endLine: 30 },
      { id: 'file', type: 'file', startLine: 0 },
      { id: 'unknown', type: 'function', startLine: 0 },
    ];
    expect(selectChangedNodes(nodes, [{ start: 20, end: 20 }], 'symbol').map((n) => n.id)).toEqual(['edited']);
    expect(selectChangedNodes(nodes, [], 'file').map((n) => n.id)).toEqual(['file']);
  });
  it('replaces only the fixed PR item set and keeps unrelated anchors identical', () => {
    const original = [
      { itemId: 'br-changed', nodeId: 'old' },
      { itemId: 'br-other', nodeId: 'untouched' },
    ];
    const replacements = [{ itemId: 'br-changed', nodeId: 'new' }];
    expect(replaceItemAnchors(original, new Set(['br-changed']), replacements)).toEqual([original[1], replacements[0]]);
    expect(original[0]?.nodeId).toBe('old');
  });
});
