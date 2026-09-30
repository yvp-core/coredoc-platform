/**
 * `build.zig` module/executable map (BR-13a).
 *
 * `build.zig` is the only place a Zig repo names its modules and its executables, so the
 * import lane (BR-9b) and the entrypoint lane (BR-13) both read this map. It is NOT a build
 * evaluator: value resolution is exactly two substitutions — a local/top-level `const` by its
 * initializer (one level), and a `fn` parameter by the argument at the same position of each
 * call site of that `fn` inside `build.zig` (one exe/module per call site). Anything still
 * unresolved after that is skipped silently (LIM-E), and a missing or unparseable `build.zig`
 * yields empty maps rather than a throw.
 *
 * Grammar facts this file depends on (probed, not guessed): `call_expression` has a `function`
 * field and NO `arguments` node — the arguments are the named children AFTER the `function`
 * child; `.{ .a = b }` is `anonymous_struct_initializer > initializer_list >
 * assignment_expression[left = field_expression(.a), right]`; `&.{ … }` wraps that in a
 * `unary_expression`; a `string` carries its text in a `string_content` child.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseParsedTree } from '../../tree-sitter/tree-release.js';
import {
  MAX_CST_DEPTH,
  type TsNode,
  callArguments,
  calleeOf,
  initializerElements,
  initializerEntries,
  namedChildrenOfType,
  parseZig,
  sameNode,
} from './zig-cst.js';

/** What an identifier may stand for at one point of `build.zig`: call-site arguments + fn locals. */
interface Ctx {
  args: Map<string, TsNode>;
  locals?: Map<string, TsNode>;
}

/** Module name → repo-relative root source path; exe root source path → executable name. */
export interface ZigBuildMap {
  modules: Map<string, string>;
  exeByRoot: Map<string, string>;
}

/** Calls that produce a module whose `.root_source_file` we can read. */
const MODULE_CALLS = new Set(['createModule', 'addModule']);
/** `const` substitution + parameter substitution: at most one hop each (BR-13a). */
const MAX_SUBSTITUTIONS = 2;
/**
 * Call sites of ONE build.zig helper `fn` that get their parameters substituted, in source
 * order. A helper body is re-walked once per call site, so the work is sites × body: the cap
 * keeps a pathological build.zig (a loop-generated list of exes) from quadratic blow-up. Real
 * builds have a handful; the largest fixture here has three.
 */
const MAX_CALL_SITES_PER_HELPER = 16;
/**
 * Module names `@import` always answers from the toolchain. `build.zig` is ordinary user code
 * and may bind one of them (RT1); accepting it would redirect every `@import("std")` in the repo
 * at an in-repo file. Refused at the SOURCE so no consumer has to remember the rule.
 */
const RESERVED_MODULE_NAMES: ReadonlySet<string> = new Set(['std', 'builtin', 'root']);

/**
 * Parse `<root>/build.zig` into the module/exe maps. Never throws: any read/parse failure and
 * any unrecognised shape yields (partially) empty maps.
 */
export async function parseZigBuild(root: string): Promise<ZigBuildMap> {
  const map: ZigBuildMap = { modules: new Map(), exeByRoot: new Map() };
  let tree: TsNode | undefined;
  try {
    tree = await parseZig(await readFile(join(root, 'build.zig'), 'utf8'));
  } catch {
    // BR-13a: missing or unparseable build.zig → empty maps, never a throw. Only the READ and
    // the PARSE are guarded: a bug inside `collect` must surface, not read as an absent build.
  }
  if (!tree) return map;
  try {
    collect(tree, map);
  } finally {
    // web-tree-sitter never collects a tree: free it as soon as `collect` has read it.
    releaseParsedTree(tree);
  }
  return map;
}

// ---------------------------------------------------------------------------------------
// CST accessors (the shared ones live in `zig-cst.ts`; only the build-local name lookup here)
// ---------------------------------------------------------------------------------------

function walk(node: TsNode, visit: (n: TsNode) => void, skip?: (n: TsNode) => boolean, depth = 0): void {
  // Node depth is attacker-controlled (a generated `++` chain nests one node per operand):
  // past the cap the subtree is not descended rather than overflowing the stack.
  if (depth > MAX_CST_DEPTH) return;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (skip?.(child)) continue;
    visit(child);
    walk(child, visit, skip, depth + 1);
  }
}

/** `b.addModule(…)` → `addModule`; `addExe(…)` → `addExe`. */
function calleeName(call: TsNode): string | undefined {
  const fn = calleeOf(call);
  if (!fn) return undefined;
  if (fn.type === 'identifier') return fn.text as string;
  if (fn.type === 'field_expression') {
    const member = fn.childForFieldName?.('member');
    if (member) return member.text as string;
    return namedChildrenOfType(fn, 'identifier').at(-1)?.text as string | undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// BR-13a resolution
// ---------------------------------------------------------------------------------------

/** The `function_declaration` a node sits inside, if any — `build.zig`'s only scope boundary. */
function enclosingFn(node: TsNode): TsNode | undefined {
  for (let parent = node?.parent; parent; parent = parent.parent) {
    if (parent.type === 'function_declaration') return parent;
  }
  return undefined;
}

function rangeKey(node: TsNode): string {
  return `${node.startIndex}:${node.endIndex}`;
}

function collect(root: TsNode, map: ZigBuildMap): void {
  /** Every TOP-LEVEL `const`/`var` in build.zig. First binding wins. */
  const consts = new Map<string, TsNode>();
  /**
   * Function-local `const`s, keyed by the enclosing `fn`'s range. Two helpers may each declare
   * `const root = b.path("…")` with a DIFFERENT path; one flat table would give both exes the
   * first helper's file. A fn-local binding shadows a top-level one of the same name.
   */
  const fnConsts = new Map<string, Map<string, TsNode>>();
  /** Function name → parameter names, in order. */
  const fnParams = new Map<string, string[]>();
  const fns: TsNode[] = [];

  walk(root, (node) => {
    if (node.type === 'variable_declaration') {
      const name = namedChildrenOfType(node, 'identifier')[0]?.text as string | undefined;
      const value = node.namedChild(node.namedChildCount - 1);
      if (!name || !value || sameNode(value, node.namedChild(0))) return;
      const fn = enclosingFn(node);
      if (!fn) {
        if (!consts.has(name)) consts.set(name, value);
        return;
      }
      const scope = fnConsts.get(rangeKey(fn)) ?? new Map<string, TsNode>();
      if (!scope.has(name)) scope.set(name, value);
      fnConsts.set(rangeKey(fn), scope);
    } else if (node.type === 'function_declaration') {
      const name = node.childForFieldName?.('name')?.text as string | undefined;
      if (name && !fnParams.has(name)) {
        // `parameters` is a named CHILD, not a field (the probe prints only name/type/body).
        const params = namedChildrenOfType(node, 'parameters')[0];
        fnParams.set(
          name,
          params
            ? namedChildrenOfType(params, 'parameter').map(
                (p: TsNode) => (p.childForFieldName?.('name')?.text as string) ?? '',
              )
            : [],
        );
        fns.push(node);
      }
    }
  });

  /** Call sites of a build.zig-local `fn`, as parameter → argument-node bindings. */
  const callSites = new Map<string, Map<string, TsNode>[]>();
  walk(root, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = calleeOf(node);
    if (fn?.type !== 'identifier') return;
    const params = fnParams.get(fn.text as string);
    if (!params) return;
    const sites = callSites.get(fn.text as string) ?? [];
    if (sites.length >= MAX_CALL_SITES_PER_HELPER) return;
    const args = callArguments(node);
    const binding = new Map<string, TsNode>();
    params.forEach((param, i) => {
      const arg = args[i];
      if (param && arg) binding.set(param, arg);
    });
    sites.push(binding);
    callSites.set(fn.text as string, sites);
  });

  /**
   * Substitute an identifier by its parameter argument, then by the nearest `const` initializer
   * that is VISIBLE here: the enclosing fn's own locals first, top-level consts second.
   */
  const deref = (node: TsNode | undefined, ctx: Ctx): TsNode | undefined => {
    let current = node;
    for (let hop = 0; current?.type === 'identifier' && hop < MAX_SUBSTITUTIONS; hop++) {
      const name = current.text as string;
      const next = ctx.args.get(name) ?? ctx.locals?.get(name) ?? consts.get(name);
      if (!next) break;
      current = next;
    }
    return current;
  };

  const literal = (node: TsNode | undefined, ctx: Ctx): string | undefined => {
    const resolved = deref(node, ctx);
    if (resolved?.type !== 'string') return undefined;
    // NOT `zig-cst.stringValue`: an empty literal must read as undefined here (no usable path),
    // where the shared reader reports it as the empty string it genuinely is.
    return namedChildrenOfType(resolved, 'string_content')[0]?.text as string | undefined;
  };

  /** `b.path("src/main.zig")` → `src/main.zig`. */
  const pathOf = (node: TsNode | undefined, ctx: Ctx): string | undefined => {
    const resolved = deref(node, ctx);
    if (resolved?.type !== 'call_expression' || calleeName(resolved) !== 'path') return undefined;
    const value = literal(callArguments(resolved)[0], ctx);
    return value ? value.replace(/^\.\//, '') : undefined;
  };

  /** A module expression → its literal root source path, when it has one in this repo. */
  const modulePath = (node: TsNode | undefined, ctx: Ctx): string | undefined => {
    const resolved = deref(node, ctx);
    if (resolved?.type !== 'call_expression') return undefined;
    const callee = calleeName(resolved);
    if (!callee || !MODULE_CALLS.has(callee)) return undefined; // `dep.module("x")` is not in-repo
    const args = callArguments(resolved);
    const config = initializerEntries(args[args.length - 1]);
    return pathOf(config.get('root_source_file'), ctx);
  };

  const setModule = (name: string, path: string): void => {
    if (!RESERVED_MODULE_NAMES.has(name)) map.modules.set(name, path);
  };

  const recognize = (node: TsNode, ctx: Ctx): void => {
    if (node.type === 'assignment_expression') {
      // `.imports = &.{ .{ .name = "n", .module = m } }`
      const left = node.childForFieldName?.('left');
      if (namedChildrenOfType(left ?? node, 'identifier')[0]?.text !== 'imports') return;
      for (const element of initializerElements(node.childForFieldName?.('right'))) {
        const fields = initializerEntries(element);
        const name = literal(fields.get('name'), ctx);
        const path = modulePath(fields.get('module'), ctx);
        if (name && path) setModule(name, path);
      }
      return;
    }
    if (node.type !== 'call_expression') return;
    const args = callArguments(node);
    switch (calleeName(node)) {
      case 'addModule': {
        const name = literal(args[0], ctx);
        const path = pathOf(initializerEntries(args[1]).get('root_source_file'), ctx);
        if (name && path) setModule(name, path);
        return;
      }
      case 'addImport': {
        const name = literal(args[0], ctx);
        const path = modulePath(args[1], ctx);
        if (name && path) setModule(name, path);
        return;
      }
      case 'addExecutable': {
        const fields = initializerEntries(args[0]);
        const name = literal(fields.get('name'), ctx);
        const path = fields.has('root_module')
          ? modulePath(fields.get('root_module'), ctx)
          : pathOf(fields.get('root_source_file'), ctx);
        if (name && path) map.exeByRoot.set(path, name);
        return;
      }
      default:
        return;
    }
  };

  // Statements outside any `fn` run once; a `fn` body runs once per call site (its parameters
  // bound to that site's arguments), or once with no bindings when nothing calls it here.
  const noArgs = new Map<string, TsNode>();
  walk(
    root,
    (node) => recognize(node, { args: noArgs }),
    (node) => node.type === 'function_declaration',
  );
  for (const fn of fns) {
    const name = fn.childForFieldName?.('name')?.text as string;
    const body = fn.childForFieldName?.('body');
    if (!body) continue;
    const locals = fnConsts.get(rangeKey(fn));
    for (const args of callSites.get(name) ?? [noArgs]) {
      walk(body, (node) => {
        recognize(node, { args, locals });
      });
    }
  }
}
