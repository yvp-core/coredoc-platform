import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type GoFile, parseGo } from './go-cst.js';
import { extractGoEntities } from './go-entities.js';

const ID = new StableIdGenerator('/demo', 'demo');
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function gf(relPath: string, source: string): Promise<GoFile> {
  return { relPath, source, root: await parseGo(source) };
}

/** Go struct tags are backtick-delimited, so fixtures are line arrays rather than template literals. */
function go(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

/** A temp repo holding only `.sql` schema files (the Go sources are passed in-memory). */
function sqlRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'go-entities-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe('migration DDL — the source whose names match the SQL in the code', () => {
  it('reads tables, columns, nullability, PKs and REFERENCES out of CREATE TABLE', async () => {
    const root = sqlRepo({
      'db/migrations/20240101_init.sql': `
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nickname TEXT
);

CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL,
    user_id UUID NOT NULL REFERENCES users(id),
    total NUMERIC(10, 2) NOT NULL,
    PRIMARY KEY (id)
);
`,
    });
    const { entities, tableNames } = extractGoEntities([], { idGen: ID, repoRoot: root });
    const users = entities.find((e) => e.tableName === 'users');
    expect(users?.name).toBe('User');
    expect(users?.ormType).toBe('sql');
    expect(users?.fields.find((f) => f.name === 'id')?.isPrimaryKey).toBe(true);
    expect(users?.fields.find((f) => f.name === 'email')?.isNullable).toBe(false);
    expect(users?.fields.find((f) => f.name === 'email')?.isUnique).toBe(true);
    expect(users?.fields.find((f) => f.name === 'nickname')?.isNullable).toBe(true);

    const orders = entities.find((e) => e.tableName === 'orders');
    // A `NUMERIC(10, 2)` column must not be split on its inner comma.
    expect(orders?.fields.map((f) => f.name)).toEqual(['id', 'user_id', 'total']);
    expect(orders?.fields.find((f) => f.name === 'id')?.isPrimaryKey).toBe(true);
    expect(orders?.relations).toEqual([
      expect.objectContaining({ name: 'user_id', type: 'many-to-one', targetEntityName: 'users' }),
    ]);
    expect([...tableNames].sort()).toEqual(['orders', 'users']);
  });

  it('drops the schema qualifier so the name matches what a query string says', async () => {
    const root = sqlRepo({ 'migrations/1.sql': 'CREATE TABLE public.audit_logs (id BIGINT PRIMARY KEY);' });
    const { entities, tableNames } = extractGoEntities([], { idGen: ID, repoRoot: root });
    expect(entities[0]?.tableName).toBe('audit_logs');
    expect([...tableNames]).toEqual(['audit_logs']);
  });
});

describe('tagged structs', () => {
  const SRC = go(
    'package db',
    '',
    'type User struct {',
    '\tID        int64   `db:"id"`',
    '\tEmail     string  `db:"email"`',
    '\tNickname  *string `db:"nickname"`',
    '\tSecret    string  `db:"-"`',
    '\tCreatedAt time.Time',
    '\tMeta      struct{ A string }',
    '\tinternal  int     `db:"internal"`',
    '}',
  );

  it('names the table by convention and maps every column from its tag', async () => {
    const { entities } = extractGoEntities([await gf('internal/db/models.go', SRC)], {
      idGen: ID,
      repoRoot: sqlRepo(),
    });
    expect(entities).toHaveLength(1);
    const user = entities[0];
    expect(user.name).toBe('User');
    // GORM pluralizes and sqlc singularizes its struct off the table — both meet at `users`.
    expect(user.tableName).toBe('users');
    // The `db:` tag names no library (sqlx, pgx/scany and sqlc all emit it), so the honest label
    // is the language.
    expect(user.ormType).toBe('go');
    expect(user.fields.map((f) => f.columnName)).toEqual(['id', 'email', 'nickname', 'created_at', 'meta']);
    expect(user.fields.find((f) => f.name === 'ID')?.isPrimaryKey).toBe(true);
    // A pointer IS Go's nullability declaration, the way `Option<T>` is Rust's.
    expect(user.fields.find((f) => f.name === 'Nickname')?.isNullable).toBe(true);
    expect(user.fields.find((f) => f.name === 'Email')?.isNullable).toBe(false);
  });

  it('drops `db:"-"`, unexported fields and the fields of a NESTED anonymous struct', async () => {
    const { entities } = extractGoEntities([await gf('internal/db/models.go', SRC)], {
      idGen: ID,
      repoRoot: sqlRepo(),
    });
    const names = entities[0].fields.map((f) => f.name);
    expect(names).not.toContain('Secret');
    // Unexported fields are invisible to reflection, so nothing can persist them.
    expect(names).not.toContain('internal');
    // `Meta struct{ A string }` is one column, not a doorway into the parent's column list.
    expect(names).not.toContain('A');
  });

  it('ignores a struct with no persistence signal at all', async () => {
    const src = go('package app', '', 'type Config struct {', '\tPort int', '\tHost string', '}');
    const { entities } = extractGoEntities([await gf('internal/app/config.go', src)], {
      idGen: ID,
      repoRoot: sqlRepo(),
    });
    expect(entities).toEqual([]);
  });

  it('leaves `json:`-tagged DTOs out by default, and honors an explicit opt-in', async () => {
    // A `json:`-tagged struct is an API DTO far more often than a table; defaulting it on emits
    // hundreds of entities no db-op ever touches (the entities-but-0-dbOps red flag).
    const src = go(
      'package api',
      '',
      'type LoginRequest struct {',
      '\tEmail    string `json:"email"`',
      '\tPassword string `json:"password"`',
      '}',
    );
    const files = [await gf('internal/api/dto.go', src)];
    expect(extractGoEntities(files, { idGen: ID, repoRoot: sqlRepo() }).entities).toEqual([]);
    expect(
      extractGoEntities(files, { idGen: ID, repoRoot: sqlRepo(), structTags: ['db', 'gorm', 'json'] }).entities.map(
        (e) => e.tableName,
      ),
    ).toEqual(['login_requests']);
  });

  it('stamps an explicit `orm` over every inferred label', async () => {
    const { entities } = extractGoEntities([await gf('internal/db/models.go', SRC)], {
      idGen: ID,
      repoRoot: sqlRepo(),
      orm: 'sqlx',
    });
    expect(entities[0].ormType).toBe('sqlx');
  });
});

describe('GORM models', () => {
  it('expands an embedded gorm.Model into its four real columns', async () => {
    const src = go('package models', '', 'type Post struct {', '\tgorm.Model', '\tTitle string', '}');
    const { entities } = extractGoEntities([await gf('models/post.go', src)], { idGen: ID, repoRoot: sqlRepo() });
    expect(entities).toHaveLength(1);
    expect(entities[0].ormType).toBe('gorm');
    expect(entities[0].tableName).toBe('posts');
    expect(entities[0].fields.map((f) => f.columnName)).toEqual([
      'id',
      'created_at',
      'updated_at',
      'deleted_at',
      'title',
    ]);
    expect(entities[0].fields.find((f) => f.columnName === 'deleted_at')?.isNullable).toBe(true);
  });

  it('reads a TableName() override, and only when it returns a literal', async () => {
    const src = go(
      'package models',
      '',
      'type User struct {',
      '\tName string `gorm:"column:name"`',
      '}',
      '',
      'func (User) TableName() string { return "app_users" }',
      '',
      'type Session struct {',
      '\tToken string `gorm:"column:token"`',
      '}',
      '',
      'func (Session) TableName() string { return sessionTable }',
    );
    const { entities } = extractGoEntities([await gf('models/user.go', src)], { idGen: ID, repoRoot: sqlRepo() });
    // The unreadable override falls back to the naming convention rather than guessing a constant.
    expect(entities.map((e) => e.tableName).sort()).toEqual(['app_users', 'sessions']);
  });

  it('picks up a TableName() declared in another file of the same package', async () => {
    const files = [
      await gf('models/user.go', go('package models', '', 'type User struct {', '\tID int64 `db:"id"`', '}')),
      await gf('models/names.go', go('package models', '', 'func (User) TableName() string { return "app_users" }')),
    ];
    const { entities } = extractGoEntities(files, { idGen: ID, repoRoot: sqlRepo() });
    expect(entities.map((e) => e.tableName)).toEqual(['app_users']);
  });

  it('parses semicolon-separated gorm options, including a value with a comma in it', async () => {
    // `structTags` cuts each value at its first comma, which would drop `column:price` here — the
    // gorm tag has to be read from its raw text.
    const src = go(
      'package models',
      '',
      'type Item struct {',
      '\tRef   string  `gorm:"primaryKey;column:ref_code"`',
      '\tPrice float64 `gorm:"type:decimal(10,2);column:price;not null"`',
      '\tSlug  *string `gorm:"column:slug;uniqueIndex"`',
      '\tNote  *string `gorm:"column:note;not null"`',
      '}',
    );
    const { entities } = extractGoEntities([await gf('models/item.go', src)], { idGen: ID, repoRoot: sqlRepo() });
    const fields = entities[0].fields;
    expect(fields.map((f) => f.columnName)).toEqual(['ref_code', 'price', 'slug', 'note']);
    expect(fields.find((f) => f.columnName === 'ref_code')?.isPrimaryKey).toBe(true);
    expect(fields.find((f) => f.columnName === 'price')?.dbType).toBe('decimal(10,2)');
    expect(fields.find((f) => f.columnName === 'slug')?.isUnique).toBe(true);
    expect(fields.find((f) => f.columnName === 'slug')?.isNullable).toBe(true);
    // An explicit `not null` overrides the pointer.
    expect(fields.find((f) => f.columnName === 'note')?.isNullable).toBe(false);
  });

  it('turns a field typed as another model into a relation instead of a column', async () => {
    const src = go(
      'package models',
      '',
      'type User struct {',
      '\tID     int64   `db:"id"`',
      '\tOrders []Order `gorm:"foreignKey:UserID"`',
      '\tGroups []Group `gorm:"many2many:user_groups"`',
      '}',
      '',
      'type Order struct {',
      '\tID     int64 `db:"id"`',
      '\tUserID int64 `db:"user_id"`',
      '\tUser   *User',
      '}',
      '',
      'type Group struct {',
      '\tID int64 `db:"id"`',
      '}',
    );
    const { entities } = extractGoEntities([await gf('models/models.go', src)], { idGen: ID, repoRoot: sqlRepo() });
    const user = entities.find((e) => e.tableName === 'users');
    const order = entities.find((e) => e.tableName === 'orders');
    expect(user?.relations.map((r) => [r.name, r.type, r.targetEntityName])).toEqual([
      ['Orders', 'one-to-many', 'orders'],
      ['Groups', 'many-to-many', 'groups'],
    ]);
    // An association is not a column: the scalar `UserID` beside it is the real FK.
    expect(user?.fields.map((f) => f.columnName)).toEqual(['id']);
    expect(order?.relations).toEqual([
      expect.objectContaining({ name: 'User', type: 'many-to-one', targetEntityName: 'users' }),
    ]);
    expect(order?.relations[0].targetEntityId).toBe(user?.id);
    expect(order?.fields.map((f) => f.columnName)).toEqual(['id', 'user_id']);
  });
});

describe('cross-source dedupe', () => {
  const DDL = `
CREATE TABLE users (
    id BIGINT PRIMARY KEY,
    email TEXT NOT NULL
);
`;

  it('keeps ONE entity when the DDL and a tagged struct describe the same table', async () => {
    // Double-emitting splits db-op attribution across two ids and every answer is half the truth.
    const root = sqlRepo({ 'db/migrations/1_init.sql': DDL });
    const src = go('package db', '', 'type User struct {', '\tID int64 `db:"id"`', '}');
    const { entities, entityIdByName, tableNames } = extractGoEntities([await gf('internal/db/models.go', src)], {
      idGen: ID,
      repoRoot: root,
    });
    expect(entities).toHaveLength(1);
    expect(entities[0].tableName).toBe('users');
    expect(entities[0].ormType).toBe('sql');
    // The DDL keeps identity, so the columns are the ones with real SQL types.
    expect(entities[0].fields.map((f) => f.name)).toEqual(['id', 'email']);
    // Both spellings a db-op site can use resolve to the SAME id: `FROM users` and `&User{}`.
    expect(entityIdByName.get('users')).toBe(entities[0].id);
    expect(entityIdByName.get('User')).toBe(entities[0].id);
    expect([...tableNames]).toEqual(['users']);
  });

  it('registers a sqlc model struct that carries NO tags at all, without emitting an entity', async () => {
    // sqlc emits `type User struct` for table `users` with no tags unless the repo opts into
    // `emit_json_tags`; the DDL it generated from is what proves the struct is a model.
    const root = sqlRepo({ 'db/migrations/1_init.sql': DDL });
    const src = go(
      'package db',
      '',
      'type User struct {',
      '\tID    int64',
      '\tEmail string',
      '}',
      '',
      'type Params struct {',
      '\tX int',
      '}',
    );
    const { entities, entityIdByName } = extractGoEntities([await gf('internal/db/models.go', src)], {
      idGen: ID,
      repoRoot: root,
    });
    expect(entities).toHaveLength(1);
    expect(entities[0].tableName).toBe('users');
    expect(entityIdByName.get('User')).toBe(entities[0].id);
    // The merge-only lane never invents a table for a struct the DDL says nothing about.
    expect(entityIdByName.has('Params')).toBe(false);
  });

  it('merges a second struct claiming a table already claimed, rather than double-emitting', async () => {
    const files = [
      await gf('internal/db/models.go', go('package db', '', 'type User struct {', '\tID int64 `db:"id"`', '}')),
      await gf('internal/api/dto.go', go('package api', '', 'type User struct {', '\tName string `db:"name"`', '}')),
    ];
    const { entities } = extractGoEntities(files, { idGen: ID, repoRoot: sqlRepo() });
    expect(entities).toHaveLength(1);
    expect(entities[0].location.filePath).toBe('internal/db/models.go');
  });
});

describe('defaults', () => {
  it('extracts from a bare config — no structTags, no orm, no schemaFileGlobs', async () => {
    const root = sqlRepo({ 'schema.sql': 'CREATE TABLE teams (id BIGINT PRIMARY KEY);' });
    const src = go('package models', '', 'type Project struct {', '\tID int64 `db:"id"`', '}');
    const { entities } = extractGoEntities([await gf('models/project.go', src)], { idGen: ID, repoRoot: root });
    expect(entities.map((e) => e.tableName).sort()).toEqual(['projects', 'teams']);
  });

  it('honors a narrowed schemaFileGlobs', async () => {
    const root = sqlRepo({ 'sql/schema/1.sql': 'CREATE TABLE teams (id BIGINT PRIMARY KEY);' });
    expect(extractGoEntities([], { idGen: ID, repoRoot: root }).entities).toEqual([]);
    expect(
      extractGoEntities([], { idGen: ID, repoRoot: root, schemaFileGlobs: ['sql/**/*.sql'] }).entities.map(
        (e) => e.tableName,
      ),
    ).toEqual(['teams']);
  });
});
