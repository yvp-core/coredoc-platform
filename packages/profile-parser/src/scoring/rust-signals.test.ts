import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RustProfile } from '../types/rust-profile.js';
import { rustSourceSignals } from './rust-signals.js';
import { categoryScore } from './score-core.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo(files: Record<string, string>, checkoutDir = ''): string {
  const base = mkdtempSync(join(tmpdir(), 'rs-signals-'));
  roots.push(base);
  const root = checkoutDir ? join(base, checkoutDir) : base;
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const profile: RustProfile = {
  parserId: 'rs-v1',
  substrate: { language: 'rust', include: ['**/*.rs'] },
};

describe('rustSourceSignals', () => {
  it('counts route attributes and router registration call sites for http', () => {
    const root = repo({
      'src/api.rs': `
#[get("/users")]
async fn list() {}
#[post("/users")]
async fn create() {}

fn app() -> Router {
    Router::new().route("/health", get(health)).nest("/api", inner())
}
`,
    });
    const signals = rustSourceSignals(root, profile);
    // `grep -c` counts matching LINES, not matches: 2 attribute-route lines + the one builder
    // line carrying both `.route("` and `.nest("` = 3. This is an order-of-magnitude signal.
    expect(signals.http).toBe(3);
  });

  it('counts persistence derives, table! blocks and CREATE TABLE DDL for entities', () => {
    const root = repo({
      'src/schema.rs': 'diesel::table! {\n    users (id) { id -> Int4, }\n}\n',
      'src/models.rs': '#[derive(Debug, Queryable)]\npub struct User { pub id: i32 }\n',
      'src/entity.rs': '#[derive(Clone, DeriveEntityModel)]\npub struct Model { pub id: i32 }\n',
      // Depth-agnostic: a Cargo workspace keeps migrations under the owning crate.
      'crates/api/migrations/1_init.sql': 'CREATE TABLE users (id UUID PRIMARY KEY);\ncreate table orders (id INT);\n',
    });
    const signals = rustSourceSignals(root, profile);
    // 2 derives + 1 table! + 2 CREATE TABLE (one lowercase — `grep -E` has no `-i`).
    expect(signals.entities).toBe(5);
  });

  it('does not count a derive that merely CONTAINS a configured name', () => {
    const root = repo({ 'src/x.rs': '#[derive(MyQueryableThing)]\npub struct A { pub id: i32 }\n' });
    expect(rustSourceSignals(root, profile).entities).toBe(0);
  });

  it('omits queue so a contract-only crate scores self-relative, and http stays honestly zero', () => {
    // A pure-contract crate has no HTTP surface. The http denominator must be 0 so the category
    // goes `not_applicable` (→ PASS) rather than scoring as an HTTP FAIL.
    const root = repo({
      'src/lib.rs': '#[program]\npub mod prog {\n    pub fn initialize(ctx: Context<I>) -> Result<()> { Ok(()) }\n}\n',
    });
    const signals = rustSourceSignals(root, profile);
    expect(signals.http).toBe(0);
    expect(signals.queue).toBeUndefined(); // omitted → self-relative
    expect(signals.externalCalls).toBeUndefined();
    expect(signals.dbOperations).toBeUndefined();

    const http = categoryScore('http', signals.http, 0);
    expect(http.status).toBe('not_applicable');
    expect(http.verdict).toBe('PASS');
    // queue self-relative: emitted 1 against source 1 → PASS.
    expect(categoryScore('queue', 1, 1).verdict).toBe('PASS');
  });

  it('honors configured route attributes and derive macros', () => {
    const root = repo({
      'src/x.rs': '#[handler("/x")]\nfn h() {}\n#[derive(MyModel)]\nstruct M { id: i32 }\n',
    });
    const tuned: RustProfile = {
      ...profile,
      entrypoints: { http: { routeAttributes: ['handler'], routerMethods: ['route'] } },
      entities: { deriveMacros: ['MyModel'] },
    };
    const signals = rustSourceSignals(root, tuned);
    expect(signals.http).toBe(1);
    expect(signals.entities).toBe(1);
  });

  it('does not let the CHECKOUT path zero the denominators', () => {
    // grep echoes absolute paths, so testing the noise exclusion against the whole line makes a
    // repo living under `~/examples/…` (or tests/vendor/target/node_modules) drop every match.
    // A zero denominator scores `not_applicable` → PASS, so the failure mode is a false PASS.
    for (const dir of ['examples/api', 'vendor/api', 'tests/api', 'node_modules/api']) {
      const root = repo(
        {
          'src/api.rs': '#[get("/users")]\nasync fn list() {}\n',
          'migrations/1_init.sql': 'CREATE TABLE users (id UUID PRIMARY KEY);\n',
        },
        dir,
      );
      const signals = rustSourceSignals(root, profile);
      expect(signals.http, `http under ${dir}`).toBe(1);
      expect(signals.entities, `entities under ${dir}`).toBe(1);
    }
  });

  it('still excludes in-repo target/vendor/test noise', () => {
    const root = repo({
      'src/api.rs': '#[get("/users")]\nasync fn list() {}\n',
      'target/debug/build/gen.rs': '#[get("/generated")]\nasync fn gen() {}\n',
      'tests/it.rs': '#[get("/fixture")]\nasync fn fixture() {}\n',
    });
    expect(rustSourceSignals(root, profile).http).toBe(1);
  });

  it('scopes the grep to the include roots', () => {
    const root = repo({
      'crates/api/src/a.rs': '#[get("/a")]\nfn a() {}\n',
      'other/src/b.rs': '#[get("/b")]\nfn b() {}\n',
    });
    const scoped: RustProfile = { ...profile, substrate: { language: 'rust', include: ['crates/**/*.rs'] } };
    expect(rustSourceSignals(root, scoped).http).toBe(1);
  });

  it('does not count route or entity signals from profile-excluded generated sources', () => {
    const root = repo({
      'src/api.rs': '#[get("/live")]\nfn live() {}\n#[derive(Queryable)]\nstruct Live { id: i32 }\n',
      'generated/api.rs':
        '#[get("/generated")]\nfn generated() {}\n#[derive(Queryable)]\nstruct Generated { id: i32 }\n',
    });
    const scoped: RustProfile = {
      ...profile,
      substrate: { language: 'rust', include: ['**/*.rs'], exclude: ['generated/**'] },
    };

    expect(rustSourceSignals(root, scoped)).toMatchObject({ http: 1, entities: 1 });
  });
});
