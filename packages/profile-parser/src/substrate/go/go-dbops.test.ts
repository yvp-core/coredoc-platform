import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type GoFile } from './go-cst.js';
import { type GoDbOpConfig, extractGoDbOps } from './go-dbops.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

const ID = new StableIdGenerator('/demo', 'demo');
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function gf(relPath: string, source: string): Promise<GoFile> {
  return { relPath, source, root: await parseSource('go', source) };
}

/** A temp repo holding only `.sql` files — the Go sources are always passed in-memory. */
function sqlRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'go-dbops-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const TABLES = new Set(['users', 'posts']);
const IDS = new Map([
  ['users', ID.entityId('db/schema.sql', 'User')],
  ['posts', ID.entityId('db/schema.sql', 'Post')],
]);

/** Extract db-ops from one file — the whole result, so the resolution record is assertable too. */
async function resOf(body: string, cfg: Partial<GoDbOpConfig> = {}, relPath = 'internal/db/repo.go') {
  const file = await gf(relPath, `package db\n\n${body}`);
  return extractGoDbOps([file], TABLES, IDS, { idGen: ID, ...cfg });
}

/** Extract db-ops from one file and describe each as `op entityName idResolved`. */
async function opsOf(
  body: string,
  cfg: Partial<GoDbOpConfig> = {},
  relPath = 'internal/db/repo.go',
): Promise<string[]> {
  const res = await resOf(body, cfg, relPath);
  return res.dbOperations.map((o) => `${o.operation} ${o.entityName} ${o.entityId ? 'id' : 'no-id'}`);
}

// =============================================================================
// Lane 1 — sqlc
// =============================================================================

const QUERIES_SQL = `-- name: ListUsersByWorkspace :many
SELECT id, email FROM users WHERE workspace_id = $1;

-- name: CreateUser :one
INSERT INTO users (email) VALUES ($1) RETURNING *;

-- name: UpdatePostTitle :exec
-- a leading comment line the annotation is followed by
UPDATE posts SET title = $2 WHERE id = $1;

-- name: DeleteUser :exec
DELETE FROM users WHERE id = $1;

-- name: PurgeAll :exec
TRUNCATE users;

-- name: CountAuditLog :one
SELECT count(*) FROM audit_log;
`;

describe('sqlc — real table attribution at the CALL SITE, learned from the repo’s own .sql files', () => {
  const repoRoot = () => sqlRepo({ 'db/queries/users.sql': QUERIES_SQL });

  it('classifies every generated query method by the SQL its .sql file declares', async () => {
    const src = `
func (s *Store) Handle(ctx context.Context, id int64) error {
	users, err := s.q.ListUsersByWorkspace(ctx, id)
	u, err := s.q.CreateUser(ctx, "a@b.c")
	s.q.UpdatePostTitle(ctx, id, "t")
	s.q.DeleteUser(ctx, id)
	return err
}
`;
    expect(await opsOf(src, { repoRoot: repoRoot() })).toEqual([
      'read users id',
      'create users id',
      'update posts id',
      'delete users id',
    ]);
  });

  it('carries the query’s SQL as the op details — a table name is not enough to review a query', async () => {
    const src = 'func (s *Store) f(ctx context.Context) { s.q.DeleteUser(ctx, 1) }';
    const file = await gf('internal/db/repo.go', `package db\n\n${src}`);
    const res = extractGoDbOps([file], TABLES, IDS, { idGen: ID, repoRoot: repoRoot() });
    expect(res.dbOperations[0].details).toBe('DELETE FROM users WHERE id = $1;');
  });

  it('leaves a query whose table is not in the entity index without a fabricated entityId', async () => {
    const src = 'func (s *Store) f(ctx context.Context) { s.q.CountAuditLog(ctx) }';
    expect(await opsOf(src, { repoRoot: repoRoot() })).toEqual(['read audit_log no-id']);
  });

  it('reads a TRUNCATE query as a schema op over its table, not as a row delete', async () => {
    // `TRUNCATE users` used to be unreadable and the op was dropped; it now parses as `ddl`,
    // which keeps it out of the "who deletes user rows?" answer while making the surface visible.
    const src = 'func (s *Store) f(ctx context.Context) { s.q.PurgeAll(ctx) }';
    expect(await opsOf(src, { repoRoot: repoRoot() })).toEqual(['ddl users id']);
  });

  it('IGNORES a bare call that merely shares a query name — sqlc methods hang off a *Queries value', async () => {
    const src = 'func f(ctx context.Context) { DeleteUser(ctx, 1) }';
    expect(await opsOf(src, { repoRoot: repoRoot() })).toEqual([]);
  });

  it('is silent when no repoRoot is supplied (nothing to read the query vocabulary from)', async () => {
    const src = 'func (s *Store) f(ctx context.Context) { s.q.DeleteUser(ctx, 1) }';
    expect(await opsOf(src)).toEqual([]);
  });

  it('finds query files at any depth (a multi-module repo nests them under the owning module)', async () => {
    const root = sqlRepo({ 'services/api/internal/db/queries/users.sql': QUERIES_SQL });
    const src = 'func (s *Store) f(ctx context.Context) { s.q.DeleteUser(ctx, 1) }';
    expect(await opsOf(src, { repoRoot: root })).toEqual(['delete users id']);
  });

  it('honours a profile-supplied sqlcQueryGlobs, and finds nothing outside it', async () => {
    const root = sqlRepo({ 'sql/gen/users.sql': QUERIES_SQL });
    const src = 'func (s *Store) f(ctx context.Context) { s.q.DeleteUser(ctx, 1) }';
    expect(await opsOf(src, { repoRoot: root })).toEqual([]);
    expect(await opsOf(src, { repoRoot: root, sqlcQueryGlobs: ['**/sql/**/*.sql'] })).toEqual(['delete users id']);
  });
});

// =============================================================================
// Lane 2 — raw SQL
// =============================================================================

describe('raw SQL — database/sql, pgx and sqlx executors, read by the engine’s own parser', () => {
  it('reads the SQL argument of the standard executors whatever position it sits in', async () => {
    const src = `
func (r *Repo) Work(ctx context.Context, id int64) error {
	r.pool.Exec(ctx, "UPDATE users SET email = $1 WHERE id = $2", e, id)
	r.db.QueryContext(ctx, "SELECT id FROM posts WHERE user_id = $1", id)
	r.db.QueryRowContext(ctx, "SELECT count(*) FROM users")
	sqlx.Get(r.db, &u, "SELECT * FROM users WHERE id = $1", id)
	r.tx.NamedExec("INSERT INTO posts (title) VALUES (:title)", p)
	return nil
}
`;
    expect(await opsOf(src)).toEqual([
      'update users id',
      'read posts id',
      'read users id',
      'read users id',
      'create posts id',
    ]);
  });

  it('reads a backticked multi-line query — the literal has no string_content child to read', async () => {
    // TRAP: `interpreted_string_literal`/`raw_string_literal` expose NO `string_content` in this
    // grammar build, so the Python idiom yields '' here and the op silently loses its table.
    const src = [
      'func (r *Repo) f(ctx context.Context) {',
      '\tr.db.QueryContext(ctx, `',
      '\t\tSELECT id, email',
      '\t\tFROM users',
      '\t\tWHERE deleted_at IS NULL`)',
      '}',
    ].join('\n');
    const file = await gf('internal/db/repo.go', `package db\n\n${src}`);
    const res = extractGoDbOps([file], TABLES, IDS, { idGen: ID });
    expect(res.dbOperations.map((o) => `${o.operation} ${o.entityName}`)).toEqual(['read users']);
    expect(res.dbOperations[0].details).toBe('SELECT id, email FROM users WHERE deleted_at IS NULL');
  });

  it('follows the `const q = "…"` indirection that generated and hand-written Go both use', async () => {
    const src =
      `
const getUserQuery = ` +
      '`SELECT * FROM users WHERE id = $1`' +
      `

func (r *Repo) Get(ctx context.Context, id int64) error {
	stmt := "DELETE FROM posts WHERE id = $1"
	r.pool.QueryRow(ctx, getUserQuery, id)
	r.db.ExecContext(ctx, stmt, id)
	return nil
}
`;
    expect(await opsOf(src)).toEqual(['read users id', 'delete posts id']);
  });

  it('reports the FIRST binding of a rebound query name, in source order', async () => {
    // A `var` spec and a later `=` are different node types, scanned in different passes; merging
    // them by position is what keeps "first" meaning the statement written first rather than the
    // node type that happened to be scanned first.
    const src = `
func (r *Repo) f(ctx context.Context, all bool) {
	var q = "SELECT * FROM users"
	if all {
		q = "SELECT * FROM posts"
	}
	r.db.QueryContext(ctx, q)
}
`;
    expect(await opsOf(src)).toEqual(['read users id']);
  });

  it('resolves a query constant declared in ANOTHER FILE of the same package (Go has no file scope)', async () => {
    const consts = await gf('internal/db/queries.go', 'package db\n\nconst listUsers = "SELECT * FROM users"\n');
    const repo = await gf(
      'internal/db/repo.go',
      'package db\n\nfunc (r *Repo) f(ctx context.Context) { r.db.QueryContext(ctx, listUsers) }\n',
    );
    const res = extractGoDbOps([consts, repo], TABLES, IDS, { idGen: ID });
    expect(res.dbOperations.map((o) => `${o.operation} ${o.entityName}`)).toEqual(['read users']);
  });

  it('does NOT reach into a package the file never declared a constant of', async () => {
    const other = await gf('internal/other/queries.go', 'package other\n\nconst listUsers = "SELECT * FROM users"\n');
    const repo = await gf(
      'internal/db/repo.go',
      'package db\n\nfunc (r *Repo) f(ctx context.Context) { r.db.QueryContext(ctx, listUsers) }\n',
    );
    expect(extractGoDbOps([other, repo], TABLES, IDS, { idGen: ID }).dbOperations).toEqual([]);
  });

  it('IGNORES SQL that is not being executed, and executors whose argument is not SQL', async () => {
    const src = `
func (r *Repo) noise(ctx context.Context) {
	msg := fmt.Sprintf("SELECT * FROM users where id = %d", 1)
	log.Printf("SELECT * FROM users")
	r.db.Exec(ctx, "PRAGMA journal_mode = WAL")
	r.cache.Get(ctx, "user:1")
	r.client.Query(ctx, buildQuery(id))
}
`;
    expect(await opsOf(src)).toEqual([]);
  });

  it('accepts a repo’s own executor wrapper through cfg.methods', async () => {
    const src = 'func (r *Repo) f(ctx context.Context) { r.db.MustQueryRow(ctx, "SELECT * FROM users") }';
    expect(await opsOf(src)).toEqual([]);
    expect(await opsOf(src, { methods: ['MustQueryRow'] })).toEqual(['read users id']);
  });
});

// =============================================================================
// Lane 3 — GORM
// =============================================================================

describe('GORM — the table gate is what makes this lane usable', () => {
  it('derives the table from a .Model(&X{}) segment anywhere in the chain', async () => {
    const src = `
func (r *Repo) List(ctx context.Context) error {
	r.gdb.Model(&User{}).Where("id = ?", 1).Find(&users)
	r.gdb.Model(&Post{}).Count(&n)
	return nil
}
`;
    expect(await opsOf(src)).toEqual(['read users id', 'read posts id']);
  });

  it('derives the table from a .Table("…") segment and from the verb’s own model literal', async () => {
    const src = `
func (r *Repo) Write(ctx context.Context) error {
	r.gdb.Table("users").Updates(map[string]any{"email": e})
	r.gdb.Create(&User{Email: "a@b.c"})
	r.gdb.Where("id = ?", 1).Delete(&Post{})
	return nil
}
`;
    expect(await opsOf(src)).toEqual(['update users id', 'create users id', 'delete posts id']);
  });

  it('IGNORES ordinary Go methods that share GORM’s verb names', async () => {
    // `rows.Scan(&a, &b)` is in every database/sql loop, `cache.Delete(k)` in every cache wrapper,
    // and `Find`/`First`/`Count` are ordinary helper names. A verb-name-only rule buries the real
    // ops under thousands of `entityName: unknown` rows.
    const src = `
func (r *Repo) ordinary(rows *sql.Rows) error {
	for rows.Next() {
		rows.Scan(&id, &email)
	}
	r.cache.Delete("user:1")
	r.index.Find("needle")
	r.items.First()
	r.metrics.Count()
	r.mu.Update(func() {})
	return nil
}
`;
    const res = await resOf(src);
    expect(res.dbOperations).toEqual([]);
    // And none of them is a SITE either. A verb-name-only rule would count all six as misses,
    // so the resolution rate would collapse on a repo that uses no GORM at all — the record has
    // to agree with the table gate, not just the output.
    expect(res.stats).toEqual({ dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 });
  });

  it('SKIPS a model passed as a variable — its type is not in the CST, and a guess would be fiction', async () => {
    const src = 'func (r *Repo) f(u *User) { r.gdb.Create(&u); r.gdb.Save(u) }';
    expect(await opsOf(src)).toEqual([]);
  });

  it('emits the source’s own spelling, with no entityId, for a model no entity answers to', async () => {
    const src = 'func (r *Repo) f() { r.gdb.Model(&AuditLog{}).Find(&rows) }';
    expect(await opsOf(src)).toEqual(['read AuditLog no-id']);
  });

  it('emits ONE op for a chain, not one per builder segment', async () => {
    const src = 'func (r *Repo) f() { r.gdb.Model(&User{}).Where("a = ?", 1).Order("id").Limit(10).Find(&users) }';
    expect(await opsOf(src)).toEqual(['read users id']);
  });
});

// =============================================================================
// Performers
// =============================================================================

describe('performers', () => {
  it('mints a FunctionNode for every performer so no performerId dangles', async () => {
    const src = `
func (r *Repo) Get(ctx context.Context) error {
	r.db.QueryContext(ctx, "SELECT * FROM users")
	return nil
}

func List(ctx context.Context, db *sql.DB) error {
	db.QueryContext(ctx, "SELECT * FROM posts")
	return nil
}
`;
    const file = await gf('internal/db/repo.go', `package db\n\n${src}`);
    const res = extractGoDbOps([file], TABLES, IDS, { idGen: ID });
    const byId = new Map(res.functions.map((f) => [f.id, f]));
    expect(res.dbOperations.every((o) => byId.has(o.performerId))).toBe(true);
    expect(res.functions.map((f) => `${f.name} ${f.kind}`).sort()).toEqual(['Get method', 'List function']);
  });

  it('attributes a package-scope site to an `init` performer instead of dropping it', async () => {
    // Go really executes package-level initializers — at init time, with no enclosing function.
    const src = 'var listStmt, _ = db.Prepare("SELECT * FROM users")';
    const file = await gf('internal/db/repo.go', `package db\n\n${src}`);
    const res = extractGoDbOps([file], TABLES, IDS, { idGen: ID });
    expect(res.dbOperations.map((o) => `${o.operation} ${o.entityName}`)).toEqual(['read users']);
    expect(res.functions.map((f) => f.id)).toEqual([ID.functionId('internal/db/repo.go', 'init')]);
    expect(res.dbOperations[0].performerId).toBe(res.functions[0].id);
  });

  it('attributes a site inside a closure to the closure, not to its enclosing function', async () => {
    const src = `
func (r *Repo) Run(ctx context.Context) error {
	return r.tx(ctx, func(tx *sql.Tx) error {
		tx.ExecContext(ctx, "DELETE FROM posts WHERE id = $1", 1)
		return nil
	})
}
`;
    const file = await gf('internal/db/repo.go', `package db\n\n${src}`);
    const res = extractGoDbOps([file], TABLES, IDS, { idGen: ID });
    expect(res.functions.map((f) => f.name)).toEqual(['(anonymous)']);
    expect(res.dbOperations[0].performerId).not.toBe(ID.methodId('internal/db/repo.go', 'Repo', 'Run'));
  });

  it('every emitted id comes from the generator and belongs to this repo', async () => {
    const src = 'func (r *Repo) f(ctx context.Context) { r.db.QueryContext(ctx, "SELECT * FROM users") }';
    const file = await gf('internal/db/repo.go', `package db\n\n${src}`);
    const res = extractGoDbOps([file], TABLES, IDS, { idGen: ID });
    for (const op of res.dbOperations) {
      expect(ID.belongsToRepo(op.id)).toBe(true);
      expect(op.id.split(':')[1]).toBe('db-op');
      expect(op.versionedId).not.toBe(op.id);
    }
    for (const fn of res.functions) expect(ID.belongsToRepo(fn.id)).toBe(true);
  });

  it('records one op per site, so a re-run over the same file is stable', async () => {
    const src = 'func (r *Repo) f(ctx context.Context) { r.db.QueryContext(ctx, "SELECT * FROM users") }';
    const file = await gf('internal/db/repo.go', `package db\n\n${src}`);
    const a = extractGoDbOps([file], TABLES, IDS, { idGen: ID });
    const b = extractGoDbOps([file], TABLES, IDS, { idGen: ID });
    expect(a.dbOperations.map((o) => o.id)).toEqual(b.dbOperations.map((o) => o.id));
    expect(a.dbOperations).toHaveLength(1);
  });
});

// =============================================================================
// A bare profile
// =============================================================================

describe('defaults', () => {
  it('extracts all three lanes with no knob set beyond idGen + repoRoot', async () => {
    const root = sqlRepo({ 'db/queries/users.sql': QUERIES_SQL });
    const src = `
func (s *Store) All(ctx context.Context) error {
	s.q.ListUsersByWorkspace(ctx, 1)
	s.db.ExecContext(ctx, "DELETE FROM posts WHERE id = $1", 1)
	s.gdb.Model(&User{}).Count(&n)
	return nil
}
`;
    expect(await opsOf(src, { repoRoot: root })).toEqual(['read users id', 'delete posts id', 'read users id']);
  });
});

// =============================================================================
// stats.dbOpResolution (spec BR-4, LIM-4)
// =============================================================================

describe('dbOpResolution', () => {
  it('counts sites, entity-bound ops and table tokens the repo declares nowhere', async () => {
    // `events` is a declared table with no entity behind it: in scope and UNBOUND (the third
    // bucket), which is why `bound + outOfScope < sites` here. `widgets` is declared nowhere.
    const tables = new Set(['users', 'events']);
    const ids = new Map([['users', ID.entityId('db/schema.sql', 'User')]]);
    const file = await gf(
      'internal/db/repo.go',
      `package db

func (r *Repo) f() {
	r.gdb.Table("users").Find(&u)
	r.gdb.Table("events").Find(&e)
	r.gdb.Table("widgets").Find(&w)
}
`,
    );
    const res = extractGoDbOps([file], tables, ids, { idGen: ID });
    expect(res.dbOperations.map((o) => `${o.entityName} ${o.entityId ? 'id' : 'no-id'}`)).toEqual([
      'users id',
      'events no-id',
      'widgets no-id',
    ]);
    expect(res.stats).toEqual({ dbOpSites: 3, boundDbOps: 1, outOfScopeDbOps: 1 });
    expect(res.stats.boundDbOps + res.stats.outOfScopeDbOps).toBeLessThanOrEqual(res.stats.dbOpSites);
  });

  it('counts the sqlc sub-lane at its own enumeration point (a query-name hit)', async () => {
    const repoRoot = sqlRepo({ 'db/queries/users.sql': QUERIES_SQL });
    const src = `
func (s *Store) Handle(ctx context.Context, id int64) error {
	s.q.DeleteUser(ctx, id)
	s.q.CountAuditLog(ctx)
	DeleteUser(ctx, id)
	return nil
}
`;
    const res = await resOf(src, { repoRoot });
    // `audit_log` answers to no entity and to no declared table → out of scope. The bare
    // `DeleteUser(...)` is not a sqlc site at all (no `*Queries` receiver), so it is UNCOUNTED.
    expect(res.dbOperations.map((o) => `${o.entityName} ${o.entityId ? 'id' : 'no-id'}`)).toEqual([
      'users id',
      'audit_log no-id',
    ]);
    expect(res.stats).toEqual({ dbOpSites: 2, boundDbOps: 1, outOfScopeDbOps: 1 });
  });

  it('counts the raw-SQL sub-lane at its own enumeration point (readable SQL in an executor)', async () => {
    const src = `
func (r *Repo) f(ctx context.Context) error {
	r.db.QueryContext(ctx, "SELECT id FROM users")
	r.db.ExecContext(ctx, "DELETE FROM widgets WHERE id = $1", 1)
	r.db.QueryContext(ctx, buildQuery())
	return nil
}
`;
    const res = await resOf(src);
    // `widgets` is declared nowhere → out of scope. The executor whose argument is not readable
    // SQL never became a site: this lane claims a site only where it read a statement.
    expect(res.dbOperations.map((o) => `${o.entityName} ${o.entityId ? 'id' : 'no-id'}`)).toEqual([
      'users id',
      'widgets no-id',
    ]);
    expect(res.stats).toEqual({ dbOpSites: 2, boundDbOps: 1, outOfScopeDbOps: 1 });
  });
});
