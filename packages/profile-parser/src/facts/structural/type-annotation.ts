import type { TypeInfo, TypeStructure } from '@coredoc/core/types';
import type { Node as TsNode } from 'web-tree-sitter';

/**
 * Parse a tree-sitter type node into a `TypeInfo` whose `structure` names the
 * types it references. This is what lets the downstream USES_TYPE builder link a
 * declaration (interface member, class property, type alias) to the types it
 * uses without re-scanning source text.
 *
 * Modelled shapes: type references (incl. generic type arguments and qualified
 * `A.B` names), arrays, tuples, unions, intersections, parenthesized types,
 * predefined primitives and literal types. Anything else — function types,
 * object/mapped/conditional types, `typeof`/`keyof` queries — deliberately
 * yields `{ text }` WITHOUT a structure: claiming `kind: 'unknown'` would assert
 * "no references here", while the missing structure lets the consumer fall back
 * to its own text handling.
 */
export function parseTypeNode(node: TsNode | null | undefined): TypeInfo | undefined {
  if (!node) return undefined;
  // `type_annotation` wraps the type in `: T`; `opting_type_annotation` is the `?:` form.
  const inner =
    node.type === 'type_annotation' ||
    node.type === 'opting_type_annotation' ||
    node.type === 'omitting_type_annotation'
      ? node.namedChildren[0]
      : node;
  if (!inner) return undefined;
  const text = inner.text.trim();
  if (!text) return undefined;
  const structure = typeStructure(inner);
  return structure ? { text, structure } : { text };
}

/** Bare name of a (possibly qualified) type name node: `A.B.C` → `C`. */
function typeName(node: TsNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'type_identifier' || node.type === 'identifier') return node.text;
  if (node.type === 'nested_type_identifier') {
    const last = node.namedChildren[node.namedChildren.length - 1];
    return last?.text;
  }
  return undefined;
}

function children(node: TsNode): TypeInfo[] {
  const out: TypeInfo[] = [];
  for (const c of node.namedChildren) {
    const info = parseTypeNode(c);
    if (info) out.push(info);
  }
  return out;
}

function typeStructure(node: TsNode): TypeStructure | undefined {
  switch (node.type) {
    case 'type_identifier':
    case 'nested_type_identifier': {
      const name = typeName(node);
      return name ? { kind: 'reference', name } : undefined;
    }
    case 'generic_type': {
      const name = typeName(node.childForFieldName('name') ?? node.namedChildren[0]);
      if (!name) return undefined;
      const args = node.namedChildren.find((c) => c.type === 'type_arguments');
      const typeArguments = args ? children(args) : [];
      return typeArguments.length ? { kind: 'reference', name, typeArguments } : { kind: 'reference', name };
    }
    case 'array_type': {
      const elementType = parseTypeNode(node.namedChildren[0]);
      return elementType ? { kind: 'array', elementType } : undefined;
    }
    case 'tuple_type':
      return { kind: 'tuple', elements: children(node) };
    case 'union_type':
      return { kind: 'union', types: children(node) };
    case 'intersection_type':
      return { kind: 'intersection', types: children(node) };
    case 'parenthesized_type':
      return node.namedChildren[0] ? typeStructure(node.namedChildren[0]) : undefined;
    case 'predefined_type':
      return { kind: 'primitive', name: node.text };
    case 'literal_type':
      return { kind: 'literal', value: node.text.replace(/^['"`]|['"`]$/g, '') };
    default:
      // Unmodelled shape — no structure (see the doc comment above).
      return undefined;
  }
}
