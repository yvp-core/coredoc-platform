/**
 * Python ORM model classes → EntityNode[]. Generic ORM — the base classes that mark a
 * class as a model and the ORM label come from config (`PythonEntityConfig`), never
 * hard-coded model/table names (repo rule: no framework-identity heuristics). The default
 * base is Django's `models.Model`; a project base model (`app.BaseModel`) or SQLAlchemy's
 * `Base` enter through `cfg.baseClasses`.
 *
 * MODEL-NESS IS TRANSITIVE FOR DJANGO (G3): a class counts when ANY base chain reaches a
 * configured base through the repo's own class graph (`Team(UUIDModel)` → `UUIDModel(models.Model)`),
 * resolved by python-model-bases.ts. A class declaring `Meta.abstract = True` is a BASE, not a
 * table, so it is deliberately not emitted. Non-Django ORMs keep the single-hop rule.
 *
 * Two passes mirror the Ruby entity engine: Pass A registers every model (name → id, table
 * name) so relations can resolve cross-model ids; Pass B emits one EntityNode per model with
 * fields from class-level assignments and relations from ForeignKey/OneToOne/ManyToMany
 * assignments.
 *
 * tableName is BEST-EFFORT but SHAPED LIKE DJANGO'S: an explicit `Meta.db_table` wins, else
 * `<app_label>_<lowercased class name>` with the label resolved statically (see
 * python-django-app.ts). A bare lowercased class name is a value Django never creates, so
 * emitting it made the Django and SQL/Rust entities for one physical table unjoinable (G10).
 * Non-Django ORMs keep the bare name — the prefix rule is Django's, not a universal one.
 */
import type { EntityField, EntityNode, EntityRelation, StableIdGenerator } from '@coredoc/core';
import { type PythonFile, type TsNode, defName } from './python-cst.js';
import { buildDjangoAppIndex, djangoTableName } from './python-django-app.js';
import { buildModelBaseResolver, isAbstractModel } from './python-model-bases.js';

export interface PythonEntityConfig {
  /** Canonical id generator (seeded for this repo) — mints entity/file ids. */
  idGen: StableIdGenerator;
  /** Superclasses that mark a class as a model, e.g. ['models.Model', 'app.BaseModel']. */
  baseClasses: string[];
  /** ORM label written onto every EntityNode (default 'django'). */
  orm?: string;
}

/** ORM field-class name → relation cardinality. */
const RELATION_TYPES: Record<string, EntityRelation['type']> = {
  ForeignKey: 'many-to-one',
  OneToOneField: 'one-to-one',
  ManyToManyField: 'many-to-many',
};

interface ModelInfo {
  name: string;
  relPath: string;
  tableName: string;
  classNode: TsNode;
}

/** Last dotted segment of a call's callee (`models.CharField` → 'CharField'; `CharField` → 'CharField'). */
function calleeName(callNode: TsNode): string {
  const fn = callNode.childForFieldName?.('function');
  if (!fn) return '';
  if (fn.type === 'attribute') return (fn.childForFieldName?.('attribute')?.text ?? fn.text ?? '') as string;
  return (fn.text ?? '') as string;
}

/** Last dotted segment of an attribute/identifier chain (`app.models.User` → 'User'). */
function lastSegment(node: TsNode): string {
  if (node.type === 'attribute') return (node.childForFieldName?.('attribute')?.text ?? node.text ?? '') as string;
  return (node.text ?? '') as string;
}

/**
 * Inner text of a string node, quotes stripped.
 *
 * NOT `python-cst.stringValue`: this one falls back to stripping a prefix+quote off `.text` for a
 * node the CST gave no `string_content` child, and its callers require a string, never undefined.
 */
function stringContent(node: TsNode): string {
  const content = node.descendantsOfType?.('string_content')?.[0];
  return (content?.text ?? (node.text as string).replace(/^[a-zA-Z]*['"]|['"]$/g, '')) as string;
}

/** Whether a `key=True` keyword argument is present on the call. */
function hasTrueKwarg(callNode: TsNode, key: string): boolean {
  const args = callNode.childForFieldName?.('arguments');
  if (!args) return false;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (c?.type !== 'keyword_argument') continue;
    if (c.childForFieldName?.('name')?.text === key) return c.childForFieldName?.('value')?.type === 'true';
  }
  return false;
}

/** First positional argument of a call as a plain string (model name / 'self'), or undefined. */
function firstPositionalArgText(callNode: TsNode): string | undefined {
  const args = callNode.childForFieldName?.('arguments');
  if (!args) return undefined;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c?.isNamed || c.type === 'keyword_argument') continue;
    if (c.type === 'string') return stringContent(c);
    if (c.type === 'identifier') return c.text as string;
    if (c.type === 'attribute') return lastSegment(c);
    // First positional isn't a name-like reference → no usable target.
    return undefined;
  }
  return undefined;
}

/** Direct expression-statement assignments in a block (`name = <rhs>`), not nested-scope ones. */
function bodyAssignments(classNode: TsNode): TsNode[] {
  const body = classNode.childForFieldName?.('body');
  if (!body) return [];
  const out: TsNode[] = [];
  for (let i = 0; i < body.childCount; i++) {
    const stmt = body.child(i);
    if (stmt?.type !== 'expression_statement') continue;
    for (let j = 0; j < stmt.childCount; j++) {
      const inner = stmt.child(j);
      if (inner?.type === 'assignment') {
        out.push(inner);
        break;
      }
    }
  }
  return out;
}

/** Explicit `Meta.db_table = '...'` string, if a nested `class Meta` declares one. */
function metaDbTable(classNode: TsNode): string | undefined {
  const body = classNode.childForFieldName?.('body');
  if (!body) return undefined;
  for (let i = 0; i < body.childCount; i++) {
    const inner = body.child(i);
    if (inner?.type !== 'class_definition' || defName(inner) !== 'Meta') continue;
    for (const assign of bodyAssignments(inner)) {
      const left = assign.childForFieldName?.('left');
      const right = assign.childForFieldName?.('right');
      if (left?.type === 'identifier' && left.text === 'db_table' && right?.type === 'string') {
        return stringContent(right);
      }
    }
  }
  return undefined;
}

export function extractPythonEntities(
  files: PythonFile[],
  cfg: PythonEntityConfig,
): { entities: EntityNode[]; entityIdByName: Map<string, string> } {
  const idGen = cfg.idGen;
  const orm = cfg.orm ?? 'django';
  const bases = cfg.baseClasses.length > 0 ? cfg.baseClasses : ['models.Model'];

  const models: ModelInfo[] = [];
  const entityIdByName = new Map<string, string>();
  // Django's `<app_label>_<model>` default needs the app roots; built once for the whole repo.
  // Other ORMs name tables by their own rules, so the index is only consulted for django.
  const appIndex = orm === 'django' ? buildDjangoAppIndex(files) : new Map<string, string>();
  // Django models inherit their model-ness (G3): `class Team(UUIDModel)` is a model because
  // UUIDModel is. Other ORMs keep the single-hop rule — their base conventions differ and no
  // evidence justifies walking them.
  const resolver = buildModelBaseResolver(files, { baseClasses: bases, transitive: orm === 'django' });

  // Pass A — register every model (name → id, resolved table name).
  for (const file of files) {
    for (const classNode of file.root.descendantsOfType('class_definition') as TsNode[]) {
      const name = defName(classNode);
      if (!name) continue;
      if (!resolver.isModel(file.relPath, classNode, name)) continue;
      // `class Meta: abstract = True` declares a BASE, not a table — Django creates no relation for
      // it, so emitting an entity was pure noise (mixins showing up as tables). Its subclasses are
      // still models; only the abstract class itself is dropped.
      if (orm === 'django' && isAbstractModel(classNode)) continue;
      const explicit = metaDbTable(classNode);
      const tableName =
        orm === 'django'
          ? djangoTableName(classNode, name, file.relPath, appIndex, explicit)
          : (explicit ?? name.toLowerCase());
      models.push({ name, relPath: file.relPath, tableName, classNode });
      if (!entityIdByName.has(name)) entityIdByName.set(name, idGen.entityId(file.relPath, name));
    }
  }

  // Pass B — emit one EntityNode per registered model.
  const entities: EntityNode[] = models.map((model) => {
    const id = idGen.entityId(model.relPath, model.name);
    const fields: EntityField[] = [];
    const relations: EntityRelation[] = [];

    for (const assign of bodyAssignments(model.classNode)) {
      const left = assign.childForFieldName?.('left');
      const right = assign.childForFieldName?.('right');
      // Only `name = SomeField(...)` class-level assignments become fields.
      if (left?.type !== 'identifier' || right?.type !== 'call') continue;
      const fieldName = left.text as string;
      const fieldClass = calleeName(right);

      fields.push({
        name: fieldName,
        columnName: fieldName,
        type: { text: fieldClass },
        dbType: fieldClass,
        isPrimaryKey: fieldName === 'id' || hasTrueKwarg(right, 'primary_key'),
        isNullable: hasTrueKwarg(right, 'null'),
        isUnique: hasTrueKwarg(right, 'unique'),
        isGenerated: false,
      });

      const relType = RELATION_TYPES[fieldClass];
      if (relType) {
        const raw = firstPositionalArgText(right);
        // Django's `'self'` sentinel → the enclosing model itself.
        const target = raw === 'self' ? model.name : raw;
        relations.push({
          name: fieldName,
          type: relType,
          targetEntityName: target ?? '',
          targetEntityId: target ? entityIdByName.get(target) : undefined,
        });
      }
    }

    return {
      id,
      versionedId: idGen.versionedId(id, `${model.classNode.text as string}:${JSON.stringify({ fields })}`),
      name: model.name,
      kind: 'entity',
      fileId: idGen.fileId(model.relPath),
      ormType: orm,
      tableName: model.tableName,
      fields,
      relations,
      location: {
        filePath: model.relPath,
        startLine: model.classNode.startPosition.row + 1,
        endLine: model.classNode.endPosition.row + 1,
      },
    };
  });

  return { entities, entityIdByName };
}
