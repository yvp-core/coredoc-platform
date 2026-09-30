/**
 * AC-9 / BR-13: `cli` entrypoints for exported top-level `main`s, named by `build.zig`.
 *
 * The fixture carries both exe shapes (const-bound module, helper-fn parameters) plus a `main`
 * the build does not claim, so the `exeByRoot` lookup and the basename fallback are both live.
 * The negatives are the ones that would silently inflate `totalEntrypoints`: a non-`pub` `main`,
 * a `main` nested in a container, and `pub fn maintenance`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ZigBuildMap, parseZigBuild } from './zig-build.js';
import { type ZigFile, type ZigFileEntry, extractZigFileFacts, toZigFile } from './zig-declarations.js';
import { emitZigEntrypoints } from './zig-entrypoints.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mini-zig-data');
const SOURCES = ['src/main.zig', 'src/second.zig', 'src/third.zig'];
const idGen = new StableIdGenerator(FIXTURE, 'mini-zig-data');

const parsed: ZigFile[] = [];
let files: ZigFileEntry[];
let build: ZigBuildMap;

beforeAll(async () => {
  for (const relPath of SOURCES) parsed.push(await toZigFile(relPath, readFileSync(join(FIXTURE, relPath), 'utf-8')));
  files = parsed.map((file) => ({ relPath: file.relPath, facts: extractZigFileFacts(file, idGen) }));
  build = await parseZigBuild(FIXTURE);
});

afterAll(() => releaseParsedTrees(parsed));

/** BR-13: the entrypoint versions on its HANDLER's text, not on the command name. */
const handlerSource = (relPath: string): string =>
  files.find((f) => f.relPath === relPath)?.facts.index.topLevelFunctions.get('main')?.sourceCode as string;

describe('emitZigEntrypoints', () => {
  it('emits one cli entrypoint per exported top-level main, named by build.zig or the basename', () => {
    const entrypoints = emitZigEntrypoints(files, build, idGen);

    expect(entrypoints).toEqual([
      {
        id: idGen.entrypointId('cli', 'tool', 'src/main.zig'),
        versionedId: idGen.versionedId(
          idGen.entrypointId('cli', 'tool', 'src/main.zig'),
          handlerSource('src/main.zig'),
        ),
        type: 'cli',
        handlerId: idGen.functionId('src/main.zig', 'main'),
        location: { filePath: 'src/main.zig', startLine: 3, endLine: 5 },
        details: { type: 'cli', command: 'tool' },
      },
      {
        id: idGen.entrypointId('cli', 'second-tool', 'src/second.zig'),
        versionedId: idGen.versionedId(
          idGen.entrypointId('cli', 'second-tool', 'src/second.zig'),
          handlerSource('src/second.zig'),
        ),
        type: 'cli',
        handlerId: idGen.functionId('src/second.zig', 'main'),
        location: { filePath: 'src/second.zig', startLine: 3, endLine: 5 },
        details: { type: 'cli', command: 'second-tool' },
      },
      {
        // No executable roots at this file → the basename is the command (BR-13, LIM-E).
        id: idGen.entrypointId('cli', 'third', 'src/third.zig'),
        versionedId: idGen.versionedId(
          idGen.entrypointId('cli', 'third', 'src/third.zig'),
          handlerSource('src/third.zig'),
        ),
        type: 'cli',
        handlerId: idGen.functionId('src/third.zig', 'main'),
        location: { filePath: 'src/third.zig', startLine: 2, endLine: 2 },
        details: { type: 'cli', command: 'third' },
      },
    ]);
  });

  it('emits nothing for `pub fn maintenance` or a `main` nested in a container', () => {
    const third = files.find((f) => f.relPath === 'src/third.zig') as ZigFileEntry;
    const entrypoints = emitZigEntrypoints([third], build, idGen);

    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].details).toEqual({ type: 'cli', command: 'third' });
    // Both rejected names ARE emitted functions — they are just not the program entry.
    expect(third.facts.decls.functions.map((f) => f.name).sort()).toEqual(['main', 'main', 'maintenance']);
  });

  it('versions on the handler’s source, so renaming the exe alone does not re-version it', () => {
    const [entrypoint] = emitZigEntrypoints(files, build, idGen);
    expect(entrypoint.versionedId).not.toBe(idGen.versionedId(entrypoint.id, 'tool'));
    expect(handlerSource('src/main.zig')).toContain('fn main');
  });

  it('emits nothing for a non-`pub` top-level main', async () => {
    const file = await toZigFile('src/quiet.zig', 'fn main() void {}\n');
    const facts = extractZigFileFacts(file, idGen);

    expect(facts.index.topLevelFunctions.get('main')?.isExported).toBe(false);
    expect(emitZigEntrypoints([{ relPath: file.relPath, facts }], build, idGen)).toEqual([]);
    releaseParsedTrees([file]);
  });
});
