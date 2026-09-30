import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type KotlinFileFacts, extractKotlinFileFacts, toKotlinFile } from './kotlin-declarations.js';
import { type KotlinDbOpsConfig, extractKotlinDbOps } from './kotlin-dbops.js';
import { type KotlinEntitiesConfig, extractKotlinEntities } from './kotlin-entities.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';

const idGen = new StableIdGenerator('repo-key');

async function run(files: Record<string, string>, cfg: KotlinEntitiesConfig & KotlinDbOpsConfig) {
  const all: KotlinFileFacts[] = [];
  for (const [path, source] of Object.entries(files)) {
    all.push(extractKotlinFileFacts(await toKotlinFile(path, source), idGen));
  }
  const index = new KotlinTypeIndex(all);
  const { entityIdByName } = extractKotlinEntities(all, index, idGen, cfg);
  const ops = extractKotlinDbOps(all, index, entityIdByName, idGen, cfg);
  return { ...ops, summary: ops.operations.map((o) => `${o.operation}:${o.entityName}`) };
}

const THING = 'package a\n@Entity(tableName = "things")\nclass Thing(val id: Int)';

describe('Room DAO operations', () => {
  it('maps each DAO annotation to its operation and attributes the entity', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Dao.kt': [
          'package a',
          '@Dao',
          'interface ThingDao {',
          '  @Insert fun add(thing: Thing)',
          '  @Update fun edit(thing: Thing)',
          '  @Delete fun drop(things: List<Thing>)',
          '  @Upsert fun put(thing: Thing)',
          '  @Query("SELECT * FROM things WHERE id = :id") fun byId(id: Int): Thing',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.summary).toEqual(['create:Thing', 'update:Thing', 'delete:Thing', 'create:Thing', 'read:Thing']);
    expect(r.operations.every((o) => o.entityId !== undefined)).toBe(true);
    expect(r.operations.every((o) => o.performerId.length > 0)).toBe(true);
  });

  it('folds a companion const val into the query before parsing it', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Dao.kt': [
          'package a',
          '@Dao',
          'abstract class ThingDao {',
          '  companion object { const val TABLE = "things" }',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Kotlin string interpolation, not JS
          '  @Query("DELETE FROM ${TABLE}") abstract fun clear()',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.summary).toEqual(['delete:Thing']);
  });

  it('ANTI: a @Transaction-only function emits nothing', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Dao.kt': ['package a', '@Dao', 'interface ThingDao {', '  @Transaction fun both() {}', '}'].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.operations).toEqual([]);
  });

  it('ANTI: a @Query with no table emits nothing and is counted', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Dao.kt': [
          'package a',
          '@Dao',
          'interface ThingDao {',
          '  @Query("PRAGMA user_version") fun version(): Int',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.operations).toEqual([]);
    expect(r.unparsedDaoQueries).toBe(1);
  });

  it('ANTI: a Retrofit @Query PARAMETER emits no operation (EC-2)', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Api.kt': [
          'package a',
          'interface Api {',
          '  @GET("things") fun list(@Query("since") since: String): Thing',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.operations).toEqual([]);
    expect(r.unparsedDaoQueries).toBe(0);
  });

  it('ANTI: a @Query outside a @Dao type emits no operation', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Helper.kt': [
          'package a',
          'interface Helper {',
          '  @Query("SELECT * FROM things") fun all(): Thing',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.operations).toEqual([]);
    expect(r.unparsedDaoQueries).toBe(0);
  });

  it('falls back to the annotation entity argument, then to unknown, never to a fabricated table', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Dao.kt': [
          'package a',
          '@Dao',
          'interface ThingDao {',
          '  @Delete(entity = Thing::class) fun dropById(id: Int)',
          '  @Insert fun addBlob(blob: Blob)',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.summary).toEqual(['delete:Thing', 'create:unknown']);
  });
});

describe('ANTI: a contested entity simple name joins on nothing', () => {
  it('emits the entityName but no entityId when two modules declare the same class name', async () => {
    const r = await run(
      {
        'a/Thing.kt': 'package a\n@Entity(tableName = "a_things")\nclass Thing(val id: Int)',
        'b/Thing.kt': 'package b\n@Entity(tableName = "b_things")\nclass Thing(val id: Int)',
        'b/Dao.kt': ['package b', '@Dao', 'interface ThingDao {', '  @Insert fun put(thing: Thing)', '}'].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.operations).toHaveLength(1);
    // Better an operation with no join than one pointing at the other module's table.
    expect(r.operations[0].entityId).toBeUndefined();
    expect(r.operations[0].entityName).toBe('Thing');
  });

  it("abstains when one entity's tableName is another entity's class name", async () => {
    const r = await run(
      {
        'a/Thing.kt': 'package a\n@Entity(tableName = "Other")\nclass Thing(val id: Int)',
        'b/Other.kt': 'package b\n@Entity(tableName = "others")\nclass Other(val id: Int)',
        'b/Dao.kt': ['package b', '@Dao', 'interface D {', '  @Insert fun put(o: Other)', '}'].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.operations[0].entityId).toBeUndefined();
  });
});

describe('Realm operations', () => {
  const REALM_SRC = {
    'a/Thing.kt': 'package a\nopen class Thing : RealmObject() {\n  var id: Int = 0\n}',
  };
  const cfg: KotlinEntitiesConfig & KotlinDbOpsConfig = { orm: 'realm' };

  it('(a) a chain rooted in a Realm-typed binding', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': [
          'package a',
          'class Repo(private val realm: Realm) {',
          '  fun load(): Thing? = realm.where(Thing::class.java).findFirst()',
          '}',
        ].join('\n'),
      },
      cfg,
    );
    expect(r.summary.sort()).toEqual(['query:Thing', 'read:Thing']);
  });

  it('(b) a receiver-less call inside a class holding a Realm property', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': [
          'package a',
          'class Repo(private val realm: Realm) {',
          '  fun wipe() { executeTransaction { } }',
          '}',
        ].join('\n'),
      },
      cfg,
    );
    expect(r.summary).toEqual(['transaction:unknown']);
  });

  it('(c) an extension function whose receiver resolves to an emitted entity', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': [
          'package a',
          'class Repo {',
          '  fun store(thing: Thing) { val t: Thing = thing; t.save() }',
          '}',
        ].join('\n'),
      },
      { orm: 'realm', opMap: { save: 'create' } },
    );
    expect(r.summary).toEqual(['create:Thing']);
  });

  it('(c) a type argument naming an emitted entity resolves the entity', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': ['package a', 'class Repo {', '  fun all() { query<Thing>() }', '}'].join('\n'),
      },
      cfg,
    );
    expect(r.summary).toEqual(['query:Thing']);
  });

  it('extends the default op map rather than replacing it', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': [
          'package a',
          'class Repo(private val realm: Realm) {',
          '  fun run() { realm.where(Thing::class.java); realm.stash(Thing::class.java) }',
          '}',
        ].join('\n'),
      },
      { orm: 'realm', opMap: { stash: 'create' } },
    );
    expect(r.summary.sort()).toEqual(['create:Thing', 'query:Thing']);
  });

  it('ANTI: an op-map-named call on a receiver that is neither Realm nor an entity emits nothing', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Other.kt': 'package a\nclass Other { fun where(x: Int) {} }',
        'a/Repo.kt': [
          'package a',
          'class Repo(private val other: Other) {',
          '  fun run() { other.where(1) }',
          '}',
        ].join('\n'),
      },
      cfg,
    );
    expect(r.operations).toEqual([]);
  });

  it('ANTI: a receiver-less op-map call outside any Realm scope emits nothing', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': ['package a', 'class Repo {', '  fun run() { executeTransaction { } }', '}'].join('\n'),
      },
      cfg,
    );
    expect(r.operations).toEqual([]);
  });

  it('ANTI: a Room DAO under a realm profile emits no operation', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Dao.kt': ['package a', '@Dao', 'interface ThingDao {', '  @Insert fun add(thing: Thing)', '}'].join('\n'),
      },
      cfg,
    );
    expect(r.operations).toEqual([]);
  });
});

describe('Realm extension-function receivers', () => {
  const REALM_SRC = { 'a/Thing.kt': 'package a\nopen class Thing : RealmObject() {\n  var id: Int = 0\n}' };
  const cfg: KotlinEntitiesConfig & KotlinDbOpsConfig = { orm: 'realm', opMap: { save: 'create' } };

  it('resolves a CONSTRUCTOR-CALL receiver', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': ['package a', 'class Repo {', '  fun load() { Thing().query { } }', '}'].join('\n'),
      },
      cfg,
    );
    expect(r.summary).toEqual(['query:Thing']);
  });

  it('resolves a PARAMETER whose declared type is an emitted entity', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': ['package a', 'class Repo {', '  fun store(thing: Thing) { thing.save() }', '}'].join('\n'),
      },
      cfg,
    );
    expect(r.summary).toEqual(['create:Thing']);
  });

  it('resolves a nullable receiver through a safe call', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': [
          'package a',
          'class Repo(private val thing: Thing?) {',
          '  fun run() { thing?.save() }',
          '}',
        ].join('\n'),
      },
      cfg,
    );
    expect(r.summary).toEqual(['create:Thing']);
  });

  it('ANTI: a constructor-call receiver of a non-entity emits nothing', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Other.kt': 'package a\nclass Other { fun save() {} }',
        'a/Repo.kt': ['package a', 'class Repo {', '  fun run() { Other().save() }', '}'].join('\n'),
      },
      cfg,
    );
    expect(r.operations).toEqual([]);
  });

  it('ANTI: a receiver typed only by inference from a previous call emits nothing', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': ['package a', 'class Repo {', '  fun run() { val t = Thing().query { }; t.save() }', '}'].join(
          '\n',
        ),
      },
      cfg,
    );
    // The `query` on the constructor resolves; `t`, whose type only inference would give, does not.
    expect(r.summary).toEqual(['query:Thing']);
  });

  it('ANTI: an Object.prototype member name is not a Realm verb', async () => {
    const r = await run(
      {
        ...REALM_SRC,
        'a/Repo.kt': ['package a', 'class Repo {', '  fun run(thing: Thing) { thing.toString() }', '}'].join('\n'),
      },
      cfg,
    );
    expect(r.operations).toEqual([]);
  });
});

describe('entity name canonicalisation', () => {
  const ROW = 'package a\n@Entity(tableName = "things")\nclass ThingRow(val id: Int)';

  it('a table-named @Query and a class-named @Insert emit the entity node name', async () => {
    const r = await run(
      {
        'a/ThingRow.kt': ROW,
        'a/Dao.kt': [
          'package a',
          '@Dao',
          'interface ThingDao {',
          '  @Query("SELECT * FROM things") fun all(): ThingRow',
          '  @Insert(entity = ThingRow::class) fun put(row: ThingRow)',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.summary).toEqual(['read:ThingRow', 'create:ThingRow']);
    const ids = new Set(r.operations.map((o) => o.entityId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeDefined();
  });

  it('ANTI: an operation whose entity does not resolve stays unknown with no entityId', async () => {
    const r = await run(
      {
        'a/ThingRow.kt': ROW,
        'a/Dao.kt': [
          'package a',
          '@Dao',
          'interface ThingDao {',
          '  @Query("SELECT * FROM absent_table") fun all(): Int',
          '  @Insert fun put(blob: Blob)',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.summary).toEqual(['read:absent_table', 'create:unknown']);
    expect(r.operations.every((o) => o.entityId === undefined)).toBe(true);
  });
});

/**
 * `stats.dbOpResolution` (spec BR-4, LIM-4): sites are Room DAO op methods with an emitted
 * performer and Realm verb calls; a Realm receiver that is neither realm-rooted, receiver-less in
 * Realm scope, nor an in-repo entity is out of scope; bound is an emitted op with an `entityId`.
 */
describe('dbOpResolution', () => {
  it('counts Realm verb sites, the bound ones and the receivers this repo declares nowhere', async () => {
    const r = await run(
      {
        'a/Thing.kt': 'package a\nopen class Thing : RealmObject() {\n  var id: Int = 0\n}',
        'a/Repo.kt': [
          'package a',
          'class Repo(private val realm: Realm) {',
          // bound: the chain names the entity.
          '  fun load(): Thing? = realm.where(Thing::class.java).findFirst()',
          // in scope, unbound: a Realm-rooted transaction belongs to no single entity.
          '  fun wipe() { realm.executeTransaction { } }',
          '}',
          'class Cache(private val lru: LruCache) {',
          // out of scope: the receiver is neither realm-rooted nor an entity of this repo.
          '  fun drop() { lru.delete("k") }',
          '}',
        ].join('\n'),
      },
      { orm: 'realm', opMap: { delete: 'delete' } },
    );
    // Four sites: the chain `realm.where(...).findFirst()` is TWO verb calls (both bound by the
    // `Thing::class.java` the chain names once), the Realm-rooted transaction is in scope and
    // unbound, and the cache receiver is out of scope.
    expect(r.stats).toEqual({ dbOpSites: 4, boundDbOps: 2, outOfScopeDbOps: 1 });
    expect(r.stats.boundDbOps + r.stats.outOfScopeDbOps).toBeLessThanOrEqual(r.stats.dbOpSites);
    // BR-6: only the three in-scope sites emit, exactly as before the record existed.
    expect(r.summary).toEqual(['read:Thing', 'query:Thing', 'transaction:unknown']);
  });

  it('counts a Room @Query the SQL reader cannot parse as a site, bound to nothing', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Dao.kt': [
          'package a',
          '@Dao',
          'interface ThingDao {',
          '  @Query("PRAGMA user_version") fun version(): Int',
          '}',
        ].join('\n'),
      },
      { orm: 'room' },
    );
    // The DAO method IS a db-op site the lane saw and could not bind: dropping it from the
    // denominator would report the Room lane as fully resolved on a query it never read.
    expect(r.stats).toEqual({ dbOpSites: 1, boundDbOps: 0, outOfScopeDbOps: 0 });
    expect(r.operations).toEqual([]);
    expect(r.unparsedDaoQueries).toBe(1);
  });

  it('counts a bound Room DAO annotation site', async () => {
    const r = await run(
      {
        'a/Thing.kt': THING,
        'a/Dao.kt': ['package a', '@Dao', 'interface ThingDao {', '  @Insert fun add(thing: Thing)', '}'].join('\n'),
      },
      { orm: 'room' },
    );
    expect(r.stats).toEqual({ dbOpSites: 1, boundDbOps: 1, outOfScopeDbOps: 0 });
  });
});
