/**
 * Kotlin persistence call sites → DbOperation[], per spec §Entities and db operations.
 *
 * Emitted ONLY when the profile carries an `entities` block, and the ORM decides the rule:
 * Room reads DAO annotations, Realm reads call shapes. A Retrofit `@Query` is a request
 * PARAMETER and a Room `@Query` is SQL — they share a simple name, so membership of a `@Dao`
 * type is what tells them apart (EC-2). A `@Query` outside a `@Dao` type emits nothing.
 *
 * `parseSqlOp` returning undefined means "no table found": that query emits NO operation and is
 * counted, because an operation on a fabricated table is worse than a missing one.
 */
import type { DbOperation, DbOpResolutionStats, DbOperationType, StableIdGenerator } from '@coredoc/core';
import { parseSqlOp } from '../engine/text-helpers.js';
import {
  MAX_CHAIN_HOPS,
  type TsNode,
  annotationArg,
  annotationName,
  annotationsOf,
  argValue,
  callArgs,
  calleeChain,
  firstChildOfType,
  functionName,
  parameterFacts,
  stringValue,
} from './kotlin-cst.js';
import {
  type KotlinCallSite,
  type KotlinFileFacts,
  type KotlinFileLookup,
  type KotlinTypeDecl,
  indexKotlinFile,
} from './kotlin-declarations.js';
import { directBodyFunctions, foldConstant } from './kotlin-entities.js';
import type { KotlinTypeIndex } from './kotlin-resolve.js';

/** Room DAO annotation → operation. Fixed by the framework; a profile's opMap does not touch it. */
const ROOM_ANNOTATION_OPS: Record<string, DbOperationType> = {
  Insert: 'create',
  Upsert: 'create',
  Update: 'update',
  Delete: 'delete',
};

/** Realm verb → operation. A profile's `dbOperations.opMap` EXTENDS this, never replaces it. */
export const DEFAULT_REALM_OP_MAP: Record<string, DbOperationType> = {
  where: 'query',
  query: 'query',
  findAll: 'read',
  findFirst: 'read',
  copyToRealm: 'create',
  copyToRealmOrUpdate: 'create',
  insert: 'create',
  insertOrUpdate: 'create',
  save: 'create',
  deleteFromRealm: 'delete',
  deleteAllFromRealm: 'delete',
  delete: 'delete',
  executeTransaction: 'transaction',
  beginTransaction: 'transaction',
  commitTransaction: 'transaction',
};

/** The type name that marks a Realm handle binding. */
const REALM_TYPE = 'Realm';

export interface KotlinDbOpsConfig {
  orm: string;
  opMap?: Record<string, string>;
}

export interface KotlinDbOpsResult {
  operations: DbOperation[];
  /**
   * The db-op resolution record (spec BR-4/LIM-4). A site is a Room DAO op method with an emitted
   * performer, or a Realm verb call; out of scope is a Realm receiver that is neither realm-rooted,
   * receiver-less inside Realm scope, nor an in-repo entity — no node here could be its target. A
   * DAO `@Query` whose SQL names no readable table IS a site, in scope and unbound.
   */
  stats: DbOpResolutionStats;
  /** `@Query` bodies `parseSqlOp` found no table in. Counted, never guessed at. */
  unparsedDaoQueries: number;
}

function annotationOn(node: TsNode, name: string): TsNode | undefined {
  return annotationsOf(node).find((a) => annotationName(a) === name);
}

/**
 * The first parameter's entity type, unwrapping `List<T>` / `Array<T>` (a `vararg` already
 * reports its element type). The container's element type lives only in the parameter TEXT:
 * `parameterFacts` reports the bare `List`.
 */
function firstParameterType(fn: TsNode): string | undefined {
  const [param] = parameterFacts(fn);
  if (!param?.typeName) return undefined;
  if (!/^(List|MutableList|Array|Collection|Set)$/.test(param.typeName)) return param.typeName;
  const params = firstChildOfType(fn, 'function_value_parameters');
  const m = /<\s*([A-Za-z_]\w*)/.exec((params?.text as string) ?? '');
  return m ? m[1] : undefined;
}

/**
 * Entity id → the `name` its EntityNode carries.
 *
 * `entityIdByName` is keyed by both the class name and the table name of every entity, and the
 * class name — which is the node's `name` — is registered FIRST, so the first key seen for an id
 * is that spelling. An operation must speak it: `find-entity-usage` keys an entity's consumers on
 * the emitted `entityName`, so a Room `@Query` saying `things` while an `@Insert` on the same
 * entity says `ThingEntity` makes that tool answer with a confident SUBSET of the real consumers.
 */
function canonicalNameById(entityIdByName: ReadonlyMap<string, string | undefined>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, id] of entityIdByName) if (id && !out.has(id)) out.set(id, name);
  return out;
}

/** The entity's own `name` when the operation resolves to one, else the string as matched. */
function canonicalEntityName(
  name: string,
  entityIdByName: ReadonlyMap<string, string | undefined>,
  canonical: ReadonlyMap<string, string>,
): string {
  const id = entityIdByName.get(name);
  return (id && canonical.get(id)) ?? name;
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

function roomOps(
  facts: KotlinFileFacts,
  dao: KotlinTypeDecl,
  index: KotlinTypeIndex,
  entityIdByName: ReadonlyMap<string, string | undefined>,
  canonical: ReadonlyMap<string, string>,
  idGen: StableIdGenerator,
  out: DbOperation[],
  stats: DbOpResolutionStats,
): number {
  let unparsed = 0;
  for (const fn of directBodyFunctions(dao)) {
    const name = functionName(fn);
    if (!name) continue;
    const performerId = dao.methodsByName.get(name);
    if (!performerId) continue; // no emitted performer → no operation, never a synthetic one

    let operation: DbOperationType | undefined;
    let entityName: string | undefined;
    let marker: TsNode | undefined;
    const query = annotationOn(fn, 'Query');
    if (query) {
      stats.dbOpSites++;
      marker = query;
      const raw = stringValue(annotationArg(query, 0));
      if (raw === undefined) continue;
      const sql = raw.replace(
        /\{([A-Za-z_][\w.]*)\}/g,
        (all, constant) => foldConstant(constant, dao, facts, index) ?? all,
      );
      const parsed = parseSqlOp(sql);
      if (!parsed) {
        unparsed++;
        continue;
      }
      operation = parsed.op;
      entityName = parsed.entity;
    } else {
      for (const [annotation, op] of Object.entries(ROOM_ANNOTATION_OPS)) {
        const hit = annotationOn(fn, annotation);
        if (!hit) continue;
        marker = hit;
        operation = op;
        break;
      }
      if (operation) stats.dbOpSites++;
    }
    if (!operation) continue; // e.g. a `@Transaction`-only function: no operation of its own

    if (!entityName) {
      const fromParam = firstParameterType(fn);
      const declared = fromParam && entityIdByName.has(fromParam) ? fromParam : undefined;
      const annotated = marker ? (annotationArg(marker, 'entity')?.text as string | undefined) : undefined;
      entityName = declared ?? annotated?.replace(/\s*::\s*class.*$/, '') ?? 'unknown';
    }
    entityName = canonicalEntityName(entityName, entityIdByName, canonical);

    const location = { filePath: facts.relPath, startLine: fn.startPosition.row + 1, endLine: fn.endPosition.row + 1 };
    const id = idGen.dbOperationId(
      performerId,
      entityName,
      operation,
      `${facts.relPath}:${location.startLine}:${name}`,
    );
    out.push({
      id,
      versionedId: idGen.versionedId(id, fn.text as string),
      performerId,
      entityId: entityIdByName.get(entityName),
      entityName,
      operation,
      location,
    });
  }
  return unparsed;
}

// ---------------------------------------------------------------------------
// Realm
// ---------------------------------------------------------------------------

/** The declared type of a single-name binding: a local of the enclosing function, or a property. */
function bindingTypeName(
  facts: KotlinFileFacts,
  lookup: KotlinFileLookup,
  index: KotlinTypeIndex,
  call: KotlinCallSite,
  name: string,
): string | undefined {
  const local = lookup.localsByFunction.get(call.enclosingFunctionId)?.get(name);
  if (local?.typeName) return local.typeName;
  // A PARAMETER of the enclosing function: `fun store(thing: Thing) { thing.save() }`.
  const fn = lookup.functionsById.get(call.enclosingFunctionId);
  const param = fn?.parameters.find((p) => p.name === name);
  if (param?.type?.text) return param.type.text;
  const owner = call.enclosingClassFqcn ? facts.declarations.get(call.enclosingClassFqcn) : undefined;
  if (!owner) return undefined;
  for (const decl of index.supertypeChain(owner)) {
    const hit = decl.propertyTypes.get(name) ?? decl.diProperties.get(name)?.typeName;
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The ROOT identifier of a receiver chain, descending through intermediate calls:
 * `realm.where(X).findFirst()` roots in `realm`, which is the binding the Realm rule is about.
 */
function receiverRootName(node: TsNode, depth = 0): string | undefined {
  if (depth > MAX_CHAIN_HOPS) return undefined;
  const chain = calleeChain(node);
  if (!chain) return undefined;
  if (chain.root.type === 'simple_identifier') {
    return chain.members.length > 0 ? (chain.root.text as string) : undefined;
  }
  if (chain.root.type === 'call_expression') return receiverRootName(chain.root, depth + 1);
  return undefined;
}

/**
 * The TYPE a constructor-call receiver names: `Thing().queryFirst { … }` → `Thing`.
 *
 * Only a bare `T(…)` counts. `a.b().op()` and `f().op()` are NOT constructor receivers — their
 * result type is not written anywhere, so they stay unresolved rather than being guessed at.
 */
function constructorReceiverType(node: TsNode): string | undefined {
  const chain = calleeChain(node);
  if (!chain || chain.members.length === 0 || chain.root.type !== 'call_expression') return undefined;
  const inner = calleeChain(chain.root);
  if (!inner || inner.members.length > 0 || inner.root.type !== 'simple_identifier') return undefined;
  const name = inner.root.text as string;
  return /^[A-Z]/.test(name) ? name : undefined;
}

/** Whether a call is written with no receiver at all (`f()`), as opposed to `a.f()` / `g().f()`. */
function isReceiverLess(node: TsNode): boolean {
  const chain = calleeChain(node);
  return !!chain && chain.members.length === 0 && chain.root.type === 'simple_identifier';
}

function classArgIn(node: TsNode): string | undefined {
  for (const arg of callArgs(node)) {
    const m = /^([A-Za-z_]\w*)\s*::\s*class/.exec((argValue(arg)?.text as string) ?? '');
    if (m) return m[1];
  }
  return undefined;
}

/**
 * `X::class.java` / `X::class` naming the entity, at this call or at a receiver call of the SAME
 * expression (`realm.where(X::class.java).findFirst()` — the chain names X once, for both ops).
 */
function classArgName(call: KotlinCallSite): string | undefined {
  let node: TsNode | undefined = call.node;
  for (let hop = 0; node && hop < MAX_CHAIN_HOPS; hop++) {
    const hit = classArgIn(node);
    if (hit) return hit;
    const chain = calleeChain(node);
    node = chain?.root.type === 'call_expression' ? chain.root : undefined;
  }
  return undefined;
}

function realmOps(
  facts: KotlinFileFacts,
  index: KotlinTypeIndex,
  opMap: Record<string, DbOperationType>,
  entityIdByName: ReadonlyMap<string, string | undefined>,
  canonical: ReadonlyMap<string, string>,
  bases: ReadonlySet<string>,
  idGen: StableIdGenerator,
  out: DbOperation[],
  stats: DbOpResolutionStats,
): void {
  const lookup = indexKotlinFile(facts);
  // Three ancestry walks per owner, so it is computed at most once per owner and only for the
  // receiver-less sites that actually consume it.
  const realmScopeByOwner = new Map<string, boolean>();
  const inRealmScope = (owner: KotlinTypeDecl): boolean => {
    const memo = realmScopeByOwner.get(owner.fqcn);
    if (memo !== undefined) return memo;
    const scoped =
      index.supertypeNames(owner).some((n) => bases.has(n)) ||
      index.supertypeChain(owner).some((d) => [...d.propertyTypes.values()].includes(REALM_TYPE));
    realmScopeByOwner.set(owner.fqcn, scoped);
    return scoped;
  };

  for (const call of facts.calls) {
    // `hasOwn`, not a plain lookup: `toString` and friends are inherited by every object literal,
    // and an `Object.prototype` member masquerading as a verb emits a fabricated operation.
    const operation = Object.hasOwn(opMap, call.name) ? opMap[call.name] : undefined;
    if (!operation) continue;

    const rootName = receiverRootName(call.node);
    const rootType = rootName ? bindingTypeName(facts, lookup, index, call, rootName) : undefined;
    const owner = call.enclosingClassFqcn ? facts.declarations.get(call.enclosingClassFqcn) : undefined;

    // (a) a receiver chain rooted in a Realm-typed binding.
    const realmRooted = rootType === REALM_TYPE;
    // (b) a receiver-less call inside a Realm class, or one holding a Realm-typed property.
    const receiverLess = isReceiverLess(call.node) && !!owner && inRealmScope(owner);
    // (c) an extension function on an emitted entity: the receiver or the type argument is one.
    const ctorType = constructorReceiverType(call.node);
    const receiverType = rootType ?? ctorType;
    const receiverEntity = receiverType && entityIdByName.has(receiverType) ? receiverType : undefined;
    const typeArgEntity = call.typeArgNames.find((t) => entityIdByName.has(t));
    const onEntity = !!receiverEntity || !!typeArgEntity;

    stats.dbOpSites++;
    if (!realmRooted && !receiverLess && !onEntity) {
      stats.outOfScopeDbOps++;
      continue;
    }

    const firstArgType = (() => {
      const first = call.args[0];
      const text = (first ? (argValue(first)?.text as string) : '') ?? '';
      return /^[A-Za-z_]\w*$/.test(text) ? bindingTypeName(facts, lookup, index, call, text) : undefined;
    })();
    const matched =
      classArgName(call) ??
      typeArgEntity ??
      call.typeArgNames[0] ??
      receiverEntity ??
      (firstArgType && entityIdByName.has(firstArgType) ? firstArgType : undefined) ??
      'unknown';
    const entityName = canonicalEntityName(matched, entityIdByName, canonical);

    const id = idGen.dbOperationId(
      call.enclosingFunctionId,
      entityName,
      operation,
      `${facts.relPath}:${call.location.startLine}:${call.name}`,
    );
    out.push({
      id,
      versionedId: idGen.versionedId(id, (call.node.text as string).slice(0, 200)),
      performerId: call.enclosingFunctionId,
      entityId: entityIdByName.get(entityName),
      entityName,
      operation,
      location: call.location,
    });
  }
}

export function extractKotlinDbOps(
  allFacts: readonly KotlinFileFacts[],
  index: KotlinTypeIndex,
  entityIdByName: ReadonlyMap<string, string | undefined>,
  idGen: StableIdGenerator,
  cfg: KotlinDbOpsConfig & { baseClasses?: string[] },
): KotlinDbOpsResult {
  const operations: DbOperation[] = [];
  let unparsedDaoQueries = 0;
  const canonical = canonicalNameById(entityIdByName);
  const stats: DbOpResolutionStats = { dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 };
  // Read back from the EMITTED operations, never a loop counter: one site emits at most one op.
  const withBound = (): DbOpResolutionStats => ({
    ...stats,
    boundDbOps: operations.filter((o) => o.entityId).length,
  });

  if (cfg.orm === 'realm') {
    const opMap: Record<string, DbOperationType> = { ...DEFAULT_REALM_OP_MAP };
    for (const [verb, op] of Object.entries(cfg.opMap ?? {})) opMap[verb] = op as DbOperationType;
    const bases = new Set(cfg.baseClasses ?? ['RealmObject', 'RealmModel']);
    for (const facts of allFacts)
      realmOps(facts, index, opMap, entityIdByName, canonical, bases, idGen, operations, stats);
    return { operations, unparsedDaoQueries, stats: withBound() };
  }

  for (const facts of allFacts) {
    for (const decl of facts.declarations.values()) {
      if (!annotationOn(decl.node, 'Dao')) continue;
      unparsedDaoQueries += roomOps(facts, decl, index, entityIdByName, canonical, idGen, operations, stats);
    }
  }
  return { operations, unparsedDaoQueries, stats: withBound() };
}
