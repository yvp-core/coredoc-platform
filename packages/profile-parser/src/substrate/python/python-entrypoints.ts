/**
 * Python entrypoint extraction — Django/DRF URLconf routes → `http` entrypoints, Django
 * management commands → `cli` entrypoints, and Celery task decorators → `event` entrypoints.
 * Generic Python: the route-table locations and task decorators are profile-configurable; no
 * client class names are hardcoded.
 *
 * Routes are the cross-repo MOAT (spec S11): every Django/DRF route becomes a linkable
 * target with a method + path TEMPLATE, so another repo's egress joins to it on route
 * PREFIX. Because a Django URLconf carries NO HTTP method (the view class does), routes
 * default to method `'GET'` — the linker matches on prefix, not method, so this is a
 * label, not a lie. DRF `router.register(prefix, ViewSet)` is the one place the method
 * set is known, so it expands to the standard REST verbs on the collection + detail paths;
 * that whole lane (nested routers, router mounts, `@action` sub-routes, handler wiring) lives
 * in python-drf.ts, and management commands in python-django-commands.ts.
 *
 * Celery tasks reuse the existing `'event'` EntrypointType (no new member) — a `@shared_task`
 * def is a message consumer, not an HTTP handler.
 */
import type { Entrypoint, EventEntrypointDetails, HttpMethod, StableIdGenerator } from '@coredoc/core';
import { globMatches } from '../glob.js';
import { buildModuleIndex, resolveModuleToFile } from './python-imports.js';
import {
  type PythonFile,
  type TsNode,
  decoratorNameKwarg,
  defName,
  hasDecorator,
  pythonFunctionId,
} from './python-cst.js';
import { extractDjangoCommandEntrypoints } from './python-django-commands.js';
import { extractDrfRoutes } from './python-drf.js';
import { calleeLastName, firstPositionalString, includedModule, normalizePath, templatize } from './python-urlconf.js';
import { httpEntrypoint } from '../file-nodes.js';

export interface PythonEntrypointConfig {
  /** Where Django/DRF URLconf tables live. Defaults to the repo's `urls.py` files. */
  routeFileGlobs?: string[];
  /** Decorators that mark a Celery task. Default `['shared_task', 'app.task']`. */
  taskDecorators?: string[];
}

/** A single route the extractor resolves from one URLconf call. */
interface Route {
  method: HttpMethod;
  fullPath: string;
  line: number;
  /** The handler def, when a lane can name one (DRF ViewSet methods); else the synthetic fallback. */
  handlerId?: string;
}

/**
 * The route(s) a single `path`/`re_path` call yields. DRF `register()` calls are NOT handled
 * here: a registration's path depends on its router's lineage (nesting + where the router is
 * mounted), which is a whole-file walk — see python-drf.ts.
 */
function routesForCall(call: TsNode, basePath = ''): Route[] {
  const name = calleeLastName(call);
  if (name !== 'path' && name !== 're_path') return [];
  const line = (call.startPosition?.row ?? 0) + 1;
  const raw = firstPositionalString(call);
  if (raw === undefined) return [];
  // A `path(prefix, include(…))` is a MOUNT, not an endpoint. Emitting it as a route
  // invented an endpoint at the prefix that nothing serves, and the mounted app's real
  // routes came out unprefixed — so every included app joined the cross-repo linker on a
  // key that was wrong at both ends. The prefix is applied to the child file instead.
  if (includedModule(call).isMount) return [];
  // URLconf carries no method → default GET (linker joins on prefix, not method).
  return [{ method: 'GET', fullPath: normalizePath(`${basePath}/${templatize(raw, name === 're_path')}`), line }];
}

/**
 * The URL prefix(es) each route file is mounted under, following `path(p, include('a.urls'))`.
 *
 * A file reachable by more than one mount genuinely serves its routes at each prefix, so the
 * result is a set. Unmounted files (the root URLconf, or one whose parent could not be
 * resolved) keep `''` — an unprefixed route is the honest answer when no mount is known,
 * and it is what the extractor emitted for every file before mounts were followed at all.
 */
function mountPrefixes(files: PythonFile[], routeFiles: Set<string>): Map<string, Set<string>> {
  const moduleIndex = buildModuleIndex(files);
  // parent file → [{ prefix, child file }]
  const edges = new Map<string, { prefix: string; child: string }[]>();
  const mounted = new Set<string>();
  for (const file of files) {
    if (!routeFiles.has(file.relPath)) continue;
    for (const call of file.root.descendantsOfType('call') as TsNode[]) {
      const name = calleeLastName(call);
      if (name !== 'path' && name !== 're_path') continue;
      const mount = includedModule(call);
      if (!mount.isMount || !mount.module) continue;
      const child = resolveModuleToFile(mount.module, moduleIndex);
      if (!child || child === file.relPath) continue;
      const raw = firstPositionalString(call) ?? '';
      const list = edges.get(file.relPath) ?? [];
      list.push({ prefix: templatize(raw, name === 're_path'), child });
      edges.set(file.relPath, list);
      mounted.add(child);
    }
  }

  const out = new Map<string, Set<string>>();
  const add = (f: string, p: string): void => {
    const set = out.get(f) ?? new Set<string>();
    set.add(p);
    out.set(f, set);
  };
  // Depth-first, carrying the set of files on the CURRENT chain. A URLconf cannot mount
  // itself, so revisiting a file already on the path is a cycle and the walk stops there —
  // deduping on (file, prefix) instead would not terminate, because each lap around a cycle
  // produces a longer, never-before-seen prefix.
  const walk = (file: string, prefix: string, onPath: Set<string>): void => {
    add(file, prefix);
    if (onPath.has(file)) return;
    onPath.add(file);
    for (const e of edges.get(file) ?? []) {
      walk(e.child, normalizePath(`${prefix}/${e.prefix}`), onPath);
    }
    onPath.delete(file);
  };
  const roots = [...routeFiles].filter((f) => !mounted.has(f));
  // Every route file mounted by another leaves no root (a pure cycle); treat each as its own.
  for (const f of roots.length > 0 ? roots : [...routeFiles]) walk(f, '', new Set());
  return out;
}

// =============================================================================
// Entrypoint construction
// =============================================================================

function celeryEntrypoint(idGen: StableIdGenerator, taskName: string, relPath: string, def: TsNode): Entrypoint {
  const id = idGen.queueEntrypointId('celery', taskName, relPath);
  const details: EventEntrypointDetails = { type: 'event', eventName: taskName, emitter: 'celery' };
  return {
    id,
    versionedId: idGen.versionedId(id, `celery:${taskName}`),
    type: 'event',
    handlerId: pythonFunctionId(idGen, relPath, def),
    location: {
      filePath: relPath,
      startLine: (def.startPosition?.row ?? 0) + 1,
      endLine: (def.endPosition?.row ?? 0) + 1,
    },
    details,
  };
}

/**
 * Extract Python entrypoints from parsed files:
 *   - HTTP: Django `path()`/`re_path()` + the DRF router lane (`register()`, nested routers,
 *     router mounts, `@action` sub-routes) over files whose relPath matches `routeFileGlobs`
 *     (default: the repo's `urls.py`), de-duped by `${method} ${fullPath} ${relPath}` — the file
 *     is part of the key (matching the id's file scoping) so the SAME path in two apps' `urls.py`
 *     yields two distinct entrypoints, not one.
 *   - CLI: Django management commands (a `management/commands/<name>.py` module), over ALL files.
 *   - Event: `@shared_task`/`@app.task`-decorated defs over ALL files, de-duped by entrypoint id.
 */
export function extractPythonEntrypoints(
  files: PythonFile[],
  idGen: StableIdGenerator,
  cfg: PythonEntrypointConfig,
): Entrypoint[] {
  const routeGlobs = cfg.routeFileGlobs ?? ['**/urls.py'];
  const taskDecorators = cfg.taskDecorators ?? ['shared_task', 'app.task'];
  const out: Entrypoint[] = [];
  const seen = new Set<string>();

  const routeFiles = new Set(files.filter((f) => globMatches(f.relPath, routeGlobs)).map((f) => f.relPath));
  const prefixes = mountPrefixes(files, routeFiles);
  // The DRF lane resolves registrations across the whole route-file set at once (a nested
  // registration's path lives in its PARENT router, which may be another file), so it runs once
  // here and hands back the routes grouped by the file that declares each registration.
  const drfRoutes = extractDrfRoutes({
    files,
    routeFiles,
    filePrefixes: prefixes,
    moduleIndex: buildModuleIndex(files),
    idGen,
  });

  // Django management commands → cli. File-convention only; no route-glob scoping.
  out.push(...extractDjangoCommandEntrypoints(files, idGen));
  for (const ep of out) seen.add(ep.id);

  for (const file of files) {
    // Celery task entrypoints — scanned over EVERY file (tasks live outside urls.py).
    for (const def of file.root.descendantsOfType('function_definition') as TsNode[]) {
      if (!hasDecorator(def, taskDecorators)) continue;
      // An explicit `name=` on the decorator IS the routing key a producer sends; the def
      // name only names the task when the decorator does not override it.
      const taskName = decoratorNameKwarg(def, taskDecorators) ?? defName(def);
      if (!taskName) continue;
      const ep = celeryEntrypoint(idGen, taskName, file.relPath, def);
      if (seen.has(ep.id)) continue;
      seen.add(ep.id);
      out.push(ep);
    }

    // Django/DRF routes — only in the configured route-table files, once per mount prefix.
    if (!routeFiles.has(file.relPath)) continue;
    const routes: Route[] = [];
    for (const basePath of prefixes.get(file.relPath) ?? ['']) {
      for (const call of file.root.descendantsOfType('call') as TsNode[]) {
        routes.push(...routesForCall(call, basePath));
      }
    }
    routes.push(...(drfRoutes.get(file.relPath) ?? []));
    for (const route of routes) {
      // File-scoped key (matches `httpEntrypointId(method, path, relPath)`): distinct files with
      // the same `method path` are distinct entrypoints and must both survive de-dup.
      const key = `${route.method} ${route.fullPath} ${file.relPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        httpEntrypoint(idGen, route.method, route.fullPath, file.relPath, route.line, route.line, route.handlerId),
      );
    }
  }
  return out;
}
