import { describe, expect, it } from 'vitest';
import { entityNameFromTable, parseCreateTables, splitColumns } from './sql-ddl.js';

describe('parseCreateTables', () => {
  it('parses a multiline CREATE TABLE with a PK, a nullable column, an inline reference and a foreign key clause', () => {
    const sql = [
      'CREATE TABLE posts (',
      '  id integer primary key,',
      '  title text not null,',
      '  body text,',
      '  author_id integer references users(id),',
      '  foreign key (owner_id) references owners(id)',
      ');',
    ].join('\n');

    const drafts = parseCreateTables(sql);
    expect(drafts).toHaveLength(1);
    const [draft] = drafts;
    expect(draft.tableName).toBe('posts');
    expect(draft.fields).toEqual([
      {
        name: 'id',
        columnName: 'id',
        // The type stops at the first constraint keyword: `primary key` is not part of it.
        type: { text: 'integer' },
        dbType: 'integer',
        isPrimaryKey: true,
        isNullable: false,
        isUnique: false,
        isGenerated: false,
      },
      {
        name: 'title',
        columnName: 'title',
        type: { text: 'text' },
        dbType: 'text',
        isPrimaryKey: false,
        isNullable: false,
        isUnique: false,
        isGenerated: false,
      },
      {
        name: 'body',
        columnName: 'body',
        type: { text: 'text' },
        dbType: 'text',
        isPrimaryKey: false,
        isNullable: true,
        isUnique: false,
        isGenerated: false,
      },
      {
        name: 'author_id',
        columnName: 'author_id',
        type: { text: 'integer' },
        dbType: 'integer',
        isPrimaryKey: false,
        isNullable: true,
        isUnique: false,
        isGenerated: false,
      },
    ]);
    expect(draft.relations).toEqual([
      { name: 'author_id', type: 'many-to-one', targetEntityName: 'users' },
      { name: 'owner_id', type: 'many-to-one', targetEntityName: 'owners' },
    ]);
    expect(sql.slice(draft.matchIndex, draft.endIndex)).toContain('CREATE TABLE posts (');
  });

  it('accepts lowercase `create table` with quoted identifiers', () => {
    const sql = 'create table "users" ("id" integer primary key, "name" text not null);';
    const drafts = parseCreateTables(sql);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].tableName).toBe('users');
    expect(drafts[0].fields.map((f) => f.name)).toEqual(['id', 'name']);
  });

  it('keeps a parenthesised type and a multi-word type, and stops at a constraint keyword', () => {
    const sql =
      'create table t (a varchar(255) not null, b numeric(10, 2), c double precision default 0, d int primary key);';
    expect(parseCreateTables(sql)[0].fields.map((f) => f.dbType)).toEqual([
      'varchar(255)',
      'numeric(10, 2)',
      'double precision',
      'int',
    ]);
  });

  it('keeps every column when a quoted value holds a paren or a comma', () => {
    // The `)` in the default and the `,` inside `('a,b')` are STRING content: a scan that does
    // not track quoting ends the column list at the first of them and loses the rest.
    const sql = "create table t (a int primary key, x text default ')', check (y in ('a,b')), z text);";
    const [draft] = parseCreateTables(sql);
    expect(draft.fields.map((f) => f.name)).toEqual(['a', 'x', 'z']);
    expect(draft.fields.map((f) => f.dbType)).toEqual(['int', 'text', 'text']);
  });

  it('returns an empty array for a string with no DDL', () => {
    expect(parseCreateTables('SELECT * FROM users WHERE id = $1')).toEqual([]);
  });
});

describe('splitColumns', () => {
  it('splits on top-level commas only, ignoring commas nested in parens', () => {
    expect(splitColumns('a integer, b numeric(10, 2), c text')).toEqual(['a integer', ' b numeric(10, 2)', ' c text']);
  });
});

describe('splitColumns — quoted content', () => {
  it('does not split on a comma inside a quoted literal', () => {
    expect(splitColumns("a text default 'x,y', b int")).toEqual(["a text default 'x,y'", ' b int']);
  });
});

describe('entityNameFromTable', () => {
  it('singularizes and PascalCases a snake_case table name', () => {
    expect(entityNameFromTable('user_profiles')).toBe('UserProfile');
    expect(entityNameFromTable('users')).toBe('User');
  });

  it('strips the full `-es` plural after x / z / ch / sh / ss', () => {
    expect(entityNameFromTable('idb_indexes')).toBe('IdbIndex');
    expect(entityNameFromTable('boxes')).toBe('Box');
    expect(entityNameFromTable('batches')).toBe('Batch');
    expect(entityNameFromTable('matches')).toBe('Match');
    expect(entityNameFromTable('classes')).toBe('Class');
    expect(entityNameFromTable('companies')).toBe('Company');
  });

  it('leaves a `-ses` / `-uses` stem its trailing `e`, at the cost of `statuses`', () => {
    // A plain `-ses` is a stem that already ends in `e`: stripping `es` would eat it.
    expect(entityNameFromTable('idb_databases')).toBe('IdbDatabase');
    expect(entityNameFromTable('houses')).toBe('House');
    expect(entityNameFromTable('warehouses')).toBe('Warehouse');
    expect(entityNameFromTable('clauses')).toBe('Clause');
    // KNOWN LIMITATION: `status` is the minority shape, and no rule separates it from the
    // four above without an irregular list. Pinned so the miss is deliberate, not a surprise.
    expect(entityNameFromTable('statuses')).toBe('Statuse');
  });
});
