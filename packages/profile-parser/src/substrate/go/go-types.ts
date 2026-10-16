/**
 * Go LOCAL TYPE ENVIRONMENT — "what named type does this identifier hold, and which package
 * declares it?".
 *
 * Go writes almost nothing the way the rest of this substrate's lanes can read directly. The
 * dominant router shape is a handler value held in a LOCAL:
 *
 *     h := handler.New(queries, …)   // *handler.Handler, declared in another package
 *     r.Get("/api/me", h.GetMe)      // the handler is a method on that value's type
 *
 * and the dominant call shape is the same value being called (`h.GetMe()`). Without an answer to
 * "what is `h`", the entrypoint lane emits a route LIST with no handler and the call graph drops
 * every method call that is not on the enclosing method's own receiver — which is most of them.
 * This module is that answer, and it is deliberately the ONLY place in the Go substrate that
 * infers a type, so the two consumers cannot drift apart.
 *
 * It is not a type checker. It reads the STATICALLY DECIDABLE binding shapes off the CST and
 * refuses everything else:
 *
 *   - a `parameter_declaration` in an enclosing signature, including a method's receiver
 *   - `x := &T{}` / `T{}` / `pkg.T{}` — a composite literal names its own type
 *   - `x := New…(…)` / `x := pkg.New…(…)` / `x := v.Method(…)` — the callee's DECLARED result type,
 *     read off the callee's declaration (never guessed from the callee's NAME), including the
 *     multi-value form `x, err := New(…)` where the slot is positional and therefore decidable
 *   - `var x T` — an explicit type, at function or package scope
 *   - `recv.field` — the field's declared type, read off the struct that declares it
 *
 * Everything else is a Tier-B gap that answers `unresolved` and is COUNTED, never guessed: a
 * `range` element, a type-switch alias, a member promoted through an embedded struct, a
 * predeclared (universe-block) name, and any type declared outside this repo's in-scope packages.
 * Two shapes are deliberately NOT in that list. An interface-typed value answers with the
 * INTERFACE — a real, correct answer; it is the consumer that finds no method bodies on it and
 * drops the dispatch. And a later `= …` is never read: Go fixes a variable's static type at its
 * DECLARATION, so a binding site is the only thing that can decide one.
 *
 * Two properties make it safe to build call edges on:
 *
 *   1. **A type is a (name, PACKAGE DIRECTORY) pair, never a bare name.** An unqualified `T` is
 *      declared in the directory of the file that SPELLS it, and `pkg.T` resolves `pkg` through
 *      that same file's import table. The declaring file matters: `handler.New`'s result is
 *      written `*Handler` inside `internal/handler`, so it names `internal/handler`'s `Handler` —
 *      resolving it against the CALLING file's directory would attach the whole router to whatever
 *      same-named type happened to live next to `main`.
 *   2. **A binding site that cannot be typed stops the search.** Shadowing is ordinary Go, so an
 *      inner `x := <undecidable>` must NOT fall through to an outer typed `x` — that would silently
 *      answer with the wrong variable. `resolveOperand` distinguishes "bound, undecidable"
 *      (`unresolved`, drop it) from "no binding in scope at all" (`unbound`, which is how a caller
 *      learns the identifier is free to be read as a package qualifier instead).
 */
import {
  CALL_EXPRESSION,
  COMPOSITE_LITERAL,
  FIELD_DECLARATION,
  FN_SCOPE_TYPES,
  FOR_CLAUSE,
  FUNCTION_DECLARATION,
  type GoFile,
  IDENTIFIER,
  METHOD_DECLARATION,
  PARAMETER_DECLARATION,
  PARAMETER_LIST,
  PARENTHESIZED_EXPRESSION,
  RANGE_CLAUSE,
  SELECTOR_EXPRESSION,
  SHORT_VAR_DECLARATION,
  STRUCT_TYPE,
  TYPE_SPEC,
  TYPE_SWITCH_STATEMENT,
  type TsNode,
  UNARY_EXPRESSION,
  VARIADIC_PARAMETER_DECLARATION,
  VAR_DECLARATION,
  VAR_SPEC,
  baseTypeName,
  fieldNames,
  itemName,
  namedChildrenOfType,
  nearestAncestor,
  receiverTypeName,
  typeQualifier,
} from './go-cst.js';
import { namedChildren } from '../cst-kit/walk.js';
import { type GoPackageIndex, buildImportTable, resolveQualifier } from './go-imports.js';
import { repoDir } from '../glob.js';

// =============================================================================
// Public shapes
// =============================================================================

/** A named type resolved to the package that declares it. */
export interface GoTypeRef {
  /** The base type name — wrappers, generic arguments and the package qualifier stripped. */
  name: string;
  /** Repo-relative directory of the package that DECLARES it (a Go package IS a directory). */
  dir: string;
}

/**
 * What an operand expression denotes, as a three-way answer rather than `GoTypeRef | undefined`.
 *
 * The third state is the load-bearing one. A caller that sees `unbound` may legitimately re-read
 * the identifier as a package qualifier (`db.Find()`); one that sees `unresolved` must NOT, because
 * the name really is a variable here and reading it as a package would bind the call to a func in
 * some unrelated package. Collapsing the two into `undefined` is exactly how a shadowed import
 * fabricates an edge.
 */
export type GoOperand = { kind: 'type'; type: GoTypeRef } | { kind: 'unresolved' } | { kind: 'unbound' };

const UNRESOLVED: GoOperand = { kind: 'unresolved' };
const UNBOUND: GoOperand = { kind: 'unbound' };

/** The Tier-B holes this environment reports rather than papers over. */
export interface GoTypeGaps {
  /** Operands whose named type WAS decided and landed in a package. */
  resolved: number;
  /**
   * Operands bound to a value whose named type is not statically readable — an interface value, a
   * `range` element, a type-switch alias, a promoted field, or a type declared outside this repo's
   * in-scope packages. Dropped rather than guessed, and counted so the hole stays visible.
   */
  undecidable: number;
}

/** The shared type environment: one per parse, read by the entrypoint and call-graph lanes. */
export interface GoTypeEnv {
  /**
   * What `operand` denotes at its own position in `file`. Handles a bare `identifier` and a
   * `recv.field` `selector_expression`; every other expression shape answers `unresolved`.
   */
  resolveOperand(operand: TsNode, file: GoFile): GoOperand;
  gaps: GoTypeGaps;
}

// =============================================================================
// Repo-wide declaration indexes
// =============================================================================

/** A declaration plus the file that SPELLS it — the context its type expressions resolve in. */
interface GoDecl {
  file: GoFile;
  node: TsNode;
}

interface TypeIndexes {
  /** `${dir}#${funcName}` → package-scope func declarations. A list, so an ambiguous name drops. */
  funcs: Map<string, GoDecl[]>;
  /** `${dir}#${Type}` → (method name → declaration), for reading a method's declared result type. */
  methods: Map<string, Map<string, GoDecl>>;
  /** `${dir}#${Type}` → (field name → the declaring struct's `field_declaration`). */
  fields: Map<string, Map<string, GoDecl>>;
  /** `${dir}#${varName}` → package-scope `var_spec` (visible to every file of the package). */
  packageVars: Map<string, GoDecl>;
}

/**
 * Index the declarations a type inference can be read off, in one pass over the already-parsed
 * files. Everything is keyed by PACKAGE (directory) because that is Go's own scope: a type's
 * methods, its struct definition and the package's vars routinely sit in different files of the
 * same directory, and Go's rule guarantees they cannot sit anywhere else.
 */
function buildTypeIndexes(files: GoFile[]): TypeIndexes {
  const funcs = new Map<string, GoDecl[]>();
  const methods = new Map<string, Map<string, GoDecl>>();
  const fields = new Map<string, Map<string, GoDecl>>();
  const packageVars = new Map<string, GoDecl>();

  for (const file of files) {
    const dir = repoDir(file.relPath);

    for (const fn of file.root.descendantsOfType(FUNCTION_DECLARATION) as TsNode[]) {
      const name = itemName(fn);
      // A func nested in another func is reachable only through the value it is bound to, which is
      // not a name a package-scope lookup may answer with.
      if (!name || nearestAncestor(fn, FN_SCOPE_TYPES)) continue;
      const key = `${dir}#${name}`;
      const list = funcs.get(key) ?? [];
      list.push({ file, node: fn });
      funcs.set(key, list);
    }

    for (const decl of file.root.descendantsOfType(METHOD_DECLARATION) as TsNode[]) {
      const typeName = receiverTypeName(decl);
      const name = itemName(decl);
      if (!typeName || !name) continue;
      const key = `${dir}#${typeName}`;
      let m = methods.get(key);
      if (!m) {
        m = new Map<string, GoDecl>();
        methods.set(key, m);
      }
      if (!m.has(name)) m.set(name, { file, node: decl });
    }

    for (const spec of file.root.descendantsOfType(TYPE_SPEC) as TsNode[]) {
      const typeName = itemName(spec);
      const body = spec.childForFieldName?.('type') as TsNode | undefined;
      if (!typeName || body?.type !== STRUCT_TYPE) continue;
      const key = `${dir}#${typeName}`;
      let m = fields.get(key);
      if (!m) {
        m = new Map<string, GoDecl>();
        fields.set(key, m);
      }
      // An EMBEDDED field declares no name of its own and Go PROMOTES its members into the outer
      // struct; `fieldNames` returns nothing for it, so promotion stays an unfollowed gap rather
      // than resolving `outer.Member` against the wrong type.
      for (const fd of body.descendantsOfType(FIELD_DECLARATION) as TsNode[]) {
        for (const name of fieldNames(fd)) if (!m.has(name)) m.set(name, { file, node: fd });
      }
    }

    // Package-scope `var`s only. A `var` inside a function is found by the scope walk at the block
    // that owns it instead, so shadowing still resolves innermost-first.
    for (const decl of namedChildrenOfType(file.root, VAR_DECLARATION)) {
      for (const spec of namedChildrenOfType(decl, VAR_SPEC)) {
        for (const ident of namedChildrenOfType(spec, IDENTIFIER)) {
          const key = `${dir}#${ident.text as string}`;
          // Two files of one package declaring the same package-scope name is invalid Go, so the
          // first (files arrive sorted) is a read rather than a vote.
          if (!packageVars.has(key)) packageVars.set(key, { file, node: spec });
        }
      }
    }
  }

  return { funcs, methods, fields, packageVars };
}

/**
 * Go's PREDECLARED type names — the universe block, which belongs to no package.
 *
 * They must be refused rather than attributed to the writing file's directory. `func Run(db chan
 * int)` peels to the name `int`, and answering `${dir}#int` claims this package declares a type
 * called `int`: it inflates the resolved count with a type that exists nowhere, and it is one
 * same-named method away from a fabricated edge. Go does allow a package to shadow a predeclared
 * name (`type error struct{}` is legal), and this refuses that case too — the cost is a missing
 * edge on a spelling essentially no Go codebase uses, which is the direction this substrate errs in.
 */
const PREDECLARED_TYPES = new Set<string>([
  'any',
  'bool',
  'byte',
  'comparable',
  'complex64',
  'complex128',
  'error',
  'float32',
  'float64',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'rune',
  'string',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
]);

// =============================================================================
// Binding sites
// =============================================================================

/** Statement shapes that BIND a name in the scope that owns them. */
const BINDING_STATEMENTS = new Set<string>([SHORT_VAR_DECLARATION, VAR_DECLARATION, RANGE_CLAUSE]);

/** Parameter shapes, both spellings — `f(a int)` and `f(rest ...T)` are different node types. */
const PARAM_TYPES = new Set<string>([PARAMETER_DECLARATION, VARIADIC_PARAMETER_DECLARATION]);

/**
 * The binding constructs a scope node owns DIRECTLY.
 *
 * `block` holds statements; `if`/`switch` hold their initializer as a direct child; `for` holds
 * either a `range_clause` or a `for_clause` that wraps the initializer one level deeper. A
 * `type_switch_statement`'s `alias` is returned as a binding site precisely BECAUSE its type
 * differs per case: the search must stop there rather than fall through to an outer `x`.
 */
function bindingSitesOf(scope: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (const child of namedChildren(scope)) {
    if (BINDING_STATEMENTS.has(child.type)) out.push(child);
    else if (child.type === FOR_CLAUSE) {
      for (const inner of namedChildren(child)) if (BINDING_STATEMENTS.has(inner.type)) out.push(inner);
    }
  }
  if (scope.type === TYPE_SWITCH_STATEMENT) {
    const alias = scope.childForFieldName?.('alias') as TsNode | undefined;
    if (alias) out.push(alias);
  }
  return out;
}

/** Whether a binding construct declares `name`. */
function bindsName(site: TsNode, name: string): boolean {
  if (site.type === VAR_DECLARATION) {
    return namedChildrenOfType(site, VAR_SPEC).some((spec) => slotOf(spec, name) >= 0);
  }
  const left =
    site.type === SHORT_VAR_DECLARATION || site.type === RANGE_CLAUSE
      ? (site.childForFieldName?.('left') as TsNode | undefined)
      : site; // a type-switch `alias` IS the expression_list
  return slotOf(left, name) >= 0;
}

/** Position of `name` among a node's direct identifier children, or -1. */
function slotOf(left: TsNode | undefined, name: string): number {
  const items = namedChildren(left);
  for (let i = 0; i < items.length; i++) {
    if (items[i].type === IDENTIFIER && (items[i].text as string) === name) return i;
  }
  return -1;
}

/** Whether `outer` lexically contains `inner` (byte ranges, so it holds across node types). */
function contains(outer: TsNode, inner: TsNode): boolean {
  return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;
}

// =============================================================================
// The environment
// =============================================================================

/**
 * How far an inference may chase a value before giving up (`a := New(); b := a.Thing()`). A depth
 * cap rather than a visited set because the chain is a value flow, not a graph walk, and it also
 * bounds the field-access recursion. Without it a mutually-referential pair could recurse forever.
 */
const MAX_INFERENCE_DEPTH = 6;

/**
 * Build the shared type environment over the already-parsed files.
 *
 * `packageIndex` is what turns an import path into a repo DIRECTORY, so it is the gate that keeps
 * a stdlib or third-party type (`*chi.Mux`, `http.ResponseWriter`) from being attributed to a
 * same-named type of this repo's.
 */
export function buildGoTypeEnv(files: GoFile[], packageIndex: GoPackageIndex): GoTypeEnv {
  const idx = buildTypeIndexes(files);
  const gaps: GoTypeGaps = { resolved: 0, undecidable: 0 };

  /**
   * A type expression, as spelled in `file`, resolved to (name, declaring package directory).
   *
   * `file` is the file that WROTE the expression — a result type read off a func in another package
   * resolves in THAT package's file, never in the caller's.
   */
  function resolveTypeExpr(text: string | undefined, file: GoFile): GoTypeRef | undefined {
    const name = baseTypeName(text);
    if (!name) return undefined;
    const qualifier = typeQualifier(text);
    if (qualifier) {
      const importPath = resolveQualifier(buildImportTable(file), packageIndex, qualifier);
      const dir = importPath ? packageIndex.byImportPath.get(importPath) : undefined;
      // stdlib, third-party, or an in-repo package the profile's globs left out of scope — either
      // way there is no declaration in reach to resolve anything against.
      if (dir === undefined) return undefined;
      return { name, dir };
    }
    // An UNQUALIFIED name is declared in the writing file's own package — unless it is predeclared
    // (no package declares it), or a dot import could have dropped it in from somewhere else, which
    // the CST cannot tell us (see go-imports.ts).
    if (PREDECLARED_TYPES.has(name)) return undefined;
    if (buildImportTable(file).dotImports.length > 0) return undefined;
    return { name, dir: repoDir(file.relPath) };
  }

  /** The declared type of result slot `slot` of a func/method declaration. */
  function resultTypeRef(decl: GoDecl, slot: number): GoTypeRef | undefined {
    const result = decl.node.childForFieldName?.('result') as TsNode | undefined;
    if (!result) return undefined;
    // A single result IS the type expression; several are wrapped in a `parameter_list` whose
    // declarations are positional — which is what makes `x, err := New()` decidable.
    if (result.type !== PARAMETER_LIST) {
      return slot === 0 ? resolveTypeExpr(result.text as string, decl.file) : undefined;
    }
    const declared = namedChildren(result).filter((c) => PARAM_TYPES.has(c.type));
    const at = declared[slot];
    return at ? resolveTypeExpr(at.childForFieldName?.('type')?.text as string | undefined, decl.file) : undefined;
  }

  /** The single package-scope func declaration for a name, or undefined when absent or ambiguous. */
  function uniqueFunc(dir: string, name: string): GoDecl | undefined {
    const list = idx.funcs.get(`${dir}#${name}`);
    return list && list.length === 1 ? list[0] : undefined;
  }

  /** The type of result slot `slot` of a call expression, when the callee's declaration is known. */
  function callResultType(call: TsNode, slot: number, file: GoFile, depth: number): GoTypeRef | undefined {
    const callee = call.childForFieldName?.('function') as TsNode | undefined;
    if (!callee) return undefined;
    if (callee.type === IDENTIFIER) {
      const name = callee.text as string;
      // A bare callee names a func in the caller's OWN package by Go's scoping rule — UNLESS a
      // nearer lexical binding shadows it (`New := func() *B { … }`, or a `New func() *B` param).
      // Reading the package func through a shadow is not a harmless over-approximation: where the
      // two types share a method name — which is the whole reason to shadow a constructor — it
      // yields a confidently WRONG edge to the shadowed type's method, and a wrong edge is worse
      // than a missing one. The func value's own result is not read back: that needs the literal's
      // signature threaded through every binding form, and no caller needs the recall today.
      if (findBinding(name, callee, file)) return undefined;
      const decl = uniqueFunc(repoDir(file.relPath), name);
      return decl ? resultTypeRef(decl, slot) : undefined;
    }
    if (callee.type !== SELECTOR_EXPRESSION) return undefined;
    const operand = callee.childForFieldName?.('operand') as TsNode | undefined;
    const name = callee.childForFieldName?.('field')?.text as string | undefined;
    if (!operand || !name) return undefined;

    // `v.Method(…)` on a value whose type we know → the method's declared result.
    const base = operandKind(operand, file, depth + 1);
    if (base.kind === 'type') {
      const decl = idx.methods.get(`${base.type.dir}#${base.type.name}`)?.get(name);
      return decl ? resultTypeRef(decl, slot) : undefined;
    }
    if (base.kind === 'unresolved') return undefined;
    // `pkg.New(…)` — the operand names no variable in scope, so it may be read as a qualifier.
    const importPath = resolveQualifier(buildImportTable(file), packageIndex, operand.text as string);
    const dir = importPath ? packageIndex.byImportPath.get(importPath) : undefined;
    if (dir === undefined) return undefined;
    const decl = uniqueFunc(dir, name);
    return decl ? resultTypeRef(decl, slot) : undefined;
  }

  /** The named type an expression evaluates to, for the value-producing shapes that are decidable. */
  function expressionType(expr: TsNode | undefined, file: GoFile, depth: number): GoTypeRef | undefined {
    if (!expr || depth > MAX_INFERENCE_DEPTH) return undefined;
    switch (expr.type) {
      case COMPOSITE_LITERAL:
        return resolveTypeExpr(expr.childForFieldName?.('type')?.text as string | undefined, file);
      case UNARY_EXPRESSION: {
        // `&T{…}` — taking the address does not change which type is named.
        const inner = expr.childForFieldName?.('operand') as TsNode | undefined;
        return inner?.type === COMPOSITE_LITERAL ? expressionType(inner, file, depth + 1) : undefined;
      }
      case PARENTHESIZED_EXPRESSION:
        return expressionType(namedChildren(expr)[0], file, depth + 1);
      case CALL_EXPRESSION:
        return callResultType(expr, 0, file, depth);
      default:
        return undefined;
    }
  }

  /** The type of the value landing in slot `slot` of a `= …` / `:= …` right-hand side. */
  function valueSlotType(values: TsNode | undefined, slot: number, file: GoFile, depth: number): GoTypeRef | undefined {
    const items = namedChildren(values);
    if (items.length === 0) return undefined;
    // One expression per name — the ordinary case; pair them positionally.
    if (items.length > 1) return slot < items.length ? expressionType(items[slot], file, depth + 1) : undefined;
    if (slot === 0) return expressionType(items[0], file, depth + 1);
    // A single expression feeding SEVERAL names is Go's multi-value form. Only a call has declared
    // result slots to read off; `v, ok := m[k]` and `v, ok := x.(T)` do not.
    return items[0].type === CALL_EXPRESSION ? callResultType(items[0], slot, file, depth + 1) : undefined;
  }

  /**
   * The type a binding construct gives `name`, or undefined when the site binds it undecidably.
   *
   * The undefined case is NOT "keep looking": the caller must stop, because an inner binding really
   * does shadow every outer one and answering with the outer type would name the wrong variable.
   */
  function bindingType(site: TsNode, name: string, file: GoFile, depth: number): GoTypeRef | undefined {
    if (PARAM_TYPES.has(site.type)) {
      return resolveTypeExpr(site.childForFieldName?.('type')?.text as string | undefined, file);
    }
    if (site.type === VAR_DECLARATION) {
      const spec = namedChildrenOfType(site, VAR_SPEC).find((s) => slotOf(s, name) >= 0);
      return spec ? bindingType(spec, name, file, depth) : undefined;
    }
    if (site.type === VAR_SPEC) {
      const declared = site.childForFieldName?.('type')?.text as string | undefined;
      if (declared) return resolveTypeExpr(declared, file);
      return valueSlotType(site.childForFieldName?.('value') as TsNode | undefined, slotOf(site, name), file, depth);
    }
    if (site.type === SHORT_VAR_DECLARATION) {
      const slot = slotOf(site.childForFieldName?.('left') as TsNode | undefined, name);
      if (slot < 0) return undefined;
      return valueSlotType(site.childForFieldName?.('right') as TsNode | undefined, slot, file, depth);
    }
    // `for … range` element/key and a type-switch alias both take a type this substrate cannot read
    // off the CST — a real binding whose type is undecidable.
    return undefined;
  }

  /**
   * Walk the lexical scopes enclosing `use`, innermost first, for the binding of `name`.
   *
   * Returns the SITE and the file that DECLARES it, so the caller can tell "bound but undecidable"
   * from "not bound here" — the distinction the whole precision story rests on. Within one scope
   * the last binding that starts BEFORE the use wins, so a re-`:=` in the same block resolves to
   * the right one; a site that lexically CONTAINS the use is skipped, because in `a := a.B()` the
   * right-hand `a` is Go's outer variable, not the one being declared.
   */
  function findBinding(name: string, use: TsNode, file: GoFile): GoDecl | undefined {
    let cur: TsNode | null = use?.parent ?? null;
    while (cur) {
      if (FN_SCOPE_TYPES.has(cur.type)) {
        for (const list of [cur.childForFieldName?.('receiver'), cur.childForFieldName?.('parameters')]) {
          for (const param of namedChildren(list as TsNode | undefined)) {
            if (PARAM_TYPES.has(param.type) && slotOf(param, name) >= 0) return { file, node: param };
          }
        }
      }
      let best: TsNode | undefined;
      for (const site of bindingSitesOf(cur)) {
        if (site.startIndex >= use.startIndex || contains(site, use) || !bindsName(site, name)) continue;
        best = site;
      }
      if (best) return { file, node: best };
      cur = cur.parent;
    }
    // Package scope: visible to every file of the directory and NOT position-ordered (Go permits a
    // forward reference there), so it is a plain lookup rather than part of the ordered walk.
    return idx.packageVars.get(`${repoDir(file.relPath)}#${name}`);
  }

  /** `resolveOperand`, with the recursion depth the value-chasing paths thread through. */
  function operandKind(operand: TsNode, file: GoFile, depth: number): GoOperand {
    if (depth > MAX_INFERENCE_DEPTH) return UNRESOLVED;

    if (operand.type === SELECTOR_EXPRESSION) {
      // `recv.field` — the field's declared type, read off the struct that declares it.
      const base = operand.childForFieldName?.('operand') as TsNode | undefined;
      const field = operand.childForFieldName?.('field')?.text as string | undefined;
      if (!base || !field) return UNRESOLVED;
      const baseKind = operandKind(base, file, depth + 1);
      if (baseKind.kind !== 'type') return UNRESOLVED;
      const decl = idx.fields.get(`${baseKind.type.dir}#${baseKind.type.name}`)?.get(field);
      if (!decl) return UNRESOLVED;
      const ref = resolveTypeExpr(decl.node.childForFieldName?.('type')?.text as string | undefined, decl.file);
      return ref ? { kind: 'type', type: ref } : UNRESOLVED;
    }

    if (operand.type !== IDENTIFIER) return UNRESOLVED;
    const binding = findBinding(operand.text as string, operand, file);
    if (!binding) return UNBOUND;
    const ref = bindingType(binding.node, operand.text as string, binding.file, depth);
    return ref ? { kind: 'type', type: ref } : UNRESOLVED;
  }

  return {
    resolveOperand(operand: TsNode, file: GoFile): GoOperand {
      const result = operandKind(operand, file, 0);
      if (result.kind === 'type') gaps.resolved++;
      else if (result.kind === 'unresolved') gaps.undecidable++;
      return result;
    },
    gaps,
  };
}
