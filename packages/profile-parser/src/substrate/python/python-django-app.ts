/**
 * Django app labels → the `<app_label>_<model>` table name Django actually creates (audit gap
 * G10).
 *
 * A model without an explicit `Meta.db_table` was emitted as the bare lowercased class name
 * (`cohort`), but Django's documented default is `<app_label>_<lowercased class name>`
 * (`posthog_cohort`). In a polyglot repo that split the graph silently: the Django model and the
 * Rust/sqlx entity for the SAME physical table never shared a `tableName`, so nothing joined.
 *
 * The label is derived by precedence, most authoritative first:
 *   1. an explicit `Meta.app_label = '...'` on the model;
 *   2. the nearest ANCESTOR directory holding an `apps.py` — Django's app root — reading its
 *      `AppConfig` subclass: `label` if declared, else the last dotted segment of `name`
 *      (`name = "products.surveys.backend"` → 'backend' unless `label = "surveys"` overrides it),
 *      else the directory's own name;
 *   3. the first path segment, which is what a conventional single-package Django layout
 *      (`posthog/models/...`) resolves to anyway.
 *
 * Static parsing cannot see the runtime app registry, so this stays BEST-EFFORT — but it is
 * best-effort at the same shape Django uses, instead of a value Django never produces.
 */
import { type PythonFile, type TsNode, baseNames, defName, stringValue } from './python-cst.js';
import { posix } from 'node:path';

/** Direct `name = <rhs>` assignments in a class body (not nested-scope ones). */
function bodyAssignments(classNode: TsNode): TsNode[] {
  const body = classNode.childForFieldName?.('body');
  if (!body) return [];
  const out: TsNode[] = [];
  for (let i = 0; i < body.childCount; i++) {
    const stmt = body.child(i);
    if (stmt?.type !== 'expression_statement') continue;
    for (let j = 0; j < stmt.childCount; j++) {
      const inner = stmt.child(j);
      if (inner?.type === 'assignment') {
        out.push(inner);
        break;
      }
    }
  }
  return out;
}

/**
 * The RHS node of a class-body assignment (`abstract = True` → the `true` node), or undefined.
 * Node-level so non-string values (booleans for `Meta.abstract`) are readable too.
 */
export function classAttrValue(classNode: TsNode, attr: string): TsNode | undefined {
  return classAttrValues(classNode, attr)[0];
}

/** Every RHS assigned to `attr` in the class body, in source order. */
function classAttrValues(classNode: TsNode, attr: string): TsNode[] {
  const out: TsNode[] = [];
  for (const assign of bodyAssignments(classNode)) {
    const left = assign.childForFieldName?.('left');
    if (left?.type !== 'identifier' || left.text !== attr) continue;
    const right = assign.childForFieldName?.('right');
    if (right) out.push(right);
  }
  return out;
}

/** A class-body string assignment (`label = 'surveys'`), or undefined. */
export function classStringAttr(classNode: TsNode, attr: string): string | undefined {
  for (const value of classAttrValues(classNode, attr)) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

/** The nested `class Meta` of a model class, if it declares one. */
export function metaClass(classNode: TsNode): TsNode | undefined {
  const body = classNode.childForFieldName?.('body');
  if (!body) return undefined;
  for (let i = 0; i < body.childCount; i++) {
    const inner = body.child(i);
    if (inner?.type === 'class_definition' && defName(inner) === 'Meta') return inner;
  }
  return undefined;
}

/** The app label an `apps.py` file declares: AppConfig `label`, else the tail of `name`. */
function labelFromAppsFile(file: PythonFile): string | undefined {
  for (const classNode of file.root.descendantsOfType('class_definition') as TsNode[]) {
    // Any `*AppConfig` base — Django's own `AppConfig` or a project base config class.
    if (!baseNames(classNode).some((b) => b === 'AppConfig' || b.endsWith('AppConfig'))) continue;
    const label = classStringAttr(classNode, 'label');
    if (label) return label;
    const name = classStringAttr(classNode, 'name');
    if (name) return name.split('.').pop();
  }
  return undefined;
}

/**
 * Directory → app label, for every `apps.py` in the parsed file set. An `apps.py` whose
 * `AppConfig` declares nothing usable still marks its directory as an app root, labelled by the
 * directory name — that is what Django's own default (`name.split('.')[-1]`) resolves to.
 */
export function buildDjangoAppIndex(files: PythonFile[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of files) {
    if (!/(^|\/)apps\.pyi?$/.test(file.relPath)) continue;
    const dir = posix.dirname(file.relPath);
    const label = labelFromAppsFile(file) ?? (dir === '.' ? undefined : (dir.split('/').pop() as string));
    if (label && !index.has(dir)) index.set(dir, label);
  }
  return index;
}

/**
 * The app label owning a file: the NEAREST ancestor directory registered as an app root, else the
 * first path segment ('posthog/models/cohort/cohort.py' → 'posthog'). Undefined only for a file
 * sitting directly at the repo root, which no Django app can own.
 */
export function djangoAppLabel(relPath: string, appIndex: Map<string, string>): string | undefined {
  const parts = relPath.split('/').slice(0, -1);
  for (let i = parts.length; i > 0; i--) {
    const dir = parts.slice(0, i).join('/');
    const label = appIndex.get(dir);
    if (label) return label;
  }
  return parts[0];
}

/**
 * A Django model's table name: explicit `Meta.db_table` wins; else `Meta.app_label` or the
 * resolved app label, joined to the lowercased class name — Django's documented default. Falls
 * back to the bare lowercased name only when no label can be derived at all (a model at the repo
 * root), which is the previous behaviour.
 */
export function djangoTableName(
  classNode: TsNode,
  className: string,
  relPath: string,
  appIndex: Map<string, string>,
  explicitDbTable?: string,
): string {
  if (explicitDbTable) return explicitDbTable;
  const meta = metaClass(classNode);
  const label = (meta ? classStringAttr(meta, 'app_label') : undefined) ?? djangoAppLabel(relPath, appIndex);
  const base = className.toLowerCase();
  return label ? `${label}_${base}` : base;
}
