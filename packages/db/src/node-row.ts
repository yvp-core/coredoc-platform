import type { NodeType } from '@coredoc/core';
import type {
  CallerInfo,
  ClassInfo,
  CodeElement,
  EntityInfo,
  EntrypointInfo,
  EnumInfo,
  FunctionInfo,
  InterfaceInfo,
  TypeAliasInfo,
  UnresolvedCallRecord,
} from './types.js';

/**
 * The identity columns every backend already selects for a code-declaration node
 * (function, class, interface, enum, type alias). Everything else lives in the
 * node's property bag, which each backend decodes in its own way (SQLite/Ladybug
 * parse a JSON column, Neo4j reads the flattened node) before calling a mapper
 * here. Numeric coercion (Neo4j `Integer`, Ladybug `bigint`) also happens at that
 * boundary, so `startLine`/`endLine` arrive as plain numbers.
 */
export interface NodeRow {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** The node's own summary column, not a property-bag key. */
  summary?: string | null;
}

/** A property-bag string, treating '' as absent. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A property-bag boolean, treating a non-boolean as absent. */
function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Absent optionals are OMITTED rather than set to `undefined`, matching
 * `externalCallInfoFromRow` and the Ladybug backend: a serialized DTO carries no
 * null-ish keys, and the contract test compares with `toStrictEqual`.
 */
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

/**
 * Map a function/method node to {@link FunctionInfo}. The ONE projection for this
 * DTO: `findFunction`, `getDirectCallees` and `getMonikeredFunctions` in all three
 * backends go through it, so a stored property is read back in one place.
 */
export function functionInfoFromRow(row: NodeRow, props: Record<string, unknown>, className?: string): FunctionInfo {
  const monikerPackage = str(props.monikerPackage);
  return {
    id: row.id,
    ...optional('versionedId', str(props.versionedId)),
    name: row.name,
    kind: str(props.kind) === 'method' ? 'method' : 'function',
    ...optional('fileId', str(props.fileId)),
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    isAsync: bool(props.isAsync) ?? false,
    ...optional('isGenerator', bool(props.isGenerator)),
    ...optional('isExported', bool(props.isExported)),
    ...optional('classId', str(props.classId)),
    ...optional('className', str(className)),
    ...optional('visibility', str(props.visibility) as FunctionInfo['visibility']),
    ...optional('isStatic', bool(props.isStatic)),
    ...optional('isAbstract', bool(props.isAbstract)),
    ...optional('complexity', typeof props.complexity === 'number' ? props.complexity : undefined),
    ...optional('documentation', str(props.documentation)),
    ...optional('summary', str(row.summary)),
    ...optional('purpose', str(props.purpose)),
    ...optional('businessLogic', str(props.businessLogic)),
    ...optional('sideEffects', str(props.sideEffects)),
    ...optional('sourceCode', str(props.sourceCode)),
    ...(monikerPackage
      ? { moniker: { packageName: monikerPackage, descriptor: str(props.monikerDescriptor) ?? '' } }
      : {}),
    ...optional('synthesized', str(props.synthesized) as FunctionInfo['synthesized']),
  };
}

/** The four named declarations that share a node shape, keyed by their DTO. */
interface NamedDeclarationByKind {
  class: ClassInfo;
  interface: InterfaceInfo;
  enum: EnumInfo;
  type_alias: TypeAliasInfo;
}

export type NamedDeclarationKind = keyof NamedDeclarationByKind;

/**
 * Map a class/interface/enum/type-alias node to its DTO. They differ only in a
 * couple of tail fields, so one mapper with a `kind` discriminator replaces four
 * near-identical projections per backend.
 *
 * Nested array fields (`properties_`, `members`) must already be arrays — the
 * Neo4j backend JSON-stringifies them on write and decodes at the row boundary.
 */
export function namedDeclarationFromRow<K extends NamedDeclarationKind>(
  kind: K,
  row: NodeRow,
  props: Record<string, unknown>,
): NamedDeclarationByKind[K] {
  const base = {
    id: row.id,
    ...optional('versionedId', str(props.versionedId)),
    name: row.name,
    ...optional('fileId', str(props.fileId)),
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    isExported: bool(props.isExported) ?? false,
  };
  const documentation = optional('documentation', str(props.documentation));
  switch (kind) {
    case 'class':
      return {
        ...base,
        isAbstract: bool(props.isAbstract) ?? false,
        ...optional('extendsName', str(props.extendsName)),
        ...optional('extendsId', str(props.extendsId)),
        ...documentation,
        // The transformer persists class fields under `properties_` (the trailing
        // underscore avoids colliding with the node's own properties blob).
        ...(Array.isArray(props.properties_) ? { properties: props.properties_ as ClassInfo['properties'] } : {}),
      } as NamedDeclarationByKind[K];
    case 'interface':
      return {
        ...base,
        ...documentation,
        ...(Array.isArray(props.members) ? { members: props.members as InterfaceInfo['members'] } : {}),
      } as NamedDeclarationByKind[K];
    case 'enum':
      return {
        ...base,
        ...optional('isConst', bool(props.isConst)),
        ...documentation,
        ...(Array.isArray(props.members) ? { members: props.members as EnumInfo['members'] } : {}),
      } as NamedDeclarationByKind[K];
    default:
      return {
        ...base,
        ...documentation,
        ...optional('aliasedTypeText', str(props.aliasedTypeText)),
      } as NamedDeclarationByKind[K];
  }
}

/**
 * Map an entity node to {@link EntityInfo}. Nested `fields`/`relations`/`indexes`
 * must already be arrays — the Neo4j backend JSON-stringifies them on write and
 * decodes at the row boundary.
 */
export function entityInfoFromRow(row: NodeRow, props: Record<string, unknown>): EntityInfo {
  return {
    id: row.id,
    ...optional('versionedId', str(props.versionedId)),
    name: row.name,
    ...optional('fileId', str(props.fileId)),
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    ormType: str(props.ormType) ?? 'unknown',
    tableName: str(props.tableName) ?? row.name,
    ...optional('schema', str(props.schema)),
    ...optional('documentation', str(props.documentation)),
    ...(Array.isArray(props.fields) ? { fields: props.fields as EntityInfo['fields'] } : {}),
    ...(Array.isArray(props.relations) ? { relations: props.relations as EntityInfo['relations'] } : {}),
    ...(Array.isArray(props.indexes) ? { indexes: props.indexes as EntityInfo['indexes'] } : {}),
  };
}

/**
 * Every property `transformEntrypoint` writes that can hold an entrypoint's ADDRESS — the token
 * an agent types into `pathPattern`. Only an HTTP entrypoint has a `fullPath`; a queue/event/
 * cron/CLI one is addressed by its destination, topic, event name, command or schedule.
 *
 * These are the STORED names, which are not the `EntrypointAddress` field names the JS
 * refinement uses (`messagingDestinationRef` / `messagingDestination`, not `destination` /
 * `destinationValue`). The SQLite and Neo4j `listEntrypoints` prefilters both build their
 * predicate from this one list; Ladybug has no prefilter (it scans and refines in JS).
 */
export const ENTRYPOINT_ADDRESS_PROPERTY_KEYS = [
  'fullPath',
  'path',
  'fieldName',
  'messagingDestination',
  'messagingDestinationRef',
  'topicValue',
  'topic',
  'eventValue',
  'eventName',
  'command',
  'schedule',
  'className',
] as const;

/** Entrypoint identity columns: unlike {@link NodeRow} the name is unused and `endLine` optional. */
export interface EntrypointRow {
  id: string;
  filePath: string;
  startLine: number;
  endLine?: number;
}

/** The handling function, as far as an entrypoint read resolved it. */
export interface EntrypointHandler {
  id?: string | null;
  name?: string | null;
  summary?: string | null;
  purpose?: string | null;
}

/**
 * Map an entrypoint node to {@link EntrypointInfo}. The ONE projection for this DTO:
 * `listEntrypoints` and the reaching-entrypoints walk in all three backends go through it,
 * so a stored address property — `className`/`trigger` and whatever a future entrypoint kind
 * adds — is read back in one place.
 */
export function entrypointInfoFromRow(
  row: EntrypointRow,
  props: Record<string, unknown>,
  handler: EntrypointHandler = {},
): EntrypointInfo {
  const destination = str(props.messagingDestinationRef ?? props.topic ?? props.eventName);
  const storedDestination = str(props.messagingDestination ?? props.topicValue ?? props.eventValue);
  return {
    id: row.id,
    ...optional('versionedId', str(props.versionedId)),
    type: (str(props.entrypointType) ?? 'http') as EntrypointInfo['type'],
    handlerId: str(props.handlerId) ?? str(handler.id) ?? '',
    ...optional('handlerName', str(handler.name)),
    ...optional('method', str(props.method) as EntrypointInfo['method']),
    ...optional('path', str(props.path)),
    ...optional('fullPath', str(props.fullPath)),
    ...optional('fieldName', str(props.fieldName)),
    ...optional('operationType', str(props.operationType) as EntrypointInfo['operationType']),
    ...optional('schedule', str(props.schedule)),
    ...optional('topic', str(props.topic)),
    ...optional('topicValue', str(props.topicValue)),
    ...optional('eventName', str(props.eventName)),
    ...optional('system', str(props.messagingSystem ?? props.emitter)),
    ...optional('destination', destination),
    ...(storedDestination && storedDestination !== destination ? { destinationValue: storedDestination } : {}),
    ...optional('command', str(props.command)),
    ...optional('className', str(props.className)),
    ...optional('trigger', str(props.trigger)),
    filePath: row.filePath,
    startLine: row.startLine,
    ...optional('endLine', row.endLine),
    ...optional('documentation', str(props.documentation)),
    ...optional('summary', str(handler.summary)),
    ...optional('purpose', str(handler.purpose)),
  };
}

/**
 * The identity columns a search/symbol-listing read selects for a {@link CodeElement}.
 * `type` is already normalized to a {@link NodeType} by the backend (SQLite reads the
 * stored string, Neo4j the label, Ladybug the decoded node), and `purpose`/`sourceCode`
 * come from the property bag the backend decoded.
 */
export interface CodeElementRow {
  id: string;
  name: string;
  type: NodeType;
  filePath: string;
  startLine: number;
  endLine?: number | null;
  summary?: string | null;
  purpose?: string | null;
  /** Only projected when the read was asked for source; otherwise absent. */
  sourceCode?: string | null;
}

/**
 * Map a search hit to {@link CodeElement}. The ONE projection for this DTO:
 * `findCode` and `listSymbolsInFile` in all three backends go through it.
 */
export function codeElementFromRow(row: CodeElementRow): CodeElement {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    filePath: row.filePath,
    startLine: row.startLine,
    ...(row.endLine != null ? { endLine: row.endLine } : {}),
    ...optional('summary', str(row.summary)),
    ...optional('purpose', str(row.purpose)),
    ...optional('sourceCode', str(row.sourceCode)),
  };
}

/** Caller identity columns: like {@link NodeRow} but `endLine` is genuinely optional. */
export interface CallerRow {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine?: number | null;
  summary?: string | null;
}

/**
 * What the CALLS/REFERENCES_VARIABLE edge (and the walk that followed it) contributes
 * to a caller row — everything {@link CallerInfo} carries that is not a node property.
 */
export interface CallerEdgeFacts {
  /** 1 = direct caller, 2+ = transitive. */
  distance: number;
  className?: string | null;
  callSiteLine?: number | null;
  isAsyncCall?: boolean | null;
  /**
   * Truthy when the edge (or any hop of the path) was INFERRED. Projected as the
   * literal `true` or omitted — an explicit `false` would read as "proven" on a row
   * whose edge simply predates the flag.
   */
  provenanceInferred?: boolean | number | null;
}

/**
 * Map a caller node + its reaching edge to {@link CallerInfo}. The ONE projection for
 * this DTO: `getDirectCallers` and `getTransitiveCallers` in all three backends go
 * through it.
 */
export function callerInfoFromRow(row: CallerRow, props: Record<string, unknown>, facts: CallerEdgeFacts): CallerInfo {
  return {
    id: row.id,
    name: row.name,
    kind: str(props.kind) === 'method' ? 'method' : 'function',
    filePath: row.filePath,
    startLine: row.startLine,
    ...(row.endLine != null ? { endLine: row.endLine } : {}),
    ...optional('className', str(facts.className)),
    ...optional('summary', str(row.summary)),
    ...optional('purpose', str(props.purpose)),
    ...optional('visibility', str(props.visibility) as CallerInfo['visibility']),
    ...optional('isAsync', bool(props.isAsync)),
    distance: facts.distance,
    ...(facts.callSiteLine ? { callSiteLine: facts.callSiteLine } : {}),
    ...(facts.isAsyncCall ? { isAsyncCall: true } : {}),
    ...(facts.provenanceInferred ? { provenanceInferred: true as const } : {}),
    ...optional('synthesized', str(props.synthesized) as CallerInfo['synthesized']),
  };
}

/**
 * The stored columns of an unresolved call site. `line` is already a plain number —
 * each backend coerces at its own row boundary (Ladybug returns `bigint`).
 */
export interface UnresolvedCallRow {
  callerId: string;
  calleeExpression: string;
  calleeNameTail: string | null;
  filePath: string;
  line: number;
}

/**
 * Map an unresolved-call row to {@link UnresolvedCallRecord}. `calleeNameTail` keeps its
 * explicit `null` (the DTO declares it nullable — absence would mean "not read").
 */
export function unresolvedCallFromRow(row: UnresolvedCallRow): UnresolvedCallRecord {
  return {
    callerId: row.callerId,
    calleeExpression: row.calleeExpression,
    calleeNameTail: row.calleeNameTail,
    filePath: row.filePath,
    line: row.line,
  };
}
