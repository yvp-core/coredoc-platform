import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PY_EXCLUDES, discoverPythonFiles } from './python-cst.js';

/** A repo tree with the standard Python noise dirs plus real sources under app/. */
const TREE = [
  'app/x.py',
  'app/y.py',
  'app/stubs.pyi', // a typed stub — real defs, previously dropped
  'venv/lib/z.pyi',
  'venv/lib/z.py',
  '.venv/lib/z2.py',
  'site-packages/pkg/s.py',
  '__pycache__/c.py',
  'node_modules/dep/m.py',
  'app/migrations/0001_init.py',
  'app/foo_pb2.py',
  'README.md', // non-python — always filtered out
];

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'py-discovery-'));
  for (const rel of TREE) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, rel.endsWith('.py') ? '# fixture\n' : 'fixture\n');
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverPythonFiles — S3 file discovery & exclusions', () => {
  it('returns ONLY normal .py/.pyi sources under the default excludes', () => {
    const files = discoverPythonFiles(root, []);
    expect(files).toEqual(['app/stubs.pyi', 'app/x.py', 'app/y.py']);
    // A stub under an excluded tree stays excluded — the extension is not a bypass.
    expect(files).not.toContain('venv/lib/z.pyi');
    // Every noise path is excluded.
    for (const noisy of [
      'venv/lib/z.py',
      '.venv/lib/z2.py',
      'site-packages/pkg/s.py',
      '__pycache__/c.py',
      'node_modules/dep/m.py',
      'app/migrations/0001_init.py',
      'app/foo_pb2.py',
    ]) {
      expect(files).not.toContain(noisy);
    }
    // Non-.py never appears.
    expect(files.some((f) => f.endsWith('.md'))).toBe(false);
  });

  it('excludeDefaults:false restores venv/migrations/pb2 (node_modules stays pruned by the enumerator floor)', () => {
    const files = discoverPythonFiles(root, [], [], false);
    expect(files).toContain('venv/lib/z.py');
    expect(files).toContain('.venv/lib/z2.py');
    expect(files).toContain('site-packages/pkg/s.py');
    expect(files).toContain('__pycache__/c.py');
    expect(files).toContain('app/migrations/0001_init.py');
    expect(files).toContain('app/foo_pb2.py');
    expect(files).toContain('app/x.py');
    // node_modules is a hard enumerator floor (dropped even when tracked), not a py-glob exclude.
    expect(files).not.toContain('node_modules/dep/m.py');
  });

  it('a profile exclude EXTENDS the defaults', () => {
    const files = discoverPythonFiles(root, [], ['**/y.py', '**/*.pyi']);
    expect(files).toEqual(['app/x.py']);
  });

  it('an include of only **/*.py leaves stubs out (the profile decides)', () => {
    expect(discoverPythonFiles(root, ['**/*.py'])).toEqual(['app/x.py', 'app/y.py']);
  });

  it('an explicit include narrows the scope', () => {
    const files = discoverPythonFiles(root, ['app/x.py']);
    expect(files).toEqual(['app/x.py']);
  });

  it('ships the documented default exclude globs', () => {
    expect(DEFAULT_PY_EXCLUDES).toEqual([
      '**/venv/**',
      '**/.venv/**',
      '**/site-packages/**',
      '**/__pycache__/**',
      '**/node_modules/**',
      '**/migrations/**',
      '**/*_pb2.py',
    ]);
  });
});
