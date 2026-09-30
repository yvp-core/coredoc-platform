/**
 * ActiveRecord models -> EntityNode[]. Generic ActiveRecord — base classes and ORM
 * label come from config (`RubyEntityConfig`), never hard-coded model/table names. Two
 * passes mirror the TS entity engine: Pass A registers every model (name -> id, table
 * name) so relations can resolve cross-model ids; Pass B emits one EntityNode per model
 * with fields drawn from the parsed `schema.rb` and relations from association macros.
 *
 * Pass A hands Pass B PLAIN DATA (`ModelInfo`), never CST nodes: holding a node holds its whole
 * WASM tree, and web-tree-sitter neither GCs trees nor grows past 2GB — see `ModelInfo`.
 *
 * Parsing is async (grammar load), so this extractor is async; the result shape is the
 * specified `{ entities, entityIdByName }`.
 */
import type { EntityField, EntityIndex, EntityNode, EntityRelation, StableIdGenerator } from '@coredoc/core';
import {
  CLASS_TYPES,
  DEF_TYPES,
  SINGLETON_CLASS_TYPE,
  type TsNode,
  firstArg,
  methodName,
  nearestAncestor,
  qualifiedClassName,
  tokenText,
  withParsedRuby,
} from './ruby-cst.js';
import { classify, pluralize, snakeCase } from './ruby-inflect.js';
import type { SchemaTable } from './ruby-schema.js';

export interface RubyEntityConfig {
  /** Canonical id generator (seeded for this repo) — mints entity/file ids. */
  idGen: StableIdGenerator;
  /** Superclasses that mark a class as a model, e.g. ['ApplicationRecord', 'ActiveRecord::Base']. */
  baseClasses: string[];
  orm: string;
}

/**
 * Association macro -> relation cardinality. A `Map`, not an object literal: the key is a method
 * NAME read out of Ruby source, and a plain object answers `constructor` / `toString` from
 * `Object.prototype`, so `constructor :foo` in a model body read as an association macro.
 */
const ASSOCIATION_TYPES = new Map<string, EntityRelation['type']>([
  ['has_many', 'one-to-many'],
  ['belongs_to', 'many-to-one'],
  ['has_one', 'one-to-one'],
  ['has_and_belongs_to_many', 'many-to-many'],
]);

/**
 * One association macro, reduced to the plain values Pass B needs. Read in Pass A while the model's
 * tree is still alive, because the relation itself cannot be built yet: `targetEntityId` needs the
 * cross-model `entityIdByName` that only exists once every model is registered.
 */
interface AssociationInfo {
  macro: string;
  assocName: string;
  /** `class_name:` override, when the macro gives one. */
  className?: string;
  foreignKey?: string;
  through?: string;
  dependent?: string;
  polymorphic: boolean;
  /** 1-based line of the macro call — the location a synthesized reader node reports. */
  line: number;
  /**
   * Whether the macro DECLARES on the model: its nearest scope is the model class itself (not a
   * nested class, a `class << self` block or a `def` body) and it has no explicit receiver.
   * `associationCalls` scans DESCENDANTS, so a macro anywhere inside the class is reported on the
   * model — harmless for a relation, but a synthesized reader minted from it is a method Ruby
   * never defined on the model. Readers use this; relations do not, so the emitted entity
   * relations stay byte-identical.
   */
  ownScope: boolean;
}

/**
 * One association reader the call graph may synthesize: the macro's own name, on the
 * NESTING-QUALIFIED class that declared it (the key the repo-wide def index uses — a bare
 * `Invoice` would merge `Billing::Invoice` with a top-level one).
 */
export interface RubyAssociationReader {
  name: string;
  macro: string;
  filePath: string;
  line: number;
}

/**
 * A registered model as PLAIN DATA — deliberately no `classNode`. Holding the node would keep its
 * whole tree alive until Pass B ran, which turned a per-file WASM peak into a per-repo one against
 * web-tree-sitter's hard 2GB cap (every `app/models/**` tree resident at once). Everything Pass B
 * reads off the class node is extracted here instead, so each tree is freed at the end of its own
 * iteration and at most one is ever live.
 */
interface ModelInfo {
  name: string;
  /** Nesting-qualified class name (`module Billing; class Invoice` → 'Billing::Invoice'). */
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  tableName: string;
  /** The class body source — the version seed (`versionedId`) is derived from it. */
  classText: string;
  associations: AssociationInfo[];
}

/** Last `::`-segment of a constant path, with a leading `::` stripped. */
function demodulize(constant: string): string {
  const stripped = constant.replace(/^::/, '');
  const parts = stripped.split('::');
  return parts[parts.length - 1];
}

/** Constant-path segments, with a leading `::` stripped (`'::A::B'` -> ['A','B']). */
function segments(constant: string): string[] {
  return constant.replace(/^::/, '').split('::');
}

/**
 * Whether a superclass path matches a configured base class. The superclass must END WITH
 * the base's segments, so a bare `Base` does NOT match a configured `ActiveRecord::Base`
 * while `::ActiveRecord::Base` does — and a single-segment base like `ApplicationRecord`
 * matches any superclass ending in `ApplicationRecord`.
 */
function matchesBase(superSegs: string[], baseSegs: string[]): boolean {
  if (baseSegs.length > superSegs.length) return false;
  const offset = superSegs.length - baseSegs.length;
  return baseSegs.every((seg, i) => seg === superSegs[offset + i]);
}

/** The model constant declared by a `class` node (`class Admin::Foo` -> "Foo"). */
function className(classNode: TsNode): string | undefined {
  const nameNode = classNode.childForFieldName?.('name');
  if (!nameNode) return undefined;
  return demodulize(nameNode.text);
}

/** The superclass constant path of a `class` node (`< ::A::B` -> "::A::B"), or undefined if none. */
function superclassPath(classNode: TsNode): string | undefined {
  const sc = classNode.childForFieldName?.('superclass');
  if (!sc) return undefined;
  // superclass node text is `< Foo` / `< ::A::B::Base`; drop the leading `<`.
  return (sc.text as string).replace(/^<\s*/, '').trim();
}

/** Top-level association-macro calls in a class body (`belongs_to`, `has_many`, …). */
function associationCalls(classNode: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (const call of classNode.descendantsOfType('call') as TsNode[]) {
    const m = methodName(call);
    if (m && ASSOCIATION_TYPES.has(m)) out.push(call);
  }
  return out;
}

/** `self.table_name = "x"` literal, if the model overrides the convention. */
function explicitTableName(classNode: TsNode): string | undefined {
  for (const assign of classNode.descendantsOfType('assignment') as TsNode[]) {
    const left = assign.childForFieldName?.('left');
    if (left && /(^|\.)table_name$/.test(left.text) && /\bself\b/.test(left.text)) {
      const right = assign.childForFieldName?.('right');
      if (right?.type === 'string') return tokenText(right);
    }
  }
  return undefined;
}

/** Value of a `key:` option in a call's argument hash. Returns the unquoted string/symbol text. */
function optionValue(call: TsNode, key: string): string | undefined {
  for (const pair of call.descendantsOfType('pair') as TsNode[]) {
    const k = pair.childForFieldName?.('key');
    const keyText = k ? (k.text as string).replace(/:$/, '') : undefined;
    if (keyText !== key) continue;
    const v = pair.childForFieldName?.('value');
    if (!v) return undefined;
    if (v.type === 'string' || v.type === 'simple_symbol') return tokenText(v);
    return v.text;
  }
  return undefined;
}

/** Whether a `key: true` option is present on the call. */
function hasFlag(call: TsNode, key: string): boolean {
  for (const pair of call.descendantsOfType('pair') as TsNode[]) {
    const k = pair.childForFieldName?.('key');
    const keyText = k ? (k.text as string).replace(/:$/, '') : undefined;
    if (keyText === key) return pair.childForFieldName?.('value')?.text === 'true';
  }
  return false;
}

function entityId(cfg: RubyEntityConfig, filePath: string, name: string): string {
  return cfg.idGen.entityId(filePath, name);
}

function fileId(cfg: RubyEntityConfig, relPath: string): string {
  return cfg.idGen.fileId(relPath);
}

/**
 * Every scope a macro call can sit in: a class, a module, a `class << self` block — and a method
 * body. `def` belongs here even though it declares nothing: without it, `other.has_many :employees`
 * inside `def self.configure(other)` reported the MODEL as its nearest scope, and a reader was
 * synthesized for a method Ruby never defines on it (it defines one on whatever `other` is, at
 * call time).
 */
const MACRO_SCOPES = new Set([...CLASS_TYPES, SINGLETON_CLASS_TYPE, ...DEF_TYPES]);

/** One association macro → its plain values, read while the tree is alive (Pass A). */
function toAssociationInfo(call: TsNode, macro: string, classNode: TsNode): AssociationInfo | undefined {
  const assocName = firstArg(call)?.value;
  if (!assocName) return undefined;
  return {
    macro,
    assocName,
    line: call.startPosition.row + 1,
    // Own-scope means BOTH: the macro's nearest scope is the model class itself (not a nested
    // class, a `class << self` block or a `def` body) AND it has no explicit receiver — a bare
    // `has_many :x`. `other.has_many :x` declares on another object, never on this model.
    ownScope: nearestAncestor(call, MACRO_SCOPES)?.id === classNode.id && !call.childForFieldName?.('receiver'),
    className: optionValue(call, 'class_name'),
    foreignKey: optionValue(call, 'foreign_key'),
    through: optionValue(call, 'through'),
    dependent: optionValue(call, 'dependent'),
    // Polymorphic belongs_to: the target is the association name itself (no concrete model).
    polymorphic: macro === 'belongs_to' && hasFlag(call, 'polymorphic'),
  };
}

function buildRelation(assoc: AssociationInfo, entityIdByName: Map<string, string>): EntityRelation {
  // `classify` already singularizes — do NOT wrap in another `singularize` (that produced
  // wrong targets for plural assocs whose singular still ends in a sibilant, e.g.
  // has_many :statuses → 'Statu'). classify handles both singular and plural assoc names.
  const targetEntityName = assoc.polymorphic
    ? classify(assoc.assocName)
    : (assoc.className ?? classify(assoc.assocName));

  return {
    name: assoc.assocName,
    type: ASSOCIATION_TYPES.get(assoc.macro) as EntityRelation['type'],
    targetEntityName,
    targetEntityId: assoc.polymorphic ? undefined : entityIdByName.get(targetEntityName),
    joinColumn: assoc.foreignKey,
    inverseSide: assoc.through,
    cascade: assoc.dependent !== undefined ? ['delete'] : undefined,
  };
}

/** Unique indexes (single + composite) from the schema table → EntityNode.indexes. */
function buildIndexes(table: SchemaTable | undefined): EntityIndex[] {
  if (!table) return [];
  return table.uniqueIndexes.map((columns) => ({ columns, isUnique: true }));
}

function buildFields(table: SchemaTable | undefined): EntityField[] {
  if (!table) return [];
  return table.columns.map((col) => ({
    name: col.name,
    columnName: col.name,
    type: { text: col.type },
    dbType: col.type,
    isPrimaryKey: col.isPrimaryKey,
    isNullable: col.nullable,
    isUnique: col.unique,
    isGenerated: col.isGenerated,
    defaultValue: col.defaultValue,
  }));
}

export async function extractRubyEntities(
  modelFiles: Array<{ relPath: string; source: string }>,
  schema: Map<string, SchemaTable>,
  cfg: RubyEntityConfig,
): Promise<{
  entities: EntityNode[];
  entityIdByName: Map<string, string>;
  /** Qualified class name → its association readers (call-graph input only; nothing emitted). */
  associationsByClass: Map<string, RubyAssociationReader[]>;
}> {
  const baseSegLists = cfg.baseClasses.map(segments);
  const models: ModelInfo[] = [];
  const entityIdByName = new Map<string, string>();

  // Pass A — register every model (name -> id, resolved table name) and extract everything Pass B
  // will need as PLAIN DATA, so each file's tree dies with its own iteration. Pass B used to read
  // the retained `classNode`, which held every `app/models/**` tree alive at once — a per-repo WASM
  // peak against a 2GB cap that web-tree-sitter never collects from.
  for (const file of modelFiles) {
    await withParsedRuby(file.source, (root) => {
      for (const classNode of root.descendantsOfType('class') as TsNode[]) {
        const superPath = superclassPath(classNode);
        if (!superPath) continue;
        const superSegs = segments(superPath);
        if (!baseSegLists.some((baseSegs) => matchesBase(superSegs, baseSegs))) continue;
        const name = className(classNode);
        if (!name) continue;

        const associations: AssociationInfo[] = [];
        for (const call of associationCalls(classNode)) {
          const macro = methodName(call);
          const assoc = macro ? toAssociationInfo(call, macro, classNode) : undefined;
          if (assoc) associations.push(assoc);
        }

        models.push({
          name,
          // Read while the tree is alive: `name` is demodulized for the entity, but the call
          // graph keys on the qualified name and the class node is gone by Pass B.
          qualifiedName: qualifiedClassName(classNode) ?? name,
          filePath: file.relPath,
          startLine: classNode.startPosition.row + 1,
          endLine: classNode.endPosition.row + 1,
          tableName: explicitTableName(classNode) ?? pluralize(snakeCase(name)),
          classText: classNode.text as string,
          associations,
        });
        if (!entityIdByName.has(name)) entityIdByName.set(name, entityId(cfg, file.relPath, name));
      }
    });
  }

  // Pass B — emit one EntityNode per registered model. Reads only `models` (plain data) and the
  // now-complete `entityIdByName`, which is what cross-model relation ids need.
  const entities: EntityNode[] = models.map((model) => {
    const id = entityId(cfg, model.filePath, model.name);
    const relations = model.associations.map((assoc) => buildRelation(assoc, entityIdByName));

    const fields = buildFields(schema.get(model.tableName));
    const indexes = buildIndexes(schema.get(model.tableName));

    return {
      id,
      // The class body text covers associations (relations), but columns/indexes
      // come from schema.rb and are absent from it — fold them into the version
      // seed so a column change flips the checksum for the incremental cloud diff.
      versionedId: cfg.idGen.versionedId(
        id,
        `${model.classText || `${model.name}|${model.tableName}`}:${JSON.stringify({ fields, indexes })}`,
      ),
      name: model.name,
      kind: 'entity',
      fileId: fileId(cfg, model.filePath),
      ormType: cfg.orm,
      tableName: model.tableName,
      fields,
      indexes,
      relations,
      location: {
        filePath: model.filePath,
        startLine: model.startLine,
        endLine: model.endLine,
      },
    };
  });

  const associationsByClass = new Map<string, RubyAssociationReader[]>();
  for (const model of models) {
    const readers = associationsByClass.get(model.qualifiedName) ?? [];
    for (const assoc of model.associations) {
      if (!assoc.ownScope) continue;
      readers.push({ name: assoc.assocName, macro: assoc.macro, filePath: model.filePath, line: assoc.line });
    }
    associationsByClass.set(model.qualifiedName, readers);
  }

  return { entities, entityIdByName, associationsByClass };
}
