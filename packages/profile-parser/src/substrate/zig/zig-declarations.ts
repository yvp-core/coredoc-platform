/**
 * One walk per Zig file → the container and function nodes it declares (BR-2..BR-6).
 *
 * Two properties this module exists to hold:
 *
 *  - `class.id === method.classId` BY CONSTRUCTION. Both come from the same qualified-name
 *    chain in the same walk, so a method can never name a container nobody emitted (the
 *    dangling-classId class of defect the Rust substrate had to repair after the fact).
 *  - Only DECLARED containers become nodes. A container reached any other way — a field's
 *    anonymous `struct { … }` type, a `.{ … }` initializer, a struct built inside a block that
 *    is not a directly returned type — has no name a stable id could key on, so it emits
 *    nothing rather than a fabricated one.
 */
import type { StableIdGenerator } from '@coredoc/core';
import type { ClassNode, EnumMember, EnumNode, FunctionNode, PropertyNode, SourceLocation } from '@coredoc/core/types';
import { parseCreateTables } from '../engine/sql-ddl.js';
import {
  BINARY_EXPRESSION,
  BUILTIN_FUNCTION,
  CALL_EXPRESSION,
  CONTAINER_FIELD,
  FIELD_EXPRESSION,
  type FieldFacts,
  FUNCTION_DECL,
  SOURCE_FILE,
  TEST_DECL,
  TRY_EXPRESSION,
  type TsNode,
  VARIABLE_DECL,
  MAX_CST_DEPTH,
  bareTypeText,
  builtinName,
  builtinStringArg,
  calleeOf,
  callArguments,
  containerOf,
  declName,
  declValue,
  docComment,
  enclosingFunctionDecl,
  fieldFacts,
  fnName,
  hasModifier,
  isTypeConstructor,
  locationOf,
  memberChain,
  namedChildrenOfType,
  parameterFacts,
  referencesSelf,
  returnTypeText,
  returnedContainer,
  sqlText,
  stringConstText,
  unwrapTry,
} from './zig-cst.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

/** One parsed Zig source file. `root` is released by the caller (`releaseParsedTrees`). */
export interface ZigFile {
  relPath: string;
  source: string;
  root: TsNode;
}

export interface ZigFileDeclarations {
  classes: ClassNode[];
  enums: EnumNode[];
  functions: FunctionNode[];
}

/** One emitted container, as the resolution lanes need it (BR-12). */
export interface ZigContainerFacts {
  classId: string;
  /** The container declaration node (`struct_declaration`, …). */
  node: TsNode;
  methodsByName: Map<string, FunctionNode>;
  /** Property name → its declared type TEXT, as written (`*std.mem.Allocator`). */
  propertyTypes: Map<string, string>;
}

/** Everything in a file a name can be resolved against, keyed by BR-4 qualified names. */
export interface ZigDeclarationIndex {
  /** Functions declared directly under `source_file`, by name. */
  topLevelFunctions: Map<string, FunctionNode>;
  containers: Map<string, ZigContainerFacts>;
  /** Present when the file is itself a struct (BR-3). */
  fileStruct?: { classId: string; name: string };
  /**
   * Qualified name → the VALUE node of its `variable_declaration`, for every declaration at
   * file scope or directly inside an emitted container — the raw material the `zig-type`
   * chain (BR-12) and the constant/alias classification (BR-16) read.
   */
  constBindings: Map<string, TsNode>;
}

/** One `@import`/`@cInclude` occurrence, before any path resolution (BR-9). */
export interface RawImportBinding {
  /** The literal spec: `std`, `./x.zig`, or the header name of a `@cInclude`. */
  spec: string;
  /** The name the declaration binds, when the builtin is (the head of) a declaration's value. */
  localName?: string;
  /** The whole selector off the import (`@import("x").Outer.Inner` → `['Outer','Inner']`), empty for a namespace import. */
  members: string[];
  isPub: boolean;
  kind: 'import' | 'cinclude';
  /**
   * Whether the declaration is at FILE scope — top level, or directly inside a container body.
   * A function-local `const util = @import("b.zig")` is a lexical binding of that function only:
   * it must not enter the file binding table (where it would resolve every OTHER function's
   * `util.f()` to the wrong file), even though its ImportEdge is still emitted (BR-9/BR-10).
   */
  bindsFileScope: boolean;
  node: TsNode;
  location: SourceLocation;
}

/** One `call_expression` under an emitted function (BR-11). `try` is already unwrapped. */
export interface ZigCallSite {
  callerId: string;
  /** Qualified name of the caller's container, when the caller is a method. */
  callerOwnerQualifiedName?: string;
  node: TsNode;
  callee: TsNode;
  /** `memberChain(callee)`; absent when the callee is not a plain name chain. */
  chain?: string[];
  /** Argument texts, capped at 200 chars each. */
  arguments: string[];
  location: SourceLocation;
}

/**
 * Generic SQL-client verbs — the METHOD a raw statement is handed to. Deliberately not client
 * names: no shared lane may hardcode one repo's wrapper. A repo whose wrapper names its verb
 * differently adds it through `ZigProfile.dbOperations.methods` (a UNION, never a replacement).
 *
 * `run` is deliberately absent: in Zig it is the name of every step/loop/worker entry point, and
 * `run("update available packages")` reads as an UPDATE on a table called `available`.
 *
 * It lives here rather than in `zig-dbops.ts` because the WALK needs it too: a `create table`
 * handed to a non-DB verb inside a `test` block is a log line, not a fixture table (BR-15).
 */
export const DB_EXEC_METHODS = [
  'exec',
  'execute',
  'query',
  'queryRow',
  'queryRows',
  'row',
  'rows',
  'scalar',
  'prepare',
  'fetchAll',
  'fetchOne',
];

const DEFAULT_EXEC_METHODS: ReadonlySet<string> = new Set(DB_EXEC_METHODS);

/**
 * `std.fmt` formatters: a call that RETURNS the composed string rather than executing it. The
 * SQL text is the format string as written — `{d}`/`{s}` placeholders stay, which is all
 * `parseSqlOp` needs (a verb and a table).
 */
export const SQL_FORMATTER_METHODS: ReadonlySet<string> = new Set([
  'bufPrint',
  'bufPrintZ',
  'allocPrint',
  'allocPrintZ',
  'comptimePrint',
]);

/** One literal that looks like SQL (BR-15). `parseSqlOp` is the dbops lane's job, not this one. */
export interface ZigSqlString {
  text: string;
  node: TsNode;
  /** The enclosing emitted function, when there is one. */
  callerId?: string;
  asCallArgument: boolean;
  /**
   * LAST chain member of the enclosing call's callee (`conn.exec("…")` -> `'exec'`), when the
   * literal is one of that call's arguments. The db-op lane gates on it: without the gate a
   * `std.debug.print("update err: {any}", …)` reads as an UPDATE on a table called `err`.
   */
  calleeMethod?: string;
  /**
   * The local this literal's FORMATTED result is bound to, one hop only: `const sql = try
   * std.fmt.bufPrint(&buf, "delete from t where id = {d}", .{id});`. The db-op lane pairs it
   * with a later `conn.exec(sql, …)` in the same function (BR-15) — the common Zig idiom for a
   * statement with an interpolated fragment, which the immediate-callee gate alone drops.
   */
  boundLocal?: string;
  location: SourceLocation;
}

/** A `const`/`var` that is neither a container, a function nor an import (BR-16). */
export interface ZigConstantCandidate {
  qualifiedName: string;
  name: string;
  isPub: boolean;
  declarationKind: 'const' | 'var';
  typeText?: string;
  valueNode: TsNode;
  /** Value text, capped at 200 chars. */
  valueText: string;
  node: TsNode;
  location: SourceLocation;
}

/**
 * One file's facts, all produced by the SINGLE pass `extractZigFileFacts` performs (BR-18):
 * no lane re-walks `file.root`, because the tree is released right after parsing.
 */
export interface ZigFileFacts {
  decls: ZigFileDeclarations;
  index: ZigDeclarationIndex;
  imports: RawImportBinding[];
  callSites: ZigCallSite[];
  sqlStrings: ZigSqlString[];
  /**
   * Receivers that denote a `std.http.Client` (BR-14): a binding by `<caller fn id>:<name>`
   * (`'local'`; the id is empty at file scope), a container property by `Container.field`
   * (`'field'`).
   */
  httpClientDecls: Map<string, 'local' | 'field'>;
  /**
   * Tables a `create table` inside a `test` block declares. No node, no entity — just the
   * names, so the db-op lane can drop an op on a table that only the test suite creates.
   */
  testOnlyTables: Set<string>;
  /**
   * Plain-string constants, keyed by the SCOPE they are visible in exactly like
   * `httpClientDecls` (`<enclosing fn id>:<name>`, `:<name>` at file scope). One hop of
   * constant folding for the egress lane; a parameter is not a declaration, so it never lands here.
   */
  stringConstDecls: Map<string, string>;
  /**
   * Emitted caller id → every name LEXICALLY BOUND inside it: its parameter names plus the name
   * of every `variable_declaration` in its body, nested blocks included. A bare `f()` or a chain
   * head that is one of these names is a local, not a file-level function/type/import — so the
   * call tiers and the egress fold DROP it instead of resolving it against the file table.
   */
  localsByCaller: Map<string, Set<string>>;
  constantCandidates: ZigConstantCandidate[];
}

/** One file's facts, as every slice-2 lane consumes them (BR-18: no lane re-walks the tree). */
export interface ZigFileEntry {
  relPath: string;
  facts: ZigFileFacts;
}

/** Parse one file's source into a `ZigFile`. */
export async function toZigFile(relPath: string, source: string): Promise<ZigFile> {
  return { relPath, source, root: await parseSource('zig', source) };
}

/** The file-struct's name: the basename without the `.zig` extension (`src/Config.zig` → `Config`). */
export function fileStructName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return base.endsWith('.zig') ? base.slice(0, -4) : base;
}

/** Mutable accumulator shared by the recursive walk. `seen` enforces the first-wins rule (BR-4). */
interface Walk {
  relPath: string;
  idGen: StableIdGenerator;
  out: ZigFileDeclarations;
  seen: Set<string>;
  facts: ZigFileFacts;
  /** Source range of an emitted `function_declaration` → the node it produced. */
  emittedFns: Map<string, { fn: FunctionNode; ownerQualifiedName?: string }>;
}

/** Identity key for a CST node: web-tree-sitter hands out a fresh object on every access. */
function rangeKey(node: TsNode): string {
  return `${node.startIndex}:${node.endIndex}`;
}

/** Register an id once; a later declaration producing the same id is dropped (BR-4). */
function claim(walk: Walk, id: string): boolean {
  if (walk.seen.has(id)) return false;
  walk.seen.add(id);
  return true;
}

function propertiesOf(container: TsNode, classId: string, walk: Walk): PropertyNode[] {
  return propertiesFrom(namedChildrenOfType(container, CONTAINER_FIELD), classId, walk);
}

/**
 * Fields → properties. A field `fieldFacts` reports as no field (the phantom of an empty
 * container) emits NOTHING; a tuple field, which has no name of its own, is named by its
 * ordinal position so its id stays unique and reads as positional.
 */
function propertiesFrom(fields: TsNode[], classId: string, walk: Walk): PropertyNode[] {
  const out: PropertyNode[] = [];
  fields.forEach((field, index) => {
    const facts = fieldFacts(field);
    if (!facts) return;
    const name = facts.kind === 'positional' ? String(index) : facts.name;
    out.push(toProperty(field, name, facts, classId, walk));
  });
  return out;
}

function toProperty(field: TsNode, name: string, facts: FieldFacts, classId: string, walk: Walk): PropertyNode {
  return {
    id: walk.idGen.generateNodeId('variable', walk.relPath, `${classId}.${name}`),
    name,
    classId,
    // Zig has no per-field visibility: a field of a reachable type is reachable.
    visibility: 'public',
    isStatic: false,
    isReadonly: false,
    isOptional: facts.typeText?.startsWith('?') ?? false,
    type: facts.typeText ? { text: facts.typeText } : undefined,
    defaultValue: facts.defaultValue,
    location: locationOf(field, walk.relPath),
    documentation: docComment(field),
  };
}

/** Enum members. A phantom field (`enum {}`) and a positional field, which no enum declares, emit nothing. */
function membersOf(container: TsNode): EnumMember[] {
  const out: EnumMember[] = [];
  for (const field of namedChildrenOfType(container, CONTAINER_FIELD)) {
    const facts = fieldFacts(field);
    if (facts?.kind !== 'named') continue;
    out.push({ name: facts.name, value: facts.defaultValue, documentation: docComment(field) });
  }
  return out;
}

/**
 * Emit one function. `owner` is present iff the function is declared inside an EMITTED
 * container, which is exactly the condition for `kind: 'method'` (BR-6).
 */
function emitFunction(
  node: TsNode,
  walk: Walk,
  owner?: { classId: string; qualifiedName: string },
): FunctionNode | undefined {
  const name = fnName(node);
  if (!name) return undefined;
  const id = owner
    ? walk.idGen.methodId(walk.relPath, owner.qualifiedName, name)
    : walk.idGen.functionId(walk.relPath, name);
  if (!claim(walk, id)) return undefined;

  const params = parameterFacts(node);
  const simpleName = owner ? owner.qualifiedName.slice(owner.qualifiedName.lastIndexOf('.') + 1) : '';
  const isExported = hasModifier(node, 'pub');
  const fn: FunctionNode = {
    id,
    versionedId: walk.idGen.versionedId(id, node.text as string),
    name,
    location: locationOf(node, walk.relPath),
    documentation: docComment(node),
    kind: owner ? 'method' : 'function',
    fileId: walk.idGen.fileId(walk.relPath),
    // Zig's `async` is a call-site keyword, not a function modifier, and it has no generators.
    isAsync: false,
    isGenerator: false,
    parameters: params.map((p) => ({
      name: p.name,
      type: p.typeText ? { text: p.typeText } : undefined,
      isOptional: false,
      isRest: false,
    })),
    returnType: returnTypeText(node) ? { text: returnTypeText(node) as string } : undefined,
    isExported,
    visibility: isExported ? 'public' : 'private',
    // Same cap as the Swift and Go substrates: `summarize` and `explain` read this text
    // locally, and strip-source removes it before any remote write.
    sourceCode: (node.text as string).slice(0, 20000),
  };
  if (owner) {
    fn.classId = owner.classId;
    // A Zig method is an ordinary namespaced function; only a receiver first parameter
    // (`self: Self` / `*@This()` / the container's own name) makes it an instance method.
    fn.isStatic = !referencesSelf(params[0]?.typeText, simpleName);
  }
  walk.out.functions.push(fn);
  walk.emittedFns.set(rangeKey(node), { fn, ownerQualifiedName: owner?.qualifiedName });
  // Parameter names are the first half of the caller's lexical scope; the walk adds its
  // `variable_declaration`s below (BR-12: a shadowed name resolves to nothing).
  walk.facts.localsByCaller.set(id, new Set(params.map((p) => p.name).filter((n) => n && n !== '_')));
  if (owner) walk.facts.index.containers.get(owner.qualifiedName)?.methodsByName.set(name, fn);
  // A file-struct's functions are methods AND top-level functions: a bare `f()` in the file
  // reaches them either way, so both indexes must see them (BR-12 `zig-local`).
  if (node.parent?.type === SOURCE_FILE && !walk.facts.index.topLevelFunctions.has(name)) {
    walk.facts.index.topLevelFunctions.set(name, fn);
  }
  return fn;
}

/** Index an emitted container and record any `std.http.Client` property on it (BR-14b). */
function registerContainer(
  walk: Walk,
  qualifiedName: string,
  classId: string,
  node: TsNode,
  properties: PropertyNode[],
): void {
  const propertyTypes = new Map<string, string>();
  for (const property of properties) {
    if (property.type?.text) propertyTypes.set(property.name, property.type.text);
  }
  walk.facts.index.containers.set(qualifiedName, {
    classId,
    node,
    methodsByName: new Map<string, FunctionNode>(),
    propertyTypes,
  });
  for (const [name, text] of propertyTypes) {
    if (namesHttpClient(text)) walk.facts.httpClientDecls.set(`${qualifiedName}.${name}`, 'field');
  }
}

/**
 * Emit a declared container and everything it declares. `declNode` is the node whose source
 * text versions the node (the `variable_declaration` for a named type, the container itself
 * for a type constructor's returned struct).
 */
function emitContainer(
  container: TsNode,
  declNode: TsNode,
  qualifiedName: string,
  isExported: boolean,
  walk: Walk,
): void {
  const isEnum = container.type === 'enum_declaration';
  const classId = walk.idGen.classId(walk.relPath, qualifiedName);
  const fnNodes = namedChildrenOfType(container, FUNCTION_DECL);

  if (isEnum) {
    const enumId = walk.idGen.enumId(walk.relPath, qualifiedName);
    if (!claim(walk, enumId)) return;
    walk.out.enums.push({
      id: enumId,
      versionedId: walk.idGen.versionedId(enumId, declNode.text as string),
      name: qualifiedName,
      location: locationOf(declNode, walk.relPath),
      documentation: docComment(declNode),
      kind: 'enum',
      fileId: walk.idGen.fileId(walk.relPath),
      isExported,
      // Every Zig enum member is a compile-time constant.
      isConst: true,
      members: membersOf(container),
    });
    // No functions → no method-bearing facet to emit; an EnumNode alone is the honest node.
    if (fnNodes.length === 0) {
      emitNestedTypes(container, qualifiedName, walk);
      return;
    }
  }

  if (!claim(walk, classId)) return;
  const cls: ClassNode = {
    id: classId,
    versionedId: walk.idGen.versionedId(classId, declNode.text as string),
    name: qualifiedName,
    location: locationOf(declNode, walk.relPath),
    documentation: docComment(declNode),
    kind: 'class',
    fileId: walk.idGen.fileId(walk.relPath),
    isExported,
    // Zig has no abstract types; `opaque` is an incomplete type, not an abstract one.
    isAbstract: false,
    methods: [],
    // An enum's `container_field`s are its MEMBERS; the class facet exists only to own methods.
    properties: isEnum ? [] : propertiesOf(container, classId, walk),
    // Zig has no constructor concept: `init` is an ordinary function by convention.
    constructor: undefined,
  };
  walk.out.classes.push(cls);
  registerContainer(walk, qualifiedName, classId, container, cls.properties);

  for (const fnNode of fnNodes) {
    const fn = emitFunction(fnNode, walk, { classId, qualifiedName });
    if (fn) cls.methods.push(fn.id);
    emitTypeConstructor(fnNode, qualifiedName, walk);
  }
  emitNestedTypes(container, qualifiedName, walk);
  scanBindings(container, qualifiedName, walk);
}

/** `Outer` + `Inner` → `Outer.Inner`; an empty prefix (a namespace file) leaves the name bare. */
function qualify(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

/** Named containers declared directly inside `container`'s body, qualified by the dotted chain. */
function emitNestedTypes(container: TsNode, prefix: string, walk: Walk): void {
  for (const decl of namedChildrenOfType(container, VARIABLE_DECL)) {
    const nested = containerOf(decl);
    const name = declName(decl);
    if (!nested || !name) continue;
    emitContainer(nested, decl, qualify(prefix, name), hasModifier(decl, 'pub'), walk);
  }
}

/** A `fn F(…) type` that DIRECTLY returns a container also declares that container (BR-5). */
function emitTypeConstructor(fnNode: TsNode, prefix: string, walk: Walk): void {
  if (!isTypeConstructor(fnNode)) return;
  const container = returnedContainer(fnNode);
  const name = fnName(fnNode);
  if (!container || !name) return;
  emitContainer(container, container, qualify(prefix, name), hasModifier(fnNode, 'pub'), walk);
}

/**
 * Extract one file's declarations. A file with at least one top-level `container_field` IS a
 * struct (BR-3): it gets a class named for the file and its top-level functions become that
 * class's methods. A file without top-level fields is a namespace and gets no synthetic class.
 */
export function extractZigFileFacts(file: ZigFile, idGen: StableIdGenerator): ZigFileFacts {
  const out: ZigFileDeclarations = { classes: [], enums: [], functions: [] };
  const walk: Walk = {
    relPath: file.relPath,
    idGen,
    out,
    seen: new Set<string>(),
    emittedFns: new Map(),
    facts: {
      decls: out,
      index: {
        topLevelFunctions: new Map(),
        containers: new Map(),
        constBindings: new Map(),
      },
      imports: [],
      callSites: [],
      sqlStrings: [],
      httpClientDecls: new Map(),
      testOnlyTables: new Set(),
      stringConstDecls: new Map(),
      localsByCaller: new Map(),
      constantCandidates: [],
    },
  };
  const root = file.root;
  const topFields = namedChildrenOfType(root, CONTAINER_FIELD);
  const topFns = namedChildrenOfType(root, FUNCTION_DECL);

  let owner: { classId: string; qualifiedName: string } | undefined;
  let prefix = '';
  if (topFields.length > 0) {
    const name = fileStructName(file.relPath);
    const classId = idGen.classId(file.relPath, name);
    if (claim(walk, classId)) {
      const cls: ClassNode = {
        id: classId,
        versionedId: idGen.versionedId(classId, file.source),
        name,
        location: { filePath: file.relPath, startLine: 1, endLine: root.endPosition.row + 1 },
        kind: 'class',
        fileId: idGen.fileId(file.relPath),
        // A file-struct is reachable by `@import` from anywhere in the module; there is no
        // `pub` keyword on a file to read this from.
        isExported: true,
        isAbstract: false,
        methods: [],
        properties: [],
        constructor: undefined,
      };
      cls.properties = propertiesFrom(topFields, classId, walk);
      walk.out.classes.push(cls);
      registerContainer(walk, name, classId, root, cls.properties);
      walk.facts.index.fileStruct = { classId, name };
      owner = { classId, qualifiedName: name };
      prefix = name;
    }
  }

  for (const fnNode of topFns) {
    const fn = emitFunction(fnNode, walk, owner);
    if (fn && owner) {
      const cls = walk.out.classes.find((c) => c.id === owner?.classId);
      cls?.methods.push(fn.id);
    }
    emitTypeConstructor(fnNode, prefix, walk);
  }
  emitNestedTypes(root, prefix, walk);
  scanBindings(root, prefix, walk);
  // Second and LAST traversal of the tree: call sites, imports and literals need the emitted
  // function index above to attribute themselves, and nothing after this reads `file.root`.
  sweep(root, walk, false);
  return walk.facts;
}

const HTTP_CLIENT = 'std.http.Client';

/** Whether a type annotation or an initializer names `std.http.Client` (BR-14a/b). */
function namesHttpClient(text: string | undefined): boolean {
  if (!text) return false;
  const bare = bareTypeText(text);
  return bare === HTTP_CLIENT || bare.startsWith(`${HTTP_CLIENT}{`) || bare.startsWith(`${HTTP_CLIENT}.init(`);
}

/** The builtin at the head of a value chain: `@import("x").Foo` → the `@import` node. */
function headBuiltin(node: TsNode | undefined): TsNode | undefined {
  let current = node;
  while (current?.type === FIELD_EXPRESSION) current = current.childForFieldName?.('object');
  return current?.type === BUILTIN_FUNCTION ? current : undefined;
}

/**
 * `variable_declaration`s directly under `body` (file scope or an emitted container): the
 * `constBindings` raw material (BR-12) plus the BR-16 constant candidates. Classification of
 * alias-vs-variable is NOT done here — it needs the resolved import table (`zig-parser.ts`).
 */
function scanBindings(body: TsNode, prefix: string, walk: Walk): void {
  for (const decl of namedChildrenOfType(body, VARIABLE_DECL)) {
    const name = declName(decl);
    const value = declValue(decl);
    if (!name || name === '_' || !value) continue;
    const qualifiedName = qualify(prefix, name);
    if (!walk.facts.index.constBindings.has(qualifiedName)) walk.facts.index.constBindings.set(qualifiedName, value);

    // A container is a class/enum node, a function is a function node, an import is an
    // ImportEdge — none of the three is also a constant (BR-16).
    if (containerOf(decl) || value.type === FUNCTION_DECL) continue;
    const head = builtinName(headBuiltin(value) ?? value);
    if (head === '@import' || head === '@cImport') continue;

    walk.facts.constantCandidates.push({
      qualifiedName,
      name,
      isPub: hasModifier(decl, 'pub'),
      declarationKind: hasModifier(decl, 'var') ? 'var' : 'const',
      typeText: decl.childForFieldName?.('type')?.text as string | undefined,
      valueNode: value,
      valueText: (value.text as string).slice(0, 200),
      node: decl,
      location: locationOf(decl, walk.relPath),
    });
  }
}

/** A literal whose text starts with a SQL verb — the cheap pre-filter before `parseSqlOp`. */
const SQL_VERB = /^\s*(select|insert|update|delete|create|drop|alter|replace|with)\b/i;
/** DDL anywhere in the literal: a `\\ pragma …` preamble puts `create table` off the start. */
const CREATE_TABLE = /create\s+table/i;

/**
 * The expression sweep: imports (BR-9), call sites (BR-11), SQL literals (BR-15) and
 * `std.http.Client` bindings (BR-14a). `inTest` propagates down a `test_declaration` subtree,
 * which is a caller for nothing — but still a place an `@import` legitimately appears.
 */
function sweep(node: TsNode, walk: Walk, inTest: boolean, inConcat = false, depth = 0): void {
  // Depth is attacker-controlled (a generated `++` chain nests one node per operand): past the
  // cap the subtree records NOTHING rather than overflowing the stack.
  if (depth > MAX_CST_DEPTH) return;
  const insideTest = inTest || node.type === TEST_DECL;
  // A `++` operand is a FRAGMENT, never a statement of its own: `"select " ++ name` yields no
  // SQL at all rather than the half-statement `"select "`.
  const insideConcat =
    inConcat || (node.type === BINARY_EXPRESSION && node.childForFieldName?.('operator')?.text === '++');

  if (node.type === BUILTIN_FUNCTION) {
    const name = builtinName(node);
    if (name === '@import') collectImport(node, walk, insideTest);
    if (name === '@cImport') {
      collectCImport(node, walk, insideTest);
      // Its `@cInclude`s are consumed above; recursing would double-record them.
      return;
    }
  }
  if (node.type === VARIABLE_DECL) {
    recordLocalName(node, walk);
    recordHttpClientDecl(node, walk);
    recordStringConst(node, walk);
  }

  const text = inConcat ? undefined : sqlText(node);
  if (text !== undefined && insideTest && CREATE_TABLE.test(text) && !isDecoyDdl(node)) {
    // A table only a `test` block creates is not part of the schema, but an op on it in a
    // NON-test helper still looks like a real op; record the name so the lane can drop it.
    for (const draft of parseCreateTables(text)) walk.facts.testOnlyTables.add(draft.tableName);
  }
  if (!insideTest) {
    if (node.type === CALL_EXPRESSION) collectCallSite(node, walk);
    if (text !== undefined && (SQL_VERB.test(text) || CREATE_TABLE.test(text))) collectSqlString(node, text, walk);
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) sweep(child, walk, insideTest, insideConcat, depth + 1);
  }
}

/** The declaration an import builtin is the head of, plus the members selected off it. */
function importContext(builtin: TsNode): { decl?: TsNode; members: string[] } {
  const members: string[] = [];
  let node = builtin;
  let parent = node.parent;
  while (
    parent?.type === FIELD_EXPRESSION &&
    rangeKey(parent.childForFieldName?.('object') ?? parent) === rangeKey(node)
  ) {
    const member = parent.childForFieldName?.('member');
    if (member) members.push(member.text as string);
    node = parent;
    parent = node.parent;
  }
  return { decl: parent?.type === VARIABLE_DECL ? parent : undefined, members };
}

/**
 * Whether a declaration binds its name at FILE scope: no enclosing `fn` (a container body is not
 * one) and not inside a `test` block. A function-local or test-local binding is lexical to that
 * body alone, so it must stay out of the file's import table (BR-9).
 */
function bindsFileScope(decl: TsNode | undefined, inTest: boolean): boolean {
  return decl !== undefined && !inTest && enclosingFunctionDecl(decl) === undefined;
}

function collectImport(builtin: TsNode, walk: Walk, inTest: boolean): void {
  const spec = builtinStringArg(builtin);
  // A computed spec (`@import(name)`) names no file we could resolve: record nothing.
  if (spec === undefined) return;
  const { decl, members } = importContext(builtin);
  walk.facts.imports.push({
    spec,
    localName: decl ? declName(decl) : undefined,
    members,
    isPub: decl ? hasModifier(decl, 'pub') : false,
    kind: 'import',
    bindsFileScope: bindsFileScope(decl, inTest),
    node: builtin,
    location: locationOf(builtin, walk.relPath),
  });
}

/** `@cImport({ @cInclude("h.h"); })` → one external binding per header (BR-9). */
function collectCImport(builtin: TsNode, walk: Walk, inTest: boolean): void {
  const { decl } = importContext(builtin);
  const localName = decl ? declName(decl) : undefined;
  const isPub = decl ? hasModifier(decl, 'pub') : false;
  const fileScope = bindsFileScope(decl, inTest);
  const visit = (node: TsNode): void => {
    if (node.type === BUILTIN_FUNCTION && builtinName(node) === '@cInclude') {
      const spec = builtinStringArg(node);
      if (spec !== undefined) {
        walk.facts.imports.push({
          spec,
          localName,
          members: [],
          isPub,
          kind: 'cinclude',
          bindsFileScope: fileScope,
          node,
          location: locationOf(node, walk.relPath),
        });
      }
      return;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  };
  visit(builtin);
}

function collectCallSite(call: TsNode, walk: Walk): void {
  const callee = calleeOf(call);
  if (!callee || callee.type === BUILTIN_FUNCTION) return;
  // A builtin-headed callee (`@import("x").f()`) is not a call this substrate can attribute;
  // `@This()` is the exception the `zig-self` tier reads (BR-12).
  const head = headBuiltin(callee);
  if (head && builtinName(head) !== '@This') return;

  const fnNode = enclosingFunctionDecl(call);
  if (!fnNode) return;
  const caller = walk.emittedFns.get(rangeKey(fnNode));
  if (!caller) return;

  walk.facts.callSites.push({
    callerId: caller.fn.id,
    callerOwnerQualifiedName: caller.ownerQualifiedName,
    node: call,
    callee,
    chain: memberChain(callee),
    arguments: callArguments(call).map((arg) => (arg.text as string).slice(0, 200)),
    location: locationOf(call, walk.relPath),
  });
}

/** The call a literal is a DIRECT argument of, and the last chain member of that call's callee. */
function callArgumentContext(node: TsNode): { call?: TsNode; asCallArgument: boolean; calleeMethod?: string } {
  const parent = node.parent?.type === 'arguments' ? node.parent.parent : undefined;
  const call = parent?.type === CALL_EXPRESSION ? parent : undefined;
  const callee = call ? calleeOf(call) : undefined;
  return { call, asCallArgument: call !== undefined, calleeMethod: callee ? memberChain(callee)?.at(-1) : undefined };
}

/**
 * A `create table …` literal handed straight to a method that does NOT execute SQL —
 * `log.info("create table decoy (id int)", .{})`, `std.debug.print(…)`. It describes no schema,
 * so it is neither an entity nor evidence that a table is test-only (BR-15).
 */
function isDecoyDdl(node: TsNode): boolean {
  const { asCallArgument, calleeMethod } = callArgumentContext(node);
  return asCallArgument && !DEFAULT_EXEC_METHODS.has(calleeMethod ?? '');
}

function collectSqlString(node: TsNode, text: string, walk: Walk): void {
  const fnNode = enclosingFunctionDecl(node);
  const caller = fnNode ? walk.emittedFns.get(rangeKey(fnNode)) : undefined;
  const { call, asCallArgument, calleeMethod } = callArgumentContext(node);
  const boundLocal =
    call && calleeMethod !== undefined && SQL_FORMATTER_METHODS.has(calleeMethod)
      ? formatterBoundLocal(call)
      : undefined;
  walk.facts.sqlStrings.push({
    text,
    node,
    callerId: caller?.fn.id,
    asCallArgument,
    calleeMethod,
    ...(boundLocal !== undefined ? { boundLocal } : {}),
    location: locationOf(node, walk.relPath),
  });
}

/**
 * The name a formatter call's result is DIRECTLY bound to (`const sql = try std.fmt.bufPrint(…)`),
 * `try` wrappers unwrapped. Undefined for anything else — a formatter call that is an argument,
 * a field assignment, or a binding whose value merely CONTAINS the call.
 */
function formatterBoundLocal(call: TsNode): string | undefined {
  for (let node = call.parent; node; node = node.parent) {
    if (node.type === TRY_EXPRESSION) continue;
    if (node.type !== VARIABLE_DECL) return undefined;
    const value = declValue(node);
    return value && rangeKey(unwrapTry(value)) === rangeKey(call) ? declName(node) : undefined;
  }
  return undefined;
}

/**
 * Every `variable_declaration` inside an emitted function, however deeply nested, is a LEXICAL
 * BINDING of that function: `const util = @import("b.zig")`, `const url = try build(…)`, a
 * shadowing `const client = …`. The tiers consult this set to drop a name the file table would
 * otherwise resolve to something the source never meant (BR-12).
 */
function recordLocalName(decl: TsNode, walk: Walk): void {
  const name = declName(decl);
  if (!name || name === '_') return;
  const fnNode = enclosingFunctionDecl(decl);
  const caller = fnNode ? walk.emittedFns.get(rangeKey(fnNode)) : undefined;
  if (caller) walk.facts.localsByCaller.get(caller.fn.id)?.add(name);
}

/**
 * BR-14a: a binding whose annotation OR initializer names `std.http.Client`, keyed by the
 * SCOPE it is visible in — `<enclosing function id>:<name>`, or `:<name>` at file scope. A
 * bare name would make one function's `client` type every other function's `client`.
 */
function recordHttpClientDecl(decl: TsNode, walk: Walk): void {
  const name = declName(decl);
  if (!name || name === '_') return;
  const annotation = decl.childForFieldName?.('type')?.text as string | undefined;
  const value = declValue(decl);
  if (namesHttpClient(annotation) || namesHttpClient(value?.text as string | undefined)) {
    const fnNode = enclosingFunctionDecl(decl);
    const caller = fnNode ? walk.emittedFns.get(rangeKey(fnNode)) : undefined;
    walk.facts.httpClientDecls.set(`${caller?.fn.id ?? ''}:${name}`, 'local');
  }
}

/**
 * A `const`/`var` bound to a plain string (or a `++` chain of them), keyed by its visible scope
 * — the raw material for the egress lane's one-hop URL fold (BR-14).
 */
function recordStringConst(decl: TsNode, walk: Walk): void {
  const name = declName(decl);
  if (!name || name === '_') return;
  const text = stringConstText(declValue(decl));
  if (text === undefined) return;
  const fnNode = enclosingFunctionDecl(decl);
  const caller = fnNode ? walk.emittedFns.get(rangeKey(fnNode)) : undefined;
  const key = `${caller?.fn.id ?? ''}:${name}`;
  // First wins, like every other binding in this walk (BR-4).
  if (!walk.facts.stringConstDecls.has(key)) walk.facts.stringConstDecls.set(key, text);
}
