/**
 * decorator-conventions.ts — the HYPOTHESIS PROOF.
 *
 * Reproduces a NestJS backend's HTTP entrypoints + MikroORM entities by reading
 * the FULL-TEXT decorator strings on tree-sitter `StructuralClass` /
 * `StructuralMethod` / `StructuralProperty` — NO ts-morph. This is the same set
 * of conventions encoded in the target repo profile,
 * but the substrate is web-tree-sitter structural output, not ts-morph nodes.
 *
 * The decorator strings look like:
 *   "Controller('v2/management/core/...')"
 *   "Get('/managers')"
 *   "EventPattern(getTopicInNamespace(...))"
 *   "Entity({ tableName: 'x' })"
 *   "Property({ fieldName: 'created_at', nullable: true })"
 *   "ManyToOne(() => Companies)"
 *
 * We parse them with small regexes — exactly the approach engine.ts already uses
 * over `DecoratorInfo.expression` (e.g. extractDecoratorOption / readTarget).
 */
import type { StableIdGenerator } from '@coredoc/core';
import type {
  DbOperation,
  EntityField,
  EntityNode,
  EntityRelation,
  Entrypoint,
  ExternalCallEdge,
  HttpMethod,
} from '@coredoc/core/types';
import type { StructuralClass, StructuralFile, StructuralMethod, StructuralProperty } from '../src/facts/index.js';

// ── decorator-string parsing helpers ────────────────────────────────────────

/** Decorator name = identifier before the first `(`. `Entity` from `Entity({...})`. */
function decoName(dec: string): string {
  const m = /^([A-Za-z0-9_$]+)/.exec(dec.trim());
  return m ? m[1] : '';
}
function findDeco(decorators: string[], name: string): string | undefined {
  return decorators.find((d) => decoName(d) === name);
}
/** First string-literal argument: `Controller('base')` → `base`. */
function firstStringArg(dec: string): string | undefined {
  // arg list is between the FIRST '(' and the matching trailing ')'
  const open = dec.indexOf('(');
  if (open < 0) return undefined;
  const inner = dec.slice(open + 1, dec.lastIndexOf(')'));
  const m = /^\s*['"`]([^'"`]*)['"`]/.exec(inner);
  return m ? m[1] : undefined;
}
/** Object-option string value: extractDecoratorOption equivalent. */
function optionString(dec: string, key: string): string | undefined {
  const re = new RegExp(`${key}:\\s*['"\`]([^'"\`]+)['"\`]`);
  const m = re.exec(dec);
  return m ? m[1] : undefined;
}
function hasFlag(dec: string, pattern: string): boolean {
  return new RegExp(pattern).test(dec);
}
/** `ManyToOne(() => Companies)` → `Companies`. */
function arrowTarget(dec: string): string | undefined {
  const m = /=>\s*([A-Za-z0-9_$]+)/.exec(dec);
  return m ? m[1] : undefined;
}
function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}
function singularize(name: string): string {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}
function normalizeSegment(seg: string): string {
  return seg.replace(/^\/+/, '').replace(/\/+$/, '');
}
function joinPaths(base: string, method: string): string {
  const parts = [base, method].filter((p) => p.length > 0);
  return '/' + parts.join('/');
}
function colonToBrace(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
function extractParams(p: string): string[] {
  const params: string[] = [];
  let m: RegExpExecArray | null;
  const re = /:([A-Za-z0-9_]+)/g;
  while ((m = re.exec(p)) !== null) params.push(m[1]);
  return params;
}

// ── profile constants (mirror the target repo profile) ───────────────────────

const HTTP_METHODS: Record<string, HttpMethod> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Options: 'OPTIONS',
  Head: 'HEAD',
  All: 'GET',
};
const QUEUE_DECORATORS: Record<string, string> = {
  EventPattern: 'event',
  MessagePattern: 'request-response',
};
const FIELD_DECORATORS = new Set(['Property', 'PrimaryKey', 'Enum']);
const REL_DECORATORS: Record<string, EntityRelation['type']> = {
  OneToOne: 'one-to-one',
  OneToMany: 'one-to-many',
  ManyToOne: 'many-to-one',
  ManyToMany: 'many-to-many',
};

export interface ConventionResult {
  entrypoints: Entrypoint[];
  entities: EntityNode[];
}

/**
 * Run the NestJS profile conventions over the tree-sitter structural substrate.
 * Returns entrypoints (http + queue) and entities (with fields + relations).
 */
export function extractConventions(files: StructuralFile[], idGen: StableIdGenerator): ConventionResult {
  const entrypoints: Entrypoint[] = [];
  const entities: EntityNode[] = [];
  const entityNames = new Set<string>();

  // First pass: collect entity names so relation targetEntityId can resolve.
  for (const f of files) {
    for (const c of f.classes) {
      if (findDeco(c.decorators, 'Entity')) entityNames.add(c.name);
    }
  }
  const entityIdByName = new Map<string, string>();
  for (const f of files) {
    for (const c of f.classes) {
      if (findDeco(c.decorators, 'Entity')) entityIdByName.set(c.name, idGen.entityId(f.path, c.name));
    }
  }

  for (const f of files) {
    for (const c of f.classes) {
      extractHttp(c, f.path, idGen, entrypoints);
      extractQueue(c, f.path, idGen, entrypoints);
      extractEntity(c, f.path, idGen, entityIdByName, entities);
    }
  }
  return { entrypoints, entities };
}

function extractHttp(c: StructuralClass, filePath: string, idGen: StableIdGenerator, out: Entrypoint[]): void {
  const ctrl = findDeco(c.decorators, 'Controller');
  if (!ctrl) return;
  const basePath = normalizeSegment(firstStringArg(ctrl) ?? '');

  for (const m of c.methods) {
    const httpDec = m.decorators.find((d) => HTTP_METHODS[decoName(d)] !== undefined);
    if (!httpDec) continue;
    const httpMethod = HTTP_METHODS[decoName(httpDec)];
    const methodPath = normalizeSegment(firstStringArg(httpDec) ?? '');
    const fullPathRaw = joinPaths(basePath, methodPath);
    const pathRaw = methodPath === '' ? '/' : `/${methodPath}`;
    const fullPath = colonToBrace(fullPathRaw);
    const path = colonToBrace(pathRaw);
    const pathParams = extractParams(fullPathRaw);
    const handlerId = idGen.methodId(filePath, c.name, m.name);
    const id = idGen.httpEntrypointId(httpMethod, fullPath, filePath);
    out.push({
      id,
      versionedId: idGen.versionedId(id, `${c.name}.${m.name}:${m.startLine}`),
      type: 'http',
      handlerId,
      location: { filePath, startLine: m.startLine, endLine: m.endLine },
      details: {
        type: 'http',
        method: httpMethod,
        path,
        fullPath,
        ...(pathParams.length ? { pathParams } : {}),
      },
    });
  }
}

function extractQueue(c: StructuralClass, filePath: string, idGen: StableIdGenerator, out: Entrypoint[]): void {
  for (const m of c.methods) {
    const qDec = m.decorators.find((d) => QUEUE_DECORATORS[decoName(d)] !== undefined);
    if (!qDec) continue;
    const pattern = QUEUE_DECORATORS[decoName(qDec)];
    // topic: string-literal arg, else raw inner expression text (matches ts-morph fallback).
    const open = qDec.indexOf('(');
    const innerRaw = open >= 0 ? qDec.slice(open + 1, qDec.lastIndexOf(')')).trim() : '';
    const topic = firstStringArg(qDec) ?? innerRaw;
    const handlerId = idGen.methodId(filePath, c.name, m.name);
    const id = idGen.queueEntrypointId('kafka', topic, filePath);
    out.push({
      id,
      versionedId: idGen.versionedId(id, `${c.name}.${m.name}:${m.startLine}`),
      type: 'queue',
      handlerId,
      location: { filePath, startLine: m.startLine, endLine: m.endLine },
      details: { type: 'queue', system: 'kafka', topic, pattern },
    });
  }
}

function extractEntity(
  c: StructuralClass,
  filePath: string,
  idGen: StableIdGenerator,
  entityIdByName: Map<string, string>,
  out: EntityNode[],
): void {
  const entityDec = findDeco(c.decorators, 'Entity');
  if (!entityDec) return;
  const tableName = optionString(entityDec, 'tableName') ?? snakeCase(c.name);

  const fields: EntityField[] = [];
  const relations: EntityRelation[] = [];

  for (const p of c.properties) {
    const relDec = p.decorators.find((d) => REL_DECORATORS[decoName(d)] !== undefined);
    if (relDec) {
      relations.push(buildRelation(p, relDec));
      continue;
    }
    const fieldDec = p.decorators.find((d) => FIELD_DECORATORS.has(decoName(d)));
    if (fieldDec) {
      fields.push(buildField(p, fieldDec));
    }
  }

  const entityId = idGen.entityId(filePath, c.name);
  out.push({
    id: entityId,
    versionedId: idGen.versionedId(entityId, `${c.name}:${c.startLine}-${c.endLine}`),
    name: c.name,
    kind: 'entity',
    fileId: idGen.fileId(filePath),
    ormType: 'mikro-orm',
    tableName,
    fields,
    relations: relations.map((r) => ({ ...r, targetEntityId: entityIdByName.get(r.targetEntityName) })),
    location: { filePath, startLine: c.startLine, endLine: c.endLine },
  });
}

function buildField(p: StructuralProperty, fieldDec: string): EntityField {
  const isPk = decoName(fieldDec) === 'PrimaryKey' || p.decorators.some((d) => decoName(d) === 'PrimaryKey');
  const columnName = optionString(fieldDec, 'fieldName') ?? snakeCase(p.name);
  const nullable = hasFlag(fieldDec, 'nullable:\\s*true');
  const unique = hasFlag(fieldDec, 'unique:\\s*true');
  const generated = isPk || hasFlag(fieldDec, 'defaultRaw|autoincrement|onCreate|onUpdate');
  const typeText = p.type ?? 'unknown';
  const defaultMatch = /\bdefault:\s*([^,}]+)/.exec(fieldDec);
  return {
    name: p.name,
    columnName,
    type: { text: typeText },
    isPrimaryKey: isPk,
    isNullable: nullable,
    isUnique: unique,
    isGenerated: generated,
    defaultValue: defaultMatch ? defaultMatch[1].trim() : undefined,
  };
}

function buildRelation(p: StructuralProperty, relDec: string): EntityRelation {
  const relType = REL_DECORATORS[decoName(relDec)];
  const target = arrowTarget(relDec) ?? singularize(p.name);
  const joinColumn = optionString(relDec, 'fieldName') ?? optionString(relDec, 'joinColumn');
  return { name: p.name, type: relType, targetEntityName: target, joinColumn };
}

// dbOperations are intentionally NOT reproduced here — see SCIP-PROBE.md "gaps".
export type { DbOperation, ExternalCallEdge, StructuralMethod };
