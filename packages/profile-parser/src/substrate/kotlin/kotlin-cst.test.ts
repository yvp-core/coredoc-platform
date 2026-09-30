import { describe, expect, it } from 'vitest';
import {
  annotationArg,
  annotationName,
  annotationsOf,
  bindingKind,
  bodyOf,
  callArgs,
  calleeChain,
  calleeName,
  calleeText,
  constructorProperties,
  declKind,
  declName,
  delegationSpecifiers,
  docComment,
  functionName,
  hasInterpolation,
  hasSyntaxError,
  modifierTexts,
  namedChildrenOfType,
  parameterFacts,
  parseKotlin,
  propertyFacts,
  receiverTypeOf,
  returnTypeOf,
  stringValue,
  trailingLambda,
  typeArgs,
  typeName,
  type TsNode,
} from './kotlin-cst.js';

async function root(src: string): Promise<TsNode> {
  return await parseKotlin(src);
}

/** Every `call_expression` in the tree, outermost first. */
function calls(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  const visit = (n: TsNode) => {
    if (n.type === 'call_expression') out.push(n);
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
  };
  visit(node);
  return out;
}

function decls(node: TsNode, type: string): TsNode[] {
  const out: TsNode[] = [];
  const visit = (n: TsNode) => {
    if (n.type === type) out.push(n);
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
  };
  visit(node);
  return out;
}

describe('declKind — class and interface differ only by an anonymous keyword', () => {
  it('reads each kind from the keyword token, not from the children', async () => {
    const r = await root(
      ['data class A(val x: Int)', 'class B', 'interface C', 'enum class D { E }', 'object F'].join('\n'),
    );
    const kinds = namedChildrenOfType(r, 'class_declaration')
      .concat(namedChildrenOfType(r, 'object_declaration'))
      .map((n) => `${declName(n)}:${declKind(n)}`);
    expect(kinds).toEqual(['A:class', 'B:class', 'C:interface', 'D:enum', 'F:object']);
  });

  it('ANTI: an interface is not reported as a class even though its children are identical', async () => {
    const r = await root('interface C { fun f() }');
    const iface = namedChildrenOfType(r, 'class_declaration')[0];
    const cls = namedChildrenOfType(await root('class C { fun f() }'), 'class_declaration')[0];
    // Same child types; only the keyword separates them.
    expect(declKind(iface)).toBe('interface');
    expect(declKind(cls)).toBe('class');
  });

  it('an enum class carries no modifier — the enum_class_body is the marker', async () => {
    const r = await root('enum class D { E, F }');
    const d = namedChildrenOfType(r, 'class_declaration')[0];
    expect(modifierTexts(d)).toEqual([]);
    expect(bodyOf(d)?.type).toBe('enum_class_body');
    expect(namedChildrenOfType(bodyOf(d), 'enum_entry').map((e) => e.text)).toEqual(['E', 'F']);
  });

  it('reads class modifiers', async () => {
    const r = await root('abstract data class A(val x: Int)');
    const a = namedChildrenOfType(r, 'class_declaration')[0];
    expect(modifierTexts(a)).toEqual(['abstract', 'data']);
  });
});

describe('annotations — two structural shapes', () => {
  it('names a no-argument annotation (annotation > user_type)', async () => {
    const r = await root('class C {\n  @Transaction\n  fun f() {}\n}');
    const fn = decls(r, 'function_declaration')[0];
    const [ann] = annotationsOf(fn);
    expect(annotationName(ann)).toBe('Transaction');
  });

  it('ANTI: a no-argument annotation yields undefined for every argument, never a fabricated one', async () => {
    const r = await root('class C {\n  @Transaction\n  fun f() {}\n}');
    const [ann] = annotationsOf(decls(r, 'function_declaration')[0]);
    expect(annotationArg(ann, 0)).toBeUndefined();
    expect(annotationArg(ann, 'value')).toBeUndefined();
  });

  it('names an argument-bearing annotation (annotation > constructor_invocation > user_type)', async () => {
    const r = await root('@Entity(tableName = "things")\nclass C');
    const [ann] = annotationsOf(namedChildrenOfType(r, 'class_declaration')[0]);
    expect(annotationName(ann)).toBe('Entity');
    expect(stringValue(annotationArg(ann, 'tableName'))).toBe('things');
    expect(stringValue(annotationArg(ann, 0))).toBe('things');
    expect(annotationArg(ann, 'missing')).toBeUndefined();
  });

  it('reads parameter annotations through parameter_modifiers', async () => {
    const r = await root('interface R {\n  @GET("/a/{id}")\n  fun g(@Path("id") id: Int, @Url u: String)\n}');
    const fn = decls(r, 'function_declaration')[0];
    const params = parameterFacts(fn);
    expect(params.map((p) => p.name)).toEqual(['id', 'u']);
    expect(params[0].annotations.map(annotationName)).toEqual(['Path']);
    expect(params[1].annotations.map(annotationName)).toEqual(['Url']);
    expect(annotationArg(params[1].annotations[0], 0)).toBeUndefined();
  });
});

describe('calls — nesting depends on the argument shape', () => {
  it('reads value arguments and a trailing lambda from the same call', async () => {
    const r = await root('fun f() { single(named("api")) { Impl() } }');
    const outer = calls(r)[0];
    expect(outer.text).toContain('single(named');
    expect(callArgs(outer)).toHaveLength(1);
    expect(trailingLambda(outer)?.text).toBe('{ Impl() }');
    expect(calleeName(outer)).toBe('single');
  });

  it('type arguments plus a trailing lambda stay on one call_suffix', async () => {
    const r = await root('fun f() { single<Repo> { Impl() } }');
    const outer = calls(r)[0];
    expect(callArgs(outer)).toHaveLength(0);
    expect(trailingLambda(outer)?.text).toBe('{ Impl() }');
    expect(typeArgs(outer).map(typeName)).toEqual(['Repo']);
  });

  it('keeps the outer trailing lambda distinct from a call inside its value arguments', async () => {
    const r = await root('fun f() { single(named("api")) { Impl() } }');
    const outer = calls(r)[0];
    const inner = calls(outer).find((c) => c.text === 'named("api")');
    expect(inner).toBeDefined();
    expect(callArgs(inner).map((a) => a.text)).toEqual(['"api"']);
    expect(trailingLambda(inner)).toBeUndefined();
    expect(trailingLambda(outer)?.text).toBe('{ Impl() }');
  });

  it('calleeChain recurses through alternating navigation and call nodes', async () => {
    const r = await root('fun f() { a.b().c(1) }');
    const outer = calls(r)[0];
    const chain = calleeChain(outer);
    expect(chain?.members).toEqual(['c']);
    expect(chain?.root.type).toBe('call_expression');
    expect(chain?.root.text).toBe('a.b()');
    expect(calleeText(outer)).toBe('c');
  });

  it('a plain dotted chain yields the full dotted text', async () => {
    const r = await root('fun f() { a.b.c(1) }');
    const outer = calls(r)[0];
    expect(calleeText(outer)).toBe('a.b.c');
    expect(calleeName(outer)).toBe('c');
  });

  it('a bare call yields its own name', async () => {
    const r = await root('fun f() { g(1) }');
    expect(calleeText(calls(r)[0])).toBe('g');
  });
});

describe('strings', () => {
  it('joins string_content and renders interpolations as {name}', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is KOTLIN interpolation, not JS
    const r = await root('fun f() { val s = "a${b.c}d$e f" }');
    const lit = decls(r, 'string_literal')[0];
    expect(stringValue(lit)).toBe('a{b.c}d{e} f');
    expect(hasInterpolation(lit)).toBe(true);
  });

  it('ANTI: a plain literal reports no interpolation and drops its delimiters', async () => {
    const r = await root('fun f() { val s = "plain" }');
    const lit = decls(r, 'string_literal')[0];
    expect(stringValue(lit)).toBe('plain');
    expect(hasInterpolation(lit)).toBe(false);
    expect(lit.text).toBe('"plain"');
  });
});

describe('supertypes', () => {
  it('a constructor_invocation is an extended class and a bare user_type an implemented interface', async () => {
    const r = await root('class C : Base(), Marker, Other');
    const specs = delegationSpecifiers(namedChildrenOfType(r, 'class_declaration')[0]);
    expect(specs).toEqual([
      { name: 'Base', relation: 'extends' },
      { name: 'Marker', relation: 'implements' },
      { name: 'Other', relation: 'implements' },
    ]);
  });

  // REGRESSION: a `by`-delegated supertype nests under `explicit_delegation`, so reading only
  // the specifier's direct children found no type. On real source this threw rather than
  // returning nothing, which took the whole parse down.
  it('reads a by-delegated supertype as an implemented interface', async () => {
    const r = await root('class D(private val r: Repo) : Repo by r');
    const specs = delegationSpecifiers(namedChildrenOfType(r, 'class_declaration')[0]);
    expect(specs).toEqual([{ name: 'Repo', relation: 'implements' }]);
  });

  // ANTI-SCENARIO: a function-type supertype names no type. Emitting `Unit` from its return
  // would invent a supertype the class does not have.
  it('emits nothing for a function-type supertype and does not throw', async () => {
    const r = await root('class F : () -> Unit');
    const specs = delegationSpecifiers(namedChildrenOfType(r, 'class_declaration')[0]);
    expect(specs).toEqual([]);
  });
});

describe('functions — receiver and return type are positional twins', () => {
  it('a type child before the name is the receiver, an identical one after the parameters is the return type', async () => {
    const r = await root('fun List<Thing>.firstNamed(n: String): Thing = x');
    const fn = namedChildrenOfType(r, 'function_declaration')[0];
    expect(functionName(fn)).toBe('firstNamed');
    expect(typeName(receiverTypeOf(fn))).toBe('List');
    expect(typeName(returnTypeOf(fn))).toBe('Thing');
  });

  it('ANTI: a non-extension function has NO receiver even though its return type looks the same', async () => {
    const r = await root('fun firstNamed(n: String): Thing = x');
    const fn = namedChildrenOfType(r, 'function_declaration')[0];
    expect(receiverTypeOf(fn)).toBeUndefined();
    expect(typeName(returnTypeOf(fn))).toBe('Thing');
  });

  it('ANTI: a function with no return type reports none', async () => {
    const r = await root('fun f(n: String) {}');
    const fn = namedChildrenOfType(r, 'function_declaration')[0];
    expect(returnTypeOf(fn)).toBeUndefined();
  });
});

describe('properties', () => {
  it('reads a delegated property', async () => {
    const r = await root('class C {\n  private val dep: Thing by inject()\n}');
    const prop = decls(r, 'property_declaration')[0];
    const facts = propertyFacts(prop);
    expect(facts?.name).toBe('dep');
    expect(facts?.typeName).toBe('Thing');
    expect(facts?.isReadonly).toBe(true);
    expect(facts?.delegate?.type).toBe('call_expression');
    expect(facts?.initializer).toBeUndefined();
    expect(bindingKind(prop)).toBe('val');
  });

  it('reads an initialised var', async () => {
    const r = await root('class C {\n  var n = Thing(1)\n}');
    const facts = propertyFacts(decls(r, 'property_declaration')[0]);
    expect(facts?.isReadonly).toBe(false);
    expect(facts?.delegate).toBeUndefined();
    expect(facts?.initializer?.type).toBe('call_expression');
  });

  it('constructor val/var parameters are properties and plain parameters are not', async () => {
    const r = await root('class C(val a: Int, var b: String, c: Long)');
    const props = constructorProperties(namedChildrenOfType(r, 'class_declaration')[0]);
    expect(props.map((p) => `${p.name}:${p.typeName}:${p.isReadonly}`)).toEqual(['a:Int:true', 'b:String:false']);
  });
});

describe('doc comments and error detection', () => {
  it('unwraps a KDoc sibling', async () => {
    const r = await root('class C {\n  /** Does a thing.\n   * More. */\n  fun f() {}\n}');
    expect(docComment(decls(r, 'function_declaration')[0])).toBe('Does a thing.\nMore.');
  });

  it('ANTI: a non-KDoc block comment is not a doc comment', async () => {
    const r = await root('class C {\n  /* not kdoc */\n  fun f() {}\n}');
    expect(docComment(decls(r, 'function_declaration')[0])).toBeUndefined();
  });

  it('`fun interface` produces an ERROR node plus a spurious lambda_literal', async () => {
    const r = await root('fun interface Cb { fun on(v: Int) }\nfun top() {}');
    expect(hasSyntaxError(r)).toBe(true);
    const inner = decls(r, 'function_declaration').find((f) => functionName(f) === 'on');
    expect(inner).toBeDefined();
    // The trap: its parent chain reaches a lambda_literal, NOT source_file.
    expect(inner?.parent?.type).toBe('statements');
    expect(inner?.parent?.parent?.type).toBe('lambda_literal');
  });

  it('ANTI: a clean file reports no syntax error', async () => {
    expect(hasSyntaxError(await root('fun f() {}\n'))).toBe(false);
  });
});
