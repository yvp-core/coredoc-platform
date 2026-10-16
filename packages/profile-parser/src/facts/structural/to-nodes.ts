import type { StableIdGenerator } from '@coredoc/core';
import type {
  CallEdge,
  ClassNode,
  EnumNode,
  FunctionNode,
  ImportEdge,
  InterfaceNode,
  TypeAliasNode,
  VariableNode,
} from '@coredoc/core/types';
import type { CodeGraph } from '../graph/graph-builder.js';
import { isBuiltinReceiverCall } from '../noise.js';
import type { StructuralFile } from './ts-structural.js';

/**
 * Map a StructuralFile to OutputFormat nodes using the canonical id scheme.
 * versionedId is a content checksum: it hashes the symbol's actual source slice (matching the
 * canonical parser, so identical source ⇒ identical versionedId and a real edit ⇒ a new one),
 * falling back to a name+location seed only when no source slice was provided.
 */
export function structuralToNodes(
  file: StructuralFile,
  g: CodeGraph,
  idGen: StableIdGenerator,
  _packageId: string,
  source?: string,
): void {
  const fileId = idGen.fileId(file.path);
  // Per-node source slice by 1-based line span (split once per file). Capped to guard against
  // pathological/minified functions bloating the output; undefined when no source was provided.
  const lines = source?.split('\n');
  const sliceSrc = (startLine: number, endLine: number): string | undefined =>
    lines
      ? lines
          .slice(startLine - 1, endLine)
          .join('\n')
          .slice(0, 20000)
      : undefined;
  // versionedId checksum seed: the real per-symbol source when available (true content checksum),
  // else the name+location fallback (keeps ids stable when source wasn't loaded).
  const checksum = (startLine: number, endLine: number, seed: string): string => sliceSrc(startLine, endLine) ?? seed;

  for (const imp of file.imports) {
    const edge: ImportEdge = {
      id: idGen.importEdgeId(fileId, imp.moduleSpecifier),
      sourceFileId: fileId,
      moduleSpecifier: imp.moduleSpecifier,
      isTypeOnly: imp.isTypeOnly,
      importKind: imp.kind,
      importedNames: imp.names.map((n) => ({ name: n.name, alias: n.alias })),
    };
    g.addImport(edge);
  }

  for (const fn of file.functions) {
    const id = idGen.functionId(file.path, fn.name || 'anonymous');
    const sourceCode = sliceSrc(fn.startLine, fn.endLine);
    const node: FunctionNode = {
      id,
      versionedId: idGen.versionedId(id, sourceCode ?? `${fn.name}:${fn.startLine}-${fn.endLine}`),
      name: fn.name || 'anonymous',
      kind: 'function',
      fileId,
      isAsync: fn.isAsync,
      isGenerator: false,
      isExported: fn.isExported,
      parameters: fn.params.map((p) => ({
        name: p.name,
        // Honest: only emit a type when the source annotates one. tree-sitter cannot infer, and faking
        // `any` would diverge from the baselines for inferable code (ts-morph infers the real type).
        // The parsed STRUCTURE is carried when the annotation is one `parseTypeNode` models, so a
        // consumer can read the types the parameter names instead of re-parsing its text.
        type: p.type ? (p.typeInfo ?? { text: p.type }) : undefined,
        isOptional: p.isOptional,
        isRest: p.isRest,
      })),
      // Only the annotated return type; left undefined when unannotated (a later SCIP/type-inference
      // pass can fill it — strictly better than fabricating `any`).
      returnType: fn.returnType ? { text: fn.returnType } : undefined,
      documentation: fn.documentation,
      location: { filePath: file.path, startLine: fn.startLine, endLine: fn.endLine },
      sourceCode,
    };
    g.addFunction(node);
  }

  for (const cls of file.classes) {
    const classId = idGen.classId(file.path, cls.name || 'AnonymousClass');
    const methodIds: string[] = [];
    for (const m of cls.methods) {
      const mid = idGen.methodId(file.path, cls.name || 'Class', m.name);
      methodIds.push(mid);
      const mSourceCode = sliceSrc(m.startLine, m.endLine);
      const mnode: FunctionNode = {
        id: mid,
        versionedId: idGen.versionedId(mid, mSourceCode ?? `${cls.name}.${m.name}:${m.startLine}-${m.endLine}`),
        name: m.name,
        kind: 'method',
        fileId,
        classId,
        isAsync: m.isAsync,
        isGenerator: false,
        isStatic: m.isStatic,
        visibility: m.visibility,
        parameters: m.params.map((p) => ({
          name: p.name,
          type: p.type ? (p.typeInfo ?? { text: p.type }) : undefined,
          isOptional: p.isOptional,
          isRest: p.isRest,
        })),
        returnType: m.returnType ? { text: m.returnType } : undefined,
        documentation: m.documentation,
        location: { filePath: file.path, startLine: m.startLine, endLine: m.endLine },
        sourceCode: mSourceCode,
      };
      g.addFunction(mnode);
    }
    const node: ClassNode = {
      id: classId,
      versionedId: idGen.versionedId(
        classId,
        checksum(cls.startLine, cls.endLine, `${cls.name}:${cls.startLine}-${cls.endLine}`),
      ),
      name: cls.name || 'AnonymousClass',
      kind: 'class',
      fileId,
      isExported: cls.isExported,
      isAbstract: cls.isAbstract,
      // Heritage as declared, by NAME only — `resolveHierarchyRefIdentity` binds `resolvedId`
      // later, once every file's structure is present (a barrel hop reads other files).
      extends: cls.extendsClass ? { name: cls.extendsClass.name } : undefined,
      implements: cls.implementsNames.length ? cls.implementsNames.map((name) => ({ name })) : undefined,
      methods: methodIds,
      // A class property is not a graph node (nothing registers these ids in the
      // node registry, and USES_TYPE edges from a property are sourced at the CLASS).
      // The id is required by the shape, so derive it from the owning class + name.
      properties: cls.properties.map((p) => ({
        id: `${classId}:property:${p.name}`,
        name: p.name,
        classId,
        visibility: p.visibility,
        isStatic: p.isStatic,
        isReadonly: p.isReadonly,
        isOptional: p.isOptional,
        type: p.typeInfo,
        location: { filePath: file.path, startLine: p.startLine, endLine: p.endLine },
      })),
      // `constructor` is intentionally omitted: spell it out so TS doesn't pick
      // up the implicit `Object.prototype.constructor` shape (matches the
      // canonical parser in @coredoc/core).
      constructor: undefined,
      documentation: cls.documentation,
      location: { filePath: file.path, startLine: cls.startLine, endLine: cls.endLine },
    };
    g.addClass(node);
  }

  for (const iface of file.interfaces) {
    const id = idGen.interfaceId(file.path, iface.name);
    const node: InterfaceNode = {
      id,
      versionedId: idGen.versionedId(
        id,
        checksum(iface.startLine, iface.endLine, `${iface.name}:${iface.startLine}-${iface.endLine}`),
      ),
      name: iface.name,
      kind: 'interface',
      fileId,
      isExported: iface.isExported,
      extends: iface.extends.map((name) => ({ name })),
      members: iface.members.map((m) => ({
        name: m.name,
        kind: m.kind,
        type: m.type,
        returnType: m.returnType,
        isOptional: m.isOptional,
        isReadonly: m.isReadonly,
        location: { filePath: file.path, startLine: m.startLine, endLine: m.endLine },
      })),
      documentation: iface.documentation,
      location: { filePath: file.path, startLine: iface.startLine, endLine: iface.endLine },
    };
    g.addInterface(node);
  }

  for (const ta of file.typeAliases) {
    const id = idGen.typeAliasId(file.path, ta.name);
    const node: TypeAliasNode = {
      id,
      versionedId: idGen.versionedId(
        id,
        checksum(ta.startLine, ta.endLine, `${ta.name}:${ta.startLine}-${ta.endLine}`),
      ),
      name: ta.name,
      kind: 'type-alias',
      fileId,
      isExported: ta.isExported,
      // tree-sitter has no type inference; emit the annotated alias source text (honest), or
      // 'unknown' when the grammar didn't expose it (aliasedType is required on the node).
      aliasedType: ta.aliasedTypeInfo ?? { text: ta.aliasedType ?? 'unknown' },
      documentation: ta.documentation,
      location: { filePath: file.path, startLine: ta.startLine, endLine: ta.endLine },
    };
    g.addTypeAlias(node);
  }

  for (const en of file.enums) {
    const id = idGen.enumId(file.path, en.name);
    const node: EnumNode = {
      id,
      versionedId: idGen.versionedId(
        id,
        checksum(en.startLine, en.endLine, `${en.name}:${en.startLine}-${en.endLine}`),
      ),
      name: en.name,
      kind: 'enum',
      fileId,
      isExported: en.isExported,
      isConst: en.isConst,
      members: en.members.map((m) => ({ name: m.name, value: m.value })),
      documentation: en.documentation,
      location: { filePath: file.path, startLine: en.startLine, endLine: en.endLine },
    };
    g.addEnum(node);
  }

  for (const v of file.variables) {
    const id = idGen.variableId(file.path, v.name);
    const node: VariableNode = {
      id,
      versionedId: idGen.versionedId(id, checksum(v.startLine, v.endLine, `${v.name}:${v.startLine}-${v.endLine}`)),
      name: v.name,
      kind: 'variable',
      fileId,
      isExported: v.isExported,
      declarationKind: v.declarationKind,
      // Only the annotated type; tree-sitter cannot infer (a later SCIP/type pass can fill it).
      type: v.type ? { text: v.type } : undefined,
      initialValue: v.initialValue,
      documentation: v.documentation,
      location: { filePath: file.path, startLine: v.startLine, endLine: v.endLine },
    };
    g.addVariable(node);
  }

  // Structural same-file call edges (unresolved — SCIP/overlay resolve calleeId later).
  for (const call of file.calls) {
    // Skip calls on built-in globals (console.log, Math.max, JSON.parse, …): never a graph edge,
    // and dropping them here also keeps them out of the overlay residue.
    if (isBuiltinReceiverCall(call.receiver)) continue;
    const callerId = resolveEnclosingId(call, file, idGen);
    if (!callerId) continue;
    const loc = `${file.path}:${call.startLine}`;
    const edge: CallEdge = {
      id: idGen.callEdgeId(callerId, call.expressionText, loc),
      callerId,
      calleeExpression: call.expressionText,
      isMethodCall: Boolean(call.receiver),
      isAsync: call.isAwaited || undefined,
      arguments: call.arguments.length ? call.arguments : undefined,
      location: { filePath: file.path, startLine: call.startLine, endLine: call.endLine },
    };
    g.addCall(edge);
  }

  // Value-position enum-member references (`Status.Locked`). The enum stays UNRESOLVED here —
  // `assemble` keeps only references naming an emitted enum, and the storage layer resolves the
  // (name, importedFrom) pair to the declaring enum node.
  for (const ref of file.enumMemberRefs) {
    const sourceId = resolveEnclosingId(ref, file, idGen);
    if (!sourceId) continue; // module-level references have no function node to source the edge at
    g.addEnumMemberRef({
      id: idGen.enumMemberRefEdgeId(sourceId, ref.enumName, ref.member, ref.importedFrom),
      sourceId,
      enumName: ref.enumName,
      importedFrom: ref.importedFrom,
      // No import means the enum is declared in this very file — identity is already proved.
      declaringFile: ref.importedFrom === undefined ? file.path : undefined,
      member: ref.member,
      location: { filePath: file.path, startLine: ref.startLine, endLine: ref.startLine },
    });
  }

  // Class references (`new X()` and import sites). A construction site is sourced at the enclosing
  // function/method; an import belongs to the MODULE, so it is sourced at the file node. A
  // construction at module scope (`export const client = new Client()`) has no enclosing function
  // and is sourced at the FILE for the same reason — the module is what constructs it, and dropping
  // it would leave the singleton-per-module shape with no incoming usage at all. The class stays
  // UNRESOLVED here — the identity pass proves the declaring module, `assemble` keeps only
  // references naming an emitted class, and the storage layer links the node.
  for (const ref of file.classRefs) {
    const sourceId =
      (ref.refKind === 'construction' ? resolveEnclosingId(ref, file, idGen) : undefined) ?? idGen.fileId(file.path);
    g.addClassRef({
      id: idGen.classRefEdgeId(sourceId, ref.className, ref.refKind, ref.importedFrom),
      sourceId,
      refKind: ref.refKind,
      className: ref.className,
      ...(ref.localName ? { localName: ref.localName } : {}),
      importedFrom: ref.importedFrom,
      // No import means the class is declared in this very file — identity is already proved.
      declaringFile: ref.importedFrom === undefined ? file.path : undefined,
      location: { filePath: file.path, startLine: ref.startLine, endLine: ref.startLine },
    });
  }
}

/** The enclosing function/method id of a site, or undefined for module scope. */
function resolveEnclosingId(
  site: { enclosingKind: 'method' | 'function' | 'module'; enclosingClass?: string; enclosingName?: string },
  file: StructuralFile,
  idGen: StableIdGenerator,
): string | undefined {
  if (site.enclosingKind === 'method' && site.enclosingClass && site.enclosingName) {
    return idGen.methodId(file.path, site.enclosingClass, site.enclosingName);
  }
  if (site.enclosingKind === 'function' && site.enclosingName) {
    return idGen.functionId(file.path, site.enclosingName);
  }
  return undefined; // module-level calls have no FunctionNode caller in v1
}
