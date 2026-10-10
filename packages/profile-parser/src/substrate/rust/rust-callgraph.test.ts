import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { indexRustDefs, resolveRustCalls } from './rust-callgraph.js';
import type { RustCrate } from './rust-crates.js';
import { type RustFile } from './rust-cst.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

const ID = new StableIdGenerator('/demo', 'demo');
const CRATES: RustCrate[] = [
  { name: 'demo', path: '.', dependencies: new Set(), isWorkspaceRoot: false, isPackage: true },
];

async function rf(relPath: string, source: string): Promise<RustFile> {
  return { relPath, source, root: await parseSource('rust', source) };
}

/** Resolve calls over a file set and describe each edge as `provenance caller->callee`. */
async function edgesOf(files: RustFile[]): Promise<string[]> {
  const index = indexRustDefs(files, ID);
  return resolveRustCalls(files, index, ID, CRATES).calls.map((e) => {
    const caller = index.byId.get(e.callerId);
    const callee = index.byId.get(e.calleeId as string);
    return `${e.provenance} ${caller?.location.filePath}:${caller?.name}->${callee?.location.filePath}:${callee?.name}`;
  });
}

describe('indexRustDefs — a FunctionNode for every fn', () => {
  it('emits free fns, impl methods and trait methods with the right kind', async () => {
    const files = [
      await rf(
        'src/lib.rs',
        `
pub fn free() {}
pub struct Repo;
impl Repo {
    pub async fn load(&self) -> u8 { 1 }
}
trait Greeter {
    fn declared_only(&self);
    fn with_body(&self) -> u8 { 7 }
}
`,
      ),
    ];
    const nodes = [...indexRustDefs(files, ID).byId.values()];
    const byName = new Map(nodes.map((n) => [n.name, n]));
    expect(byName.get('free')?.kind).toBe('function');
    expect(byName.get('free')?.isExported).toBe(true);
    expect(byName.get('load')?.kind).toBe('method');
    expect(byName.get('load')?.isAsync).toBe(true);
    // A trait method WITH a default body is a real callable; one with only a signature is not
    // (the grammar makes it a `function_signature_item`) and surfaces as an interface member.
    expect(byName.get('with_body')?.kind).toBe('method');
    expect(byName.has('declared_only')).toBe(false);
    // Methods are scoped under their impl/trait type, so `classId` points at a real type node.
    expect(byName.get('load')?.classId).toBe(ID.classId('src/lib.rs', 'Repo'));
  });
});

describe('resolveRustCalls — rs-local', () => {
  it('resolves a bare call to a fn in the same file and module scope', async () => {
    const files = [await rf('src/lib.rs', 'fn helper() -> u8 { 1 }\nfn go() -> u8 { helper() }')];
    expect(await edgesOf(files)).toEqual(['rs-local src/lib.rs:go->src/lib.rs:helper']);
  });

  it('does NOT cross module scope inside one file', async () => {
    // A bare `helper()` inside `mod a` means `a::helper`, not the file-level one.
    const files = [
      await rf(
        'src/lib.rs',
        `
fn helper() -> u8 { 1 }
mod a {
    fn go() -> u8 { helper() }
}
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops a call whose name is shadowed by a local binding (a closure is a value in Rust)', async () => {
    const files = [
      await rf(
        'src/lib.rs',
        `
fn helper() -> u8 { 1 }
fn go() -> u8 {
    let helper = || 2u8;
    helper()
}
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops a call whose name is a parameter', async () => {
    const files = [await rf('src/lib.rs', 'fn helper() -> u8 { 1 }\nfn go(helper: fn() -> u8) -> u8 { helper() }')];
    expect(await edgesOf(files)).toEqual([]);
  });
});

describe('resolveRustCalls — rs-use and rs-path', () => {
  it('resolves an imported fn through the use table (rs-use)', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod util;\npub mod api;'),
      await rf('src/util.rs', 'pub fn helper() -> u8 { 1 }'),
      await rf('src/api.rs', 'use crate::util::helper;\npub fn serve() -> u8 { helper() }'),
    ];
    expect(await edgesOf(files)).toEqual(['rs-use src/api.rs:serve->src/util.rs:helper']);
  });

  it('resolves an explicit crate:: path with no `use` (rs-path)', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod util;\npub mod api;'),
      await rf('src/util.rs', 'pub fn helper() -> u8 { 1 }'),
      await rf('src/api.rs', 'pub fn serve() -> u8 { crate::util::helper() }'),
    ];
    expect(await edgesOf(files)).toEqual(['rs-path src/api.rs:serve->src/util.rs:helper']);
  });

  it('resolves an Anchor-style one-hop delegation into the instruction module', async () => {
    // Anchor instruction bodies delegate one hop; without this tier every contract entrypoint
    // would be a dead end one node deep — exactly what a demo would expose.
    const files = [
      await rf(
        'src/lib.rs',
        'pub mod instructions;\n#[program]\npub mod prog { use super::*; pub fn init(ctx: Context<I>) -> Result<()> { instructions::init(ctx) } }',
      ),
      await rf('src/instructions.rs', 'pub fn init(ctx: Context<I>) -> Result<()> { Ok(()) }'),
    ];
    const edges = await edgesOf(files);
    expect(edges).toContain('rs-use src/lib.rs:init->src/instructions.rs:init');
  });

  it('resolves a Type::assoc_fn path through the method index', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod env;\npub mod test;'),
      await rf('src/env.rs', 'pub struct Env;\nimpl Env { pub fn new() -> Self { Self } }'),
      await rf('src/test.rs', 'use crate::env::Env;\npub fn go() { Env::new(); }'),
    ];
    expect(await edgesOf(files)).toEqual(['rs-use src/test.rs:go->src/env.rs:new']);
  });

  it('resolves a turbofished call — `generic_function` sits between the call and its callee', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod util;\npub mod api;'),
      await rf('src/util.rs', 'pub fn decode<T>() -> u8 { 1 }'),
      await rf('src/api.rs', 'use crate::util::decode;\npub fn go() -> u8 { decode::<u8>() }'),
    ];
    expect(await edgesOf(files)).toEqual(['rs-use src/api.rs:go->src/util.rs:decode']);
  });

  it('leaves an external crate call unresolved rather than guessing', async () => {
    const files = [await rf('src/lib.rs', 'use serde_json::to_string;\nfn go() { to_string(); }')];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('never resolves a `mod::fn` path onto an inherent impl METHOD of the same name', async () => {
    // `crate::util::run` names a free fn in module `util` — it can never reach `Runner::run`.
    // Indexing every function_item by file+name makes that fabricated edge ship as `rs-path`,
    // the tier that claims the path was written out explicitly in source.
    const files = [
      await rf('src/lib.rs', 'mod util;\npub fn go() { crate::util::run(); }'),
      await rf('src/util.rs', 'pub struct Runner;\nimpl Runner { pub fn run(&self) {} }'),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('still resolves a `mod::fn` path onto a real free fn', async () => {
    const files = [
      await rf('src/lib.rs', 'mod util;\npub fn go() { crate::util::run(); }'),
      await rf('src/util.rs', 'pub struct Runner;\nimpl Runner { pub fn other(&self) {} }\npub fn run() {}'),
    ];
    expect(await edgesOf(files)).toEqual(['rs-path src/lib.rs:go->src/util.rs:run']);
  });
});

describe('resolveRustCalls — rs-self', () => {
  it('resolves self.m() and Self::m() to the enclosing impl’s methods', async () => {
    const files = [
      await rf(
        'src/lib.rs',
        `
pub struct Repo;
impl Repo {
    fn helper(&self) -> u8 { 1 }
    fn build() -> Self { Repo }
    fn go(&self) -> u8 { self.helper() }
    fn make() -> Self { Self::build() }
}
`,
      ),
    ];
    const edges = await edgesOf(files);
    expect(edges).toContain('rs-self src/lib.rs:go->src/lib.rs:helper');
    expect(edges).toContain('rs-self src/lib.rs:make->src/lib.rs:build');
  });

  it('never crosses a file boundary for two same-named types', async () => {
    // The method index is file-qualified: two files each with `impl Svc` must resolve
    // `self.helper()` within their OWN file.
    const src = `
pub struct Svc;
impl Svc {
    fn helper(&self) -> u8 { 1 }
    fn run(&self) -> u8 { self.helper() }
}
`;
    const files = [await rf('src/a.rs', src), await rf('src/b.rs', src)];
    const index = indexRustDefs(files, ID);
    const byId = index.byId;
    for (const e of resolveRustCalls(files, index, ID, CRATES).calls) {
      expect(byId.get(e.callerId)?.location.filePath).toBe(byId.get(e.calleeId as string)?.location.filePath);
    }
    expect(resolveRustCalls(files, index, ID, CRATES).calls).toHaveLength(2);
  });

  it('does not resolve an arbitrary receiver’s method call (needs type inference)', async () => {
    const files = [
      await rf(
        'src/lib.rs',
        'pub struct Repo;\nimpl Repo { fn helper(&self) -> u8 { 1 } }\nfn go(r: Repo) -> u8 { r.helper() }',
      ),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });
});

describe('resolveRustCalls — shipping policy', () => {
  it('drops self-edges (a recursive fn is not its own caller)', async () => {
    const files = [await rf('src/lib.rs', 'fn go(n: u8) -> u8 { if n == 0 { 0 } else { go(n - 1) } }')];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('every shipped edge carries a provenance from the shippable set', async () => {
    const files = [
      await rf('src/lib.rs', 'pub mod util;'),
      await rf('src/util.rs', 'pub fn a() {}\npub fn b() { a(); }'),
    ];
    const index = indexRustDefs(files, ID);
    for (const e of resolveRustCalls(files, index, ID, CRATES).calls) {
      expect(['rs-path', 'rs-use', 'rs-self', 'rs-local']).toContain(e.provenance);
    }
  });
});

describe('resolveRustCalls — call-resolution stats (BR-1, BR-2, LIM-6)', () => {
  const src = (repoFrom: string) => `
pub fn helper() {}
${repoFrom}
pub struct Repo;
impl Repo {
    pub fn load(&self) {}
    pub fn run(&self, other: &Repo) {
        helper();
        self.load();
        other.load();
        String::from("x");
    }
}
`;

  it('counts enumerated sites, shipped sites and sites naming nothing declared here', async () => {
    const files = [await rf('src/lib.rs', src(''))];
    const res = resolveRustCalls(files, indexRustDefs(files, ID), ID, CRATES);
    // Four enumerated sites: `helper()` and `self.load()` ship, `String::from` names nothing
    // declared here, and `other.load()` names a real method this substrate cannot bind.
    expect(res.stats).toEqual({ callSites: 4, resolvedCalls: 2, outOfScopeCalls: 1 });
    expect(res.stats.resolvedCalls + res.stats.outOfScopeCalls).toBeLessThanOrEqual(res.stats.callSites);
    expect(res.calls).toHaveLength(2);
    expect(res.calls.some((e) => e.calleeExpression.includes('String::from'))).toBe(false);
  });

  it('keeps a platform call whose name IS declared in this repo in scope (BR-1 collision)', async () => {
    const files = [await rf('src/lib.rs', src('\npub fn from() {}\n'))];
    const res = resolveRustCalls(files, indexRustDefs(files, ID), ID, CRATES);
    expect(res.stats).toEqual({ callSites: 4, resolvedCalls: 2, outOfScopeCalls: 0 });
  });

  it('must NOT count a module-scope call site — a `static` initializer has no caller node (LIM-6)', async () => {
    // `static SEED: u8 = helper();` is a real call, but it belongs to no fn this substrate
    // emits, so it can never resolve. Counting it would grow the denominator with a site the
    // extractor was never able to answer for. The in-fn sibling still counts.
    const files = [
      await rf(
        'src/lib.rs',
        `
pub const fn helper() -> u8 { 1 }
pub static SEED: u8 = helper();
pub fn run() { helper(); }
`,
      ),
    ];
    const res = resolveRustCalls(files, indexRustDefs(files, ID), ID, CRATES);
    expect(res.stats).toEqual({ callSites: 1, resolvedCalls: 1, outOfScopeCalls: 0 });
  });
});
