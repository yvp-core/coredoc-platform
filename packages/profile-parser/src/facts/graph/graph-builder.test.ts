import { describe, expect, it } from 'vitest';
import { CodeGraph } from './graph-builder.js';

describe('CodeGraph', () => {
  it('dedupes nodes by id and edges by id', () => {
    const g = new CodeGraph();
    g.addFunction({
      id: 'r:function:a.ts:foo',
      versionedId: 'r:function:a.ts:foo@aa',
      name: 'foo',
      kind: 'function',
      fileId: 'r:file:a.ts',
      isAsync: false,
      isGenerator: false,
      parameters: [],
      location: { filePath: 'a.ts', startLine: 1, endLine: 2 },
    });
    g.addFunction({
      id: 'r:function:a.ts:foo',
      versionedId: 'r:function:a.ts:foo@aa',
      name: 'foo',
      kind: 'function',
      fileId: 'r:file:a.ts',
      isAsync: false,
      isGenerator: false,
      parameters: [],
      location: { filePath: 'a.ts', startLine: 1, endLine: 2 },
    });
    g.addCall({
      id: 'r:call:x',
      callerId: 'r:function:a.ts:foo',
      calleeExpression: 'bar',
      isMethodCall: false,
      location: { filePath: 'a.ts', startLine: 2, endLine: 2 },
    });
    g.addCall({
      id: 'r:call:x',
      callerId: 'r:function:a.ts:foo',
      calleeExpression: 'bar',
      isMethodCall: false,
      location: { filePath: 'a.ts', startLine: 2, endLine: 2 },
    });
    expect(g.functions.size).toBe(1);
    expect(g.calls.size).toBe(1);
  });

  it('hasNode is true only for ids that were added as nodes', () => {
    const g = new CodeGraph();
    g.addFile({
      id: 'r:file:a.ts',
      versionedId: 'r:file:a.ts@aa',
      path: 'a.ts',
      extension: '.ts',
      packageId: 'r:package:.',
      language: 'typescript',
      contentHash: 'aa',
    });
    expect(g.hasNode('r:file:a.ts')).toBe(true);
    expect(g.hasNode('r:function:nope')).toBe(false);
  });

  it('resolveInternalCall upgrades an unresolved structural edge in place (no duplicate)', () => {
    const g = new CodeGraph();
    g.addCall({
      id: 'r:call:x',
      callerId: 'CALLER',
      calleeExpression: 'this.foo.load',
      isMethodCall: true,
      location: { filePath: 'a.ts', startLine: 5, endLine: 5 },
    });
    const found = g.resolveInternalCall('CALLER', 'a.ts', 5, 'CALLEE');
    expect(found).toBe(true);
    expect(g.calls.size).toBe(1); // upgraded, not duplicated
    expect(g.calls.get('r:call:x')!.calleeId).toBe('CALLEE');
    // a second resolve at a site with no structural sibling returns false (caller adds fresh)
    expect(g.resolveInternalCall('CALLER', 'b.ts', 9, 'OTHER')).toBe(false);
  });

  it('resolveInternalCall upgrades the same-named sibling when calls nest on one line', () => {
    const g = new CodeGraph();
    // `this.publish(topicFor(Topics.A))`: outer call registered first, inner call last.
    for (const [id, calleeExpression] of [
      ['r:call:outer', 'this.publish'],
      ['r:call:inner', 'topicFor'],
    ]) {
      g.addCall({
        id,
        callerId: 'CALLER',
        calleeExpression,
        isMethodCall: true,
        location: { filePath: 'a.ts', startLine: 3, endLine: 3 },
      });
    }
    expect(g.resolveInternalCall('CALLER', 'a.ts', 3, 'PUBLISH', 'publish')).toBe(true);
    expect(g.resolveInternalCall('CALLER', 'a.ts', 3, 'TOPIC_FOR', 'topicFor')).toBe(true);
    expect(g.calls.get('r:call:outer')!.calleeId).toBe('PUBLISH');
    expect(g.calls.get('r:call:inner')!.calleeId).toBe('TOPIC_FOR');
  });

  it('removeUnresolvedCallAt deletes a structural edge being reclassified as external', () => {
    const g = new CodeGraph();
    g.addCall({
      id: 'r:call:y',
      callerId: 'CALLER',
      calleeExpression: 'this.http.get',
      isMethodCall: true,
      location: { filePath: 'a.ts', startLine: 7, endLine: 7 },
    });
    g.removeUnresolvedCallAt('CALLER', 'a.ts', 7);
    expect(g.calls.size).toBe(0);
  });

  it('removeUnresolvedCallAt removes only the same-named call when calls nest on one line', () => {
    const g = new CodeGraph();
    // `axios.post(buildUrl(x))`: outer call registered first, inner call last.
    for (const [id, calleeExpression] of [
      ['r:call:post', 'axios.post'],
      ['r:call:buildUrl', 'buildUrl'],
    ]) {
      g.addCall({
        id,
        callerId: 'CALLER',
        calleeExpression,
        isMethodCall: true,
        location: { filePath: 'a.ts', startLine: 4, endLine: 4 },
      });
    }
    g.removeUnresolvedCallAt('CALLER', 'a.ts', 4, 'post');
    expect([...g.calls.keys()]).toEqual(['r:call:buildUrl']);
    // The site key survives for the remaining sibling, so SCIP can still upgrade it.
    expect(g.resolveInternalCall('CALLER', 'a.ts', 4, 'BUILD_URL', 'buildUrl')).toBe(true);
  });
});
