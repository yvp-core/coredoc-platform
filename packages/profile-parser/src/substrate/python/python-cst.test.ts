import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import {
  type TsNode,
  decoratorName,
  decoratorsOf,
  defName,
  hasDecorator,
  isAsyncDef,
  parsePython,
  pythonFunctionId,
  pythonScopeChain,
  undecorate,
} from './python-cst.js';

/** Same seed the parser uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');

/** All `function_definition` nodes in document order. */
function fnDefs(root: TsNode): TsNode[] {
  return root.descendantsOfType('function_definition') as TsNode[];
}

describe('pythonFunctionId — full-scope-chain decl ids (T2/eng)', () => {
  // Two DISTINCT nested defs both named `wrapper`: one inside `outer_a`, one
  // inside `class C` method `m`. A flat file+name id would collapse them.
  const SRC = `
def bar():
    return 1

def foo():
    return 2

class C:
    def foo(self):
        return 3

    @staticmethod
    def m(self):
        def wrapper():
            return 4
        return wrapper

def outer_a():
    def wrapper():
        return 5
    return wrapper
`;

  it('gives the two same-named nested `wrapper` defs DISTINCT ids', async () => {
    const root = await parsePython(SRC);
    const wrappers = fnDefs(root).filter((f) => defName(f) === 'wrapper');
    expect(wrappers).toHaveLength(2);

    const ids = wrappers.map((w) => pythonFunctionId(ID, 'app/svc.py', w));
    // Scope chains distinguish them: ['C','m'] vs ['outer_a'].
    const scopes = wrappers.map((w) => pythonScopeChain(w));
    expect(scopes).toContainEqual(['C', 'm']);
    expect(scopes).toContainEqual(['outer_a']);
    expect(ids[0]).not.toBe(ids[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it('gives a module-level `foo` and a method `C.foo` DISTINCT ids', async () => {
    const root = await parsePython(SRC);
    const foos = fnDefs(root).filter((f) => defName(f) === 'foo');
    expect(foos).toHaveLength(2);

    const moduleFoo = foos.find((f) => pythonScopeChain(f).length === 0)!;
    const methodFoo = foos.find((f) => pythonScopeChain(f).length > 0)!;
    expect(pythonScopeChain(methodFoo)).toEqual(['C']);

    const moduleId = pythonFunctionId(ID, 'app/svc.py', moduleFoo);
    const methodId = pythonFunctionId(ID, 'app/svc.py', methodFoo);
    // Module-level → functionId; method → methodId(scope join, name).
    expect(moduleId).toBe(ID.functionId('app/svc.py', 'foo'));
    expect(methodId).toBe(ID.methodId('app/svc.py', 'C', 'foo'));
    expect(moduleId).not.toBe(methodId);
  });

  it('flips ONLY the edited def versionedId (real content checksum)', async () => {
    const base = `
def bar():
    return 1

def foo():
    return 2
`;
    const edited = `
def bar():
    return 1

def foo():
    return 999
`;
    const findFoo = async (src: string) => fnDefs(await parsePython(src)).find((f) => defName(f) === 'foo')!;
    const findBar = async (src: string) => fnDefs(await parsePython(src)).find((f) => defName(f) === 'bar')!;

    const fooA = await findFoo(base);
    const fooB = await findFoo(edited);
    const barA = await findBar(base);
    const barB = await findBar(edited);

    const rel = 'app/svc.py';
    const fooIdA = pythonFunctionId(ID, rel, fooA);
    const fooIdB = pythonFunctionId(ID, rel, fooB);
    const barIdA = pythonFunctionId(ID, rel, barA);
    const barIdB = pythonFunctionId(ID, rel, barB);

    // Stable ids unchanged across the edit.
    expect(fooIdA).toBe(fooIdB);
    expect(barIdA).toBe(barIdB);

    const fooVerA = ID.versionedId(fooIdA, fooA.text as string);
    const fooVerB = ID.versionedId(fooIdB, fooB.text as string);
    const barVerA = ID.versionedId(barIdA, barA.text as string);
    const barVerB = ID.versionedId(barIdB, barB.text as string);

    // Editing foo's body flips ONLY foo's versionedId.
    expect(fooVerA).not.toBe(fooVerB);
    expect(barVerA).toBe(barVerB);
    // versionedId is a real checksum, not a constant @1.
    expect(fooVerA).not.toBe(`${fooIdA}@1`);
    expect(ID.getStableId(fooVerA)).toBe(fooIdA);
  });
});

describe('decorator machinery (T8/ceo)', () => {
  const SRC = `
@shared_task
async def process():
    pass

@app.task
def scheduled():
    pass

@router.get("/x")
def route_handler():
    pass

def plain():
    pass
`;

  it('unwraps decorated_definition and reads decorator names', async () => {
    const root = await parsePython(SRC);
    const process = fnDefs(root).find((f) => defName(f) === 'process')!;
    const scheduled = fnDefs(root).find((f) => defName(f) === 'scheduled')!;
    const route = fnDefs(root).find((f) => defName(f) === 'route_handler')!;
    const plain = fnDefs(root).find((f) => defName(f) === 'plain')!;

    // undecorate: decorated_definition → inner def; passthrough for a bare def.
    const dd = (root.descendantsOfType('decorated_definition') as TsNode[]).find(
      (d) => defName(undecorate(d)) === 'process',
    )!;
    expect(undecorate(dd).type).toBe('function_definition');
    expect(undecorate(plain).type).toBe('function_definition');
    expect(defName(undecorate(plain))).toBe('plain');

    expect(decoratorsOf(process)).toHaveLength(1);
    expect(decoratorName(decoratorsOf(process)[0])).toBe('shared_task');
    expect(decoratorName(decoratorsOf(scheduled)[0])).toBe('app.task');
    expect(decoratorName(decoratorsOf(route)[0])).toBe('router.get');
    expect(decoratorsOf(plain)).toEqual([]);
  });

  it('hasDecorator matches exact and dotted-suffix names; isAsyncDef detects async', async () => {
    const root = await parsePython(SRC);
    const process = fnDefs(root).find((f) => defName(f) === 'process')!;
    const scheduled = fnDefs(root).find((f) => defName(f) === 'scheduled')!;
    const plain = fnDefs(root).find((f) => defName(f) === 'plain')!;

    expect(hasDecorator(process, ['shared_task'])).toBe(true);
    // 'app.task' matches exactly; 'task' matches by dotted suffix.
    expect(hasDecorator(scheduled, ['app.task'])).toBe(true);
    expect(hasDecorator(scheduled, ['task'])).toBe(true);
    expect(hasDecorator(plain, ['shared_task', 'app.task'])).toBe(false);

    expect(isAsyncDef(process)).toBe(true);
    expect(isAsyncDef(scheduled)).toBe(false);
  });
});
