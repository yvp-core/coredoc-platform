import { describe, expect, it } from 'vitest';
import { type PythonFile } from './python-cst.js';
import { buildImportTable, buildModuleIndex, resolveImportedTarget, resolveModuleToFile } from './python-imports.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

async function file(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parseSource('python', source) };
}

describe('buildImportTable — per-file import policy (T3/eng)', () => {
  const SRC = `
from typing import TYPE_CHECKING
from a.b import c as d
import a.b as m
import json_std
from a import *
import importlib
importlib.import_module('dynamic')

if TYPE_CHECKING:
    from models.user import User

try:
    import fast_json as jsonlib
except ImportError:
    import json as jsonlib
`;

  it('binds `from a.b import c as d` → local d, module a.b, symbol c', async () => {
    const t = buildImportTable(await file('svc.py', SRC));
    expect(t.byLocal.get('d')).toEqual({ local: 'd', module: 'a.b', symbol: 'c', typeOnly: false });
  });

  it('binds `import a.b as m` → local m, module a.b, no symbol; plain `import json_std` → local=module', async () => {
    const t = buildImportTable(await file('svc.py', SRC));
    expect(t.byLocal.get('m')).toEqual({ local: 'm', module: 'a.b', symbol: undefined, typeOnly: false });
    expect(t.byLocal.get('json_std')).toEqual({
      local: 'json_std',
      module: 'json_std',
      symbol: undefined,
      typeOnly: false,
    });
  });

  it('flags `if TYPE_CHECKING:` imports as typeOnly (never runtime edges)', async () => {
    const t = buildImportTable(await file('svc.py', SRC));
    const user = t.byLocal.get('User');
    expect(user?.typeOnly).toBe(true);
    expect(user?.module).toBe('models.user');
    expect(user?.symbol).toBe('User');
    // A runtime import stays typeOnly:false.
    expect(t.byLocal.get('d')?.typeOnly).toBe(false);
  });

  it('records the PREFERRED (first/unconditional) candidate for a try/except ImportError binding', async () => {
    const t = buildImportTable(await file('svc.py', SRC));
    // Both branches bind `jsonlib`; the first (try) candidate is preferred.
    expect(t.byLocal.get('jsonlib')?.module).toBe('fast_json');
  });

  it('counts star imports + importlib dynamic dispatch as dropped (not bound)', async () => {
    const t = buildImportTable(await file('svc.py', SRC));
    // `from a import *` (star) + `importlib.import_module(...)` (dynamic) = 2 drops.
    expect(t.droppedDynamic).toBe(2);
    // Star import binds nothing named `*`.
    expect(t.byLocal.has('*')).toBe(false);
  });

  it('does NOT count `getattr(...)` as a dropped import — it is ordinary attribute access (FIX 2)', async () => {
    // getattr alone → 0 drops (not an import mechanism).
    const onlyGetattr = buildImportTable(await file('svc.py', 'def f(obj):\n    return getattr(obj, "x")\n'));
    expect(onlyGetattr.droppedDynamic).toBe(0);

    // getattr mixed with real dynamic-import mechanisms must not inflate the count: star +
    // importlib = 2, getattr adds nothing.
    const mixed = buildImportTable(
      await file(
        'svc.py',
        `import importlib
importlib.import_module('x')
from a import *
val = getattr(obj, 'attr')
`,
      ),
    );
    expect(mixed.droppedDynamic).toBe(2);
  });

  it('does NOT flag imports under `if not TYPE_CHECKING:` as typeOnly — runtime branch (FIX 3)', async () => {
    const src = `
from typing import TYPE_CHECKING

if not TYPE_CHECKING:
    import x
`;
    const t = buildImportTable(await file('svc.py', src));
    // Negated guard is a RUNTIME branch → the import must stay a runtime edge, not type-only.
    expect(t.byLocal.get('x')?.typeOnly).toBe(false);
  });
});

describe('buildModuleIndex + relative resolution (T3/eng)', () => {
  it('maps a package __init__.py and a pkg/mod.py to their module paths', async () => {
    const files = [
      await file('pkg/__init__.py', ''),
      await file('pkg/mod.py', ''),
      await file('pkg/x.py', ''),
      await file('pkg/sub.py', 'from . import x\n'),
    ];
    const index = buildModuleIndex(files);
    expect(index.get('pkg')).toBe('pkg/__init__.py');
    expect(index.get('pkg.mod')).toBe('pkg/mod.py');
    expect(index.get('pkg.x')).toBe('pkg/x.py');
    expect(index.get('pkg.sub')).toBe('pkg/sub.py');
    expect(resolveModuleToFile('pkg', index)).toBe('pkg/__init__.py');
    expect(resolveModuleToFile('nope.mod', index)).toBeUndefined();
  });

  it('resolves a relative `from . import x` in pkg/sub.py to pkg.x', async () => {
    const files = [
      await file('pkg/__init__.py', ''),
      await file('pkg/x.py', ''),
      await file('pkg/sub.py', 'from . import x\n'),
    ];
    const index = buildModuleIndex(files);
    const sub = files.find((f) => f.relPath === 'pkg/sub.py')!;
    const table = buildImportTable(sub);
    // The relative '.' is resolved against sub.py's package (pkg).
    expect(table.byLocal.get('x')?.module).toBe('pkg');
    const target = resolveImportedTarget(table, index, 'x');
    expect(target?.module).toBe('pkg.x');
    expect(target?.filePath).toBe('pkg/x.py');
  });

  it('resolves a `mod.attr` chain through an aliased import', async () => {
    const files = [await file('a/b.py', '')];
    // pretend a.b resolves; here the point is the chain head → module.
    const table = buildImportTable(await file('caller.py', 'import a.b as m\nm.f()\n'));
    const index = buildModuleIndex([...files, await file('caller.py', 'import a.b as m\n')]);
    const target = resolveImportedTarget(table, index, 'm.f');
    expect(target?.module).toBe('a.b');
    expect(target?.symbol).toBe('f');
  });
});

describe('buildModuleIndex — source roots (src/ layout)', () => {
  // A dotted module name is relative to the sys.path entry that holds it, not to the repo
  // root. Under a PEP-621 `src/` layout the code says `from myapp.services import f` while
  // the file is at `src/myapp/services.py`; indexing only the repo-relative path meant every
  // cross-file py-import edge in such a repo silently resolved to nothing.
  const SRC_LAYOUT = [
    ['src/myapp/__init__.py', ''],
    ['src/myapp/services.py', 'def handle():\n    pass\n'],
    ['src/myapp/sub/__init__.py', ''],
    ['src/myapp/sub/deep.py', 'def go():\n    pass\n'],
  ] as const;

  it('resolves a module named without the source root', async () => {
    const files = await Promise.all(SRC_LAYOUT.map(([p, s]) => file(p, s)));
    const index = buildModuleIndex(files);
    expect(resolveModuleToFile('myapp.services', index)).toBe('src/myapp/services.py');
    expect(resolveModuleToFile('myapp.sub.deep', index)).toBe('src/myapp/sub/deep.py');
    expect(resolveModuleToFile('myapp', index)).toBe('src/myapp/__init__.py');
  });

  it('keeps the repo-relative name resolvable too', async () => {
    const files = await Promise.all(SRC_LAYOUT.map(([p, s]) => file(p, s)));
    const index = buildModuleIndex(files);
    expect(resolveModuleToFile('src.myapp.services', index)).toBe('src/myapp/services.py');
  });

  it('does not strip a directory that IS a package', async () => {
    const files = await Promise.all([
      file('myapp/__init__.py', ''),
      file('myapp/services.py', 'def handle():\n    pass\n'),
    ]);
    const index = buildModuleIndex(files);
    expect(resolveModuleToFile('myapp.services', index)).toBe('myapp/services.py');
    // `services` alone would mean a top-level module, which this repo does not have.
    expect(resolveModuleToFile('services', index)).toBeUndefined();
  });

  it('resolves an import through a nested service dir (monorepo backend/)', async () => {
    const files = await Promise.all([
      file('backend/api/__init__.py', ''),
      file('backend/api/views.py', 'def index():\n    pass\n'),
    ]);
    const index = buildModuleIndex(files);
    expect(resolveModuleToFile('api.views', index)).toBe('backend/api/views.py');
  });
});
