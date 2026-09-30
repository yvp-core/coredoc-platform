/**
 * Ruby `class` / `module` definition → `ClassNode`.
 *
 * Every method the call-graph lane emits already carries `classId = idGen.classId(relPath,
 * <enclosing class/module name>)`, but no class node was ever emitted — so every method pointed
 * at a phantom container and the class side of `explain` / `list-file-symbols` was empty. The id
 * is derived the SAME way `rubyMethodId` derives the name it hashes (the IMMEDIATE enclosing
 * class/module's own `name` text, so `class A::B` keys on 'A::B' and a `class B` nested in
 * `module A` keys on 'B'), so `class.id === method.classId` by construction.
 *
 * A `module` is emitted as a ClassNode too: it is the container the methods name, and it is
 * marked abstract because a Ruby module cannot be instantiated.
 *
 * Mixins (`include`/`extend`/`prepend`) are NOT mapped onto `implements`: the call-graph index
 * records them as ancestry keyed by class NAME repo-wide, which is a different (coarser) key
 * than the per-file class node, and no consumer reads them class-side today.
 */
import type { ClassNode, StableIdGenerator, TypeReference } from '@coredoc/core';
import { type TsNode, defOrClassName, qualifiedClassName } from './ruby-cst.js';

/** tree-sitter-ruby node type for a `module` definition (a `class` is the other CLASS_TYPE). */
const MODULE_TYPE = 'module';

/**
 * A `ClassNode` for one `class`/`module` node, or undefined when the definition has no name
 * (a malformed/ERROR parse) — an unnamed container is exactly what a method must NOT reference.
 * `methods` starts empty; the def walk fills it with the ids it minted for this container.
 */
export function rubyClassNode(node: TsNode, relPath: string, idGen: StableIdGenerator): ClassNode | undefined {
  const name = defOrClassName(node);
  if (!name) return undefined;
  // The ID carries the namespace so two same-named classes in one file are two
  // nodes; `name` stays the bare form because it is the search/display token and
  // `findCode` matches it by substring (a qualified `name` would break exact-name
  // lookups for `Client`). Must stay in step with `rubyMethodId`, which hashes the
  // same qualified segment so `method.classId === class.id` holds.
  const id = idGen.classId(relPath, qualifiedClassName(node) ?? name);
  const superclass = (node.childForFieldName?.('superclass')?.text as string | undefined)?.replace(/^<\s*/, '').trim();
  return {
    id,
    versionedId: idGen.versionedId(id, node.text as string),
    name,
    kind: 'class',
    fileId: idGen.fileId(relPath),
    // Ruby has no export gate — a constant is reachable from anywhere the namespace is.
    isExported: true,
    isAbstract: node.type === MODULE_TYPE,
    ...(superclass ? { extends: { name: superclass } satisfies TypeReference } : {}),
    methods: [],
    // Spelled out so TS does not pick up the implicit `Object.prototype.constructor` shape
    // (same reason as the TS structural path). Ruby's `initialize` is an ordinary method and
    // is already in `methods`.
    constructor: undefined,
    // Model FIELDS are emitted by the entity lane; a generic property lane would duplicate
    // that with no consumer.
    properties: [],
    location: {
      filePath: relPath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    },
  };
}
