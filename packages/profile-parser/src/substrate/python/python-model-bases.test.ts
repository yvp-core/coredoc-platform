import { describe, expect, it } from 'vitest';
import { type PythonFile, type TsNode, defName, parsePython } from './python-cst.js';
import { buildModelBaseResolver, isAbstractModel } from './python-model-bases.js';

async function pf(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parsePython(source) };
}

/** The named class node in a parsed file (first definition wins, like the resolver's index). */
function classOf(file: PythonFile, name: string): TsNode {
  const node = (file.root.descendantsOfType('class_definition') as TsNode[]).find((c) => defName(c) === name);
  if (!node) throw new Error(`no class ${name} in ${file.relPath}`);
  return node;
}

/** Whether the resolver calls `name` in `file` a model. */
function isModel(resolver: ReturnType<typeof buildModelBaseResolver>, file: PythonFile, name: string): boolean {
  return resolver.isModel(file.relPath, classOf(file, name), name);
}

const DJANGO = { baseClasses: ['models.Model'], transitive: true };

describe('buildModelBaseResolver — transitive Django base resolution', () => {
  it('resolves a two-hop chain A → B → models.Model through imports', async () => {
    const utils = await pf(
      'app/models/utils.py',
      `
from django.db import models

class UUIDModel(models.Model):
    id = models.UUIDField(primary_key=True)

    class Meta:
        abstract = True
`,
    );
    const team = await pf(
      'app/models/team.py',
      `
from app.models.utils import UUIDModel

class Team(UUIDModel):
    name = models.CharField(max_length=10)
`,
    );
    const r = buildModelBaseResolver([utils, team], DJANGO);
    expect(isModel(r, utils, 'UUIDModel')).toBe(true);
    expect(isModel(r, team, 'Team')).toBe(true);
  });

  it('resolves a three-hop chain and a dotted `mod.Class` base', async () => {
    const a = await pf(
      'app/a.py',
      `
class RootModel(models.Model):
    pass
`,
    );
    const b = await pf(
      'app/b.py',
      `
from app.a import RootModel

class MidModel(RootModel):
    pass
`,
    );
    const c = await pf(
      'app/c.py',
      `
from app import b

class Leaf(b.MidModel):
    pass
`,
    );
    const r = buildModelBaseResolver([a, b, c], DJANGO);
    expect(isModel(r, c, 'Leaf')).toBe(true);
  });

  it('resolves a multi-base combo when ANY base reaches models.Model', async () => {
    const base = await pf(
      'app/base.py',
      `
class UUIDTModel(models.Model):
    pass

class FileSystemSyncMixin:
    def sync(self):
        return 1
`,
    );
    const survey = await pf(
      'app/survey.py',
      `
from app.base import FileSystemSyncMixin, UUIDTModel

class Survey(FileSystemSyncMixin, UUIDTModel):
    pass
`,
    );
    const r = buildModelBaseResolver([base, survey], DJANGO);
    expect(isModel(r, survey, 'Survey')).toBe(true);
    // The pure mixin itself is not a model.
    expect(isModel(r, base, 'FileSystemSyncMixin')).toBe(false);
  });

  it('resolves an import-aliased models.Model', async () => {
    const aliased = await pf(
      'app/aliased.py',
      `
import django.db.models as dj

class Thing(dj.Model):
    pass
`,
    );
    const fromImport = await pf(
      'app/from_import.py',
      `
from django.db.models import Model as DjangoModel

class Other(DjangoModel):
    pass
`,
    );
    const r = buildModelBaseResolver([aliased, fromImport], DJANGO);
    expect(isModel(r, aliased, 'Thing')).toBe(true);
    expect(isModel(r, fromImport, 'Other')).toBe(true);
  });

  it('is cycle-safe (A → B → A never recurses forever)', async () => {
    const a = await pf(
      'app/cyc_a.py',
      `
from app.cyc_b import B

class A(B):
    pass
`,
    );
    const b = await pf(
      'app/cyc_b.py',
      `
from app.cyc_a import A

class B(A):
    pass
`,
    );
    const r = buildModelBaseResolver([a, b], DJANGO);
    expect(isModel(r, a, 'A')).toBe(false);
    expect(isModel(r, b, 'B')).toBe(false);
  });

  it('resolves a base defined in the same file without any import', async () => {
    const file = await pf(
      'app/local.py',
      `
class LocalBase(models.Model):
    pass

class Child(LocalBase):
    pass
`,
    );
    const r = buildModelBaseResolver([file], DJANGO);
    expect(isModel(r, file, 'Child')).toBe(true);
  });

  it('falls back to a repo-unique name when no import binds the base, and refuses an ambiguous one', async () => {
    const defs = await pf(
      'app/defs.py',
      `
class UniqueBase(models.Model):
    pass
`,
    );
    const dupeA = await pf(
      'app/dupe_a.py',
      `
class DupeBase(models.Model):
    pass
`,
    );
    const dupeB = await pf(
      'app/dupe_b.py',
      `
class DupeBase:
    pass
`,
    );
    // Star import → no binding in the table, so both bases arrive unbound.
    const user = await pf(
      'app/user.py',
      `
from app.defs import *
from app.dupe_a import *

class UsesUnique(UniqueBase):
    pass

class UsesDupe(DupeBase):
    pass
`,
    );
    const r = buildModelBaseResolver([defs, dupeA, dupeB, user], DJANGO);
    expect(isModel(r, user, 'UsesUnique')).toBe(true);
    // Two classes named DupeBase and no import binding → ambiguous, left unresolved.
    expect(isModel(r, user, 'UsesDupe')).toBe(false);
  });

  it('prefers the import-resolved class over a same-name class in another module', async () => {
    const real = await pf(
      'app/real.py',
      `
class Shared(models.Model):
    pass
`,
    );
    const decoy = await pf(
      'app/decoy.py',
      `
class Shared:
    pass
`,
    );
    const viaDecoy = await pf(
      'app/via_decoy.py',
      `
from app.decoy import Shared

class Child(Shared):
    pass
`,
    );
    const viaReal = await pf(
      'app/via_real.py',
      `
from app.real import Shared

class Child(Shared):
    pass
`,
    );
    const r = buildModelBaseResolver([real, decoy, viaDecoy, viaReal], DJANGO);
    expect(isModel(r, viaDecoy, 'Child')).toBe(false);
    expect(isModel(r, viaReal, 'Child')).toBe(true);
  });

  it('keeps single-hop behaviour when transitivity is off (non-django ORMs)', async () => {
    const base = await pf(
      'app/sa.py',
      `
class Base:
    pass

class Widget(Base):
    pass

class Gadget(Widget):
    pass
`,
    );
    const r = buildModelBaseResolver([base], { baseClasses: ['Base'], transitive: false });
    expect(isModel(r, base, 'Widget')).toBe(true);
    // Gadget only reaches Base through Widget → NOT a model in single-hop mode.
    expect(isModel(r, base, 'Gadget')).toBe(false);
  });

  it('resolves transitively through a configured non-default base too', async () => {
    const file = await pf(
      'app/custom.py',
      `
class ProjectBase(app.core.BaseModel):
    pass

class Leaf(ProjectBase):
    pass
`,
    );
    const r = buildModelBaseResolver([file], { baseClasses: ['BaseModel'], transitive: true });
    expect(isModel(r, file, 'Leaf')).toBe(true);
  });

  it('resolves an arbitrarily deep chain without recursion depth mattering', async () => {
    // 400 links off models.Model — propagation visits each link once, so no depth cap is needed.
    const lines = ['class L0(models.Model):', '    pass', ''];
    for (let i = 1; i <= 400; i++) lines.push(`class L${i}(L${i - 1}):`, '    pass', '');
    const file = await pf('app/deep.py', lines.join('\n'));
    const r = buildModelBaseResolver([file], DJANGO);
    expect(isModel(r, file, 'L1')).toBe(true);
    expect(isModel(r, file, 'L400')).toBe(true);
  });
});

describe('isAbstractModel', () => {
  it('is true only for a class whose Meta declares abstract = True', async () => {
    const file = await pf(
      'app/abstract.py',
      `
class Abstract(models.Model):
    class Meta:
        abstract = True

class Concrete(models.Model):
    class Meta:
        ordering = ['id']

class NotAbstract(models.Model):
    class Meta:
        abstract = False

class NoMeta(models.Model):
    pass
`,
    );
    expect(isAbstractModel(classOf(file, 'Abstract'))).toBe(true);
    expect(isAbstractModel(classOf(file, 'Concrete'))).toBe(false);
    expect(isAbstractModel(classOf(file, 'NotAbstract'))).toBe(false);
    expect(isAbstractModel(classOf(file, 'NoMeta'))).toBe(false);
  });
});
