import { describe, expect, it } from 'vitest';
import { parseTsStructural } from './ts-structural.js';

const SRC = `
import { Foo } from './foo';
export class UserService {
  constructor(private readonly foo: Foo) {}
  async getUser(id: string) {
    return this.foo.load(id);
  }
}
export function helper() {
  return new UserService(null as any).getUser('1');
}
`;

describe('parseTsStructural', () => {
  it('extracts classes, methods, functions, imports, and call sites', async () => {
    const f = await parseTsStructural('src/user.service.ts', SRC, 'typescript');
    expect(f.classes.map((c) => c.name)).toContain('UserService');
    const cls = f.classes.find((c) => c.name === 'UserService')!;
    expect(cls.methods.map((m) => m.name)).toContain('getUser');
    // the constructor is NOT emitted as a method — it isn't one (params go to ctorParams instead)
    expect(cls.methods.map((m) => m.name)).not.toContain('constructor');
    // constructor parameter-property `private readonly foo: Foo` is captured as a ctorParam
    expect(cls.ctorParams.map((p) => p.name)).toContain('foo');
    expect(cls.ctorParams.find((p) => p.name === 'foo')?.type).toBe('Foo');
    expect(f.functions.map((fn) => fn.name)).toContain('helper');
    expect(f.imports.find((i) => i.moduleSpecifier === './foo')).toBeTruthy();
    // call site this.foo.load(id) recorded with receiver + method + enclosing method name
    const load = f.calls.find((c) => c.methodName === 'load');
    expect(load?.receiver).toBe('this.foo');
    expect(load?.enclosingName).toBe('getUser');
    expect(load?.enclosingClass).toBe('UserService');
    // `new UserService(...)` inside `helper` is a construction candidate on the same-file class,
    // and the value import of `Foo` is an import candidate — both carried for downstream identity.
    expect(f.classRefs).toContainEqual(
      expect.objectContaining({ className: 'UserService', refKind: 'construction', enclosingName: 'helper' }),
    );
    expect(f.classRefs).toContainEqual(
      expect.objectContaining({ className: 'Foo', refKind: 'import', importedFrom: './foo' }),
    );
  });

  it('refuses class-reference candidates a module cannot decide: dotted ctors, locals, type-only imports', async () => {
    const SRC2 = `
import type { OnlyType } from './types';
import { type InlineType, Value } from './mixed';
import Default from './default';
import * as ns from './ns';

export function make() {
  const local = { Klass: class {} };
  return [new ns.Widget(), new Default(), new local.Klass(), new Value()];
}
`;
    const f = await parseTsStructural('src/refs.ts', SRC2, 'typescript');
    const names = (f.classRefs ?? []).map((r) => `${r.refKind}:${r.className}`);
    // Only the named VALUE import survives, as both an import candidate and the construction one.
    expect(names.sort()).toEqual(['construction:Value', 'import:Value']);
  });

  it('extracts abstract classes, their concrete + abstract methods, and intra-class this.method() edges', async () => {
    const ABS = `
export abstract class Telemetry {
  abstract send(): void;
  doThing(): void {
    this.send();
  }
}
abstract class BaseBodyContentRequest<T> {
  build(): T {
    return this.make();
  }
  abstract make(): T;
}
`;
    const f = await parseTsStructural('src/telemetry.ts', ABS, 'typescript');
    const tel = f.classes.find((c) => c.name === 'Telemetry')!;
    expect(tel).toBeTruthy();
    expect(tel.isAbstract).toBe(true);
    expect(tel.isExported).toBe(true);
    // both the concrete method and the abstract method signature are registered
    expect(tel.methods.map((m) => m.name).sort()).toEqual(['doThing', 'send']);
    // generic abstract class is extracted too
    const base = f.classes.find((c) => c.name === 'BaseBodyContentRequest')!;
    expect(base).toBeTruthy();
    expect(base.isAbstract).toBe(true);
    expect(base.methods.map((m) => m.name).sort()).toEqual(['build', 'make']);
    // the intra-class this.method() call inside an abstract-class method is recorded
    const sendCall = f.calls.find((c) => c.methodName === 'send' && c.receiver === 'this');
    expect(sendCall?.enclosingClass).toBe('Telemetry');
    expect(sendCall?.enclosingName).toBe('doThing');
  });

  it('extracts module-scope interfaces, type aliases, enums, and variables (and skips nested ones)', async () => {
    const TYPES = `
export interface Config extends Base, Other {
  name: string;
  ttl?: number;
  readonly id: string;
  greet(x: number): void;
  [key: string]: unknown;
}
type Handler = (app: App) => App;
export const enum Color { Red = 'red', Green = 'green' }
enum Plain { A, B }
export const TOKEN: string = 'tok';
let counter = compute();
const { a, b } = destructure();
export const make = () => 1;
function fn() {
  interface Nested {}
  const inner = 1;
  type T = number;
}
`;
    const f = await parseTsStructural('src/types.ts', TYPES, 'typescript');

    // interface: module-scope only (Nested is excluded), with extends + members + flags
    expect(f.interfaces?.map((i) => i.name)).toEqual(['Config']);
    const cfg = (f.interfaces ?? []).find((i) => i.name === 'Config')!;
    expect(cfg.isExported).toBe(true);
    expect(cfg.extends).toEqual(['Base', 'Other']);
    expect(cfg.members.find((m) => m.name === 'ttl')?.isOptional).toBe(true);
    expect(cfg.members.find((m) => m.name === 'id')?.isReadonly).toBe(true);
    expect(cfg.members.find((m) => m.name === 'greet')?.kind).toBe('method');
    expect(cfg.members.some((m) => m.kind === 'index')).toBe(true);

    // type alias: module-scope only (T inside fn excluded)
    expect(f.typeAliases?.map((t) => t.name)).toEqual(['Handler']);
    expect(f.typeAliases?.[0].isExported).toBe(false);
    expect(f.typeAliases?.[0].aliasedType).toContain('App');

    // enums: const-enum flag + auto-numbered members
    expect(f.enums?.map((e) => e.name).sort()).toEqual(['Color', 'Plain']);
    const color = (f.enums ?? []).find((e) => e.name === 'Color')!;
    expect(color.isConst).toBe(true);
    expect(color.isExported).toBe(true);
    expect(color.members).toEqual([
      { name: 'Red', value: 'red' },
      { name: 'Green', value: 'green' },
    ]);
    const plain = (f.enums ?? []).find((e) => e.name === 'Plain')!;
    expect(plain.members).toEqual([
      { name: 'A', value: undefined },
      { name: 'B', value: undefined },
    ]);

    // variables: module-scope non-function decls (TOKEN const, counter let, destructuring pattern);
    // `make` (arrow fn) becomes a function, not a variable; nested `inner` excluded.
    const varNames = f.variables?.map((v) => v.name) ?? [];
    expect(varNames).toContain('TOKEN');
    expect(varNames).toContain('counter');
    expect(varNames).toContain('{ a, b }');
    expect(varNames).not.toContain('make');
    expect(varNames).not.toContain('inner');
    expect(f.functions.map((fn) => fn.name)).toContain('make');
    const token = (f.variables ?? []).find((v) => v.name === 'TOKEN')!;
    expect(token.declarationKind).toBe('const');
    expect(token.isExported).toBe(true);
    expect(token.type).toBe('string');
    expect(f.variables?.find((v) => v.name === 'counter')?.declarationKind).toBe('let');
  });

  it('extracts ambient (`declare`) interfaces as module-scope', async () => {
    const AMBIENT = `export declare interface InjectionCommands { run: () => void; }`;
    const f = await parseTsStructural('src/ambient.ts', AMBIENT, 'typescript');
    expect(f.interfaces?.map((i) => i.name)).toEqual(['InjectionCommands']);
    expect(f.interfaces?.[0].isExported).toBe(true);
  });

  it('captures decorators on exported classes, methods, and properties (preceding-sibling form)', async () => {
    const DECO = `
import { Controller, Get, Entity, Column } from 'x';
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(id: string) {
    return id;
  }
}
@Entity('user')
export class User {
  @Column({ name: 'email' })
  email: string;
}
`;
    const f = await parseTsStructural('src/u.ts', DECO, 'typescript');
    const ctrl = f.classes.find((c) => c.name === 'UsersController')!;
    expect(ctrl.decorators.some((d) => d.startsWith('Controller'))).toBe(true);
    expect(ctrl.methods[0].decorators.some((d) => d.startsWith('Get'))).toBe(true);
    const ent = f.classes.find((c) => c.name === 'User')!;
    expect(ent.decorators.some((d) => d.startsWith('Entity'))).toBe(true);
    expect(ent.properties[0].decorators.some((d) => d.startsWith('Column'))).toBe(true);
  });

  it('captures the full decorator stack when comments interleave it', async () => {
    const DECO = `
import { Controller, Get, WorkspaceRole, RequirePermission } from 'x';
@Controller('sessions')
export class SessionsController {
  @Get('summary')
  @WorkspaceRole('member')
  // Service tokens need an explicit read grant here.
  @RequirePermission('result:read')
  summary() {
    return [];
  }
}
`;
    const f = await parseTsStructural('src/s.ts', DECO, 'typescript');
    const m = f.classes.find((c) => c.name === 'SessionsController')!.methods[0];
    expect(m.decorators.some((d) => d.startsWith('Get'))).toBe(true);
    expect(m.decorators.some((d) => d.startsWith('WorkspaceRole'))).toBe(true);
    expect(m.decorators.some((d) => d.startsWith('RequirePermission'))).toBe(true);
  });

  it('captures arrow-fn consts, object methods, and function expressions as functions', async () => {
    const SRC = `
export const handleRequest = async (ctx) => { return ctx.body; };
const helpers = {
  format(x) { return x; },
  parse: function (y) { return y; },
};
`;
    const f = await parseTsStructural('src/handlers.ts', SRC, 'typescript');
    const names = f.functions.map((fn) => fn.name);
    expect(names).toContain('handleRequest'); // arrow assigned to const
    expect(names).toContain('format'); // object shorthand method
    expect(names).toContain('parse'); // function expression in object
    expect(f.functions.find((fn) => fn.name === 'handleRequest')?.isExported).toBe(true);
    expect(f.functions.find((fn) => fn.name === 'handleRequest')?.isAsync).toBe(true);
  });

  it('attributes calls inside arrow-fn / object-method / function-expression bodies to those functions', async () => {
    const SRC = `
export const handleRequest = async (ctx) => { someService(ctx); return ctx.body; };
const helpers = {
  format(x) { formatHelper(x); return x; },
  parse: function (y) { parseHelper(y); return y; },
};
`;
    const f = await parseTsStructural('src/handlers.ts', SRC, 'typescript');
    // arrow-fn const body: call attributes to the function node 'handleRequest'
    const inArrow = f.calls.find((c) => c.methodName === 'someService');
    expect(inArrow?.enclosingKind).toBe('function');
    expect(inArrow?.enclosingName).toBe('handleRequest');
    expect(inArrow?.enclosingClass).toBeUndefined();
    // object shorthand method body: must NOT be kind 'method' (no class) — attributes as a function
    const inObjMethod = f.calls.find((c) => c.methodName === 'formatHelper');
    expect(inObjMethod?.enclosingKind).toBe('function');
    expect(inObjMethod?.enclosingName).toBe('format');
    expect(inObjMethod?.enclosingClass).toBeUndefined();
    // function expression in object body: attributes to the function node 'parse'
    const inFnExpr = f.calls.find((c) => c.methodName === 'parseHelper');
    expect(inFnExpr?.enclosingKind).toBe('function');
    expect(inFnExpr?.enclosingName).toBe('parse');
    expect(inFnExpr?.enclosingClass).toBeUndefined();
  });

  it('attributes calls inside an anonymous call-argument callback to a synthetic function (resolveAnonCallbacks)', async () => {
    // The residual recall hole: an anonymous arrow/fn-expression passed as a CALL ARGUMENT
    // (`router.get('/x', (req,res) => …)`, `arr.forEach(item => …)`) is not bound to a
    // variable/pair, so its body's calls fall through to module scope and are dropped. With
    // resolveAnonCallbacks the callback is promoted to a citable function node and its inner
    // calls attribute to it — so `find_callers(handleUser)` is no longer empty.
    const SRC = `
const router = makeRouter();
router.get('/x', (req, res) => { handleUser(req); });
arr.forEach((item) => { processItem(item); });
`;
    // Flag OFF (default): legacy behavior — the inner call falls through to module scope.
    const off = await parseTsStructural('src/routes.ts', SRC, 'typescript');
    expect(off.calls.find((c) => c.methodName === 'handleUser')?.enclosingKind).toBe('module');

    // Flag ON: the anonymous callback becomes a function; its inner call attributes to it.
    const on = await parseTsStructural('src/routes.ts', SRC, 'typescript', { resolveAnonCallbacks: true });
    const inner = on.calls.find((c) => c.methodName === 'handleUser');
    expect(inner?.enclosingKind).toBe('function');
    expect(inner?.enclosingClass).toBeUndefined();
    // Synthetic name is derived from the enclosing call (callee@argIndex#line), stable + unique.
    expect(inner?.enclosingName).toContain('router.get');
    // The callback itself is emitted as a function node under the SAME synthetic name, so the
    // to-nodes/SCIP layers can resolve the inner edge (functionId(file, syntheticName) matches).
    expect(on.functions.some((fn) => fn.name === inner?.enclosingName)).toBe(true);
    // forEach callback is promoted too.
    expect(on.calls.find((c) => c.methodName === 'processItem')?.enclosingKind).toBe('function');
  });

  it('does NOT promote a callback nested in a method — inner calls stay attributed to the method', async () => {
    // The fragmentation guard: a callback nested in a named method/function already has a real caller
    // (the method) to attribute its inner calls to. Promoting it would re-attribute those calls to an
    // orphan node behind a dropped builtin (`.forEach`), fragmenting the graph — so it must be left alone.
    const SRC = `
class SchedulesService {
  process(items) {
    items.forEach((item) => { this.handle(item); });
  }
}
`;
    const on = await parseTsStructural('src/svc.ts', SRC, 'typescript', { resolveAnonCallbacks: true });
    const inner = on.calls.find((c) => c.methodName === 'handle');
    // attributes to the enclosing METHOD, not a synthetic callback
    expect(inner?.enclosingKind).toBe('method');
    expect(inner?.enclosingName).toBe('process');
    expect(inner?.enclosingClass).toBe('SchedulesService');
    // no synthetic function node was emitted for the nested forEach callback
    expect(on.functions.some((f) => /@\d+#\d+$/.test(f.name))).toBe(false);
  });

  it('captures const-literal, string-object, and string-enum value bindings', async () => {
    const SRC = `
export const TOPIC = 'orders';
const ROUTES = { users: '/users', me: '/me' };
export enum Topics { Sum = 'sum-all', Fwd = 'forward' }
const NOT_STRINGS = { n: 1, f: () => 2 };
`;
    const f = await parseTsStructural('src/constants.ts', SRC, 'typescript');
    const byName = new Map(f.valueBindings!.map((b) => [b.name, b]));
    expect(byName.get('TOPIC')).toMatchObject({ kind: 'literal', literal: 'orders', isExported: true });
    expect(byName.get('ROUTES')).toMatchObject({ kind: 'object', members: { users: '/users', me: '/me' } });
    expect(byName.get('Topics')).toMatchObject({ kind: 'enum', members: { Sum: 'sum-all', Fwd: 'forward' } });
    // object with no string members is omitted (nothing to resolve)
    expect(byName.has('NOT_STRINGS')).toBe(false);
  });

  it('captures named and star re-exports (export ... from), ignores local exports', async () => {
    const SRC = `
export * from './metrics';
export { KAFKA_EVENT_STAGE } from './kafka.const';
export { Foo as Bar } from './foo';
const Local = 1;
export { Local };
`;
    const f = await parseTsStructural('src/constants/index.ts', SRC, 'typescript');
    const re = f.reExports!;
    expect(re.find((r) => r.kind === 'star' && r.moduleSpecifier === './metrics')).toBeTruthy();
    const named = re.find((r) => r.moduleSpecifier === './kafka.const');
    expect(named?.kind).toBe('named');
    expect(named?.names).toEqual([{ name: 'KAFKA_EVENT_STAGE' }]);
    const aliased = re.find((r) => r.moduleSpecifier === './foo');
    expect(aliased?.names).toEqual([{ name: 'Foo', alias: 'Bar' }]);
    // `export { Local }` (no `from`) is a local export, not a re-export
    expect(re.some((r) => r.moduleSpecifier === '')).toBe(false);
  });

  it('captures return types for function declarations, arrow consts, and class methods', async () => {
    const SRC = `
export function f(a: string, b?: number): Promise<void> { return; }
export const g = async (x: number): number => x;
export class C {
  async m(p: string): Promise<number> { return 1; }
}
function untyped(a) { return a; }
`;
    const file = await parseTsStructural('src/rt.ts', SRC, 'typescript');
    const f = file.functions.find((fn) => fn.name === 'f')!;
    expect(f.returnType).toBe('Promise<void>');
    // Each param carries its annotation text AND the parsed structure of the same annotation.
    expect(f.params).toEqual([
      {
        name: 'a',
        type: 'string',
        typeInfo: { text: 'string', structure: { kind: 'primitive', name: 'string' } },
        isOptional: false,
        isRest: false,
      },
      {
        name: 'b',
        type: 'number',
        typeInfo: { text: 'number', structure: { kind: 'primitive', name: 'number' } },
        isOptional: true,
        isRest: false,
      },
    ]);
    expect(file.functions.find((fn) => fn.name === 'g')!.returnType).toBe('number');
    const m = file.classes.find((c) => c.name === 'C')!.methods.find((mm) => mm.name === 'm')!;
    expect(m.returnType).toBe('Promise<number>');
    // an unannotated function has no structural return type (mapping layer defaults it to `any`)
    expect(file.functions.find((fn) => fn.name === 'untyped')!.returnType).toBeUndefined();
  });

  it('extracts JavaScript function parameters (bare identifier, default, rest, destructuring)', async () => {
    // Regression: the JS grammar exposes params as bare `identifier`/pattern nodes (not the TS
    // `required_parameter` wrapper), so a `type.includes('parameter')` filter dropped every JS param.
    const SRC = `
function normalizedToday(ctx) { return ctx.query.today; }
function withDefault(a, b = 1) { return a + b; }
function withRest(first, ...rest) { return rest.length; }
function destructured({ id }, [head]) { return id; }
`;
    const file = await parseTsStructural('app/handlers/schedules.js', SRC, 'javascript');
    expect(file.functions.find((fn) => fn.name === 'normalizedToday')!.params).toEqual([
      { name: 'ctx', type: undefined, isOptional: false, isRest: false },
    ]);
    const wd = file.functions.find((fn) => fn.name === 'withDefault')!;
    expect(wd.params.map((p) => p.name)).toEqual(['a', 'b']);
    expect(wd.params.find((p) => p.name === 'b')!.isOptional).toBe(true);
    const wr = file.functions.find((fn) => fn.name === 'withRest')!;
    expect(wr.params.map((p) => p.name)).toEqual(['first', 'rest']);
    expect(wr.params.find((p) => p.name === 'rest')!.isRest).toBe(true);
    // both destructuring patterns are captured as params (not dropped)
    expect(file.functions.find((fn) => fn.name === 'destructured')!.params).toHaveLength(2);
  });

  it('captures leading JSDoc on functions, exported functions, classes, methods, and arrow consts', async () => {
    const SRC = `
/** Plain helper. */
function plain() {}
/** Exported fn. */
export function exported() {}
/**
 * A service.
 * Multi-line.
 */
@Injectable()
export class Svc {
  /** Does the thing. */
  doThing(): void {}
}
/** Arrow doc. */
export const arrow = () => {};
// not jsdoc
function noDoc() {}
`;
    const f = await parseTsStructural('src/doc.ts', SRC, 'typescript');
    expect(f.functions.find((fn) => fn.name === 'plain')!.documentation).toBe('Plain helper.');
    expect(f.functions.find((fn) => fn.name === 'exported')!.documentation).toBe('Exported fn.');
    expect(f.functions.find((fn) => fn.name === 'arrow')!.documentation).toBe('Arrow doc.');
    const svc = f.classes.find((c) => c.name === 'Svc')!;
    // decorator sits between the JSDoc and the class — must still resolve the doc
    expect(svc.documentation).toBe('A service.\nMulti-line.');
    expect(svc.methods.find((m) => m.name === 'doThing')!.documentation).toBe('Does the thing.');
    // a non-JSDoc line comment is not documentation
    expect(f.functions.find((fn) => fn.name === 'noDoc')!.documentation).toBeUndefined();
  });

  it('keeps only the JSDoc description, dropping @param/@returns tag lines (ts-morph getComment parity)', async () => {
    const SRC = `
/**
 * Adds two numbers.
 * More detail.
 * @param a first
 * @param b second
 * @returns the sum
 */
export function add(a: number, b: number): number { return a + b; }
/** @internal only a tag */
export function tagOnly() {}
`;
    const f = await parseTsStructural('src/doc.ts', SRC, 'typescript');
    expect(f.functions.find((fn) => fn.name === 'add')!.documentation).toBe('Adds two numbers.\nMore detail.');
    // a tags-only block has no description text → undefined (ts-morph getComment() yields '')
    expect(f.functions.find((fn) => fn.name === 'tagOnly')!.documentation).toBeUndefined();
  });

  it('captures call arguments as expression-text strings', async () => {
    const ARGS_SRC = `function reg() { initHandler(SHIFTS_JOB, onMsg, { concurrency: 2 }); }`;
    const f = await parseTsStructural('src/r.ts', ARGS_SRC, 'typescript');
    const call = f.calls.find((c) => c.methodName === 'initHandler' || c.expressionText === 'initHandler');
    expect(call?.arguments).toEqual(['SHIFTS_JOB', 'onMsg', '{ concurrency: 2 }']);
  });

  it('extracts receiver/method/args for awaited calls carrying generic type arguments', async () => {
    // `await x.m<A, B<C>, D>(…)` mis-parses in the tree-sitter TS grammar so the
    // call_expression's `function` field is the whole `await_expression`; the walker must
    // unwrap it, else receiver is lost and the call is mis-read as a bare callee `await x.m`.
    const SRC = `
class S {
  async run() {
    const a = await this.axios.request<TResponse, AxiosResponse<TResponse>, TData>({ method, url });
    const b = await axios.get<never, AxiosResponse<string>>('/metrics', { timeout: 5 });
    const c = await this.httpService.axiosRef.post<{ content: Resp }>('/u', body);
  }
}`;
    const f = await parseTsStructural('src/s.ts', SRC, 'typescript');
    const req = f.calls.find((c) => c.methodName === 'request');
    expect(req?.receiver).toBe('this.axios');
    expect(req?.isAwaited).toBe(true);
    const get = f.calls.find((c) => c.methodName === 'get');
    expect(get?.receiver).toBe('axios');
    expect(get?.arguments[0]).toBe("'/metrics'");
    const post = f.calls.find((c) => c.methodName === 'post');
    expect(post?.receiver).toBe('this.httpService.axiosRef');
    expect(post?.arguments[0]).toBe("'/u'");
  });

  it('captures the implements clause alongside extends, generic arguments stripped from the base name', async () => {
    const SRC = `
class Repo extends BaseRepo<User> implements UserPort, Disposable, Mapper<User, Row>, ns.Legacy {}
class Plain {}
`;
    const f = await parseTsStructural('src/repo.ts', SRC, 'typescript');
    const repo = f.classes.find((c) => c.name === 'Repo')!;
    expect(repo.extendsClass).toEqual({ name: 'BaseRepo', typeArgs: ['User'] });
    // `Mapper<User, Row>` is the interface `Mapper`; a namespace-qualified base keeps its text.
    expect(repo.implementsNames).toEqual(['UserPort', 'Disposable', 'Mapper', 'ns.Legacy']);
    // A class with no heritage says so with an empty list, never a missing field.
    expect(f.classes.find((c) => c.name === 'Plain')!.implementsNames).toEqual([]);
  });

  it('keeps a generic base interface in the extends list', async () => {
    const SRC = 'interface Page<T> extends Base, Paged<T> {}';
    const f = await parseTsStructural('src/page.ts', SRC, 'typescript');
    expect(f.interfaces?.[0].extends).toEqual(['Base', 'Paged']);
  });
});
