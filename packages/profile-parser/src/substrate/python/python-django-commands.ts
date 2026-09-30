/**
 * Django management commands → `cli` entrypoints (audit gap G5).
 *
 * Django's command discovery is a FILE CONVENTION, not a registration table: `find_commands()`
 * lists the non-package modules directly inside an app's `management/commands/` directory whose
 * name does not start with `_`, and loads the `Command` class each declares. That is exactly the
 * rule implemented here — there is nothing per-repo to tune, so this lane has no profile knob and
 * is always on (a knob with one possible value would be dead config).
 *
 * The command NAME is the module's file name (`sync_persons_to_clickhouse.py` → the command
 * `sync_persons_to_clickhouse`), and the handler is `Command.handle`, following the class's
 * repo-declared base chain (`class Command(BaseHyperCacheCommand)` keeps its inherited `handle`).
 *
 * A `Command` whose `handle` cannot be resolved is DROPPED, with a one-line count on stderr: the
 * only alternative is a synthetic handler id, and an entrypoint whose handlerId names no function
 * node is a referential-integrity violation that dead-ends impact analysis at the command — the
 * failure this lane exists to remove.
 */
import type { CliEntrypointDetails, Entrypoint, StableIdGenerator } from '@coredoc/core';
import {
  CLASS_DEF,
  FUNCTION_DEF,
  type PythonFile,
  type TsNode,
  baseNames,
  defName,
  pythonClassChain,
  pythonFunctionId,
  undecorate,
} from './python-cst.js';

/** The class Django loads from a command module. */
const COMMAND_CLASS = 'Command';

/** How far `Command`'s base chain is followed when looking for `handle`. */
const MAX_BASE_HOPS = 6;

/**
 * The command name a path declares, or undefined when the path is not a command module:
 * `<app>/management/commands/<name>.py`, `name` not starting with `_` and not `__init__`.
 * A file in a SUBDIRECTORY (`management/commands/test/foo.py`) is not a command — Django's
 * `iter_modules` skips packages and never recurses.
 */
export function djangoCommandName(relPath: string): string | undefined {
  const m = /(?:^|\/)management\/commands\/([^/]+)\.pyi?$/.exec(relPath);
  const name = m?.[1];
  if (!name || name.startsWith('_')) return undefined;
  return name;
}

/** Module-level classes of one file, by name. */
function moduleClasses(file: PythonFile): Map<string, TsNode> {
  const out = new Map<string, TsNode>();
  for (const cls of file.root.descendantsOfType(CLASS_DEF) as TsNode[]) {
    if (pythonClassChain(cls).length > 0) continue;
    const name = defName(cls);
    if (name && !out.has(name)) out.set(name, cls);
  }
  return out;
}

/** A class's direct method def by name (decorated defs unwrapped). */
function directMethod(cls: TsNode, name: string): TsNode | undefined {
  const body = cls.childForFieldName?.('body');
  const n = body?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const child = undecorate(body.namedChild?.(i) as TsNode);
    if (child?.type === FUNCTION_DEF && defName(child) === name) return child;
  }
  return undefined;
}

/**
 * Extract one `cli` entrypoint per Django management command. `classesByName` spans the whole
 * repo so an inherited `handle` (a shared command base in another module) still resolves; base
 * names are matched by their last dotted segment, and a name defined by several modules resolves
 * only when it is repo-wide UNIQUE — a wrong match would wire the command to a foreign function.
 */
export function extractDjangoCommandEntrypoints(files: PythonFile[], idGen: StableIdGenerator): Entrypoint[] {
  const commandFiles = files.filter((f) => djangoCommandName(f.relPath) !== undefined);
  if (commandFiles.length === 0) return [];

  // Repo-wide class lookup for base resolution: name → [(relPath, node)]; ambiguous names are kept
  // so the uniqueness rule can reject them rather than silently picking one.
  const byName = new Map<string, { relPath: string; node: TsNode }[]>();
  for (const file of files) {
    for (const [name, node] of moduleClasses(file)) {
      const list = byName.get(name) ?? [];
      list.push({ relPath: file.relPath, node });
      byName.set(name, list);
    }
  }

  /** `handle` on the class or, transitively, on a uniquely-named repo-declared base. */
  const findHandle = (
    relPath: string,
    cls: TsNode,
    hops: number,
    seen: Set<string>,
  ): { relPath: string; def: TsNode } | undefined => {
    const key = `${relPath}#${defName(cls) ?? ''}`;
    if (seen.has(key) || hops > MAX_BASE_HOPS) return undefined;
    seen.add(key);
    const own = directMethod(cls, 'handle');
    if (own) return { relPath, def: own };
    for (const base of baseNames(cls)) {
      const candidates = byName.get(base.split('.').pop() as string) ?? [];
      const same = candidates.filter((c) => c.relPath === relPath);
      const target = same.length === 1 ? same[0] : candidates.length === 1 ? candidates[0] : undefined;
      if (!target) continue;
      const found = findHandle(target.relPath, target.node, hops + 1, seen);
      if (found) return found;
    }
    return undefined;
  };

  const out: Entrypoint[] = [];
  let unresolvedHandlers = 0;
  for (const file of commandFiles) {
    const command = djangoCommandName(file.relPath) as string;
    const cls = moduleClasses(file).get(COMMAND_CLASS);
    if (!cls) continue; // a module with no `Command` class is not a command Django can run
    const handle = findHandle(file.relPath, cls, 0, new Set());
    if (!handle) {
      unresolvedHandlers++;
      continue;
    }
    const id = idGen.entrypointId('cli', command, file.relPath);
    const details: CliEntrypointDetails = { type: 'cli', command };
    out.push({
      id,
      versionedId: idGen.versionedId(id, `django:${command}`),
      type: 'cli',
      handlerId: pythonFunctionId(idGen, handle.relPath, handle.def),
      location: {
        filePath: file.relPath,
        startLine: cls.startPosition.row + 1,
        endLine: cls.endPosition.row + 1,
      },
      details,
    });
  }
  if (unresolvedHandlers > 0) {
    console.warn(
      `[coredoc] python: ${unresolvedHandlers} django management command(s) dropped — no resolvable ` +
        '`Command.handle` (an entrypoint with a dangling handlerId would be worse than a missing one).',
    );
  }
  return out;
}
