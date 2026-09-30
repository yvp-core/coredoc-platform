/**
 * Zig ENTRYPOINTS (BR-13) — the one declarative entry a Zig program has: `pub fn main`.
 *
 * A Zig executable's entry is a top-level `main` that the build declares as an exe root; the
 * command NAME lives in `build.zig` (BR-13a), not in the source file, so `exeByRoot` decides it
 * and the file basename is the honest fallback when the build does not name the file. Nothing
 * else is an entrypoint here (LIM-C): `export fn` is a C-ABI callback, a `test` block is a test,
 * an `std.http.Server` accept loop and the CDP method `switch` have no declarative route table.
 *
 * Top-level is the whole gate: `facts.index.topLevelFunctions` holds exactly the functions the
 * walk found directly under `source_file` (a file-struct's methods included, since a bare call in
 * the file reaches them either way), so a `main` declared inside a nested container is absent by
 * construction rather than by a filter that could drift.
 */
import type { CliEntrypointDetails, Entrypoint, StableIdGenerator } from '@coredoc/core';
import type { ZigBuildMap } from './zig-build.js';
import { type ZigFileEntry, fileStructName } from './zig-declarations.js';

/** `cli` entrypoints for every exported top-level `main` (BR-13). */
export function emitZigEntrypoints(
  files: ReadonlyArray<ZigFileEntry>,
  build: ZigBuildMap,
  idGen: StableIdGenerator,
): Entrypoint[] {
  const out: Entrypoint[] = [];
  for (const { relPath, facts } of files) {
    const fn = facts.index.topLevelFunctions.get('main');
    // A non-`pub` `main` is not the program entry Zig links: no entrypoint, no fallback.
    if (!fn?.isExported) continue;

    const command = build.exeByRoot.get(relPath) ?? fileStructName(relPath);
    const id = idGen.entrypointId('cli', command, relPath);
    const details: CliEntrypointDetails = { type: 'cli', command };
    out.push({
      id,
      // The handler's own text: renaming the exe changes the id, but only an edit to `main`
      // changes the VERSION of the entrypoint.
      versionedId: idGen.versionedId(id, fn.sourceCode ?? command),
      type: 'cli',
      handlerId: fn.id,
      location: fn.location,
      details,
    });
  }
  return out;
}
