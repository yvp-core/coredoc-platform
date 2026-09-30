/**
 * Components, layouts and routes (§Components, layouts and routes).
 *
 * Two component shapes: a `@Composable` function and an Activity/Fragment class. A ROUTE is a
 * DECLARED DESTINATION only — a navigation-XML destination or a `composable("literal")` — and
 * screen-to-screen navigation (`Intent(…, X::class.java)`, a fragment transaction,
 * `navigate(…)`) is component USAGE on the source component, never a route.
 *
 * `routeId` takes a single string and hashes only it, while route paths repeat across a
 * repository, so every route id is keyed `<file>#<name>`: without the file two unrelated
 * destinations silently merge into one node.
 */
import type { StableIdGenerator } from '@coredoc/core';
import type { ComponentNode, RouteNode } from '@coredoc/core/types';
import {
  argValue,
  calleeChain,
  FUNCTION_DECL,
  functionName,
  hasInterpolation,
  locationOf,
  SIMPLE_IDENTIFIER,
  stringValue,
  type TsNode,
} from './kotlin-cst.js';
import type { KotlinCallSite, KotlinFileFacts, KotlinTypeDecl } from './kotlin-declarations.js';
import { type AndroidBases, classifyAndroidClass, resolveDeclaredName } from './kotlin-entrypoints.js';
import { resolveLayoutFile } from './kotlin-gradle.js';
import type { KotlinTypeIndex } from './kotlin-resolve.js';
import type { NavGraphFacts } from './kotlin-xml.js';

const COMPOSABLE = 'Composable';
/** Fragment-transaction verbs that take the destination fragment as an argument. */
const TRANSACTION_VERBS = new Set(['replace', 'add']);

export interface KotlinComponentsInput {
  facts: readonly KotlinFileFacts[];
  index: KotlinTypeIndex;
  bases: AndroidBases;
  idGen: StableIdGenerator;
  /** Parsed `res/navigation/*.xml`, in discovery order. */
  navGraphs: readonly NavGraphFacts[];
  /** `res/layout/*.xml` paths of the in-scope source sets, for the layout link. */
  layoutFiles: readonly string[];
}

export interface KotlinComponentsResult {
  components: ComponentNode[];
  routes: RouteNode[];
}

/** An emitted component plus what the usage and route passes need to look it up. */
interface Emitted {
  node: ComponentNode;
  file: KotlinFileFacts;
  /** Source range of the function or class body, for attributing call sites. */
  start: number;
  end: number;
  /** Set for a class component. */
  decl?: KotlinTypeDecl;
  kind?: 'activity' | 'fragment';
  /** Set for a composable. */
  composableName?: string;
}

/** `HomeScreenBinding` → `home_screen`; the layout file name Android generates it from. */
export function bindingToLayoutName(binding: string): string {
  return binding
    .replace(/Binding$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * The first resolvable layout reference in a class body: `R.layout.<name>` or a
 * `<Pascal>Binding.inflate` / `.bind` receiver. Read from the declaration's SOURCE TEXT in
 * order — the references sit in arguments, receivers and property initialisers alike, and a
 * second tree walk would buy nothing. An unresolvable name sets nothing.
 */
export function findLayoutFile(source: string, layoutFiles: readonly string[]): string | undefined {
  // The binding alternative is anchored on a non-word boundary: an unanchored `(\w+)Binding`
  // restarts inside every word-character run and backtracks to its end, which is quadratic on a
  // long run (a generated file, a base64 literal) — seconds of CPU for a class body with no
  // binding in it at all.
  const pattern = /R\.layout\.(\w+)|(?:^|[^\w.])(\w+)Binding\s*\.\s*(?:inflate|bind)\b/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1] ?? bindingToLayoutName(`${match[2]}Binding`);
    const hit = resolveLayoutFile(name, layoutFiles);
    if (hit) return hit;
  }
  return undefined;
}

function contains(emitted: Emitted, node: TsNode): boolean {
  return node.startIndex >= emitted.start && node.endIndex <= emitted.end;
}

/**
 * Whether the call is written as a BARE `Name()` — the only shape that invokes a composable of
 * this repository. `isMethodCall` cannot answer it: it is derived from the callee TEXT, which
 * keeps only the member names when the chain root is not a plain identifier, so
 * `factory().Screen()` reaches it looking exactly like `Screen()`. The chain root is the fact.
 */
function isBareCall(call: KotlinCallSite): boolean {
  const chain = calleeChain(call.node);
  return !!chain && chain.root.type === SIMPLE_IDENTIFIER && chain.members.length === 0;
}

/** `X::class.java`, `X::class` or `X()` written as an argument → the type name. */
function argTypeName(arg: TsNode): string | undefined {
  const text = ((argValue(arg) ?? arg).text as string).trim();
  const classRef = /^([\w.]+)::class(?:\.java)?$/.exec(text);
  if (classRef) return classRef[1];
  const ctor = /^([A-Z][\w.]*)\(\s*\)$/.exec(text);
  return ctor ? ctor[1] : undefined;
}

/** `R.id.home` written as an argument → `home`. */
function argResourceId(arg: TsNode): string | undefined {
  const m = /^R\.id\.(\w+)$/.exec(((argValue(arg) ?? arg).text as string).trim());
  return m ? m[1] : undefined;
}

export function extractKotlinComponents(input: KotlinComponentsInput): KotlinComponentsResult {
  const { facts, index, bases, idGen, navGraphs, layoutFiles } = input;
  const byPath = new Map(facts.map((f) => [f.relPath, f]));
  const emitted: Emitted[] = [];
  const byFqcn = new Map<string, Emitted>();
  const composablesByName = new Map<string, Emitted[]>();

  // --- Components -----------------------------------------------------------
  for (const file of facts) {
    for (const fn of file.annotationIndex.get(COMPOSABLE) ?? []) {
      if (fn.type !== FUNCTION_DECL) continue;
      const name = functionName(fn);
      if (!name) continue;
      const id = idGen.componentId(file.relPath, name);
      if (composablesByName.get(name)?.some((c) => c.file.relPath === file.relPath)) continue;
      const node: ComponentNode = {
        kind: 'component',
        id,
        versionedId: idGen.versionedId(id, fn.text as string),
        name,
        fileId: file.fileId,
        framework: 'compose',
        componentType: 'functional',
        location: locationOf(fn, file.relPath),
      };
      const entry: Emitted = {
        node,
        file,
        start: fn.startIndex,
        end: fn.endIndex,
        composableName: name,
      };
      emitted.push(entry);
      const bucket = composablesByName.get(name);
      if (bucket) bucket.push(entry);
      else composablesByName.set(name, [entry]);
    }

    for (const decl of file.declarations.values()) {
      const kind = classifyAndroidClass(decl, index, byPath, bases);
      if (kind !== 'activity' && kind !== 'fragment') continue;
      const id = idGen.componentId(file.relPath, decl.qualifiedName);
      const templateFile = findLayoutFile(decl.node.text as string, layoutFiles);
      const node: ComponentNode = {
        kind: 'component',
        id,
        versionedId: idGen.versionedId(id, decl.node.text as string),
        name: decl.qualifiedName,
        fileId: file.fileId,
        framework: 'android',
        componentType: 'class',
        location: decl.location,
        ...(templateFile ? { templateFile } : {}),
      };
      const entry: Emitted = { node, file, start: decl.node.startIndex, end: decl.node.endIndex, decl, kind };
      emitted.push(entry);
      byFqcn.set(decl.fqcn, entry);
    }
  }

  /** The single composable a call name refers to: same file first, then a unique name. */
  const resolveComposable = (name: string, file: KotlinFileFacts): Emitted | undefined => {
    const candidates = composablesByName.get(name) ?? [];
    const local = candidates.filter((c) => c.file.relPath === file.relPath);
    const pool = local.length > 0 ? local : candidates;
    return pool.length === 1 ? pool[0] : undefined;
  };

  /** Call sites of each file, so every pass reads the one recorded list. */
  const callsOf = (entry: Emitted): KotlinCallSite[] => entry.file.calls.filter((c) => contains(entry, c.node));

  /**
   * Append one usage to the source component, at most once per call site. A call with value
   * arguments AND a trailing lambda is TWO nested `call_expression`s and is therefore recorded
   * twice; both share a start offset, which is what dedupes them (node wrappers are not
   * identity-stable, so offsets are the only safe key).
   */
  const usageSeen = new Set<string>();
  const appendUsage = (entry: Emitted, target: Emitted | undefined, call: KotlinCallSite) => {
    if (!target || target.node.id === entry.node.id) return;
    const key = `${entry.node.id}|${target.node.id}|${call.node.startIndex}`;
    if (usageSeen.has(key)) return;
    usageSeen.add(key);
    const usages = entry.node.childComponents ?? [];
    usages.push({ componentId: target.node.id, componentName: target.node.name, location: call.location });
    entry.node.childComponents = usages;
  };

  // --- childComponents of a composable --------------------------------------
  for (const entry of emitted) {
    if (!entry.composableName) continue;
    for (const call of callsOf(entry)) {
      if (!isBareCall(call)) continue;
      const target = resolveComposable(call.name, entry.file);
      if (!target) continue;
      appendUsage(entry, target, call);
    }
  }

  // --- Routes: navigation XML destinations ----------------------------------
  const routes: RouteNode[] = [];
  /** Destination id → the route it declared, for `navigate(R.id.x)`. */
  const routesByDestId = new Map<string, RouteNode[]>();
  for (const graph of navGraphs) {
    const routeIdOf = (destId: string) => idGen.routeId(`${graph.filePath}#${destId}`);
    for (const dest of graph.destinations) {
      const target = dest.componentName ? resolveDeclaredName(dest.componentName, index) : undefined;
      const component = target ? byFqcn.get(target.fqcn) : undefined;
      const route: RouteNode = {
        id: routeIdOf(dest.id),
        path: dest.id,
        componentName: dest.componentName ?? dest.id,
        ...(component ? { componentId: component.node.id } : {}),
        ...(dest.parentId ? { parentRouteId: routeIdOf(dest.parentId) } : {}),
        meta: {
          file: graph.filePath,
          ...(dest.startDestination ? { startDestination: dest.startDestination } : {}),
          actions: dest.actions,
        },
        isLazy: false,
      };
      routes.push(route);
      const bucket = routesByDestId.get(dest.id);
      if (bucket) bucket.push(route);
      else routesByDestId.set(dest.id, [route]);
    }
  }

  // --- Routes: `composable("literal")` inside an emitted composable ----------
  /** Route path → the composable routes declaring it, for `navigate("route")`. */
  const routesByPath = new Map<string, RouteNode[]>();
  const routeSeen = new Set<string>();
  for (const entry of emitted) {
    if (!entry.composableName) continue;
    for (const call of callsOf(entry)) {
      if (call.name !== 'composable') continue;
      const routeArg = argValue(call.args[0]);
      // `composable("$ROUTE/detail")` renders as `{ROUTE}/detail`, a path that exists nowhere.
      if (hasInterpolation(routeArg)) continue;
      const path = stringValue(routeArg);
      if (path === undefined) continue; // a non-literal route names nothing knowable
      const routeKey = idGen.routeId(`${entry.file.relPath}#${path}`);
      if (routeSeen.has(routeKey)) continue; // the outer and inner node of `composable(x) { }`
      routeSeen.add(routeKey);
      const screen = entry.file.calls
        .filter((c) => c.node.startIndex > call.node.startIndex && c.node.endIndex <= call.node.endIndex)
        .sort((a, b) => a.node.startIndex - b.node.startIndex)
        .map((c) => resolveComposable(c.name, entry.file))
        .find((c): c is Emitted => !!c);
      const route: RouteNode = {
        id: routeKey,
        path,
        componentName: screen?.node.name ?? path,
        ...(screen ? { componentId: screen.node.id } : {}),
        meta: { navHost: entry.composableName },
        isLazy: false,
        location: call.location,
      };
      routes.push(route);
      const bucket = routesByPath.get(path);
      if (bucket) bucket.push(route);
      else routesByPath.set(path, [route]);
    }
  }

  // --- Screen-to-screen navigation → ComponentUsage on the source ------------
  const sole = (list: RouteNode[] | undefined): RouteNode | undefined => (list?.length === 1 ? list[0] : undefined);
  const componentById = new Map(emitted.map((e) => [e.node.id, e]));

  const targetOfRoute = (route: RouteNode | undefined): Emitted | undefined =>
    route?.componentId ? componentById.get(route.componentId) : undefined;

  for (const entry of emitted) {
    for (const call of callsOf(entry)) {
      // `Intent(<ctx>, X::class.java)`
      if (call.name === 'Intent') {
        for (const arg of call.args) {
          const typeName = argTypeName(arg);
          if (!typeName) continue;
          const hit = index.resolve(typeName, entry.file);
          if (hit.status === 'resolved') appendUsage(entry, byFqcn.get(hit.decl.fqcn), call);
        }
        continue;
      }
      // Fragment transaction: `replace(R.id.container, HomeFragment())`
      if (TRANSACTION_VERBS.has(call.name)) {
        for (const arg of call.args) {
          const typeName = argTypeName(arg);
          if (!typeName) continue;
          const hit = index.resolve(typeName, entry.file);
          if (hit.status !== 'resolved') continue;
          const target = byFqcn.get(hit.decl.fqcn);
          if (target?.kind === 'fragment') appendUsage(entry, target, call);
        }
        continue;
      }
      // `navigate(R.id.x)` / `navigate("route")`
      if (call.name === 'navigate') {
        const arg = call.args[0];
        if (!arg) continue;
        const destId = argResourceId(arg);
        if (destId) {
          appendUsage(entry, targetOfRoute(sole(routesByDestId.get(destId))), call);
          continue;
        }
        // Unlike the route DEFINITION above, an interpolated destination is legitimate here.
        // This is a LOOKUP against routes already emitted, and `stringValue` renders `$id` as
        // `{id}` — exactly how a route template spells its parameter — so `navigate("detail/$id")`
        // matches a real `composable("detail/{id}")`. Rejecting it would drop a true edge to
        // prevent a fabrication that cannot happen: `sole()` abstains unless exactly one emitted
        // route has that path, and routes are literal-only.
        const literal = stringValue(argValue(arg) ?? arg);
        if (literal !== undefined) appendUsage(entry, targetOfRoute(sole(routesByPath.get(literal))), call);
      }
    }
  }

  return { components: emitted.map((e) => e.node), routes };
}
