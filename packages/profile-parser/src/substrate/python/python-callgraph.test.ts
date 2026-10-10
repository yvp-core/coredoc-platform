import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type PythonFile } from './python-cst.js';
import { SHIPPABLE_PROVENANCE, indexPythonDefs, resolvePythonCalls } from './python-callgraph.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

const defsOf = (...args: Parameters<typeof indexPythonDefs>) => [...indexPythonDefs(...args).byId.values()];

const mkGen = () => new StableIdGenerator('/repo', 'repo');

async function file(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parseSource('python', source) };
}

/** Build the def index + resolve the shippable calls across a set of files. */
async function run(files: Array<{ relPath: string; source: string }>) {
  const idGen = mkGen();
  const pyFiles = await Promise.all(files.map((f) => file(f.relPath, f.source)));
  const index = indexPythonDefs(pyFiles, idGen);
  const { calls: edges, stats } = resolvePythonCalls(pyFiles, index, idGen);
  return { edges, stats, index, idGen, pyFiles };
}

const edgeFor = (edges: Awaited<ReturnType<typeof run>>['edges'], exprIncludes: string) =>
  edges.find((e) => e.calleeExpression.includes(exprIncludes));

describe('SHIPPABLE_PROVENANCE', () => {
  it('is exactly the three Python tiers', () => {
    expect([...SHIPPABLE_PROVENANCE].sort()).toEqual(['py-import', 'py-local', 'py-self']);
  });
});

describe('resolvePythonCalls — Tier-B precision-first resolution (S7)', () => {
  it('cross-file `from pkg.a import helper; helper(3)` → py-import edge to the imported def', async () => {
    const { edges, index } = await run([
      { relPath: 'pkg/a.py', source: 'def helper(x):\n    return x\n' },
      { relPath: 'pkg/b.py', source: 'from pkg.a import helper\n\n\ndef use():\n    helper(3)\n' },
    ]);
    const e = edgeFor(edges, 'helper(3)');
    expect(e).toBeDefined();
    expect(e?.provenance).toBe('py-import');
    // calleeId equals helper's FunctionNode id
    const helper = [...index.byId.values()].find((f) => f.name === 'helper');
    expect(helper).toBeDefined();
    expect(e?.calleeId).toBe(helper?.id);
    // caller is `use`
    const use = [...index.byId.values()].find((f) => f.name === 'use');
    expect(e?.callerId).toBe(use?.id);
    expect(e?.isMethodCall).toBe(false);
  });

  it('same-class `self.run()` calling a sibling method → py-self', async () => {
    const { edges, index } = await run([
      {
        relPath: 'svc.py',
        source: 'class Service:\n    def start(self):\n        self.run()\n\n    def run(self):\n        pass\n',
      },
    ]);
    const e = edgeFor(edges, 'self.run()');
    expect(e).toBeDefined();
    expect(e?.provenance).toBe('py-self');
    const runDef = [...index.byId.values()].find((f) => f.name === 'run');
    expect(e?.calleeId).toBe(runDef?.id);
    expect(e?.isMethodCall).toBe(true);
  });

  it('same-file module-level `g()` calling a local `def g` → py-local', async () => {
    const { edges, index } = await run([{ relPath: 'mod.py', source: 'def g():\n    pass\n\n\ndef h():\n    g()\n' }]);
    const e = edgeFor(edges, 'g()');
    expect(e).toBeDefined();
    expect(e?.provenance).toBe('py-local');
    const g = [...index.byId.values()].find((f) => f.name === 'g');
    expect(e?.calleeId).toBe(g?.id);
    expect(e?.isMethodCall).toBe(false);
  });

  it('external `requests.get(...)` (not in-repo) → NO shippable edge', async () => {
    const { edges } = await run([
      { relPath: 'client.py', source: 'import requests\n\n\ndef fetch():\n    requests.get("http://x")\n' },
    ]);
    expect(edgeFor(edges, 'requests.get')).toBeUndefined();
    expect(edges).toHaveLength(0);
  });

  it('`import pkg.a as m; m.helper()` module-alias attribute → py-import', async () => {
    const { edges, index } = await run([
      { relPath: 'pkg/a.py', source: 'def helper():\n    return 1\n' },
      { relPath: 'caller.py', source: 'import pkg.a as m\n\n\ndef use():\n    m.helper()\n' },
    ]);
    const e = edgeFor(edges, 'm.helper()');
    expect(e).toBeDefined();
    expect(e?.provenance).toBe('py-import');
    const helper = [...index.byId.values()].find((f) => f.name === 'helper');
    expect(e?.calleeId).toBe(helper?.id);
    expect(e?.isMethodCall).toBe(true);
  });

  it('self-recursion `def f(): f()` → self-edge dropped from the shippable set', async () => {
    const { edges } = await run([{ relPath: 'r.py', source: 'def f():\n    f()\n' }]);
    expect(edges).toHaveLength(0);
  });

  it('unknown-receiver instance call `obj.do()` → NO shippable edge (precision-first)', async () => {
    const { edges } = await run([{ relPath: 'u.py', source: 'def use(obj):\n    obj.do()\n' }]);
    expect(edges).toHaveLength(0);
  });
});

describe('resolvePythonCalls — precision-first remediation regressions (S7)', () => {
  it('cross-file same-class: `self.helper()` resolves within the CALLER file, not file A', async () => {
    // FIX 1: methodsByClass is file-qualified — two `class Svc` in different files must not collide.
    const { edges, index } = await run([
      {
        relPath: 'a.py',
        source:
          'class Svc:\n    def run(self):\n        return self.helper()\n\n    def helper(self):\n        return "A"\n',
      },
      {
        relPath: 'b.py',
        source:
          'class Svc:\n    def run(self):\n        return self.helper()\n\n    def helper(self):\n        return "B"\n',
      },
    ]);
    const all = [...index.byId.values()];
    const bRun = all.find((f) => f.name === 'run' && f.location.filePath === 'b.py');
    const bHelper = all.find((f) => f.name === 'helper' && f.location.filePath === 'b.py');
    const aHelper = all.find((f) => f.name === 'helper' && f.location.filePath === 'a.py');
    expect(bRun && bHelper && aHelper).toBeTruthy();
    const bEdge = edges.find((e) => e.callerId === bRun?.id && e.provenance === 'py-self');
    expect(bEdge).toBeDefined();
    // Before FIX 1 this resolved to file A's helper (first-file-wins collision).
    expect(bEdge?.calleeId).toBe(bHelper?.id);
    expect(bEdge?.calleeId).not.toBe(aHelper?.id);
  });

  it('LEGB shadowing: a nested def or a param named like a module fn drops the bare-call edge', async () => {
    // FIX 2: a local binding shadows the module-level def — precision-first, drop (do not mis-attribute).
    const src =
      'def helper():\n    return 1\n\n\n' +
      'def outer():\n    def helper():\n        return 2\n\n    return helper()\n\n\n' +
      'def run(helper):\n    return helper()\n';
    const { edges, index, idGen } = await run([{ relPath: 'm.py', source: src }]);
    const outer = [...index.byId.values()].find((f) => f.name === 'outer');
    const runFn = [...index.byId.values()].find((f) => f.name === 'run');
    const moduleHelperId = idGen.functionId('m.py', 'helper');
    // The nested-def call resolves to the local `helper`, NOT the module `helper` → no shippable edge.
    expect(edges.find((e) => e.callerId === outer?.id && e.calleeId === moduleHelperId)).toBeUndefined();
    // The param-shadowed call likewise makes no edge to the module `helper`.
    expect(edges.find((e) => e.callerId === runFn?.id && e.calleeId === moduleHelperId)).toBeUndefined();
    // No edge anywhere targets the module helper (it is never called by a resolvable site).
    expect(edges.some((e) => e.calleeId === moduleHelperId)).toBe(false);
  });

  it('aliased import: `from pkg.a import compute as calc; calc()` → py-import edge to compute', async () => {
    // FIX 3: the target-file lookup uses the imported SYMBOL, not the local alias.
    const { edges, index } = await run([
      { relPath: 'pkg/a.py', source: 'def compute():\n    return 1\n' },
      { relPath: 'pkg/b.py', source: 'from pkg.a import compute as calc\n\n\ndef use():\n    return calc()\n' },
    ]);
    const e = edgeFor(edges, 'calc()');
    // Before FIX 3 this produced ZERO edges (looked up `pkg/a.py#calc`, which does not exist).
    expect(e).toBeDefined();
    expect(e?.provenance).toBe('py-import');
    const compute = [...index.byId.values()].find((f) => f.name === 'compute');
    const use = [...index.byId.values()].find((f) => f.name === 'use');
    expect(e?.calleeId).toBe(compute?.id);
    expect(e?.callerId).toBe(use?.id);
  });

  it('TYPE_CHECKING-only import makes NO runtime edge', async () => {
    const { edges } = await run([
      { relPath: 'm.py', source: 'def f():\n    return 1\n' },
      {
        relPath: 'c.py',
        source:
          'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from m import f\n\n\ndef use():\n    return f()\n',
      },
    ]);
    expect(edgeFor(edges, 'f()')).toBeUndefined();
    expect(edges).toHaveLength(0);
  });

  it('star import `from m import *; foo()` → NO py-import edge (star dropped)', async () => {
    const { edges } = await run([
      { relPath: 'm.py', source: 'def foo():\n    return 1\n' },
      { relPath: 'c.py', source: 'from m import *\n\n\ndef use():\n    return foo()\n' },
    ]);
    expect(edgeFor(edges, 'foo()')).toBeUndefined();
    expect(edges).toHaveLength(0);
  });
});

describe('indexPythonDefs — structural extraction + two-ID integrity (S4)', () => {
  it('a nested def and a class method get DISTINCT ids and REAL versionedIds', async () => {
    const idGen = mkGen();
    const src =
      'class Svc:\n    def outer(self):\n        def helper():\n            return 1\n\n        return helper()\n';
    const defs = defsOf([await file('f.py', src)], idGen);

    const outer = defs.find((d) => d.name === 'outer');
    const helper = defs.find((d) => d.name === 'helper');
    expect(outer).toBeDefined();
    expect(helper).toBeDefined();

    // Distinct ids (scope-chain keyed): Svc.outer vs Svc.outer.helper.
    expect(outer?.id).not.toBe(helper?.id);
    expect(outer?.id).toContain(':Svc.outer');
    expect(helper?.id).toContain(':Svc.outer.helper');

    // kind + classId
    expect(outer?.kind).toBe('method');
    expect(helper?.kind).toBe('method'); // nested inside a class → still enclosed by CLASS_TYPES
    expect(outer?.classId).toBe(idGen.classId('f.py', 'Svc'));

    // REAL versionedIds: `id@<checksum>`, checksum is a content hash, never the constant '1'.
    for (const d of [outer, helper]) {
      expect(d?.versionedId.startsWith(`${d?.id}@`)).toBe(true);
      expect(idGen.getChecksum(d?.versionedId ?? '')).not.toBe('1');
      expect(idGen.getChecksum(d?.versionedId ?? '')).toBeTruthy();
    }
  });

  it('a module-level def and a same-named method get DISTINCT ids (function vs method)', async () => {
    const idGen = mkGen();
    const src = 'def run():\n    pass\n\n\nclass Svc:\n    def run(self):\n        pass\n';
    const defs = defsOf([await file('f.py', src)], idGen);
    const fn = defs.find((d) => d.kind === 'function' && d.name === 'run');
    const method = defs.find((d) => d.kind === 'method' && d.name === 'run');
    expect(fn).toBeDefined();
    expect(method).toBeDefined();
    expect(fn?.id).not.toBe(method?.id);
    expect(fn?.classId).toBeUndefined();
    expect(method?.classId).toBe(idGen.classId('f.py', 'Svc'));
    expect(fn?.id).toBe(idGen.functionId('f.py', 'run'));
    expect(method?.id).toBe(idGen.methodId('f.py', 'Svc', 'run'));
  });

  it('editing one function body flips ONLY that node versionedId', async () => {
    const idGen = mkGen();
    const v1 = defsOf([await file('f.py', 'def alpha():\n    return 1\n\n\ndef beta():\n    return 2\n')], idGen);
    const v2 = defsOf([await file('f.py', 'def alpha():\n    return 1\n\n\ndef beta():\n    return 99\n')], idGen);
    const a1 = v1.find((d) => d.name === 'alpha');
    const a2 = v2.find((d) => d.name === 'alpha');
    const b1 = v1.find((d) => d.name === 'beta');
    const b2 = v2.find((d) => d.name === 'beta');
    // Same stable id across edits for both.
    expect(a1?.id).toBe(a2?.id);
    expect(b1?.id).toBe(b2?.id);
    // Only beta's content changed → only beta's versionedId flips.
    expect(a1?.versionedId).toBe(a2?.versionedId);
    expect(b1?.versionedId).not.toBe(b2?.versionedId);
  });

  it('captures async, parameters, location, and caps sourceCode at 20000 chars', async () => {
    const idGen = mkGen();
    const src = 'async def handle(request, *args, **kwargs):\n    return 1\n';
    const defs = defsOf([await file('h.py', src)], idGen);
    const handle = defs.find((d) => d.name === 'handle');
    expect(handle?.isAsync).toBe(true);
    expect(handle?.isGenerator).toBe(false);
    expect(handle?.parameters.map((p) => p.name)).toEqual(['request', 'args', 'kwargs']);
    expect(handle?.location.filePath).toBe('h.py');
    expect(handle?.location.startLine).toBe(1);
    expect(handle?.fileId).toBe(idGen.fileId('h.py'));
    expect(handle?.sourceCode.length).toBeLessThanOrEqual(20000);
  });
});

describe('resolvePythonCalls — call-resolution stats (BR-1, BR-2, LIM-6)', () => {
  it('counts enumerated sites, shipped sites and sites naming nothing declared here', async () => {
    const { edges, stats } = await run([
      { relPath: 'pkg/a.py', source: 'def helper(x):\n    return x\n' },
      {
        relPath: 'pkg/b.py',
        source: 'from pkg.a import helper\n\n\ndef use(obj):\n    helper(3)\n    print("hi")\n    obj.helper()\n',
      },
    ]);
    // Three enumerated sites: the py-import one ships, `print` names nothing declared here, and
    // `obj.helper()` names a real def this substrate cannot bind — an in-scope miss, not a skip.
    expect(stats).toEqual({ callSites: 3, resolvedCalls: 1, outOfScopeCalls: 1 });
    expect(stats.resolvedCalls + stats.outOfScopeCalls).toBeLessThanOrEqual(stats.callSites);
    expect(edges).toHaveLength(1);
    expect(edges.some((e) => e.calleeExpression.includes('print'))).toBe(false);
  });

  it('keeps a platform call whose name IS declared in this repo in scope (BR-1 collision)', async () => {
    const { stats } = await run([
      { relPath: 'pkg/a.py', source: 'def print(msg):\n    return msg\n' },
      { relPath: 'pkg/b.py', source: 'def use():\n    print("hi")\n' },
    ]);
    expect(stats).toEqual({ callSites: 1, resolvedCalls: 0, outOfScopeCalls: 0 });
  });

  it('must NOT count a module-scope call site — it has no enclosing def (LIM-6)', async () => {
    // The import-time `helper()` really runs, but there is no def to attribute it to, so no
    // edge could ever be emitted for it. Counting it would grow the denominator with a site
    // the extractor was never able to answer for. The in-def sibling still counts.
    const { stats } = await run([
      { relPath: 'pkg/a.py', source: 'def helper():\n    return 1\n\n\nhelper()\n\n\ndef use():\n    helper()\n' },
    ]);
    expect(stats).toEqual({ callSites: 1, resolvedCalls: 1, outOfScopeCalls: 0 });
  });
});
