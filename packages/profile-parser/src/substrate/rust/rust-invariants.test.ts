/**
 * Graph-wide invariant suite for the Rust substrate.
 *
 * The per-concern tests assert positive/negative outcomes on tiny fixtures. This file does the
 * OTHER thing: it scans the WHOLE assembled repo for property violations, sample-free. The
 * fixture is deliberately shaped to trigger the trap classes the substrate exists to avoid —
 * two files with a same-named `impl Svc`, a `foo.rs` + `foo/` module pair, a hyphenated crate
 * name used with underscores in code, a host-only egress URL beside a real one, an Anchor
 * `#[program]` mod, and a diesel `table!` describing the same table as a derive struct.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FunctionNode, QueueEntrypointDetails } from '@coredoc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RustProfile } from '../../types.js';
import { type RustParsedRepo, parseRustRepo } from './rust-parser.js';

const FILES: Record<string, string> = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/api", "crates/program"]\n',

  // --- crate 1: a hyphenated name, used as `my_api` in code ---
  'crates/api/Cargo.toml':
    '[package]\nname = "my-api"\nversion = "0.1.0"\n\n[dependencies]\nreqwest = "0.12"\ndiesel = "2"\n',
  'crates/api/src/lib.rs': `
pub mod schema;
pub mod models;
pub mod db;
pub mod routes;
pub mod svc_a;
pub mod svc_b;
`,
  'crates/api/src/schema.rs': `
diesel::table! {
    users (id) {
        id -> Int4,
        email -> Varchar,
        deleted_at -> Nullable<Timestamp>,
    }
}
`,
  // Describes the SAME table as the `table!` above — must merge, not double-emit.
  'crates/api/src/models.rs': `
#[derive(Queryable)]
#[diesel(table_name = users)]
pub struct User {
    pub id: i32,
    pub email: String,
}
`,
  // `db.rs` declares `mod queries;`, which lives at `db/queries.rs` — the moduleDir asymmetry.
  'crates/api/src/db.rs': `
pub mod queries;

pub fn connect() -> u8 { 1 }
`,
  'crates/api/src/db/queries.rs': `
use crate::schema::users;

pub fn load_all(conn: &mut PgConnection) -> Vec<User> {
    users::table.filter(users::email.eq("a")).load::<User>(conn).unwrap()
}

pub fn insert_one(conn: &mut PgConnection, new_user: &NewUser) {
    diesel::insert_into(users::table).values(new_user).execute(conn).unwrap();
}
`,
  'crates/api/src/routes.rs': `
use crate::db::queries::load_all;

#[get("/users")]
async fn list_users() -> String { String::new() }

pub fn app() -> Router {
    Router::new()
        .nest("/api", Router::new().route("/health", get(health)))
        .route("/version", get(version))
}

async fn health() -> String { load_all(); String::new() }
async fn version() -> String { String::new() }
`,
  // Two files with the SAME type name — a name-only method index would cross-link them.
  'crates/api/src/svc_a.rs': `
pub struct Svc { http: reqwest::Client }

impl Svc {
    fn helper(&self) -> u8 { 1 }
    pub async fn run(&self) -> u8 {
        self.http.get("/v1/orders").send().await;
        self.http.get("https://only-a-host").send().await;
        self.helper()
    }
}
`,
  'crates/api/src/svc_b.rs': `
pub struct Svc;

impl Svc {
    fn helper(&self) -> u8 { 2 }
    pub fn run(&self) -> u8 { self.helper() }
}
`,
  'crates/api/migrations/20240101_init.sql':
    'CREATE TABLE orders (\n  id BIGSERIAL PRIMARY KEY,\n  user_id INT NOT NULL REFERENCES users(id)\n);\n',

  // --- crate 2: an Anchor program ---
  'crates/program/Cargo.toml':
    '[package]\nname = "my-program"\nversion = "0.1.0"\n\n[dependencies]\nanchor-lang = "0.30"\n',
  'crates/program/src/lib.rs': `
pub mod instructions;

#[program]
pub mod my_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, amount: u64) -> Result<()> {
        instructions::initialize(ctx, amount)
    }

    pub fn helper_not_an_instruction(amount: u64) -> u64 { amount }
}

#[derive(Accounts)]
pub struct Initialize<'info> { pub payer: Signer<'info> }
`,
  'crates/program/src/instructions.rs': `
pub fn initialize(ctx: Context<Initialize>, amount: u64) -> Result<()> { Ok(()) }
`,
};

const PROFILE: RustProfile = {
  parserId: 'inv',
  repoType: 'backend',
  substrate: { language: 'rust', include: ['**/*.rs'] },
};

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'rs-invariants-'));
  for (const [rel, src] of Object.entries(FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, src);
  }
  return root;
}

describe('rust substrate — graph-wide invariants', () => {
  let root: string;
  let repo: RustParsedRepo;
  let fnById: Map<string, FunctionNode>;

  beforeAll(async () => {
    root = writeFixture();
    repo = await parseRustRepo(root, 'inv', {}, PROFILE);
    fnById = new Map((repo.functions ?? []).map((f) => [f.id, f]));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('no rs-self CALL edge crosses a file boundary', () => {
    // Two `impl Svc` in different files must each resolve run->helper within their OWN file.
    const selfEdges = repo.calls.filter((e) => e.provenance === 'rs-self' && e.calleeId);
    const offenders = selfEdges.filter(
      (e) => fnById.get(e.callerId)?.location.filePath !== fnById.get(e.calleeId as string)?.location.filePath,
    );
    expect(offenders).toEqual([]);
    expect(selfEdges.length).toBeGreaterThanOrEqual(2); // non-vacuous
  });

  it('every CALL edge resolves to a real FunctionNode and carries a shippable provenance', () => {
    for (const e of repo.calls) {
      expect(e.calleeId).toBeDefined();
      expect(fnById.has(e.calleeId as string)).toBe(true);
      expect(['rs-path', 'rs-use', 'rs-self', 'rs-local']).toContain(e.provenance);
    }
  });

  it('every DbOperation performer id resolves to a real FunctionNode', () => {
    expect(repo.dbOperations.filter((op) => !fnById.has(op.performerId))).toEqual([]);
    expect(repo.dbOperations.length).toBeGreaterThan(0); // non-vacuous
  });

  it('every entrypoint handlerId resolves to a real FunctionNode', () => {
    const dangling = repo.entrypoints.filter((e) => !fnById.has(e.handlerId));
    expect(dangling.map((e) => `${e.type} ${e.location.filePath}:${e.location.startLine}`)).toEqual([]);
  });

  it('every FileNode belongs to a crate Package that exists', () => {
    const packageIds = new Set(repo.packages.map((p) => p.id));
    expect(repo.files.filter((f) => !packageIds.has(f.packageId))).toEqual([]);
    expect(repo.files.length).toBeGreaterThan(0);
    // The hyphenated Cargo names survive onto the Package nodes.
    expect(repo.packages.map((p) => p.name).sort()).toEqual(['my-api', 'my-program']);
  });

  it('no egress edge has an empty or bare-slash path template', () => {
    for (const x of repo.externalCalls) {
      const p = x.targetDescriptor?.http?.pathTemplate;
      expect(p).toBeTruthy();
      expect(p).not.toBe('/');
    }
    // The real egress survived with its path; the host-only one beside it was dropped.
    expect(repo.externalCalls.map((x) => x.targetDescriptor?.http?.pathTemplate)).toEqual(['/v1/orders']);
  });

  it('every node/edge versionedId is a real checksum (id@hex, never @1)', () => {
    const checksum = /@[0-9a-f]{6,}$/;
    const nodes: Array<{ id: string; versionedId: string }> = [
      ...(repo.functions ?? []),
      ...repo.files,
      ...repo.classes,
      ...repo.interfaces,
      ...repo.enums,
      ...repo.entities,
      ...repo.entrypoints,
      ...repo.dbOperations,
      ...repo.externalCalls,
    ];
    const bad = nodes.filter((n) => !n.versionedId || n.versionedId === `${n.id}@1` || !checksum.test(n.versionedId));
    expect(bad.map((n) => n.id)).toEqual([]);
    expect(repo.calls.every((c) => Boolean(c.id) && Boolean(c.callerId))).toBe(true);
  });

  it('the table! and the derive struct describe ONE entity, not two', () => {
    // Double-emitting splits db-op attribution across two ids and halves every answer.
    expect(repo.entities.filter((e) => e.tableName === 'users')).toHaveLength(1);
    // The migration DDL contributed its own table alongside the diesel schema.
    expect(repo.entities.map((e) => e.tableName).sort()).toEqual(['orders', 'users']);
  });

  it('resolves the moduleDir asymmetry — db.rs owns db/queries.rs', () => {
    // `crates/api/src/db.rs` declaring `mod queries;` resolves to `db/queries.rs`; a naive
    // dirname() would look for `src/queries.rs` and the whole module graph would be wrong.
    expect(repo.files.map((f) => f.path)).toContain('crates/api/src/db/queries.rs');
    const routeFn = (repo.functions ?? []).find((f) => f.name === 'health');
    const edge = repo.calls.find((e) => e.callerId === routeFn?.id);
    expect(fnById.get(edge?.calleeId as string)?.location.filePath).toBe('crates/api/src/db/queries.rs');
  });

  it('emits Anchor instructions as `queue` (never `event`) with namespaced topics', () => {
    const queue = repo.entrypoints.filter((e) => e.type === 'queue');
    expect(queue.map((e) => (e.details as QueueEntrypointDetails).topic)).toEqual(['my_program::initialize']);
    expect(repo.entrypoints.some((e) => e.type === 'event')).toBe(false);
  });
});

/**
 * `RustProfile` documents every knob as optional with a code-level default so a bare
 * `{ parserId, substrate }` profile already extracts meaningfully. Gating extraction on the
 * PRESENCE of a key would contradict that: omitting `entities` would yield zero entities AND
 * zero db-ops with no error — the silent hole this substrate exists to avoid.
 */
describe('rust substrate — a bare profile uses defaults, not opt-out', () => {
  let root: string;
  let bare: RustParsedRepo;

  beforeAll(async () => {
    root = writeFixture();
    bare = await parseRustRepo(root, 'bare', {}, {
      parserId: 'bare',
      substrate: { language: 'rust', include: ['**/*.rs'] },
    } as RustProfile);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('yields crates, files, functions and types', () => {
    expect(bare.packages.length).toBeGreaterThan(0);
    expect(bare.files.length).toBeGreaterThan(0);
    expect((bare.functions ?? []).length).toBeGreaterThan(0);
    expect(bare.classes.length).toBeGreaterThan(0);
  });

  it('yields entities, db-ops, entrypoints, calls and egress with no knobs declared', () => {
    expect(bare.entities.length).toBeGreaterThan(0);
    expect(bare.dbOperations.length).toBeGreaterThan(0);
    expect(bare.entrypoints.length).toBeGreaterThan(0);
    expect(bare.calls.length).toBeGreaterThan(0);
    expect(bare.externalCalls.length).toBeGreaterThan(0);
  });
});
