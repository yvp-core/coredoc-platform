/**
 * Cross-file Grape MOUNT/PREFIX resolver — generic Grape DSL, no client-specific
 * assumptions. Grape route paths assemble across files: a ROOT mount (`mount X => "/p"`,
 * typically in `config/routes.rb` or a top-level API file) supplies the leading prefix, the
 * mounted root API holds pathless INTERNAL mounts (`mount Sub`) of sub-APIs, and the leaf
 * classes hold the actual route verbs. This resolver composes each route's FULL path:
 *
 *     full = (root mount prefix)  +  (every internal-mount hop, all pathless → no segment)
 *            +  (the class's in-file relative route, from grapeRoutesFromRoot)
 *
 * Classes never reached by any mount fall back to their relative path (best-effort, so no
 * route is lost). Class names are resolved by SUFFIX-matching the registry of fully-qualified
 * names, so `mount Companies` / `mount WithUser::Companies` both find `A::B::Companies`.
 */
import { grapeRoutesFromRoot } from './grape-routes.js';
import { type TsNode, collectCalls, methodName, normalizePath, withParsedRuby, tokenText } from './ruby-cst.js';

export interface GrapeEntrypoint {
  method: string;
  path: string;
  file: string;
  line: number;
}

interface GrapeClass {
  /** Fully-qualified class name, e.g. `Mobile::WithUser::Companies`. */
  fqn: string;
  file: string;
  /** Routes relative to this class (no root-mount prefix). */
  relativeRoutes: Array<{ method: string; path: string; line: number }>;
  /** Pathless `mount Sub` targets (raw class refs, resolved later by suffix match). */
  internalMounts: string[];
}

/** A `mount X => "/prefix"` root mount: the raw class ref + its prefix. */
interface RootMount {
  classRef: string;
  prefix: string;
}

/** A class/module DEFINITION node has a `name` field; the bare `class`/`module` keyword token does not. */
function isDefinition(node: TsNode): boolean {
  return (node.type === 'class' || node.type === 'module') && !!node.childForFieldName?.('name');
}

/**
 * The constant text of a class/module definition's name (`constant` → "Companies",
 * `scope_resolution` → "Mobile::API"). Returns the as-written text (may itself be qualified).
 */
function definitionName(node: TsNode): string | undefined {
  return node.childForFieldName?.('name')?.text;
}

/**
 * Fully-qualified name of a definition node by walking UP through enclosing module/class
 * definitions and prefixing their (possibly already-qualified) names. `module A; module B;
 * class C` → `A::B::C`.
 */
function fqnOf(node: TsNode): string {
  const parts: string[] = [];
  let cur: TsNode | null = node;
  while (cur) {
    if (isDefinition(cur)) {
      const name = definitionName(cur);
      if (name) parts.unshift(name);
    }
    cur = cur.parent;
  }
  return parts.join('::');
}

/** Whether a call node is a `mount …` command. */
function isMountCall(node: TsNode): boolean {
  return methodName(node) === 'mount';
}

/**
 * The single argument node of a `mount` call (`mount Companies` → the `constant`/`scope_resolution`,
 * `mount X => "/p"` → the `pair`). Returns undefined if there is no argument.
 */
function mountArg(node: TsNode): TsNode | undefined {
  const list = node.descendantsOfType('argument_list')[0] as TsNode | undefined;
  if (!list) return undefined;
  for (let i = 0; i < list.childCount; i++) {
    const c = list.child(i);
    if (c && c.type !== '(' && c.type !== ')' && c.type !== ',') return c;
  }
  return undefined;
}

/** Parse one Grape class definition node into a registry entry. */
function classFromDefinition(node: TsNode, file: string): GrapeClass {
  const fqn = fqnOf(node);
  const relativeRoutes = grapeRoutesFromRoot(node);
  const internalMounts: string[] = [];
  for (const call of collectCalls(node)) {
    if (!isMountCall(call)) continue;
    const arg = mountArg(call);
    // Pathless internal mount: the arg is a bare class ref (constant / scope_resolution).
    // `mount X => "/p"` (a `pair`) is a PREFIX mount, handled as a root mount, not a chain edge.
    if (arg && (arg.type === 'constant' || arg.type === 'scope_resolution')) {
      internalMounts.push(arg.text);
    }
  }
  return { fqn, file, relativeRoutes, internalMounts };
}

/** Extract `mount X => "/prefix"` root mounts from any call in the tree. */
function rootMountsFromCall(call: TsNode): RootMount | undefined {
  if (!isMountCall(call)) return undefined;
  const arg = mountArg(call);
  if (!arg || arg.type !== 'pair') return undefined;
  const key = arg.childForFieldName('key') ?? arg.child(0);
  const value = arg.childForFieldName('value') ?? arg.child(arg.childCount - 1);
  if (!key || !value) return undefined;
  if (key.type !== 'constant' && key.type !== 'scope_resolution') return undefined;
  if (value.type !== 'string') return undefined;
  return { classRef: key.text, prefix: tokenText(value) };
}

/**
 * Resolve a raw class ref (`Companies`, `WithUser::Companies`, `Mobile::API`) to a registered
 * FQN by suffix match: the registered FQN equals the ref or ends with `::<ref>`. Returns the
 * FIRST match; ambiguity is rare in practice and resolving to any matching class is best-effort.
 */
function resolveRef(ref: string, registry: Map<string, GrapeClass>): GrapeClass | undefined {
  const direct = registry.get(ref);
  if (direct) return direct;
  const suffix = `::${ref}`;
  for (const cls of registry.values()) {
    if (cls.fqn.endsWith(suffix)) return cls;
  }
  return undefined;
}

export async function resolveGrapeEntrypoints(
  files: Array<{ relPath: string; source: string }>,
): Promise<GrapeEntrypoint[]> {
  const registry = new Map<string, GrapeClass>();
  const rootMounts: RootMount[] = [];

  // Sort by relPath so registry insertion order — and therefore resolveRef's
  // first-suffix-match — is deterministic regardless of caller file order.
  const sortedFiles = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Pass 1: build the class registry + collect root mounts across all files.
  for (const { relPath, source } of sortedFiles) {
    await withParsedRuby(source, (root) => {
      const defs = [
        ...(root.descendantsOfType('class') as TsNode[]),
        ...(root.descendantsOfType('module') as TsNode[]),
      ].filter(isDefinition);
      for (const def of defs) {
        // A Grape class is a leaf `class` with routes or internal mounts. Modules are namespaces
        // (they show up only via fqnOf); we still register every `class` def so suffix-match works.
        if (def.type !== 'class') continue;
        const cls = classFromDefinition(def, relPath);
        registry.set(cls.fqn, cls);
      }

      for (const call of collectCalls(root)) {
        const rm = rootMountsFromCall(call);
        if (rm) rootMounts.push(rm);
      }
    });
  }

  // Pass 2: DFS from each root mount, accumulating the prefix; emit visited classes' routes.
  const out: GrapeEntrypoint[] = [];
  const visited = new Set<string>();

  const emit = (cls: GrapeClass, prefix: string): void => {
    for (const r of cls.relativeRoutes) {
      out.push({
        method: r.method,
        path: prefix ? normalizePath([prefix, r.path]) : r.path,
        file: cls.file,
        line: r.line,
      });
    }
  };

  const walk = (cls: GrapeClass, prefix: string): void => {
    if (visited.has(cls.fqn)) return;
    visited.add(cls.fqn);
    emit(cls, prefix);
    // Internal mounts are pathless → the prefix is unchanged down the chain.
    for (const ref of cls.internalMounts) {
      const target = resolveRef(ref, registry);
      if (target) walk(target, prefix);
    }
  };

  for (const rm of rootMounts) {
    const cls = resolveRef(rm.classRef, registry);
    if (cls) walk(cls, rm.prefix);
  }

  // Pass 3: classes never reached by any mount → emit their relative routes with NO prefix.
  for (const cls of registry.values()) {
    if (visited.has(cls.fqn)) continue;
    visited.add(cls.fqn);
    emit(cls, '');
  }

  return out;
}
