import { describe, expect, it } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import type { SwiftFile } from './swift-callgraph.js';
import { parseSwift } from './swift-cst.js';
import { extractSwiftDbOps } from './swift-dbops.js';
import { extractSwiftEntities } from './swift-entities.js';

async function mkFiles(entries: Array<[string, string]>): Promise<SwiftFile[]> {
  return Promise.all(entries.map(async ([relPath, source]) => ({ relPath, source, root: await parseSwift(source) })));
}

const MODELS = `class BookingDB: Object {
  @Persisted(primaryKey: true) var id: Int
  @Persisted var uuid: String
  @Persisted var employee: EmployeeDB?
  @Persisted var checkins: List<CheckinDB>
}
class EmployeeDB: Object { @Persisted var name: String }
class CheckinDB: Object { @Persisted var at: Date }
class NotAModel { var x: Int = 0 }`;

/** [S6a] Realm `class *DB: Object` → EntityNode; fields + relations; non-models ignored. */
describe('[S6] swift entities (Realm)', () => {
  const idGen = new StableIdGenerator('/repo', 'demo');

  it('does NOT absorb stored properties of a NESTED type as phantom fields/relations', async () => {
    const files = await mkFiles([
      [
        'Data/Models/OrderDB.swift',
        `class EmployeeDB: Object { @Persisted var name: String }
        class OrderDB: Object {
          @Persisted var total: Double
          class Line: Object { @Persisted var qty: Int }
          struct Meta { var linked: EmployeeDB }
        }`,
      ],
    ]);
    const { entities } = extractSwiftEntities(files, { idGen, baseClasses: ['Object'], orm: 'realm' });
    // Line is itself a registered Object entity (nested but still an Object subclass); OrderDB must
    // NOT absorb Line.qty or Meta.linked.
    const order = entities.find((e) => e.name === 'OrderDB');
    expect(order?.fields.map((f) => f.name)).toEqual(['total']); // no phantom `qty` / `linked`
    expect(order?.relations).toEqual([]); // no fabricated OrderDB→EmployeeDB relation
  });

  it('captures unannotated stored properties (inferred type) as fields and to-many relations', async () => {
    const files = await mkFiles([
      [
        'Data/Models/UserDB.swift',
        `class LogDB: Object { @Persisted var at: Date }
        class UserDB: Object {
          @Persisted var count = 0
          @Persisted var isActive = false
          @Persisted var name: String
          let logs = List<LogDB>()
        }`,
      ],
    ]);
    const { entities } = extractSwiftEntities(files, { idGen, baseClasses: ['Object'], orm: 'realm' });
    const user = entities.find((e) => e.name === 'UserDB');
    // `count = 0` and `isActive = false` have no `: Type` annotation but must still be columns.
    expect(user?.fields.map((f) => f.name).sort()).toEqual(['count', 'isActive', 'logs', 'name']);
    // `let logs = List<LogDB>()` (type only in the initializer) → one-to-many relation.
    expect(user?.relations.find((r) => r.name === 'logs')?.type).toBe('one-to-many');
    expect(user?.relations.find((r) => r.name === 'logs')?.targetEntityName).toBe('LogDB');
  });

  it('registers Object subclasses as entities with fields and relations', async () => {
    const files = await mkFiles([['Data/Models/Models.swift', MODELS]]);
    const { entities } = extractSwiftEntities(files, { idGen, baseClasses: ['Object'], orm: 'realm' });

    expect(entities.map((e) => e.name).sort()).toEqual(['BookingDB', 'CheckinDB', 'EmployeeDB']);
    const booking = entities.find((e) => e.name === 'BookingDB');
    expect(booking?.ormType).toBe('realm');
    expect(booking?.tableName).toBe('BookingDB');
    expect(booking?.fields.find((f) => f.name === 'id')?.isPrimaryKey).toBe(true);
    expect(booking?.fields.find((f) => f.name === 'employee')?.isNullable).toBe(true);

    // relations: employee (many-to-one → EmployeeDB), checkins (one-to-many → CheckinDB)
    const rel = new Map(booking?.relations.map((r) => [r.name, r]));
    expect(rel.get('employee')?.type).toBe('many-to-one');
    expect(rel.get('employee')?.targetEntityName).toBe('EmployeeDB');
    expect(rel.get('checkins')?.type).toBe('one-to-many');
    expect(rel.get('checkins')?.targetEntityName).toBe('CheckinDB');
  });
});

/** [S6b] Realm op call sites → DbOperation; entity via explicit `.self`, DBObject, or 'unknown'. */
describe('[S6] swift db-ops (Realm)', () => {
  const idGen = new StableIdGenerator('/repo', 'demo');

  it('maps realm verbs to operations, attributes performer + entity, never fabricates', async () => {
    const files = await mkFiles([
      [
        'Data/DataServices/BookingService.swift',
        `class BookingService: DataService {
          typealias DBObject = BookingDB
          func fetchAll() -> [BookingDB] { return Array(realm.objects(BookingDB.self)) }
          func synced() { let r = realm.objects(BookingDB.self).filter("synced == true") }
          func wipe() { realm.safeWrite { realm.delete(all) } }
        }`,
      ],
    ]);
    const entityIdByName = new Map([['BookingDB', idGen.entityId('Data/Models/Models.swift', 'BookingDB')]]);
    const ops = extractSwiftDbOps(files, entityIdByName, idGen, { entityTypealias: 'DBObject' }).dbOperations;

    const byOp = ops.map((o) => `${o.operation}:${o.entityName}`);
    expect(byOp).toContain('read:BookingDB'); // realm.objects(BookingDB.self)
    expect(byOp).toContain('query:BookingDB'); // .filter(...) — entity from enclosing DBObject
    expect(byOp).toContain('transaction:BookingDB'); // safeWrite — DBObject fallback
    expect(byOp).toContain('delete:BookingDB'); // realm.delete — DBObject fallback

    const read = ops.find((o) => o.operation === 'read');
    expect(read?.performerId).toBe(
      idGen.methodId('Data/DataServices/BookingService.swift', 'BookingService', 'fetchAll'),
    );
    expect(read?.entityId).toBe(entityIdByName.get('BookingDB'));
  });

  it("emits entity 'unknown' (never fabricated) when no type is resolvable", async () => {
    const files = await mkFiles([['x.swift', `class Free { func f(realm: Realm) { realm.safeWrite { } } }`]]);
    const ops = extractSwiftDbOps(files, new Map(), idGen).dbOperations;
    expect(ops).toHaveLength(1);
    expect(ops[0].entityName).toBe('unknown');
    expect(ops[0].entityId).toBeUndefined();
  });
});

/**
 * BR-4 — the Swift lane's resolution record. A site is an opMap call inside a `func`; a call with
 * no enclosing func is uncounted, and an emitted `'unknown'` entity is NOT bound.
 */
describe('[S6] swift db-op resolution record (BR-4)', () => {
  const idGen = new StableIdGenerator('/repo', 'demo');

  it('counts enumerated sites, binds only resolved entities, scopes out unknown receivers', async () => {
    const files = await mkFiles([
      [
        'Data/DataServices/BookingService.swift',
        `class BookingService: DataService {
          typealias DBObject = BookingDB
          func fetchAll() -> [BookingDB] { return Array(realm.objects(BookingDB.self)) }
        }
        class Free { func f(realm: Realm) { realm.safeWrite { } } }`,
      ],
      ['main.swift', 'let all = realm.objects(BookingDB.self)'], // no enclosing func → uncounted
    ]);
    const entityIdByName = new Map([['BookingDB', idGen.entityId('Data/Models/Models.swift', 'BookingDB')]]);
    const { dbOperations, stats } = extractSwiftDbOps(files, entityIdByName, idGen, {
      entityTypealias: 'DBObject',
    });
    expect(dbOperations.map((o) => `${o.operation} ${o.entityName}`)).toEqual([
      'read BookingDB',
      'transaction unknown',
    ]);
    expect(stats).toEqual({ dbOpSites: 2, boundDbOps: 1, outOfScopeDbOps: 1 });
    expect(stats.boundDbOps + stats.outOfScopeDbOps).toBeLessThanOrEqual(stats.dbOpSites);
  });

  it('reads boundDbOps back from the EMITTED ops, never from a loop counter', async () => {
    // Two identical op calls on ONE line. This lane emits per site (it keeps no dedup set), so
    // both ship — the point is that the counter is DERIVED from what shipped, so it can never
    // disagree with the output the way a loop counter did.
    const files = await mkFiles([
      [
        'Data/DataServices/BookingService.swift',
        `class BookingService: DataService {
          typealias DBObject = BookingDB
          func fetchAll() { _ = realm.objects(BookingDB.self); _ = realm.objects(BookingDB.self) }
        }`,
      ],
    ]);
    const entityIdByName = new Map([['BookingDB', idGen.entityId('Data/Models/Models.swift', 'BookingDB')]]);
    const { dbOperations, stats } = extractSwiftDbOps(files, entityIdByName, idGen, {
      entityTypealias: 'DBObject',
    });
    expect(stats.boundDbOps).toBe(dbOperations.filter((o) => o.entityId !== undefined).length);
    expect(stats.boundDbOps + stats.outOfScopeDbOps).toBeLessThanOrEqual(stats.dbOpSites);
  });
});
