/**
 * Tests for the Go structural index + Tier-B call resolver.
 *
 * The resolver is PRECISION-FIRST, so nearly every test here has a negative twin: it is not enough
 * that the three decidable shapes resolve, the undecidable ones must be DROPPED rather than bound
 * to a plausible-looking wrong target. The fixtures are deliberately shaped so that a naive
 * resolver would find something — a same-named method sitting in the same package, a shadowing
 * local, an ambiguous package-scope name — because an edge that is merely plausible is
 * indistinguishable from a real one to a reader of the graph.
 */
import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { indexGoDefs, resolveGoCalls } from './go-callgraph.js';
import { type GoFile } from './go-cst.js';
import { buildPackageIndex } from './go-imports.js';
import type { GoModule } from './go-modules.js';
import { buildGoTypeEnv } from './go-types.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

const ID = new StableIdGenerator('/demo', 'demo');
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
  return { relPath, source, root: await parseSource('go', source) };
}

function pkgIndex(files: GoFile[]) {
  return buildPackageIndex(files, MODULES);
}

/** The shared type environment the resolver reads `v.M()` receivers through. */
function typeEnvOf(files: GoFile[]) {
  return buildGoTypeEnv(files, pkgIndex(files));
}

/** Resolve calls over a file set and describe each edge as `provenance caller->callee`. */
async function edgesOf(files: GoFile[]): Promise<string[]> {
  const index = indexGoDefs(files, ID);
  const packageIndex = pkgIndex(files);
  const typeEnv = buildGoTypeEnv(files, packageIndex);
  return resolveGoCalls(files, index, ID, packageIndex, typeEnv).calls.map((e) => {
    const caller = index.byId.get(e.callerId);
    const callee = index.byId.get(e.calleeId as string);
    return `${e.provenance} ${caller?.location.filePath}:${caller?.name}->${callee?.location.filePath}:${callee?.name}`;
  });
}

describe('indexGoDefs — a FunctionNode for every func, method and closure', () => {
  it('reads a method name from field_identifier, never the receiver variable', async () => {
    // TRAP: in `func (s *Svc) Handle()`, descendantsOfType('identifier')[0] is the RECEIVER `s`.
    // A resolver that took it would name every method after its receiver variable.
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

func Free() int { return 1 }

type Svc struct{}

func (s *Svc) Handle() int { return 1 }

func (s *Svc) hidden() int { return 2 }
`,
      ),
    ];
    const byName = new Map([...indexGoDefs(files, ID).byId.values()].map((n) => [n.name, n]));
    expect(byName.has('s')).toBe(false);
    expect(byName.get('Handle')?.kind).toBe('method');
    expect(byName.get('Handle')?.visibility).toBe('public');
    expect(byName.get('hidden')?.visibility).toBe('private');
    // A package-scope func carries case-derived visibility as `isExported` instead.
    expect(byName.get('Free')?.kind).toBe('function');
    expect(byName.get('Free')?.isExported).toBe(true);
    // Methods hang off a real type node, so ClassNode.methods can point back at them.
    expect(byName.get('Handle')?.classId).toBe(ID.classId('svc/svc.go', 'Svc'));
    // Go has no `async` keyword — concurrency is a property of the CALL (`go f()`).
    expect(byName.get('Handle')?.isAsync).toBe(false);
  });

  it('keeps the same method name on two receiver types apart', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type A struct{}

func (a *A) Handle() int { return 1 }

type B struct{}

func (b *B) Handle() int { return 2 }
`,
      ),
    ];
    const handles = [...indexGoDefs(files, ID).byId.values()].filter((n) => n.name === 'Handle');
    expect(handles).toHaveLength(2);
    expect(new Set(handles.map((n) => n.id)).size).toBe(2);
  });

  it('indexes closures so a call inside a handler is not merged into its enclosing func', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup() {
	handler := func() int { return 1 }
	_ = handler
}
`,
      ),
    ];
    const names = [...indexGoDefs(files, ID).byId.values()].map((n) => n.name).sort();
    // A func_literal bound to a variable is named after it; only a truly inline one is anonymous.
    expect(names).toEqual(['handler', 'setup']);
  });

  it('records only PACKAGE-SCOPE funcs as resolvable names, keyed by directory', async () => {
    const files = [
      await gf('svc/a.go', 'package svc\n\nfunc Top() int { return nested() }\n\nfunc nested() int { return 1 }\n'),
    ];
    const index = indexGoDefs(files, ID);
    expect([...index.funcIdsByPackageName.keys()].sort()).toEqual(['svc#Top', 'svc#nested']);
    expect(index.methodsByPackageType.size).toBe(0);
  });
});

describe('resolveGoCalls — go-local (the package IS the scope)', () => {
  it('resolves a bare call to a func in ANOTHER FILE of the same package', async () => {
    // Go's compilation unit is the DIRECTORY. This is the case Rust cannot do, and getting it
    // wrong would silently halve the call graph of every multi-file Go package.
    const files = [
      await gf('svc/a.go', 'package svc\n\nfunc Helper() int { return 7 }\n'),
      await gf('svc/b.go', 'package svc\n\nfunc Run() int { return Helper() }\n'),
    ];
    expect(await edgesOf(files)).toEqual(['go-local svc/b.go:Run->svc/a.go:Helper']);
  });

  it('does NOT cross package (directory) boundaries for a bare name', async () => {
    const files = [
      await gf('svc/a.go', 'package svc\n\nfunc Helper() int { return 7 }\n'),
      await gf('other/b.go', 'package other\n\nfunc Run() int { return Helper() }\n'),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops a bare call shadowed by a local closure of the same name', async () => {
    // Go funcs are ordinary values: `helper := func(){}` means `helper()` is the CLOSURE, not the
    // package-scope func. Binding it to the package func would be a wrong edge.
    const files = [
      await gf(
        'svc/a.go',
        `package svc

func helper() int { return 7 }

func Run() int {
	helper := func() int { return 1 }
	return helper()
}
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops a bare call shadowed by a parameter', async () => {
    const files = [
      await gf(
        'svc/a.go',
        `package svc

func helper() int { return 7 }

func Run(helper func() int) int { return helper() }
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops an AMBIGUOUS package-scope name rather than picking a winner', async () => {
    // Two `init`s in one package are legal Go. An arbitrary winner is worse than no edge.
    const files = [
      await gf('svc/a.go', 'package svc\n\nfunc init() { _ = 1 }\n'),
      await gf('svc/b.go', 'package svc\n\nfunc init() { _ = 2 }\n'),
      await gf('svc/c.go', 'package svc\n\nfunc Run() { init() }\n'),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops every bare call in a file carrying a dot import', async () => {
    // `import . "pkg"` drops an unknowable set of names into the file's namespace, so a bare
    // `Helper()` here may belong to the dot-imported package.
    const files = [
      await gf('svc/a.go', 'package svc\n\nfunc Helper() int { return 7 }\n'),
      await gf(
        'svc/b.go',
        `package svc

import . "github.com/acme/api/other"

func Run() int { return Helper() }
`,
      ),
    ];
    // Non-vacuous: without the dot import this exact fixture resolves (see the go-local test above),
    // so the empty result is the dot-import guard firing and not a broken fixture.
    expect(await edgesOf(files)).toEqual([]);
  });
});

describe('resolveGoCalls — go-recv (the enclosing method receiver)', () => {
  it('resolves `s.helper()` to a method on the receiver type', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Svc struct{}

func (s *Svc) Handle() int { return s.helper() }

func (s *Svc) helper() int { return 1 }
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual(['go-recv svc/svc.go:Handle->svc/svc.go:helper']);
  });

  it('resolves a receiver call from inside a closure that captures the receiver', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Svc struct{}

func (s *Svc) Register() {
	cb := func() int { return s.helper() }
	_ = cb
}

func (s *Svc) helper() int { return 1 }
`,
      ),
    ];
    // The caller is the CLOSURE, not Register — otherwise every handler's calls merge into setup.
    expect(await edgesOf(files)).toEqual(['go-recv svc/svc.go:cb->svc/svc.go:helper']);
  });

  it('resolves a receiver method declared in ANOTHER FILE of the package', async () => {
    const files = [
      await gf('svc/a.go', 'package svc\n\ntype Svc struct{}\n\nfunc (s *Svc) Handle() int { return s.helper() }\n'),
      await gf('svc/b.go', 'package svc\n\nfunc (s *Svc) helper() int { return 1 }\n'),
    ];
    expect(await edgesOf(files)).toEqual(['go-recv svc/a.go:Handle->svc/b.go:helper']);
  });

  it('drops a PROMOTED method (receiver-qualified but not declared on the type)', async () => {
    // `s.Log()` here comes from the embedded Base. Following it needs embedding resolution; a
    // same-named method on a sibling type is exactly the wrong thing to bind to.
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Base struct{}

func (b *Base) Log() {}

type Svc struct {
	Base
}

func (s *Svc) Handle() { s.Log() }
`,
      ),
    ];
    // Non-vacuous: `Log` IS indexed, so a resolver that ignored the receiver TYPE would bind it.
    expect([...indexGoDefs(files, ID).byId.values()].map((n) => n.name)).toContain('Log');
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops interface dispatch through a field instead of binding an implementation', async () => {
    // The single most damaging wrong edge a Go call graph can ship: `s.n.Notify()` bound to the
    // one implementation that happens to sit in the same package.
    const files = [
      await gf(
        'notify/notify.go',
        `package notify

type Notifier interface {
	Notify(msg string) error
}

type Email struct{}

func (e *Email) Notify(msg string) error { return nil }

type Service struct {
	n Notifier
}

func (s *Service) Send() error { return s.n.Notify("hi") }
`,
      ),
    ];
    // Non-vacuous: `(*Email).Notify` is indexed and sits in the SAME package, so it is exactly the
    // target a receiver-blind resolver would reach for.
    expect([...indexGoDefs(files, ID).byId.values()].map((n) => n.name)).toContain('Notify');
    expect(await edgesOf(files)).toEqual([]);
  });
});

describe('resolveGoCalls — go-type (the receiver value TYPED from its declaration)', () => {
  it('resolves a method call on a local bound to a composite literal', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Dep struct{}

func (d *Dep) Work() int { return 1 }

func Run() int {
	d := Dep{}
	return d.Work()
}
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual(['go-type svc/svc.go:Run->svc/svc.go:Work']);
  });

  it('resolves a method call on a PARAMETER and on a `var` with an explicit type', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Dep struct{}

func (d *Dep) Work() int { return 1 }

func FromParam(d *Dep) int { return d.Work() }

func FromVar() int {
	var d *Dep
	return d.Work()
}
`,
      ),
    ];
    expect((await edgesOf(files)).sort()).toEqual([
      'go-type svc/svc.go:FromParam->svc/svc.go:Work',
      'go-type svc/svc.go:FromVar->svc/svc.go:Work',
    ]);
  });

  it('resolves ACROSS packages through a constructor result, keyed by the TYPE owner', async () => {
    // The router shape: `h := handler.New(…)` in `main`, methods declared in `internal/handler`.
    // Keying the method lookup on the CALLING file's directory finds nothing here, which is the
    // bug this tier exists to fix.
    const files = [
      await gf(
        'internal/handler/handler.go',
        `package handler

type Handler struct{}

func New() *Handler { return &Handler{} }

func (h *Handler) GetMe() int { return 1 }
`,
      ),
      await gf(
        'cmd/server/main.go',
        `package main

import "github.com/acme/api/internal/handler"

func run() int {
	h := handler.New()
	return h.GetMe()
}
`,
      ),
    ];
    // Both edges are real: the constructor call itself is an ordinary qualified call, and the
    // method call on its result is the tier under test. Asserted together so a regression that
    // swapped one tier for the other cannot hide behind a filtered expectation.
    expect((await edgesOf(files)).sort()).toEqual([
      'go-import cmd/server/main.go:run->internal/handler/handler.go:New',
      'go-type cmd/server/main.go:run->internal/handler/handler.go:GetMe',
    ]);
  });

  it('reads the right slot of a MULTI-VALUE constructor and drops the others', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Dep struct{}

func (d *Dep) Work() int { return 1 }

func NewDep() (*Dep, error) { return nil, nil }

func Run() int {
	d, err := NewDep()
	_ = err.Work()
	return d.Work()
}
`,
      ),
    ];
    // `NewDep()` is itself a bare package-scope call, hence the go-local edge. Of the two method
    // calls on its results only one survives: slot 0 is `*Dep` and resolves; slot 1 is `error`,
    // which declares no `Work` in this repo.
    expect((await edgesOf(files)).sort()).toEqual([
      'go-local svc/svc.go:Run->svc/svc.go:NewDep',
      'go-type svc/svc.go:Run->svc/svc.go:Work',
    ]);
  });

  it('resolves through a struct FIELD but never through an interface-typed one', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Dep struct{}

func (d *Dep) Work() int { return 1 }

type Notifier interface{ Work() int }

type Svc struct {
	dep  *Dep
	note Notifier
}

func (s *Svc) Concrete() int { return s.dep.Work() }

func (s *Svc) Dynamic() int { return s.note.Work() }
`,
      ),
    ];
    // The interface names the SAME method as the concrete type, in the SAME package — exactly the
    // wrong edge a field-blind resolver would ship.
    expect(await edgesOf(files)).toEqual(['go-type svc/svc.go:Concrete->svc/svc.go:Work']);
  });

  it('drops a method on a value whose type is declared OUTSIDE this repo', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

import "github.com/go-chi/chi/v5"

type Router struct{}

func (r *Router) Get(p string) {}

func setup() {
	r := chi.NewRouter()
	r.Get("/x")
}
`,
      ),
    ];
    // Non-vacuous: this package declares its OWN `Get` on a type named `Router`, so a resolver that
    // ignored where `chi.Router` is declared would bind the chi call to it.
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops a method on a RANGE binding rather than falling through to the shadowed outer value', async () => {
    // Shadowing is ordinary Go. The inner `d` is a range element whose type this substrate cannot
    // read; answering with the OUTER `d`'s type would name the wrong variable entirely.
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Dep struct{}

func (d *Dep) Work() int { return 1 }

func Run(deps []int) int {
	d := Dep{}
	_ = d
	for _, d := range deps {
		_ = d.Work()
	}
	return 0
}
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('never re-reads a shadowing LOCAL as a package qualifier', async () => {
    // A local named after an imported package must not resolve to that package's func: Go's own
    // scoping puts the binding ahead of the file's imports.
    const files = [
      await gf('other/other.go', 'package other\n\nfunc Find() int { return 1 }\n'),
      await gf(
        'svc/svc.go',
        `package svc

import "github.com/acme/api/other"

func Run(other chan int) int {
	return other.Find()
}
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops a method PROMOTED through an embedded struct', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

type Base struct{}

func (b *Base) Work() int { return 1 }

type Svc struct {
	Base
}

func Run() int {
	s := Svc{}
	return s.Work()
}
`,
      ),
    ];
    // `Work` is a real call, but it is declared on `Base`, not on `Svc`. Following promotion is a
    // documented gap; binding it to `Svc` would be a fabricated declaration.
    expect(await edgesOf(files)).toEqual([]);
  });
});

describe('resolveGoCalls — go-import (qualified into this repo)', () => {
  it('resolves `db.Load()` through the import table into the repo package', async () => {
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
    expect(await edgesOf(files)).toEqual(['go-import cmd/main.go:run->internal/db/db.go:Load']);
  });

  it('corrects the last-segment guess against the DECLARED package name', async () => {
    // `internal/database` declaring `package db` is referenced as `db.` — the naive last-segment
    // guess would look for a qualifier named `database` and find nothing.
    const files = [
      await gf('internal/database/db.go', 'package db\n\nfunc Load() int { return 1 }\n'),
      await gf(
        'cmd/main.go',
        `package main

import "github.com/acme/api/internal/database"

func run() int { return db.Load() }
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual(['go-import cmd/main.go:run->internal/database/db.go:Load']);
  });

  it('drops a qualified call into a package OUTSIDE the repo', async () => {
    const files = [
      await gf(
        'cmd/main.go',
        `package main

import "fmt"

func run() { fmt.Println("x") }
`,
      ),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('drops a qualified call whose qualifier is not an import in THIS file', async () => {
    const files = [
      await gf('internal/db/db.go', 'package db\n\nfunc Load() int { return 1 }\n'),
      // No import declaration at all — `db` is some other value here.
      await gf('cmd/main.go', 'package main\n\nfunc run() int { return db.Load() }\n'),
    ];
    expect(await edgesOf(files)).toEqual([]);
  });
});

describe('resolveGoCalls — edge policy and observability', () => {
  it('drops a self-edge for direct recursion', async () => {
    const files = [await gf('svc/a.go', 'package svc\n\nfunc Fib(n int) int { return Fib(n - 1) }\n')];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('emits no edge for a call at PACKAGE scope (there is no caller node)', async () => {
    const files = [await gf('svc/a.go', 'package svc\n\nfunc mustOpen() int { return 1 }\n\nvar db = mustOpen()\n')];
    expect(await edgesOf(files)).toEqual([]);
  });

  it('counts every dropped site in ambiguousCalls rather than hiding it', async () => {
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

import "fmt"

type Svc struct{}

func (s *Svc) Handle() int {
	fmt.Println("x")
	return s.helper()
}

func (s *Svc) helper() int { return 1 }
`,
      ),
    ];
    const index = indexGoDefs(files, ID);
    const res = resolveGoCalls(files, index, ID, pkgIndex(files), typeEnvOf(files));
    expect(res.calls).toHaveLength(1);
    // `fmt.Println` is a real call site this substrate deliberately does not resolve.
    expect(res.ambiguousCalls).toBeGreaterThan(0);
  });

  it('mints call ids through idGen and attributes the caller by innermost func scope', async () => {
    const files = [
      await gf(
        'svc/a.go',
        `package svc

func Helper() int { return 1 }

func Run() int { return Helper() }
`,
      ),
    ];
    const index = indexGoDefs(files, ID);
    const [edge] = resolveGoCalls(files, index, ID, pkgIndex(files), typeEnvOf(files)).calls;
    expect(ID.belongsToRepo(edge.id)).toBe(true);
    expect(ID.parseId(edge.id)?.type).toBe('call');
    expect(edge.isMethodCall).toBe(false);
    expect(edge.location.filePath).toBe('svc/a.go');
  });
});

describe('resolveGoCalls — call-resolution stats (BR-1, BR-2, LIM-6)', () => {
  const src = (repoPrintln: string) => `package svc

import "fmt"

type Saver interface{ Save() }

type Store struct{}

func (s *Store) Save() {}

func helper() {}
${repoPrintln}
func use(x Saver) {
	helper()
	fmt.Println("x")
	x.Save()
}
`;

  it('counts enumerated sites, shipped sites and sites naming nothing declared here', async () => {
    const files = [await gf('svc/svc.go', src(''))];
    const res = resolveGoCalls(files, indexGoDefs(files, ID), ID, pkgIndex(files), typeEnvOf(files));
    // Three enumerated sites: `helper()` ships, `fmt.Println` names nothing declared here, and
    // `x.Save()` (interface dispatch) names a real method this substrate cannot bind.
    expect(res.stats).toEqual({ callSites: 3, resolvedCalls: 1, outOfScopeCalls: 1 });
    expect(res.stats.resolvedCalls + res.stats.outOfScopeCalls).toBeLessThanOrEqual(res.stats.callSites);
    expect(res.calls).toHaveLength(1);
    expect(res.calls.some((e) => e.calleeExpression.includes('fmt.Println'))).toBe(false);
  });

  it('keeps a platform call whose name IS declared in this repo in scope (BR-1 collision)', async () => {
    const files = [await gf('svc/svc.go', src('\nfunc Println(a string) {}\n'))];
    const res = resolveGoCalls(files, indexGoDefs(files, ID), ID, pkgIndex(files), typeEnvOf(files));
    expect(res.stats).toEqual({ callSites: 3, resolvedCalls: 1, outOfScopeCalls: 0 });
  });

  it('must NOT count a package-scope call site — it has no caller node (LIM-6)', async () => {
    // `var _ = compute()` really runs, but Go attributes it to no func this substrate emits, so
    // it can never resolve. Counting it would make the denominator grow with something the
    // extractor was never able to answer for. The in-func sibling still counts.
    const files = [
      await gf(
        'svc/svc.go',
        `package svc

func compute() int { return 0 }

var _ = compute()

func use() {
	compute()
}
`,
      ),
    ];
    const res = resolveGoCalls(files, indexGoDefs(files, ID), ID, pkgIndex(files), typeEnvOf(files));
    expect(res.stats).toEqual({ callSites: 1, resolvedCalls: 1, outOfScopeCalls: 0 });
  });
});
