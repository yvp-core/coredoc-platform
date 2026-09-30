/**
 * Transitive ORM-base resolution over the repo's own class graph (audit gap G3).
 *
 * Django model detection used to match a LITERAL base only (`class X(models.Model)`), which on a
 * real Django repo finds roughly a third of the models: everything built on the project's own
 * abstract bases (`UUIDModel`, `CreatedMetaFields`, mixin combos) was invisible, and the miss
 * cascaded into db-ops whose receiver (`Team.objects.filter`) bound to no entity.
 *
 * This module answers "does any base chain of this class reach a configured base?" by building the
 * repo's class graph once and propagating model-ness from the seeds OUTWARD along subclass edges.
 * Propagation (not recursion) is what makes it cycle-safe: every class is marked at most once, so a
 * `A(B)` / `B(A)` cycle simply never gets marked, and an arbitrarily long chain costs one visit per
 * link instead of one stack frame. That is a stronger guarantee than a depth cap, so no cap exists.
 *
 * BASE → CLASS RESOLUTION, in precedence order (the ambiguity rule):
 *   1. the file's import table — `from app.models.utils import UUIDModel` resolves to that module's
 *      file, and a re-export chain (`app/models/__init__.py: from .team import Team`) is followed
 *      up to `MAX_REEXPORT_HOPS` hops;
 *   2. a class of that name defined in the SAME file (`class Child(LocalBase)`);
 *   3. a repo-wide UNIQUE name match — the star-import / implicit-namespace escape hatch;
 *   4. otherwise UNRESOLVED. A name defined by several modules with no import binding is
 *      deliberately left unresolved rather than guessed: a wrong guess mints a phantom table.
 *
 * DJANGO'S OWN BASE is additionally recognised through the import table, so `import django.db.models
 * as dj` + `class X(dj.Model)` and `from django.db.models import Model as DjangoModel` match the
 * same way the literal `models.Model` spelling does.
 */
import { type PythonFile, type TsNode, baseNames, defName } from './python-cst.js';
import { classAttrValue, metaClass } from './python-django-app.js';
import { type ImportTable, buildImportTable, buildModuleIndex, resolveImportedTarget } from './python-imports.js';

/** The canonical dotted path of Django's model base, as the import table spells it out. */
const DJANGO_MODEL_PATH = 'django.db.models.Model';

/** How far a `from .x import Y` re-export chain is followed before giving up. */
const MAX_REEXPORT_HOPS = 5;

export interface ModelBaseOptions {
  /** Superclasses that mark a class as a model, e.g. ['models.Model', 'app.BaseModel']. */
  baseClasses: string[];
  /**
   * Follow base chains through the repo's own classes. Django only: other ORMs (SQLAlchemy's
   * declarative `Base`, project base models) keep the historical single-hop semantics.
   */
  transitive: boolean;
}

/** Whether a superclass path matches a configured base — EXACT or dotted-suffix (see python-entities). */
export function matchesBase(superName: string, configured: string): boolean {
  return superName === configured || superName.endsWith(`.${configured}`);
}

/** Whether a class declares `class Meta: abstract = True` — a Django base, never a table. */
export function isAbstractModel(classNode: TsNode): boolean {
  const meta = metaClass(classNode);
  if (!meta) return false;
  return classAttrValue(meta, 'abstract')?.type === 'true';
}

/** A class in the repo graph, keyed `${relPath}#${name}`. */
interface ClassEntry {
  key: string;
  relPath: string;
  name: string;
  node: TsNode;
}

export interface ModelBaseResolver {
  /** Whether `classNode` (named `name`, in `relPath`) is an ORM model by base resolution. */
  isModel(relPath: string, classNode: TsNode, name: string): boolean;
}

function keyOf(relPath: string, name: string): string {
  return `${relPath}#${name}`;
}

/**
 * The dotted path a base name denotes once the file's import table is applied
 * (`models.Model` + `from django.db import models` → 'django.db.models.Model'). Undefined when the
 * head name is not imported (a local or star-imported name).
 */
function canonicalBasePath(table: ImportTable, baseText: string): string | undefined {
  const parts = baseText.split('.');
  const imp = table.byLocal.get(parts[0]);
  if (!imp) return undefined;
  return [imp.module, ...(imp.symbol ? [imp.symbol] : []), ...parts.slice(1)].join('.');
}

/**
 * Build the resolver over every parsed file. One pass indexes the classes; a second resolves each
 * base to a class key and seeds the directly-matching classes; a worklist then propagates
 * model-ness down the subclass edges.
 */
export function buildModelBaseResolver(files: PythonFile[], opts: ModelBaseOptions): ModelBaseResolver {
  const configured = opts.baseClasses.length > 0 ? opts.baseClasses : ['models.Model'];

  // --- Index every class in the repo -----------------------------------------------------------
  const byFile = new Map<string, Map<string, ClassEntry>>();
  const byName = new Map<string, ClassEntry[]>();
  for (const file of files) {
    const inFile = new Map<string, ClassEntry>();
    for (const node of file.root.descendantsOfType('class_definition') as TsNode[]) {
      const name = defName(node);
      // First definition wins, the same collapse the def index applies to redefinitions.
      if (!name || inFile.has(name)) continue;
      const entry: ClassEntry = { key: keyOf(file.relPath, name), relPath: file.relPath, name, node };
      inFile.set(name, entry);
      const bucket = byName.get(name);
      if (bucket) bucket.push(entry);
      else byName.set(name, [entry]);
    }
    byFile.set(file.relPath, inFile);
  }

  // Import tables are only needed for files that carry a base we must resolve, so they are built
  // on demand and memoized (the parser builds its own set for ImportEdges; this one is scoped here
  // rather than threaded through the entity signature).
  const moduleIndex = buildModuleIndex(files);
  const fileByPath = new Map(files.map((f) => [f.relPath, f] as const));
  const tables = new Map<string, ImportTable>();
  const tableFor = (relPath: string): ImportTable | undefined => {
    const cached = tables.get(relPath);
    if (cached) return cached;
    const file = fileByPath.get(relPath);
    if (!file) return undefined;
    const table = buildImportTable(file);
    tables.set(relPath, table);
    return table;
  };

  /** The class a base name refers to, by the documented precedence, or undefined. */
  const resolveBase = (relPath: string, baseText: string): ClassEntry | undefined => {
    const simpleName = baseText.split('.').pop() as string;

    // 1. Import table (following re-export chains such as `pkg/__init__.py: from .team import Team`).
    let cursorPath: string | undefined = relPath;
    let cursorChain = baseText;
    const seen = new Set<string>();
    for (let hop = 0; cursorPath && hop < MAX_REEXPORT_HOPS; hop++) {
      const table = tableFor(cursorPath);
      if (!table) break;
      const target = resolveImportedTarget(table, moduleIndex, cursorChain);
      if (!target?.filePath) break;
      const wanted = target.symbol ?? simpleName;
      const hit = byFile.get(target.filePath)?.get(wanted);
      if (hit) return hit;
      if (seen.has(target.filePath)) break;
      seen.add(target.filePath);
      // The module resolved but does not define the name → it is re-exported from somewhere else.
      cursorPath = target.filePath;
      cursorChain = wanted;
    }

    // 2. Same file.
    const local = byFile.get(relPath)?.get(simpleName);
    if (local) return local;

    // 3. Repo-wide unique name (star imports, namespace packages). Ambiguous → unresolved.
    const candidates = byName.get(simpleName);
    return candidates?.length === 1 ? candidates[0] : undefined;
  };

  // --- Seed + propagate --------------------------------------------------------------------------
  const isModelKey = new Set<string>();
  // base key → subclasses, the direction model-ness travels.
  const subclasses = new Map<string, ClassEntry[]>();
  const queue: ClassEntry[] = [];

  for (const inFile of byFile.values()) {
    for (const entry of inFile.values()) {
      let direct = false;
      const resolvedBases: ClassEntry[] = [];
      for (const base of baseNames(entry.node)) {
        if (configured.some((cb) => matchesBase(base, cb))) {
          direct = true;
          continue;
        }
        if (!opts.transitive) continue;
        const table = tableFor(entry.relPath);
        if (table && canonicalBasePath(table, base) === DJANGO_MODEL_PATH) {
          direct = true;
          continue;
        }
        const target = resolveBase(entry.relPath, base);
        if (target && target.key !== entry.key) resolvedBases.push(target);
      }
      if (direct) {
        if (!isModelKey.has(entry.key)) {
          isModelKey.add(entry.key);
          queue.push(entry);
        }
        continue;
      }
      for (const base of resolvedBases) {
        const bucket = subclasses.get(base.key);
        if (bucket) bucket.push(entry);
        else subclasses.set(base.key, [entry]);
      }
    }
  }

  // Each class is marked at most once, so this terminates on any graph — cycles included.
  while (queue.length > 0) {
    const current = queue.pop() as ClassEntry;
    for (const child of subclasses.get(current.key) ?? []) {
      if (isModelKey.has(child.key)) continue;
      isModelKey.add(child.key);
      queue.push(child);
    }
  }

  return {
    isModel(relPath: string, classNode: TsNode, name: string): boolean {
      const indexed = byFile.get(relPath)?.get(name);
      // A node the index never saw (a redefinition that lost the first-wins collapse) still gets an
      // honest single-hop answer rather than a silent false.
      if (!indexed || indexed.node.startIndex !== classNode.startIndex) {
        return baseNames(classNode).some((b) => configured.some((cb) => matchesBase(b, cb)));
      }
      return isModelKey.has(indexed.key);
    },
  };
}
