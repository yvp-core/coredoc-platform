import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type KotlinFileFacts, extractKotlinFileFacts, toKotlinFile } from './kotlin-declarations.js';
import { type KotlinEntitiesConfig, extractKotlinEntities } from './kotlin-entities.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';

const idGen = new StableIdGenerator('repo-key');

async function entities(files: Record<string, string>, cfg: KotlinEntitiesConfig) {
  const all: KotlinFileFacts[] = [];
  for (const [path, source] of Object.entries(files)) {
    all.push(extractKotlinFileFacts(await toKotlinFile(path, source), idGen));
  }
  return extractKotlinEntities(all, new KotlinTypeIndex(all), idGen, cfg);
}

const ROOM: KotlinEntitiesConfig = { orm: 'room' };
const REALM: KotlinEntitiesConfig = { orm: 'realm' };

describe('Room entities', () => {
  it('reads the table name, the column renames and the primary key', async () => {
    const r = await entities(
      {
        'a/Thing.kt': [
          'package a',
          '@Entity(tableName = "things")',
          'class Thing(',
          '  @PrimaryKey val id: Int,',
          '  @ColumnInfo(name = "thing_name") val name: String,',
          '  @Ignore val cached: String',
          ')',
        ].join('\n'),
      },
      ROOM,
    );
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].ormType).toBe('room');
    expect(r.entities[0].tableName).toBe('things');
    expect(r.entities[0].fields.map((f) => `${f.name}:${f.columnName}:${f.isPrimaryKey}`)).toEqual([
      'id:id:true',
      'name:thing_name:false',
    ]);
  });

  it('reads nullability, generation and single-column unique indices from the declaration', async () => {
    const r = await entities(
      {
        'a/Thing.kt': [
          'package a',
          '@Entity(tableName = "things", indices = [Index(value = ["email"], unique = true)])',
          'class Thing(',
          '  @PrimaryKey(autoGenerate = true) val id: Int,',
          '  @ColumnInfo(name = "email") val email: String,',
          '  val nickname: String?,',
          ')',
        ].join('\n'),
      },
      ROOM,
    );
    expect(
      r.entities[0].fields.map((f) => `${f.name}:${f.type.text}:${f.isNullable}:${f.isUnique}:${f.isGenerated}`),
    ).toEqual(['id:Int:false:false:true', 'email:String:false:true:false', 'nickname:String:true:false:false']);
  });

  it('reads nullability of a body property too', async () => {
    const r = await entities(
      {
        'a/Thing.kt': [
          'package a',
          '@Entity',
          'class Thing {',
          '  @PrimaryKey var id: Int = 0',
          '  var note: String? = null',
          '}',
        ].join('\n'),
      },
      ROOM,
    );
    expect(r.entities[0].fields.map((f) => `${f.name}:${f.isNullable}`)).toEqual(['id:false', 'note:true']);
  });

  it('ANTI: @PrimaryKey without autoGenerate = true, and a MULTI-column unique index, mark nothing', async () => {
    const r = await entities(
      {
        'a/Thing.kt': [
          'package a',
          '@Entity(indices = [Index(value = ["a", "b"], unique = true), Index(value = ["c"])])',
          'class Thing(',
          '  @PrimaryKey(autoGenerate = false) val id: Int,',
          '  val a: String,',
          '  val b: String,',
          '  val c: String,',
          ')',
        ].join('\n'),
      },
      ROOM,
    );
    expect(r.entities[0].fields.every((f) => !f.isUnique)).toBe(true);
    expect(r.entities[0].fields.every((f) => !f.isGenerated)).toBe(true);
  });

  it('folds a companion const val one hop into the table name', async () => {
    const r = await entities(
      {
        'a/Thing.kt': [
          'package a',
          '@Entity(tableName = Thing.TABLE_NAME)',
          'class Thing(val id: Int) {',
          '  companion object { const val TABLE_NAME = "things" }',
          '}',
        ].join('\n'),
      },
      ROOM,
    );
    expect(r.entities[0].tableName).toBe('things');
  });

  it('ANTI: an unfoldable constant falls back to the class simple name, never a guess', async () => {
    const r = await entities(
      { 'a/Thing.kt': ['package a', '@Entity(tableName = Other.TABLE_NAME)', 'class Thing(val id: Int)'].join('\n') },
      ROOM,
    );
    expect(r.entities[0].tableName).toBe('Thing');
  });

  it('takes the primary key from the entity primaryKeys list', async () => {
    const r = await entities(
      {
        'a/Thing.kt': [
          'package a',
          '@Entity(tableName = "things", primaryKeys = ["id"])',
          'class Thing(val id: Int, val name: String)',
        ].join('\n'),
      },
      ROOM,
    );
    expect(r.entities[0].fields.filter((f) => f.isPrimaryKey).map((f) => f.name)).toEqual(['id']);
  });

  it('reads relations from foreignKeys', async () => {
    const r = await entities(
      {
        'a/Thing.kt': 'package a\n@Entity(tableName = "things")\nclass Thing(val id: Int)',
        'a/Part.kt': [
          'package a',
          '@Entity(tableName = "parts", foreignKeys = [ForeignKey(entity = Thing::class, parentColumns = ["id"], childColumns = ["thing_id"])])',
          'class Part(val id: Int, val thing_id: Int)',
        ].join('\n'),
      },
      ROOM,
    );
    const part = r.entities.find((e) => e.tableName === 'parts');
    expect(part?.relations.map((rel) => `${rel.targetEntityName}:${rel.joinColumn}`)).toEqual(['Thing:thing_id']);
    expect(part?.relations[0].targetEntityId).toBe(r.entities.find((e) => e.tableName === 'things')?.id);
  });

  it('ANTI: an unannotated class is not an entity', async () => {
    const r = await entities({ 'a/Thing.kt': 'package a\nclass Thing(val id: Int)' }, ROOM);
    expect(r.entities).toEqual([]);
  });
});

describe('Realm entities', () => {
  const src = {
    'a/Thing.kt': 'package a\nopen class Thing : RealmObject() {\n  var id: Int = 0\n  var part: Part? = null\n}',
    'a/Part.kt': 'package a\nopen class Part : RealmObject() {\n  var id: Int = 0\n}',
  };

  it('marks a class whose supertype chain reaches a configured base', async () => {
    const r = await entities(src, REALM);
    expect(r.entities.map((e) => e.tableName).sort()).toEqual(['Part', 'Thing']);
    expect(r.entities[0].ormType).toBe('realm');
  });

  it('follows an in-repo base class to the realm base', async () => {
    const r = await entities(
      {
        'a/Base.kt': 'package a\nopen class Base : RealmObject()',
        'a/Thing.kt': 'package a\nclass Thing : Base() {\n  var id: Int = 0\n}',
      },
      REALM,
    );
    expect(r.entities.map((e) => e.tableName).sort()).toEqual(['Base', 'Thing']);
  });

  it('types a property holding another entity as many-to-one and a realm list as one-to-many', async () => {
    const r = await entities(
      {
        ...src,
        'a/Box.kt': 'package a\nopen class Box : RealmObject() {\n  var parts: RealmList<Part> = RealmList()\n}',
      },
      REALM,
    );
    const thing = r.entities.find((e) => e.tableName === 'Thing');
    expect(thing?.relations.map((rel) => `${rel.name}:${rel.type}`)).toEqual(['part:many-to-one']);
    const box = r.entities.find((e) => e.tableName === 'Box');
    expect(box?.relations.map((rel) => `${rel.name}:${rel.type}:${rel.targetEntityName}`)).toEqual([
      'parts:one-to-many:Part',
    ]);
  });

  it('ANTI: an @Entity class under a realm profile emits no entity', async () => {
    const r = await entities(
      { 'a/Thing.kt': 'package a\n@Entity(tableName = "things")\nclass Thing(val id: Int)' },
      REALM,
    );
    expect(r.entities).toEqual([]);
  });

  it('ANTI: a class reaching an unrelated base emits no entity', async () => {
    const r = await entities({ 'a/Thing.kt': 'package a\nclass Thing : Other() {\n  var id: Int = 0\n}' }, REALM);
    expect(r.entities).toEqual([]);
  });
});
