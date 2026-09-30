/**
 * Rust type-with-methods → `ClassNode` (audit gap G1-rust).
 *
 * Every Rust fn inside an `impl` or `trait` already carries
 * `classId = idGen.classId(relPath, rustTypeChain(fn).join('::'))`, but the substrate only ever
 * minted a `ClassNode` for `struct_item`. On PostHog that left 435 methods across 198 distinct
 * ids pointing at classes nobody emitted, in four shapes:
 *
 *   - `impl` on an ENUM (`impl ClientError`) — an `EnumNode` was emitted under `enumId`, which is
 *     a different id, so the method's `classId` resolved to nothing (103/198);
 *   - `impl Foo` in a file where `struct Foo` lives in ANOTHER module (47/198);
 *   - default-bodied methods inside a `trait` — an `InterfaceNode` under `interfaceId` (12/198);
 *   - `impl` on a foreign/std type (`impl Sink for Box<dyn Sink>`) (the rest).
 *
 * The fix is reference-driven, like the Python one: this module walks the SAME nodes the id path
 * walks and mints the class the methods already name, so `class.id === method.classId` holds by
 * construction rather than by coincidence. Enums and traits keep their `EnumNode`/`InterfaceNode`
 * as well — those carry variants/signatures a `ClassNode` has no field for; the class node is the
 * METHOD-BEARING facet of the same type, which is what `classId` means.
 *
 * BOUNDARY (Tier-B, unchanged by this module): `classId` is keyed on the file holding the `impl`,
 * not on the file holding the type declaration. A type implemented across several files therefore
 * appears as one class node per impl file. Re-keying it needs cross-file type resolution the Rust
 * substrate does not have (there is no scip-rust here), so the split is documented, not guessed.
 */
import type { ClassNode, PropertyNode, StableIdGenerator, TypeReference } from '@coredoc/core';
import {
  ENUM_ITEM,
  FUNCTION_ITEM,
  IMPL_ITEM,
  type RustFile,
  STRUCT_ITEM,
  TRAIT_ITEM,
  type TsNode,
  implTraitName,
  implTypeName,
  isPublic,
  itemName,
  rustFunctionId,
  rustTypeChain,
} from './rust-cst.js';

/** What one file's `impl` blocks say about a type: its methods and the traits it implements. */
interface ImplFacts {
  /** The `impl` block that first named this type — the location fallback when no decl is local. */
  node: TsNode;
  /** Method ids from every `impl <Type>` block in the file, in source order, de-duped. */
  methodIds: string[];
  /** Trait names from `impl <Trait> for <Type>` blocks in the file, de-duped. */
  traits: string[];
}

/** File-qualified key (`${relPath}#${Type}`) — two files' `impl Config` must never share a key. */
function typeKey(relPath: string, typeName: string): string {
  return `${relPath}#${typeName}`;
}

/**
 * `${relPath}#${Type}` → the impl facts for that type in that file. Walks the `impl` blocks
 * directly rather than range-matching every fn against every impl, which is quadratic.
 */
function implFactsByTypeFile(files: RustFile[], idGen: StableIdGenerator): Map<string, ImplFacts> {
  const out = new Map<string, ImplFacts>();
  for (const { relPath, root } of files) {
    for (const implNode of root.descendantsOfType(IMPL_ITEM) as TsNode[]) {
      const typeName = implTypeName(implNode);
      if (!typeName) continue;
      const key = typeKey(relPath, typeName);
      let facts = out.get(key);
      if (!facts) {
        facts = { node: implNode, methodIds: [], traits: [] };
        out.set(key, facts);
      }
      const traitName = implTraitName(implNode);
      if (traitName && !facts.traits.includes(traitName)) facts.traits.push(traitName);
      for (const fn of implNode.descendantsOfType(FUNCTION_ITEM) as TsNode[]) {
        const id = rustFunctionId(idGen, relPath, fn);
        if (!facts.methodIds.includes(id)) facts.methodIds.push(id);
      }
    }
  }
  return out;
}

/** The `field_declaration` properties of a struct. */
function structProperties(
  structNode: TsNode,
  classId: string,
  relPath: string,
  idGen: StableIdGenerator,
): PropertyNode[] {
  const out: PropertyNode[] = [];
  for (const fd of structNode.descendantsOfType('field_declaration') as TsNode[]) {
    const name = fd.childForFieldName?.('name')?.text as string | undefined;
    if (!name) continue;
    const typeText = fd.childForFieldName?.('type')?.text as string | undefined;
    out.push({
      id: idGen.generateNodeId('variable', relPath, `${classId}.${name}`),
      name,
      classId,
      visibility: isPublic(fd) ? 'public' : 'private',
      isStatic: false,
      isReadonly: false,
      isOptional: typeText?.startsWith('Option<') ?? false,
      type: typeText ? { text: typeText } : undefined,
      location: { filePath: relPath, startLine: fd.startPosition.row + 1, endLine: fd.endPosition.row + 1 },
    });
  }
  return out;
}

/** The node that DECLARES a nominal type in a file, by name (`struct`/`enum`/`trait`). */
function declsByName(root: TsNode): Map<string, TsNode> {
  const out = new Map<string, TsNode>();
  for (const kind of [STRUCT_ITEM, ENUM_ITEM, TRAIT_ITEM]) {
    for (const node of root.descendantsOfType(kind) as TsNode[]) {
      const name = itemName(node);
      if (name && !out.has(name)) out.set(name, node);
    }
  }
  return out;
}

/** Location fields for a CST node. */
function locationOf(node: TsNode, relPath: string): ClassNode['location'] {
  return { filePath: relPath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

/**
 * Emit one `ClassNode` per method-bearing Rust type, keyed by the id its methods already compute.
 *
 * Sources, in precedence order (first to claim an id wins, so a struct's node — the only one with
 * properties — is never overwritten by an impl-derived stub):
 *   1. every `struct_item` (unconditionally, as before — a field-only struct is still a type);
 *   2. every `impl <Type>` target, whether the type is an enum, a struct declared elsewhere, or a
 *      foreign type;
 *   3. every `trait` that has default-bodied methods (`function_item`, not `function_signature_item`).
 *
 * (2) and (3) are gated on actually owning a method, so this mints nodes that close a dangling
 * reference and nothing else.
 */
export function extractRustClasses(files: RustFile[], idGen: StableIdGenerator): ClassNode[] {
  const implFacts = implFactsByTypeFile(files, idGen);
  const byId = new Map<string, ClassNode>();

  const mint = (node: ClassNode): void => {
    if (!byId.has(node.id)) byId.set(node.id, node);
  };
  const asRefs = (names: string[]): TypeReference[] => names.map((name) => ({ name }));

  for (const { relPath, root } of files) {
    const decls = declsByName(root);
    const fileId = idGen.fileId(relPath);

    // --- 1. structs ---
    for (const node of root.descendantsOfType(STRUCT_ITEM) as TsNode[]) {
      const name = itemName(node);
      if (!name) continue;
      const id = idGen.classId(relPath, [...rustTypeChain(node), name].join('::'));
      const facts = implFacts.get(typeKey(relPath, name));
      mint({
        id,
        versionedId: idGen.versionedId(id, node.text as string),
        name,
        kind: 'class',
        fileId,
        isExported: isPublic(node),
        isAbstract: false,
        ...(facts && facts.traits.length > 0 ? { implements: asRefs(facts.traits) } : {}),
        methods: facts?.methodIds ?? [],
        properties: structProperties(node, id, relPath, idGen),
        // Spelled out so TS does not pick up the implicit `Object.prototype.constructor`
        // shape for the optional `constructor` field (matches facts/structural/to-nodes.ts).
        constructor: undefined,
        location: locationOf(node, relPath),
      });
    }

    // --- 2. impl targets that no struct node covers (enums, foreign types, other-file structs) ---
    for (const implNode of root.descendantsOfType(IMPL_ITEM) as TsNode[]) {
      const name = implTypeName(implNode);
      if (!name) continue;
      const facts = implFacts.get(typeKey(relPath, name));
      if (!facts || facts.methodIds.length === 0) continue;
      const id = idGen.classId(relPath, [...rustTypeChain(implNode), name].join('::'));
      if (byId.has(id)) continue;
      // Prefer the type's own declaration for location/visibility when it is in THIS file (the
      // enum case); otherwise the impl block is the only evidence this file holds.
      const decl = decls.get(name);
      const anchor = decl ?? facts.node;
      mint({
        id,
        versionedId: idGen.versionedId(id, anchor.text as string),
        name,
        kind: 'class',
        fileId,
        // With no local declaration the type's visibility lives in another file; Tier-B cannot see
        // it, and claiming `pub` for an unseen declaration would be a guess.
        isExported: decl ? isPublic(decl) : false,
        isAbstract: false,
        ...(facts.traits.length > 0 ? { implements: asRefs(facts.traits) } : {}),
        methods: facts.methodIds,
        properties: [],
        constructor: undefined,
        location: locationOf(anchor, relPath),
      });
    }

    // --- 3. traits with default-bodied methods ---
    for (const node of root.descendantsOfType(TRAIT_ITEM) as TsNode[]) {
      const name = itemName(node);
      if (!name) continue;
      const methods: string[] = [];
      for (const fn of node.descendantsOfType(FUNCTION_ITEM) as TsNode[]) {
        const fnId = rustFunctionId(idGen, relPath, fn);
        if (!methods.includes(fnId)) methods.push(fnId);
      }
      if (methods.length === 0) continue;
      const id = idGen.classId(relPath, [...rustTypeChain(node), name].join('::'));
      if (byId.has(id)) continue;
      mint({
        id,
        versionedId: idGen.versionedId(id, node.text as string),
        name,
        kind: 'class',
        fileId,
        isExported: isPublic(node),
        // A trait is Rust's abstract type: it declares behaviour that other types supply.
        isAbstract: true,
        methods,
        properties: [],
        constructor: undefined,
        location: locationOf(node, relPath),
      });
    }
  }

  return [...byId.values()];
}
