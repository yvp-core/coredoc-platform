/**
 * Celery producer→task CALL edges — models async dispatch as a graph-native call edge so
 * `find_callers(task)` surfaces the code that ENQUEUES it. A `@shared_task` def is the
 * consumer; a `task.delay(...)` / `task.apply_async(...)` site is the producer. We connect
 * the producer's enclosing function to the task def, precision-first: an unresolved receiver
 * (not a known task, or an external import) is DROPPED rather than guessed.
 *
 * Self-contained (does NOT depend on the call-graph def index): it builds its own task map
 * and resolves producer receivers through the per-file import table (`python-imports`),
 * so the queue half of the graph stands on its own.
 */
import type { CallEdge, StableIdGenerator } from '@coredoc/core';
import {
  type PythonFile,
  type TsNode,
  ATTRIBUTE,
  DEF_TYPES,
  defName,
  hasDecorator,
  nearestAncestor,
  pythonFunctionId,
} from './python-cst.js';
import { type ImportTable, buildImportTable, buildModuleIndex, resolveImportedTarget } from './python-imports.js';

export interface PythonQueueConfig {
  /** Decorators that mark a Celery task. Default `['shared_task', 'app.task']`. */
  taskDecorators?: string[];
}

/** A task's owning file + canonical def id — the CALL-edge target for its producers. */
interface TaskTarget {
  relPath: string;
  defId: string;
}

/** The two Celery dispatch methods that turn a call into a producer edge. */
const DISPATCH_METHODS = new Set(['delay', 'apply_async']);

/**
 * Resolve a producer receiver (`sync` / `tasks.sync`) to a known task's def id:
 *   1. Same-file bare name — `sync.delay()` where `sync` is a `@task` def in THIS file.
 *   2. Imported name — via the file's import table (`from tasks import sync; sync.delay()`
 *      or `import tasks; tasks.sync.delay()`), matched by symbol name + owning file.
 * Returns undefined (→ drop) when the receiver is not an in-repo task.
 */
function resolveProducerTarget(
  receiver: string,
  file: PythonFile,
  table: ImportTable,
  taskByName: Map<string, TaskTarget>,
  moduleIndex: Map<string, string>,
): string | undefined {
  // 1. Same-file task referenced by its bare name.
  if (!receiver.includes('.')) {
    const same = taskByName.get(receiver);
    if (same && same.relPath === file.relPath) return same.defId;
  }

  // 2. Imported task — resolve the receiver head through this file's import table.
  const resolved = resolveImportedTarget(table, moduleIndex, receiver);
  if (resolved?.filePath) {
    const name = resolved.symbol ?? receiver.split('.').pop();
    if (name) {
      const task = taskByName.get(name);
      if (task && task.relPath === resolved.filePath) return task.defId;
    }
  }
  return undefined;
}

/**
 * Build Celery producer→task CALL edges across `files`. Emits `provenance: 'py-import'`,
 * `isMethodCall: true` edges; unresolved producers and producer==task self-loops are dropped.
 */
export function extractPythonQueueEdges(
  files: PythonFile[],
  idGen: StableIdGenerator,
  cfg: PythonQueueConfig,
): CallEdge[] {
  const taskDecorators = cfg.taskDecorators ?? ['shared_task', 'app.task'];

  // Pass 1 — index every @task-decorated def by name (first occurrence wins; Celery task
  // names are effectively globally unique, so a name key resolves both same-file and imports).
  const taskByName = new Map<string, TaskTarget>();
  for (const file of files) {
    for (const def of file.root.descendantsOfType('function_definition') as TsNode[]) {
      if (!hasDecorator(def, taskDecorators)) continue;
      const name = defName(def);
      if (!name || taskByName.has(name)) continue;
      taskByName.set(name, { relPath: file.relPath, defId: pythonFunctionId(idGen, file.relPath, def) });
    }
  }

  const moduleIndex = buildModuleIndex(files);
  const edges: CallEdge[] = [];

  // Pass 2 — every `X.delay(...)` / `X.apply_async(...)` inside a function becomes a
  // caller→task edge when X resolves to a known task.
  for (const file of files) {
    // Build the file's import table ONCE, not per producer call-site (was O(sites × treewalk)).
    const table = buildImportTable(file);
    for (const call of file.root.descendantsOfType('call') as TsNode[]) {
      const fn = call.childForFieldName?.('function');
      if (fn?.type !== ATTRIBUTE) continue;
      const method = fn.childForFieldName?.('attribute')?.text as string | undefined;
      if (!method || !DISPATCH_METHODS.has(method)) continue;
      const receiver = fn.childForFieldName?.('object')?.text as string | undefined;
      if (!receiver) continue;

      const calleeId = resolveProducerTarget(receiver, file, table, taskByName, moduleIndex);
      if (!calleeId) continue; // unresolved → drop (precision-first)

      const enclosing = nearestAncestor(call, DEF_TYPES);
      if (!enclosing) continue; // a module-level dispatch has no caller function
      const callerId = pythonFunctionId(idGen, file.relPath, enclosing);
      if (callerId === calleeId) continue; // a task re-dispatching itself is not its own caller

      const line = (call.startPosition?.row ?? 0) + 1;
      const calleeExpression = `${receiver}.${method}`;
      const id = idGen.callEdgeId(callerId, calleeExpression, `${file.relPath}:${line}`);
      edges.push({
        id,
        callerId,
        calleeId,
        provenance: 'py-import',
        calleeExpression,
        isMethodCall: true,
        location: { filePath: file.relPath, startLine: line, endLine: line },
      });
    }
  }
  return edges;
}
