import { describe, it, expect } from 'vitest';
import { optionIdentifier, parseSqlOp, parseSqlStatement, resolveDecoratorFieldType } from './text-helpers.js';

describe('parseSqlOp — WITH / CTE statements', () => {
  it('reads the op and table from the statement AFTER the CTE list', () => {
    expect(parseSqlOp('WITH stats AS (SELECT id FROM autopilot_run) SELECT a.id FROM autopilot a')).toEqual({
      op: 'read',
      entity: 'autopilot',
    });
  });

  it('resolves a main-statement table that is only a CTE ALIAS to the real table underneath', () => {
    // Reporting `recent` here would invent a table that does not exist in the schema.
    const sql = 'WITH recent AS (SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 5) SELECT * FROM recent';
    expect(parseSqlOp(sql)).toEqual({ op: 'read', entity: 'activity_log' });
  });

  it('handles the `AS MATERIALIZED` hint and a multi-CTE list', () => {
    const sql = [
      'WITH',
      'ws_agents AS MATERIALIZED (SELECT id FROM agent WHERE workspace_id = $1),',
      'ws_issues AS NOT MATERIALIZED (SELECT id FROM issue WHERE workspace_id = $1)',
      'DELETE FROM comment WHERE issue_id IN (SELECT id FROM ws_issues)',
    ].join('\n');
    expect(parseSqlOp(sql)).toEqual({ op: 'delete', entity: 'comment' });
  });

  it('is not fooled by parens, comments or quoted strings inside a CTE body', () => {
    const sql = [
      'WITH stats AS (',
      '    -- a ) inside a comment must not close the body',
      "    SELECT count(*) FILTER (WHERE status IN ('completed', 'failed')) AS total",
      '    FROM autopilot_run',
      ')',
      'SELECT s.total FROM autopilot a JOIN stats s ON true',
    ].join('\n');
    expect(parseSqlOp(sql)).toEqual({ op: 'read', entity: 'autopilot' });
  });

  it('reads RECURSIVE and a CTE column list', () => {
    const sql = 'WITH RECURSIVE tree (id, parent) AS (SELECT id, parent FROM issue) SELECT * FROM tree';
    expect(parseSqlOp(sql)).toEqual({ op: 'read', entity: 'issue' });
  });

  it('takes the op from the MAIN statement when a data-modifying CTE feeds it', () => {
    const sql =
      'WITH gone AS (DELETE FROM session WHERE id = $1 RETURNING user_id) INSERT INTO audit SELECT * FROM gone';
    expect(parseSqlOp(sql)).toEqual({ op: 'create', entity: 'audit' });
  });

  it('reads a statement that OPENS with a comment', () => {
    // Every verb match is anchored at ^, so an unstripped leading comment parses as nothing.
    // This is the norm inside a CTE body and in hand-written query files.
    expect(parseSqlOp('-- the newest rows first\nSELECT * FROM activity_log')).toEqual({
      op: 'read',
      entity: 'activity_log',
    });
    expect(parseSqlOp('/* block */ DELETE FROM session')).toEqual({ op: 'delete', entity: 'session' });
  });

  it('resolves through a CTE body that opens with a comment', () => {
    // Regression: the alias fallback re-parses each body, which silently yielded nothing when the
    // body began with `-- …`, so a whole recursive-CTE query resolved to no table at all.
    const sql = [
      'WITH RECURSIVE membership(id, root_id) AS (',
      '    -- Each root maps to itself.',
      '    SELECT c.id, c.id AS root_id FROM comment c WHERE c.parent_id IS NULL',
      '),',
      'picked AS (SELECT root_id FROM membership)',
      'SELECT p.root_id FROM picked p',
    ].join('\n');
    expect(parseSqlOp(sql)).toEqual({ op: 'read', entity: 'comment' });
  });

  it('returns undefined rather than guessing when nothing under the CTE resolves', () => {
    // GRANT is not a modelled verb, so the main statement yields nothing to attribute.
    expect(parseSqlOp('WITH x AS (SELECT 1) GRANT SELECT ON foo TO bar')).toBeUndefined();
    expect(parseSqlOp('WITH broken AS SELECT 1')).toBeUndefined();
  });

  it('still reads ordinary statements unchanged', () => {
    expect(parseSqlOp('SELECT * FROM users WHERE id = $1')).toEqual({ op: 'read', entity: 'users' });
    expect(parseSqlOp('INSERT INTO users (id) VALUES ($1)')).toEqual({ op: 'create', entity: 'users' });
    expect(parseSqlOp('UPDATE users SET name = $1')).toEqual({ op: 'update', entity: 'users' });
    expect(parseSqlOp('DELETE FROM users WHERE id = $1')).toEqual({ op: 'delete', entity: 'users' });
  });
});

describe('optionIdentifier', () => {
  it('reads a bare-identifier option value', () => {
    expect(optionIdentifier('Property({ type: JsonType, nullable: true })', 'type')).toBe('JsonType');
    expect(optionIdentifier('Property({ type: UuidType })', 'type')).toBe('UuidType');
  });
  it('ignores quoted values (use optionString for those)', () => {
    expect(optionIdentifier("Property({ type: 'int' })", 'type')).toBeUndefined();
  });
  it("does not match inside a longer key like 'columnType'", () => {
    expect(optionIdentifier("Property({ columnType: 'varchar' })", 'type')).toBeUndefined();
  });
});

describe('resolveDecoratorFieldType', () => {
  const KEYS = ['type', 'columnType'];

  it('keeps a real TS annotation and sets no dbType', () => {
    expect(resolveDecoratorFieldType("Property({ type: 'int' }) ", 'string', KEYS)).toEqual({ typeText: 'string' });
  });

  it('recovers a quoted decorator type when the annotation is missing', () => {
    // `@Property({ type: 'int', default: 0 }) retryNumber = 0;` → no TS annotation
    expect(resolveDecoratorFieldType("Property({ type: 'int', default: 0 })", undefined, KEYS)).toEqual({
      dbType: 'int',
      typeText: 'int',
    });
  });

  it('recovers a bare-identifier decorator type when the annotation is `unknown`', () => {
    // `@Property({ type: JsonType }) error: unknown | null;`
    expect(resolveDecoratorFieldType('Property({ type: JsonType, nullable: true })', 'unknown | null', KEYS)).toEqual({
      dbType: 'JsonType',
      typeText: 'JsonType',
    });
  });

  it('normalizes the recovered token via dataTypeMap', () => {
    expect(resolveDecoratorFieldType('Property({ type: JsonType })', undefined, KEYS, { JsonType: 'json' })).toEqual({
      dbType: 'json',
      typeText: 'json',
    });
  });

  it('falls back to columnType', () => {
    expect(resolveDecoratorFieldType("Property({ columnType: 'varchar(31)' })", undefined, KEYS)).toEqual({
      dbType: 'varchar(31)',
      typeText: 'varchar(31)',
    });
  });

  it('stays `unknown` when neither annotation nor decorator type is present', () => {
    expect(resolveDecoratorFieldType('Property({ nullable: true })', undefined, KEYS)).toEqual({ typeText: 'unknown' });
  });
});

describe('parseSqlOp — DDL verbs', () => {
  it('reads CREATE / DROP / ALTER / TRUNCATE TABLE as ddl over the named relation', () => {
    expect(parseSqlOp('CREATE TABLE listings (id int)')).toEqual({ op: 'ddl', entity: 'listings' });
    expect(parseSqlOp('DROP TABLE IF EXISTS listings')).toEqual({ op: 'ddl', entity: 'listings' });
    expect(parseSqlOp('ALTER TABLE ONLY public.listings ADD COLUMN x int')).toEqual({
      op: 'ddl',
      entity: 'public.listings',
    });
    expect(parseSqlOp('TRUNCATE TABLE IF EXISTS sharded_events')).toEqual({ op: 'ddl', entity: 'sharded_events' });
    expect(parseSqlOp('TRUNCATE person')).toEqual({ op: 'ddl', entity: 'person' });
  });

  it('reads view DDL, including the MATERIALIZED and OR REPLACE forms', () => {
    expect(parseSqlOp('CREATE OR REPLACE VIEW auth.active_users AS SELECT 1')).toEqual({
      op: 'ddl',
      entity: 'auth.active_users',
    });
    expect(parseSqlOp('DROP MATERIALIZED VIEW IF EXISTS "reporting"."daily"')).toEqual({
      op: 'ddl',
      entity: 'reporting.daily',
    });
  });

  it('does not claim DDL over non-relation objects (their target is not a table)', () => {
    expect(parseSqlOp('CREATE FUNCTION f() RETURNS void AS $$ $$')).toBeUndefined();
    expect(parseSqlOp('DROP POLICY p ON listings')).toBeUndefined();
    expect(parseSqlOp('CREATE INDEX idx ON listings (id)')).toBeUndefined();
  });
});

describe('parseSqlOp — schema-qualified and non-table targets', () => {
  it('keeps the schema qualifier instead of collapsing to the schema name', () => {
    expect(parseSqlOp('select * from auth.users where id = $1')).toEqual({ op: 'read', entity: 'auth.users' });
    expect(parseSqlOp('DELETE FROM "auth"."users"')).toEqual({ op: 'delete', entity: 'auth.users' });
    expect(parseSqlOp('INSERT INTO storage.objects (id) VALUES ($1)')).toEqual({
      op: 'create',
      entity: 'storage.objects',
    });
    expect(parseSqlOp('UPDATE auth.users SET x = 1')).toEqual({ op: 'update', entity: 'auth.users' });
  });

  it('drops the function-in-FROM and bare-keyword noise class', () => {
    expect(parseSqlOp('SELECT * FROM unnest($1::text[])')).toBeUndefined();
    expect(parseSqlOp('SELECT * FROM generate_series(1, 10)')).toBeUndefined();
    expect(parseSqlOp('SELECT * FROM table')).toBeUndefined();
    expect(parseSqlOp('SELECT * FROM (SELECT 1) t')).toBeUndefined();
  });

  it('still reads a quoted identifier that happens to be a keyword', () => {
    expect(parseSqlOp('SELECT * FROM "table"')).toEqual({ op: 'read', entity: 'table' });
  });
});

describe('parseSqlStatement — op without a readable target', () => {
  it('keeps the verb when the target is an unfolded interpolation', () => {
    expect(parseSqlStatement('SELECT COUNT(*) FROM {table_name} LIMIT 1')).toEqual({ op: 'read' });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the SQL under test literally carries an unfolded TS template placeholder.
    expect(parseSqlStatement('INSERT INTO ${table} (id) VALUES (1)')).toEqual({ op: 'create' });
    expect(parseSqlStatement('DROP TABLE IF EXISTS {table_name}')).toEqual({ op: 'ddl' });
  });

  it('is undefined for text that is not a statement at all', () => {
    expect(parseSqlStatement('queryConstant')).toBeUndefined();
    expect(parseSqlStatement('')).toBeUndefined();
  });

  it('keeps the main verb when a CTE main statement has no readable table', () => {
    expect(parseSqlStatement('WITH t AS (SELECT 1) SELECT * FROM unnest($1)')).toEqual({ op: 'read' });
  });
});
