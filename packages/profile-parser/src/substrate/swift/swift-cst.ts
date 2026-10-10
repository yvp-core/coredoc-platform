/**
 * Shared tree-sitter-swift CST helpers for the Swift substrate. Generic Swift —
 * no framework- or client-specific assumptions. The egress / entities / db-ops /
 * call-graph extractors all build on these primitives.
 *
 * Node vocabulary (verified against tree-sitter-swift@tree-sitter-wasms 0.1.13):
 *   - `class_declaration` is the UNIFIED node for class / struct / enum / actor /
 *     extension; its `declaration_kind` field child holds the keyword.
 *   - `protocol_declaration` is separate.
 *   - `enum_entry` = one `case` (Moya endpoint), `property_declaration` for vars
 *     (Moya getters carry a `computed_value: computed_property`), `switch_statement`
 *     / `switch_entry` for the path/method resolution, `line_string_literal` +
 *     `interpolated_expression` for path templates, `call_expression` →
 *     `navigation_expression` (`target` + `navigation_suffix`) → `call_suffix`.
 */
import type { StableIdGenerator } from '@coredoc/core';
import { type TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { makeStringValueReader } from '../cst-kit/strings.js';
import { nearestAncestor } from '../cst-kit/walk.js';

// Re-exported: every extractor in this language's lane imports its node type from here.
export type { TsNode };

/** The unified type-declaration node (class / struct / enum / actor / extension). */
export const TYPE_DECL = 'class_declaration';
export const PROTOCOL_DECL = 'protocol_declaration';
export const FUNC_DECL = 'function_declaration';
export const CALL_EXPR = 'call_expression';
export const NAV_EXPR = 'navigation_expression';
export const ENUM_ENTRY = 'enum_entry';
export const PROPERTY_DECL = 'property_declaration';

/** Both kinds of type container we treat as an "enclosing type" for method scoping. */
export const TYPE_CONTAINERS = new Set([TYPE_DECL, PROTOCOL_DECL]);

/** The `declaration_kind` keyword of a `class_declaration` (class|struct|enum|actor|extension). */
export function declKind(node: TsNode): string | undefined {
  return node.childForFieldName?.('declaration_kind')?.text as string | undefined;
}

/** The `name` field text (a `type_identifier` for types, `simple_identifier` for funcs). */
export function nameOf(node: TsNode): string | undefined {
  return node.childForFieldName?.('name')?.text as string | undefined;
}

/**
 * The declared name of a type. For most decls this is the `name` field; for an
 * `extension` the name is the extended type (same `name` field), so members of
 * `extension Foo { … }` correctly attribute to `Foo`.
 */
export function typeName(node: TsNode): string | undefined {
  return nameOf(node);
}

export { nearestAncestor };

/** The enclosing type container's declared name, if any (`Foo` for a method of `Foo`). */
export function enclosingTypeName(node: TsNode): string | undefined {
  const c = nearestAncestor(node, TYPE_CONTAINERS);
  return c ? typeName(c) : undefined;
}

/** Base types a decl inherits/conforms to (`class Foo: Object, Bar` → ['Object','Bar']). */
export function inheritedTypes(node: TsNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type !== 'inheritance_specifier') continue;
    const from = c.childForFieldName?.('inherits_from') ?? c.child(0);
    // The type NAME is the last identifier of a qualified path (`RealmSwift.Object` → 'Object',
    // `Moya.TargetType` → 'TargetType'); a generic like `List<X>` also yields the outer 'List'
    // here since the base identifier precedes the type argument in the flat identifier list… so
    // take the qualifier tail up to (not into) any generic args.
    const ids = from?.descendantsOfType?.('type_identifier') as TsNode[] | undefined;
    const id = qualifiedTail(from, ids) ?? (from?.text as string | undefined);
    if (id) out.push(id);
  }
  return out;
}

/**
 * The intended type name from an `inherits_from` node: the LAST component of a dotted qualifier
 * (`A.B.Object` → 'Object'), but the FIRST identifier of a generic (`List<Foo>` → 'List', not the
 * argument 'Foo'). Disambiguated by whether a `navigation_type`/`.`-qualifier is present.
 */
function qualifiedTail(from: TsNode | undefined, ids: TsNode[] | undefined): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  if (ids.length === 1) return ids[0].text as string;
  // Generic base (`List<Foo>`): the base type is the FIRST identifier, args follow.
  if ((from?.text as string)?.includes('<')) return ids[0].text as string;
  // Qualified path (`RealmSwift.Object`): the type name is the LAST identifier.
  return ids[ids.length - 1].text as string;
}

/**
 * Whether a function/property decl carries a `static` or `class` modifier. Inspects only the
 * modifier keyword tokens, NOT attribute arguments — an `@available(…, message: "use the static
 * factory")` string must not flip an instance method to static.
 */
export function isStaticDecl(node: TsNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const mods = node.child(i);
    if (mods?.type !== 'modifiers') continue;
    for (let j = 0; j < mods.childCount; j++) {
      const m = mods.child(j);
      if (!m || m.type === 'attribute') continue; // skip @available(...) etc.
      if (/\b(static|class)\b/.test(m.text as string)) return true;
    }
  }
  return false;
}

/** The property name of a `property_declaration` (`var foo: X` → "foo"). */
export function propertyName(node: TsNode): string | undefined {
  const pat = node.childForFieldName?.('name');
  if (!pat) return undefined;
  const bound = pat.childForFieldName?.('bound_identifier');
  return (bound?.text ?? pat.text) as string | undefined;
}

/** The `computed_property` getter body of a property, if it is a computed var. */
export function computedBody(node: TsNode): TsNode | undefined {
  return node.childForFieldName?.('computed_value');
}

/** The type-annotation type node of a property (`var x: Foo?` → the `Foo?` optional_type node). */
export function typeAnnotationNode(node: TsNode): TsNode | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === 'type_annotation') {
      // The type is the last named child of the annotation (after the `:`).
      for (let j = c.childCount - 1; j >= 0; j--) {
        const t = c.child(j);
        if (t?.isNamed) return t;
      }
    }
  }
  return undefined;
}

/** The leading `type_identifier` of a type node, unwrapping `X?` / `[X]` (`Foo?` → "Foo"). */
export function baseTypeIdentifier(typeNode: TsNode | undefined): string | undefined {
  if (!typeNode) return undefined;
  if (typeNode.type === 'type_identifier') return typeNode.text as string;
  return typeNode.descendantsOfType?.('type_identifier')?.[0]?.text as string | undefined;
}

// =============================================================================
// Call-expression shape
// =============================================================================

/** The method name of a `call_expression` (`a.b.c()` → "c"; a bare `Foo()` → undefined). */
export function callMethodName(call: TsNode): string | undefined {
  const head = call.child(0);
  if (head?.type === NAV_EXPR) {
    // navigation_expression → suffix: navigation_suffix → suffix: simple_identifier
    return head.childForFieldName?.('suffix')?.childForFieldName?.('suffix')?.text as string | undefined;
  }
  return undefined; // bare construction `Foo(...)` — no method suffix
}

/** The receiver node of a method `call_expression` (the target of the outer navigation). */
export function callReceiver(call: TsNode): TsNode | undefined {
  const head = call.child(0);
  if (head?.type === NAV_EXPR) return head.childForFieldName?.('target');
  return undefined;
}

/** The `call_suffix` (arguments / trailing closure) of a `call_expression`. */
export function callSuffix(call: TsNode): TsNode | undefined {
  for (let i = call.childCount - 1; i >= 0; i--) {
    const c = call.child(i);
    if (c?.type === 'call_suffix') return c;
  }
  return undefined;
}

/**
 * If a node is a direct construction `Foo(...)` (a `call_expression` whose head is a
 * bare `simple_identifier`), return the constructed type name `Foo`. Used by the Tier-B
 * resolver: `Foo().method()` has a known receiver type by construction.
 */
export function constructedType(node: TsNode | undefined): string | undefined {
  if (!node || node.type !== CALL_EXPR) return undefined;
  const head = node.child(0);
  return head?.type === 'simple_identifier' ? (head.text as string) : undefined;
}

/**
 * Reconstruct a Moya path template from a `line_string_literal`, normalizing Swift
 * interpolation `\(id)` → `{id}` so the cross-repo linker can match it as a path
 * template (e.g. `/bookings/\(id)` → `/bookings/{id}`).
 */
const stringTemplate = makeStringValueReader({
  contentChildTypes: new Set(['line_str_text']),
  renderChild: new Map([
    [
      'interpolated_expression',
      (c: TsNode) => {
        // Collapse the interpolation to a single-token placeholder: the value if it is a bare
        // identifier (`\(id)` → {id}), else its first identifier (`\(uuid.lowercased)` → {uuid}),
        // else `{param}`. Keeps path templates clean (no spaces / operators inside `{…}`).
        const val = c.childForFieldName?.('value');
        const token =
          val?.type === 'simple_identifier'
            ? (val.text as string)
            : ((val?.descendantsOfType?.('simple_identifier')?.[0]?.text as string | undefined) ?? 'param');
        return `{${token}}`;
      },
    ],
  ]),
  emptyValue: '',
});

export function stringTemplateWithParams(lit: TsNode): string {
  return stringTemplate(lit) as string;
}

// =============================================================================
// Canonical decl id
// =============================================================================

/**
 * Canonical id for a Swift function/method decl. Free functions → `functionId(file, name)`;
 * methods → `methodId(file, Type, name)`; static/class methods → `methodId(file, Type,
 * 'static.'+name)` so a static and an instance method of the SAME name in the SAME type do
 * not collapse onto one id. Used by BOTH the call-graph def index and the db-op performer
 * minting so a decl's node id matches its db-op performer id (they merge by id in the
 * orchestrator).
 *
 * Keyed on the NEAREST type container, not on a scope chain: a method of a nested type is
 * attributed to that type alone, so the shared `makeScopeChainId` is deliberately not used here.
 */
export function swiftMethodId(idGen: StableIdGenerator, relPath: string, func: TsNode): string {
  const name = nameOf(func) ?? '(anonymous)';
  const type = enclosingTypeName(func);
  if (!type) return idGen.functionId(relPath, name);
  return idGen.methodId(relPath, type, isStaticDecl(func) ? `static.${name}` : name);
}
