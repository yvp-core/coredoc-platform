/**
 * Referential integrity of the Rust substrate (audit gap G1-rust).
 *
 * The wave-2 integrity validator measured 457 dangling references out of the Rust target on
 * PostHog: 435 `functions.classId` (methods on enums, on structs declared in another module, on
 * traits with default bodies, and on non-nominal impl targets) plus 22 `entities.fileId` (sqlx
 * DDL entities pointing at `.sql` migrations that were never emitted as FileNodes).
 *
 * This fixture reproduces every one of those shapes in miniature and asserts the validator — the
 * same one `run.ts` / `merge.ts` apply at write time — reports a CLEAN graph.
 */
import { rustProvider } from '../../providers/rust.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import type { RustProfile } from '../../types.js';

const FILES: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',

  'src/lib.rs': `
pub mod db;
pub mod emit;
pub mod error;
pub mod sink;
pub mod wiring;
`,

  // An `impl` on an ENUM — the largest dangling class (103/198 distinct ids on PostHog).
  'src/error.rs': `
pub enum ClientError {
    NotFound,
    Timeout,
}

impl ClientError {
    pub fn code(&self) -> u16 { 404 }
    pub fn message(&self) -> String { String::new() }
}
`,

  // A trait with a DEFAULT-BODIED method beside a signature-only one, plus a struct implementing it.
  'src/sink.rs': `
pub trait Sink {
    fn name(&self) -> String;
    fn describe(&self) -> String { String::new() }
}

pub struct KafkaSink { pub topic: String }

impl Sink for KafkaSink {
    fn name(&self) -> String { String::new() }
}
`,

  // An inherent `impl` in a DIFFERENT module from the struct declaration.
  'src/wiring.rs': `
use crate::sink::KafkaSink;

impl KafkaSink {
    pub fn flush(&self) -> u8 { 1 }
}
`,

  // Two non-nominal impl targets: a lifetime-annotated reference and a tuple.
  'src/emit.rs': `
pub struct StdoutEmitter;
pub struct InjectArgs;
pub struct UploadArgs;

pub trait Transaction<'a> {
    fn commit(&self) -> u8;
}

impl<'a> Transaction<'a> for &'a StdoutEmitter {
    fn commit(&self) -> u8 { 1 }
}

impl From<StdoutEmitter> for (InjectArgs, UploadArgs) {
    fn from(e: StdoutEmitter) -> Self { (InjectArgs, UploadArgs) }
}
`,

  // A sqlx call site whose entity comes from the migration DDL below.
  'src/db.rs': `
pub async fn load_person(id: i64) -> u8 {
    sqlx::query!("SELECT id FROM persons WHERE id = $1", id);
    1
}
`,

  'migrations/20250923000001_initial_persons_schema.sql': `-- initial persons schema
CREATE TABLE persons (
  id BIGSERIAL PRIMARY KEY,
  team_id INT NOT NULL
);
`,
};

const PROFILE: RustProfile = {
  parserId: 'rs-integrity',
  repoType: 'backend',
  substrate: { language: 'rust', include: ['**/*.rs'] },
};

const SQL_PATH = 'migrations/20250923000001_initial_persons_schema.sql';

describe('rust substrate — referential integrity', () => {
  let root: string;
  let repo: ParsedRepo;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rs-integrity-'));
    for (const [rel, src] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, src);
    }
    repo = await rustProvider.parse(PROFILE, { repoRoot: root, repoName: 'app' });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports zero dangling references and no stats dishonesty', () => {
    const report = checkReferentialIntegrity(repo);
    expect(report.violations.map((v) => `${v.ref}: ${v.count} (${v.samples.join(', ')})`)).toEqual([]);
    expect(report.danglingRefs).toBe(0);
    // Non-vacuous: the fixture really does exercise the two edges that used to break.
    expect(repo.functions.filter((f) => f.classId !== undefined).length).toBeGreaterThan(0);
    expect(repo.entities.some((e) => e.location.filePath === SQL_PATH)).toBe(true);
  });

  it('carries the db-op resolution record into ParseStats (BR-4)', () => {
    // The EXACT triple of this fixture: one sqlx site (`sqlx::query!("SELECT id FROM persons …")`)
    // bound to the entity the migration DDL declares, nothing out of scope. A `> 0` assertion
    // would still pass with a lost counter.
    expect(repo.stats.dbOpResolution).toEqual({ dbOpSites: 1, boundDbOps: 1, outOfScopeDbOps: 0 });
  });

  it('an enum with an impl block gets the class node its methods name', () => {
    const code = repo.functions.find((f) => f.name === 'code');
    const cls = repo.classes.find((c) => c.name === 'ClientError');
    expect(cls?.id).toBe(code?.classId);
    expect(cls?.methods).toEqual(repo.functions.filter((f) => f.classId === cls?.id).map((f) => f.id));
    // The EnumNode survives alongside it — the class is the method-bearing facet, not a replacement.
    expect(repo.enums.map((e) => e.name)).toContain('ClientError');
  });

  it('a trait with default-bodied methods gets a class node; a signature-only trait does not', () => {
    const describe = repo.functions.find((f) => f.name === 'describe');
    const sink = repo.classes.find((c) => c.name === 'Sink');
    expect(sink?.id).toBe(describe?.classId);
    expect(sink?.isAbstract).toBe(true);
    // `Transaction` declares only signatures — nothing references it, so no class is minted.
    expect(repo.classes.some((c) => c.name === 'Transaction')).toBe(false);
    expect(repo.interfaces.map((i) => i.name).sort()).toEqual(['Sink', 'Transaction']);
  });

  it('an impl in another module gets a class node at the impl site', () => {
    const flush = repo.functions.find((f) => f.name === 'flush');
    const cls = repo.classes.find((c) => c.id === flush?.classId);
    // Tier-B boundary: `classId` is keyed on the impl file, so the type appears once per impl file.
    expect(cls?.name).toBe('KafkaSink');
    expect(cls?.location.filePath).toBe('src/wiring.rs');
    expect(
      repo.classes
        .filter((c) => c.name === 'KafkaSink')
        .map((c) => c.location.filePath)
        .sort(),
    ).toEqual(['src/sink.rs', 'src/wiring.rs']);
  });

  it('a lifetime-reference impl target joins the struct it names; a tuple target has no class', () => {
    const commit = repo.functions.find((f) => f.name === 'commit');
    const stdout = repo.classes.find((c) => c.name === 'StdoutEmitter');
    expect(commit?.classId).toBe(stdout?.id);
    // `impl From<X> for (A, B)` names no nominal type — the method carries NO classId rather than
    // a fabricated one (the old `Args)` fragment).
    const from = repo.functions.find((f) => f.name === 'from');
    expect(from?.kind).toBe('method');
    expect(from?.classId).toBeUndefined();
    expect(repo.classes.map((c) => c.name)).not.toContain('UploadArgs)');
  });

  it('emits a FileNode for the .sql migration its entities point at', () => {
    const sql = repo.files.find((f) => f.path === SQL_PATH);
    expect(sql).toBeDefined();
    expect(sql?.language).toBe('sql');
    expect(sql?.extension).toBe('.sql');
    expect(repo.packages.map((p) => p.id)).toContain(sql?.packageId);
    expect(repo.entities.find((e) => e.location.filePath === SQL_PATH)?.fileId).toBe(sql?.id);
    // Stats count it as a parsed source, which is what keeps `stats.parsedFiles` honest.
    expect(repo.stats.parsedFiles).toBe(repo.files.length);
  });
});
