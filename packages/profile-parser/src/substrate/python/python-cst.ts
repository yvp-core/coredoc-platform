/**
 * Shared tree-sitter-python CST helpers for the Python substrate. Generic Python —
 * no framework- or client-specific assumptions. The entrypoint / entity / db-op / egress /
 * call-graph extractors all build on these primitives.
 *
 * Two things that live ONCE here because every lane depends on them:
 *   1. Decorator machinery. `decorated_definition` WRAPS every decorated def/class; an
 *      extractor that forgets to unwrap silently misses every `@login_required` view and
 *      every `@shared_task` — so `undecorate` / `decoratorsOf` / `decoratorName` /
 *      `hasDecorator` are canonical here (review finding A4).
 *   2. `pythonFunctionId` — the canonical decl id keyed on the FULL enclosing scope chain
 *      (module → class → enclosing defs → name). Python decorator factories make same-named
 *      nested defs (`wrapper`, `inner`) ubiquitous; a flat file+name id would collapse
 *      hundreds of distinct functions and corrupt the call graph (spec Decision 2026-07-24).
 */
import type { StableIdGenerator } from '@coredoc/core';
import { type TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import { makeScopeChainId } from '../cst-kit/scope.js';
import { makeStringValueReader } from '../cst-kit/strings.js';
import { nearestAncestor } from '../cst-kit/walk.js';

// Re-exported: every extractor in this language's lane imports its node type from here.
export type { TsNode };

/** A parsed Python source file: repo-relative path, its text, and the CST root node. */
export interface PythonFile {
  relPath: string;
  source: string;
  root: TsNode;
}

// tree-sitter-python node types the substrate depends on.
export const FUNCTION_DEF = 'function_definition';
export const CLASS_DEF = 'class_definition';
export const DECORATED_DEF = 'decorated_definition';
export const CALL = 'call';
export const ATTRIBUTE = 'attribute';
export const STRING = 'string';

/** Node types that represent a Python function/method definition. */
export const DEF_TYPES = new Set<string>([FUNCTION_DEF]);
/** Node types that represent a Python class definition. */
export const CLASS_TYPES = new Set<string>([CLASS_DEF]);
/** Def + class — the nodes that introduce a lexical scope (for the scope chain). */
const SCOPE_TYPES = new Set<string>([FUNCTION_DEF, CLASS_DEF]);

export { nearestAncestor };

/**
 * The literal value of a `string` node: its first `string_content` piece, delimiters and any
 * `f`/`r`/`b` prefix left to the CST. Undefined for a node that is not a string, and for a string
 * that has no literal content at all (`f"{x}"`).
 *
 * The FIRST piece only: in an interpolated string the `interpolation` children sit BETWEEN the
 * content pieces, so concatenating them would read `f"a{x}b"` as the literal `ab` — a path or
 * table name that is not the one the code uses. A lane that wants the whole template renders the
 * interpolations itself (`python-egress`, `python-dbops`).
 */
export const stringValue = makeStringValueReader({
  stringNodeTypes: new Set([STRING]),
  contentChildTypes: new Set(['string_content']),
});

/** The `name` field text of a function/class definition. */
export function defName(node: TsNode): string | undefined {
  return (node.childForFieldName?.('name')?.text ?? undefined) as string | undefined;
}

/** Whether a `function_definition` is `async` (its first child token is `async`). */
export function isAsyncDef(node: TsNode): boolean {
  return node.child?.(0)?.type === 'async';
}

/**
 * The dotted names in a class's superclass list, skipping keyword args (e.g. `metaclass=`).
 * Verbatim source text — `class X(UUIDModel, mixins.Named)` → ['UUIDModel', 'mixins.Named'].
 * Shared because both the entity lane (is-this-a-model) and the class lane (base capture, which
 * a later Django base-transitivity pass reads) must agree on what a base IS.
 */
export function baseNames(classNode: TsNode): string[] {
  const supers = classNode.childForFieldName?.('superclasses');
  if (!supers) return [];
  const out: string[] = [];
  for (let i = 0; i < supers.childCount; i++) {
    const c = supers.child(i);
    if (c?.isNamed && c.type !== 'keyword_argument') out.push(c.text as string);
  }
  return out;
}

/**
 * The TEXT of a def's return annotation (`-> dict[str, Any]` → 'dict[str, Any]'), or undefined
 * when unannotated. Text only: Python annotations are arbitrary expressions (and often strings
 * under `from __future__ import annotations`), so the substrate records the spelling and leaves
 * resolution to consumers.
 */
export function returnTypeText(def: TsNode): string | undefined {
  const t = def.childForFieldName?.('return_type');
  const text = (t?.text ?? undefined) as string | undefined;
  return text && text.length > 0 ? text : undefined;
}

// =============================================================================
// Decorator machinery — MUST live once here (review finding A4)
// =============================================================================

/** A `decorated_definition` → its inner function/class def; passthrough for any other node. */
export function undecorate(node: TsNode): TsNode {
  if (node?.type === DECORATED_DEF) {
    return node.childForFieldName?.('definition') ?? node;
  }
  return node;
}

/** The decorator nodes on a def/class (via its `decorated_definition` parent); [] if none. */
export function decoratorsOf(defNode: TsNode): TsNode[] {
  const parent = defNode?.parent;
  if (!parent || parent.type !== DECORATED_DEF) return [];
  const out: TsNode[] = [];
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c?.type === 'decorator') out.push(c);
  }
  return out;
}

/**
 * The dotted name a decorator applies:
 *   `@shared_task`        → 'shared_task'   (identifier)
 *   `@app.task`           → 'app.task'      (attribute)
 *   `@router.get("/x")`   → 'router.get'    (call — the callee's dotted name)
 */
export function decoratorName(decorator: TsNode): string {
  // decorator children: `@` then one of identifier | attribute | call.
  let value: TsNode | undefined;
  for (let i = 0; i < decorator.childCount; i++) {
    const c = decorator.child(i);
    if (c && c.type !== '@') {
      value = c;
      break;
    }
  }
  if (!value) return '';
  if (value.type === CALL) {
    const callee = value.childForFieldName?.('function');
    return (callee?.text ?? value.text ?? '') as string;
  }
  return (value.text ?? '') as string;
}

/** Whether a decorator's dotted name matches `name` exactly or by dotted suffix ('task' ⊂ 'app.task'). */
function nameMatches(decName: string, name: string): boolean {
  return decName === name || decName.endsWith(`.${name}`);
}

/** Whether the def carries any decorator whose dotted name matches one of `names` (exact or suffix). */
export function hasDecorator(defNode: TsNode, names: string[]): boolean {
  const decs = decoratorsOf(defNode).map(decoratorName);
  return decs.some((d) => names.some((n) => nameMatches(d, n)));
}

/**
 * The `name=` keyword argument of a matching decorator factory, if it is a string literal.
 *
 * `@shared_task(name='billing.charge')` renames the task, and the routing key a producer
 * sends (`send_task('billing.charge')`) is that name, not the def's. Reading the def name
 * instead makes the consumer entrypoint unjoinable from the producer side — the task looks
 * present but no cross-repo edge can ever land on it.
 */
export function decoratorNameKwarg(defNode: TsNode, names: string[]): string | undefined {
  for (const dec of decoratorsOf(defNode)) {
    if (!names.some((n) => nameMatches(decoratorName(dec), n))) continue;
    const call = dec.descendantsOfType(CALL)[0] as TsNode | undefined;
    const args = call?.childForFieldName?.('arguments');
    const count = args?.namedChildCount ?? 0;
    for (let i = 0; i < count; i++) {
      const a = args.namedChild?.(i) as TsNode | undefined;
      if (a?.type !== 'keyword_argument') continue;
      if ((a.childForFieldName?.('name')?.text as string | undefined) !== 'name') continue;
      const v = a.childForFieldName?.('value') as TsNode | undefined;
      const text = stringValue(v);
      if (text) return text;
    }
  }
  return undefined;
}

// =============================================================================
// Canonical decl id — full enclosing scope chain (spec Decision 2026-07-24)
// =============================================================================

/**
 * The enclosing class/def names of a def, OUTERMOST first, excluding the def itself.
 * `decorated_definition` is transparent (we collect the class/function_definition inside it).
 * async / @staticmethod / @classmethod do NOT enter the chain — the id is normalized.
 */
/** A class or def contributes its own name; an unnamed node in the chain contributes nothing. */
function namedSegment(node: TsNode): string[] {
  const n = defName(node);
  return n ? [n] : [];
}

const pythonScope = makeScopeChainId({ scopeNodeTypes: SCOPE_TYPES, segmentsOf: namedSegment, separator: '.' });

export const pythonScopeChain = pythonScope.chain;

/**
 * Canonical id for a Python function/method def, keyed on its full enclosing scope chain.
 * Module-level defs → `functionId(file, name)`; anything nested (in a class and/or an
 * enclosing def) → `methodId(file, scope.join('.'), name)`. Used by BOTH the call-graph def
 * index and the db-op performer minting so the ids match for one def.
 *
 * Boundary: same-scope `@overload` / `@singledispatch` redefinitions collapse onto one id
 * (a documented collapse, like Swift's same-name overloads).
 */
export function pythonFunctionId(idGen: StableIdGenerator, relPath: string, defNode: TsNode): string {
  return pythonScope.id(idGen, relPath, defNode, { name: defName(defNode) ?? '(anonymous)' });
}

/** The enclosing `class_definition` names of a node, outermost first (for classId scoping). */
export const pythonClassChain = makeScopeChainId({
  scopeNodeTypes: CLASS_TYPES,
  segmentsOf: namedSegment,
  separator: '.',
}).chain;

// =============================================================================
// File discovery (S3)
// =============================================================================

/**
 * Built-in default excludes for Python repos. These SHIP in code (spec DX D5a — defaults are
 * first-class, not a doc suggestion); a profile's `exclude` EXTENDS them and `excludeDefaults:
 * false` opts out entirely. The node_modules glob is also a hard enumerator floor
 * (`enumerateRepoFiles` prunes it even when tracked) — listed here for completeness.
 */
export const DEFAULT_PY_EXCLUDES: string[] = [
  '**/venv/**',
  '**/.venv/**',
  '**/site-packages/**',
  '**/__pycache__/**',
  '**/node_modules/**',
  '**/migrations/**',
  '**/*_pb2.py',
];

/**
 * The source extensions the Python substrate parses. `.pyi` stubs are ordinary Python syntax and
 * are the ONLY declaration site for a typed C-extension / re-export surface, so dropping them lost
 * real defs (3 files / 32 defs on the posthog audit). A stub and its `.py` sibling map to the same
 * dotted module; the module index keeps the `.py` (registered first in sorted order).
 */
export const PY_SOURCE_EXTENSIONS = ['.py', '.pyi'] as const;

/** Default include globs — every Python source extension, repo-wide. */
export const DEFAULT_PY_INCLUDES: string[] = ['**/*.py', '**/*.pyi'];

/**
 * Python sources in scope: the gitignore-honoring repo walk (`enumerateRepoFiles`) filtered to
 * `.py`/`.pyi` + the profile's include/exclude globs. An empty `include` defaults to
 * `DEFAULT_PY_INCLUDES`; the effective exclude is `DEFAULT_PY_EXCLUDES` plus the profile's
 * `exclude` unless `excludeDefaults === false`, when only the profile's `exclude` applies. Shared
 * by the parser and the scorer.
 */
export const discoverPythonFileScope = makeFileScopeDiscoverer({
  extensions: PY_SOURCE_EXTENSIONS,
  defaultInclude: DEFAULT_PY_INCLUDES,
  defaultExclude: DEFAULT_PY_EXCLUDES,
});
