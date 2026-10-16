import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type PythonFile } from './python-cst.js';
import { type PythonEntityConfig, extractPythonEntities } from './python-entities.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

/** Same seed the parser uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');

/** Build a PythonFile (relPath + source + parsed root) the way the parser does. */
async function pf(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parseSource('python', source) };
}

const DJANGO_CFG: PythonEntityConfig = { idGen: ID, baseClasses: ['models.Model'] };

const USER_SRC = `
class User(models.Model):
    email = models.CharField(max_length=200, unique=True)
    age = models.IntegerField(null=True)
    ident = models.UUIDField(primary_key=True)
    org = models.ForeignKey('Org', on_delete=models.CASCADE)
    peers = models.ManyToManyField('self')

    class Meta:
        db_table = 'custom_users'
`;

const ORG_SRC = `
class Org(models.Model):
    name = models.CharField(max_length=50)
`;

const NOT_AN_ENTITY_SRC = `
class Report:
    def run(self):
        return 1
`;

describe('extractPythonEntities', () => {
  it('extracts one EntityNode per models.Model subclass, ormType django', async () => {
    const files = [
      await pf('app/user.py', USER_SRC),
      await pf('app/org.py', ORG_SRC),
      await pf('app/report.py', NOT_AN_ENTITY_SRC),
    ];
    const { entities } = await extractPythonEntities(files, DJANGO_CFG);
    expect(entities.map((e) => e.name).sort()).toEqual(['Org', 'User']);
    const user = entities.find((e) => e.name === 'User')!;
    expect(user.kind).toBe('entity');
    expect(user.ormType).toBe('django');
    // A class that does NOT subclass a configured base is ignored.
    expect(entities.find((e) => e.name === 'Report')).toBeUndefined();
  });

  it('reads fields from class-level assignments with ORM field-class types', async () => {
    const { entities } = await extractPythonEntities([await pf('app/user.py', USER_SRC)], DJANGO_CFG);
    const user = entities.find((e) => e.name === 'User')!;

    const email = user.fields.find((f) => f.name === 'email')!;
    expect(email).toMatchObject({
      name: 'email',
      columnName: 'email',
      dbType: 'CharField',
      isUnique: true,
      isNullable: false,
      isPrimaryKey: false,
      isGenerated: false,
    });
    // The field type is the ORM field class name read off the RHS call callee.
    expect(email.type.text).toBe('CharField');

    const age = user.fields.find((f) => f.name === 'age')!;
    expect(age.isNullable).toBe(true);
    expect(age.dbType).toBe('IntegerField');

    // primary_key=True kwarg → isPrimaryKey.
    const ident = user.fields.find((f) => f.name === 'ident')!;
    expect(ident.isPrimaryKey).toBe(true);
  });

  it('treats a field named `id` as the primary key even without the kwarg', async () => {
    const src = `
class Thing(models.Model):
    id = models.AutoField()
    label = models.CharField(max_length=10)
`;
    const { entities } = await extractPythonEntities([await pf('app/thing.py', src)], DJANGO_CFG);
    const thing = entities.find((e) => e.name === 'Thing')!;
    expect(thing.fields.find((f) => f.name === 'id')?.isPrimaryKey).toBe(true);
    expect(thing.fields.find((f) => f.name === 'label')?.isPrimaryKey).toBe(false);
  });

  it('maps ForeignKey/OneToOneField/ManyToManyField assignments to relations', async () => {
    const files = [await pf('app/user.py', USER_SRC), await pf('app/org.py', ORG_SRC)];
    const { entities, entityIdByName } = await extractPythonEntities(files, DJANGO_CFG);
    const user = entities.find((e) => e.name === 'User')!;

    const org = user.relations.find((r) => r.name === 'org')!;
    expect(org.type).toBe('many-to-one');
    expect(org.targetEntityName).toBe('Org');
    // Org is a known entity here → its id resolves.
    expect(org.targetEntityId).toBe(entityIdByName.get('Org'));
    expect(org.targetEntityId).toBe(ID.entityId('app/org.py', 'Org'));

    // ManyToManyField('self') → self-referential relation to the enclosing model.
    const peers = user.relations.find((r) => r.name === 'peers')!;
    expect(peers.type).toBe('many-to-many');
    expect(peers.targetEntityName).toBe('User');
    expect(peers.targetEntityId).toBe(entityIdByName.get('User'));
  });

  it('leaves an unknown relation target unresolved (never fabricates an id)', async () => {
    // Org NOT provided this time → target name kept, id undefined.
    const { entities } = await extractPythonEntities([await pf('app/user.py', USER_SRC)], DJANGO_CFG);
    const org = entities.find((e) => e.name === 'User')!.relations.find((r) => r.name === 'org')!;
    expect(org.targetEntityName).toBe('Org');
    expect(org.targetEntityId).toBeUndefined();
  });

  it("resolves tableName from Meta.db_table, else Django's <app_label>_<model> default", async () => {
    const files = [await pf('app/user.py', USER_SRC), await pf('app/org.py', ORG_SRC)];
    const { entities } = await extractPythonEntities(files, DJANGO_CFG);
    expect(entities.find((e) => e.name === 'User')?.tableName).toBe('custom_users');
    // Org has no Meta.db_table and no apps.py → the first path segment is the app label,
    // which is what Django creates for a conventional single-package layout (G10).
    expect(entities.find((e) => e.name === 'Org')?.tableName).toBe('app_org');
  });

  it('mints ids via the single StableIdGenerator with a real-checksum versionedId', async () => {
    const { entities, entityIdByName } = await extractPythonEntities([await pf('app/org.py', ORG_SRC)], DJANGO_CFG);
    const org = entities.find((e) => e.name === 'Org')!;
    const expectedId = ID.entityId('app/org.py', 'Org');
    expect(org.id).toBe(expectedId);
    expect(org.fileId).toBe(ID.fileId('app/org.py'));
    expect(entityIdByName.get('Org')).toBe(expectedId);
    // versionedId is a real content checksum (not the legacy literal @1).
    expect(ID.getStableId(org.versionedId)).toBe(expectedId);
    expect(org.versionedId).not.toBe(`${expectedId}@1`);
    expect(org.location.filePath).toBe('app/org.py');
  });

  it('flips versionedId only when the model source changes', async () => {
    const a = await extractPythonEntities([await pf('app/org.py', ORG_SRC)], DJANGO_CFG);
    const bSrc = ORG_SRC.replace('max_length=50', 'max_length=99');
    const b = await extractPythonEntities([await pf('app/org.py', bSrc)], DJANGO_CFG);
    const orgA = a.entities.find((e) => e.name === 'Org')!;
    const orgB = b.entities.find((e) => e.name === 'Org')!;
    expect(orgA.id).toBe(orgB.id);
    expect(orgA.versionedId).not.toBe(orgB.versionedId);
  });

  it('matches a project base class by dotted suffix when configured', async () => {
    const src = `
class Account(app.core.BaseModel):
    name = models.CharField(max_length=10)
`;
    // Default django base does NOT match app.core.BaseModel.
    const def = await extractPythonEntities([await pf('app/account.py', src)], DJANGO_CFG);
    expect(def.entities.find((e) => e.name === 'Account')).toBeUndefined();

    // A configured project base `BaseModel` matches app.core.BaseModel by suffix.
    const cfg: PythonEntityConfig = { idGen: ID, baseClasses: ['BaseModel'] };
    const withBase = await extractPythonEntities([await pf('app/account.py', src)], cfg);
    expect(withBase.entities.find((e) => e.name === 'Account')).toBeDefined();
  });

  it('emits NO EntityNode for a base-less or non-matching class; only a configured-base subclass (FIX 5)', async () => {
    const src = `
class Plain:
    def run(self):
        return 1

class Other(SomethingElse):
    label = models.CharField(max_length=10)

class Real(models.Model):
    name = models.CharField(max_length=10)
`;
    const { entities } = await extractPythonEntities([await pf('app/mix.py', src)], DJANGO_CFG);
    // `class Plain:` (no bases) and `class Other(SomethingElse):` (base not configured) → no entity.
    expect(entities.find((e) => e.name === 'Plain')).toBeUndefined();
    expect(entities.find((e) => e.name === 'Other')).toBeUndefined();
    // Only the class subclassing the configured base is emitted — locks the no-false-entity guarantee.
    expect(entities.map((e) => e.name)).toEqual(['Real']);
  });

  it('emits models that reach models.Model transitively, with full fields + Django tableName (G3)', async () => {
    const utils = await pf(
      'app/models/utils.py',
      `
from django.db import models

class UUIDModel(models.Model):
    id = models.UUIDField(primary_key=True)

    class Meta:
        abstract = True

class CreatedMetaFields(UUIDModel):
    created_at = models.DateTimeField(null=True)

    class Meta:
        abstract = True
`,
    );
    const team = await pf(
      'app/models/team.py',
      `
from app.models.utils import CreatedMetaFields

class SyncMixin:
    pass

class Team(SyncMixin, CreatedMetaFields):
    name = models.CharField(max_length=10, unique=True)
`,
    );
    const { entities, entityIdByName } = await extractPythonEntities([utils, team], DJANGO_CFG);

    // The abstract bases are bases, not tables — only the concrete multi-base model is emitted.
    expect(entities.map((e) => e.name)).toEqual(['Team']);
    const t = entities[0];
    // Fields and tableName go through exactly the same extraction as a direct models.Model subclass.
    expect(t.fields.find((f) => f.name === 'name')).toMatchObject({ dbType: 'CharField', isUnique: true });
    expect(t.tableName).toBe('app_team');
    expect(t.ormType).toBe('django');
    expect(entityIdByName.get('Team')).toBe(ID.entityId('app/models/team.py', 'Team'));
  });

  it('keeps a NON-abstract intermediate model as its own table (concrete inheritance)', async () => {
    const src = `
class Base(models.Model):
    name = models.CharField(max_length=10)

class Child(Base):
    extra = models.CharField(max_length=10)
`;
    const { entities } = await extractPythonEntities([await pf('app/inherit.py', src)], DJANGO_CFG);
    expect(entities.map((e) => e.name).sort()).toEqual(['Base', 'Child']);
  });

  it('leaves non-django ORMs single-hop (no transitive widening)', async () => {
    const cfg: PythonEntityConfig = { idGen: ID, baseClasses: ['Base'], orm: 'sqlalchemy' };
    const src = `
class Base:
    pass

class Widget(Base):
    name = models.CharField(max_length=5)

class Gadget(Widget):
    name = models.CharField(max_length=5)
`;
    const { entities } = await extractPythonEntities([await pf('app/widget.py', src)], cfg);
    expect(entities.map((e) => e.name)).toEqual(['Widget']);
  });

  it('honors an explicit orm override', async () => {
    const cfg: PythonEntityConfig = { idGen: ID, baseClasses: ['Base'], orm: 'sqlalchemy' };
    const src = `
class Widget(Base):
    name = models.CharField(max_length=5)
`;
    const { entities } = await extractPythonEntities([await pf('app/widget.py', src)], cfg);
    expect(entities.find((e) => e.name === 'Widget')?.ormType).toBe('sqlalchemy');
  });
});
