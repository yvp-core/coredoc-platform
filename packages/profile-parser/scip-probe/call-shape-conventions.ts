/**
 * call-shape-conventions.ts — the JS-PROBE HYPOTHESIS PROOF.
 *
 * The TS (NestJS, decorator-driven) probe proved decorator-DRIVEN conventions run on tree-sitter's
 * structural decorator STRINGS. This file tests the OPEN risk: pure-JS repos whose
 * conventions are CALL-SHAPE based (no decorators at all). It reproduces
 * a Koa+Sequelize service's three bespoke extractions —
 *
 *   - 16 Sequelize entities:  sequelize.define("Name", {fields}, {opts})
 *                             + Model.hasMany/belongsTo/... associations
 *   - 82 Koa HTTP routes:     router.<method>("/p", handler) nested inside
 *                             router.extend(BASE, fn) blocks (fullPath = BASE+path)
 *   -  9 Pub/Sub queues:      initHandler(JOB_NAME_CONST, handlers.alias) with the
 *                             JOB const resolved + bg initializeQueues({...})
 *
 * The decisive design point: these are NOT recoverable from code-graph's
 * StructuralCall abstraction, because StructuralCall flattens every call and
 * records only its enclosing METHOD/FUNCTION/CLASS — it does NOT record the
 * enclosing CALL (the router.extend wrapper that supplies BASE), nor does it give
 * structured access to object-literal arguments (entity fields). So this probe
 * goes to RAW tree-sitter CST via TreeSitterLoader (the same loader+parse pattern
 * as packages/code-graph/src/structural/ts-structural.ts), walks CallExpression
 * nodes itself, and reads string-literal args / const bindings / object literals.
 *
 * This is the JS analogue of the TS decorator proof: can tree-sitter's CST
 * carry enough to run call-shape conventions?
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TreeSitterLoader } from '../src/tree-sitter/tree-sitter-loader.js';
import type { StableIdGenerator } from '@coredoc/core';
import type { EntityField, EntityNode, EntityRelation, Entrypoint, HttpMethod } from '@coredoc/core/types';
import type { Node as TsNode } from 'web-tree-sitter';

const KOA_ROUTER_FILE = 'app/initializers/create-koa-router.js';
const PUBSUB_JOBS_FILE = 'app/initializers/create-pub-sub-jobs.js';
const BG_PROCESSING_FILE = 'app/initializers/create-bg-processing.js';

const ROUTER_METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  del: 'DELETE',
  all: 'GET',
};

const ASSOC_METHODS: Record<string, EntityRelation['type']> = {
  hasOne: 'one-to-one',
  hasMany: 'one-to-many',
  belongsTo: 'many-to-one',
  belongsToMany: 'many-to-many',
};

// ── tree-sitter helpers ──────────────────────────────────────────────────────

function text(n: TsNode | null | undefined): string {
  return n?.text ?? '';
}
function unquote(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}
function colonToBrace(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
function extractColonParams(p: string): string[] {
  const params: string[] = [];
  const re = /:([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p)) !== null) params.push(m[1]);
  return params;
}
function joinPath(base: string, p: string): string {
  const b = base.replace(/\/$/, '');
  if (p === '/' || p === '') return b || '/';
  return `${b}${p.startsWith('/') ? '' : '/'}${p}`;
}
function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Collect every call_expression node in the tree. */
function allCalls(root: TsNode): TsNode[] {
  const out: TsNode[] = [];
  const walk = (n: TsNode) => {
    if (n.type === 'call_expression') out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

/** A call's callee shape: receiver (object text) + method (property), for member calls. */
function calleeShape(call: TsNode): { receiver?: string; method?: string; bare?: string } {
  const fn = call.childForFieldName('function');
  if (!fn) return {};
  if (fn.type === 'member_expression') {
    return { receiver: text(fn.childForFieldName('object')), method: text(fn.childForFieldName('property')) };
  }
  return { bare: text(fn) };
}

function callArgs(call: TsNode): TsNode[] {
  const a = call.childForFieldName('arguments');
  return a ? a.namedChildren : [];
}

async function parseFile(repoRoot: string, rel: string): Promise<TsNode> {
  const loader = TreeSitterLoader.getInstance();
  const parser = await loader.getParser('javascript');
  const source = readFileSync(join(repoRoot, rel), 'utf8');
  return parser.parse(source).rootNode;
}

// ── 1. Sequelize entities (call-shape: sequelize.define) ─────────────────────

interface EntityResult {
  entities: EntityNode[];
}

/**
 * Walk every model file's CST for `<x>.define("Name", {fields}, {opts})` and
 * `Model.<assoc>(Target, ...)` association calls. Entity name may be a string
 * literal OR a const identifier resolved from a sibling `const Name = "..."`.
 */
async function extractEntities(
  repoRoot: string,
  modelFiles: string[],
  idGen: StableIdGenerator,
): Promise<EntityResult> {
  const entities: EntityNode[] = [];
  const entityIdByName = new Map<string, string>();
  // First pass: collect entity names (for relation target resolution).
  const perFile: { rel: string; root: TsNode }[] = [];
  for (const rel of modelFiles) {
    const root = await parseFile(repoRoot, rel);
    perFile.push({ rel, root });
    for (const call of allCalls(root)) {
      const { method } = calleeShape(call);
      if (method !== 'define') continue;
      const name = resolveDefineName(call, root);
      if (name) entityIdByName.set(name, idGen.entityId(rel, name));
    }
  }

  for (const { rel, root } of perFile) {
    // associations grouped per file: Model.<assoc>(Target) — attach to whichever
    // entity name matches the receiver.
    const relationsByModel = new Map<string, EntityRelation[]>();
    for (const call of allCalls(root)) {
      const { receiver, method } = calleeShape(call);
      if (!method || !receiver) continue;
      const relType = ASSOC_METHODS[method];
      if (!relType) continue;
      const target = identifierArg(callArgs(call)[0]);
      if (!target) continue;
      const list = relationsByModel.get(receiver) ?? [];
      list.push({ name: target, type: relType, targetEntityName: target });
      relationsByModel.set(receiver, list);
    }

    for (const call of allCalls(root)) {
      const { method } = calleeShape(call);
      if (method !== 'define') continue;
      const name = resolveDefineName(call, root);
      if (!name) continue;
      const args = callArgs(call);
      // golden fallback = 'verbatim' (the model name itself), explicit tableName opt overrides.
      const tableName = optionStringFromObject(args[2]) ?? name;
      const fields = args[1] && args[1].type === 'object' ? readFields(args[1]) : [];
      const relations = (relationsByModel.get(name) ?? []).map((r) => ({
        ...r,
        targetEntityId: entityIdByName.get(r.targetEntityName),
      }));
      const entityId = idGen.entityId(rel, name);
      entities.push({
        id: entityId,
        versionedId: idGen.versionedId(entityId, `${name}:${call.startPosition.row}`),
        name,
        kind: 'entity',
        fileId: idGen.fileId(rel),
        ormType: 'sequelize',
        tableName,
        fields,
        relations,
        location: { filePath: rel, startLine: call.startPosition.row + 1, endLine: call.endPosition.row + 1 },
      });
    }
  }
  return { entities };
}

/** define()'s first arg: string literal, or a const identifier resolved in-file. */
function resolveDefineName(call: TsNode, root: TsNode): string | undefined {
  const arg0 = callArgs(call)[0];
  if (!arg0) return undefined;
  if (arg0.type === 'string') return unquote(text(arg0));
  if (arg0.type === 'identifier') {
    // resolve `const Foo = "Bar"` in the same file
    const want = text(arg0);
    let found: string | undefined;
    const walk = (n: TsNode) => {
      if (n.type === 'variable_declarator') {
        if (text(n.childForFieldName('name')) === want) {
          const v = n.childForFieldName('value');
          if (v?.type === 'string') found = unquote(text(v));
        }
      }
      for (const c of n.namedChildren) walk(c);
    };
    walk(root);
    return found;
  }
  return undefined;
}

/** Field list from the define() fields object literal. */
function readFields(obj: TsNode): EntityField[] {
  const fields: EntityField[] = [];
  for (const pair of obj.namedChildren.filter((c) => c.type === 'pair')) {
    const key = text(pair.childForFieldName('key')).replace(/['"]/g, '');
    if (!key) continue;
    const val = pair.childForFieldName('value');
    const fieldBody = val && val.type === 'object' ? val : undefined;
    const typeText = fieldBody ? dataType(fieldBody) : 'unknown';
    const isPk = fieldBody ? boolOption(fieldBody, 'primaryKey') : false;
    const nullable = fieldBody ? boolOption(fieldBody, 'allowNull') : false;
    const unique = fieldBody ? boolOption(fieldBody, 'unique') : false;
    const autoInc = fieldBody ? boolOption(fieldBody, 'autoIncrement') : false;
    fields.push({
      name: key,
      columnName: snakeCase(key),
      type: { text: typeText },
      isPrimaryKey: isPk,
      isNullable: nullable,
      isUnique: unique,
      isGenerated: isPk || autoInc,
    });
  }
  return fields;
}

/** DataTypes.XXX(...) → "XXX". */
function dataType(fieldBody: TsNode): string {
  for (const pair of fieldBody.namedChildren.filter((c) => c.type === 'pair')) {
    if (text(pair.childForFieldName('key')).replace(/['"]/g, '') !== 'type') continue;
    const v = pair.childForFieldName('value');
    const raw = text(v);
    const m = /DataTypes\.([A-Z]+)/.exec(raw);
    if (m) return m[1];
    return raw;
  }
  return 'unknown';
}

function boolOption(obj: TsNode, key: string): boolean {
  for (const pair of obj.namedChildren.filter((c) => c.type === 'pair')) {
    if (text(pair.childForFieldName('key')).replace(/['"]/g, '') !== key) continue;
    return text(pair.childForFieldName('value')) === 'true';
  }
  return false;
}

function optionStringFromObject(obj: TsNode | undefined): string | undefined {
  if (!obj || obj.type !== 'object') return undefined;
  for (const pair of obj.namedChildren.filter((c) => c.type === 'pair')) {
    if (text(pair.childForFieldName('key')).replace(/['"]/g, '') !== 'tableName') continue;
    const v = pair.childForFieldName('value');
    if (v?.type === 'string') return unquote(text(v));
  }
  return undefined;
}

function identifierArg(arg: TsNode | undefined): string | undefined {
  if (!arg) return undefined;
  if (arg.type === 'identifier') return text(arg);
  if (arg.type === 'string') return unquote(text(arg));
  // associations target `models.ScheduleException` (member_expression) → property name
  if (arg.type === 'member_expression') return text(arg.childForFieldName('property'));
  return undefined;
}

// ── 2. Koa HTTP routes (call-shape: router.extend > router.<method>) ──────────

/**
 * The decisive CST-only extraction: router.<method>("/p", handler) calls are
 * only meaningful WITH the BASE supplied by the enclosing router.extend(BASE, fn).
 * StructuralCall cannot express this nesting; raw CST can — we recurse into the
 * extend() callback and join BASE + path.
 */
async function extractHttp(repoRoot: string, idGen: StableIdGenerator): Promise<Entrypoint[]> {
  const out: Entrypoint[] = [];
  const root = await parseFile(repoRoot, KOA_ROUTER_FILE);

  for (const call of allCalls(root)) {
    const { method } = calleeShape(call);
    if (method !== 'extend') continue;
    const args = callArgs(call);
    const baseArg = args[0];
    if (!baseArg || baseArg.type !== 'string') continue;
    const base = unquote(text(baseArg));
    const fnArg = args[1];
    if (!fnArg || (fnArg.type !== 'arrow_function' && fnArg.type !== 'function_expression')) continue;

    for (const inner of allCalls(fnArg)) {
      const cs = calleeShape(inner);
      // router.<method>(path, ..., handler)
      if (cs.receiver !== 'router' || !cs.method) continue;
      const httpMethod = ROUTER_METHODS[cs.method.toLowerCase()];
      if (!httpMethod) continue;
      const iargs = callArgs(inner);
      const pathArg = iargs[0];
      if (!pathArg || pathArg.type !== 'string') continue;
      const routePath = unquote(text(pathArg));
      const handlerArg = iargs[iargs.length - 1];
      const handlerId = resolveHandlerId(text(handlerArg), root, idGen);
      // ts-morph golden requires a resolved handlerId; mirror that gate.
      if (!handlerId) continue;

      const fullPathRaw = joinPath(base, routePath);
      const fullPath = colonToBrace(fullPathRaw);
      const path = colonToBrace(routePath);
      const id = idGen.httpEntrypointId(httpMethod, fullPath, KOA_ROUTER_FILE);
      out.push({
        id,
        versionedId: idGen.versionedId(id, `${httpMethod}:${fullPath}:${inner.startPosition.row}`),
        type: 'http',
        handlerId,
        location: {
          filePath: KOA_ROUTER_FILE,
          startLine: inner.startPosition.row + 1,
          endLine: inner.endPosition.row + 1,
        },
        details: {
          type: 'http',
          method: httpMethod,
          path,
          fullPath,
          ...(extractColonParams(fullPathRaw).length ? { pathParams: extractColonParams(fullPathRaw) } : {}),
        },
      });
    }
  }
  return out;
}

/** handlers.<alias>.<method> → getFunctionId(file, method) via the require-map. */
function buildHandlerAliasMap(root: TsNode, nested: boolean): Map<string, string> {
  const map = new Map<string, string>();
  // find `const handlers = { ... }`
  let handlersObj: TsNode | undefined;
  const findHandlers = (n: TsNode) => {
    if (n.type === 'variable_declarator' && text(n.childForFieldName('name')) === 'handlers') {
      const v = n.childForFieldName('value');
      if (v?.type === 'object') handlersObj = v;
    }
    for (const c of n.namedChildren) if (!handlersObj) findHandlers(c);
  };
  findHandlers(root);
  if (!handlersObj) return map;

  const requirePathToRel = (t: string): string | undefined => {
    const m = t.match(/require\(["']([^"']+)["']\)/);
    if (!m) return undefined;
    let p = m[1];
    if (!p.startsWith('app/')) return undefined;
    if (!p.endsWith('.js')) p = `${p}.js`;
    return p;
  };

  const walk = (obj: TsNode, prefix: string) => {
    for (const pair of obj.namedChildren.filter((c) => c.type === 'pair')) {
      const key = text(pair.childForFieldName('key')).replace(/['"]/g, '');
      const alias = prefix ? `${prefix}.${key}` : key;
      const v = pair.childForFieldName('value');
      if (!v) continue;
      if (nested && v.type === 'object') walk(v, alias);
      else {
        const file = requirePathToRel(text(v));
        if (file) map.set(alias, file);
      }
    }
  };
  walk(handlersObj, '');
  return map;
}

function resolveHandlerId(handlerText: string, root: TsNode, idGen: StableIdGenerator): string | undefined {
  const aliasToFile = buildHandlerAliasMap(root, true);
  const cleaned = handlerText.replace(/\(.*\)\s*$/, '');
  if (!cleaned.startsWith('handlers.')) return undefined;
  const parts = cleaned.slice('handlers.'.length).split('.');
  if (parts.length < 2) return undefined;
  const methodName = parts[parts.length - 1];
  const alias = parts.slice(0, -1).join('.');
  const file = aliasToFile.get(alias);
  if (!file) return undefined;
  return idGen.functionId(file, methodName);
}

// ── 3. Pub/Sub queues (call-shape: initHandler + initializeQueues) ───────────

async function extractQueues(
  repoRoot: string,
  idGen: StableIdGenerator,
  validFnId: (id: string) => boolean,
): Promise<Entrypoint[]> {
  const out: Entrypoint[] = [];

  // 3a. initHandler(JOB_CONST, handlers.alias)
  const root = await parseFile(repoRoot, PUBSUB_JOBS_FILE);
  const jobNameConst = new Map<string, string>();
  const collectConsts = (n: TsNode) => {
    if (n.type === 'variable_declarator') {
      const v = n.childForFieldName('value');
      if (v?.type === 'string') jobNameConst.set(text(n.childForFieldName('name')), unquote(text(v)));
    }
    for (const c of n.namedChildren) walk2(c, collectConsts);
  };
  const walk2 = (n: TsNode, fn: (n: TsNode) => void) => fn(n);
  collectConsts(root);
  const aliasToFile = buildHandlerAliasMap(root, false);

  for (const call of allCalls(root)) {
    const cs = calleeShape(call);
    if (cs.bare !== 'initHandler') continue;
    const args = callArgs(call);
    const topicArg = args[0];
    let topic: string | undefined;
    if (topicArg?.type === 'string') topic = unquote(text(topicArg));
    else if (topicArg?.type === 'identifier') topic = jobNameConst.get(text(topicArg));
    if (!topic) continue;
    const handlerText = text(args[1]);
    const alias = handlerText.startsWith('handlers.') ? handlerText.slice('handlers.'.length) : handlerText;
    const file = aliasToFile.get(alias);
    const handlerId = file ? idGen.functionId(file, 'onMessage') : undefined;
    if (!handlerId) continue;
    out.push(makeQueueEp(idGen, topic, handlerId, PUBSUB_JOBS_FILE, call));
  }

  // 3b. bgProcessing.initializeQueues({ name: [n, require("app/jobs/...")] })
  const bgRoot = await parseFile(repoRoot, BG_PROCESSING_FILE);
  for (const call of allCalls(bgRoot)) {
    const cs = calleeShape(call);
    if (cs.method !== 'initializeQueues') continue;
    const arg = callArgs(call)[0];
    if (!arg || arg.type !== 'object') continue;
    for (const pair of arg.namedChildren.filter((c) => c.type === 'pair')) {
      const queueName = text(pair.childForFieldName('key')).replace(/['"]/g, '');
      const v = pair.childForFieldName('value');
      const reqMatch = text(v).match(/require\(["'](app\/jobs\/[^"']+)["']\)/);
      if (!reqMatch) continue;
      const file = reqMatch[1].endsWith('.js') ? reqMatch[1] : `${reqMatch[1]}.js`;
      // golden gates on a RESOLVED handler: getFunctionId(file,'onMessage') else the
      // first top-level function DECLARATION. A `module.exports = async () => {}` job
      // (update-events-subscription) is neither → golden emits nothing for it. Mirror
      // that gate: only emit when the handlerId is a real function node in the graph.
      const handlerId = idGen.functionId(file, 'onMessage');
      if (!validFnId(handlerId)) continue;
      out.push(makeQueueEp(idGen, queueName, handlerId, BG_PROCESSING_FILE, call));
    }
  }
  return out;
}

function makeQueueEp(
  idGen: StableIdGenerator,
  topic: string,
  handlerId: string,
  filePath: string,
  call: TsNode,
): Entrypoint {
  const id = idGen.queueEntrypointId('google-pubsub', topic, filePath);
  return {
    id,
    versionedId: idGen.versionedId(id, `${topic}:${call.startPosition.row}`),
    type: 'queue',
    handlerId,
    location: { filePath, startLine: call.startPosition.row + 1, endLine: call.endPosition.row + 1 },
    details: { type: 'queue', system: 'google-pubsub', topic, pattern: 'event' },
  };
}

// ── orchestrator ─────────────────────────────────────────────────────────────

export interface CallShapeResult {
  entities: EntityNode[];
  entrypoints: Entrypoint[];
  httpCount: number;
  queueCount: number;
}

export async function extractCallShapeConventions(
  repoRoot: string,
  modelFiles: string[],
  idGen: StableIdGenerator,
  validFnId: (id: string) => boolean,
): Promise<CallShapeResult> {
  const { entities } = await extractEntities(repoRoot, modelFiles, idGen);
  const http = await extractHttp(repoRoot, idGen);
  const queues = await extractQueues(repoRoot, idGen, validFnId);
  return {
    entities,
    entrypoints: [...http, ...queues],
    httpCount: http.length,
    queueCount: queues.length,
  };
}
