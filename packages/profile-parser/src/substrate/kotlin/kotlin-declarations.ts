/**
 * ONE walk per Kotlin file producing `KotlinFileFacts`. Every later lane (calls, egress,
 * entities, db operations, entrypoints, components) consumes these facts and MUST NOT re-walk
 * the tree: a second walk is a second chance to disagree with this one.
 *
 * Emission rules are §Declarations of the spec. The ones that fail silently when guessed:
 *   - A function is FILE-LEVEL only when its parent is `source_file`. The grammar produces a
 *     spurious `lambda_literal` for `fun interface`, and its member would otherwise be emitted
 *     as a top-level function that does not exist.
 *   - Companion and object members are STATIC members of the enclosing class; no `Companion`
 *     and no file-facade class is synthesised.
 *   - An `enum class` with members emits an `EnumNode` AND a `ClassNode` facet, so every
 *     `method.classId` resolves; an `interface` with functions likewise.
 *   - Calls inside anonymous `object : X { }` bodies and lambdas belong to the nearest
 *     ENCLOSING EMITTED function, not to nothing.
 *   - Every id flows through `StableIdGenerator`; no id string is hand-built.
 */
import type { StableIdGenerator } from '@coredoc/core';
import type {
  ClassNode,
  DecoratorInfo,
  EnumNode,
  FunctionNode,
  InterfaceMember,
  InterfaceNode,
  PropertyNode,
  SourceLocation,
  TypeAliasNode,
  TypeReference,
  VariableNode,
} from '@coredoc/core/types';
import {
  ANNOTATION,
  CALL_EXPRESSION,
  CLASS_DECL,
  MAX_CST_DEPTH,
  MAX_EXPRESSION_DEPTH,
  COMPANION_OBJECT,
  ENUM_ENTRY,
  FUNCTION_DECL,
  IMPORT_HEADER,
  IMPORT_ALIAS,
  IDENTIFIER,
  OBJECT_DECL,
  OBJECT_LITERAL,
  PACKAGE_HEADER,
  PROPERTY_DECL,
  SIMPLE_IDENTIFIER,
  SOURCE_FILE,
  STRING_LITERAL,
  TYPE_ALIAS,
  TYPE_IDENTIFIER,
  annotationName,
  annotationsOf,
  bodyOf,
  callArgs,
  calleeName,
  calleeText,
  constructorProperties,
  declKind,
  declName,
  delegationSpecifiers,
  docComment,
  firstChildOfType,
  functionName,
  hasModifier,
  hasSyntaxError,
  locationOf,
  modifierTexts,
  namedChildren,
  namedChildrenOfType,
  parameterFacts,
  propertyFacts,
  receiverTypeOf,
  returnTypeOf,
  stringValue,
  trailingLambda,
  typeArgs,
  typeName,
  type DelegationSpecifier,
  type KotlinDeclKind,
  type TsNode,
} from './kotlin-cst.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

/** One parsed file, kept only until the last lane has run. */
export interface KotlinFile {
  relPath: string;
  source: string;
  root: TsNode;
}

/** Parse one file's source into a `KotlinFile`. */
export async function toKotlinFile(relPath: string, source: string): Promise<KotlinFile> {
  return { relPath, source, root: await parseSource('kotlin', source) };
}

/** A type declaration in the FQCN index. */
export interface KotlinTypeDecl {
  /** `<package>.<Outer>.<Inner>` — the join key of the whole substrate. */
  fqcn: string;
  /** Qualified within the file: `Outer.Inner`. */
  qualifiedName: string;
  simpleName: string;
  kind: KotlinDeclKind;
  filePath: string;
  /** The `ClassNode` facet id — present for every declaration that can own a method. */
  classId?: string;
  /** The `InterfaceNode` id, for an interface. */
  interfaceId?: string;
  /** The `EnumNode` id, for an enum. */
  enumId?: string;
  supertypes: DelegationSpecifier[];
  /** Annotation simple names on the declaration. */
  annotations: string[];
  /** Method simple name → emitted `FunctionNode` id, for this declaration's own members. */
  methodsByName: Map<string, string>;
  /** Static (companion / object) member names → id, on the enclosing class. */
  staticMethodsByName: Map<string, string>;
  /** Declared property name → declared type simple name, when written. */
  propertyTypes: Map<string, string>;
  /** Declared property name → the Koin accessor and its explicit type, when delegated. */
  diProperties: Map<string, { accessor: string; typeName?: string }>;
  location: SourceLocation;
  node: TsNode;
}

/** An `import a.b.C` / `import a.b.*` statement. */
export interface KotlinImport {
  /** The dotted identifier as written, without the alias. */
  path: string;
  /** The last segment, or the alias when one is written. */
  localName: string;
  alias?: string;
  isWildcard: boolean;
  location: SourceLocation;
}

/** A call site, with the emitted function it belongs to. */
export interface KotlinCallSite {
  node: TsNode;
  /** Final member name (`a.b.c()` → `c`). */
  name: string;
  /** Dotted callee text when every hop is a plain name, else undefined. */
  calleeText?: string;
  /** `true` when the callee is a navigation chain (`x.m()`), `false` for a bare `m()`. */
  isMethodCall: boolean;
  /** Receiver expression text of a method call (`x` in `x.m()`). */
  receiverText?: string;
  /** Simple name of the receiver when it is a single identifier. */
  receiverName?: string;
  /** Explicit type-argument simple names (`get<T>()` → `['T']`). */
  typeArgNames: string[];
  /** Argument nodes, read through the outer-node unwrap. */
  args: TsNode[];
  /** The `FunctionNode` id of the nearest enclosing EMITTED function. */
  enclosingFunctionId: string;
  /** The FQCN of the class owning that function, when it has one. */
  enclosingClassFqcn?: string;
  location: SourceLocation;
}

/** A string literal, for SQL/route/path lanes that need the literal set without a re-walk. */
export interface KotlinStringLiteral {
  value: string;
  node: TsNode;
  location: SourceLocation;
}

/** A local binding inside an emitted function: `val x: T = …` or `val x = T(...)`. */
export interface KotlinLocalBinding {
  name: string;
  /** Declared or inferred-from-constructor type simple name. */
  typeName?: string;
  /** The Koin accessor when the binding comes from one. */
  diAccessor?: string;
  enclosingFunctionId: string;
}

/** A Koin module binding: `single<I> { Impl() }`, `factory { Impl() } bind I::class`, … */
export interface KotlinKoinBinding {
  /** The binding builder name (`single`, `factory`, `viewModel`, `scoped`). */
  builder: string;
  /** Explicit type argument, when written. */
  declaredType?: string;
  /** The constructed implementation type in the trailing lambda, when there is one. */
  implType?: string;
  /** `named("api")` qualifier value, when the binding carries one. */
  qualifier?: string;
  location: SourceLocation;
}

/** A `…create(X::class.java)` site — the Retrofit base-path join. */
export interface KotlinCreateSite {
  /** The type named in the `create` argument (`X` in `X::class.java`), when written literally. */
  targetType?: string;
  node: TsNode;
  enclosingFunctionId?: string;
  location: SourceLocation;
}

/** Everything one walk of one file produces. No lane re-walks the tree. */
export interface KotlinFileFacts {
  relPath: string;
  fileId: string;
  /** The `package_header` value, `''` for the root package. */
  packageName: string;
  /** Whether the tree contains an `ERROR` node (MISSING nodes excluded by construction). */
  hasSyntaxError: boolean;
  /** FQCN → declaration, for every type declared in this file. */
  declarations: Map<string, KotlinTypeDecl>;
  imports: KotlinImport[];
  classes: ClassNode[];
  interfaces: InterfaceNode[];
  enums: EnumNode[];
  functions: FunctionNode[];
  variables: VariableNode[];
  typeAliases: TypeAliasNode[];
  /** Annotation simple name → the nodes carrying it, anywhere in the file. */
  annotationIndex: Map<string, TsNode[]>;
  calls: KotlinCallSite[];
  strings: KotlinStringLiteral[];
  localBindings: KotlinLocalBinding[];
  koinBindings: KotlinKoinBinding[];
  createSites: KotlinCreateSite[];
}

/**
 * Per-file lookups for the lanes that type a receiver by name. Both the db-op and the egress
 * lane used to `.find` over `localBindings`/`functions` at every call site, which is
 * O(sites x bindings) per file; the maps are built once and answer in O(1).
 *
 * FIRST-WINS on a repeated `(enclosingFunctionId, name)`, exactly as `.find` was.
 */
export interface KotlinFileLookup {
  /** Enclosing function id → binding name → the binding declared in that function. */
  localsByFunction: ReadonlyMap<string, ReadonlyMap<string, KotlinLocalBinding>>;
  functionsById: ReadonlyMap<string, FunctionNode>;
}

export function indexKotlinFile(facts: KotlinFileFacts): KotlinFileLookup {
  const localsByFunction = new Map<string, Map<string, KotlinLocalBinding>>();
  for (const binding of facts.localBindings) {
    let byName = localsByFunction.get(binding.enclosingFunctionId);
    if (!byName) {
      byName = new Map();
      localsByFunction.set(binding.enclosingFunctionId, byName);
    }
    if (!byName.has(binding.name)) byName.set(binding.name, binding);
  }
  const functionsById = new Map<string, FunctionNode>();
  for (const fn of facts.functions) if (!functionsById.has(fn.id)) functionsById.set(fn.id, fn);
  return { localsByFunction, functionsById };
}

/** Koin accessors whose result is an instance of their type argument or declared type. */
export const DEFAULT_KOIN_ACCESSORS = ['get', 'inject', 'viewModel', 'activityViewModel', 'sharedViewModel'] as const;

/** Koin module builders whose trailing lambda constructs the bound implementation. */
const KOIN_BUILDERS: ReadonlySet<string> = new Set(['single', 'factory', 'scoped', 'viewModel', 'worker']);

/** Stdlib scope functions: never call candidates (§Calls). */
export const SCOPE_FUNCTIONS: ReadonlySet<string> = new Set([
  'let',
  'run',
  'apply',
  'also',
  'with',
  'takeIf',
  'takeUnless',
  'repeat',
]);

interface Walk {
  relPath: string;
  idGen: StableIdGenerator;
  facts: KotlinFileFacts;
  koinAccessors: ReadonlySet<string>;
  /** First-wins: a second declaration minting the same id is dropped. */
  seen: Set<string>;
}

export interface KotlinFactsOptions {
  /** Profile-configured Koin accessors; defaults to `DEFAULT_KOIN_ACCESSORS`. */
  koinAccessors?: readonly string[];
}

function visibilityOf(node: TsNode): 'public' | 'private' | 'protected' {
  const mods = modifierTexts(node);
  if (mods.includes('private')) return 'private';
  if (mods.includes('protected')) return 'protected';
  return 'public';
}

function decoratorsOf(node: TsNode): DecoratorInfo[] | undefined {
  const anns = annotationsOf(node);
  if (anns.length === 0) return undefined;
  const out: DecoratorInfo[] = [];
  for (const ann of anns) {
    const name = annotationName(ann);
    if (name) out.push({ name, expression: ann.text as string });
  }
  return out.length > 0 ? out : undefined;
}

function typeRef(name: string): TypeReference {
  return { name };
}

/** Register an id once; a later declaration producing the same id is dropped (overload rule). */
function claim(walk: Walk, id: string): boolean {
  if (walk.seen.has(id)) return false;
  walk.seen.add(id);
  return true;
}

function indexAnnotations(walk: Walk, node: TsNode): void {
  for (const ann of annotationsOf(node)) {
    const name = annotationName(ann);
    if (!name) continue;
    const list = walk.facts.annotationIndex.get(name);
    if (list) list.push(node);
    else walk.facts.annotationIndex.set(name, [node]);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Walk one parsed Kotlin file once and return everything the lanes need. */
export function extractKotlinFileFacts(
  file: KotlinFile,
  idGen: StableIdGenerator,
  opts: KotlinFactsOptions = {},
): KotlinFileFacts {
  const packageHeader = firstChildOfType(file.root, PACKAGE_HEADER);
  const packageName = packageHeader ? ((firstChildOfType(packageHeader, IDENTIFIER)?.text as string) ?? '') : '';
  const facts: KotlinFileFacts = {
    relPath: file.relPath,
    fileId: idGen.fileId(file.relPath),
    packageName,
    hasSyntaxError: hasSyntaxError(file.root),
    declarations: new Map(),
    imports: [],
    classes: [],
    interfaces: [],
    enums: [],
    functions: [],
    variables: [],
    typeAliases: [],
    annotationIndex: new Map(),
    calls: [],
    strings: [],
    localBindings: [],
    koinBindings: [],
    createSites: [],
  };
  const walk: Walk = {
    relPath: file.relPath,
    idGen,
    facts,
    koinAccessors: new Set(opts.koinAccessors ?? DEFAULT_KOIN_ACCESSORS),
    seen: new Set(),
  };

  collectImports(walk, file.root);
  for (const child of namedChildren(file.root)) {
    visitTopLevel(walk, child);
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function collectImports(walk: Walk, root: TsNode): void {
  const list = firstChildOfType(root, 'import_list');
  if (!list) return;
  const seen = new Set<string>();
  for (const header of namedChildrenOfType(list, IMPORT_HEADER)) {
    const identifier = firstChildOfType(header, IDENTIFIER);
    if (!identifier) continue;
    const path = identifier.text as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const aliasNode = firstChildOfType(header, IMPORT_ALIAS);
    const alias = aliasNode ? (firstChildOfType(aliasNode, TYPE_IDENTIFIER)?.text as string | undefined) : undefined;
    const isWildcard = (header.text as string).trimEnd().endsWith('*');
    const segments = path.split('.');
    walk.facts.imports.push({
      path,
      localName: alias ?? (isWildcard ? '*' : segments[segments.length - 1]),
      alias,
      isWildcard,
      location: locationOf(header, walk.relPath),
    });
  }
}

// ---------------------------------------------------------------------------
// Top-level declarations
// ---------------------------------------------------------------------------

function visitTopLevel(walk: Walk, node: TsNode): void {
  switch (node.type) {
    case CLASS_DECL:
    case OBJECT_DECL:
      visitTypeDecl(walk, node, undefined);
      return;
    case FUNCTION_DECL:
      // A function is file-level ONLY when its parent is `source_file`: the spurious
      // `lambda_literal` the grammar produces for `fun interface` must not emit one.
      if (node.parent?.type === SOURCE_FILE) emitFileFunction(walk, node);
      return;
    case PROPERTY_DECL:
      emitFileProperty(walk, node);
      return;
    case TYPE_ALIAS:
      emitTypeAlias(walk, node);
      return;
    default:
      return;
  }
}

function emitTypeAlias(walk: Walk, node: TsNode): void {
  const name = declName(node);
  if (!name) return;
  const id = walk.idGen.typeAliasId(walk.relPath, name);
  if (!claim(walk, id)) return;
  const aliased = namedChildren(node).find((c) => c.type !== TYPE_IDENTIFIER);
  walk.facts.typeAliases.push({
    kind: 'type-alias',
    id,
    versionedId: walk.idGen.versionedId(id, node.text as string),
    name,
    fileId: walk.facts.fileId,
    isExported: visibilityOf(node) !== 'private',
    aliasedType: { text: (aliased?.text as string) ?? 'Any' },
    location: locationOf(node, walk.relPath),
    documentation: docComment(node),
  });
}

function emitFileProperty(walk: Walk, node: TsNode): void {
  const facts = propertyFacts(node);
  if (!facts) return;
  const id = walk.idGen.variableId(walk.relPath, facts.name);
  if (!claim(walk, id)) return;
  indexAnnotations(walk, node);
  walk.facts.variables.push({
    kind: 'variable',
    id,
    versionedId: walk.idGen.versionedId(id, node.text as string),
    name: facts.name,
    fileId: walk.facts.fileId,
    isExported: visibilityOf(node) !== 'private',
    declarationKind: facts.isReadonly ? 'const' : 'var',
    type: facts.typeName ? { text: facts.typeName } : undefined,
    initialValue: facts.initializer ? (facts.initializer.text as string) : undefined,
    location: locationOf(node, walk.relPath),
    documentation: docComment(node),
  });
  // A file-level property initializer/delegate can still contain calls and literals.
  const expr = facts.delegate ?? facts.initializer;
  if (expr) collectExpressions(walk, expr, undefined, undefined);
}

// ---------------------------------------------------------------------------
// Type declarations
// ---------------------------------------------------------------------------

function qualify(parentQualified: string | undefined, simple: string): string {
  return parentQualified ? `${parentQualified}.${simple}` : simple;
}

function fqcnOf(packageName: string, qualified: string): string {
  return packageName ? `${packageName}.${qualified}` : qualified;
}

function visitTypeDecl(walk: Walk, node: TsNode, parentQualified: string | undefined): void {
  const simpleName = declName(node);
  if (!simpleName) return;
  const kind = declKind(node);
  const qualifiedName = qualify(parentQualified, simpleName);
  const fqcn = fqcnOf(walk.facts.packageName, qualifiedName);
  const body = bodyOf(node);
  const supertypes = delegationSpecifiers(node);
  indexAnnotations(walk, node);

  const decl: KotlinTypeDecl = {
    fqcn,
    qualifiedName,
    simpleName,
    kind,
    filePath: walk.relPath,
    supertypes,
    annotations: annotationsOf(node)
      .map(annotationName)
      .filter((n): n is string => !!n),
    methodsByName: new Map(),
    staticMethodsByName: new Map(),
    propertyTypes: new Map(),
    diProperties: new Map(),
    location: locationOf(node, walk.relPath),
    node,
  };

  const memberFns = body ? namedChildrenOfType(body, FUNCTION_DECL) : [];
  const memberProps = body ? namedChildrenOfType(body, PROPERTY_DECL) : [];
  const companions = body ? namedChildrenOfType(body, COMPANION_OBJECT) : [];

  // A ClassNode FACET exists for every declaration that owns members, so `method.classId`
  // always resolves — including for an enum and for an interface with functions.
  const ownsMembers =
    kind === 'class' || kind === 'object' || memberFns.length > 0 || memberProps.length > 0 || companions.length > 0;

  const classId = ownsMembers ? walk.idGen.classId(walk.relPath, qualifiedName) : undefined;
  decl.classId = classId;
  walk.facts.declarations.set(fqcn, decl);

  const properties: PropertyNode[] = [];
  if (classId) {
    for (const prop of constructorProperties(node)) {
      decl.propertyTypes.set(prop.name, prop.typeName ?? '');
      properties.push({
        id: walk.idGen.generateNodeId('variable', walk.relPath, `${classId}.${prop.name}`),
        name: prop.name,
        classId,
        visibility: 'public',
        isStatic: false,
        isReadonly: prop.isReadonly,
        isOptional: false,
        type: prop.typeName ? { text: prop.typeName } : undefined,
        location: decl.location,
      });
    }
  }

  // Members: functions, properties, companions, nested types.
  if (body && classId) {
    for (const prop of memberProps) {
      const p = emitMemberProperty(walk, prop, decl, classId, false);
      if (p) properties.push(p);
    }
    for (const fn of memberFns) {
      emitMethod(walk, fn, decl, classId, false);
    }
    for (const companion of companions) {
      // Companion members are STATIC members of the enclosing class; no `Companion` node.
      const companionBody = bodyOf(companion);
      if (!companionBody) continue;
      for (const prop of namedChildrenOfType(companionBody, PROPERTY_DECL)) {
        const p = emitMemberProperty(walk, prop, decl, classId, true);
        if (p) properties.push(p);
      }
      for (const fn of namedChildrenOfType(companionBody, FUNCTION_DECL)) {
        emitMethod(walk, fn, decl, classId, true);
      }
    }
  }

  // Emit the node(s) for this declaration.
  if (kind === 'enum') {
    emitEnum(walk, node, decl, body);
  }
  if (kind === 'interface') {
    emitInterface(walk, node, decl, memberFns, memberProps);
  }
  if (classId) {
    const extendsSpec = supertypes.find((s) => s.relation === 'extends');
    const implementsSpecs = supertypes.filter((s) => s.relation !== 'extends');
    const mods = modifierTexts(node);
    walk.facts.classes.push({
      kind: 'class',
      id: classId,
      versionedId: walk.idGen.versionedId(classId, node.text as string),
      name: qualifiedName,
      fileId: walk.facts.fileId,
      isExported: visibilityOf(node) !== 'private',
      isAbstract: mods.includes('abstract') || mods.includes('sealed') || kind === 'interface',
      extends: extendsSpec ? typeRef(extendsSpec.name) : undefined,
      implements: implementsSpecs.length > 0 ? implementsSpecs.map((s) => typeRef(s.name)) : undefined,
      decorators: decoratorsOf(node),
      methods: [...decl.methodsByName.values(), ...decl.staticMethodsByName.values()],
      properties,
      // Kotlin's primary constructor surfaces as class properties, not as a ConstructorNode.
      constructor: undefined,
      location: decl.location,
      documentation: docComment(node),
    });
  }

  // Nested types, after the parent is registered so the FQCN index reads parent-first.
  if (body) {
    for (const child of namedChildren(body)) {
      if (child.type === CLASS_DECL || child.type === OBJECT_DECL) {
        visitTypeDecl(walk, child, qualifiedName);
      }
    }
  }
}

function emitEnum(walk: Walk, node: TsNode, decl: KotlinTypeDecl, body: TsNode | undefined): void {
  const id = walk.idGen.enumId(walk.relPath, decl.qualifiedName);
  if (!claim(walk, id)) return;
  decl.enumId = id;
  walk.facts.enums.push({
    kind: 'enum',
    id,
    versionedId: walk.idGen.versionedId(id, node.text as string),
    name: decl.qualifiedName,
    fileId: walk.facts.fileId,
    isExported: visibilityOf(node) !== 'private',
    isConst: true,
    members: body
      ? namedChildrenOfType(body, ENUM_ENTRY).map((entry) => ({
          name: (firstChildOfType(entry, SIMPLE_IDENTIFIER)?.text as string) ?? (entry.text as string),
        }))
      : [],
    location: decl.location,
    documentation: docComment(node),
  });
}

function emitInterface(
  walk: Walk,
  node: TsNode,
  decl: KotlinTypeDecl,
  memberFns: TsNode[],
  memberProps: TsNode[],
): void {
  const id = walk.idGen.interfaceId(walk.relPath, decl.qualifiedName);
  if (!claim(walk, id)) return;
  decl.interfaceId = id;
  const members: InterfaceMember[] = [];
  for (const fn of memberFns) {
    const name = functionName(fn);
    if (!name) continue;
    members.push({
      name,
      kind: 'method',
      isOptional: false,
      isReadonly: false,
      parameters: parameterFacts(fn).map((p) => ({
        name: p.name,
        type: p.typeName ? { text: p.typeName } : undefined,
        isOptional: false,
        isRest: false,
      })),
      returnType: typeName(returnTypeOf(fn)) ? { text: typeName(returnTypeOf(fn)) as string } : undefined,
      location: locationOf(fn, walk.relPath),
      documentation: docComment(fn),
    });
  }
  for (const prop of memberProps) {
    const facts = propertyFacts(prop);
    if (!facts) continue;
    members.push({
      name: facts.name,
      kind: 'property',
      isOptional: false,
      isReadonly: facts.isReadonly,
      type: facts.typeName ? { text: facts.typeName } : undefined,
      location: locationOf(prop, walk.relPath),
    });
  }
  walk.facts.interfaces.push({
    kind: 'interface',
    id,
    versionedId: walk.idGen.versionedId(id, node.text as string),
    name: decl.qualifiedName,
    fileId: walk.facts.fileId,
    isExported: visibilityOf(node) !== 'private',
    extends: decl.supertypes.length > 0 ? decl.supertypes.map((s) => typeRef(s.name)) : undefined,
    members,
    location: decl.location,
    documentation: docComment(node),
  });
}

function emitMemberProperty(
  walk: Walk,
  node: TsNode,
  decl: KotlinTypeDecl,
  classId: string,
  isStatic: boolean,
): PropertyNode | undefined {
  const facts = propertyFacts(node);
  if (!facts) return undefined;
  indexAnnotations(walk, node);
  if (facts.typeName) decl.propertyTypes.set(facts.name, facts.typeName);

  // `by inject()` / `by viewModel<T>()` / `= get<T>()`: the DI accessor types the receiver.
  const expr = facts.delegate ?? facts.initializer;
  if (expr?.type === CALL_EXPRESSION) {
    const accessor = calleeName(expr);
    if (accessor && walk.koinAccessors.has(accessor)) {
      const explicit = typeArgs(expr)
        .map(typeName)
        .find((t): t is string => !!t);
      decl.diProperties.set(facts.name, { accessor, typeName: explicit ?? facts.typeName });
      if (!facts.typeName && explicit) decl.propertyTypes.set(facts.name, explicit);
    }
  }
  if (expr) collectExpressions(walk, expr, undefined, decl.fqcn);

  return {
    id: walk.idGen.generateNodeId('variable', walk.relPath, `${classId}.${facts.name}`),
    name: facts.name,
    classId,
    visibility: visibilityOf(node),
    isStatic,
    isReadonly: facts.isReadonly,
    isOptional: false,
    type: facts.typeName ? { text: facts.typeName } : undefined,
    defaultValue: facts.initializer ? (facts.initializer.text as string) : undefined,
    decorators: decoratorsOf(node),
    location: locationOf(node, walk.relPath),
    documentation: docComment(node),
  };
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

function parametersOf(fn: TsNode) {
  return parameterFacts(fn).map((p) => ({
    name: p.name,
    type: p.typeName ? { text: p.typeName } : undefined,
    isOptional: false,
    isRest: false,
    decorators:
      p.annotations.length > 0
        ? p.annotations
            .map((a) => {
              const name = annotationName(a);
              return name ? { name, expression: a.text as string } : undefined;
            })
            .filter((d): d is DecoratorInfo => !!d)
        : undefined,
  }));
}

function emitFileFunction(walk: Walk, fn: TsNode): void {
  const simple = functionName(fn);
  if (!simple) return;
  const receiver = typeName(receiverTypeOf(fn));
  const name = receiver ? `${receiver}.${simple}` : simple;
  const id = walk.idGen.functionId(walk.relPath, name);
  if (!claim(walk, id)) return; // overloads: first in source order wins
  indexAnnotations(walk, fn);
  const returnType = typeName(returnTypeOf(fn));
  walk.facts.functions.push({
    kind: 'function',
    id,
    versionedId: walk.idGen.versionedId(id, fn.text as string),
    name,
    fileId: walk.facts.fileId,
    // Cap at 20000 chars to guard against pathological bodies bloating output (matches the TS/Ruby/Swift paths).
    sourceCode: (fn.text as string).slice(0, 20000),
    isAsync: hasModifier(fn, 'suspend'),
    isGenerator: false,
    isExported: visibilityOf(fn) !== 'private',
    parameters: parametersOf(fn),
    returnType: returnType ? { text: returnType } : undefined,
    decorators: decoratorsOf(fn),
    location: locationOf(fn, walk.relPath),
    documentation: docComment(fn),
  });
  collectBody(walk, fn, id, undefined);
}

function emitMethod(walk: Walk, fn: TsNode, decl: KotlinTypeDecl, classId: string, isStatic: boolean): void {
  const simple = functionName(fn);
  if (!simple) return;
  const id = walk.idGen.methodId(walk.relPath, decl.qualifiedName, simple);
  if (!claim(walk, id)) return;
  indexAnnotations(walk, fn);
  const returnType = typeName(returnTypeOf(fn));
  walk.facts.functions.push({
    kind: 'method',
    id,
    versionedId: walk.idGen.versionedId(id, fn.text as string),
    name: simple,
    fileId: walk.facts.fileId,
    classId,
    // Cap at 20000 chars to guard against pathological bodies bloating output (matches the TS/Ruby/Swift paths).
    sourceCode: (fn.text as string).slice(0, 20000),
    isAsync: hasModifier(fn, 'suspend'),
    isGenerator: false,
    isStatic,
    visibility: visibilityOf(fn),
    parameters: parametersOf(fn),
    returnType: returnType ? { text: returnType } : undefined,
    decorators: decoratorsOf(fn),
    location: locationOf(fn, walk.relPath),
    documentation: docComment(fn),
  });
  if (isStatic) decl.staticMethodsByName.set(simple, id);
  else decl.methodsByName.set(simple, id);
  collectBody(walk, fn, id, decl.fqcn);
}

// ---------------------------------------------------------------------------
// Bodies: calls, literals, local bindings, Koin bindings, create sites
// ---------------------------------------------------------------------------

function collectBody(
  walk: Walk,
  fn: TsNode,
  enclosingFunctionId: string,
  enclosingClassFqcn: string | undefined,
): void {
  const body = firstChildOfType(fn, 'function_body');
  if (!body) return;
  collectExpressions(walk, body, enclosingFunctionId, enclosingClassFqcn);
}

/**
 * Walk an expression subtree, attributing everything to `enclosingFunctionId`.
 *
 * Nested `function_declaration`s (local functions, and members of an anonymous
 * `object : X { }`) are NOT emitted as nodes, but their bodies stay attributed to the nearest
 * enclosing EMITTED function — dropping them would silently depress the call graph.
 */
function collectExpressions(
  walk: Walk,
  node: TsNode,
  enclosingFunctionId: string | undefined,
  enclosingClassFqcn: string | undefined,
  depth = 0,
): void {
  if (depth > MAX_CST_DEPTH) return;
  switch (node.type) {
    case STRING_LITERAL: {
      const value = stringValue(node);
      if (value !== undefined) {
        walk.facts.strings.push({ value, node, location: locationOf(node, walk.relPath) });
      }
      break;
    }
    case ANNOTATION:
      // Annotation arguments are read by their own lanes through the annotation index.
      return;
    case PROPERTY_DECL: {
      if (enclosingFunctionId) recordLocalBinding(walk, node, enclosingFunctionId);
      break;
    }
    case CALL_EXPRESSION: {
      recordCall(walk, node, enclosingFunctionId, enclosingClassFqcn);
      break;
    }
    case OBJECT_LITERAL:
      // Anonymous object: its members are not emitted, its calls belong to the enclosing fn.
      break;
    default:
      break;
  }
  for (const child of namedChildren(node)) {
    collectExpressions(walk, child, enclosingFunctionId, enclosingClassFqcn, depth + 1);
  }
}

function recordLocalBinding(walk: Walk, node: TsNode, enclosingFunctionId: string): void {
  const facts = propertyFacts(node);
  if (!facts) return;
  const expr = facts.delegate ?? facts.initializer;
  let typeText = facts.typeName;
  let diAccessor: string | undefined;
  if (expr?.type === CALL_EXPRESSION) {
    const callee = calleeName(expr);
    if (callee && walk.koinAccessors.has(callee)) {
      diAccessor = callee;
      typeText =
        typeArgs(expr)
          .map(typeName)
          .find((t): t is string => !!t) ?? typeText;
    } else if (!typeText && callee && /^[A-Z]/.test(callee)) {
      // `val x = T(...)`: a constructor call types the binding.
      typeText = callee;
    }
  }
  walk.facts.localBindings.push({
    name: facts.name,
    typeName: typeText,
    diAccessor,
    enclosingFunctionId,
  });
}

function recordCall(
  walk: Walk,
  node: TsNode,
  enclosingFunctionId: string | undefined,
  enclosingClassFqcn: string | undefined,
): void {
  const name = calleeName(node);
  if (!name) return;

  recordKoinBinding(walk, node, name);
  if (name === 'create') recordCreateSite(walk, node, enclosingFunctionId);

  if (!enclosingFunctionId) return;
  const dotted = calleeText(node);
  const isMethodCall = dotted !== undefined ? dotted.includes('.') : true;
  let receiverText: string | undefined;
  let receiverName: string | undefined;
  if (dotted?.includes('.')) {
    receiverText = dotted.slice(0, dotted.lastIndexOf('.'));
    if (!receiverText.includes('.')) receiverName = receiverText;
  }
  walk.facts.calls.push({
    node,
    name,
    calleeText: dotted,
    isMethodCall,
    receiverText,
    receiverName,
    typeArgNames: typeArgs(node)
      .map(typeName)
      .filter((t): t is string => !!t),
    args: callArgs(node),
    enclosingFunctionId,
    enclosingClassFqcn,
    location: locationOf(node, walk.relPath),
  });
}

function recordKoinBinding(walk: Walk, node: TsNode, name: string): void {
  if (!KOIN_BUILDERS.has(name)) return;
  const lambda = trailingLambda(node);
  if (!lambda) return;
  const declaredType = typeArgs(node)
    .map(typeName)
    .find((t): t is string => !!t);
  let qualifier: string | undefined;
  for (const arg of callArgs(node)) {
    const value = namedChildren(arg).find((c) => c.type === CALL_EXPRESSION);
    if (value && calleeName(value) === 'named') {
      qualifier = stringValue(namedChildren(callArgs(value)[0] ?? {}).find((c: TsNode) => c.type === STRING_LITERAL));
    }
  }
  const firstCall = findFirstCall(lambda, 0);
  const implType = firstCall ? calleeName(firstCall) : undefined;
  walk.facts.koinBindings.push({
    builder: name,
    declaredType,
    implType: implType && /^[A-Z]/.test(implType) ? implType : undefined,
    qualifier,
    location: locationOf(node, walk.relPath),
  });
}

function findFirstCall(node: TsNode, depth: number): TsNode | undefined {
  if (depth > MAX_EXPRESSION_DEPTH) return undefined;
  if (node.type === CALL_EXPRESSION) return node;
  for (const child of namedChildren(node)) {
    const hit = findFirstCall(child, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function recordCreateSite(walk: Walk, node: TsNode, enclosingFunctionId: string | undefined): void {
  const [arg] = callArgs(node);
  // `X::class.java` parses as a navigation_expression whose leading identifier is `X`.
  const text = arg ? (arg.text as string) : '';
  const m = /^([A-Za-z_][\w]*)\s*::\s*class/.exec(text);
  walk.facts.createSites.push({
    targetType: m ? m[1] : undefined,
    node,
    enclosingFunctionId,
    location: locationOf(node, walk.relPath),
  });
}
