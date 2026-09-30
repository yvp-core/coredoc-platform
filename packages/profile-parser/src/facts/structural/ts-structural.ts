import { TreeSitterLoader } from '../../tree-sitter/tree-sitter-loader.js';
import type { TypeInfo } from '@coredoc/core/types';
import type { Node as TsNode } from 'web-tree-sitter';
import { parseTypeNode } from './type-annotation.js';

/**
 * Direct children of a `formal_parameters` node that represent a parameter. TypeScript wraps each
 * param in `required_parameter`/`optional_parameter`; JavaScript exposes the binding node directly
 * (a bare `identifier`, an `assignment_pattern` for defaults, a `rest_pattern`, or a destructuring
 * `object_pattern`/`array_pattern`). Filtering on `type.includes('parameter')` alone silently drops
 * every JS parameter.
 */
const PARAM_NODE_TYPES = new Set([
  'required_parameter',
  'optional_parameter',
  'identifier',
  'assignment_pattern',
  'object_pattern',
  'array_pattern',
  'rest_pattern',
]);

export interface StructuralParam {
  name: string;
  type?: string;
  /**
   * Parsed form of the same annotation, carrying the type references it names (including the
   * ones nested in generic arguments, `Proxy<IFoo>` → `Proxy` + `IFoo`). Absent when the param
   * is unannotated or the annotation is a shape `parseTypeNode` deliberately does not model.
   */
  typeInfo?: TypeInfo;
  isOptional: boolean;
  isRest: boolean;
}
export interface StructuralMethod {
  name: string;
  isAsync: boolean;
  isStatic: boolean;
  visibility: 'public' | 'private' | 'protected';
  params: StructuralParam[];
  /** Return-type annotation text (without the leading `: `); undefined when unannotated. */
  returnType?: string;
  /** Leading JSDoc (`/** … *\/`) description, stripped of comment markup; undefined when absent. */
  documentation?: string;
  startLine: number;
  endLine: number;
  decorators: string[];
}
export interface StructuralProperty {
  name: string;
  type?: string;
  /** Parsed form of the same annotation, carrying the type references it names. */
  typeInfo?: TypeInfo;
  isOptional: boolean;
  isStatic: boolean;
  isReadonly: boolean;
  visibility: 'public' | 'private' | 'protected';
  startLine: number;
  endLine: number;
  decorators: string[];
}
export interface StructuralClass {
  name: string;
  isExported: boolean;
  isAbstract: boolean;
  startLine: number;
  endLine: number;
  decorators: string[];
  /** Leading JSDoc (`/** … *\/`) description, stripped of comment markup; undefined when absent. */
  documentation?: string;
  methods: StructuralMethod[];
  properties: StructuralProperty[];
  ctorParams: { name: string; type?: string; visibility?: string }[];
  /**
   * The `extends Base<...>` heritage clause: base-class name + its generic type-arg
   * texts (`extends EntityRepository<Foo>` → { name: 'EntityRepository', typeArgs: ['Foo'] }).
   * Undefined when the class has no `extends` clause. Used by repo-base-class entity
   * resolution to bind a repository's managed entity from its generic type arg.
   */
  extendsClass?: { name: string; typeArgs: string[] };
  /**
   * Names of the interfaces the `implements A, B<T>` clause lists, generic arguments stripped
   * (`implements Repository<Foo>` → `Repository`). A namespace-qualified base keeps its dotted
   * source text (`ns.IBar`) — it names no in-file symbol, so identity resolution refuses it.
   */
  implementsNames: string[];
}
export interface StructuralFunction {
  name: string;
  isAsync: boolean;
  isExported: boolean;
  params: StructuralParam[];
  /** Return-type annotation text (without the leading `: `); undefined when unannotated. */
  returnType?: string;
  /** Leading JSDoc (`/** … *\/`) description, stripped of comment markup; undefined when absent. */
  documentation?: string;
  startLine: number;
  endLine: number;
  decorators: string[];
}
export interface StructuralInterfaceMember {
  name: string;
  kind: 'property' | 'method' | 'index';
  /** Annotated type of a property/index member (undefined for methods). */
  type?: TypeInfo;
  /** Annotated return type of a method member (undefined for properties). */
  returnType?: TypeInfo;
  isOptional: boolean;
  isReadonly: boolean;
  startLine: number;
  endLine: number;
}
export interface StructuralInterface {
  name: string;
  isExported: boolean;
  /** Names of extended interfaces (the `extends A, B` clause). */
  extends: string[];
  members: StructuralInterfaceMember[];
  documentation?: string;
  startLine: number;
  endLine: number;
}
export interface StructuralTypeAlias {
  name: string;
  isExported: boolean;
  /** The aliased type's source text (everything after `=`), undefined when unreadable. */
  aliasedType?: string;
  /** Parsed form of the same type, carrying the type references it names. */
  aliasedTypeInfo?: TypeInfo;
  documentation?: string;
  startLine: number;
  endLine: number;
}
export interface StructuralEnumMember {
  name: string;
  /** String/number member value as source text, undefined for auto-numbered members. */
  value?: string;
}
export interface StructuralEnum {
  name: string;
  isExported: boolean;
  isConst: boolean;
  members: StructuralEnumMember[];
  documentation?: string;
  startLine: number;
  endLine: number;
}
export interface StructuralVariable {
  name: string;
  isExported: boolean;
  declarationKind: 'const' | 'let' | 'var';
  /** Annotated type text (without leading `: `); undefined when unannotated. */
  type?: string;
  /** Initializer source text (if simple), undefined when absent. */
  initialValue?: string;
  documentation?: string;
  startLine: number;
  endLine: number;
}
/**
 * A NON-module-scope `const`/`let`/`var` binding with a plain identifier name and an
 * initializer, plus the line span of the block it is visible in. This is the raw material
 * for the single in-scope hop that argument resolution takes when a call argument is a
 * bare local name (`const topic = …; emit(topic)`); module-scope bindings are not repeated
 * here because the const resolver already reaches them.
 *
 * `initialValue` is the initializer's SOURCE TEXT — nothing is evaluated. Consumers
 * re-apply their own argument mode to it and must not chase a further hop.
 */
export interface StructuralLocalBinding {
  name: string;
  declarationKind: 'const' | 'let' | 'var';
  initialValue: string;
  /** First line of the enclosing block the binding is visible in. */
  scopeStartLine: number;
  /** Last line of that block. */
  scopeEndLine: number;
  /** The name is also the target of an assignment in this file — not statically decidable. */
  reassigned?: boolean;
}
export interface StructuralImport {
  moduleSpecifier: string;
  /**
   * `isTypeOnly` marks an INLINE type specifier (`import { type Foo, Bar }`) — a type-position
   * binding inside an otherwise value import. Absent means a value binding.
   */
  names: { name: string; alias?: string; isTypeOnly?: boolean }[];
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  /** The whole statement is `import type { … }`. */
  isTypeOnly: boolean;
  startLine: number;
}
export interface StructuralCall {
  receiver?: string;
  methodName?: string;
  expressionText: string;
  /** Raw expression-text of each call argument (e.g. `['SHIFTS_JOB', '{ concurrency: 2 }']`). */
  arguments: string[];
  isAwaited: boolean;
  startLine: number;
  endLine: number;
  enclosingName?: string;
  enclosingClass?: string;
  enclosingKind: 'method' | 'function' | 'module';
  /**
   * True when the nearest enclosing function-like node is an object-literal method/property
   * (`{ init: () => {} }` / `{ format(x) {} }`). ts-morph does NOT register these as
   * top-level functions, so external-egress passes that mirror ts-morph's caller set use
   * this to skip them. The call-tree ignores this flag (it keys off enclosingName/-Kind).
   */
  enclosingObjectMethod?: boolean;
}
/**
 * A VALUE-position member access (`Status.Locked`) whose object name is either an enum declared in
 * this file or a name imported into it — i.e. a candidate reference to an extracted enum. This fact
 * records the site, its enclosing scope, and the import the name came from; resolution to the enum
 * node happens downstream.
 *
 * Type-position uses of an enum are NOT here: they travel as type annotations (`parseTypeNode`), and
 * the TS grammar parses them as `nested_type_identifier`, never as `member_expression`.
 */
export interface StructuralEnumMemberRef {
  /** Name the enum is exported under: the import's original name, not its local alias. */
  enumName: string;
  /** Raw specifier of the import that bound the name; absent when declared in this file. */
  importedFrom?: string;
  /** Property identifier as written (`Locked`). */
  member: string;
  startLine: number;
  enclosingName?: string;
  enclosingClass?: string;
  enclosingKind: 'method' | 'function' | 'module';
}
/**
 * A non-annotation USE of a name that can be a class from this file's perspective: a construction
 * site (`new UserService(...)`) or an import clause that binds the name. The candidate records the
 * site, its enclosing scope and the import the name came from; deciding whether the name really is
 * a class (and which one) happens downstream over the module graph.
 *
 * Type-position uses are NOT here — they travel as type annotations.
 */
export interface StructuralClassRef {
  /** Name the class is exported under: the import's original name, not its local alias. */
  className: string;
  /** Which use this is: `new X(...)` versus an import of `X`. */
  refKind: 'construction' | 'import';
  /** Local name the file binds the class under; set only when it differs from `className`. */
  localName?: string;
  /** Raw specifier of the import that bound the name; absent when declared in this file. */
  importedFrom?: string;
  startLine: number;
  enclosingName?: string;
  enclosingClass?: string;
  enclosingKind: 'method' | 'function' | 'module';
}
export interface ValueBinding {
  name: string;
  filePath: string;
  kind: 'literal' | 'object' | 'enum';
  literal?: string; // kind 'literal'
  members?: Record<string, string>; // kind 'object' | 'enum'
  isExported: boolean;
}
export interface ReExport {
  moduleSpecifier: string;
  kind: 'star' | 'named';
  names?: { name: string; alias?: string }[]; // 'named' only; `name` is the source-module export, `alias` is the re-exported-as name
}
/** One name bound by a destructured dynamic import (`const { a: b } = await import('m')`). */
export interface StructuralDynamicImportBinding {
  /** Name exported by the imported module (`a`). */
  exportName: string;
  /** Name it is bound to locally (`b`, or `a` for the shorthand form). */
  localName: string;
  /** 1-based line of the EXPORT-name identifier — the position SCIP records the export ref at. */
  line: number;
  /** 0-based column of the same identifier. */
  column: number;
}
/** A `const { … } = await import('<spec>')` site. */
export interface StructuralDynamicImport {
  /** Literal specifier; undefined when it isn't a plain string (template/computed) — unresolvable. */
  moduleSpecifier?: string;
  bindings: StructuralDynamicImportBinding[];
  startLine: number;
  /** Last line of the declarator — the `import('…')` call can sit below the destructure. */
  endLine: number;
}

export interface StructuralFile {
  path: string;
  language: 'typescript' | 'javascript';
  classes: StructuralClass[];
  functions: StructuralFunction[];
  // Optional so hand-built fixtures/callers that predate type-symbol capture stay valid;
  // parseTsStructural always initializes these to [], so live parse results are never undefined.
  interfaces?: StructuralInterface[];
  typeAliases?: StructuralTypeAlias[];
  enums?: StructuralEnum[];
  variables?: StructuralVariable[];
  /**
   * Function/block-scoped bindings. Optional for the same fixture-compatibility reason as the
   * fields above; parseTsStructural always initializes it to [].
   */
  localBindings?: StructuralLocalBinding[];
  imports: StructuralImport[];
  /**
   * Destructured dynamic imports. Optional for the same fixture-compatibility reason as the
   * fields above; parseTsStructural always initializes it to [].
   */
  dynamicImports?: StructuralDynamicImport[];
  calls: StructuralCall[];
  /**
   * Value-position enum-member accesses. Optional for the same fixture-compatibility reason as the
   * fields above; parseTsStructural always initializes it to [].
   */
  enumMemberRefs?: StructuralEnumMemberRef[];
  /**
   * Construction and import references to class-shaped names. Optional for the same
   * fixture-compatibility reason as the fields above; parseTsStructural always initializes it to [].
   */
  classRefs?: StructuralClassRef[];
  // Optional so hand-built fixtures/callers that predate value-binding capture stay valid;
  // parseTsStructural always initializes it to [], so live parse results are never undefined.
  valueBindings?: ValueBinding[];
  // Optional for the same reason — read only via resolverFromStructuralFiles; parseTsStructural
  // always initializes it to [], so live parse results are never undefined.
  reExports?: ReExport[];
}

function text(n: TsNode | null | undefined): string {
  return n?.text ?? '';
}

/**
 * The base NAME one entry of a heritage clause (`implements A, B<T>`, `extends Y, Z<Q>`) declares.
 * A `generic_type` is peeled to its own identifier so `Z<Q>` reads as `Z` — the type arguments are
 * not part of the base's identity. A `nested_type_identifier` (`ns.IBar`) keeps its dotted text:
 * it is honest about what the source says, and nothing downstream resolves a dotted name.
 */
function heritageBaseName(n: TsNode): string | undefined {
  if (n.type === 'generic_type') {
    const inner = n.namedChildren.find((c) => c.type.includes('identifier'));
    return inner ? text(inner) : undefined;
  }
  return n.type.includes('identifier') ? text(n) || undefined : undefined;
}

/** Options for {@link parseTsStructural}. */
export interface ParseStructuralOptions {
  /**
   * Promote anonymous callbacks passed as a CALL ARGUMENT (`router.get('/x', (req,res) => …)`,
   * `arr.forEach(x => …)`) to citable function nodes, so calls inside them attribute to the
   * callback instead of falling through to module scope (closes the inline-callback recall hole).
   * Default false — keeps golden parity byte-identical until a profile opts in.
   */
  resolveAnonCallbacks?: boolean;
}

/**
 * Parse one TS/JS source into a StructuralFile. Pure tree-sitter — no type info.
 * Call-site enclosing resolution is by walking up to the nearest method/function node.
 */
export async function parseTsStructural(
  path: string,
  source: string,
  language: 'typescript' | 'javascript',
  opts: ParseStructuralOptions = {},
): Promise<StructuralFile> {
  const loader = TreeSitterLoader.getInstance();
  const langName = language === 'typescript' ? (path.endsWith('.tsx') ? 'tsx' : 'typescript') : 'javascript';
  const parser = await loader.getParser(langName);
  const tree = parser.parse(source);
  const root = tree.rootNode;

  // Local non-optional handles: StructuralFile.valueBindings / .reExports are optional (for legacy
  // callers), but parse results always populate them. Push to these arrays, which `file` aliases.
  const valueBindings: ValueBinding[] = [];
  const reExports: ReExport[] = [];
  const file: StructuralFile = {
    path,
    language,
    classes: [],
    functions: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    localBindings: [],
    imports: [],
    dynamicImports: [],
    calls: [],
    enumMemberRefs: [],
    classRefs: [],
    valueBindings,
    reExports,
  };
  // Non-optional handles for the type-symbol arrays (declared optional on the interface for legacy
  // fixtures); parse results always populate them — push to these, which `file` aliases.
  const interfaces = file.interfaces as StructuralInterface[];
  const typeAliases = file.typeAliases as StructuralTypeAlias[];
  const enums = file.enums as StructuralEnum[];
  const variables = file.variables as StructuralVariable[];
  const localBindings = file.localBindings as StructuralLocalBinding[];
  /** Names assigned to after declaration anywhere in this file (`x = …`, `x += …`, `x++`). */
  const assignedNames = new Set<string>();

  const lineOf = (n: TsNode) => n.startPosition.row + 1;
  const endLineOf = (n: TsNode) => n.endPosition.row + 1;
  // Decorators appear in two shapes in the tree-sitter TS/JS grammar: as direct children of a
  // NON-exported class_declaration, OR (the common case) as `decorator` named-siblings immediately
  // preceding the decorated node — every method/property inside a class_body, and an EXPORTED class
  // inside its export_statement. Collect both, else @Controller/@Get/@Entity/@Column on exported
  // classes are silently dropped. Sibling lookup compares by node id (web-tree-sitter returns fresh
  // wrapper objects, so indexOf on the node reference is unreliable). Comments may interleave a
  // decorator stack (`@Get() … // why … @RequirePermission()`) — skip them, don't stop the walk.
  const decoratorsOf = (n: TsNode): string[] => {
    const nodes: TsNode[] = n.children.filter((c) => c.type === 'decorator');
    const sibs = n.parent ? n.parent.namedChildren : [];
    const idx = sibs.findIndex((s) => s.id === n.id);
    for (let i = idx - 1; i >= 0; i--) {
      if (sibs[i].type === 'decorator') nodes.push(sibs[i]);
      else if (sibs[i].type === 'comment') continue;
      else break;
    }
    return nodes.map((d) => text(d).replace(/^@/, '').trim());
  };

  // Return-type annotation lives on the `return_type` field of function_declaration / arrow_function /
  // function_expression / method_definition, as a `type_annotation` whose `.text` carries the leading
  // `: ` — strip it to match the param-type convention. Undefined when the node is unannotated.
  const returnTypeOf = (n: TsNode): string | undefined => {
    const rt = n.childForFieldName('return_type');
    return rt ? text(rt).replace(/^:\s*/, '') : undefined;
  };

  // JSDoc is the immediately-preceding `comment` sibling of the declaration — of the node itself or of
  // its `lexical_declaration`/`export_statement` wrapper (an exported or `const` binding nests the node
  // under those). Decorators can sit between the comment and the node, so skip them. Only `/** … */`
  // blocks count as documentation (matching ts-morph's getJsDocs); line/`/* */` comments do not.
  const jsdocAnchor = (n: TsNode): TsNode => {
    let a = n;
    if (a.parent?.type === 'lexical_declaration' || a.parent?.type === 'variable_declaration') a = a.parent;
    if (a.parent?.type === 'export_statement') a = a.parent;
    return a;
  };
  // Reduce a `/** … */` block to its DESCRIPTION text only, matching ts-morph's `JSDoc.getComment()`
  // (the baselines' source): strip the comment frame + per-line ` * ` gutter, then stop at the first
  // block tag (`@param`/`@returns`/…). A tag-only block yields '' (ts-morph getComment() also yields '').
  const stripJsDoc = (raw: string): string => {
    const lines = raw
      .replace(/^\/\*\*?/, '') // leading /** (or /*)
      .replace(/\*\/\s*$/, '') // trailing */
      .split('\n')
      .map((l) => l.replace(/^\s*\*+\s?/, '').trimEnd()); // per-line ` * ` gutter
    const desc: string[] = [];
    for (const l of lines) {
      if (/^\s*@\w/.test(l)) break; // first JSDoc block tag ends the description
      desc.push(l);
    }
    return desc.join('\n').trim();
  };
  const jsdocOf = (n: TsNode): string | undefined => {
    const anchor = jsdocAnchor(n);
    const sibs = anchor.parent ? anchor.parent.namedChildren : [];
    const idx = sibs.findIndex((s) => s.id === anchor.id);
    for (let i = idx - 1; i >= 0; i--) {
      const s = sibs[i];
      if (s.type === 'decorator') continue;
      // A block with only tags (no description) reduces to '' → undefined, matching the baselines.
      if (s.type === 'comment') return s.text.startsWith('/**') ? stripJsDoc(s.text) || undefined : undefined;
      break;
    }
    return undefined;
  };

  const parseParams = (paramsNode: TsNode | null): StructuralParam[] => {
    if (!paramsNode) return [];
    return paramsNode.namedChildren
      .filter((p) => PARAM_NODE_TYPES.has(p.type))
      .map((p) => {
        // TS wraps each param (`required_parameter`/`optional_parameter`) with a `pattern` field
        // and an optional `type` field. JS exposes the binding directly: a bare `identifier`, an
        // `assignment_pattern` (default value), a `rest_pattern`, or a destructuring pattern — so
        // fall back to the param node itself when there's no `pattern` field.
        const nameNode =
          p.childForFieldName('pattern') ??
          (p.type === 'assignment_pattern' ? (p.childForFieldName('left') ?? p.namedChildren[0]) : undefined) ??
          (p.type === 'rest_pattern' ? p.namedChildren.find((c) => c.type === 'identifier') : undefined) ??
          p;
        const typeNode = p.childForFieldName('type');
        return {
          name: text(nameNode).replace(/[?]/, ''),
          type: typeNode ? text(typeNode).replace(/^:\s*/, '') : undefined,
          typeInfo: parseTypeNode(typeNode),
          isOptional: p.type === 'optional_parameter' || p.type === 'assignment_pattern' || p.text.includes('?'),
          isRest: p.type === 'rest_pattern' || p.text.startsWith('...'),
        };
      });
  };

  // An export keyword wraps `variable_declarator`s as `export_statement > lexical_declaration >
  // variable_declarator`, so we walk up past `lexical_declaration`; stop at a block/program boundary.
  const isUnderExport = (node: TsNode): boolean => {
    let p = node.parent;
    while (p) {
      if (p.type === 'export_statement') return true;
      if (p.type === 'statement_block' || p.type === 'program') break;
      p = p.parent;
    }
    return false;
  };
  // A declaration node is MODULE-SCOPE when, climbing through its `lexical_declaration`/
  // `variable_declaration`/`export_statement` wrappers, the first real ancestor is the `program`
  // root. ts-morph's getVariableStatements()/getInterfaces()/… only return module-scope decls;
  // nested ones (inside a function/method/block) must NOT be emitted as top-level nodes.
  const isModuleScope = (node: TsNode): boolean => {
    let p = node.parent;
    while (
      p &&
      (p.type === 'lexical_declaration' ||
        p.type === 'variable_declaration' ||
        p.type === 'export_statement' ||
        // `declare interface X {}` / `declare const Y` wrap the decl in an ambient_declaration; it is
        // still module-scope (ts-morph's getInterfaces()/getVariableStatements() include ambient decls).
        p.type === 'ambient_declaration')
    ) {
      p = p.parent;
    }
    return p?.type === 'program';
  };

  // Nearest enclosing `statement_block` of a declarator — the block a `const`/`let` is visible in.
  // A `var` is function-scoped, but keeping it to its block can only UNDER-resolve, never invent a
  // binding at a site the name doesn't reach. Undefined at module scope (handled by the const resolver).
  const enclosingBlock = (node: TsNode): TsNode | undefined => {
    let p = node.parent;
    while (p) {
      if (p.type === 'statement_block') return p;
      if (p.type === 'program') return undefined;
      p = p.parent;
    }
    return undefined;
  };

  // const/let/var for a variable_declarator. `var` parses as `variable_declaration`; `const`/`let`
  // parse as `lexical_declaration` carrying a `const`/`let` keyword child.
  const declarationKindOf = (declarator: TsNode): 'const' | 'let' | 'var' => {
    const decl = declarator.parent;
    if (decl?.type === 'variable_declaration') return 'var';
    if (decl?.children.some((c) => c.type === 'let')) return 'let';
    return 'const';
  };

  // Push a flat module/object-level function (arrow-fn const, object method, function expression).
  // No classId — these are not class members. `docNode` is the declaration whose preceding sibling
  // carries the JSDoc (the variable_declarator / pair / method_definition), distinct from `valueNode`
  // (the arrow/function expression that carries params + return type).
  const pushFn = (name: string, valueNode: TsNode, isExported: boolean, docNode: TsNode): void => {
    if (!name) return;
    file.functions.push({
      name,
      isAsync: valueNode.children.some((c) => c.type === 'async') || valueNode.text.startsWith('async'),
      isExported,
      params: parseParams(valueNode.childForFieldName('parameters')),
      returnType: returnTypeOf(valueNode),
      documentation: jsdocOf(docNode),
      startLine: lineOf(valueNode),
      endLine: endLineOf(valueNode),
      decorators: [],
    });
  };

  // Strip surrounding quotes (single/double/backtick) — the tree-sitter `string` node's `.text`
  // includes its quote characters even though the literal content lives in a `string_fragment` child.
  const unquote = (s: string): string => s.replace(/^['"`]|['"`]$/g, '');
  // Collect string-valued members of an object literal or enum body into a flat record.
  // Non-string members (numbers, fns, computed) are skipped; returns undefined when none qualify.
  const stringMembers = (
    objOrEnumBody: TsNode,
    pairType: string,
    keyField: string,
    valField: string,
  ): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const c of objOrEnumBody.namedChildren) {
      if (c.type !== pairType) continue;
      const v = c.childForFieldName(valField);
      if (v?.type !== 'string') continue; // string-valued members only
      const k = text(c.childForFieldName(keyField));
      if (k) out[k] = unquote(text(v));
    }
    return Object.keys(out).length ? out : undefined;
  };

  // A stable synthetic name for an anonymous callback passed as a CALL ARGUMENT
  // (`router.get('/x', (req,res) => …)`, `arr.map(x => …)`): `<callee>@<argIndex>#<startLine>`.
  // Unique within a file (callee + arg position + start line), so functionId(file, name) never
  // collides with a sibling callback. Returns undefined unless the node is an UNNAMED
  // arrow/function-expression whose parent is the `arguments` list of a call_expression — so IIFEs,
  // JSX handlers, and var/pair-bound functions (named elsewhere) are excluded by construction.
  // Both the promotion (walk) and the attribution (enclosingInfo) compute the name from this single
  // helper, so the function node and the call's enclosingName agree by construction.
  const anonCallbackName = (node: TsNode): string | undefined => {
    if (node.type !== 'arrow_function' && node.type !== 'function_expression') return undefined;
    if (text(node.childForFieldName('name'))) return undefined; // a named function expression keeps its own name
    const args = node.parent;
    if (!args || args.type !== 'arguments') return undefined;
    const call = args.parent;
    if (!call || call.type !== 'call_expression') return undefined;
    const calleeText = text(call.childForFieldName('function'));
    if (!calleeText) return undefined;
    const argIndex = args.namedChildren.findIndex((c) => c.id === node.id);
    if (argIndex < 0) return undefined;
    return `${calleeText}@${argIndex}#${lineOf(node)}`;
  };

  // Whether a node is enclosed by a NAMED function/method scope (a real caller already exists to
  // attribute its calls to). Gates anon-callback promotion: only a callback with NO named enclosing
  // scope — a module-scope inline handler like `app.get('/x', () => …)` — is promoted. A callback
  // NESTED in a method (`m() { arr.map(x => svc.do(x)) }`) keeps its calls attributed to that method;
  // promoting it would re-attribute them to an orphan node behind a dropped builtin (`.map`/`.forEach`),
  // fragmenting the call graph instead of improving recall.
  const hasNamedEnclosingScope = (node: TsNode): boolean => {
    let cur: TsNode | null = node.parent;
    while (cur) {
      if (cur.type === 'method_definition' || cur.type === 'method_signature' || cur.type === 'function_declaration') {
        return true;
      }
      if (cur.type === 'function_expression' || cur.type === 'arrow_function' || cur.type === 'function') {
        if (text(cur.childForFieldName('name'))) return true; // named function expression
        const owner = cur.parent;
        if (owner && (owner.type === 'variable_declarator' || owner.type === 'pair')) return true; // bound to a name
        // else: another anonymous call-arg callback — not a named scope; keep climbing.
      }
      if (cur.type === 'class_declaration' || cur.type === 'class' || cur.type === 'abstract_class_declaration') {
        return false;
      }
      cur = cur.parent;
    }
    return false;
  };

  // Whether a callback body contains a call_expression NOT nested inside its own inner function scope —
  // i.e. a call that would actually attribute to this callback. Gates promotion so an EMPTY module-scope
  // callback (`useFactory: () => new X()`, `() => config`, accessor arrows) is never promoted: it would
  // be a pure-noise function node with no edge to carry. Only callbacks with real inner calls become nodes.
  const bodyHasDirectCall = (fnNode: TsNode): boolean => {
    const contains = (n: TsNode): boolean => {
      if (n.type === 'call_expression') return true;
      // Don't descend into a nested function scope — its calls attribute to it, not to this callback.
      if (
        n.type === 'function_declaration' ||
        n.type === 'function_expression' ||
        n.type === 'arrow_function' ||
        n.type === 'method_definition'
      ) {
        return false;
      }
      return n.namedChildren.some(contains);
    };
    const body = fnNode.childForFieldName('body');
    return body ? contains(body) : false;
  };

  const enclosingInfo = (
    n: TsNode,
  ): { kind: 'method' | 'function' | 'module'; name?: string; cls?: string; objectMethod?: boolean } => {
    let cur: TsNode | null = n.parent;
    let cls: string | undefined;
    let name: string | undefined;
    let kind: 'method' | 'function' | 'module' = 'module';
    let objectMethod = false;
    // Innermost anonymous call-arg callback seen while climbing — used ONLY as a fallback when the
    // climb reaches module scope without a real named function/method (the module-scope inline-callback
    // hole). A callback nested in a method never reaches this fallback, so its calls stay attributed to
    // the method (no re-attribution / call-graph fragmentation).
    let firstAnonCallback: string | undefined;
    while (cur) {
      if ((cur.type === 'method_definition' || cur.type === 'method_signature') && !name) {
        // Object-literal shorthand methods (`{ format(x) { … } }`) also parse as `method_definition`,
        // but with parent `object` and no enclosing class. These are emitted as flat StructuralFunctions
        // (classId-less), so attribute calls inside them as kind 'function' — otherwise resolveEnclosingId
        // requires an enclosingClass for kind 'method' and silently drops the call (cls stays undefined).
        name = text(cur.childForFieldName('name'));
        const inObject = cur.parent?.type === 'object';
        kind = inObject ? 'function' : 'method';
        if (inObject) objectMethod = true;
      } else if (
        (cur.type === 'function_declaration' ||
          cur.type === 'function' ||
          cur.type === 'function_expression' ||
          cur.type === 'arrow_function') &&
        !name
      ) {
        // arrow_function / function_expression nodes have no `name` field in the tree-sitter TS/JS
        // grammar — the binding identifier lives on the parent `variable_declarator` (`const fn = …`)
        // or `pair` (`{ key: function(){} }`). Climb to it so calls inside these bodies attribute to
        // the emitted function nodes, instead of falling through to enclosingKind 'module'.
        name = text(cur.childForFieldName('name')) || undefined;
        if (!name) {
          const owner = cur.parent;
          if (owner && (owner.type === 'variable_declarator' || owner.type === 'pair')) {
            name = text(owner.childForFieldName('name') || owner.childForFieldName('key')) || undefined;
            // A `pair`-owned function (`{ key: () => {} }`) is an object-literal method.
            if (owner.type === 'pair') objectMethod = true;
          }
        }
        // Still unnamed → an anonymous callback passed as a call argument. Remember the innermost one,
        // but keep climbing: a real enclosing fn/method above must win, so a nested callback's calls
        // stay attributed to it. Only a callback with NO named enclosing scope falls through to the
        // post-loop fallback below (and only those are promoted in the walk).
        if (!name && opts.resolveAnonCallbacks && !firstAnonCallback) firstAnonCallback = anonCallbackName(cur);
        kind = name ? 'function' : kind;
      } else if (
        cur.type === 'class_declaration' ||
        cur.type === 'class' ||
        cur.type === 'abstract_class_declaration'
      ) {
        cls = text(cur.childForFieldName('name'));
        break;
      }
      cur = cur.parent;
    }
    // No named scope enclosed the call → a module-scope anonymous callback (`app.get('/x', () =>
    // handleUser())`). Attribute it to the promoted callback: the genuine inline-callback recall hole.
    if (!name && firstAnonCallback) {
      name = firstAnonCallback;
      kind = 'function';
    }
    return { kind, name, cls, objectMethod };
  };

  // Every `Ident.prop` value access seen in the walk. Filtered to enum-shaped candidates AFTER the
  // walk, because the enum/import declarations that qualify a candidate may be parsed later than the
  // reference site.
  const memberAccessCandidates: StructuralEnumMemberRef[] = [];
  // Every `new Ident(...)` site seen in the walk, filtered to class-shaped candidates AFTER the walk
  // for the same reason: the class/import declarations that qualify a candidate may be parsed later
  // than the construction site. Import sites are derived from `file.imports` after the walk.
  const constructionCandidates: StructuralClassRef[] = [];

  const walk = (n: TsNode): void => {
    switch (n.type) {
      case 'import_statement': {
        const spec = n.childForFieldName('source');
        const moduleSpecifier = text(spec).replace(/^['"]|['"]$/g, '');
        const isTypeOnly = n.text.startsWith('import type');
        const names: { name: string; alias?: string }[] = [];
        let kind: StructuralImport['kind'] = 'side-effect';
        const clause = n.namedChildren.find((c) => c.type === 'import_clause');
        if (clause) {
          for (const c of clause.namedChildren) {
            if (c.type === 'identifier') {
              names.push({ name: text(c) });
              kind = 'default';
            } else if (c.type === 'namespace_import') {
              names.push({ name: text(c.namedChildren[0]) });
              kind = 'namespace';
            } else if (c.type === 'named_imports') {
              kind = 'named';
              for (const spec2 of c.namedChildren.filter((x) => x.type === 'import_specifier')) {
                const nm = text(spec2.childForFieldName('name'));
                const alias = spec2.childForFieldName('alias');
                // `import { type Foo, Bar }` — the inline `type` keyword is an anonymous child
                // token of the specifier, so the specifier text is what states it.
                const inlineTypeOnly = spec2.children.some((x) => x.type === 'type');
                names.push({
                  name: nm,
                  alias: alias ? text(alias) : undefined,
                  ...(inlineTypeOnly ? { isTypeOnly: true } : {}),
                });
              }
            }
          }
        }
        file.imports.push({ moduleSpecifier, names, kind, isTypeOnly, startLine: lineOf(n) });
        break;
      }
      case 'export_statement': {
        // Re-exports (`export … from '…'`) carry a `source` field. A plain `export { Local }` or an
        // exported declaration (`export class …`) has NO `source` field — those are local exports,
        // handled elsewhere (class/function cases via `n.parent?.type === 'export_statement'`), so skip.
        const src = n.childForFieldName('source');
        if (!src) break;
        const moduleSpecifier = unquote(text(src));
        const clause = n.namedChildren.find((c) => c.type === 'export_clause');
        if (!clause) {
          // `export * from '…'` — no export_clause child.
          reExports.push({ moduleSpecifier, kind: 'star' });
        } else {
          const names = clause.namedChildren
            .filter((s) => s.type === 'export_specifier')
            .map((s) => {
              const name = text(s.childForFieldName('name'));
              const alias = s.childForFieldName('alias');
              return alias ? { name, alias: text(alias) } : { name };
            });
          reExports.push({ moduleSpecifier, kind: 'named', names });
        }
        break;
      }
      case 'class_declaration':
      case 'class':
      // Abstract classes parse as a distinct `abstract_class_declaration` node (not `class_declaration`),
      // but expose the same `name`/`body` fields and the same `class_body` children. Without this case
      // they — and their methods, and the intra-class `this.method()` call edges inside them — are
      // dropped entirely. Nothing about `abstract` should exclude a class from extraction.
      case 'abstract_class_declaration': {
        const name = text(n.childForFieldName('name'));
        const body = n.childForFieldName('body');
        const methods: StructuralMethod[] = [];
        const properties: StructuralProperty[] = [];
        const ctorParams: StructuralClass['ctorParams'] = [];
        if (body) {
          for (const p of body.namedChildren.filter((c) => c.type === 'public_field_definition')) {
            const nameNode =
              p.childForFieldName('name') ?? p.namedChildren.find((c) => c.type === 'property_identifier');
            const typeNode = p.childForFieldName('type') ?? p.namedChildren.find((c) => c.type === 'type_annotation');
            const accessibility = p.namedChildren.find((c) => c.type === 'accessibility_modifier');
            properties.push({
              name: text(nameNode),
              type: typeNode ? text(typeNode).replace(/^:\s*/, '') : undefined,
              typeInfo: parseTypeNode(typeNode),
              isOptional: p.children.some((c) => c.type === '?'),
              isStatic: p.children.some((c) => c.type === 'static'),
              isReadonly: p.children.some((c) => c.type === 'readonly'),
              visibility: (text(accessibility) || 'public') as 'public' | 'private' | 'protected',
              startLine: lineOf(p),
              endLine: endLineOf(p),
              decorators: decoratorsOf(p),
            });
          }
          // `method_definition` is a concrete method (with body); `abstract_method_signature` is an
          // abstract method (no body) inside an abstract class. ts-morph's classDecl.getMethods()
          // returns both, so emit both — otherwise a `this.abstractMethod()` call has no callee node
          // to resolve onto and the edge is silently dropped.
          for (const m of body.namedChildren.filter(
            (c) => c.type === 'method_definition' || c.type === 'abstract_method_signature',
          )) {
            const mName = text(m.childForFieldName('name'));
            const params = parseParams(m.childForFieldName('parameters'));
            if (mName === 'constructor') {
              // Capture ctor params for the class's constructor info, but don't emit the
              // constructor as a method FunctionNode — it isn't a method (schema keeps it in
              // ClassNode.constructor/ConstructorNode), nothing resolves call edges onto it
              // (`new X()` is its own egress), and as a call *source* it's already skipped by
              // the egress detectors. Leaving it in only adds noise to functions/summarize/graph.
              for (const p of params) ctorParams.push({ name: p.name, type: p.type });
              continue;
            }
            methods.push({
              name: mName,
              isAsync: m.text.startsWith('async') || m.children.some((c) => c.type === 'async'),
              isStatic: m.children.some((c) => c.type === 'static'),
              visibility: m.text.includes('private')
                ? 'private'
                : m.text.includes('protected')
                  ? 'protected'
                  : 'public',
              params,
              returnType: returnTypeOf(m),
              documentation: jsdocOf(m),
              startLine: lineOf(m),
              endLine: endLineOf(m),
              decorators: decoratorsOf(m),
            });
          }
        }
        // Heritage: `class X extends Base<TypeArg, …>` → base name + type-arg texts, and the
        // separate `implements_clause` → one base name per listed interface. Both live under
        // `class_heritage`.
        let extendsClass: StructuralClass['extendsClass'];
        const heritage = n.namedChildren.find((c) => c.type === 'class_heritage');
        const implClause = heritage?.namedChildren.find((c) => c.type === 'implements_clause');
        const implementsNames = implClause
          ? implClause.namedChildren.flatMap((c) => {
              const name = heritageBaseName(c);
              return name ? [name] : [];
            })
          : [];
        const extClause = heritage?.namedChildren.find((c) => c.type === 'extends_clause');
        if (extClause) {
          const baseNode = extClause.namedChildren.find(
            (c) => c.type === 'identifier' || c.type === 'member_expression' || c.type === 'type_identifier',
          );
          const baseName = text(baseNode);
          const typeArgsNode = extClause.namedChildren.find((c) => c.type === 'type_arguments');
          const typeArgs = typeArgsNode
            ? typeArgsNode.namedChildren.filter((c) => c.type !== 'comment').map((c) => text(c))
            : [];
          if (baseName) extendsClass = { name: baseName, typeArgs };
        }
        file.classes.push({
          name,
          isExported: n.parent?.type === 'export_statement',
          isAbstract: n.text.includes('abstract'),
          startLine: lineOf(n),
          endLine: endLineOf(n),
          decorators: decoratorsOf(n),
          documentation: jsdocOf(n),
          methods,
          properties,
          ctorParams,
          extendsClass,
          implementsNames,
        });
        break;
      }
      case 'function_declaration': {
        file.functions.push({
          name: text(n.childForFieldName('name')),
          isAsync: n.children.some((c) => c.type === 'async'),
          isExported: n.parent?.type === 'export_statement',
          params: parseParams(n.childForFieldName('parameters')),
          returnType: returnTypeOf(n),
          documentation: jsdocOf(n),
          startLine: lineOf(n),
          endLine: endLineOf(n),
          decorators: [],
        });
        break;
      }
      case 'variable_declarator': {
        const value = n.childForFieldName('value');
        const nameNode = n.childForFieldName('name');
        const name = text(nameNode);
        // Dynamic import binding: `const { X } = await import('pkg')` / `const ns = await import('pkg')`.
        // Recorded as a structural import so SDK provenance (registry / fromModule) resolves like a static import.
        const dynImp = value?.type === 'await_expression' ? value.namedChildren[0] : value;
        if (dynImp?.type === 'call_expression') {
          const fn = dynImp.childForFieldName('function');
          if (fn && (fn.type === 'import' || text(fn) === 'import')) {
            const strArg = dynImp.childForFieldName('arguments')?.namedChildren.find((c) => c.type === 'string');
            if (strArg && nameNode) {
              const impNames: { name: string; alias?: string }[] = [];
              // Same bindings, with the export-name identifier's position: that is where SCIP
              // records the reference to the real export, so call resolution can follow it.
              const dynBindings: StructuralDynamicImportBinding[] = [];
              let impKind: StructuralImport['kind'] = 'namespace';
              if (nameNode.type === 'object_pattern') {
                impKind = 'named';
                for (const c of nameNode.namedChildren) {
                  if (c.type === 'shorthand_property_identifier_pattern') {
                    impNames.push({ name: text(c) });
                    dynBindings.push({
                      exportName: text(c),
                      localName: text(c),
                      line: lineOf(c),
                      column: c.startPosition.column,
                    });
                  } else if (c.type === 'pair_pattern') {
                    const key = c.childForFieldName('key');
                    const val = c.childForFieldName('value');
                    if (key) impNames.push({ name: text(key), alias: val ? text(val) : undefined });
                    // Only a plain identifier is a usable local binding; a nested pattern
                    // (`{ a: { b } }`) is deliberately skipped rather than guessed at.
                    if (key && val?.type === 'identifier')
                      dynBindings.push({
                        exportName: text(key),
                        localName: text(val),
                        line: lineOf(key),
                        column: key.startPosition.column,
                      });
                  }
                }
                if (dynBindings.length)
                  file.dynamicImports?.push({
                    moduleSpecifier: unquote(text(strArg)),
                    bindings: dynBindings,
                    startLine: lineOf(n),
                    endLine: endLineOf(n),
                  });
              } else if (nameNode.type === 'identifier') {
                impNames.push({ name });
              }
              if (impNames.length) {
                file.imports.push({
                  moduleSpecifier: unquote(text(strArg)),
                  names: impNames,
                  kind: impKind,
                  isTypeOnly: false,
                  startLine: lineOf(n),
                });
              }
            }
          }
        }
        const isFunctionValued = !!value && (value.type === 'arrow_function' || value.type === 'function_expression');
        if (isFunctionValued) {
          pushFn(name, value, isUnderExport(n), n);
        } else if (value?.type === 'string' && name) {
          valueBindings.push({
            name,
            filePath: path,
            kind: 'literal',
            literal: unquote(text(value)),
            isExported: isUnderExport(n),
          });
        } else if (value?.type === 'object' && name) {
          const members = stringMembers(value, 'pair', 'key', 'value');
          if (members)
            valueBindings.push({ name, filePath: path, kind: 'object', members, isExported: isUnderExport(n) });
        }
        // Emit a VariableNode for module-scope, non-function-valued declarators — mirroring
        // ts-morph's getVariableStatements() (module-scope; function-valued decls become
        // FunctionNodes via parseFunctionVariableDeclaration and are skipped here). A destructuring
        // declarator (`const { a, b } = …`) is ONE VariableNode whose name is the pattern text,
        // matching ts-morph's VariableDeclaration.getName().
        const isNamedDecl =
          nameNode?.type === 'identifier' || nameNode?.type === 'object_pattern' || nameNode?.type === 'array_pattern';
        // Block-scoped binding with a simple name and an initializer: record it with the span of
        // the block it is visible in, so a call site can take ONE hop from a bare local name to
        // this initializer text. Function-valued and destructured declarators are not topics.
        if (!isFunctionValued && name && nameNode?.type === 'identifier' && value && !isModuleScope(n)) {
          const block = enclosingBlock(n);
          if (block) {
            localBindings.push({
              name,
              declarationKind: declarationKindOf(n),
              initialValue: text(value),
              scopeStartLine: lineOf(block),
              scopeEndLine: endLineOf(block),
            });
          }
        }
        if (!isFunctionValued && name && isNamedDecl && isModuleScope(n)) {
          const typeNode = n.childForFieldName('type');
          variables.push({
            name,
            isExported: isUnderExport(n),
            declarationKind: declarationKindOf(n),
            type: typeNode ? text(typeNode).replace(/^:\s*/, '') : undefined,
            initialValue: value ? text(value) : undefined,
            documentation: jsdocOf(n),
            startLine: lineOf(n),
            endLine: endLineOf(n),
          });
        }
        break;
      }
      case 'interface_declaration': {
        // Only module-scope interfaces are emitted (ts-morph's getInterfaces() is module-scope).
        if (!isModuleScope(n)) break;
        const name = text(n.childForFieldName('name'));
        if (!name) break;
        const extendsClause = n.namedChildren.find((c) => c.type === 'extends_type_clause');
        const ext = extendsClause
          ? extendsClause.namedChildren.flatMap((c) => {
              const base = heritageBaseName(c);
              return base ? [base] : [];
            })
          : [];
        const body = n.childForFieldName('body') ?? n.namedChildren.find((c) => c.type === 'interface_body');
        const members: StructuralInterfaceMember[] = [];
        if (body) {
          for (const m of body.namedChildren) {
            let kind: StructuralInterfaceMember['kind'];
            if (m.type === 'property_signature') kind = 'property';
            else if (m.type === 'method_signature') kind = 'method';
            else if (m.type === 'index_signature') kind = 'index';
            else continue;
            // The annotation is the member's own type for a property/index signature and the
            // RETURN type for a method signature (`describe(): T`) — mapping both onto `type`
            // would misreport a method as a value of its return type.
            const typeNode = m.childForFieldName('type') ?? m.namedChildren.find((c) => c.type === 'type_annotation');
            const typeInfo = parseTypeNode(typeNode);
            members.push({
              name: text(m.childForFieldName('name')) || 'unknown',
              kind,
              ...(kind === 'method' ? { returnType: typeInfo } : { type: typeInfo }),
              isOptional: m.text.includes('?'),
              isReadonly: m.text.includes('readonly'),
              startLine: lineOf(m),
              endLine: endLineOf(m),
            });
          }
        }
        interfaces.push({
          name,
          isExported: isUnderExport(n),
          extends: ext,
          members,
          documentation: jsdocOf(n),
          startLine: lineOf(n),
          endLine: endLineOf(n),
        });
        break;
      }
      case 'type_alias_declaration': {
        if (!isModuleScope(n)) break;
        const name = text(n.childForFieldName('name'));
        if (!name) break;
        // The aliased type is the `value` field (the node after `=`). Fall back to the last named
        // child when the grammar version doesn't expose the field.
        const valueNode = n.childForFieldName('value') ?? n.namedChildren[n.namedChildren.length - 1];
        typeAliases.push({
          name,
          isExported: isUnderExport(n),
          aliasedType: valueNode ? text(valueNode) : undefined,
          aliasedTypeInfo: parseTypeNode(valueNode),
          documentation: jsdocOf(n),
          startLine: lineOf(n),
          endLine: endLineOf(n),
        });
        break;
      }
      case 'enum_declaration': {
        const name = text(n.childForFieldName('name'));
        const body = n.childForFieldName('body') ?? n.namedChildren.find((c) => c.type === 'enum_body');
        // String-valued members also feed the value resolver (existing behavior, all scopes).
        if (name && body) {
          const members = stringMembers(body, 'enum_assignment', 'name', 'value');
          if (members)
            valueBindings.push({ name, filePath: path, kind: 'enum', members, isExported: isUnderExport(n) });
        }
        // Emit the EnumNode for module-scope enums (ts-morph's getEnums() is module-scope).
        if (name && body && isModuleScope(n)) {
          const enumMembers: StructuralEnumMember[] = [];
          for (const c of body.namedChildren) {
            if (c.type === 'enum_assignment') {
              const mName = text(c.childForFieldName('name'));
              if (!mName) continue;
              const v = c.childForFieldName('value');
              enumMembers.push({ name: mName, value: v ? unquote(text(v)) : undefined });
            } else if (c.type === 'property_identifier') {
              // Auto-numbered member (`enum { A }`) — no value node.
              const mName = text(c);
              if (mName) enumMembers.push({ name: mName });
            }
          }
          enums.push({
            name,
            isExported: isUnderExport(n),
            isConst: n.children.some((c) => c.type === 'const'),
            members: enumMembers,
            documentation: jsdocOf(n),
            startLine: lineOf(n),
            endLine: endLineOf(n),
          });
        }
        break;
      }
      case 'pair': {
        const value = n.childForFieldName('value');
        if (
          value &&
          (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function')
        ) {
          pushFn(text(n.childForFieldName('key')), value, false, n);
        }
        break;
      }
      case 'method_definition': {
        // Object-literal shorthand method `{ m() {} }` parses as method_definition with parent `object`.
        // Class methods are handled inside the class_declaration case — guard so they are not duplicated.
        if (n.parent?.type === 'object') pushFn(text(n.childForFieldName('name')), n, false, n);
        break;
      }
      case 'member_expression': {
        // Candidate enum-member access: `Ident.prop` in value position. A method call
        // (`Ident.prop()`) is a CALL, already modelled as such — skip it here so one site never
        // yields two competing facts. Computed access (`Ident[expr]`) names no member statically.
        const object = n.childForFieldName('object');
        const property = n.childForFieldName('property');
        if (
          object?.type === 'identifier' &&
          property?.type === 'property_identifier' &&
          !(n.parent?.type === 'call_expression' && n.parent.childForFieldName('function')?.id === n.id)
        ) {
          const enc = enclosingInfo(n);
          memberAccessCandidates.push({
            enumName: text(object),
            member: text(property),
            startLine: lineOf(n),
            enclosingKind: enc.kind,
            enclosingName: enc.name,
            enclosingClass: enc.cls,
          });
        }
        break;
      }
      case 'new_expression': {
        // `new Ident(...)` — the constructed name is the new_expression's first named child. A
        // dotted constructor (`new ns.X()` / `new this.Klass()`) parses as a member_expression:
        // no local declaration and no import bind that name, so it is refused rather than guessed.
        const ctor = n.namedChildren.find((c) => c.type === 'identifier' || c.type === 'member_expression');
        if (ctor?.type === 'identifier') {
          const enc = enclosingInfo(n);
          constructionCandidates.push({
            className: text(ctor),
            refKind: 'construction',
            startLine: lineOf(n),
            enclosingKind: enc.kind,
            enclosingName: enc.name,
            enclosingClass: enc.cls,
          });
        }
        break;
      }
      // A name written to after its declaration has more than one value reaching a use site,
      // which is not statically decidable here — record it so local-binding lookups refuse it.
      case 'assignment_expression':
      case 'augmented_assignment_expression': {
        const left = n.childForFieldName('left');
        if (left?.type === 'identifier') assignedNames.add(text(left));
        break;
      }
      case 'update_expression': {
        const arg = n.childForFieldName('argument');
        if (arg?.type === 'identifier') assignedNames.add(text(arg));
        break;
      }
      case 'call_expression': {
        let fn = n.childForFieldName('function');
        // Grammar quirk: `await x.m<A, B>(…)` (await + type arguments) mis-parses so the
        // call_expression's `function` field is the whole `await_expression` (`await x.m`)
        // rather than the normal `await_expression > call_expression` nesting. Unwrap the
        // await so receiver/method extraction sees the real member_expression callee; without
        // this the receiver is lost and the call (incl. axios/SDK egress with type args) is
        // mis-classified as a bare callee named "await x.m". Plain `await x.m()` (no type args)
        // parses normally and is unaffected.
        let awaitUnwrapped = false;
        if (fn && fn.type === 'await_expression') {
          const inner = fn.namedChildren[0];
          if (inner) {
            fn = inner;
            awaitUnwrapped = true;
          }
        }
        let receiver: string | undefined;
        let methodName: string | undefined;
        if (fn && fn.type === 'member_expression') {
          receiver = text(fn.childForFieldName('object'));
          methodName = text(fn.childForFieldName('property'));
        } else if (fn) {
          methodName = text(fn);
        }
        const argsNode = n.childForFieldName('arguments');
        const args = argsNode ? argsNode.namedChildren.map((a) => text(a)) : [];
        const enc = enclosingInfo(n);
        file.calls.push({
          receiver,
          methodName,
          expressionText: text(fn),
          arguments: args,
          isAwaited: awaitUnwrapped || n.parent?.type === 'await_expression',
          startLine: lineOf(n),
          endLine: endLineOf(n),
          enclosingKind: enc.kind,
          enclosingName: enc.name,
          enclosingClass: enc.cls,
          enclosingObjectMethod: enc.objectMethod || undefined,
        });
        // Promote anonymous callbacks passed as arguments (`router.get('/x', () => …)`) to citable
        // function nodes so their bodies' calls (attributed above via enclosingInfo) resolve to a
        // real caller. Each arrow is the argument of exactly one call_expression, so it is promoted
        // once; nested callbacks are promoted when their own enclosing call is visited.
        if (opts.resolveAnonCallbacks && argsNode) {
          for (const a of argsNode.namedChildren) {
            const syntheticName = anonCallbackName(a);
            // Promote only a module-scope callback (no named enclosing scope) that actually CONTAINS a
            // direct call — matching the enclosingInfo fallback above. A nested callback is left alone
            // (its calls attribute to the enclosing method); an empty callback is left alone (no edge to
            // carry → no noise node). So promotion happens exactly where an inline handler makes a call.
            if (syntheticName && !hasNamedEnclosingScope(a) && bodyHasDirectCall(a)) {
              pushFn(syntheticName, a, false, a);
            }
          }
        }
        break;
      }
    }
    for (const child of n.namedChildren) walk(child);
  };

  // Free the WASM-side tree once extraction is done: web-tree-sitter never garbage-collects
  // trees (no FinalizationRegistry), and its Emscripten heap is hard-capped at 2GB — parsing a
  // large monorepo without this aborts the process (`Aborted()`). StructuralFile holds only
  // plain data, never tree nodes, so deleting here is safe.
  try {
    walk(root);
  } finally {
    tree.delete();
  }

  // Assignments are collected file-wide (a write may be parsed after the declaration), so the
  // reassigned flag is applied once the walk is complete.
  for (const b of localBindings) {
    if (assignedNames.has(b.name)) b.reassigned = true;
  }

  // Keep only member accesses whose object name can name an enum from this file's perspective:
  // an enum declared here, or a name imported into the file (the import may bind anything — the
  // enum-node lookup downstream decides). Everything else (locals, parameters, `this` chains) is
  // dropped here so the fact stream stays enum-shaped rather than every property read in the repo.
  // An imported name is rewritten to the name it is EXPORTED under (`import { Status as S }` →
  // `Status`) and tagged with the module it came from, so downstream resolution can match a symbol
  // instead of trusting whatever the local alias happens to spell.
  const declaredHere = new Set<string>(enums.map((e) => e.name));
  const importedNames = new Map<string, { exportName: string; moduleSpecifier: string }>();
  for (const imp of file.imports) {
    for (const named of imp.names) {
      // Default/namespace imports bind no export name — `named.name` already is the local name.
      importedNames.set(named.alias ?? named.name, { exportName: named.name, moduleSpecifier: imp.moduleSpecifier });
    }
  }
  file.enumMemberRefs = memberAccessCandidates.flatMap((ref) => {
    if (declaredHere.has(ref.enumName)) return [ref];
    const imported = importedNames.get(ref.enumName);
    if (!imported) return [];
    return [{ ...ref, enumName: imported.exportName, importedFrom: imported.moduleSpecifier }];
  });

  // Class references, on the same "declared here or imported here" discipline as enum members.
  // A `new X()` whose name is neither (a local factory variable, a parameter) names no class this
  // parse can decide on and is dropped.
  const classesDeclaredHere = new Set<string>(file.classes.map((c) => c.name));
  // Only NAMED value imports can bind a class this parse can identify: a default import binds no
  // exported name to look up in the target module, and a type-only binding (`import type { X }`,
  // `import { type X }`) is a type-position use, already carried by annotations.
  const namedValueImports = new Map<string, { exportName: string; moduleSpecifier: string; startLine: number }>();
  for (const imp of file.imports) {
    if (imp.kind !== 'named' || imp.isTypeOnly) continue;
    for (const named of imp.names) {
      if (named.isTypeOnly) continue;
      namedValueImports.set(named.alias ?? named.name, {
        exportName: named.name,
        moduleSpecifier: imp.moduleSpecifier,
        startLine: imp.startLine,
      });
    }
  }
  const constructionRefs = constructionCandidates.flatMap((ref) => {
    if (classesDeclaredHere.has(ref.className)) return [ref];
    const imported = namedValueImports.get(ref.className);
    if (!imported) return [];
    return [{ ...ref, className: imported.exportName, importedFrom: imported.moduleSpecifier }];
  });
  // Import sites: one candidate per NAMED, value-position import specifier. A default or namespace
  // import binds no exported name to look up in the target module, and a `import type` statement or
  // an inline `type` specifier is a TYPE-position use already carried by annotations — neither
  // produces a row. Whether the imported name is really a class is decided downstream.
  const importRefs: StructuralClassRef[] = [...namedValueImports.entries()].map(([localName, imported]) => ({
    className: imported.exportName,
    refKind: 'import' as const,
    // A rename is the only case worth carrying: `Svc` is what this module's reader greps for, and
    // the exported name alone would send them to a name the file never spells.
    ...(localName !== imported.exportName ? { localName } : {}),
    importedFrom: imported.moduleSpecifier,
    startLine: imported.startLine,
    enclosingKind: 'module' as const,
  }));
  file.classRefs = [...constructionRefs, ...importRefs];
  return file;
}
