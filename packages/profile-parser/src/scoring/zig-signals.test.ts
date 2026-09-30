/**
 * AC-13 / BR-17: the Zig scorecard denominators.
 *
 * The point of these numbers is that they are measured the SAME way the parser measures its
 * numerators — same DDL parser, `test` blocks excluded, `\\` blocks dedented. So the fixture's
 * decoys (`pub fn maintenance`, a commented-out DDL, a table declared inside a `test` block)
 * must be absent from the denominator too, or a fully-correct parse would score below 100 %.
 *
 * `dbOperations` is omitted on purpose (RT3): distinct operated TABLES and op ROWS are different
 * units, so the row is self-relative and carries `dbOperationsNote` saying so.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ScoreContext } from './score-core.js';
import { zigSourceSignals } from './zig-signals.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'substrate',
  'zig',
  '__fixtures__',
  'mini-zig-data',
);
const SOURCES = ['build.zig', 'src/main.zig', 'src/second.zig', 'src/third.zig', 'src/net.zig', 'src/store.zig'];

/** The scorer only reads `repoRoot` + `sourceFiles`; the rest of the context is inert here. */
function ctx(repoRoot: string, sourceFiles: readonly string[]): ScoreContext {
  return { repoRoot, sourceFiles, outPath: '', profile: {}, parsed: {} } as unknown as ScoreContext;
}

/** A throwaway repo on disk — the scorer reads its files, not a fixture directory. */
function writeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'zig-signals-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('zigSourceSignals', () => {
  it('counts the observables each lane gates on, decoys excluded', () => {
    expect(zigSourceSignals(ctx(FIXTURE, SOURCES))).toEqual({
      http: 0,
      queue: 0,
      // `cache` + `cache_owner` + `pragma_first`; the commented-out and test-block tables are
      // not schema.
      entities: 3,
      // RT3: distinct operated TABLES cannot be divided into op ROWS — no denominator, a note.
      dbOperationsNote: 'operated-table count is not commensurable with op rows; db-ops score self-relative',
      // Two `std.http.Client` declarations; the extra call sites reuse them.
      externalCalls: 2,
      // Three `pub fn main`; `pub fn maintenance` and the nested non-`pub` `main` do not count.
      cli: 3,
    });
  });

  it('never supplies a dbOperations denominator — the row stays self-relative (RT3)', () => {
    const signals = zigSourceSignals(ctx(FIXTURE, SOURCES));

    expect(signals.dbOperations).toBeUndefined();
    expect(signals.dbOperationsNote).toContain('self-relative');
  });

  it('ends a `test` block at its real closing brace when a string holds a `}`', () => {
    // A brace scanner that reads `"}"` as code ends the block three lines early and scores the
    // test's own table as production schema. The `pub fn main` after it counts either way.
    const root = writeRepo({
      'src/main.zig': [
        'test "brace in a string" {',
        '    const s = "}";',
        '    _ = s;',
        '    const ddl = "create table ghost (id int)";',
        '}',
        '',
        'pub fn main() void {}',
      ].join('\n'),
    });

    expect(zigSourceSignals(ctx(root, ['src/main.zig']))).toMatchObject({ entities: 0, cli: 1 });
  });

  it('keeps a DDL literal whose text contains a `//` URL', () => {
    // `//` inside a string is not a comment: stripping it would truncate the statement and
    // lose the table the lane's numerator does extract.
    const root = writeRepo({
      'src/main.zig': [
        'pub fn go() void {',
        `    const ddl = "create table links (url text default 'https://x/y')";`,
        '    _ = ddl;',
        '}',
      ].join('\n'),
    });

    expect(zigSourceSignals(ctx(root, ['src/main.zig']))).toMatchObject({ entities: 1 });
  });

  it('returns zeros for a repo with no Zig sources', () => {
    const empty = mkdtempSync(join(tmpdir(), 'zig-signals-'));

    expect(zigSourceSignals(ctx(empty, []))).toEqual({
      http: 0,
      queue: 0,
      entities: 0,
      dbOperationsNote: 'operated-table count is not commensurable with op rows; db-ops score self-relative',
      externalCalls: 0,
      cli: 0,
    });
  });
});
