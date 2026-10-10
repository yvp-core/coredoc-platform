import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import {
  FIELD_DECLARATION,
  FUNC_LITERAL,
  METHOD_DECLARATION,
  type TsNode,
  baseTypeName,
  discoverGoFileScope,
  enclosingFunction,
  fieldNames,
  goDeclName,
  goFunctionId,
  goScopeChain,
  goStringValue,
  isExported,
  itemName,
  packageName,
  receiverTypeName,
  structTags,
} from './go-cst.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

/** Same seed the parser uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');

/** All function-ish declarations in document order. */
async function decls(source: string): Promise<TsNode[]> {
  const root = await parseSource('go', source);
  return [
    ...(root.descendantsOfType('function_declaration') as TsNode[]),
    ...(root.descendantsOfType('method_declaration') as TsNode[]),
    ...(root.descendantsOfType(FUNC_LITERAL) as TsNode[]),
  ];
}

describe('goStringValue — Go string literals have NO string_content child', () => {
  // Trap 1: `interpreted_string_literal.namedChildCount === 0` (only `escape_sequence` children
  // ever appear), so the Python idiom `descendantsOfType('string_content')[0]?.text` returns '' for
  // every Go string with no error — empty route paths, empty table names, empty SQL.
  it('strips the quotes and never returns the empty-string artefact', async () => {
    const root = await parseSource('go', 'package p\nfunc f() { a := "/users/{id}"; b := "table_name"; _, _ = a, b }');
    const values = (root.descendantsOfType('interpreted_string_literal') as TsNode[]).map(goStringValue);
    expect(values).toEqual(['/users/{id}', 'table_name']);
    // The trap itself, asserted so a grammar bump that "fixes" it is noticed.
    expect(root.descendantsOfType('string_content')).toEqual([]);
  });

  it('decodes the common escapes in an interpreted literal', async () => {
    const src = ['package p', 'func f() {', '  a := "line\\nnext"', '  b := "say \\"hi\\""', '  _, _ = a, b', '}'];
    const root = await parseSource('go', src.join('\n'));
    const values = (root.descendantsOfType('interpreted_string_literal') as TsNode[]).map(goStringValue);
    expect(values).toEqual(['line\nnext', 'say "hi"']);
  });

  it('does NOT process escapes in a raw literal — that is Go’s actual semantics', async () => {
    const root = await parseSource('go', 'package p\nfunc f() { q := `SELECT *\\nFROM users`; _ = q }');
    const raw = (root.descendantsOfType('raw_string_literal') as TsNode[])[0];
    expect(goStringValue(raw)).toBe('SELECT *\\nFROM users');
  });
});

describe('itemName / receiverTypeName — a method name is a field_identifier', () => {
  // Trap 2: in `func (s *Svc) Handle()` the first `identifier` descendant is the RECEIVER VARIABLE.
  const SRC = `package svc

type Svc struct{}

func (s *Svc) Handle() {}
func (s Svc) Close() {}
func Plain() {}
`;

  it('names the method, not its receiver variable', async () => {
    const root = await parseSource('go', SRC);
    const method = (root.descendantsOfType(METHOD_DECLARATION) as TsNode[])[0];
    expect(itemName(method)).toBe('Handle');
    // The trap, asserted: the naive descendant scan yields the receiver variable.
    expect((method.descendantsOfType('identifier') as TsNode[])[0].text).toBe('s');
  });

  it('collapses pointer and value receivers onto the same type name', async () => {
    const root = await parseSource('go', SRC);
    const methods = root.descendantsOfType(METHOD_DECLARATION) as TsNode[];
    expect(methods.map(receiverTypeName)).toEqual(['Svc', 'Svc']);
  });

  it('reads a generic receiver through its type arguments', async () => {
    const root = await parseSource('go', 'package p\nfunc (r *Repo[T]) Get() {}');
    const method = (root.descendantsOfType(METHOD_DECLARATION) as TsNode[])[0];
    expect(receiverTypeName(method)).toBe('Repo');
  });
});

describe('baseTypeName', () => {
  it('strips pointers, collections, channels, generics and the package qualifier', () => {
    expect(baseTypeName('*User')).toBe('User');
    expect(baseTypeName('[]*db.User')).toBe('User');
    expect(baseTypeName('map[string]*User')).toBe('User');
    expect(baseTypeName('[4]User')).toBe('User');
    expect(baseTypeName('...User')).toBe('User');
    expect(baseTypeName('chan *Msg')).toBe('Msg');
    expect(baseTypeName('Repo[T]')).toBe('Repo');
    expect(baseTypeName(undefined)).toBeUndefined();
    expect(baseTypeName('')).toBeUndefined();
  });
});

describe('isExported / packageName', () => {
  it('applies Go’s capital-letter visibility rule', () => {
    expect(isExported('Handler')).toBe(true);
    expect(isExported('handler')).toBe(false);
    expect(isExported('_private')).toBe(false);
    expect(isExported('Ünicode')).toBe(true);
    expect(isExported(undefined)).toBe(false);
  });

  it('reads the declared package name', async () => {
    const file = { relPath: 'internal/db/store.go', source: '', root: await parseSource('go', 'package db\n') };
    expect(packageName(file)).toBe('db');
  });
});

describe('fieldNames — childForFieldName("name") returns only the FIRST', () => {
  const SRC = `package p

type User struct {
  ID   int
  a, b int
  Embedded
}
`;

  it('returns every name in a grouped declaration and none for an embedded field', async () => {
    const root = await parseSource('go', SRC);
    const fields = root.descendantsOfType(FIELD_DECLARATION) as TsNode[];
    expect(fields.map(fieldNames)).toEqual([['ID'], ['a', 'b'], []]);
    // The trap: the `name` field alone loses `b` and cannot tell an embedded field from an unnamed one.
    expect(fields.map(itemName)).toEqual(['ID', 'a', undefined]);
  });
});

describe('structTags', () => {
  it('parses a multi-key tag down to each value’s first comma segment', async () => {
    const src = ['package p', 'type User struct {', '  ID int `json:"id,omitempty" db:"id" gorm:"primaryKey"`', '}'];
    const root = await parseSource('go', src.join('\n'));
    const field = (root.descendantsOfType(FIELD_DECLARATION) as TsNode[])[0];
    expect([...structTags(field)]).toEqual([
      ['json', 'id'],
      ['db', 'id'],
      ['gorm', 'primaryKey'],
    ]);
  });

  it('keeps a bare "-" and an empty name as written', async () => {
    const src = [
      'package p',
      'type User struct {',
      '  Secret string `json:"-"`',
      '  Opt    string `json:",omitempty"`',
      '}',
    ];
    const root = await parseSource('go', src.join('\n'));
    const fields = root.descendantsOfType(FIELD_DECLARATION) as TsNode[];
    expect(structTags(fields[0]).get('json')).toBe('-');
    expect(structTags(fields[1]).get('json')).toBe('');
  });

  it('reads the interpreted-string spelling of a tag, which generated code emits', async () => {
    const src = ['package p', 'type User struct {', '  ID int "json:\\"id\\""', '}'];
    const root = await parseSource('go', src.join('\n'));
    const field = (root.descendantsOfType(FIELD_DECLARATION) as TsNode[])[0];
    expect(structTags(field).get('json')).toBe('id');
  });

  it('stops at a malformed pair instead of inventing a key, and is empty for an untagged field', async () => {
    const src = ['package p', 'type User struct {', '  ID   int `json:"id" broken db:"x"`', '  Name string', '}'];
    const root = await parseSource('go', src.join('\n'));
    const fields = root.descendantsOfType(FIELD_DECLARATION) as TsNode[];
    expect([...structTags(fields[0]).keys()]).toEqual(['json']);
    expect(structTags(fields[1]).size).toBe(0);
  });
});

describe('goFunctionId — keyed on the enclosing scope chain', () => {
  // Go hangs the same method name off every type in a file and permits several `init` per file; a
  // flat file+name id would merge them onto one node and corrupt the call graph.
  const SRC = `package svc

func Get() {}

func (a *Alpha) Get() {}

func (b Beta) Get() {}

func outer() {
  inner := func() {}
  inner()
}
`;

  it('gives distinct ids to three same-named Get declarations', async () => {
    const all = await decls(SRC);
    const gets = all.filter((d) => goDeclName(d) === 'Get');
    const ids = gets.map((d) => goFunctionId(ID, 'svc/svc.go', d));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('scopes a method under its receiver type and a free function under the file', async () => {
    const all = await decls(SRC);
    const free = all.find((d) => d.type === 'function_declaration' && itemName(d) === 'Get') as TsNode;
    const method = all.find((d) => d.type === METHOD_DECLARATION && receiverTypeName(d) === 'Alpha') as TsNode;
    expect(goFunctionId(ID, 'svc/svc.go', free)).toBe(ID.functionId('svc/svc.go', 'Get'));
    expect(goFunctionId(ID, 'svc/svc.go', method)).toBe(ID.methodId('svc/svc.go', 'Alpha', 'Get'));
  });

  it('names a bound closure after its variable and scopes it under the enclosing function', async () => {
    const all = await decls(SRC);
    const closure = all.find((d) => d.type === FUNC_LITERAL) as TsNode;
    expect(goDeclName(closure)).toBe('inner');
    expect(goScopeChain(closure)).toEqual(['outer']);
    expect(goFunctionId(ID, 'svc/svc.go', closure)).toBe(ID.methodId('svc/svc.go', 'outer', 'inner'));
  });

  it('scopes a closure inside a method under receiver AND method', async () => {
    const src = 'package p\nfunc (s *Svc) Handle() {\n  h := func() {}\n  h()\n}\n';
    const closure = (await decls(src)).find((d) => d.type === FUNC_LITERAL) as TsNode;
    expect(goScopeChain(closure)).toEqual(['Svc', 'Handle']);
    expect(goFunctionId(ID, 'a.go', closure)).toBe(ID.methodId('a.go', 'Svc.Handle', 'h'));
  });

  it('falls back to (anonymous) for a truly inline closure', async () => {
    const src = 'package p\nfunc setup() { http.HandleFunc("/x", func() {}) }\n';
    const closure = (await decls(src)).find((d) => d.type === FUNC_LITERAL) as TsNode;
    expect(goDeclName(closure)).toBe('(anonymous)');
    expect(goFunctionId(ID, 'a.go', closure)).toBe(ID.methodId('a.go', 'setup', '(anonymous)'));
  });

  it('pairs a closure with the RIGHT target in a multi-value binding', async () => {
    const src = 'package p\nfunc f() {\n  a, h := 1, func() {}\n  _, _ = a, h\n}\n';
    const closure = (await decls(src)).find((d) => d.type === FUNC_LITERAL) as TsNode;
    expect(goDeclName(closure)).toBe('h');
  });

  it('names a package-level `var h = func(){}` closure after its var', async () => {
    const src = 'package p\nvar h = func() {}\n';
    const closure = (await decls(src)).find((d) => d.type === FUNC_LITERAL) as TsNode;
    expect(goDeclName(closure)).toBe('h');
    expect(goFunctionId(ID, 'a.go', closure)).toBe(ID.functionId('a.go', 'h'));
  });
});

describe('enclosingFunction', () => {
  it('attributes a call to its method, and reports NO owner at package scope', async () => {
    const src = 'package p\n\nvar router = chi.NewRouter()\n\nfunc (s *Svc) Handle() { s.log() }\n';
    const root = await parseSource('go', src);
    const calls = root.descendantsOfType('call_expression') as TsNode[];
    const inMethod = calls.find((c) => c.text === 's.log()') as TsNode;
    const atPackageScope = calls.find((c) => c.text === 'chi.NewRouter()') as TsNode;
    expect(itemName(enclosingFunction(inMethod))).toBe('Handle');
    // Go really does run package-level initializers with no enclosing function — the caller must
    // attribute them to the file rather than assume one is always there.
    expect(enclosingFunction(atPackageScope)).toBeUndefined();
  });
});

describe('discoverGoFileScope — built-in default excludes', () => {
  // `vendor/` is NOT in the shared enumerator's ignore floor, so this is the only thing keeping a
  // vendored dependency tree out of scope.
  it('excludes vendor/testdata/_test.go/.pb.go by default, and honors the opt-out', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { dirname, join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'go-discovery-'));
    const files = [
      'main.go',
      'internal/db/store.go',
      'internal/db/store_test.go',
      'api/user.pb.go',
      'api/user_grpc.pb.go',
      'vendor/github.com/x/y/lib.go',
      'testdata/fixture.go',
    ];
    for (const rel of files) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, 'package p\n');
    }
    try {
      expect(discoverGoFileScope(root, ['**/*.go']).included).toEqual(['internal/db/store.go', 'main.go']);
      expect(discoverGoFileScope(root, ['**/*.go'], [], false).included).toContain('internal/db/store_test.go');
      // An empty include defaults to every .go file, so a bare profile still extracts.
      expect(discoverGoFileScope(root, []).included).toEqual(['internal/db/store.go', 'main.go']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
