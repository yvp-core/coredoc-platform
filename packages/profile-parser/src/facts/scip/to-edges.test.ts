import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../graph/graph-builder.js';
import type { LoadedScip } from './decode.js';
import { buildMappingHooks, scipToEdges, tagExportedMonikers } from './to-edges.js';

function fn(g: CodeGraph, id: string, file: string, s: number, e: number, name = id) {
  g.addFunction({
    id,
    versionedId: `${id}@v`,
    name,
    kind: 'function',
    fileId: 'f',
    isAsync: false,
    isGenerator: false,
    parameters: [],
    location: { filePath: file, startLine: s, endLine: e },
  });
}

describe('scipToEdges', () => {
  it('emits in-repo CallEdge when reference resolves to an in-repo definition', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    fn(g, 'CALLER', 'a.ts', 10, 20); // getUser body lines 10-20
    fn(g, 'CALLEE', 'b.ts', 1, 5, 'load'); // load definition lines 1-5 (node name == moniker tail)

    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        // definition of CALLEE's symbol in b.ts
        {
          relativePath: 'b.ts',
          occurrences: [{ symbol: 'scip-typescript npm k . b.ts/Foo#load().', symbolRoles: 1, range: [0, 2, 6] }],
        },
        // reference to that symbol inside a.ts at line 14 (0-based 13)
        {
          relativePath: 'a.ts',
          occurrences: [{ symbol: 'scip-typescript npm k . b.ts/Foo#load().', symbolRoles: 0, range: [13, 4, 8] }],
        },
      ],
    };
    // map: symbol -> CALLEE node; enclosing: a.ts line 14 -> CALLER node
    scipToEdges(scip, g, idGen, {
      symbolToNodeId: () => 'CALLEE',
      enclosingNodeIdAt: (file, line) => (file === 'a.ts' && line === 14 ? 'CALLER' : undefined),
    });

    const edges = [...g.calls.values()];
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ callerId: 'CALLER', calleeId: 'CALLEE' });
  });

  it('mints the fresh edge with the readable moniker tail as calleeExpression; a non-re-parented id stays keyed on the symbol', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    fn(g, 'CALLER', 'a.ts', 10, 20);
    fn(g, 'CALLEE', 'b.ts', 1, 5, 'SdkVersionWarnings');
    const symbol = 'scip-typescript npm @acme/frontend 0.0.0 src/scenes/`SdkVersionWarnings.tsx`/SdkVersionWarnings().';
    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        { relativePath: 'b.ts', occurrences: [{ symbol, symbolRoles: 1, range: [0, 2, 6] }] },
        { relativePath: 'a.ts', occurrences: [{ symbol, symbolRoles: 0, range: [13, 4, 8] }] },
      ],
    };
    scipToEdges(scip, g, idGen, {
      symbolToNodeId: () => 'CALLEE',
      enclosingNodeIdAt: (file, line) => (file === 'a.ts' && line === 14 ? 'CALLER' : undefined),
    });
    const edges = [...g.calls.values()];
    expect(edges).toHaveLength(1);
    // The raw moniker must never reach output…
    expect(edges[0].calleeExpression).toBe('SdkVersionWarnings');
    // …while edge identity stays keyed on the symbol (artifact-cache stability).
    expect(edges[0].id).toBe(idGen.callEdgeId('CALLER', symbol, 'a.ts:14'));
  });

  it('emits ExternalCallEdge for an external npm moniker reference', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    fn(g, 'CALLER', 'a.ts', 10, 20);
    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        {
          relativePath: 'a.ts',
          occurrences: [
            {
              symbol: 'scip-typescript npm @nestjs/axios 2.0.0 http.service.d.ts/HttpService#get().',
              symbolRoles: 0,
              range: [13, 4, 8],
            },
          ],
        },
      ],
    };
    scipToEdges(scip, g, idGen, {
      symbolToNodeId: () => undefined, // not in-repo
      enclosingNodeIdAt: (file, line) => (file === 'a.ts' && line === 14 ? 'CALLER' : undefined),
    });
    const ext = [...g.externalCalls.values()];
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ callerId: 'CALLER', serviceName: '@nestjs/axios', method: 'get' });
    // NEW: the raw SCIP moniker is preserved for the cross-repo symbol hop.
    expect(ext[0].moniker).toEqual({
      packageName: '@nestjs/axios',
      descriptor: 'http.service.d.ts/HttpService#get().',
    });
  });

  it('preserves the package moniker descriptor for an in-workspace SDK consumer call', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    fn(g, 'CALLER', 'a.ts', 10, 20);
    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        {
          relativePath: 'a.ts',
          occurrences: [
            {
              symbol:
                'scip-typescript npm @sample/demo-api-client 0.208.0 src/`index.d.ts`/CalculationsClient#dailySummaries().',
              symbolRoles: 0,
              range: [13, 4, 8],
            },
          ],
        },
      ],
    };
    scipToEdges(scip, g, idGen, {
      symbolToNodeId: () => undefined,
      enclosingNodeIdAt: (file, line) => (file === 'a.ts' && line === 14 ? 'CALLER' : undefined),
    });
    const ext = [...g.externalCalls.values()];
    expect(ext).toHaveLength(1);
    expect(ext[0].serviceName).toBe('@sample/demo-api-client');
    expect(ext[0].method).toBe('dailySummaries');
    expect(ext[0].moniker).toEqual({
      packageName: '@sample/demo-api-client',
      descriptor: 'src/`index.d.ts`/CalculationsClient#dailySummaries().',
    });
  });

  it('collapses the structural sibling instead of duplicating when SCIP resolves a call site', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    fn(g, 'CALLER', 'a.ts', 10, 20);
    fn(g, 'CALLEE', 'b.ts', 1, 5, 'load'); // node name == moniker tail (`load`)
    // structural unresolved edge already present at a.ts:14
    g.addCall({
      id: 'struct1',
      callerId: 'CALLER',
      calleeExpression: 'this.foo.load',
      isMethodCall: true,
      location: { filePath: 'a.ts', startLine: 14, endLine: 14 },
    });
    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        {
          relativePath: 'b.ts',
          occurrences: [{ symbol: 'scip-typescript npm k . b.ts/Foo#load().', symbolRoles: 1, range: [0, 2, 6] }],
        },
        {
          relativePath: 'a.ts',
          occurrences: [{ symbol: 'scip-typescript npm k . b.ts/Foo#load().', symbolRoles: 0, range: [13, 4, 8] }],
        },
      ],
    };
    scipToEdges(scip, g, idGen, {
      symbolToNodeId: () => 'CALLEE',
      enclosingNodeIdAt: (file, line) => (file === 'a.ts' && line === 14 ? 'CALLER' : undefined),
    });
    expect(g.calls.size).toBe(1); // collapsed, not duplicated
    expect(g.calls.get('struct1')?.calleeId).toBe('CALLEE');
  });
});

describe('scipToEdges — cross-package workspace resolution (via buildMappingHooks)', () => {
  // pkg A (apps/server) imports+calls a function exported by pkg B (@coredoc/db). Because A
  // resolves the import through B's PUBLISHED declarations, the reference symbol carries a
  // `dist/`index.d.ts`` file part while B's definition carries `src/`db.ts`` — the exact symbol
  // strings differ, but the package + descriptor suffix match. The default mapping hooks must
  // still join them into an INTERNAL edge (A → B), not drop them or emit an external SDK call.
  const DEF = 'scip-typescript npm @coredoc/db 1.0.0 src/`db.ts`/containsSourceCode().';
  const REF = 'scip-typescript npm @coredoc/db 1.0.0 dist/`index.d.ts`/containsSourceCode().';

  it('resolves a call across a workspace-package boundary to the callee package source def', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    // caller `handler` in apps/server (call at line 14), callee `containsSourceCode` in packages/db
    fn(g, 'CALLER', 'apps/server/src/main.ts', 10, 20, 'handler');
    fn(g, 'CALLEE', 'packages/db/src/db.ts', 1, 3, 'containsSourceCode');

    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        // B's source definition (indexed via --pnpm-workspaces): src file part
        { relativePath: 'packages/db/src/db.ts', occurrences: [{ symbol: DEF, symbolRoles: 1, range: [0, 16, 33] }] },
        // A's reference: resolved through B's dist declarations → dist file part, same suffix
        { relativePath: 'apps/server/src/main.ts', occurrences: [{ symbol: REF, symbolRoles: 0, range: [13, 9, 26] }] },
      ],
    };
    scipToEdges(scip, g, idGen, buildMappingHooks(scip, g));

    const edges = [...g.calls.values()];
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ callerId: 'CALLER', calleeId: 'CALLEE' });
    // NOT emitted as an external SDK call — @coredoc/db is a workspace-internal package.
    expect(g.externalCalls.size).toBe(0);
  });

  it('leaves a genuine external package reference as an external edge (no in-repo definition)', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    fn(g, 'CALLER', 'apps/server/src/main.ts', 10, 20, 'handler');
    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        {
          relativePath: 'apps/server/src/main.ts',
          occurrences: [
            {
              symbol: 'scip-typescript npm @nestjs/axios 2.0.0 dist/`http.service.d.ts`/HttpService#get().',
              symbolRoles: 0,
              range: [13, 9, 12],
            },
          ],
        },
      ],
    };
    // No definition occurrence for @nestjs/axios exists in the index (it is not a workspace source
    // project), so the suffix fallback finds no def and the call correctly stays external.
    scipToEdges(scip, g, idGen, buildMappingHooks(scip, g));
    expect(g.calls.size).toBe(0);
    expect([...g.externalCalls.values()][0]).toMatchObject({ serviceName: '@nestjs/axios', method: 'get' });
  });

  it('does not cross-resolve when two files in one package share the same symbol suffix (ambiguous)', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    fn(g, 'CALLER', 'apps/server/src/main.ts', 10, 20, 'handler');
    fn(g, 'CALLEE_A', 'packages/db/src/a.ts', 1, 3, 'containsSourceCode');
    fn(g, 'CALLEE_B', 'packages/db/src/b.ts', 1, 3, 'containsSourceCode');
    const defA = 'scip-typescript npm @coredoc/db 1.0.0 src/`a.ts`/containsSourceCode().';
    const defB = 'scip-typescript npm @coredoc/db 1.0.0 src/`b.ts`/containsSourceCode().';
    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        { relativePath: 'packages/db/src/a.ts', occurrences: [{ symbol: defA, symbolRoles: 1, range: [0, 16, 33] }] },
        { relativePath: 'packages/db/src/b.ts', occurrences: [{ symbol: defB, symbolRoles: 1, range: [0, 16, 33] }] },
        { relativePath: 'apps/server/src/main.ts', occurrences: [{ symbol: REF, symbolRoles: 0, range: [13, 9, 26] }] },
      ],
    };
    scipToEdges(scip, g, idGen, buildMappingHooks(scip, g));
    // Ambiguous key → no internal edge (precision preserved); falls through to an external edge.
    expect(g.calls.size).toBe(0);
    expect([...g.externalCalls.values()][0]).toMatchObject({ serviceName: '@coredoc/db' });
  });
});

describe('scipToEdges — own-workspace-package symbols are never egress', () => {
  // An interface MEMBER is a non-local moniker in the repo's OWN package that resolves to no
  // function node (interfaces declare no bodies). Treating it as external destroyed the whole
  // call site: the structural sibling was deleted AND a self-referential "external service" was
  // minted, which the engine discards downstream — so the site vanished from the graph.
  const IFACE_MEMBER = 'scip-typescript npm @acme/workflows 1.0.0 src/`activities.ts`/IActivities#recalculate().';

  function graphWithStructuralSibling(): CodeGraph {
    const g = new CodeGraph();
    fn(g, 'CALLER', 'src/workflow.ts', 10, 20, 'runWorkflow');
    g.addCall({
      id: 'struct1',
      callerId: 'CALLER',
      calleeExpression: 'activities.recalculate',
      isMethodCall: true,
      location: { filePath: 'src/workflow.ts', startLine: 14, endLine: 14 },
    });
    return g;
  }

  const scipWith = (symbol: string): LoadedScip => ({
    projectRoot: 'file:///repo',
    documents: [{ relativePath: 'src/workflow.ts', occurrences: [{ symbol, symbolRoles: 0, range: [13, 4, 8] }] }],
  });

  const hooks = {
    symbolToNodeId: () => undefined, // an interface member is not a function node
    enclosingNodeIdAt: (file: string, line: number) =>
      file === 'src/workflow.ts' && line === 14 ? 'CALLER' : undefined,
  };

  it('keeps the unresolved structural sibling and emits no external for an own-package symbol', () => {
    const g = graphWithStructuralSibling();
    scipToEdges(scipWith(IFACE_MEMBER), g, new StableIdGenerator('/repo', 'k'), hooks, {
      workspacePackageNames: ['@acme/workflows'],
    });
    expect(g.externalCalls.size).toBe(0);
    expect(g.calls.get('struct1')).toBeDefined();
    expect(g.calls.get('struct1')?.calleeId).toBeUndefined();
  });

  it('still drops the sibling and emits the external edge for a genuine dependency package', () => {
    const g = graphWithStructuralSibling();
    scipToEdges(
      scipWith('scip-typescript npm @nestjs/axios 2.0.0 http.service.d.ts/HttpService#get().'),
      g,
      new StableIdGenerator('/repo', 'k'),
      hooks,
      { workspacePackageNames: ['@acme/workflows'] },
    );
    expect(g.calls.size).toBe(0);
    expect([...g.externalCalls.values()][0]).toMatchObject({ serviceName: '@nestjs/axios', method: 'get' });
  });
});

describe('tagExportedMonikers', () => {
  it('tags an exported method node with its own package moniker', () => {
    const g = new CodeGraph();
    // method node `dailySummaries` defined at calculations.ts:10-12
    g.addFunction({
      id: 'METHOD',
      versionedId: 'METHOD@v',
      name: 'dailySummaries',
      kind: 'method',
      fileId: 'f',
      isAsync: false,
      isGenerator: false,
      parameters: [],
      location: { filePath: 'src/lib/core/calculations.ts', startLine: 10, endLine: 12 },
    });
    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        {
          relativePath: 'src/lib/core/calculations.ts',
          occurrences: [
            {
              symbol:
                'scip-typescript npm @sample/demo-api-client 0.1.0 src/lib/core/`calculations.ts`/CalculationsClient#dailySummaries().',
              symbolRoles: 1, // definition
              range: [9, 2, 16], // 0-based line 9 → 1-based line 10
            },
          ],
        },
      ],
    };
    tagExportedMonikers(scip, g);
    expect(g.functions.get('METHOD')?.moniker).toEqual({
      packageName: '@sample/demo-api-client',
      descriptor: 'src/lib/core/`calculations.ts`/CalculationsClient#dailySummaries().',
    });
  });

  it('does not tag a node whose definition moniker is a noise package (TS stdlib / @types)', () => {
    const g = new CodeGraph();
    g.addFunction({
      id: 'METHOD',
      versionedId: 'METHOD@v',
      name: 'map',
      kind: 'method',
      fileId: 'f',
      isAsync: false,
      isGenerator: false,
      parameters: [],
      location: { filePath: 'src/x.ts', startLine: 1, endLine: 3 },
    });
    const scip: LoadedScip = {
      projectRoot: 'file:///repo',
      documents: [
        {
          relativePath: 'src/x.ts',
          // empty package field (`.`) = TS stdlib → noise.
          occurrences: [{ symbol: 'scip-typescript npm . . src/`x.ts`/map().', symbolRoles: 1, range: [0, 2, 5] }],
        },
      ],
    };
    tagExportedMonikers(scip, g);
    expect(g.functions.get('METHOD')?.moniker).toBeUndefined();
  });
});
