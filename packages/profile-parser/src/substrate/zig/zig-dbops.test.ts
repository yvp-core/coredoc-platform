/**
 * AC-11 / BR-15: entities from `CREATE TABLE` strings, db operations from the SQL a function
 * executes.
 *
 * The fixture writes its schema the way the real repo does — a `\\` multiline block, one column
 * per line — and its statements the three ways a Zig call site writes SQL: a plain literal, a
 * second literal, and a `++` concatenation. The negatives are the ones that fabricate rows when
 * a lane trusts a text match: a `select`-looking log line, a commented-out `create table`, and a
 * table declared inside a `test` block.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ZigFile, type ZigFileEntry, extractZigFileFacts, toZigFile } from './zig-declarations.js';
import { DB_EXEC_METHODS, emitZigDbOps, emitZigEntities } from './zig-dbops.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mini-zig-data');
const REL = 'src/store.zig';
const idGen = new StableIdGenerator(FIXTURE, 'mini-zig-data');

const parsed: ZigFile[] = [];
let files: ZigFileEntry[];

beforeAll(async () => {
  const file = await toZigFile(REL, readFileSync(join(FIXTURE, REL), 'utf-8'));
  parsed.push(file);
  files = [{ relPath: REL, facts: extractZigFileFacts(file, idGen) }];
});

afterAll(() => releaseParsedTrees(parsed));

/** Facts for an inline source — shapes the fixture deliberately does not carry. */
async function inlineFile(source: string, relPath: string): Promise<ZigFileEntry> {
  const file = await toZigFile(relPath, source);
  parsed.push(file);
  return { relPath, facts: extractZigFileFacts(file, idGen) };
}

describe('emitZigEntities', () => {
  it('reads a multiline DDL block into an entity with its columns', () => {
    const cache = emitZigEntities(files, idGen).find((e) => e.tableName === 'cache');

    expect(cache).toMatchObject({
      id: idGen.entityId(REL, 'cache'),
      name: 'Cache',
      kind: 'entity',
      ormType: 'sql',
      tableName: 'cache',
      fileId: idGen.fileId(REL),
      relations: [],
      location: { filePath: REL, startLine: 4, endLine: 7 },
    });
    expect(cache?.fields.map((f) => f.name)).toEqual(['url', 'status']);
    expect(cache?.fields[0]).toMatchObject({ isPrimaryKey: true, isNullable: false });
    expect(cache?.fields[1]).toMatchObject({ isPrimaryKey: false, isNullable: false });
  });

  it('carries an inline `references` clause as a relation', () => {
    const owner = emitZigEntities(files, idGen).find((e) => e.tableName === 'cache_owner');

    expect(owner?.name).toBe('CacheOwner');
    expect(owner?.relations).toEqual([{ name: 'owner_id', type: 'many-to-one', targetEntityName: 'cache' }]);
  });

  it('emits no entity for a commented-out DDL or one declared inside a `test` block', () => {
    expect(emitZigEntities(files, idGen).map((e) => e.tableName)).toEqual(['cache', 'cache_owner', 'pragma_first']);
  });

  it('reads DDL that does not START the literal — a `pragma` preamble, then `create table`', () => {
    const entity = emitZigEntities(files, idGen).find((e) => e.tableName === 'pragma_first');

    expect(entity?.name).toBe('PragmaFirst');
    expect(entity?.fields.map((f) => f.name)).toEqual(['id']);
    // A schema constant is never an operation, however it is written.
    expect(
      emitZigDbOps(files, emitZigEntities(files, idGen), idGen).dbOperations.some(
        (o) => o.entityName === 'pragma_first',
      ),
    ).toBe(false);
  });

  it('locates each `create table` at its OWN line inside a shared literal', async () => {
    const file = await inlineFile(
      'const SCHEMA =\n' +
        '    \\\\create table a (id integer)\n' +
        '    \\\\;\n' +
        '    \\\\create table b (id integer)\n' +
        ';\n',
      'src/two.zig',
    );

    expect(emitZigEntities([file], idGen).map((e) => [e.tableName, e.location.startLine])).toEqual([
      ['a', 2],
      ['b', 4],
    ]);
  });

  it('keeps the first declaration of a table repo-wide', async () => {
    const other = await toZigFile('src/dup.zig', 'const S =\n    \\\\create table cache (url text)\n;\n');
    parsed.push(other);
    const dup = { relPath: other.relPath, facts: extractZigFileFacts(other, idGen) };

    const entities = emitZigEntities([...files, dup], idGen);
    expect(entities.map((e) => e.id)).toEqual([
      idGen.entityId(REL, 'cache'),
      idGen.entityId(REL, 'cache_owner'),
      idGen.entityId(REL, 'pragma_first'),
    ]);
  });
});

describe('emitZigDbOps', () => {
  it('emits one operation per non-DDL statement, joined to its entity', () => {
    const entities = emitZigEntities(files, idGen);
    const ops = emitZigDbOps(files, entities, idGen).dbOperations;
    const cacheId = idGen.entityId(REL, 'cache');

    expect(
      ops.map((o) => ({ performer: o.performerId, op: o.operation, entityId: o.entityId, line: o.location.startLine })),
    ).toEqual([
      { performer: idGen.functionId(REL, 'put'), op: 'create', entityId: cacheId, line: 20 },
      { performer: idGen.functionId(REL, 'get'), op: 'read', entityId: cacheId, line: 24 },
      { performer: idGen.functionId(REL, 'count'), op: 'read', entityId: cacheId, line: 28 },
      // A table neither an entity nor test-only still emits an op, with no `entityId`.
      { performer: idGen.functionId(REL, 'unknown'), op: 'read', entityId: undefined, line: 48 },
      // Formatted into a local, executed one hop later by `conn.exec(sql, …)`.
      { performer: idGen.functionId(REL, 'evict'), op: 'delete', entityId: cacheId, line: 55 },
    ]);
    expect(new Set(ops.map((o) => o.id)).size).toBe(5);
    expect(ops.slice(0, 3).every((o) => o.entityName === 'cache')).toBe(true);
    expect(ops[2].details).toBe('select count(*) from cache');
    expect(ops[0].id).toBe(idGen.dbOperationId(idGen.functionId(REL, 'put'), 'cache', 'create', `${REL}:20`));
    expect(ops[0].versionedId).toBe(idGen.versionedId(ops[0].id, 'insert into cache (url) values (?1)'));
  });

  it('emits no operation for the DDL constants, the log string or the `test` block', () => {
    const ops = emitZigDbOps(files, emitZigEntities(files, idGen), idGen).dbOperations;

    expect(ops).toHaveLength(5);
    // The log line IS a recorded SQL-looking literal; `parseSqlOp` names no table, so it drops.
    expect(files[0].facts.sqlStrings.some((s) => s.text === 'select something')).toBe(true);
    expect(ops.some((o) => o.details === 'select something')).toBe(false);
  });

  it('mints one op for two identical-id statements on ONE line', async () => {
    const file = await inlineFile(
      'pub fn twice(conn: anytype) !void {\n' +
        '    try conn.exec("select a from cache"); try conn.exec("select b from cache");\n' +
        '}\n',
      'src/twice.zig',
    );

    const ops = emitZigDbOps([file], [], idGen).dbOperations;
    expect(ops).toHaveLength(1);
    expect(ops[0].details).toBe('select a from cache');
    expect(new Set(ops.map((o) => o.id)).size).toBe(1);

    // BR-4: both statements are enumerated sites, but only the EMITTED op binds (the deduped
    // twin must not be counted a second time).
    const withEntity = emitZigDbOps([file], emitZigEntities(files, idGen), idGen);
    expect(withEntity.dbOperations).toHaveLength(1);
    expect(withEntity.dbOperations[0].entityId).toBeDefined();
    expect(withEntity.stats).toEqual({ dbOpSites: 2, boundDbOps: 1, outOfScopeDbOps: 0 });
  });

  it('leaves entityId unset when no entity declares the operated table', () => {
    const ops = emitZigDbOps(files, [], idGen).dbOperations;

    expect(ops).toHaveLength(5);
    expect(ops.every((o) => o.entityId === undefined)).toBe(true);
  });

  it('drops an op on a table only a `test` block creates, even from a non-test helper', () => {
    const ops = emitZigDbOps(files, emitZigEntities(files, idGen), idGen).dbOperations;

    expect(files[0].facts.testOnlyTables).toContain('t_test');
    expect(ops.some((o) => o.entityName === 't_test')).toBe(false);
    // …while the table nothing declares at all is kept: dropping it would hide a real write.
    expect(ops.some((o) => o.entityName === 'unknown_t')).toBe(true);
  });

  it('drops a formatted statement that no DB verb executes, and one handed on through a second local', () => {
    const ops = emitZigDbOps(files, emitZigEntities(files, idGen), idGen).dbOperations;
    const performers = ops.map((o) => o.performerId);

    // `describe` only logs its formatted string; `evictIndirect` executes a SECOND local, which
    // is one hop too far to follow (LIM-B).
    expect(performers).not.toContain(idGen.functionId(REL, 'describe'));
    expect(performers).not.toContain(idGen.functionId(REL, 'evictIndirect'));
    // All three literals ARE recorded, bound local and all — the GATE is what executes them.
    expect(files[0].facts.sqlStrings.filter((s) => s.boundLocal !== undefined).map((s) => s.boundLocal)).toEqual([
      'sql',
      'msg',
      'sql',
    ]);
  });

  it('emits nothing for SQL-looking text handed to a method that does not execute SQL', async () => {
    const file = await inlineFile(
      'pub fn log_only(err: anyerror) void {\n' +
        '    std.debug.print("update err: {any}", .{err});\n' +
        '    log.err(.cache, "delete from cache", .{});\n' +
        '}\n',
      'src/logs.zig',
    );

    // The literals ARE recorded SQL strings — the GATE is the callee, not the text.
    expect(file.facts.sqlStrings.map((sql) => sql.calleeMethod)).toEqual(['print', 'err']);
    expect(emitZigDbOps([file], [], idGen).dbOperations).toEqual([]);
  });

  it('emits an op for the same text when an execution method receives it', async () => {
    const file = await inlineFile(
      'pub fn wipe(conn: anytype) !void {\n    try conn.exec("delete from cache");\n}\n',
      'src/wipe.zig',
    );

    expect(emitZigDbOps([file], [], idGen).dbOperations.map((o) => `${o.operation} ${o.entityName}`)).toEqual([
      'delete cache',
    ]);
  });

  it('requires SQL STRUCTURE behind the verb, not just the verb (B1)', async () => {
    const file = await inlineFile(
      'pub fn go(conn: anytype) !void {\n' +
        '    try conn.exec("update available packages");\n' +
        '    try conn.exec("update cache set x = 1");\n' +
        '}\n',
      'src/prose.zig',
    );

    // Both literals ARE recorded, both reach a DB verb — only one is SQL.
    expect(file.facts.sqlStrings.map((sql) => sql.text)).toEqual([
      'update available packages',
      'update cache set x = 1',
    ]);
    expect(emitZigDbOps([file], [], idGen).dbOperations.map((o) => `${o.operation} ${o.entityName}`)).toEqual([
      'update cache',
    ]);
  });

  it('no longer treats `run` as a SQL execution verb (B2)', async () => {
    const file = await inlineFile(
      'pub fn go(step: anytype, conn: anytype) !void {\n' +
        '    try step.run("update packages set x = 1");\n' +
        '    try conn.exec("update cache set x = 1");\n' +
        '}\n',
      'src/run-verb.zig',
    );

    expect(DB_EXEC_METHODS).not.toContain('run');
    // The `run` statement is well-formed SQL and still drops: the VERB is what fails.
    expect(emitZigDbOps([file], [], idGen).dbOperations.map((o) => o.entityName)).toEqual(['cache']);
    // …and a profile that owns such a wrapper can put it back.
    expect(emitZigDbOps([file], [], idGen, ['run']).dbOperations.map((o) => o.entityName)).toEqual([
      'packages',
      'cache',
    ]);
  });

  it('emits no entity for DDL handed to a method that does not execute SQL (B3)', async () => {
    const file = await inlineFile(
      'pub fn go(logger: anytype, conn: anytype) !void {\n' +
        '    logger.info("create table decoy (id int)", .{});\n' +
        '    try conn.exec("create table kept2 (id int)");\n' +
        '}\n',
      'src/decoy.zig',
    );

    expect(emitZigEntities([file], idGen).map((e) => e.tableName)).toEqual(['kept2']);
  });

  it('keeps a const-bound DDL string, which is nobody’s argument (B3)', async () => {
    const file = await inlineFile('const DDL =\n    \\\\create table kept (id integer)\n;\n', 'src/bound.zig');

    expect(emitZigEntities([file], idGen).map((e) => e.tableName)).toEqual(['kept']);
  });

  it('does not let a DDL decoy inside a `test` block mark a real table test-only (B3)', async () => {
    const file = await inlineFile(
      'pub fn go(conn: anytype) !void {\n' +
        '    try conn.exec("select id from decoy");\n' +
        '}\n' +
        'test "logs" {\n' +
        '    logger.info("create table decoy (id int)", .{});\n' +
        '    const real = "create table fixture (id int)";\n' +
        '    _ = real;\n' +
        '}\n',
      'src/test-decoy.zig',
    );

    // The genuine test-block table is still recorded; the log line is not.
    expect([...file.facts.testOnlyTables]).toEqual(['fixture']);
    expect(emitZigDbOps([file], [], idGen).dbOperations.map((o) => o.entityName)).toEqual(['decoy']);
  });

  it('stores and links the lowercased BARE table, schema qualifier stripped (RT4)', async () => {
    const schema = await inlineFile('const DDL =\n    \\\\create table users (id integer)\n;\n', 'src/schema.zig');
    const file = await inlineFile(
      'pub fn go(conn: anytype) !void {\n' +
        '    try conn.exec("INSERT INTO Users (id) values (?1)");\n' +
        '    try conn.exec("insert into public.users (id) values (?1)");\n' +
        '}\n',
      'src/qualified.zig',
    );

    const entities = emitZigEntities([schema], idGen);
    const ops = emitZigDbOps([schema, file], entities, idGen).dbOperations;
    expect(ops.map((o) => o.entityName)).toEqual(['users', 'users']);
    expect(ops.every((o) => o.entityId === entities[0].id)).toBe(true);
    // Different lines, so the two ops stay distinct rows.
    expect(new Set(ops.map((o) => o.id)).size).toBe(2);
  });

  it('adds a profile method to the default verb set instead of replacing it', async () => {
    const file = await inlineFile(
      'pub fn both(db: anytype, conn: anytype) !void {\n' +
        '    try db.runSql("select a from cache");\n' +
        '    try conn.exec("select b from cache");\n' +
        '}\n',
      'src/knob.zig',
    );

    expect(emitZigDbOps([file], [], idGen).dbOperations.map((o) => o.details)).toEqual(['select b from cache']);
    expect(emitZigDbOps([file], [], idGen, ['runSql']).dbOperations.map((o) => o.details)).toEqual([
      'select a from cache',
      'select b from cache',
    ]);
  });
});

/**
 * BR-4 — the Zig lane's resolution record over `__fixtures__/mini-zig-data`. A site is a recorded
 * SQL string a DB verb executes inside a caller; SQL that never reached `facts.sqlStrings`, and
 * SQL that is not a call argument, are uncounted by construction (LIM-4).
 */
describe('emitZigDbOps — resolution record (BR-4)', () => {
  it('counts executed SQL sites, bound tables, and the test-only table as out of scope', () => {
    const { dbOperations, stats } = emitZigDbOps(files, emitZigEntities(files, idGen), idGen);

    expect(dbOperations).toHaveLength(5); // BR-6: emission unchanged
    // 4 bound (`cache`, incl. the one-hop formatted local), 1 out of scope (`t_test`, created
    // only by a `test` block), 1 in scope and unbound (`unknown_t`, a table nothing declares).
    // The `select something` log string never reaches an exec verb, so it is not a site at all.
    expect(stats).toEqual({ dbOpSites: 6, boundDbOps: 4, outOfScopeDbOps: 1 });
    expect(stats.boundDbOps + stats.outOfScopeDbOps).toBeLessThanOrEqual(stats.dbOpSites);
  });
});
