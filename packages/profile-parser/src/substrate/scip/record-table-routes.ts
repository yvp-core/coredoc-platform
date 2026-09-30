/**
 * Table-driven route extraction (`RecordTableRouteRule`).
 *
 * The shape: a path-keyed `Record` whose value names a SCENE KEY, plus a second
 * table mapping that scene key to a `() => import('<module>')` thunk. The route's
 * component is what that module exposes — its declared `moduleComponent` descriptor,
 * else its default export — two hops away from the path, with no component reference
 * anywhere near the route declaration, which is why neither the JSX nor the
 * config-array detector sees anything here.
 *
 * Measured on kea-router (PostHog): `frontend/src/scenes/scenes.ts#routes` joined to
 * `appScenes`, and the generated `frontend/src/products.tsx#productRoutes` joined to
 * `productScenes`. Nothing in this module names a framework: it reads the tables the
 * rule points at.
 *
 * Two discipline rules carried from the rest of the frontend lane:
 * - We never fabricate an id. The reader resolves (module file, declared name) and
 *   hands that to the engine, which only sets `componentId` when it matches a really
 *   emitted component; a module that resolves to a non-component yields a name-only
 *   route.
 * - We never drop a route. A computed key that does not const-fold is emitted with
 *   an `unresolved:` path (the callee text), so the surface stays visible and nothing
 *   joins it by accident.
 */
import type { Node as TsNode } from 'web-tree-sitter';
import type { ImportResolution, RecordTableRouteRule, RecordTableSceneTableRule } from '../../types/frontend.js';
import { markUnresolved } from '../../unresolved-sentinel.js';
import { globMatches } from '../glob.js';
import type { RouteSite } from '../interface.js';
import { text, unquote } from './ts-text.js';

/**
 * The substrate capabilities this reader borrows: the parsed CSTs, module-specifier
 * resolution (alias/baseUrl/relative + extension probe + `confineTo`), and the
 * HOC-peeled default-export index. Passed as a port so the reader stays a
 * self-contained function rather than more surface on the substrate class.
 */
export interface RecordTableHost {
  cstRoots: ReadonlyMap<string, TsNode>;
  resolveSpecifier(specifier: string, fromFile: string, imports: ImportResolution): string | undefined;
  defaultExportedName(file: string): string | undefined;
}

/** Scene key → the dynamic-import specifier and the file it was written in. */
type SceneIndex = Map<string, { specifier: string; file: string }>;

/** One route-table pair, already reduced to (path, sceneKey, line). */
interface TableEntry {
  path: string;
  sceneKey: string | undefined;
  line: number;
}

export function recordTableRouteSites(
  host: RecordTableHost,
  rule: RecordTableRouteRule,
  imports: ImportResolution,
): RouteSite[] {
  const sceneIndex = buildSceneIndex(host, rule.files, rule.sceneTable);
  const urls = rule.resolveComputedKeyVia
    ? buildUrlsIndex(host, rule.resolveComputedKeyVia.urlsObject, rule.resolveComputedKeyVia.inPaths, imports)
    : undefined;

  const out: RouteSite[] = [];
  for (const [file, root] of host.cstRoots) {
    if (!globMatches(file, rule.files)) continue;
    const table = findTableObject(root, rule.table);
    if (!table) continue;
    for (const entry of readRouteEntries(table, rule, urls)) {
      const scene = entry.sceneKey ? sceneIndex.get(entry.sceneKey) : undefined;
      const moduleFile = scene ? host.resolveSpecifier(scene.specifier, scene.file, imports) : undefined;
      const resolved = moduleFile ? moduleComponent(host, moduleFile, rule.sceneTable, imports) : undefined;
      // Name fallback when the module (or its component export) does not resolve: the
      // scene key's own trailing segment (`Scene.Dashboard` → `Dashboard`). A name,
      // never an id — the engine still refuses to bind a componentId to it.
      const componentName = resolved?.declaredName ?? lastSegment(entry.sceneKey ?? entry.path);
      out.push({
        path: entry.path,
        componentName,
        componentLine: entry.line,
        file,
        // The reader followed the reference itself; the engine must not re-resolve
        // `componentName` at this line (the only symbols there are table keys).
        resolution: resolved ? { resolved } : {},
        isLazy: scene !== undefined,
      });
    }
  }
  return out;
}

// ── route table ──────────────────────────────────────────────────────────────

function readRouteEntries(table: TsNode, rule: RecordTableRouteRule, urls: UrlsIndex | undefined): TableEntry[] {
  const out: TableEntry[] = [];
  for (const pair of table.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    if (!key || !value) continue;
    const path = readKeyPath(key, urls);
    if (path === undefined) continue;
    out.push({ path, sceneKey: readSceneKey(value, rule.sceneKey.tupleIndex), line: pair.startPosition.row + 1 });
  }
  return out;
}

/**
 * The entry value's tuple slot, uncast and unquoted (`[Scene.Dashboard, 'dashboard']`
 * → `Scene.Dashboard`, `['FeatureFlagTemplates' as Scene, …]` → `FeatureFlagTemplates`).
 */
function readSceneKey(value: TsNode, tupleIndex: number): string | undefined {
  if (value.type !== 'array') return undefined;
  const slot = unwrap(value.namedChildren[tupleIndex]);
  return slot ? unquote(text(slot)).trim() : undefined;
}

/**
 * Table key → route path. String keys are literal; computed keys go through the
 * urls const-eval and, when that fails, keep the callee text behind an
 * `unresolved:` marker so the route is visible but joins nothing.
 */
function readKeyPath(key: TsNode, urls: UrlsIndex | undefined): string | undefined {
  if (key.type === 'string') return unquote(text(key));
  if (key.type === 'property_identifier') return text(key);
  if (key.type !== 'computed_property_name') return undefined;
  const expr = key.namedChildren[0];
  if (!expr) return undefined;
  if (expr.type === 'string') return unquote(text(expr));
  if (urls && expr.type === 'call_expression') {
    const callee = expr.childForFieldName('function');
    const folded = callee ? evalUrlCall(callee, expr.childForFieldName('arguments'), urls) : undefined;
    if (folded !== undefined) return folded;
    return markUnresolved(text(callee) || text(expr));
  }
  return markUnresolved(text(expr));
}

/**
 * The (file, declared name) of the component a scene module exposes: the declared
 * `moduleComponent` descriptor first (`export const scene = { component: X }`), then
 * the module's HOC-peeled default export. When the descriptor names an identifier the
 * module IMPORTS, the declaration file is followed one hop; otherwise the module
 * declares it itself. Either way the engine validates the pair against emitted
 * component ids, so a wrong guess costs a name-only route, never a fabricated id.
 */
function moduleComponent(
  host: RecordTableHost,
  moduleFile: string,
  rule: RecordTableSceneTableRule,
  imports: ImportResolution,
): { filePath: string; declaredName: string } | undefined {
  const spec = rule.moduleComponent;
  const root = spec ? host.cstRoots.get(moduleFile) : undefined;
  const descriptor = root && spec ? findTableObject(root, spec.export) : undefined;
  const value = descriptor && spec ? readProperty(descriptor, spec.property) : undefined;
  const name = value?.type === 'identifier' ? text(value) : undefined;
  if (root && name && /^[A-Z]/.test(name)) {
    const specifier = importSpecifierFor(root, name);
    const declFile = specifier ? host.resolveSpecifier(specifier, moduleFile, imports) : moduleFile;
    if (declFile) return { filePath: declFile, declaredName: name };
  }
  const declaredName = host.defaultExportedName(moduleFile);
  return declaredName ? { filePath: moduleFile, declaredName } : undefined;
}

// ── scene table ──────────────────────────────────────────────────────────────

function buildSceneIndex(host: RecordTableHost, routeFiles: string[], rule: RecordTableSceneTableRule): SceneIndex {
  const index: SceneIndex = new Map();
  const files = rule.files ?? routeFiles;
  for (const [file, root] of host.cstRoots) {
    if (!globMatches(file, files)) continue;
    const table = findTableObject(root, rule.table);
    if (!table) continue;
    for (const pair of table.namedChildren) {
      if (pair.type !== 'pair') continue;
      const key = pair.childForFieldName('key');
      const value = pair.childForFieldName('value');
      if (!key || !value) continue;
      const sceneKey = readTableKeyText(key);
      if (!sceneKey || index.has(sceneKey)) continue;
      const thunk = rule.property ? readProperty(value, rule.property) : value;
      const specifier = thunk ? dynamicImportSpecifier(thunk) : undefined;
      if (specifier) index.set(sceneKey, { specifier, file });
    }
  }
  return index;
}

/**
 * The key AS WRITTEN, so both tables join on the same text: `[Scene.Dashboard]` and
 * `'ErrorTracking'` reduce to `Scene.Dashboard` / `ErrorTracking`. Enum members are
 * never evaluated — the two tables spell the key identically, which is what makes
 * the join sound without a type checker.
 */
function readTableKeyText(key: TsNode): string | undefined {
  if (key.type === 'computed_property_name') {
    const inner = unwrap(key.namedChildren[0]);
    return inner ? unquote(text(inner)).trim() : undefined;
  }
  return unquote(text(key)).trim() || undefined;
}

/** The `property` slot of an object-literal entry value (`{ import: () => … }`). */
function readProperty(value: TsNode, property: string): TsNode | undefined {
  if (value.type !== 'object') return undefined;
  for (const pair of value.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    if (!key || readTableKeyText(key) !== property) continue;
    return pair.childForFieldName('value') ?? undefined;
  }
  return undefined;
}

/** The first `import('<specifier>')` string argument anywhere under `n`. */
function dynamicImportSpecifier(n: TsNode): string | undefined {
  if (n.type === 'call_expression' && text(n.childForFieldName('function')) === 'import') {
    const arg = n.childForFieldName('arguments')?.namedChildren[0];
    if (arg?.type === 'string') return unquote(text(arg));
  }
  for (const c of n.namedChildren) {
    const found = dynamicImportSpecifier(c);
    if (found) return found;
  }
  return undefined;
}

// ── computed keys: the urls object ───────────────────────────────────────────

/** Path-builder name → its arrow function node. */
type UrlsIndex = Map<string, TsNode>;

/**
 * Index the named object literal's function-valued properties, following ONE spread
 * hop into another object literal in another file (`urls = { ...productUrls, … }`).
 * Own properties win over spread ones, mirroring JS evaluation order for the
 * measured shape (the spread is written first).
 */
function buildUrlsIndex(
  host: RecordTableHost,
  urlsObject: string,
  inPaths: string[],
  imports: ImportResolution,
): UrlsIndex {
  const index: UrlsIndex = new Map();
  for (const [file, root] of host.cstRoots) {
    if (!inPaths.some((p) => file.startsWith(p))) continue;
    const table = findTableObject(root, urlsObject);
    if (!table) continue;
    for (const spread of table.namedChildren) {
      if (spread.type !== 'spread_element') continue;
      const name = text(spread.namedChildren[0]);
      const specifier = name ? importSpecifierFor(root, name) : undefined;
      const declFile = specifier ? host.resolveSpecifier(specifier, file, imports) : undefined;
      const declRoot = declFile ? host.cstRoots.get(declFile) : undefined;
      const spreadTable = declRoot ? findTableObject(declRoot, name) : undefined;
      if (spreadTable) addArrowProperties(spreadTable, index);
    }
    addArrowProperties(table, index, true);
  }
  return index;
}

function addArrowProperties(table: TsNode, index: UrlsIndex, overwrite = false): void {
  for (const pair of table.namedChildren) {
    if (pair.type !== 'pair') continue;
    const name = text(pair.childForFieldName('key'));
    const value = pair.childForFieldName('value');
    if (!name || value?.type !== 'arrow_function') continue;
    if (overwrite || !index.has(name)) index.set(name, value);
  }
}

/** The module specifier the file imports `name` from (named or default binding). */
function importSpecifierFor(root: TsNode, name: string): string | undefined {
  for (const imp of descendants(root, 'import_statement')) {
    const source = imp.childForFieldName('source');
    if (!source) continue;
    const clause = imp.namedChildren.find((c) => c.type === 'import_clause');
    if (!clause) continue;
    const names = descendants(clause, 'identifier').map(text);
    for (const spec of descendants(clause, 'import_specifier')) {
      const alias = spec.childForFieldName('alias');
      names.push(text(alias || spec.childForFieldName('name')));
    }
    if (names.includes(name)) return unquote(text(source));
  }
  return undefined;
}

/**
 * Const-eval `<urlsObject>.<fn>('<literal>', …)`.
 *
 * Bounded exactly to the measured shape: a single-expression arrow whose body is a
 * template literal or a plain string. Placeholders are substituted by PARAMETER NAME
 * (positional args bound to the arrow's parameters), which is stricter than blind
 * positional substitution — a placeholder naming anything other than a parameter with
 * a string-literal argument fails the fold instead of guessing. Returns undefined for
 * every other body (concatenation, helper calls, conditionals).
 */
function evalUrlCall(callee: TsNode, args: TsNode | null, urls: UrlsIndex): string | undefined {
  const name = callee.type === 'member_expression' ? text(callee.childForFieldName('property')) : text(callee);
  const arrow = name ? urls.get(name) : undefined;
  const body = arrow?.childForFieldName('body');
  if (!arrow || !body) return undefined;
  if (body.type === 'string') return unquote(text(body));
  if (body.type !== 'template_string') return undefined;

  const params = parameterNames(arrow);
  const values = new Map<string, string>();
  const argNodes = (args?.namedChildren ?? []).filter((a) => a.type !== 'comment');
  argNodes.forEach((arg, i) => {
    // `':shortId' as InsightShortId` — the cast is noise around the literal.
    const inner = arg.type === 'as_expression' ? arg.namedChildren[0] : arg;
    const param = params[i];
    if (param && inner?.type === 'string') values.set(param, unquote(text(inner)));
  });

  let outPath = '';
  for (const part of body.namedChildren) {
    if (part.type === 'string_fragment') {
      outPath += text(part);
      continue;
    }
    if (part.type !== 'template_substitution') return undefined;
    const inner = part.namedChildren[0];
    const bound = inner?.type === 'identifier' ? values.get(text(inner)) : undefined;
    if (bound === undefined) return undefined;
    outPath += bound;
  }
  // A template with escapes only (no fragments/substitutions) is not a path we read.
  return outPath === '' ? undefined : outPath;
}

function parameterNames(arrow: TsNode): string[] {
  const params = arrow.childForFieldName('parameters');
  if (!params) {
    const single = arrow.namedChildren[0];
    return single?.type === 'identifier' ? [text(single)] : [];
  }
  return params.namedChildren.map((p) => {
    if (p.type === 'identifier') return text(p);
    const id = p.namedChildren.find((c) => c.type === 'identifier');
    return id ? text(id) : '';
  });
}

// ── shared CST lookups ───────────────────────────────────────────────────────

/**
 * The object literal named `name` — either a binding (`export const routes = {…}`,
 * possibly behind an `as`/`satisfies` cast) or an object PROPERTY (a table nested in
 * a bigger config object, e.g. a product manifest's `routes`).
 */
function findTableObject(root: TsNode, name: string): TsNode | undefined {
  for (const decl of descendants(root, 'variable_declarator')) {
    if (text(decl.childForFieldName('name')) !== name) continue;
    const obj = unwrap(decl.childForFieldName('value'));
    if (obj?.type === 'object') return obj;
  }
  for (const pair of descendants(root, 'pair')) {
    const key = pair.childForFieldName('key');
    if (!key || readTableKeyText(key) !== name) continue;
    const obj = unwrap(pair.childForFieldName('value'));
    if (obj?.type === 'object') return obj;
  }
  return undefined;
}

function unwrap(n: TsNode | null | undefined): TsNode | undefined {
  let cur = n ?? undefined;
  while (
    cur &&
    (cur.type === 'as_expression' || cur.type === 'satisfies_expression' || cur.type === 'parenthesized_expression')
  ) {
    cur = cur.namedChildren[0];
  }
  return cur;
}

function descendants(n: TsNode, type: string): TsNode[] {
  const out: TsNode[] = [];
  const walk = (x: TsNode): void => {
    if (x.type === type) out.push(x);
    for (const c of x.namedChildren) walk(c);
  };
  walk(n);
  return out;
}

function lastSegment(key: string): string {
  const parts = key.split('.');
  return parts[parts.length - 1] || key;
}
