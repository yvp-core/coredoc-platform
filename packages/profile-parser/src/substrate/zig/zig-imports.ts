/**
 * Per-file `@import` binding table + `ImportEdge` emission (BR-9, BR-10).
 *
 * A Zig file has no import statement: `@import("x")` is an expression, and the only thing that
 * gives it a NAME is being (the head of) a `variable_declaration`'s value. So this module turns
 * the raw builtin occurrences the declaration walk recorded into two things:
 *
 *   - a binding table per file (local name → spec + resolved target + selected member), which
 *     is what every `a.T.m()` call resolution keys on; and
 *   - one `ImportEdge` per distinct `(file, spec)` — the dependency is on the SPEC, not on each
 *     name it brought in, so two bindings of `@import("util.zig")` merge their `importedNames`
 *     instead of colliding on `importEdgeId(fileId, spec)`.
 *
 * Spec resolution is three cases and no guessing (precision-first): a `.zig` suffix is a path
 * relative to the IMPORTING FILE'S DIRECTORY (`src/net/Client.zig` + `../Store.zig` →
 * `src/Store.zig`) and survives only if the parse scope contains it; a bare name is a module
 * iff `build.zig` bound it AND it is not one of the reserved toolchain specs; everything else —
 * `std`, `builtin`, a `.zon` dependency, a
 * `@cInclude` header, a relative path that escapes the scope — is EXTERNAL and gets an edge
 * with no `targetFileId` rather than a fabricated file id.
 *
 * `resolveBinding` additionally follows a target file's own `pub const X = @import(…)`
 * re-exports (hop-capped and cycle-safe), which is the only reason a hub file like
 * `src/hub.zig` can stand between a caller and the file that really declares the callee.
 */
import { posix } from 'node:path';
import type { ImportEdge, ImportedName, StableIdGenerator } from '@coredoc/core';
import type { ZigBuildMap } from './zig-build.js';
import type { ZigFileEntry, ZigFileFacts } from './zig-declarations.js';

/** One name an `@import` binds into a file's namespace (BR-9). */
export interface ZigBinding {
  /** The spec as written: `std`, `../Store.zig`, a `build.zig` module name, a header name. */
  spec: string;
  /** Repo-relative target, present only when the spec resolves INSIDE the parse scope. */
  targetRelPath?: string;
  /** The whole selector off the import (`@import("x").Outer.Inner` → `['Outer','Inner']`), empty for a namespace import. */
  members: string[];
  isPub: boolean;
}

export interface ZigImportIndex {
  /** relPath → local name → binding. First declaration of a name wins. */
  byFile: Map<string, Map<string, ZigBinding>>;
  /** relPath → spec → in-scope target, for every occurrence INCLUDING unnamed ones. */
  specTargets: Map<string, Map<string, string>>;
}

/** Default re-export hop limit: three files between the caller and the declaration (BR-12). */
const DEFAULT_HOPS = 3;

/**
 * Specs the Zig toolchain ALWAYS answers itself. `build.zig` is ordinary user code and may bind a
 * module named `std` (RT1); honouring that would turn every `@import("std")` in the repo into an
 * in-repo file edge and make `std.mem.eql()` a call to a repo function. The reserved names win.
 */
const RESERVED_SPECS: ReadonlySet<string> = new Set(['std', 'builtin', 'root']);

/**
 * Resolve one spec against the importing file. A `.zig` path is normalised POSIX-style with no
 * leading `./`; a bare name is looked up in the `build.zig` module map. Both must land inside
 * the parse scope, or the import is external.
 */
function resolveSpec(
  relPath: string,
  spec: string,
  build: ZigBuildMap,
  inScope: ReadonlySet<string>,
): string | undefined {
  if (RESERVED_SPECS.has(spec)) return undefined;
  const candidate = spec.endsWith('.zig')
    ? posix.normalize(posix.join(posix.dirname(relPath), spec))
    : build.modules.get(spec);
  return candidate !== undefined && inScope.has(candidate) ? candidate : undefined;
}

/** Binding table + spec→target map for every file (BR-9). */
export function buildZigImportTables(
  files: ReadonlyArray<ZigFileEntry>,
  build: ZigBuildMap,
  inScope: ReadonlySet<string>,
): ZigImportIndex {
  const index: ZigImportIndex = { byFile: new Map(), specTargets: new Map() };

  for (const { relPath, facts } of files) {
    const bindings = new Map<string, ZigBinding>();
    const targets = new Map<string, string>();
    for (const raw of facts.imports) {
      // A `@cInclude` header names a C translation unit, never a file in this parse scope.
      const target = raw.kind === 'cinclude' ? undefined : resolveSpec(relPath, raw.spec, build, inScope);
      if (target !== undefined) targets.set(raw.spec, target);
      // A function-local / test-local binding is lexical to that body: its ImportEdge is still
      // emitted above, but it must not become a FILE binding every other function resolves
      // against (BR-9). The call tiers see it as one of the caller's locals instead.
      if (!raw.bindsFileScope || !raw.localName || bindings.has(raw.localName)) continue;
      bindings.set(raw.localName, {
        spec: raw.spec,
        ...(target !== undefined ? { targetRelPath: target } : {}),
        members: raw.members,
        isPub: raw.isPub,
      });
    }
    index.byFile.set(relPath, bindings);
    index.specTargets.set(relPath, targets);
  }
  return index;
}

/**
 * The file (and remaining member) a name in `relPath` finally denotes, following the target
 * file's own `pub` re-export bindings. `pub const Client = @import("net/Client.zig")` in a hub
 * file is what makes `hub.Client.init()` reach `src/net/Client.zig`; the hop cap and the seen
 * set are what make a re-export CYCLE terminate instead of hanging the parse.
 */
export function resolveBinding(
  index: ZigImportIndex,
  relPath: string,
  headName: string,
  hops = DEFAULT_HOPS,
): { targetRelPath: string; members: string[] } | undefined {
  const binding = index.byFile.get(relPath)?.get(headName);
  if (!binding?.targetRelPath) return undefined;

  let file = binding.targetRelPath;
  let members = binding.members;
  const seen = new Set<string>([`${relPath}:${headName}`]);
  // Only a SINGLE selector can be a re-export name in the target file; a deeper selector
  // (`.Outer.Inner`) is a nested container path, which no binding table hop can shorten.
  for (let hop = 0; hop < hops && members.length === 1; hop++) {
    const key = `${file}:${members[0]}`;
    if (seen.has(key)) break;
    seen.add(key);
    const next = index.byFile.get(file)?.get(members[0]);
    if (!next?.isPub || !next.targetRelPath) break;
    file = next.targetRelPath;
    members = next.members;
  }
  return { targetRelPath: file, members };
}

/**
 * The emitted class/enum/function a SELECTOR denotes in its target file, when it is one. A
 * nested container carries its dotted qualified name (BR-4), so the whole selector is the key —
 * `Outer.Inner`, never just `Outer`.
 */
function nameIndexOf(target: ZigFileFacts): Map<string, string> {
  const byName = new Map<string, string>();
  // Class first, then enum, then top-level function — the order the lookup used to try them.
  // A function name can never collide with a dotted container name, so one map is enough.
  for (const c of target.decls.classes) if (!byName.has(c.name)) byName.set(c.name, c.id);
  for (const e of target.decls.enums) if (!byName.has(e.name)) byName.set(e.name, e.id);
  for (const [name, fn] of target.index.topLevelFunctions) if (!byName.has(name)) byName.set(name, fn.id);
  return byName;
}

/**
 * One `ImportEdge` per distinct `(file, spec)` (BR-10), in file order then first-seen spec
 * order. `importKind` is `named` as soon as ANY binding of that spec selects a member, because
 * that is the strongest statement the edge can make about what was actually imported.
 */
export function emitZigImports(
  files: ReadonlyArray<ZigFileEntry>,
  index: ZigImportIndex,
  idGen: StableIdGenerator,
): ImportEdge[] {
  const byPath = new Map(files.map((f) => [f.relPath, f.facts]));
  // Built at most once per target file, not once per selector.
  const nameIndexes = new Map<string, Map<string, string>>();
  const resolvedIdOf = (targetPath: string, members: string[]): string | undefined => {
    let index = nameIndexes.get(targetPath);
    if (!index) {
      const facts = byPath.get(targetPath);
      if (!facts) return undefined;
      index = nameIndexOf(facts);
      nameIndexes.set(targetPath, index);
    }
    return index.get(members.join('.'));
  };
  const edges: ImportEdge[] = [];

  for (const { relPath, facts } of files) {
    const fileId = idGen.fileId(relPath);
    const targets = index.specTargets.get(relPath);
    const groups = new Map<string, { names: ImportedName[]; named: boolean }>();

    for (const raw of facts.imports) {
      const group = groups.get(raw.spec) ?? { names: [], named: false };
      if (raw.localName) {
        const target = targets?.get(raw.spec);
        if (raw.members.length > 0) {
          const resolvedId = target ? resolvedIdOf(target, raw.members) : undefined;
          group.named = true;
          group.names.push({
            name: raw.members.join('.'),
            alias: raw.localName,
            ...(resolvedId !== undefined ? { resolvedId } : {}),
          });
        } else {
          group.names.push({ name: '*', alias: raw.localName });
        }
      }
      groups.set(raw.spec, group);
    }

    for (const [spec, group] of groups) {
      const target = targets?.get(spec);
      edges.push({
        id: idGen.importEdgeId(fileId, spec),
        sourceFileId: fileId,
        moduleSpecifier: spec,
        ...(target ? { targetFileId: idGen.fileId(target) } : {}),
        // Zig has no type-only import: `@import` binds a value namespace either way.
        isTypeOnly: false,
        importKind: group.named ? ('named' as const) : ('namespace' as const),
        ...(group.names.length > 0 ? { importedNames: group.names } : {}),
      });
    }
  }
  return edges;
}
