/**
 * Swift ORM query call sites → DbOperation[]. Generic — the verb→operation map is
 * config-overridable, never hard-coded to a client's names. Performer = the enclosing
 * function (canonical `swiftMethodId`, so it matches the call-graph node). Entity is
 * best-effort: an explicit `X.self` type argument at the call site, else the enclosing
 * service's `typealias DBObject = X` binding, else `'unknown'` (never fabricated).
 *
 * Default target is Realm (`realm.objects/.filter/safeWrite/add/delete/create`).
 */
import type { DbOperation, DbOperationType, DbOpResolutionStats, StableIdGenerator } from '@coredoc/core';
import {
  CALL_EXPR,
  FUNC_DECL,
  callReceiver,
  TYPE_CONTAINERS,
  type TsNode,
  callMethodName,
  callSuffix,
  enclosingTypeName,
  nearestAncestor,
  swiftMethodId,
  typeName,
} from './swift-cst.js';
import type { SwiftFile } from './swift-callgraph.js';

/** Default Realm verb → operation-kind map. */
const DEFAULT_OP_MAP: Record<string, DbOperationType> = {
  objects: 'read',
  object: 'read',
  filter: 'query',
  where: 'query',
  safeWrite: 'transaction',
  write: 'transaction',
  add: 'create',
  create: 'create',
  delete: 'delete',
};

/**
 * Build `typeName → entity` from a per-service model-binding typealias (e.g. `typealias DBObject
 * = BookingDB`). The typealias NAME is a client convention, so it is profile-supplied — when unset,
 * this fallback is off and ops attribute their entity only from an explicit `X.self` arg.
 */
function buildDbObjectMap(files: SwiftFile[], typealiasName: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!typealiasName) return out;
  for (const { root } of files) {
    for (const ta of root.descendantsOfType('typealias_declaration') as TsNode[]) {
      if (ta.childForFieldName?.('name')?.text !== typealiasName) continue;
      const owner = nearestAncestor(ta, TYPE_CONTAINERS);
      const ownerName = owner ? typeName(owner) : undefined;
      if (!ownerName) continue;
      // The assigned type is the last type_identifier in the alias (`= BookingDB`).
      const ids = ta.descendantsOfType('type_identifier') as TsNode[];
      const assigned = ids[ids.length - 1]?.text as string | undefined;
      if (assigned && !out.has(ownerName)) out.set(ownerName, assigned);
    }
  }
  return out;
}

/** An explicit `X.self` type argument at a call site → the type name `X`. */
function explicitTypeArg(call: TsNode): string | undefined {
  const suffix = callSuffix(call);
  if (!suffix) return undefined;
  for (const nav of suffix.descendantsOfType('navigation_expression') as TsNode[]) {
    const suf = nav.childForFieldName?.('suffix')?.childForFieldName?.('suffix')?.text;
    if (suf === 'self') {
      const target = nav.childForFieldName?.('target');
      if (target?.type === 'simple_identifier') return target.text as string;
    }
  }
  return undefined;
}

/** Does any identifier in the call's receiver name an entity declared in this repo? */
function receiverNamesEntity(call: TsNode, entityIdByName: Map<string, string>): boolean {
  const receiver = callReceiver(call);
  if (!receiver) return false;
  if (entityIdByName.has(receiver.text as string)) return true;
  for (const type of ['simple_identifier', 'type_identifier']) {
    for (const id of receiver.descendantsOfType(type) as TsNode[]) {
      if (entityIdByName.has(id.text as string)) return true;
    }
  }
  return false;
}

export function extractSwiftDbOps(
  files: SwiftFile[],
  entityIdByName: Map<string, string>,
  idGen: StableIdGenerator,
  cfg: { opMap?: Record<string, string>; entityTypealias?: string; receiverPattern?: string } = {},
): { dbOperations: DbOperation[]; stats: DbOpResolutionStats } {
  // A Map, not an object literal: a Swift method named `toString` or `constructor` must not
  // look up an `Object.prototype` member and emit an op with an undefined kind.
  const opMap = new Map<string, DbOperationType>(Object.entries(DEFAULT_OP_MAP));
  for (const [k, v] of Object.entries(cfg.opMap ?? {})) opMap.set(k, v as DbOperationType);
  const receiverRe = cfg.receiverPattern ? new RegExp(cfg.receiverPattern) : undefined;
  const dbObjectByType = buildDbObjectMap(files, cfg.entityTypealias);

  const out: DbOperation[] = [];
  // BR-4: sites this walk ENUMERATES — an op call with an enclosing `func`. A call with no
  // enclosing func is uncounted (it never had a performer).
  const stats: DbOpResolutionStats = { dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 };
  for (const { relPath, root } of files) {
    for (const call of root.descendantsOfType(CALL_EXPR) as TsNode[]) {
      const method = callMethodName(call);
      if (!method) continue;
      const operation = opMap.get(method);
      if (!operation) continue;
      if (receiverRe) {
        // Verbs like `fetch`/`save`/`filter` are common outside the ORM, so a profile may require
        // the receiver to name the ORM handle (`context.fetch`, not `EmployeesSync.fetch`).
        const receiver = callReceiver(call)?.text as string | undefined;
        if (!receiver || !receiverRe.test(receiver)) continue;
      }

      const func = nearestAncestor(call, new Set([FUNC_DECL]));
      if (!func) continue; // no performer → skip (never a synthetic performer)
      const performerId = swiftMethodId(idGen, relPath, func);
      stats.dbOpSites++;

      const entityName = explicitTypeArg(call) ?? dbObjectByType.get(enclosingTypeName(func) ?? '') ?? 'unknown';
      const startLine = call.startPosition.row + 1;
      const location = `${relPath}:${startLine}:${method}`;
      const id = idGen.dbOperationId(performerId, entityName, operation, location);
      const entityId = entityIdByName.get(entityName);
      // An emitted `'unknown'` entity is NOT bound (owner decision); it is out of scope only
      // when the receiver names no in-repo entity either. `boundDbOps` is read back from the
      // emitted ops below so it can never drift from what shipped.
      if (!entityId && !receiverNamesEntity(call, entityIdByName)) stats.outOfScopeDbOps++;
      out.push({
        id,
        versionedId: idGen.versionedId(id, (call.text as string).slice(0, 200)),
        performerId,
        entityId,
        entityName,
        operation,
        location: { filePath: relPath, startLine, endLine: call.endPosition.row + 1 },
      });
    }
  }
  // BR-4: bound = an EMITTED operation with a resolved entity id (as Go and Zig do).
  stats.boundDbOps = out.filter((o) => o.entityId !== undefined).length;
  return { dbOperations: out, stats };
}
