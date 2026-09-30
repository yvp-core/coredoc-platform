import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type RustFile, parseRust } from './rust-cst.js';
import { extractRustDbOps } from './rust-dbops.js';

const ID = new StableIdGenerator('/demo', 'demo');

async function rf(relPath: string, source: string): Promise<RustFile> {
  return { relPath, source, root: await parseRust(source) };
}

const TABLES = new Set(['users', 'posts']);
const IDS = new Map([
  ['users', ID.entityId('src/schema.rs', 'User')],
  ['posts', ID.entityId('src/schema.rs', 'Post')],
  ['post', ID.entityId('src/entity/post.rs', 'Post')],
]);

/** Extract db-ops and describe each as `op entityName idResolved`. */
async function opsOf(source: string, relPath = 'src/repo.rs'): Promise<string[]> {
  const res = extractRustDbOps([await rf(relPath, source)], TABLES, IDS, { idGen: ID });
  return res.dbOperations.map((o) => `${o.operation} ${o.entityName} ${o.entityId ? 'id' : 'no-id'}`);
}

describe('sqlx macros — real SQL, read by the engine’s own parser', () => {
  it('classifies the op and resolves the entity from the SQL text', async () => {
    const src = `
async fn queries(pool: &PgPool) {
    sqlx::query!("SELECT id, email FROM users WHERE id = $1", id).fetch_one(pool).await;
    sqlx::query_as!(User, "INSERT INTO users (email) VALUES ($1)", email).execute(pool).await;
    sqlx::query!("UPDATE posts SET title = $1 WHERE id = $2", t, id).execute(pool).await;
    sqlx::query_scalar!("DELETE FROM posts WHERE id = $1", id).execute(pool).await;
}
`;
    expect(await opsOf(src)).toEqual(['read users id', 'create users id', 'update posts id', 'delete posts id']);
  });

  it('reads the SQL out of `query_as!(Type, "…")` where the type comes first', async () => {
    const src = 'async fn f(p: &PgPool) { sqlx::query_as!(UserRow, "SELECT * FROM users").fetch_all(p).await; }';
    expect(await opsOf(src)).toEqual(['read users id']);
  });

  it('handles a raw-string SQL literal (no string_content child to read)', async () => {
    const src = 'async fn f(p: &PgPool) { sqlx::query!(r#"SELECT * FROM users"#).fetch_all(p).await; }';
    expect(await opsOf(src)).toEqual(['read users id']);
  });

  it('leaves an unknown table with no fabricated entityId', async () => {
    const src = 'async fn f(p: &PgPool) { sqlx::query!("SELECT * FROM audit_log").fetch_all(p).await; }';
    expect(await opsOf(src)).toEqual(['read audit_log no-id']);
  });
});

describe('the receiver gate — the reason this lane is usable at all', () => {
  it('IGNORES ordinary Iterator/Option/HashMap calls that share the verb names', async () => {
    // `.filter`, `.find`, `.first`, `.count`, `.get`, `.all` and `.one` are everywhere in Rust.
    // A method-name-only rule emits thousands of false db-ops against `entityName: unknown`.
    const src = `
fn ordinary(items: Vec<u8>, map: HashMap<String, u8>, opt: Option<u8>) {
    let a = items.iter().filter(|x| **x > 1).count();
    let b = map.get("key");
    let c = items.first();
    let d = items.iter().find(|x| **x == 2);
    let e = opt.filter(|x| *x > 0);
    let f = items.iter().all(|x| *x > 0);
    headers.get("X-Amz-Date");
}
`;
    expect(await opsOf(src)).toEqual([]);
  });

  it('accepts a diesel `::table` receiver chain, through a turbofish', async () => {
    // `.load::<User>(conn)` puts a `generic_function` between the call and the field expression;
    // a walker that only knows `field_expression` skips every turbofished call.
    const src = `
fn load_all(conn: &mut PgConnection) {
    users::table.filter(users::id.eq(1)).load::<User>(conn).unwrap();
}
`;
    expect(await opsOf(src)).toEqual(['read users id', 'read users id']);
  });

  it('accepts a bare table-name root (the `use schema::users::dsl::*` shape)', async () => {
    const src = `
use schema::users::dsl::*;
fn find_one(conn: &mut PgConnection) {
    users.filter(email.eq("a")).first(conn).unwrap();
}
`;
    expect(await opsOf(src)).toEqual(['read users id', 'read users id']);
  });

  it('accepts diesel free functions whose argument names a table', async () => {
    const src = `
fn writes(conn: &mut PgConnection, new_user: &NewUser) {
    diesel::insert_into(users::table).values(new_user).execute(conn).unwrap();
    diesel::delete(posts::table).execute(conn).unwrap();
}
`;
    const ops = await opsOf(src);
    expect(ops).toContain('create users id');
    expect(ops).toContain('delete posts id');
  });

  it('rejects a free function whose argument is not a table', async () => {
    const src = 'fn f(x: Vec<u8>) { diesel::delete(x).execute(conn).unwrap(); }';
    expect(await opsOf(src)).toEqual([]);
  });

  it('accepts a sea-orm `::Entity` chain and resolves the entity by MODULE name', async () => {
    const src = `
async fn find(db: &DbConn) {
    post::Entity::find().all(db).await.unwrap();
    post::Entity::find_by_id(1).one(db).await.unwrap();
}
`;
    // `post::Entity::find()` presents the module name at the db-op site, which the entity index
    // registers as an alias — so the id resolves rather than dangling.
    expect((await opsOf(src)).every((o) => o.endsWith('post id'))).toBe(true);
  });
});

describe('performers', () => {
  it('mints a FunctionNode for the enclosing fn so every performerId resolves', async () => {
    const src = 'async fn load(p: &PgPool) { sqlx::query!("SELECT * FROM users").fetch_all(p).await; }';
    const res = extractRustDbOps([await rf('src/repo.rs', src)], TABLES, IDS, { idGen: ID });
    const ids = new Set(res.functions.map((f) => f.id));
    expect(res.dbOperations.every((o) => ids.has(o.performerId))).toBe(true);
    expect(res.functions[0].name).toBe('load');
  });

  it('skips a module-scope op site that has no enclosing fn', async () => {
    const src = 'static Q: &str = "x";\nconst _: () = { sqlx::query!("SELECT * FROM users"); };';
    const res = extractRustDbOps([await rf('src/repo.rs', src)], TABLES, IDS, { idGen: ID });
    expect(res.dbOperations).toEqual([]);
  });
});

/**
 * BR-4 — the lane's resolution record over its three walks. A site is a sqlx macro / diesel free
 * fn / chain candidate ENUMERATED before the table-or-entity gate; a rejected gate is out of
 * scope (the root names no table and no entity module), an unparsable one is in scope, unbound.
 */
describe('rust db-op resolution record (BR-4)', () => {
  it('counts enumerated sites, bound entities and out-of-scope roots', async () => {
    const src = `
async fn f(pool: &PgPool, conn: &mut PgConnection, v: Vec<u8>) {
    sqlx::query!("SELECT * FROM users");
    diesel::insert_into(bogus);
    let _ = v.filter(|x| **x > 0);
}
`;
    const res = extractRustDbOps([await rf('src/repo.rs', src)], TABLES, IDS, { idGen: ID });
    // BR-6: only the sqlx macro still emits.
    expect(res.dbOperations.map((o) => `${o.operation} ${o.entityName}`)).toEqual(['read users']);
    // `diesel::insert_into(bogus)` is a candidate of BOTH the free-fn walk and the chain walk
    // (`insert_into` is also an op verb); it counts ONCE — the first walk to reach it judges it.
    expect(res.stats).toEqual({ dbOpSites: 3, boundDbOps: 1, outOfScopeDbOps: 2 });
    expect(res.stats.boundDbOps + res.stats.outOfScopeDbOps).toBeLessThanOrEqual(res.stats.dbOpSites);
  });

  it('lets a later walk that BINDS a node overrule an earlier walk that rejected it', async () => {
    // `post::Entity::insert_into(bogus)` is rejected by the free-fn walk (the argument names no
    // table), then emitted by the chain walk (`post` is a known entity module). One site, bound,
    // and NOT out of scope — the verdict is settled after every walk.
    const src = 'fn f(conn: &mut PgConnection) { post::Entity::insert_into(bogus); }';
    const res = extractRustDbOps([await rf('src/repo.rs', src)], TABLES, IDS, { idGen: ID });
    expect(res.dbOperations.map((o) => `${o.operation} ${o.entityName} ${o.entityId ? 'id' : 'no-id'}`)).toEqual([
      'create post id',
    ]);
    expect(res.stats).toEqual({ dbOpSites: 1, boundDbOps: 1, outOfScopeDbOps: 0 });
  });

  it('counts a sqlx macro with no static SQL as an in-scope unbound site', async () => {
    const src = 'async fn f(q: &str) { sqlx::query!(q); }';
    const res = extractRustDbOps([await rf('src/repo.rs', src)], TABLES, IDS, { idGen: ID });
    expect(res.dbOperations).toEqual([]);
    expect(res.stats).toEqual({ dbOpSites: 1, boundDbOps: 0, outOfScopeDbOps: 0 });
  });
});
