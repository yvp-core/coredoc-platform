import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type RustFile } from './rust-cst.js';
import { extractRustEntities } from './rust-entities.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

const ID = new StableIdGenerator('/demo', 'demo');
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function rf(relPath: string, source: string): Promise<RustFile> {
  return { relPath, source, root: await parseSource('rust', source) };
}

/** A temp repo holding only `.sql` schema files (the Rust sources are passed in-memory). */
function sqlRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'rs-entities-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe('diesel table! — the highest-confidence source', () => {
  const SCHEMA = `
diesel::table! {
    users (id) {
        id -> Int4,
        email -> Varchar,
        deleted_at -> Nullable<Timestamp>,
    }
}

diesel::table! {
    posts (id) {
        id -> Int4,
        user_id -> Int4,
        title -> Varchar,
    }
}

diesel::joinable!(posts -> users (user_id));
`;

  it('emits one entity per table with columns, nullability and the primary key', async () => {
    const { entities } = extractRustEntities([await rf('src/schema.rs', SCHEMA)], {
      idGen: ID,
      repoRoot: sqlRepo(),
    });
    const users = entities.find((e) => e.tableName === 'users');
    expect(users?.name).toBe('User');
    expect(users?.ormType).toBe('diesel');
    expect(users?.fields.map((f) => f.name)).toEqual(['id', 'email', 'deleted_at']);
    expect(users?.fields.find((f) => f.name === 'id')?.isPrimaryKey).toBe(true);
    expect(users?.fields.find((f) => f.name === 'deleted_at')?.isNullable).toBe(true);
    expect(users?.fields.find((f) => f.name === 'email')?.isNullable).toBe(false);
  });

  it('turns joinable! into a real foreign-key relation with a resolved target id', async () => {
    const { entities, entityIdByName } = extractRustEntities([await rf('src/schema.rs', SCHEMA)], {
      idGen: ID,
      repoRoot: sqlRepo(),
    });
    const posts = entities.find((e) => e.tableName === 'posts');
    expect(posts?.relations).toEqual([
      { name: 'user_id', type: 'many-to-one', targetEntityName: 'users', targetEntityId: entityIdByName.get('users') },
    ]);
  });
});

describe('migration DDL — the source whose names match sqlx::query! strings', () => {
  it('reads tables, columns, nullability, PKs and REFERENCES out of CREATE TABLE', async () => {
    const root = sqlRepo({
      'migrations/20240101_init.sql': `
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
    const { entities } = extractRustEntities([], { idGen: ID, repoRoot: root });
    const users = entities.find((e) => e.tableName === 'users');
    expect(users?.name).toBe('User');
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
  });
});

describe('derive-marked structs', () => {
  it('names a sea-orm entity after its TABLE, not the struct (they are all `Model`)', async () => {
    // Naming the EntityNode after the struct collapses every sea-orm entity in the repo onto
    // one node, because every one of them is literally named `Model`.
    const userSrc = `
#[derive(Clone, Debug, DeriveEntityModel)]
#[sea_orm(table_name = "users")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub email: String,
    pub nickname: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::post::Entity")]
    Post,
}
`;
    const postSrc = `
#[derive(Clone, Debug, DeriveEntityModel)]
#[sea_orm(table_name = "posts")]
pub struct Model { pub id: i32 }
`;
    const { entities, entityIdByName } = extractRustEntities(
      [await rf('src/entity/user.rs', userSrc), await rf('src/entity/post.rs', postSrc)],
      { idGen: ID, repoRoot: sqlRepo() },
    );
    expect(entities.map((e) => e.name).sort()).toEqual(['Post', 'User']);
    expect(new Set(entities.map((e) => e.id)).size).toBe(2);
    // `post::Entity::find()` at a db-op site presents the MODULE name, so it must resolve too.
    expect(entityIdByName.get('post')).toBe(entities.find((e) => e.tableName === 'posts')?.id);
    expect(entities.find((e) => e.tableName === 'users')?.fields.find((f) => f.name === 'nickname')?.isNullable).toBe(
      true,
    );
    expect(entities.find((e) => e.tableName === 'users')?.relations[0]?.targetEntityName).toBe('post');
  });

  it('MERGES a diesel derive struct into the table! entity instead of double-emitting', async () => {
    // `table! { users … }` and `#[derive(Queryable)] struct User` describe the SAME table.
    // Double-emitting splits db-op attribution across two ids and every answer is half the truth.
    const files = [
      await rf('src/schema.rs', 'table! { users (id) { id -> Int4, email -> Varchar, } }'),
      await rf(
        'src/models.rs',
        '#[derive(Queryable)]\n#[diesel(table_name = users)]\npub struct User { pub id: i32, pub email: String }',
      ),
    ];
    const { entities, entityIdByName } = extractRustEntities(files, { idGen: ID, repoRoot: sqlRepo() });
    expect(entities).toHaveLength(1);
    // Both spellings a db-op site can use resolve to the SAME id.
    expect(entityIdByName.get('User')).toBe(entities[0].id);
    expect(entityIdByName.get('users')).toBe(entities[0].id);
  });

  it('leaves sqlx::FromRow projections out by default, and honors an explicit opt-in', async () => {
    // `FromRow` structs are usually projections (`UserRow`, `UserSummary`) over one table, so
    // defaulting them on inflates the count and guarantees the entities-but-0-dbOps red flag.
    const src = '#[derive(sqlx::FromRow)]\npub struct UserSummary { pub id: i32 }';
    const files = [await rf('src/dto.rs', src)];
    expect(extractRustEntities(files, { idGen: ID, repoRoot: sqlRepo() }).entities).toEqual([]);
    expect(
      extractRustEntities(files, { idGen: ID, repoRoot: sqlRepo(), deriveMacros: ['FromRow'] }).entities.map(
        (e) => e.name,
      ),
    ).toEqual(['UserSummary']);
  });

  it('ignores a struct with no persistence derive', async () => {
    const files = [await rf('src/x.rs', '#[derive(Debug, Clone)]\npub struct Config { pub port: u16 }')];
    expect(extractRustEntities(files, { idGen: ID, repoRoot: sqlRepo() }).entities).toEqual([]);
  });
});

describe('cross-source dedupe', () => {
  it('keeps ONE entity when the DDL and a derive struct describe the same table', async () => {
    const root = sqlRepo({ 'migrations/1_init.sql': 'CREATE TABLE users (id UUID PRIMARY KEY, email TEXT NOT NULL);' });
    const files = [
      await rf('src/models.rs', '#[derive(Queryable)]\n#[diesel(table_name = users)]\npub struct User { pub id: i32 }'),
    ];
    const { entities, entityIdByName, tableNames } = extractRustEntities(files, { idGen: ID, repoRoot: root });
    expect(entities).toHaveLength(1);
    expect(entities[0].tableName).toBe('users');
    expect(entityIdByName.get('User')).toBe(entities[0].id);
    expect([...tableNames]).toEqual(['users']);
  });
});
