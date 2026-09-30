/**
 * Shared tree-sitter-kotlin CST helpers. Generic Kotlin — no framework or repo-specific
 * assumptions; the declaration walk and every lane build on these primitives.
 *
 * Node vocabulary, probed from the BUNDLED grammar (fwcd tree-sitter-kotlin, via
 * @cursorless/tree-sitter-wasms). Most declarations have no useful named fields, so
 * these accessors are positional by node type. These are
 * exactly the facts that fail silently when guessed:
 *   - An annotation has TWO shapes: `annotation > user_type` with no arguments, and
 *     `annotation > constructor_invocation > user_type + value_arguments` with them.
 *     `annotationArg` returns undefined for the first shape rather than throwing.
 *   - `class` and `interface` are BOTH `class_declaration`; the only discriminator is the
 *     ANONYMOUS keyword token after `modifiers`. `enum class` emits `enum` then `class` as two
 *     anonymous tokens AND an `enum_class_body` child; `object` is a distinct
 *     `object_declaration`.
 *   - A call with value arguments AND a trailing lambda nests TWO `call_expression`s, while
 *     type arguments plus a trailing lambda stay on ONE `call_suffix`. `callArgs` and
 *     `trailingLambda` are therefore defined on the OUTER node and unwrap one level, so both
 *     shapes read identically.
 *   - A `function_declaration`'s extension receiver is a type child BEFORE the name and its
 *     return type an identical-looking one AFTER `function_value_parameters`: position is the
 *     only discriminator.
 *   - `string_literal` exposes `string_content` plus `interpolated_identifier` (`$a`) and
 *     `interpolated_expression` (`${a.b}`); `.text` includes the delimiters.
 *   - KDoc is a `multiline_comment` sibling, not an attached field.
 */
import { TreeSitterLoader, type TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { makeStringValueReader } from '../cst-kit/strings.js';
import { firstChildOfType, namedChildren, namedChildrenOfType } from '../cst-kit/walk.js';

// Re-exported: every extractor in this language's lane imports its node type from here.
export type { TsNode };

export const SOURCE_FILE = 'source_file';
export const PACKAGE_HEADER = 'package_header';
export const IMPORT_HEADER = 'import_header';
export const IMPORT_ALIAS = 'import_alias';
export const IDENTIFIER = 'identifier';
export const SIMPLE_IDENTIFIER = 'simple_identifier';
export const TYPE_IDENTIFIER = 'type_identifier';
export const CLASS_DECL = 'class_declaration';
export const OBJECT_DECL = 'object_declaration';
export const OBJECT_LITERAL = 'object_literal';
export const COMPANION_OBJECT = 'companion_object';
export const FUNCTION_DECL = 'function_declaration';
export const PROPERTY_DECL = 'property_declaration';
export const TYPE_ALIAS = 'type_alias';
export const CLASS_BODY = 'class_body';
export const ENUM_CLASS_BODY = 'enum_class_body';
export const ENUM_ENTRY = 'enum_entry';
export const MODIFIERS = 'modifiers';
export const ANNOTATION = 'annotation';
export const CONSTRUCTOR_INVOCATION = 'constructor_invocation';
export const USER_TYPE = 'user_type';
export const NULLABLE_TYPE = 'nullable_type';
export const DELEGATION_SPECIFIER = 'delegation_specifier';
/** `: Repo by delegate` — wraps the supertype one level below the delegation specifier. */
export const EXPLICIT_DELEGATION = 'explicit_delegation';
export const PRIMARY_CONSTRUCTOR = 'primary_constructor';
export const CLASS_PARAMETER = 'class_parameter';
export const PARAMETER = 'parameter';
export const PARAMETER_MODIFIERS = 'parameter_modifiers';
export const FUNCTION_VALUE_PARAMETERS = 'function_value_parameters';
export const BINDING_PATTERN_KIND = 'binding_pattern_kind';
export const VARIABLE_DECL = 'variable_declaration';
export const PROPERTY_DELEGATE = 'property_delegate';
export const CALL_EXPRESSION = 'call_expression';
export const CALL_SUFFIX = 'call_suffix';
export const VALUE_ARGUMENTS = 'value_arguments';
export const VALUE_ARGUMENT = 'value_argument';
export const TYPE_ARGUMENTS = 'type_arguments';
export const TYPE_PROJECTION = 'type_projection';
export const ANNOTATED_LAMBDA = 'annotated_lambda';
export const LAMBDA_LITERAL = 'lambda_literal';
export const NAVIGATION_EXPRESSION = 'navigation_expression';
export const NAVIGATION_SUFFIX = 'navigation_suffix';
export const STRING_LITERAL = 'string_literal';
export const STRING_CONTENT = 'string_content';
export const INTERPOLATED_IDENTIFIER = 'interpolated_identifier';
export const INTERPOLATED_EXPRESSION = 'interpolated_expression';
export const MULTILINE_COMMENT = 'multiline_comment';
export const ERROR_NODE = 'ERROR';

/** A type child may appear as `user_type` or wrapped in `nullable_type`. */
const TYPE_NODES: ReadonlySet<string> = new Set([USER_TYPE, NULLABLE_TYPE, 'function_type']);

/** Guard against pathological nesting in the recursive accessors. */
export const MAX_CST_DEPTH = 400;

/**
 * Traversal budgets. Every recursive or iterative walk over a tree-sitter tree is bounded: a
 * generated CST is not trusted to be shallow (a machine-generated or minified file nests far
 * deeper than hand-written code, and a cyclic parent chain would not terminate at all). The
 * numbers are budgets, not measurements of real code, which sits one or two orders below them.
 */
/** Subtree scans that collect every descendant of a type. */
export const MAX_DESCENDANT_DEPTH = 200;
/** Subtree scans looking for ONE node (the first call of an initializer). */
export const MAX_EXPRESSION_DEPTH = 64;
/** Walks UP the parent chain from an expression to its enclosing declaration. */
export const MAX_ANCESTOR_HOPS = 64;
/** Recursion through nested expression or document structure (`a + b + c`, nested nav graphs). */
export const MAX_NESTED_DEPTH = 32;
/** Hops along a receiver/call chain: `a.b().c()` is a handful, never dozens. */
export const MAX_CHAIN_HOPS = 8;
/** Node budget for the iterative `ERROR` scan of one file's tree. */
export const MAX_ERROR_SCAN_NODES = 200_000;

/** Parse Kotlin source and return the root node. The loader memoises the Parser per grammar. */
export async function parseKotlin(source: string): Promise<TsNode> {
  return (await TreeSitterLoader.getInstance().getParser('kotlin')).parse(source).rootNode;
}

// This grammar has no fields, so every child lookup below is positional and optional by nature.
export { namedChildren, namedChildrenOfType, firstChildOfType };

/** The `modifiers` node of a declaration, when it has one. */
export function modifiersOf(node: TsNode): TsNode | undefined {
  return firstChildOfType(node, MODIFIERS);
}

/** Modifier keyword texts (`data`, `abstract`, `private`, `suspend`, `const`, …). */
export function modifierTexts(node: TsNode): string[] {
  const mods = modifiersOf(node);
  if (!mods) return [];
  const out: string[] = [];
  for (const child of namedChildren(mods)) {
    if (child.type === ANNOTATION) continue;
    out.push(child.text as string);
  }
  return out;
}

/** Whether a declaration carries the given modifier keyword. */
export function hasModifier(node: TsNode, keyword: string): boolean {
  return modifierTexts(node).includes(keyword);
}

export type KotlinDeclKind = 'class' | 'interface' | 'enum' | 'object' | 'unknown';

/**
 * The declaration kind of a `class_declaration` / `object_declaration`.
 *
 * `class` and `interface` are structurally identical: the kind is read from the ANONYMOUS
 * keyword token that follows `modifiers`, never inferred from the children. `enum class`
 * additionally carries an `enum_class_body`, which is checked first because it is the
 * discriminator the spec pins (the grammar also emits an `enum` keyword token before `class`).
 */
export function declKind(node: TsNode): KotlinDeclKind {
  if (node.type === OBJECT_DECL) return 'object';
  if (node.type !== CLASS_DECL) return 'unknown';
  if (firstChildOfType(node, ENUM_CLASS_BODY)) return 'enum';
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.isNamed) continue;
    const text = child.text as string;
    if (text === 'enum') return 'enum';
    if (text === 'interface') return 'interface';
    if (text === 'class') return 'class';
  }
  return 'unknown';
}

/** The declared name of a class/object/interface/enum/typealias — its first `type_identifier`. */
export function declName(node: TsNode): string | undefined {
  return firstChildOfType(node, TYPE_IDENTIFIER)?.text as string | undefined;
}

/** The declared name of a `function_declaration` — its first `simple_identifier`. */
export function functionName(node: TsNode): string | undefined {
  return firstChildOfType(node, SIMPLE_IDENTIFIER)?.text as string | undefined;
}

/** Annotation nodes on a declaration: from its `modifiers`, or from `parameter_modifiers`. */
export function annotationsOf(node: TsNode): TsNode[] {
  const holder = modifiersOf(node) ?? firstChildOfType(node, PARAMETER_MODIFIERS);
  return holder ? namedChildrenOfType(holder, ANNOTATION) : [];
}

/**
 * The simple name of an `annotation`, reading the `user_type` in EITHER shape —
 * `@Url` (`annotation > user_type`) and `@GET("/x")`
 * (`annotation > constructor_invocation > user_type`).
 */
export function annotationName(annotation: TsNode): string | undefined {
  const direct = firstChildOfType(annotation, USER_TYPE);
  if (direct) return firstChildOfType(direct, TYPE_IDENTIFIER)?.text as string | undefined;
  const ctor = firstChildOfType(annotation, CONSTRUCTOR_INVOCATION);
  if (!ctor) return undefined;
  const userType = firstChildOfType(ctor, USER_TYPE);
  return firstChildOfType(userType, TYPE_IDENTIFIER)?.text as string | undefined;
}

/**
 * One argument of an annotation, by name (`tableName = "x"`) or by zero-based position.
 * Returns undefined when the annotation has NO `constructor_invocation` — i.e. `@Url` and a
 * bare `@GET` yield undefined instead of a fabricated value.
 */
export function annotationArg(annotation: TsNode, key: string | number): TsNode | undefined {
  const ctor = firstChildOfType(annotation, CONSTRUCTOR_INVOCATION);
  if (!ctor) return undefined;
  const args = firstChildOfType(ctor, VALUE_ARGUMENTS);
  if (!args) return undefined;
  const list = namedChildrenOfType(args, VALUE_ARGUMENT);
  if (typeof key === 'number') return list[key] ? argValue(list[key]) : undefined;
  for (const arg of list) {
    const label = firstChildOfType(arg, SIMPLE_IDENTIFIER);
    if (label && label.text === key) return argValue(arg);
  }
  return undefined;
}

/** The value node of a `value_argument`, skipping a leading `name =` label. */
export function argValue(arg: TsNode): TsNode | undefined {
  const kids = namedChildren(arg);
  if (kids.length > 1 && kids[0].type === SIMPLE_IDENTIFIER) return kids[1];
  return kids[0];
}

/**
 * The value of a `string_literal` with the delimiters stripped: `string_content` joined,
 * with `$a` / `${a.b}` rendered as `{a}` / `{a.b}` so an interpolated path stays a template
 * rather than silently losing its segment.
 */
export const stringValue = makeStringValueReader({
  stringNodeTypes: new Set([STRING_LITERAL]),
  contentChildTypes: new Set([STRING_CONTENT]),
  renderChild: new Map([
    [INTERPOLATED_IDENTIFIER, (n: TsNode) => `{${n.text}}`],
    [INTERPOLATED_EXPRESSION, (n: TsNode) => `{${n.text}}`],
  ]),
  emptyValue: '',
});

/** Whether a `string_literal` carries any interpolation. */
export function hasInterpolation(node: TsNode | undefined): boolean {
  if (!node || node.type !== STRING_LITERAL) return false;
  return namedChildren(node).some((c) => c.type === INTERPOLATED_IDENTIFIER || c.type === INTERPOLATED_EXPRESSION);
}

export interface DelegationSpecifier {
  /** Simple type name. */
  name: string;
  /**
   * `extends` when the specifier wraps a `constructor_invocation` (a superclass, invoked),
   * `implements` for a bare `user_type` (an interface, or a `by`-delegated one).
   */
  relation: 'extends' | 'implements';
}

/** Supertypes of a class/object/object-literal, split by the constructor-invocation rule. */
export function delegationSpecifiers(node: TsNode): DelegationSpecifier[] {
  const out: DelegationSpecifier[] = [];
  for (const spec of namedChildrenOfType(node, DELEGATION_SPECIFIER)) {
    const ctor = firstChildOfType(spec, CONSTRUCTOR_INVOCATION);
    // `: Repo by delegate` nests the supertype one level down, under `explicit_delegation`.
    // It is still an implemented interface — the delegation only says where the members come
    // from — so it must be read, or a class delegating its framework base goes unclassified.
    // A supertype that is a `function_type` (`: () -> Unit`) names no type at all and yields
    // nothing rather than crashing on the missing child.
    const delegated = firstChildOfType(spec, EXPLICIT_DELEGATION);
    const userType = ctor ? firstChildOfType(ctor, USER_TYPE) : firstChildOfType(delegated ?? spec, USER_TYPE);
    const name = firstChildOfType(userType, TYPE_IDENTIFIER)?.text as string | undefined;
    if (name) out.push({ name, relation: ctor ? 'extends' : 'implements' });
  }
  return out;
}

/** The bare simple name of a type node (`List<Thing>` → `List`, `Thing?` → `Thing`). */
export function typeName(node: TsNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === NULLABLE_TYPE) return typeName(firstChildOfType(node, USER_TYPE));
  if (node.type !== USER_TYPE) return undefined;
  return firstChildOfType(node, TYPE_IDENTIFIER)?.text as string | undefined;
}

/**
 * The extension receiver type of a `function_declaration`: a type child appearing BEFORE the
 * name. The return type looks identical and is told apart by position only.
 */
export function receiverTypeOf(fn: TsNode): TsNode | undefined {
  for (const child of namedChildren(fn)) {
    if (child.type === SIMPLE_IDENTIFIER) return undefined; // reached the name first
    if (TYPE_NODES.has(child.type)) return child;
  }
  return undefined;
}

/** The declared return type of a `function_declaration`: a type child AFTER the parameter list. */
export function returnTypeOf(fn: TsNode): TsNode | undefined {
  let seenParams = false;
  for (const child of namedChildren(fn)) {
    if (child.type === FUNCTION_VALUE_PARAMETERS) {
      seenParams = true;
      continue;
    }
    if (seenParams && TYPE_NODES.has(child.type)) return child;
  }
  return undefined;
}

/**
 * The inner `call_expression` of a nested value-arguments-plus-trailing-lambda call, or the
 * node itself. `single(named("api")) { … }` parses as
 * `call_expression(call_expression(callee, call_suffix(value_arguments)), call_suffix(lambda))`.
 */
function innerCall(call: TsNode): TsNode {
  const inner = firstChildOfType(call, CALL_EXPRESSION);
  return inner ?? call;
}

/** Every `call_suffix` of a call site, unwrapping one nesting level. */
function callSuffixes(call: TsNode): TsNode[] {
  const out: TsNode[] = [];
  const inner = innerCall(call);
  if (inner !== call) out.push(...namedChildrenOfType(inner, CALL_SUFFIX));
  out.push(...namedChildrenOfType(call, CALL_SUFFIX));
  return out;
}

/**
 * The value-argument nodes of a call, defined on the OUTER node and unwrapping one nesting
 * level so `f(a)`, `f<T> { }` and `f(a) { }` all read the same.
 */
export function callArgs(call: TsNode): TsNode[] {
  for (const suffix of callSuffixes(call)) {
    const args = firstChildOfType(suffix, VALUE_ARGUMENTS);
    if (args) return namedChildrenOfType(args, VALUE_ARGUMENT);
  }
  return [];
}

/** The trailing `lambda_literal` of a call, in either the nested or the single-suffix shape. */
export function trailingLambda(call: TsNode): TsNode | undefined {
  for (const suffix of callSuffixes(call)) {
    const annotated = firstChildOfType(suffix, ANNOTATED_LAMBDA);
    const lambda = annotated ? firstChildOfType(annotated, LAMBDA_LITERAL) : firstChildOfType(suffix, LAMBDA_LITERAL);
    if (lambda) return lambda;
  }
  return undefined;
}

/** The explicit type-argument type nodes of a call (`get<T>()` → the `T` type node). */
export function typeArgs(call: TsNode): TsNode[] {
  for (const suffix of callSuffixes(call)) {
    const args = firstChildOfType(suffix, TYPE_ARGUMENTS);
    if (!args) continue;
    const out: TsNode[] = [];
    for (const proj of namedChildrenOfType(args, TYPE_PROJECTION)) {
      const t = namedChildren(proj).find((c) => TYPE_NODES.has(c.type));
      if (t) out.push(t);
    }
    return out;
  }
  return [];
}

/**
 * The callee chain of a `call_expression`: `[rootExpr, ...memberNames]`. Recurses through
 * alternating `navigation_expression` and `call_expression` nodes, so `a.b().c(1)` yields
 * `[<node a>, 'b', 'c']` — the root may itself be a call receiver.
 */
export function calleeChain(call: TsNode): { root: TsNode; members: string[] } | undefined {
  const inner = innerCall(call);
  const callee = namedChildren(inner).find((c) => c.type !== CALL_SUFFIX);
  if (!callee) return undefined;
  return walkChain(callee, 0);
}

function walkChain(node: TsNode, depth: number): { root: TsNode; members: string[] } | undefined {
  if (depth > MAX_CST_DEPTH) return undefined;
  if (node.type === NAVIGATION_EXPRESSION) {
    const kids = namedChildren(node);
    const suffix = kids.find((c: TsNode) => c.type === NAVIGATION_SUFFIX);
    const receiver = kids.find((c: TsNode) => c.type !== NAVIGATION_SUFFIX);
    const member = suffix ? (firstChildOfType(suffix, SIMPLE_IDENTIFIER)?.text as string) : undefined;
    if (!receiver) return undefined;
    const below = walkChain(receiver, depth + 1);
    if (!below) return undefined;
    return { root: below.root, members: member ? [...below.members, member] : below.members };
  }
  // A call receiver terminates the name chain: the root is the call itself.
  return { root: node, members: [] };
}

/** The dotted callee name of a call when every hop is a plain name, else undefined. */
export function calleeText(call: TsNode): string | undefined {
  const chain = calleeChain(call);
  if (!chain) return undefined;
  if (chain.root.type === SIMPLE_IDENTIFIER) {
    return [chain.root.text as string, ...chain.members].join('.');
  }
  return chain.members.length > 0 ? chain.members.join('.') : undefined;
}

/** The final member name of a call (`a.b.c()` → `c`, `f()` → `f`). */
export function calleeName(call: TsNode): string | undefined {
  const chain = calleeChain(call);
  if (!chain) return undefined;
  if (chain.members.length > 0) return chain.members[chain.members.length - 1];
  return chain.root.type === SIMPLE_IDENTIFIER ? (chain.root.text as string) : undefined;
}

/** `val` / `var` of a `property_declaration` or `class_parameter`, from `binding_pattern_kind`. */
export function bindingKind(node: TsNode): 'val' | 'var' | undefined {
  const kind = firstChildOfType(node, BINDING_PATTERN_KIND)?.text as string | undefined;
  return kind === 'val' || kind === 'var' ? kind : undefined;
}

export interface PropertyFacts {
  name: string;
  /** Declared type simple name, when written. */
  typeName?: string;
  isReadonly: boolean;
  /** The `by <expr>` delegate expression, when delegated. */
  delegate?: TsNode;
  /** The initializer expression, when the property has one. */
  initializer?: TsNode;
}

/** `property_declaration > [modifiers] binding_pattern_kind variable_declaration (delegate|init)`. */
export function propertyFacts(node: TsNode): PropertyFacts | undefined {
  const decl = firstChildOfType(node, VARIABLE_DECL);
  if (!decl) return undefined;
  const name = firstChildOfType(decl, SIMPLE_IDENTIFIER)?.text as string | undefined;
  if (!name) return undefined;
  const delegateNode = firstChildOfType(node, PROPERTY_DELEGATE);
  const delegate = delegateNode ? namedChildren(delegateNode)[0] : undefined;
  let initializer: TsNode | undefined;
  if (!delegateNode) {
    // Node wrappers are not identity-stable across accessor calls: compare byte offsets.
    initializer = namedChildren(node).find((c) => c.startIndex > decl.startIndex && c.type !== MULTILINE_COMMENT);
  }
  return {
    name,
    typeName: typeName(namedChildren(decl).find((c) => TYPE_NODES.has(c.type))),
    isReadonly: bindingKind(node) !== 'var',
    delegate,
    initializer,
  };
}

export interface KotlinParameterFacts {
  name: string;
  typeName?: string;
  /** Annotations on the parameter (`@Path("id")`, `@Url`). */
  annotations: TsNode[];
}

/** Parameters of a `function_declaration`, from its `function_value_parameters`. */
export function parameterFacts(fn: TsNode): KotlinParameterFacts[] {
  const params = firstChildOfType(fn, FUNCTION_VALUE_PARAMETERS);
  if (!params) return [];
  const out: KotlinParameterFacts[] = [];
  let pending: TsNode[] = [];
  for (const child of namedChildren(params)) {
    if (child.type === PARAMETER_MODIFIERS) {
      pending = namedChildrenOfType(child, ANNOTATION);
      continue;
    }
    if (child.type !== PARAMETER) continue;
    const name = firstChildOfType(child, SIMPLE_IDENTIFIER)?.text as string | undefined;
    if (name) {
      out.push({
        name,
        typeName: typeName(namedChildren(child).find((c) => TYPE_NODES.has(c.type))),
        annotations: pending,
      });
    }
    pending = [];
  }
  return out;
}

/** Constructor `val`/`var` parameters of a class, from its `primary_constructor`. */
export function constructorProperties(node: TsNode): PropertyFacts[] {
  const ctor = firstChildOfType(node, PRIMARY_CONSTRUCTOR);
  if (!ctor) return [];
  const out: PropertyFacts[] = [];
  for (const param of namedChildrenOfType(ctor, CLASS_PARAMETER)) {
    const kind = bindingKind(param);
    if (!kind) continue; // a plain constructor parameter is not a property
    const name = firstChildOfType(param, SIMPLE_IDENTIFIER)?.text as string | undefined;
    if (!name) continue;
    out.push({
      name,
      typeName: typeName(namedChildren(param).find((c) => TYPE_NODES.has(c.type))),
      isReadonly: kind === 'val',
    });
  }
  return out;
}

/** The body of a class/object/enum declaration — `class_body` or `enum_class_body`. */
export function bodyOf(node: TsNode): TsNode | undefined {
  return firstChildOfType(node, CLASS_BODY) ?? firstChildOfType(node, ENUM_CLASS_BODY);
}

/** KDoc: the `multiline_comment` sibling immediately preceding a declaration, unwrapped. */
export function docComment(node: TsNode): string | undefined {
  const prev: TsNode | null = node.previousNamedSibling;
  if (!prev || prev.type !== MULTILINE_COMMENT) return undefined;
  const text = prev.text as string;
  if (!text.startsWith('/**')) return undefined;
  return text
    .slice(3, text.endsWith('*/') ? -2 : undefined)
    .split('\n')
    .map((line) => line.trim().replace(/^\*\s?/, ''))
    .join('\n')
    .trim();
}

/** Source location of a node, 1-based lines, matching the other substrates. */
export function locationOf(node: TsNode, filePath: string): { filePath: string; startLine: number; endLine: number } {
  return {
    filePath,
    startLine: (node.startPosition?.row ?? 0) + 1,
    endLine: (node.endPosition?.row ?? 0) + 1,
  };
}

/**
 * Whether the tree contains an `ERROR` node. `MISSING` nodes are deliberately NOT counted:
 * the grammar inserts `MISSING _automatic_semicolon` into valid single-line bodies, and
 * counting those would bury a real grammar regression in noise.
 */
export function hasSyntaxError(root: TsNode): boolean {
  if (!root.hasError) return false;
  const stack: TsNode[] = [root];
  let guard = 0;
  while (stack.length > 0 && guard++ < MAX_ERROR_SCAN_NODES) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === ERROR_NODE) return true;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.hasError) stack.push(child);
    }
  }
  return false;
}
