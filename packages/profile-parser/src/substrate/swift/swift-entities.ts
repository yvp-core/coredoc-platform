/**
 * Swift ORM models → EntityNode[]. Generic — base classes and ORM label come from config
 * (`SwiftEntityConfig`), never hard-coded model names. Two passes mirror the Ruby/TS entity
 * engines: Pass A registers every model (name → id) so relations resolve cross-model ids;
 * Pass B emits one EntityNode per model with fields from stored properties and relations to
 * other registered models. Default target is Realm (`class FooDB: Object`).
 *
 * Core Data declares a model's attributes as `@NSManaged` properties in a SEPARATE
 * `extension FooDB` (Xcode's `+CoreDataProperties.swift`), so stored members are read from the
 * class AND every extension of it. An extension cannot hold an instance stored property other
 * than `@NSManaged`, so only those count there.
 */
import type { EntityField, EntityNode, EntityRelation, StableIdGenerator } from '@coredoc/core';
import {
  PROPERTY_DECL,
  TYPE_CONTAINERS,
  TYPE_DECL,
  type TsNode,
  baseTypeIdentifier,
  computedBody,
  declKind,
  inheritedTypes,
  isStaticDecl,
  nearestAncestor,
  propertyName,
  typeAnnotationNode,
  typeName,
} from './swift-cst.js';
import type { SwiftFile } from './swift-callgraph.js';

export interface SwiftEntityConfig {
  idGen: StableIdGenerator;
  /** Base classes that mark a type as a persisted entity (e.g. ['Object'] for Realm). */
  baseClasses: string[];
  orm: string;
}

interface ModelInfo {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  node: TsNode;
  /** `extension <name>` declarations anywhere in the repo. */
  extensions: TsNode[];
}

/** Whether a property carries the `@NSManaged` attribute (a Core Data attribute or relationship). */
function isNSManaged(prop: TsNode): boolean {
  for (let i = 0; i < prop.childCount; i++) {
    const c = prop.child(i);
    if (c?.type !== 'modifiers') continue;
    for (let j = 0; j < c.childCount; j++) {
      const m = c.child(j);
      if (m?.type === 'attribute' && /^@NSManaged\b/.test(m.text as string)) return true;
    }
  }
  return false;
}

/** Whether a `property_declaration` marks the primary key (Realm `@Persisted(primaryKey: true)`). */
function isPrimaryKey(prop: TsNode): boolean {
  for (let i = 0; i < prop.childCount; i++) {
    const c = prop.child(i);
    if (c?.type === 'modifiers' && /primaryKey/.test(c.text as string)) return true;
  }
  return false;
}

/**
 * The DIRECT stored (non-computed) properties of a model — excluding properties declared inside
 * a NESTED type (a struct/enum/class nested in the Realm model), which belong to that nested
 * type, not the model. Scoping by the nearest type container mirrors the DI pre-pass and db-op
 * `DBObject` scoping elsewhere in the substrate.
 */
function directStoredProps(model: ModelInfo): TsNode[] {
  const out: TsNode[] = [];
  for (const decl of [model.node, ...model.extensions]) {
    const isExtension = decl !== model.node;
    for (const prop of decl.descendantsOfType(PROPERTY_DECL) as TsNode[]) {
      if (computedBody(prop)) continue; // computed var, not a stored column
      if (nearestAncestor(prop, TYPE_CONTAINERS)?.id !== decl.id) continue; // member of a nested type
      if (isExtension && (isStaticDecl(prop) || !isNSManaged(prop))) continue;
      out.push(prop);
    }
  }
  return out;
}

interface PropType {
  text: string;
  isNullable: boolean;
  /** The scalar/reference base type name (for a to-one relation to another entity). */
  base?: string;
  /** The element type of a Realm to-many (`List<Foo>` / `LinkingObjects<Foo>`). */
  toManyTarget?: string;
}

const LITERAL_TYPES: Record<string, string> = {
  integer_literal: 'Int',
  real_literal: 'Double',
  boolean_literal: 'Bool',
  line_string_literal: 'String',
};

/**
 * The type of a stored property, from its `: Type` annotation when present, else INFERRED from
 * its initializer — Realm idiomatically omits annotations (`@Persisted var count = 0`,
 * `let logs = List<ActionLogDB>()`). Returns undefined only when neither a type nor an
 * initializer is present (no type to record).
 */
function propType(prop: TsNode): PropType | undefined {
  const ann = typeAnnotationNode(prop);
  if (ann) {
    const base = baseTypeIdentifier(ann);
    if (base === 'List' || base === 'LinkingObjects') {
      const ids = ann.descendantsOfType?.('type_identifier') as TsNode[] | undefined;
      return { text: ann.text as string, isNullable: false, toManyTarget: ids?.[ids.length - 1]?.text as string };
    }
    return { text: ann.text as string, isNullable: ann.type === 'optional_type', base };
  }
  const val = prop.childForFieldName?.('value');
  if (!val) return undefined;
  const text = (val.text as string).slice(0, 60);
  // A construction: `List<Foo>()` / `LinkingObjects<Foo>()` (parsed as `constructor_expression`)
  // or `Foo()` (a `call_expression`). Realm to-many collections declare their element type only
  // in this initializer, never an annotation.
  if (val.type === 'constructor_expression' || val.type === 'call_expression') {
    const ctorTypeNode = val.childForFieldName?.('constructed_type') ?? val;
    const typeIds = ctorTypeNode.descendantsOfType?.('type_identifier') as TsNode[] | undefined;
    const ctorName = (typeIds?.[0]?.text ?? val.descendantsOfType?.('simple_identifier')?.[0]?.text) as
      | string
      | undefined;
    if (ctorName === 'List' || ctorName === 'LinkingObjects') {
      return { text, isNullable: false, toManyTarget: typeIds?.[typeIds.length - 1]?.text as string };
    }
    return { text, isNullable: false, base: ctorName };
  }
  return {
    text: LITERAL_TYPES[val.type as string] ?? text,
    isNullable: false,
    base: LITERAL_TYPES[val.type as string],
  };
}

/** Direct stored properties of a model → EntityField[] (annotated or initializer-inferred). */
function buildFields(model: ModelInfo): EntityField[] {
  const out: EntityField[] = [];
  for (const prop of directStoredProps(model)) {
    const name = propertyName(prop);
    const pt = propType(prop);
    if (!name || !pt) continue;
    out.push({
      name,
      columnName: name,
      type: { text: pt.text },
      isPrimaryKey: isPrimaryKey(prop),
      isNullable: pt.isNullable,
      isUnique: false,
      isGenerated: false,
    });
  }
  return out;
}

/** Relations: direct stored properties whose (unwrapped) type references another registered model. */
function buildRelations(model: ModelInfo, entityIdByName: Map<string, string>): EntityRelation[] {
  const out: EntityRelation[] = [];
  for (const prop of directStoredProps(model)) {
    const name = propertyName(prop);
    const pt = propType(prop);
    if (!name || !pt) continue;
    // Realm to-many: `List<Foo>` / `LinkingObjects<Foo>`.
    if (pt.toManyTarget && entityIdByName.has(pt.toManyTarget)) {
      out.push({
        name,
        type: 'one-to-many',
        targetEntityName: pt.toManyTarget,
        targetEntityId: entityIdByName.get(pt.toManyTarget),
      });
      continue;
    }
    if (pt.base && entityIdByName.has(pt.base)) {
      out.push({ name, type: 'many-to-one', targetEntityName: pt.base, targetEntityId: entityIdByName.get(pt.base) });
    }
  }
  return out;
}

export function extractSwiftEntities(
  files: SwiftFile[],
  cfg: SwiftEntityConfig,
): { entities: EntityNode[]; entityIdByName: Map<string, string> } {
  const baseSet = new Set(cfg.baseClasses);
  const models: ModelInfo[] = [];
  const entityIdByName = new Map<string, string>();
  const extensionsByName = new Map<string, TsNode[]>();

  // Pass A — register every model (name → id), and index extensions by the type they extend.
  for (const { relPath, root } of files) {
    for (const tnode of root.descendantsOfType(TYPE_DECL) as TsNode[]) {
      const kind = declKind(tnode);
      if (kind === 'extension') {
        const extended = typeName(tnode);
        if (extended) extensionsByName.set(extended, [...(extensionsByName.get(extended) ?? []), tnode]);
        continue;
      }
      if (kind !== 'class' && kind !== 'struct') continue;
      if (!inheritedTypes(tnode).some((t) => baseSet.has(t))) continue;
      const name = typeName(tnode);
      if (!name) continue;
      models.push({
        name,
        filePath: relPath,
        startLine: tnode.startPosition.row + 1,
        endLine: tnode.endPosition.row + 1,
        node: tnode,
        extensions: [],
      });
      if (!entityIdByName.has(name)) entityIdByName.set(name, cfg.idGen.entityId(relPath, name));
    }
  }

  // Pass B — emit one EntityNode per registered model.
  const entities: EntityNode[] = models.map((model) => {
    model.extensions = extensionsByName.get(model.name) ?? [];
    const id = cfg.idGen.entityId(model.filePath, model.name);
    const fields = buildFields(model);
    const relations = buildRelations(model, entityIdByName);
    return {
      id,
      // Extensions contribute fields, so an edit to one must change the version too.
      versionedId: cfg.idGen.versionedId(id, [model.node, ...model.extensions].map((n) => n.text as string).join('\n')),
      name: model.name,
      kind: 'entity',
      fileId: cfg.idGen.fileId(model.filePath),
      ormType: cfg.orm,
      tableName: model.name,
      fields,
      relations,
      location: { filePath: model.filePath, startLine: model.startLine, endLine: model.endLine },
    };
  });

  return { entities, entityIdByName };
}
