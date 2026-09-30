/**
 * Kotlin persisted models → EntityNode[], per spec §Entities and db operations.
 *
 * Emitted ONLY when the profile carries an `entities` block (the Swift rule): a repository with
 * no ORM must not grow a half-guessed schema. Room entities are annotation-marked, Realm
 * entities are base-class-marked, and the two rules are selected by `entities.orm` — running
 * both would let a Room `@Entity` appear under a Realm profile.
 *
 * A table name is read, folded ONE hop through a companion `const val`, or falls back to the
 * class simple name. It is never invented from a comment or a file name.
 */
import type { EntityField, EntityNode, EntityRelation, StableIdGenerator } from '@coredoc/core';
import {
  MAX_DESCENDANT_DEPTH,
  NULLABLE_TYPE,
  type PropertyFacts,
  type TsNode,
  VARIABLE_DECL,
  annotationArg,
  annotationName,
  annotationsOf,
  constructorProperties,
  firstChildOfType,
  namedChildren,
  propertyFacts,
  stringValue,
} from './kotlin-cst.js';
import type { KotlinFileFacts, KotlinTypeDecl } from './kotlin-declarations.js';
import type { KotlinTypeIndex } from './kotlin-resolve.js';

/** Room: the annotation simple names that mark an entity. */
export const DEFAULT_ROOM_ENTITY_ANNOTATIONS = ['Entity'];
/** Realm: the base classes that mark a persisted class. */
export const DEFAULT_REALM_BASE_CLASSES = ['RealmObject', 'RealmModel'];
/** Realm collection types whose element type is a to-many target. */
const REALM_LIST_TYPES = new Set(['RealmList', 'RealmResults', 'List']);

export interface KotlinEntitiesConfig {
  orm: string;
  baseClasses?: string[];
  annotations?: string[];
}

export interface KotlinEntitiesResult {
  entities: EntityNode[];
  /**
   * Simple class name (and table name) → entity id, for db-op attribution.
   *
   * A key two DISTINCT entities claim — the same class simple name in two modules, or one
   * entity's `tableName` equal to another's class name — maps to `undefined`: the key is still
   * a known entity name, but no id may be joined on it. `has()` stays true so the operation
   * keeps its `entityName`; `get()` abstains rather than pointing at the first module seen.
   */
  entityIdByName: Map<string, string | undefined>;
  /** FQCN → the emitted entity's table name, for receiver-typed db-op attribution. */
  entityNameByFqcn: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Shared CST reads
// ---------------------------------------------------------------------------

export function descendantsOfType(node: TsNode, type: string, depth = 0, out: TsNode[] = []): TsNode[] {
  if (depth > MAX_DESCENDANT_DEPTH) return out;
  if (node.type === type) out.push(node);
  for (const child of namedChildren(node)) descendantsOfType(child, type, depth + 1, out);
  return out;
}

/** The body property declarations DIRECTLY on a class (not a nested type's, not a local). */
export function directBodyProperties(decl: KotlinTypeDecl): TsNode[] {
  const body = firstChildOfType(decl.node, 'class_body');
  if (!body) return [];
  return namedChildren(body).filter((c) => c.type === 'property_declaration');
}

/** The member functions DIRECTLY on a class body. */
export function directBodyFunctions(decl: KotlinTypeDecl): TsNode[] {
  const body = firstChildOfType(decl.node, 'class_body');
  if (!body) return [];
  return namedChildren(body).filter((c) => c.type === 'function_declaration');
}

function annotationOn(node: TsNode, name: string): TsNode | undefined {
  return annotationsOf(node).find((a) => annotationName(a) === name);
}

/**
 * One-hop constant fold of `X.NAME` / `NAME` → a `const val` string in that class's (or the
 * enclosing class's) companion. Anything else folds to undefined — a half-folded table name is
 * a wrong join key, not a near miss.
 */
export function foldConstant(
  name: string,
  decl: KotlinTypeDecl,
  facts: KotlinFileFacts,
  index: KotlinTypeIndex,
): string | undefined {
  const dot = name.lastIndexOf('.');
  const owner =
    dot < 0
      ? decl
      : (() => {
          const hit = index.resolve(name.slice(0, dot), facts);
          return hit.status === 'resolved' ? hit.decl : undefined;
        })();
  const simple = dot < 0 ? name : name.slice(dot + 1);
  if (!owner) return undefined;
  for (const prop of descendantsOfType(owner.node, 'property_declaration')) {
    const facts2 = propertyFacts(prop);
    if (facts2?.name !== simple) continue;
    const value = stringValue(facts2.initializer);
    if (value !== undefined) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

interface FieldSource extends PropertyFacts {
  node: TsNode;
}

function fieldSources(decl: KotlinTypeDecl): FieldSource[] {
  const out: FieldSource[] = [];
  const ctor = firstChildOfType(decl.node, 'primary_constructor');
  if (ctor) {
    const params = namedChildren(ctor).filter((c) => c.type === 'class_parameter');
    const props = constructorProperties(decl.node);
    for (const prop of props) {
      const node = params.find((p) => firstChildOfType(p, 'simple_identifier')?.text === prop.name);
      if (node) out.push({ ...prop, node });
    }
  }
  for (const node of directBodyProperties(decl)) {
    const prop = propertyFacts(node);
    if (prop) out.push({ ...prop, node });
  }
  return out;
}

/**
 * `var name: String?` → nullable. `typeName()` already drops the `?` from the type text, so the
 * flag is the only place the nullability survives: the type node itself is what carries it, on
 * the `class_parameter` directly or on the property's `variable_declaration`.
 */
function isNullableField(node: TsNode): boolean {
  const holder = firstChildOfType(node, VARIABLE_DECL) ?? node;
  return namedChildren(holder).some((c) => c.type === NULLABLE_TYPE);
}

/** `@PrimaryKey(autoGenerate = true)` — Room's only per-field generation marker. */
function isGeneratedField(node: TsNode): boolean {
  const key = annotationOn(node, 'PrimaryKey');
  return !!key && (annotationArg(key, 'autoGenerate')?.text as string | undefined)?.trim() === 'true';
}

/**
 * The COLUMNS a class-level `@Entity(indices = [Index(value = ["email"], unique = true)])` makes
 * unique. Room has no per-field unique annotation (`@ColumnInfo` carries name/type affinity and
 * nothing about uniqueness), so the class-level index table is the only source.
 *
 * A multi-column unique index constrains the TUPLE, not either column, so it marks no field:
 * a wrong `isUnique` is a confident wrong answer about the schema.
 */
function uniqueColumnsOf(entityAnnotation: TsNode | undefined): Set<string> {
  const out = new Set<string>();
  const arg = entityAnnotation ? annotationArg(entityAnnotation, 'indices') : undefined;
  if (!arg) return out;
  for (const m of (arg.text as string).matchAll(/Index\s*\(([^)]*)\)/g)) {
    const body = m[1];
    if (!/\bunique\s*=\s*true\b/.test(body)) continue;
    const columns = [...body.matchAll(/"([^"]*)"/g)].map((q) => q[1]);
    if (columns.length === 1) out.add(columns[0]);
  }
  return out;
}

function buildFields(
  decl: KotlinTypeDecl,
  primaryKeys: ReadonlySet<string>,
  uniqueColumns: ReadonlySet<string>,
): EntityField[] {
  const out: EntityField[] = [];
  for (const source of fieldSources(decl)) {
    if (annotationOn(source.node, 'Ignore')) continue;
    const columnInfo = annotationOn(source.node, 'ColumnInfo');
    const columnName = (columnInfo && stringValue(annotationArg(columnInfo, 'name'))) ?? source.name;
    out.push({
      name: source.name,
      columnName,
      type: { text: source.typeName ?? 'unknown' },
      isPrimaryKey: !!annotationOn(source.node, 'PrimaryKey') || primaryKeys.has(source.name),
      isNullable: isNullableField(source.node),
      isUnique: uniqueColumns.has(columnName),
      isGenerated: isGeneratedField(source.node),
    });
  }
  return out;
}

/** `[ForeignKey(entity = Thing::class, childColumns = ["thing_id"])]` → one relation each. */
function roomRelations(
  entityAnnotation: TsNode | undefined,
  entityIdByName: Map<string, string | undefined>,
): EntityRelation[] {
  const arg = entityAnnotation ? annotationArg(entityAnnotation, 'foreignKeys') : undefined;
  if (!arg) return [];
  const out: EntityRelation[] = [];
  const text = arg.text as string;
  const re = /entity\s*=\s*([A-Za-z_]\w*)\s*::\s*class([\s\S]*?)(?=entity\s*=|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const target = m[1];
    const child = /childColumns\s*=\s*\[\s*"([^"]+)"/.exec(m[2]);
    out.push({
      name: child ? child[1] : target,
      type: 'many-to-one',
      targetEntityName: target,
      targetEntityId: entityIdByName.get(target),
      joinColumn: child ? child[1] : undefined,
    });
  }
  return out;
}

function realmRelations(decl: KotlinTypeDecl, entityIdByName: Map<string, string | undefined>): EntityRelation[] {
  const out: EntityRelation[] = [];
  for (const source of fieldSources(decl)) {
    const declared = source.typeName;
    if (!declared) continue;
    if (REALM_LIST_TYPES.has(declared)) {
      const element = elementTypeName(source.node);
      if (element && entityIdByName.has(element)) {
        out.push({
          name: source.name,
          type: 'one-to-many',
          targetEntityName: element,
          targetEntityId: entityIdByName.get(element),
        });
      }
      continue;
    }
    if (entityIdByName.has(declared)) {
      out.push({
        name: source.name,
        type: 'many-to-one',
        targetEntityName: declared,
        targetEntityId: entityIdByName.get(declared),
      });
    }
  }
  return out;
}

/** The single type argument of a declared collection type (`RealmList<Thing>` → `Thing`). */
function elementTypeName(node: TsNode): string | undefined {
  for (const args of descendantsOfType(node, 'type_arguments')) {
    for (const projection of namedChildren(args)) {
      const id = descendantsOfType(projection, 'type_identifier')[0];
      if (id) return id.text as string;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface Candidate {
  decl: KotlinTypeDecl;
  facts: KotlinFileFacts;
  tableName: string;
  annotation?: TsNode;
  primaryKeys: Set<string>;
}

function stringList(node: TsNode | undefined): string[] {
  if (!node) return [];
  return [...(node.text as string).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function extractKotlinEntities(
  allFacts: readonly KotlinFileFacts[],
  index: KotlinTypeIndex,
  idGen: StableIdGenerator,
  cfg: KotlinEntitiesConfig,
): KotlinEntitiesResult {
  const isRealm = cfg.orm === 'realm';
  const annotations = new Set(cfg.annotations ?? DEFAULT_ROOM_ENTITY_ANNOTATIONS);
  const bases = new Set(cfg.baseClasses ?? DEFAULT_REALM_BASE_CLASSES);

  const candidates: Candidate[] = [];
  for (const facts of allFacts) {
    for (const decl of facts.declarations.values()) {
      if (decl.kind !== 'class') continue;
      if (isRealm) {
        const reachesBase =
          index.supertypeNames(decl).some((n) => bases.has(n)) || decl.supertypes.some((s) => bases.has(s.name));
        if (!reachesBase) continue;
        candidates.push({ decl, facts, tableName: decl.simpleName, primaryKeys: new Set() });
        continue;
      }
      const marker = [...annotations].map((name) => annotationOn(decl.node, name)).find((a) => a);
      if (!marker) continue;
      const written = stringValue(annotationArg(marker, 'tableName'));
      const raw = written ?? constantArgName(annotationArg(marker, 'tableName'));
      const tableName = written ?? (raw ? foldConstant(raw, decl, facts, index) : undefined) ?? decl.simpleName;
      candidates.push({
        decl,
        facts,
        tableName,
        annotation: marker,
        primaryKeys: new Set(stringList(annotationArg(marker, 'primaryKeys'))),
      });
    }
  }

  const entityIdByName = new Map<string, string | undefined>();
  const entityNameByFqcn = new Map<string, string>();
  const collided = new Set<string>();
  const claim = (key: string, id: string) => {
    if (!entityIdByName.has(key)) entityIdByName.set(key, id);
    else if (entityIdByName.get(key) !== id) collided.add(key);
  };
  for (const candidate of candidates) {
    const id = idGen.entityId(candidate.decl.filePath, candidate.tableName);
    claim(candidate.decl.simpleName, id);
    claim(candidate.tableName, id);
    entityNameByFqcn.set(candidate.decl.fqcn, candidate.tableName);
  }
  // A contested name joins on nothing: a wrong entityId is a confident wrong answer.
  for (const key of collided) entityIdByName.set(key, undefined);

  const entities: EntityNode[] = candidates.map((candidate) => {
    const id = idGen.entityId(candidate.decl.filePath, candidate.tableName);
    return {
      id,
      versionedId: idGen.versionedId(id, candidate.decl.node.text as string),
      name: candidate.decl.simpleName,
      kind: 'entity',
      fileId: candidate.facts.fileId,
      ormType: cfg.orm,
      tableName: candidate.tableName,
      fields: buildFields(candidate.decl, candidate.primaryKeys, uniqueColumnsOf(candidate.annotation)),
      relations: isRealm
        ? realmRelations(candidate.decl, entityIdByName)
        : roomRelations(candidate.annotation, entityIdByName),
      location: candidate.decl.location,
    };
  });

  return { entities, entityIdByName, entityNameByFqcn };
}

/** The dotted name of a non-literal annotation argument (`tableName = Thing.TABLE_NAME`). */
function constantArgName(node: TsNode | undefined): string | undefined {
  if (!node) return undefined;
  const text = (node.text as string).trim();
  return /^[A-Za-z_][\w.]*$/.test(text) ? text : undefined;
}
