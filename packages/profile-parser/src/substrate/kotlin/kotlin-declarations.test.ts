import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { extractKotlinFileFacts, toKotlinFile, type KotlinFileFacts } from './kotlin-declarations.js';

const idGen = new StableIdGenerator('repo-key');

async function facts(relPath: string, source: string): Promise<KotlinFileFacts> {
  return extractKotlinFileFacts(await toKotlinFile(relPath, source), idGen);
}

describe('package, imports and the FQCN index', () => {
  it('keys every declaration by its package-qualified name, nested names included', async () => {
    const f = await facts(
      'a/Impl.kt',
      ['package a.b', '', 'class Outer {', '  class Inner', '}', 'object Holder'].join('\n'),
    );
    expect(f.packageName).toBe('a.b');
    expect([...f.declarations.keys()].sort()).toEqual(['a.b.Outer', 'a.b.Outer.Inner', 'a.b.Holder'].sort());
    expect(f.declarations.get('a.b.Outer.Inner')?.qualifiedName).toBe('Outer.Inner');
  });

  it('ANTI: a file with no package header uses the root package, not a fabricated one', async () => {
    const f = await facts('a/Impl.kt', 'class C');
    expect(f.packageName).toBe('');
    expect([...f.declarations.keys()]).toEqual(['C']);
  });

  it('records imports with their alias and wildcard flag, one per distinct path', async () => {
    const f = await facts(
      'a/Impl.kt',
      ['package a', 'import x.y.Thing', 'import x.y.Thing', 'import x.y.Other as Alias', 'import x.z.*'].join('\n'),
    );
    expect(f.imports.map((i) => `${i.path}|${i.localName}|${i.isWildcard}`)).toEqual([
      'x.y.Thing|Thing|false',
      'x.y.Other|Alias|false',
      'x.z|*|true',
    ]);
  });
});

describe('emitted nodes per declaration kind', () => {
  it('emits an EnumNode AND a ClassNode facet when an enum declares a function', async () => {
    const f = await facts(
      'a/K.kt',
      ['package a', 'enum class Kind {', '  ONE, TWO;', '  fun label(): String = "k"', '}'].join('\n'),
    );
    expect(f.enums.map((e) => e.name)).toEqual(['Kind']);
    expect(f.enums[0].members.map((m) => m.name)).toEqual(['ONE', 'TWO']);
    expect(f.classes.map((c) => c.name)).toEqual(['Kind']);
    const method = f.functions.find((fn) => fn.name === 'label');
    expect(method?.kind).toBe('method');
    expect(method?.classId).toBe(f.classes[0].id);
  });

  it('ANTI: an enum with no members declares no ClassNode facet', async () => {
    const f = await facts('a/K.kt', 'package a\nenum class Kind { ONE, TWO }');
    expect(f.enums).toHaveLength(1);
    expect(f.classes).toEqual([]);
  });

  it('emits an InterfaceNode plus a ClassNode facet when an interface declares functions', async () => {
    const f = await facts('a/R.kt', ['package a', 'interface Repo {', '  fun get(id: Int): Thing', '}'].join('\n'));
    expect(f.interfaces.map((i) => i.name)).toEqual(['Repo']);
    expect(f.interfaces[0].members.map((m) => `${m.kind}:${m.name}`)).toEqual(['method:get']);
    expect(f.classes.map((c) => c.name)).toEqual(['Repo']);
    expect(f.functions[0].classId).toBe(f.classes[0].id);
    expect(f.classes[0].isAbstract).toBe(true);
  });

  it('ANTI: a marker interface with no members emits no ClassNode facet', async () => {
    const f = await facts('a/M.kt', 'package a\ninterface Marker');
    expect(f.interfaces).toHaveLength(1);
    expect(f.classes).toEqual([]);
  });

  it('reads supertypes, annotations, constructor properties and abstractness', async () => {
    const f = await facts(
      'a/T.kt',
      [
        'package a',
        '@Entity(tableName = "things")',
        'sealed class Thing(val id: Int, var name: String) : Base(), Marker',
      ].join('\n'),
    );
    const cls = f.classes[0];
    expect(cls.isAbstract).toBe(true);
    expect(cls.extends?.name).toBe('Base');
    expect(cls.implements?.map((i) => i.name)).toEqual(['Marker']);
    expect(cls.decorators?.map((d) => d.name)).toEqual(['Entity']);
    expect(cls.properties.map((p) => `${p.name}:${p.isReadonly}`)).toEqual(['id:true', 'name:false']);
  });

  it('emits a TypeAliasNode and a file-level VariableNode', async () => {
    const f = await facts('a/T.kt', 'package a\ntypealias Things = List<Thing>\nval topLevel = 1');
    expect(f.typeAliases.map((t) => `${t.name}=${t.aliasedType.text}`)).toEqual(['Things=List<Thing>']);
    expect(f.variables.map((v) => `${v.name}:${v.declarationKind}`)).toEqual(['topLevel:const']);
  });
});

describe('companions and objects are static members, never synthetic classes', () => {
  it('lifts companion members onto the enclosing class as static', async () => {
    const f = await facts(
      'a/I.kt',
      [
        'package a',
        'class Impl {',
        '  companion object {',
        '    const val TABLE = "things"',
        '    fun make(): Impl = Impl()',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(f.classes.map((c) => c.name)).toEqual(['Impl']);
    const make = f.functions.find((fn) => fn.name === 'make');
    expect(make?.isStatic).toBe(true);
    expect(make?.classId).toBe(f.classes[0].id);
    expect(f.classes[0].properties.find((p) => p.name === 'TABLE')?.isStatic).toBe(true);
  });

  it('ANTI: no `Companion` and no file-facade class is emitted', async () => {
    const f = await facts(
      'a/I.kt',
      ['package a', 'class Impl {', '  companion object {', '    fun make() {}', '  }', '}', 'fun topLevel() {}'].join(
        '\n',
      ),
    );
    expect(f.classes.map((c) => c.name)).toEqual(['Impl']);
    expect([...f.declarations.keys()]).toEqual(['a.Impl']);
  });

  it('an object declaration is its own class with static members', async () => {
    const f = await facts('a/H.kt', 'package a\nobject Holder {\n  const val TABLE = "things"\n}');
    expect(f.declarations.get('a.Holder')?.kind).toBe('object');
    expect(f.classes.map((c) => c.name)).toEqual(['Holder']);
  });
});

describe('functions — file level is decided by the PARENT node', () => {
  it('emits a file-level function, naming an extension by its receiver', async () => {
    const f = await facts(
      'a/F.kt',
      ['package a', 'suspend fun top(n: Int): Thing = x', 'fun List<Thing>.firstNamed(n: String): Thing = x'].join(
        '\n',
      ),
    );
    expect(f.functions.map((fn) => `${fn.kind}:${fn.name}:${fn.isAsync}`)).toEqual([
      'function:top:true',
      'function:List.firstNamed:false',
    ]);
    expect(f.functions[0].id).toBe(idGen.functionId('a/F.kt', 'top'));
    expect(f.functions[0].parameters.map((p) => p.name)).toEqual(['n']);
  });

  it('ANTI: the `fun interface` member is NOT emitted as a top-level function', async () => {
    const f = await facts(
      'a/C.kt',
      ['package a', 'fun interface Cb { fun on(v: Int) }', 'fun realTop() {}'].join('\n'),
    );
    expect(f.hasSyntaxError).toBe(true);
    expect(f.functions.map((fn) => fn.name)).toEqual(['realTop']);
  });

  it('ANTI: a local function and one inside a lambda emit no FunctionNode', async () => {
    const f = await facts(
      'a/L.kt',
      ['package a', 'fun top() {', '  fun local() {}', '  run { fun inLambda() {} }', '}'].join('\n'),
    );
    expect(f.functions.map((fn) => fn.name)).toEqual(['top']);
  });

  it('ANTI: overloads collapse to the first in source order', async () => {
    const f = await facts('a/O.kt', 'package a\nfun f(a: Int) {}\nfun f(a: String) {}');
    expect(f.functions).toHaveLength(1);
    expect(f.functions[0].parameters[0].type?.text).toBe('Int');
  });

  it('a member function is a method with its class id and a KDoc', async () => {
    const f = await facts(
      'a/I.kt',
      ['package a', 'class Impl {', '  /** Fetches it. */', '  private fun get(id: Int): Thing = x', '}'].join('\n'),
    );
    const m = f.functions[0];
    expect(m.kind).toBe('method');
    expect(m.id).toBe(idGen.methodId('a/I.kt', 'Impl', 'get'));
    expect(m.visibility).toBe('private');
    expect(m.documentation).toBe('Fetches it.');
    expect(f.declarations.get('a.Impl')?.methodsByName.get('get')).toBe(m.id);
  });

  it('carries the declaration text as sourceCode for a file function and for a method', async () => {
    const f = await facts(
      'a/S.kt',
      ['package a', 'fun top(n: Int): Int {', '  return n + 1', '}', 'class Impl {', '  fun get() = 7', '}'].join('\n'),
    );
    const top = f.functions.find((fn) => fn.name === 'top');
    const get = f.functions.find((fn) => fn.name === 'get');
    expect(top?.sourceCode).toBe('fun top(n: Int): Int {\n  return n + 1\n}');
    expect(get?.sourceCode).toBe('fun get() = 7');
  });

  it('caps a pathological body at 20000 chars', async () => {
    const body = Array.from({ length: 3000 }, (_, i) => `  val v${i} = ${i}`).join('\n');
    const f = await facts('a/Big.kt', ['package a', 'fun big() {', body, '}'].join('\n'));
    expect(f.functions[0].sourceCode).toHaveLength(20000);
    expect(f.functions[0].sourceCode?.startsWith('fun big() {')).toBe(true);
  });
});

describe('call sites carry their enclosing emitted function', () => {
  it('attributes a call inside an anonymous object body to the enclosing function', async () => {
    const f = await facts(
      'a/T.kt',
      [
        'package a',
        'class Impl {',
        '  fun setUp() {',
        '    register(object : Callback {',
        '      override fun onDone() { report("done") }',
        '    })',
        '  }',
        '}',
      ].join('\n'),
    );
    const setUp = f.functions.find((fn) => fn.name === 'setUp');
    const report = f.calls.find((c) => c.name === 'report');
    expect(report).toBeDefined();
    expect(report?.enclosingFunctionId).toBe(setUp?.id);
    expect(report?.enclosingClassFqcn).toBe('a.Impl');
    // The anonymous object emits no node of its own.
    expect(f.classes.map((c) => c.name)).toEqual(['Impl']);
  });

  it('attributes a call inside a lambda to the enclosing function', async () => {
    const f = await facts('a/T.kt', 'package a\nfun top() { items.forEach { report(it) } }');
    expect(f.calls.map((c) => c.name)).toContain('report');
    expect(f.calls.every((c) => c.enclosingFunctionId === f.functions[0].id)).toBe(true);
  });

  it('ANTI: a call outside any emitted function is recorded as no call site', async () => {
    const f = await facts('a/T.kt', 'package a\nval x = compute()');
    expect(f.calls).toEqual([]);
  });

  it('separates a bare call from a method call and keeps the receiver', async () => {
    const f = await facts('a/T.kt', 'package a\nfun top() { bare(); dep.member(1) }');
    const bare = f.calls.find((c) => c.name === 'bare');
    const member = f.calls.find((c) => c.name === 'member');
    expect(bare?.isMethodCall).toBe(false);
    expect(bare?.receiverName).toBeUndefined();
    expect(member?.isMethodCall).toBe(true);
    expect(member?.receiverName).toBe('dep');
    expect(member?.args).toHaveLength(1);
  });
});

describe('DI, Koin bindings, strings and create sites', () => {
  it('records a delegated DI property and its explicit type', async () => {
    const f = await facts(
      'a/I.kt',
      ['package a', 'class Impl {', '  private val dep: Repo by inject()', '  val vm by viewModel<Model>()', '}'].join(
        '\n',
      ),
    );
    const decl = f.declarations.get('a.Impl');
    expect(decl?.diProperties.get('dep')).toEqual({ accessor: 'inject', typeName: 'Repo' });
    expect(decl?.diProperties.get('vm')).toEqual({ accessor: 'viewModel', typeName: 'Model' });
    expect(decl?.propertyTypes.get('vm')).toBe('Model');
  });

  it('ANTI: a `by lazy {}` property is not a DI property', async () => {
    const f = await facts('a/I.kt', 'package a\nclass Impl { val one by lazy { Thing(1) } }');
    expect(f.declarations.get('a.Impl')?.diProperties.size).toBe(0);
  });

  it('records Koin bindings in both the type-argument and the qualifier shape', async () => {
    const f = await facts(
      'a/M.kt',
      ['package a', 'fun mod() {', '  single<Repo> { Impl() }', '  single(named("api")) { Other() }', '}'].join('\n'),
    );
    expect(f.koinBindings.map((b) => `${b.builder}|${b.declaredType}|${b.implType}|${b.qualifier}`)).toEqual([
      'single|Repo|Impl|undefined',
      'single|undefined|Other|api',
    ]);
  });

  it('records a create site and the type it names', async () => {
    const f = await facts('a/N.kt', 'package a\nfun build() { retrofit.create(Repo::class.java) }');
    expect(f.createSites.map((s) => s.targetType)).toEqual(['Repo']);
  });

  it('ANTI: a create call with no class literal names no target type', async () => {
    const f = await facts('a/N.kt', 'package a\nfun build() { factory.create(config) }');
    expect(f.createSites.map((s) => s.targetType)).toEqual([undefined]);
  });

  it('records string literals with interpolations rendered as templates', async () => {
    const f = await facts('a/S.kt', 'package a\nfun q() { exec("SELECT * FROM $TABLE") }');
    expect(f.strings.map((s) => s.value)).toEqual(['SELECT * FROM {TABLE}']);
  });

  it('records local bindings typed by a declaration or by a constructor call', async () => {
    const f = await facts(
      'a/B.kt',
      [
        'package a',
        'fun top() {',
        '  val a: Repo = make()',
        '  val b = Impl()',
        '  val c = get<Thing>()',
        '  val d = compute()',
        '}',
      ].join('\n'),
    );
    expect(f.localBindings.map((b) => `${b.name}:${b.typeName}:${b.diAccessor}`)).toEqual([
      'a:Repo:undefined',
      'b:Impl:undefined',
      'c:Thing:get',
      'd:undefined:undefined',
    ]);
  });
});

describe('annotation index', () => {
  it('ANTI: a property id is minted by the generator, never hand-built as `classId#name`', async () => {
    const f = await facts(
      'a/Thing.kt',
      ['package a', 'class Thing(val id: Int) {', '  val name: String = ""', '}'].join('\n'),
    );
    const cls = f.classes[0];
    const expected = (name: string) => idGen.generateNodeId('variable', 'a/Thing.kt', `${cls.id}.${name}`);
    expect(cls.properties.map((p) => p.id)).toEqual([expected('id'), expected('name')]);
    expect(cls.properties.some((p) => p.id.includes('#'))).toBe(false);
  });

  it('indexes annotations on classes, functions, properties and parameters', async () => {
    const f = await facts(
      'a/D.kt',
      [
        'package a',
        '@Dao',
        'interface Things {',
        '  @Query("SELECT * FROM things")',
        '  fun all(): List<Thing>',
        '  @Transaction',
        '  fun both()',
        '}',
      ].join('\n'),
    );
    expect([...f.annotationIndex.keys()].sort()).toEqual(['Dao', 'Query', 'Transaction']);
    expect(f.annotationIndex.get('Query')).toHaveLength(1);
    expect(f.declarations.get('a.Things')?.annotations).toEqual(['Dao']);
  });

  it('ANTI: an unannotated declaration adds nothing to the index', async () => {
    const f = await facts('a/D.kt', 'package a\ninterface Things { fun all() }');
    expect(f.annotationIndex.size).toBe(0);
  });
});

describe('syntax errors', () => {
  it('walks the declarations outside an ERROR subtree rather than throwing', async () => {
    const f = await facts('a/E.kt', 'package a\nfun interface Cb { fun on(v: Int) }\nclass Impl { fun go() {} }');
    expect(f.hasSyntaxError).toBe(true);
    expect(f.classes.map((c) => c.name)).toEqual(['Impl']);
  });

  it('ANTI: a clean file reports no syntax error', async () => {
    expect((await facts('a/E.kt', 'package a\nclass Impl')).hasSyntaxError).toBe(false);
  });
});
