/**
 * Tests for the Go local type environment.
 *
 * This module decides which methods the ENTIRE Go graph can attach — a route's handler and every
 * non-receiver method call both come through `resolveOperand` — so the tests are written as matched
 * pairs: a decidable shape must answer with a (name, PACKAGE DIRECTORY), and the neighbouring
 * undecidable one must answer `unresolved` rather than the plausible-looking type sitting next to
 * it. Nearly every fixture therefore plants a same-named decoy type in the CALLING package, because
 * an environment keyed on the calling file's directory passes a vacuous test and mis-attributes the
 * whole router in a real repo.
 *
 * The third answer, `unbound`, has its own tests: it is what lets a caller re-read `db.Load()` as a
 * package qualifier, and answering it where a real variable is bound is how a shadowed import
 * fabricates an edge.
 */
import { describe, expect, it } from 'vitest';
import { type GoFile, SELECTOR_EXPRESSION, type TsNode, parseGo } from './go-cst.js';
import { buildPackageIndex } from './go-imports.js';
import type { GoModule } from './go-modules.js';
import { type GoTypeEnv, buildGoTypeEnv } from './go-types.js';

const MODULES: GoModule[] = [
  {
    modulePath: 'github.com/acme/api',
    path: '.',
    manifestFile: 'go.mod',
    dependencies: new Set<string>(),
    isWorkspace: false,
  },
];

async function gf(relPath: string, source: string): Promise<GoFile> {
  return { relPath, source, root: await parseGo(source) };
}

function envOf(files: GoFile[]): GoTypeEnv {
  return buildGoTypeEnv(files, buildPackageIndex(files, MODULES));
}

/**
 * The operand of the `nth` `selector_expression` spelled exactly `expr` — `h.GetMe` → the `h` node.
 *
 * Selecting by the WHOLE selector text keeps a fixture's nested selectors apart (`s.dep.Work` and
 * `s.dep` are two distinct nodes), and `nth` is what makes a shadowing fixture testable: the same
 * `d.Work()` appears once per scope.
 */
function operandOf(file: GoFile, expr: string, nth = 0): TsNode {
  const hits = (file.root.descendantsOfType(SELECTOR_EXPRESSION) as TsNode[]).filter((n) => n.text === expr);
  const node = hits[nth]?.childForFieldName?.('operand') as TsNode | undefined;
  if (!node) throw new Error(`no selector ${expr}#${nth} in ${file.relPath}`);
  return node;
}

/** What the environment says the operand of `expr` holds: `dir#Name`, or the gap kind it answered. */
function typeOf(env: GoTypeEnv, file: GoFile, expr: string, nth = 0): string {
  const answer = env.resolveOperand(operandOf(file, expr, nth), file);
  return answer.kind === 'type' ? `${answer.type.dir}#${answer.type.name}` : answer.kind;
}

describe('buildGoTypeEnv — the decidable binding shapes', () => {
  it('types a PARAMETER and a method RECEIVER off the enclosing signature', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

type Dep struct{}
type Svc struct{}

func FromParam(d *Dep) int { return d.Work() }

func (s *Svc) FromReceiver() int { return s.Work() }
`,
    );
    const env = envOf([file]);
    expect(typeOf(env, file, 'd.Work')).toBe('svc#Dep');
    // A receiver is just a `parameter_declaration` to this module, which is why the entrypoint lane
    // gets `s.ListUsers` for free from the same code path as `h.GetMe`.
    expect(typeOf(env, file, 's.Work')).toBe('svc#Svc');
  });

  it('types a composite literal, through the address-of and the parens that wrap it', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

type Dep struct{}

func Run() {
	a := Dep{}
	b := &Dep{}
	c := (&Dep{})
	_, _, _ = a.Work(), b.Work(), c.Work()
}
`,
    );
    const env = envOf([file]);
    // `&T{}` and `(&T{})` name the same type as `T{}` — taking an address is not a type change.
    expect(typeOf(env, file, 'a.Work')).toBe('svc#Dep');
    expect(typeOf(env, file, 'b.Work')).toBe('svc#Dep');
    expect(typeOf(env, file, 'c.Work')).toBe('svc#Dep');
  });

  it('resolves a QUALIFIED composite literal through the importing file`s table', async () => {
    const files = [
      await gf('internal/dep/dep.go', 'package dep\n\ntype Dep struct{}\n'),
      await gf(
        'cmd/server/main.go',
        `package main

import d "github.com/acme/api/internal/dep"

// A same-named type in the CALLING package — an environment that resolved unqualified would
// answer with this one.
type Dep struct{}

func run() {
	x := d.Dep{}
	_ = x.Work()
}
`,
      ),
    ];
    const env = envOf(files);
    // The alias `d`, not the last path segment, is what the file spells — resolved through the
    // import table rather than guessed from the type text.
    expect(typeOf(env, files[1], 'x.Work')).toBe('internal/dep#Dep');
  });

  it('reads a constructor`s DECLARED result in the package that declares the type', async () => {
    // The router shape, and the reason the whole module exists: `New` is written in
    // `internal/handler`, so `*Handler` names THAT package's type even though the := is in `main`.
    const files = [
      await gf(
        'internal/handler/handler.go',
        `package handler

type Handler struct{}

func New() *Handler { return &Handler{} }
`,
      ),
      await gf(
        'cmd/server/main.go',
        `package main

import "github.com/acme/api/internal/handler"

// The decoy: resolving the result type against the CALLING file's directory finds this.
type Handler struct{}

func run() {
	h := handler.New()
	_ = h.GetMe()
}
`,
      ),
    ];
    expect(typeOf(envOf(files), files[1], 'h.GetMe')).toBe('internal/handler#Handler');
  });

  it('reads the RESULT, never the constructor`s name', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

type Dep struct{}
type Other struct{}

// Named like a constructor for Dep, declared to return Other. The declaration wins.
func NewDep() *Other { return nil }

func Run() {
	d := NewDep()
	_ = d.Work()
}
`,
    );
    expect(typeOf(envOf([file]), file, 'd.Work')).toBe('svc#Other');
  });

  it('reads the right SLOT of a multi-value constructor, and refuses a non-call multi-value', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

type Dep struct{}
type Other struct{}

func Open() (*Dep, *Other) { return nil, nil }

func Run(m map[string]Dep) {
	a, b := Open()
	v, ok := m["k"]
	_, _, _, _ = a.Work(), b.Work(), v.Work(), ok
}
`,
    );
    const env = envOf([file]);
    // A `parameter_list` result is positional, which is exactly what makes `x, err := New()` decidable.
    expect(typeOf(env, file, 'a.Work')).toBe('svc#Dep');
    expect(typeOf(env, file, 'b.Work')).toBe('svc#Other');
    // The comma-ok form has no declared result slots to read — `m[k]`/`x.(T)` are not calls.
    expect(typeOf(env, file, 'v.Work')).toBe('unresolved');
  });

  it('chains through a METHOD result', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

type App struct{}
type Store struct{}

func NewApp() *App { return nil }

func (a *App) Store() *Store { return nil }

func Run() {
	app := NewApp()
	st := app.Store()
	_ = st.Load()
}
`,
    );
    expect(typeOf(envOf([file]), file, 'st.Load')).toBe('svc#Store');
  });

  it('reads an explicit `var` type at function scope and at PACKAGE scope across files', async () => {
    const files = [
      await gf(
        'svc/a.go',
        `package svc

type Dep struct{}

var shared *Dep
`,
      ),
      await gf(
        'svc/b.go',
        `package svc

func FromVar() int {
	var local *Dep
	return local.Work()
}

func FromPackageVar() int { return shared.Work() }
`,
      ),
    ];
    const env = envOf(files);
    expect(typeOf(env, files[1], 'local.Work')).toBe('svc#Dep');
    // A package-scope var is visible to every FILE of the directory, and Go permits the forward
    // reference — so it is a package lookup, not part of the position-ordered scope walk.
    expect(typeOf(env, files[1], 'shared.Work')).toBe('svc#Dep');
  });

  it('reads a struct FIELD`s type in the package that declares the STRUCT', async () => {
    const files = [
      await gf('internal/dep/dep.go', 'package dep\n\ntype Dep struct{}\n'),
      await gf(
        'internal/svc/svc.go',
        `package svc

import "github.com/acme/api/internal/dep"

// Decoy again: the field is written *dep.Dep, and this package declares its own Dep.
type Dep struct{}

type Svc struct {
	inner *dep.Dep
}

func (s *Svc) Run() int { return s.inner.Work() }
`,
      ),
    ];
    // The field's type expression is resolved in the file that WROTE it, through that file's imports.
    expect(typeOf(envOf(files), files[1], 's.inner.Work')).toBe('internal/dep#Dep');
  });

  it('answers with the INTERFACE for an interface-typed field, leaving the drop to the consumer', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

type Notifier interface{ Notify() error }

type Email struct{}

func (e *Email) Notify() error { return nil }

type Svc struct {
	n Notifier
}

func (s *Svc) Run() error { return s.n.Notify() }
`,
    );
    // Not a gap here: the field really is declared `Notifier`. The precision comes downstream —
    // an interface's `method_spec`s have no bodies, so they are in no method index and dispatch
    // finds nothing to bind to. Answering the concrete `Email` instead would be the wrong edge.
    expect(typeOf(envOf([file]), file, 's.n.Notify')).toBe('svc#Notifier');
  });
});

describe('buildGoTypeEnv — what it refuses, and why', () => {
  it('answers UNBOUND for a free identifier so a caller may read it as a package qualifier', async () => {
    const files = [
      await gf('internal/db/db.go', 'package db\n\nfunc Load() int { return 1 }\n'),
      await gf(
        'cmd/main.go',
        `package main

import "github.com/acme/api/internal/db"

func run() int { return db.Load() }
`,
      ),
    ];
    // `unbound` is not `unresolved`: it is the signal that no VARIABLE named `db` exists here, which
    // is the only safe licence a consumer has to read the name as an import.
    expect(typeOf(envOf(files), files[1], 'db.Load')).toBe('unbound');
  });

  it('answers UNRESOLVED when a local func value shadows a package CONSTRUCTOR', async () => {
    // `x := New()` reads the package `New` only when nothing nearer binds the name. Both types
    // carry `Work`, which is the whole point: with a shared method name the mis-typing does not
    // dead-end at the consumer, it produces a confident edge to `A.Work` for a call that dispatches
    // to `B.Work` at runtime. A wrong edge is worse than a missing one, so this refuses.
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type A struct{}
type B struct{}

func (a *A) Work() int { return 1 }
func (b *B) Work() int { return 2 }

func New() *A { return &A{} }

func run() int {
	New := func() *B { return &B{} }
	x := New()
	return x.Work()
}
`,
      ),
    ];
    expect(typeOf(envOf(files), files[0], 'x.Work')).toBe('unresolved');
  });

  it('still types a package constructor when nothing shadows it', async () => {
    // Non-vacuous pair for the case above: same fixture minus the local binding must resolve, or
    // the refusal above would be indistinguishable from the inference simply not working.
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type A struct{}

func (a *A) Work() int { return 1 }

func New() *A { return &A{} }

func run() int {
	x := New()
	return x.Work()
}
`,
      ),
    ];
    expect(typeOf(envOf(files), files[0], 'x.Work')).toBe('svc#A');
  });

  it('answers UNRESOLVED when a PARAMETER shadows a package constructor', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type A struct{}

func (a *A) Work() int { return 1 }

func New() *A { return &A{} }

func run(New func() *A) int {
	x := New()
	return x.Work()
}
`,
      ),
    ];
    // Even where the shadow happens to produce the SAME type, the substrate has not established
    // that — the parameter's value is supplied by the caller. Answering `svc#A` here would be a
    // guess that only looks right in this fixture.
    expect(typeOf(envOf(files), files[0], 'x.Work')).toBe('unresolved');
  });

  it('answers UNRESOLVED for a local that shadows an import, never the import`s package', async () => {
    const files = [
      await gf('internal/db/db.go', 'package db\n\nfunc Load() int { return 1 }\n'),
      await gf(
        'svc/svc.go',
        `package svc

import "github.com/acme/api/internal/db"

func Run(db chan int) int { return db.Load() }
`,
      ),
    ];
    // Go's own scoping puts the parameter ahead of the file's imports. Collapsing this to `unbound`
    // would bind the call to `internal/db`.
    expect(typeOf(envOf(files), files[1], 'db.Load')).toBe('unresolved');
  });

  it('stops at the INNERMOST binding rather than falling through to a typed outer one', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

import "os"

type Dep struct{}

func Run(deps []Dep) {
	d := Dep{}
	_ = d.Work()
	{
		d := os.Getenv("X")
		_ = d.Work()
	}
	for _, d := range deps {
		_ = d.Work()
	}
	switch d := any(deps).(type) {
	case int:
		_ = d.Work()
	}
}
`,
    );
    const env = envOf([file]);
    // Source order: the outer `:=`, then the shadowing block, then the range element, then the
    // type-switch alias. Only the first is decidable, and the other three must NOT inherit it.
    expect(typeOf(env, file, 'd.Work', 0)).toBe('svc#Dep');
    expect(typeOf(env, file, 'd.Work', 1)).toBe('unresolved');
    expect(typeOf(env, file, 'd.Work', 2)).toBe('unresolved');
    expect(typeOf(env, file, 'd.Work', 3)).toBe('unresolved');
  });

  it('refuses a type declared OUTSIDE this repo', async () => {
    const file = await gf(
      'api/routes.go',
      `package api

import "github.com/go-chi/chi/v5"

// This package declares its OWN Router — a resolver that ignored the import's destination would
// hand chi's value this type and bind every router call to it.
type Router struct{}

func setup() {
	r := chi.NewRouter()
	r.Get("/x")
}
`,
    );
    // The package index maps import paths to repo DIRECTORIES; a third-party path maps to none, and
    // there is no declaration in reach to read a type off.
    expect(typeOf(envOf([file]), file, 'r.Get')).toBe('unresolved');
  });

  it('refuses an UNQUALIFIED type name in a file carrying a dot import', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

import . "math"

type Dep struct{}

func Run() {
	d := Dep{}
	_ = d.Work()
}
`,
    );
    // A dot import drops an unknowable set of names into the file, so `Dep` may not be this
    // package's `Dep` at all. Qualified spellings are unaffected — a dot import binds no qualifier.
    expect(typeOf(envOf([file]), file, 'd.Work')).toBe('unresolved');
  });

  it('refuses an AMBIGUOUS package-scope constructor rather than picking a winner', async () => {
    const files = [
      await gf('svc/a.go', 'package svc\n\ntype A struct{}\n\nfunc New() *A { return nil }\n'),
      // A second `New` in the same package (build tags produce this in real repos, and a collapsed
      // id produces it here). Two candidates means no answer.
      await gf(
        'svc/b.go',
        `package svc

type B struct{}

func New() *B { return nil }

func Run() {
	v := New()
	_ = v.Work()
}
`,
      ),
    ];
    expect(typeOf(envOf(files), files[1], 'v.Work')).toBe('unresolved');
  });

  it('refuses a member reached through an EMBEDDED struct instead of inventing a declaration', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

type Base struct {
	dep *Dep
}

type Dep struct{}

type Svc struct {
	Base
}

func (s *Svc) Run() int { return s.dep.Work() }
`,
    );
    // `dep` is promoted from `Base`; `Svc` declares no field of that name. Following promotion is
    // the documented gap — answering `Svc#dep` would be a fabricated declaration.
    expect(typeOf(envOf([file]), file, 's.dep.Work')).toBe('unresolved');
  });

  it('refuses an operand that is not an identifier or a field selector', async () => {
    const file = await gf(
      'svc/svc.go',
      `package svc

type Dep struct{}

func All() []Dep { return nil }

func Run() {
	_ = All()[0].Work()
}
`,
    );
    // An index expression has no binding site to read; the slice's element type is decidable in
    // principle and deliberately not decided here — one inference path, not two.
    expect(typeOf(envOf([file]), file, 'All()[0].Work')).toBe('unresolved');
  });
});

describe('buildGoTypeEnv — observability', () => {
  it('counts what it decided and what it refused, and neither for an unbound name', async () => {
    const files = [
      await gf('internal/db/db.go', 'package db\n\nfunc Load() int { return 1 }\n'),
      await gf(
        'svc/svc.go',
        `package svc

import "github.com/acme/api/internal/db"

type Dep struct{}

func Run(items []Dep) int {
	d := Dep{}
	_ = d.Work()
	for _, e := range items {
		_ = e.Work()
	}
	return db.Load()
}
`,
      ),
    ];
    const env = envOf(files);
    const file = files[1];
    typeOf(env, file, 'd.Work');
    typeOf(env, file, 'e.Work');
    typeOf(env, file, 'db.Load');
    // A hole a reader cannot see is a hole the graph claims it does not have.
    expect(env.gaps).toEqual({ resolved: 1, undecidable: 1 });
  });
});
