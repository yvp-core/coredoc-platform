import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { resolveKotlinCalls } from './kotlin-callgraph.js';
import { extractKotlinFileFacts, toKotlinFile, type KotlinFileFacts } from './kotlin-declarations.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';

const idGen = new StableIdGenerator('repo-key');

async function scope(files: Record<string, string>): Promise<KotlinFileFacts[]> {
  const out: KotlinFileFacts[] = [];
  for (const [relPath, source] of Object.entries(files)) {
    out.push(extractKotlinFileFacts(await toKotlinFile(relPath, source), idGen));
  }
  return out;
}

async function resolveAll(files: Record<string, string>) {
  const facts = await scope(files);
  return { facts, ...resolveKotlinCalls(facts, new KotlinTypeIndex(facts), idGen) };
}

/** `<calleeExpression> -> <callee function name>@<provenance>`, the readable edge shape. */
function shape(facts: KotlinFileFacts[], calls: ReturnType<typeof resolveKotlinCalls>['calls']): string[] {
  const names = new Map(facts.flatMap((f) => f.functions.map((fn) => [fn.id, fn.name] as const)));
  return calls.map((c) => `${c.calleeExpression} -> ${names.get(c.calleeId ?? '') ?? '?'}@${c.provenance}`);
}

describe('kt-local', () => {
  it('binds a bare call to a file-level function of the same file, then of the same package', async () => {
    const { facts, calls, stats } = await resolveAll({
      'a/Helpers.kt': 'package a\nfun helper(): Int = 1',
      'a/Use.kt': ['package a', 'fun here(): Int = 2', 'fun caller() {', '  here()', '  helper()', '}'].join('\n'),
    });
    expect(shape(facts, calls)).toEqual(['here -> here@kt-local', 'helper -> helper@kt-local']);
    expect(stats.byTier).toEqual({ 'kt-local': 2 });
  });

  it('ANTI: a package-level name declared by two files is not unique, so nothing resolves', async () => {
    const { calls, stats } = await resolveAll({
      'a/One.kt': 'package a\nfun helper(): Int = 1',
      'a/Two.kt': 'package a\nfun helper(): Int = 2',
      'b/Use.kt': 'package a\nfun caller() {\n  helper()\n}',
    });
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 1, resolvedCalls: 0 });
  });
});

describe('kt-member precedence over kt-local', () => {
  it('binds a bare call inside a class to the class member, not to the top-level function', async () => {
    const { facts, calls } = await resolveAll({
      'a/Repo.kt': [
        'package a',
        'fun save() {}',
        'class Repo {',
        '  fun save(x: Int) {}',
        '  fun caller() {',
        '    save()',
        '  }',
        '}',
      ].join('\n'),
    });
    expect(shape(facts, calls)).toEqual(['save -> save@kt-member']);
    // Both are named `save`: the id is what says which one the edge landed on.
    expect(calls[0].calleeId).not.toBe(facts[0].functions[0].id);
  });

  it('also outranks a top-level function declared in another file of the same package', async () => {
    const { facts, calls } = await resolveAll({
      'a/TopLevel.kt': 'package a\nfun save() {}',
      'a/Repo.kt': ['package a', 'class Repo {', '  fun save() {}', '  fun caller() {', '    save()', '  }', '}'].join(
        '\n',
      ),
    });
    expect(shape(facts, calls)).toEqual(['save -> save@kt-member']);
    expect(calls[0].calleeId).toBe(facts[1].functions[0].id);
  });

  // TWIN: outside a class there is no member to prefer, so the top-level function still wins.
  it('binds the same bare call outside any class to the top-level function', async () => {
    const { facts, calls } = await resolveAll({
      'a/Repo.kt': ['package a', 'fun save() {}', 'class Repo {', '  fun save() {}', '}'].join('\n'),
      'a/Use.kt': 'package a\nfun caller() {\n  save()\n}',
    });
    expect(shape(facts, calls)).toEqual(['save -> save@kt-local']);
    expect(calls[0].calleeId).toBe(facts[0].functions[0].id);
  });
});

describe('kt-member', () => {
  it('binds a bare and a this-call to the class, its supertype and its companion', async () => {
    const { facts, calls } = await resolveAll({
      'a/Base.kt': 'package a\nopen class Base {\n  fun fromBase() {}\n}',
      'a/Impl.kt': [
        'package a',
        'class Impl : Base() {',
        '  companion object {',
        '    fun statics() {}',
        '  }',
        '  fun own() {}',
        '  fun caller() {',
        '    own()',
        '    this.fromBase()',
        '    statics()',
        '  }',
        '}',
      ].join('\n'),
    });
    // GRAMMAR: a `this_expression` root is not part of `calleeText`, so a `this.m()` site's
    // calleeExpression is the bare member name.
    expect(shape(facts, calls)).toEqual([
      'own -> own@kt-member',
      'fromBase -> fromBase@kt-member',
      'statics -> statics@kt-member',
    ]);
  });
});

describe('kt-import', () => {
  it('binds a bare call through an explicit import of a top-level function', async () => {
    const { facts, calls } = await resolveAll({
      'a/Helpers.kt': 'package a.b\nfun helper(): Int = 1',
      'a/Use.kt': 'package a.c\nimport a.b.helper\nfun caller() {\n  helper()\n}',
    });
    expect(shape(facts, calls)).toEqual(['helper -> helper@kt-import']);
  });

  it('ANTI: an explicit import of an EXTERNAL type stops the receiver from binding an in-repo namesake', async () => {
    const { calls, stats } = await resolveAll({
      'internal/Client.kt': 'package internal\nclass Client {\n  fun send() {}\n}',
      'app/Use.kt': ['package app', 'import vendor.Client', 'fun caller(c: Client) {', '  c.send()', '}'].join('\n'),
    });
    // `c` is the vendor's `Client`; the repo's `internal.Client` is a different class that
    // happens to share a simple name, so the edge is a fabrication, not a miss worth closing.
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 1, resolvedCalls: 0, ambiguousCalls: 0 });
  });

  it('binds `X.m()` to a static member of the class X resolves to', async () => {
    const { facts, calls } = await resolveAll({
      'a/Thing.kt': 'package a\nclass Thing {\n  companion object {\n    fun build() {}\n  }\n}',
      'a/Use.kt': 'package a\nfun caller() {\n  Thing.build()\n}',
    });
    expect(shape(facts, calls)).toEqual(['Thing.build -> build@kt-import']);
  });
});

describe('kt-type', () => {
  it('follows a declared local, a parameter and a property to the method of that type', async () => {
    const { facts, calls } = await resolveAll({
      'a/Repo.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'a/Use.kt': [
        'package a',
        'class Use {',
        '  private val prop: Repo = Repo()',
        '  fun caller(param: Repo) {',
        '    val local: Repo = Repo()',
        '    local.fetch()',
        '    param.fetch()',
        '    prop.fetch()',
        '  }',
        '}',
      ].join('\n'),
    });
    expect(shape(facts, calls)).toEqual([
      'local.fetch -> fetch@kt-type',
      'param.fetch -> fetch@kt-type',
      'prop.fetch -> fetch@kt-type',
    ]);
  });

  it('follows a DI accessor carrying an explicit type', async () => {
    const { facts, calls } = await resolveAll({
      'a/Repo.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'a/Use.kt': [
        'package a',
        'class Use {',
        '  private val injected: Repo by inject()',
        '  fun caller() {',
        '    val got = get<Repo>()',
        '    injected.fetch()',
        '    got.fetch()',
        '  }',
        '}',
      ].join('\n'),
    });
    expect(shape(facts, calls)).toEqual(['injected.fetch -> fetch@kt-type', 'got.fetch -> fetch@kt-type']);
  });

  it('ANTI: `it`, a view binding and a Java-typed receiver emit nothing', async () => {
    const { calls, stats } = await resolveAll({
      'a/Repo.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'a/Use.kt': [
        'package a',
        'class Use {',
        '  private val binding = ThingBinding.inflate()',
        '  fun caller(items: List<Repo>) {',
        '    val file = java.io.File("x")',
        '    file.delete()',
        '    binding.root.fetch()',
        '    items.forEach { it.fetch() }',
        '  }',
        '}',
      ].join('\n'),
    });
    expect(calls).toEqual([]);
    expect(stats.resolvedCalls).toBe(0);
    expect(stats.ambiguousCalls).toBe(0);
  });

  it('ANTI: a `T.create()` factory receiver is not followed', async () => {
    const { calls } = await resolveAll({
      'a/Api.kt': 'package a\ninterface Api {\n  fun fetch()\n}',
      'a/Factory.kt': 'package a\nclass Factory {\n  companion object {\n    fun create(): Api = TODO()\n  }\n}',
      'a/Use.kt': 'package a\nfun caller() {\n  val api = Factory.create()\n  api.fetch()\n}',
    });
    expect(calls.map((c) => c.calleeExpression)).toEqual(['Factory.create']);
  });
});

describe('iface-impl', () => {
  it('retargets to the sole in-scope implementation', async () => {
    const { facts, calls } = await resolveAll({
      'a/Repo.kt': 'package a\ninterface Repo {\n  fun fetch()\n}',
      'a/Impl.kt': 'package a\nclass Impl : Repo {\n  override fun fetch() {}\n}',
      'a/Use.kt': 'package a\nfun caller(repo: Repo) {\n  repo.fetch()\n}',
    });
    expect(shape(facts, calls)).toEqual(['repo.fetch -> fetch@iface-impl']);
    expect(calls[0].calleeId).toBe(facts[1].functions[0].id);
  });

  it('ANTI: two implementations abstain — the edge stays on the interface member', async () => {
    const { facts, calls } = await resolveAll({
      'a/Repo.kt': 'package a\ninterface Repo {\n  fun fetch()\n}',
      'a/Impl.kt': 'package a\nclass Impl : Repo {\n  override fun fetch() {}\n}',
      'a/Other.kt': 'package a\nclass Other : Repo {\n  override fun fetch() {}\n}',
      'a/Koin.kt': ['package a', 'fun module() {', '  single<Repo> { Impl() }', '  single<Repo> { Other() }', '}'].join(
        '\n',
      ),
      'a/Use.kt': 'package a\nfun caller(repo: Repo) {\n  repo.fetch()\n}',
    });
    expect(calls.map((c) => c.provenance)).toContain('kt-type');
    expect(calls.map((c) => c.calleeId)).toContain(facts[0].functions[0].id);
    expect(calls.map((c) => c.provenance)).not.toContain('iface-impl');
  });
});

describe('a receiver that names a value is not the type of the same name', () => {
  it('reads a parameter shadowing an object declaration as the parameter', async () => {
    const { facts, calls } = await resolveAll({
      'a/Client.kt': 'package a\nobject Client {\n  fun send() {}\n}',
      'a/Other.kt': 'package a\nclass Other {\n  fun send() {}\n}',
      'a/Use.kt': 'package a\nfun run(Client: Other) {\n  Client.send()\n}',
    });
    expect(shape(facts, calls)).toEqual(['Client.send -> send@kt-type']);
    expect(calls[0].calleeId).toBe(facts[1].functions[0].id);
  });

  // TWIN: with no value of that name in scope, the receiver IS the object and its member binds.
  it('reads the same receiver with no binding in scope as the object declaration', async () => {
    const { facts, calls } = await resolveAll({
      'a/Client.kt': 'package a\nobject Client {\n  fun send() {}\n}',
      'a/Other.kt': 'package a\nclass Other {\n  fun send() {}\n}',
      'a/Use.kt': 'package a\nfun run() {\n  Client.send()\n}',
    });
    expect(shape(facts, calls)).toEqual(['Client.send -> send@kt-import']);
    expect(calls[0].calleeId).toBe(facts[0].functions[0].id);
  });
});

describe('a local binding that cannot be placed abstains', () => {
  // `localBindings` carries no offset, so `val x: B` inside an inner block cannot be told from
  // one covering the whole body. Typing all three sites as `B` gets two of them wrong.
  it('ANTI: a local shadowing a same-named parameter types no site of that name', async () => {
    const { calls, stats } = await resolveAll({
      'a/A.kt': 'package a\nclass A { fun send() {} }',
      'a/B.kt': 'package a\nclass B { fun send() {} }',
      'a/Use.kt': [
        'package a',
        'class Use {',
        '  fun caller(x: A) {',
        '    x.send()',
        '    run {',
        '      val x: B = B()',
        '      x.send()',
        '    }',
        '    x.send()',
        '  }',
        '}',
      ].join('\n'),
    });
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 3, resolvedCalls: 0, ambiguousCalls: 0 });
  });

  // TWIN: a local that shadows nothing is still the receiver's type.
  it('types a local that collides with no parameter or property', async () => {
    const { facts, calls } = await resolveAll({
      'a/B.kt': 'package a\nclass B { fun send() {} }',
      'a/Use.kt': ['package a', 'fun caller() {', '  val x: B = B()', '  x.send()', '}'].join('\n'),
    });
    expect(shape(facts, calls)).toEqual(['x.send -> send@kt-type']);
  });
});

describe('receivers the chain root disqualifies', () => {
  it('ANTI: `this.a.b()` is a property chain, never a member of the enclosing class', async () => {
    const { calls, stats } = await resolveAll({
      'a/Child.kt': 'package a\nclass Child {\n  fun save() {}\n}',
      'a/Parent.kt': [
        'package a',
        'class Parent {',
        '  val child: Child = Child()',
        '  fun save() {}',
        '  fun caller() {',
        '    this.child.save()',
        '  }',
        '}',
      ].join('\n'),
    });
    // Binding it to `Parent.save` — the member of the enclosing class — was a fabricated edge.
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 1, resolvedCalls: 0, ambiguousCalls: 0 });
  });

  it('ANTI: a chained (`a.b().c()`) and a postfix (`x!!.d()`) receiver bind to no file-level function', async () => {
    const { calls, stats } = await resolveAll({
      'a/Use.kt': [
        'package a',
        'fun helper() {}',
        'fun other(): Use = TODO()',
        'class Use {',
        '  fun make(): Use = this',
        '  fun caller(u: Use?) {',
        '    other().helper()',
        '    u!!.helper()',
        '  }',
        '}',
      ].join('\n'),
    });
    // The inner `other()` is its own site and resolves; the two chained/postfix receivers do not.
    expect(calls.map((c) => c.calleeExpression)).toEqual(['other']);
    expect(stats.byTier).toEqual({ 'kt-local': 1 });
  });
});

describe('ambiguity, candidates and the one-edge-per-site invariant', () => {
  it('ANTI: a call onto a duplicated FQCN emits nothing and counts as ambiguous', async () => {
    const { calls, stats } = await resolveAll({
      'main/Repo.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'flavor/Repo.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'a/Use.kt': 'package a\nfun caller(repo: Repo) {\n  repo.fetch()\n}',
    });
    expect(calls).toEqual([]);
    expect(stats.ambiguousCalls).toBe(1);
    expect(stats.resolvedCalls).toBe(0);
    expect(stats.callSites).toBe(1);
  });

  it('skips scope functions and constructors of emitted classes as candidates', async () => {
    const { calls, stats } = await resolveAll({
      'a/Repo.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'a/Use.kt': ['package a', 'fun caller() {', '  val r = Repo()', '  r.let { }', '  r.fetch()', '}'].join('\n'),
    });
    expect(stats.callSites).toBe(1);
    expect(calls.map((c) => c.calleeExpression)).toEqual(['r.fetch']);
  });

  it('ANTI: a trailing-lambda call counts ONE site, not the outer and inner node', async () => {
    const { stats } = await resolveAll({
      'a/Use.kt': ['package a', 'fun caller() {', '  outer(1) {', '    inner(2) { }', '  }', '}'].join('\n'),
    });
    // Two source calls. Counting the grammar's outer+inner `call_expression` reported four and
    // halved the resolution rate this number is the denominator of.
    expect(stats.callSites).toBe(2);
  });

  it('counts each call of a CHAIN as its own site, unlike the trailing-lambda duplicate', async () => {
    const { calls, stats } = await resolveAll({
      'a/Use.kt': ['package a', 'fun make(): String = "x"', 'fun caller() {', '  make().trim()', '}'].join('\n'),
    });
    // `make()` and `.trim()` are two calls the grammar nests at ONE offset: `make` resolves
    // here, `trim` is the stdlib. Keying the site on the offset erased the second and reported
    // 1 site / 1 resolved — a 100% rate over half the calls.
    expect(calls.map((c) => c.calleeExpression)).toEqual(['make']);
    expect(stats).toMatchObject({ callSites: 2, resolvedCalls: 1, outOfScopeCalls: 1 });
  });

  it('holds `resolvedCalls + outOfScopeCalls <= callSites` over a mixed body', async () => {
    const { stats } = await resolveAll({
      'a/Repo.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'a/Use.kt': [
        'package a',
        'fun make(): String = "x"',
        'fun caller(repo: Repo) {',
        '  make().trim().length()',
        '  repo.fetch()',
        '  outer(1) { Log.d("t", "m") }',
        '  Unknown.gone()',
        '}',
      ].join('\n'),
    });
    expect(stats.resolvedCalls + stats.outOfScopeCalls).toBeLessThanOrEqual(stats.callSites);
    expect(stats.resolvedCalls + stats.ambiguousCalls).toBeLessThanOrEqual(stats.callSites);
  });

  // The denominator of the reported rate. A call to a name this repo never declares has no
  // possible target here, so counting it as a miss reports a defect that does not exist.
  it('counts a call to a name declared nowhere in the repo as out of scope, not as a miss', async () => {
    const { stats } = await resolveAll({
      'a/Use.kt': ['package a', 'fun caller() {', '  android.util.Log.d("t", "m")', '  Toast.makeText(ctx)', '}'].join(
        '\n',
      ),
    });
    expect(stats.resolvedCalls).toBe(0);
    expect(stats.outOfScopeCalls).toBe(stats.callSites);
  });

  // ANTI: the classifier keys on the NAME alone, so a call this repo could plausibly own stays
  // in the denominator even when it does not bind. The rate understates us; it never flatters.
  it('keeps an unresolved call to a name this repo DOES declare inside the denominator', async () => {
    const { stats } = await resolveAll({
      'a/Own.kt': 'package a\nclass Holder {\n  fun submit() {}\n}',
      // `submit` is declared here, but the receiver type is unknowable, so the site is a real
      // miss rather than a platform call.
      'a/Use.kt': ['package a', 'fun caller(x: Unknown) {', '  x.submit()', '}'].join('\n'),
    });
    expect(stats.resolvedCalls).toBe(0);
    expect(stats.outOfScopeCalls).toBe(0);
    expect(stats.callSites).toBe(1);
  });

  it('emits exactly one edge per call site, with the site-determined id', async () => {
    const { facts, calls, stats } = await resolveAll({
      'a/Repo.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'a/Use.kt': ['package a', 'fun caller(repo: Repo) {', '  repo.fetch()', '  repo.fetch()', '}'].join('\n'),
    });
    expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
    expect(calls).toHaveLength(2);
    expect(stats.resolvedCalls).toBe(calls.length);
    const caller = facts[1].functions[0];
    expect(calls[0].id).toBe(idGen.callEdgeId(caller.id, 'repo.fetch', 'a/Use.kt:3'));
    expect(calls[0].callerId).toBe(caller.id);
    expect(calls[0].isMethodCall).toBe(true);
  });
});

describe('kt-type over a qualified receiver', () => {
  it('walks an object member property to the method it declares', async () => {
    const { facts, calls, stats } = await resolveAll({
      'a/Api.kt': [
        'package a',
        'class Repo {',
        '  fun fetch() {}',
        '}',
        'object Api {',
        '  val repo: Repo = Repo()',
        '}',
      ].join('\n'),
      'a/Use.kt': 'package a\nfun caller() {\n  Api.repo.fetch()\n}',
    });
    expect(shape(facts, calls)).toEqual(['Api.repo.fetch -> fetch@kt-type']);
    expect(stats).toMatchObject({ resolvedCalls: 1, ambiguousCalls: 0 });
  });

  it('walks a companion property of a class root', async () => {
    const { facts, calls } = await resolveAll({
      'a/Holder.kt': [
        'package a',
        'class Holder {',
        '  companion object {',
        '    val current: Holder = Holder()',
        '  }',
        '  fun use() {}',
        '}',
      ].join('\n'),
      'a/Use.kt': 'package a\nfun caller() {\n  Holder.current.use()\n}',
    });
    expect(shape(facts, calls)).toEqual(['Holder.current.use -> use@kt-type']);
  });

  it('binds `X.m()` on an object declaration, whose members are reached through the type name', async () => {
    const { facts, calls } = await resolveAll({
      'a/Registry.kt': 'package a\nobject Registry {\n  fun keyOf(s: String): String = s\n}',
      'a/Use.kt': 'package a\nfun caller() {\n  Registry.keyOf("done")\n}',
    });
    expect(shape(facts, calls)).toEqual(['Registry.keyOf -> keyOf@kt-import']);
  });

  it('retargets a sole implementation reached through a qualified receiver', async () => {
    const { facts, calls } = await resolveAll({
      'a/Port.kt': 'package a\ninterface Port {\n  fun send()\n}',
      'a/Wire.kt': 'package a\nclass Wire : Port {\n  override fun send() {}\n}',
      'a/Api.kt': 'package a\nobject Api {\n  val port: Port = Wire()\n}',
      'a/Use.kt': 'package a\nfun caller() {\n  Api.port.send()\n}',
    });
    expect(shape(facts, calls)).toEqual(['Api.port.send -> send@iface-impl']);
  });

  it('ANTI: an intermediate member that is not a property of the resolved type emits nothing', async () => {
    const { calls, stats } = await resolveAll({
      'a/Api.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}\nobject Api {\n  val repo: Repo = Repo()\n}',
      'a/Use.kt': 'package a\nfun caller() {\n  Api.missing.fetch()\n}',
    });
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 1, resolvedCalls: 0, ambiguousCalls: 0 });
  });

  it('ANTI: a root that resolves to nothing emits nothing', async () => {
    const { calls, stats } = await resolveAll({
      'a/Api.kt': 'package a\nclass Repo {\n  fun fetch() {}\n}',
      'a/Use.kt': 'package a\nfun caller() {\n  Unknown.repo.fetch()\n}',
    });
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 1, resolvedCalls: 0, ambiguousCalls: 0 });
  });

  it('ANTI: a duplicated fully-qualified name on the chain drops the edge and counts it', async () => {
    const { calls, stats } = await resolveAll({
      'flavorOne/a/Holder.kt': [
        'package a',
        'class Holder {',
        '  companion object {',
        '    val current: Holder = Holder()',
        '  }',
        '  fun use() {}',
        '}',
      ].join('\n'),
      'flavorTwo/a/Holder.kt': [
        'package a',
        'class Holder {',
        '  companion object {',
        '    val current: Holder = Holder()',
        '  }',
        '  fun use() {}',
        '}',
      ].join('\n'),
      'a/Use.kt': 'package a\nfun caller() {\n  Holder.current.use()\n}',
    });
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 1, resolvedCalls: 0, ambiguousCalls: 1 });
  });

  it('ANTI: a chain deeper than the two-hop bound emits nothing', async () => {
    const { calls, stats } = await resolveAll({
      'a/Deep.kt': [
        'package a',
        'class Leaf {',
        '  fun fetch() {}',
        '}',
        'class Mid {',
        '  val leaf: Leaf = Leaf()',
        '}',
        'class Outer {',
        '  val mid: Mid = Mid()',
        '}',
        'object Api {',
        '  val outer: Outer = Outer()',
        '}',
      ].join('\n'),
      'a/Use.kt': 'package a\nfun caller() {\n  Api.outer.mid.leaf.fetch()\n}',
    });
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 1, resolvedCalls: 0 });
  });

  it('ANTI: a class name root is not read as an instance of itself', async () => {
    const { calls, stats } = await resolveAll({
      'a/Thing.kt': 'package a\nclass Thing {\n  fun fetch() {}\n}',
      'a/Use.kt': 'package a\nfun caller() {\n  Thing.fetch()\n}',
    });
    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ callSites: 1, resolvedCalls: 0 });
  });
});
