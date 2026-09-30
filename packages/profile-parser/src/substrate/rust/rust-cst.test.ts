import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import {
  type TsNode,
  attributeKeyValue,
  attributeName,
  attributeStringArgs,
  attributesOf,
  deriveMacros,
  discoverRustFiles,
  hasAttribute,
  implTypeName,
  isAsyncFn,
  itemName,
  parseRust,
  rustFunctionId,
  rustScopeChain,
  rustStringValue,
} from './rust-cst.js';

/** Same seed the parser uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');

/** All `function_item` nodes in document order. */
async function fns(source: string): Promise<TsNode[]> {
  const root = await parseRust(source);
  return root.descendantsOfType('function_item') as TsNode[];
}

async function fnNamed(source: string, name: string): Promise<TsNode> {
  const found = (await fns(source)).find((f) => itemName(f) === name);
  if (!found) throw new Error(`no fn ${name}`);
  return found;
}

describe('attributesOf — attributes are preceding SIBLINGS, and comments interleave', () => {
  // Trap 1 + 2: Rust does not wrap a decorated item the way Python's `decorated_definition`
  // does, and doc comments sit BETWEEN the attributes. A walk that stops at the first
  // non-attribute sibling loses every doc-commented handler — which is most of them.
  const SRC = `
#[derive(Debug, Clone)]
/// docs for the handler
#[get("/a")]
// an ordinary comment
pub fn handler() -> String { String::new() }

pub fn plain() {}
`;

  it('collects attributes across interleaved comments, in source order', async () => {
    const handler = await fnNamed(SRC, 'handler');
    expect(attributesOf(handler).map(attributeName)).toEqual(['derive', 'get']);
  });

  it('does not leak the previous item’s attributes onto the next item', async () => {
    const plain = await fnNamed(SRC, 'plain');
    expect(attributesOf(plain)).toEqual([]);
  });

  it('reads positional string args and derive lists off the attribute', async () => {
    const handler = await fnNamed(SRC, 'handler');
    const get = attributesOf(handler).find((a) => attributeName(a) === 'get') as TsNode;
    expect(attributeStringArgs(get)).toEqual(['/a']);
    expect(deriveMacros(handler)).toEqual(['Debug', 'Clone']);
  });
});

describe('attributeMatches — cfg_attr is the real CosmWasm shape', () => {
  // Trap 12: `#[cfg_attr(not(feature = "library"), entry_point)]` is what real contracts write.
  // A bare path match on `entry_point` silently misses the majority of them.
  const SRC = `
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate() {}

#[entry_point]
pub fn execute() {}

#[cfg_attr(test, derive(Debug))]
pub fn unrelated() {}
`;

  it('matches a name nested inside a cfg_attr token tree', async () => {
    expect(hasAttribute(await fnNamed(SRC, 'instantiate'), ['entry_point'])).toBe(true);
  });

  it('still matches the bare form', async () => {
    expect(hasAttribute(await fnNamed(SRC, 'execute'), ['entry_point'])).toBe(true);
  });

  it('does not match a cfg_attr that mentions something else', async () => {
    expect(hasAttribute(await fnNamed(SRC, 'unrelated'), ['entry_point'])).toBe(false);
  });
});

describe('rustStringValue — Rust string literals have NO string_content child', () => {
  // Trap 3: the Python idiom `descendantsOfType('string_content')[0]?.text` returns '' for every
  // Rust string with no error — empty route paths, empty table names, empty SQL.
  it('strips quotes from plain, raw and hashed-raw literals', async () => {
    const root = await parseRust('fn f() { let a = "hello"; let b = r"raw"; let c = r#"has "quotes""#; }');
    const values = (root.descendantsOfType('string_literal') as TsNode[])
      .concat(root.descendantsOfType('raw_string_literal') as TsNode[])
      .map((n) => rustStringValue(n));
    expect(values).toContain('hello');
    expect(values).toContain('raw');
    expect(values).toContain('has "quotes"');
    expect(values.every((v) => v !== '')).toBe(true);
  });

  it('reads a key = "value" tail out of a token tree without parsing it structurally', async () => {
    const root = await parseRust('#[sea_orm(table_name = "users")]\npub struct Model { pub id: i32 }');
    const structNode = (root.descendantsOfType('struct_item') as TsNode[])[0];
    const attr = attributesOf(structNode)[0];
    expect(attributeKeyValue(attr, 'table_name')).toBe('users');
  });

  it('reads an UNQUOTED key = value tail (diesel writes the table name bare)', async () => {
    const root = await parseRust('#[diesel(table_name = users)]\npub struct User { pub id: i32 }');
    const structNode = (root.descendantsOfType('struct_item') as TsNode[])[0];
    expect(attributeKeyValue(attributesOf(structNode)[0], 'table_name')).toBe('users');
  });
});

describe('rustFunctionId — full enclosing scope chain', () => {
  // Rust puts same-named methods (`new`, `handle`) on every type in a file; a flat file+name id
  // would collapse them onto one node and corrupt the call graph.
  const SRC = `
pub fn new() -> u8 { 1 }

impl Alpha {
    pub fn new() -> Self { Self {} }
}

impl Beta {
    pub fn new() -> Self { Self {} }
}

pub mod inner {
    pub fn new() -> u8 { 2 }
}
`;

  it('gives four distinct ids to four same-named `new` fns', async () => {
    const ids = (await fns(SRC)).map((f) => rustFunctionId(ID, 'src/lib.rs', f));
    expect(new Set(ids).size).toBe(4);
  });

  it('scopes methods under their impl target type and fns under their mod', async () => {
    const all = await fns(SRC);
    const chains = all.map((f) => rustScopeChain(f));
    expect(chains).toContainEqual(['Alpha']);
    expect(chains).toContainEqual(['Beta']);
    expect(chains).toContainEqual(['inner']);
    expect(chains).toContainEqual([]);
  });

  it('reads the impl target type through generics and trait impls', async () => {
    const root = await parseRust("impl<'a, T> Greeter for Server<T> { fn go(&self) {} }");
    expect(implTypeName((root.descendantsOfType('impl_item') as TsNode[])[0])).toBe('Server');
  });
});

describe('isAsyncFn', () => {
  it('distinguishes async from sync fns', async () => {
    const all = await fns('async fn a() {}\nfn b() {}');
    expect(all.map(isAsyncFn)).toEqual([true, false]);
  });
});

describe('discoverRustFiles — built-in default excludes', () => {
  // `target/` is NOT in the shared enumerator's ignore floor, so this is the only thing keeping
  // a built workspace's artifacts out of scope.
  it('excludes target/vendor/tests/benches/examples/build.rs by default, and honors the opt-out', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { dirname, join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'rs-discovery-'));
    const files = [
      'src/lib.rs',
      'src/db/models.rs',
      'build.rs',
      'target/debug/gen.rs',
      'vendor/other/src/lib.rs',
      'tests/integration.rs',
      'benches/bench.rs',
      'examples/demo.rs',
    ];
    for (const rel of files) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, 'fn f() {}');
    }
    try {
      expect(discoverRustFiles(root, ['**/*.rs'])).toEqual(['src/db/models.rs', 'src/lib.rs']);
      expect(discoverRustFiles(root, ['**/*.rs'], [], false)).toContain('tests/integration.rs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
