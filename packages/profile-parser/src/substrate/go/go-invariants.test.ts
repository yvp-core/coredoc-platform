/**
 * Graph-wide invariant suite for the Go substrate.
 *
 * The per-concern tests assert positive/negative outcomes on tiny fixtures. This file does the
 * OTHER thing: it scans the WHOLE assembled repo for property violations, sample-free. The fixture
 * is deliberately shaped to trigger the trap classes this substrate exists to avoid — two files of
 * ONE package calling each other unqualified, a `Handle` method on two receiver types in one file,
 * an `init()` in two files, nested `chi.Route` mounts, a sqlc query beside its call site, a
 * migration and a struct describing the SAME table, an interface-dispatch call that must be
 * dropped rather than bound to an arbitrary implementation, and a `/v5`-suffixed import path whose
 * local name is `chi`.
 *
 * It also carries the shape real routers are actually written in: a handler CONSTRUCTED in one
 * package (`h := handler.New()`) and mounted from another, with a same-named decoy type sitting in
 * the registering package. Without it the suite would be green on a graph whose routes name no
 * handler at all — a route LIST, not a graph — and the wrong answer would go unpunished.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type EdgeIdKind, type FunctionNode, type NodeIdKind, StableIdGenerator } from '@coredoc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GoProfile } from '../../types.js';
import { type GoFile, parseGo } from './go-cst.js';
import { buildImportTable } from './go-imports.js';
import { type GoParsedRepo, parseGoRepo } from './go-parser.js';

const FILES: Record<string, string> = {
  'go.mod': [
    'module github.com/acme/api',
    '',
    'go 1.22',
    '',
    'require (',
    '\tgithub.com/go-chi/chi/v5 v5.0.11',
    '\tgithub.com/spf13/cobra v1.8.0',
    ')',
    '',
  ].join('\n'),

  // --- one package, two files: a cross-file unqualified call (Go's own scoping rule) ---
  'internal/svc/a.go': `package svc

func init() { _ = 1 }

// Two receiver types with the SAME method name in ONE file — a flat file+name id merges them.
type Svc struct{ n int }

func (s *Svc) Handle() int { return s.helper() }

func (s *Svc) helper() int { return 1 }

type Other struct{}

func (o *Other) Handle() int { return 2 }

func Helper() int { return 7 }
`,

  'internal/svc/b.go': `package svc

func init() { _ = 2 }

// Unqualified call to a func declared in a DIFFERENT FILE of the same package.
func Run() int { return Helper() }
`,

  // --- the handler package a router MOUNTS FROM ANOTHER PACKAGE ---
  'internal/handler/handler.go': `package handler

import "net/http"

type Handler struct{}

func New() *Handler { return &Handler{} }

func (h *Handler) GetMe(w http.ResponseWriter, r *http.Request) {}

func (h *Handler) Warm() {}
`,

  // --- chi router with nested mounts ---
  'internal/api/router.go': `package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/acme/api/internal/handler"
)

// A DECOY: the registering package declares its own same-named type carrying the same method
// name. A handler lookup keyed on the REGISTERING file's directory binds here, which is the
// wrong answer that "resolve the type's OWN package" exists to prevent.
type Handler struct{}

func (h *Handler) GetMe(w http.ResponseWriter, r *http.Request) {}

func buildRouter() http.Handler {
	router := chi.NewRouter()
	// The dominant real-world router shape: the handler is a LOCAL whose named type is declared
	// in another package, so both the mounted route and the plain call below need the type
	// environment to resolve at all.
	h := handler.New()
	h.Warm()
	router.Route("/api", func(r chi.Router) {
		r.Route("/v1", func(r chi.Router) {
			r.Get("/users", listUsers)
			r.Post("/users/{id}", createUser)
			r.Get("/me", h.GetMe)
		})
	})
	return router
}

func listUsers(w http.ResponseWriter, r *http.Request) {}

// The header read is a TRAP, not decoration: Get is a router verb AND the method every
// authenticated Go handler calls on http.Header. Without the rooted-path gate this fabricates a
// "GET /Authorization" route, which the exact-equality assertion on the path list catches.
func createUser(w http.ResponseWriter, r *http.Request) {
	_ = r.Header.Get("Authorization")
}
`,

  // --- persistence: a sqlc query, its call site, and a model describing the DDL's table ---
  'db/queries/users.sql': '-- name: ListUsers :many\nSELECT id, email FROM users ORDER BY id;\n',
  'migrations/0001_init.sql': 'CREATE TABLE users (\n  id BIGSERIAL PRIMARY KEY,\n  email TEXT NOT NULL\n);\n',

  'internal/db/models.go':
    `package db

// Describes the SAME table as the migration above — must merge, not double-emit.
type User struct {
	ID    int64  ` +
    '`db:"id"`' +
    `
	Email string ` +
    '`db:"email"`' +
    `
}
`,

  'internal/db/store.go': `package db

import "context"

type Queries struct{}

type Store struct {
	q *Queries
}

func (s *Store) List(ctx context.Context) ([]User, error) {
	_, err := s.q.ListUsers(ctx)
	return nil, err
}
`,

  // --- interface dispatch that must be DROPPED, with a same-named method nearby to mis-bind to ---
  'internal/notify/notify.go': `package notify

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

  // --- generated gRPC service registration ---
  'internal/grpcsrv/server.go': `package grpcsrv

import "context"

type userServer struct{}

func (s *userServer) GetUser(ctx context.Context, id int64) error { return nil }

func (s *userServer) mustEmbedUnimplementedUserServiceServer() {}

func Register(s *Registrar) {
	RegisterUserServiceServer(s, &userServer{})
}

type Registrar struct{}

func RegisterUserServiceServer(s *Registrar, srv interface{}) {}
`,

  // --- cobra CLI command (gated on the go.mod require above) ---
  'cmd/serve.go': `package cmd

import "github.com/spf13/cobra"

var serveCmd = &cobra.Command{
	Use:  "serve [flags]",
	RunE: runServe,
}

func runServe(cmd *cobra.Command, args []string) error { return nil }
`,
};

const PROFILE: GoProfile = {
  parserId: 'inv',
  repoType: 'backend',
  substrate: { language: 'go', include: ['**/*.go'] },
};

const NODE_KINDS = new Set<NodeIdKind | EdgeIdKind>([
  'file',
  'package',
  'function',
  'class',
  'method',
  'interface',
  'type-alias',
  'enum',
  'variable',
  'entity',
  'entrypoint',
  'component',
  'route',
  'state-store',
  'call',
  'import',
  'db-op',
  'ext-call',
  'component-use',
  'state-access',
]);

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'go-invariants-'));
  for (const [rel, src] of Object.entries(FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, src);
  }
  return root;
}

describe('go substrate — graph-wide invariants', () => {
  let root: string;
  let repo: GoParsedRepo;
  let fnById: Map<string, FunctionNode>;
  let idGen: StableIdGenerator;

  beforeAll(async () => {
    root = writeFixture();
    repo = await parseGoRepo(root, 'inv', {}, PROFILE);
    fnById = new Map((repo.functions ?? []).map((f) => [f.id, f]));
    idGen = new StableIdGenerator(root, 'inv');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('resolves an unqualified call across two files of ONE package', () => {
    // Go's compilation unit is the DIRECTORY: `Run` in b.go calls `Helper` in a.go with no import.
    const run = (repo.functions ?? []).find((f) => f.name === 'Run');
    const helper = (repo.functions ?? []).find((f) => f.name === 'Helper');
    const edge = repo.calls.find((e) => e.callerId === run?.id && e.calleeId === helper?.id);
    expect(edge?.provenance).toBe('go-local');
    expect(fnById.get(helper?.id as string)?.location.filePath).toBe('internal/svc/a.go');
  });

  it('keeps two receiver types with the same method name on DISTINCT ids', () => {
    const handles = (repo.functions ?? []).filter((f) => f.name === 'Handle');
    expect(handles).toHaveLength(2);
    expect(new Set(handles.map((f) => f.id)).size).toBe(2);
    // And `s.helper()` inside Svc.Handle must land on Svc's own helper.
    const svcHandle = handles.find((f) => f.classId === idGen.classId('internal/svc/a.go', 'Svc'));
    const edge = repo.calls.find((e) => e.callerId === svcHandle?.id);
    expect(edge?.provenance).toBe('go-recv');
    expect(fnById.get(edge?.calleeId as string)?.name).toBe('helper');
  });

  it('keeps `init` in two files of one package on DISTINCT ids', () => {
    const inits = (repo.functions ?? []).filter((f) => f.name === 'init');
    expect(inits).toHaveLength(2);
    expect(new Set(inits.map((f) => f.id)).size).toBe(2);
  });

  it('joins nested chi mounts into the full served path', () => {
    const http = repo.entrypoints.filter((e) => e.type === 'http');
    const paths = http
      .map((e) => `${(e.details as { method: string }).method} ${(e.details as { fullPath: string }).fullPath}`)
      .sort();
    expect(paths).toEqual(['GET /api/v1/me', 'GET /api/v1/users', 'POST /api/v1/users/{id}']);
  });

  it('resolves a route handler ACROSS packages, never to the same-named type next door', () => {
    // The whole product edge is entrypoint -> handler -> call graph. `h := handler.New()` in
    // `internal/api` mounts a method on a type declared in `internal/handler`, so the method index
    // must be read at the TYPE's directory rather than the registering file's.
    const me = repo.entrypoints.find((e) => (e.details as { fullPath?: string }).fullPath === '/api/v1/me');
    expect(fnById.get(me?.handlerId as string)?.location.filePath).toBe('internal/handler/handler.go');
    // Non-vacuous: the wrong answer really is reachable — a same-named method sits in the
    // registering file itself, which is exactly what a dir-of-the-caller lookup would return.
    const decoy = (repo.functions ?? []).find(
      (f) => f.name === 'GetMe' && f.location.filePath === 'internal/api/router.go',
    );
    expect(decoy).toBeDefined();
    expect(me?.handlerId).not.toBe(decoy?.id);
  });

  it('resolves a CALL on that same cross-package local, tagged go-type', () => {
    // The entrypoint lane and the call graph read ONE type environment, so `h.GetMe` as a mounted
    // value and `h.Warm()` as a call must agree about what `h` is.
    const warm = (repo.functions ?? []).find((f) => f.name === 'Warm');
    const edge = repo.calls.find((e) => e.calleeId === warm?.id);
    expect(edge?.provenance).toBe('go-type');
    expect(fnById.get(edge?.callerId as string)?.location.filePath).toBe('internal/api/router.go');
  });

  it('emits a DbOperation for the sqlc call site against the right table', () => {
    const op = repo.dbOperations.find((o) => o.entityName === 'users');
    expect(op).toBeDefined();
    expect(fnById.has(op?.performerId as string)).toBe(true);
    expect(op?.entityId).toBeDefined();
  });

  it('the migration and the struct describe ONE entity, not two', () => {
    // Double-emitting splits db-op attribution across two ids and halves every answer.
    expect(repo.entities.filter((e) => e.tableName === 'users')).toHaveLength(1);
    expect(repo.entities.map((e) => e.tableName)).toEqual(['users']);
  });

  it('DROPS an interface-dispatch call instead of binding it to an implementation', () => {
    // `s.n.Notify(...)` must NOT resolve to `(*Email).Notify`, which sits in the same package.
    const emailNotify = (repo.functions ?? []).find(
      (f) => f.name === 'Notify' && f.location.filePath === 'internal/notify/notify.go' && f.classId,
    );
    expect(emailNotify).toBeDefined();
    expect(repo.calls.filter((e) => e.calleeId === emailNotify?.id)).toEqual([]);
  });

  it('binds a /vN-suffixed import path to its real local name', async () => {
    const relPath = 'internal/api/router.go';
    const source = readFileSync(join(root, relPath), 'utf-8');
    const file: GoFile = { relPath, source, root: await parseGo(source) };
    // `github.com/go-chi/chi/v5` binds `chi`, never `v5` — miss this and every selector on a
    // v2+ dependency resolves to nothing.
    expect(buildImportTable(file).byLocal.get('chi')).toBe('github.com/go-chi/chi/v5');
  });

  it('every CALL edge resolves to a real FunctionNode and carries a shippable provenance', () => {
    for (const e of repo.calls) {
      expect(e.calleeId).toBeDefined();
      expect(fnById.has(e.calleeId as string)).toBe(true);
      expect(['go-local', 'go-import', 'go-recv', 'go-type']).toContain(e.provenance);
    }
    expect(repo.calls.length).toBeGreaterThan(0); // non-vacuous
  });

  it('every DbOperation performer id resolves to a real FunctionNode', () => {
    expect(repo.dbOperations.filter((op) => !fnById.has(op.performerId))).toEqual([]);
    expect(repo.dbOperations.length).toBeGreaterThan(0); // non-vacuous
  });

  it('every entrypoint handlerId resolves to a real FunctionNode', () => {
    const dangling = repo.entrypoints.filter((e) => !fnById.has(e.handlerId));
    expect(dangling.map((e) => `${e.type} ${e.location.filePath}:${e.location.startLine}`)).toEqual([]);
    expect(repo.entrypoints.length).toBeGreaterThan(0);
  });

  it('every FileNode belongs to a directory Package that exists', () => {
    const packageIds = new Set(repo.packages.map((p) => p.id));
    expect(repo.files.filter((f) => !packageIds.has(f.packageId))).toEqual([]);
    expect(repo.files.length).toBeGreaterThan(0);
    expect(repo.files.every((f) => f.language === 'go' && f.extension === '.go')).toBe(true);
  });

  it('emits one Package per DIRECTORY, named from the package clause', () => {
    // Go's import and scoping unit is the directory, not the go.mod module. One Package per
    // module collapses a whole service into a single node and makes packageId meaningless.
    const dirs = new Set(repo.files.map((f) => f.path.slice(0, f.path.lastIndexOf('/')) || '.'));
    for (const dir of dirs) expect(repo.packages.map((p) => p.path)).toContain(dir);
    // The name comes from the `package` clause, which Go does not require to match the directory.
    const owned = new Set(repo.files.map((f) => f.packageId));
    expect(
      repo.packages
        .filter((p) => owned.has(p.id))
        .map((p) => p.name)
        .sort(),
    ).toEqual(['api', 'cmd', 'db', 'grpcsrv', 'handler', 'notify', 'svc']);
  });

  it('keeps the go.mod require list on the module root even when it holds no .go file', () => {
    // `server/go.mod` beside `server/cmd/…` is the normal Go layout, so without a module-root
    // package the module's dependency set would vanish from the output entirely.
    const withDeps = repo.packages.filter((p) => p.dependencies !== undefined);
    expect(withDeps.map((p) => p.path)).toEqual(['.']);
    expect(withDeps[0].name).toBe('github.com/acme/api');
    // A require list is a MODULE fact, so it is NOT repeated onto each package underneath — they
    // carry manifestFile instead, which keeps the owning module discoverable from any of them.
    expect(repo.packages.every((p) => p.manifestFile === 'go.mod')).toBe(true);
    expect(repo.packages.filter((p) => p.path !== '.').every((p) => p.dependencies === undefined)).toBe(true);
  });

  it('every struct is a ClassNode whose methods point at real FunctionNodes', () => {
    const store = repo.classes.find((c) => c.name === 'Store');
    expect(store?.methods.every((id) => fnById.has(id))).toBe(true);
    // A Go type's methods may live in ANY file of its package, so the lookup is package-keyed.
    const svc = repo.classes.find((c) => c.name === 'Svc');
    expect(svc?.methods.map((id) => fnById.get(id)?.name).sort()).toEqual(['Handle', 'helper']);
    // An interface's method_specs have no body, so they are members — never FunctionNodes.
    const notifier = repo.interfaces.find((i) => i.name === 'Notifier');
    expect(notifier?.members.map((m) => m.name)).toEqual(['Notify']);
  });

  it('emits the gRPC service methods and the gated cobra command', () => {
    const grpc = repo.entrypoints.filter((e) => e.type === 'grpc');
    expect(grpc.map((e) => (e.details as { serviceName: string; methodName: string }).methodName)).toEqual(['GetUser']);
    expect((grpc[0]?.details as { serviceName: string }).serviceName).toBe('UserService');
    const cli = repo.entrypoints.filter((e) => e.type === 'cli');
    expect(cli.map((e) => (e.details as { command: string }).command)).toEqual(['serve']);
  });

  it('every emitted id belongs to the repo and names a real NodeIdKind/EdgeIdKind', () => {
    const ids = [
      ...(repo.functions ?? []).map((n) => n.id),
      ...repo.files.map((n) => n.id),
      ...repo.packages.map((n) => n.id),
      ...repo.classes.map((n) => n.id),
      ...repo.classes.flatMap((c) => c.properties.map((p) => p.id)),
      ...repo.interfaces.map((n) => n.id),
      ...repo.enums.map((n) => n.id),
      ...repo.typeAliases.map((n) => n.id),
      ...repo.entities.map((n) => n.id),
      ...repo.entrypoints.map((n) => n.id),
      ...repo.dbOperations.map((n) => n.id),
      ...repo.externalCalls.map((n) => n.id),
      ...repo.calls.map((n) => n.id),
    ];
    expect(ids.length).toBeGreaterThan(20);
    const bad = ids.filter((id) => {
      const parsed = idGen.parseId(id);
      return !idGen.belongsToRepo(id) || !parsed || !NODE_KINDS.has(parsed.type);
    });
    expect(bad).toEqual([]);
  });

  it('every node/edge versionedId is a real checksum (id@hex, never @1)', () => {
    const checksum = /@[0-9a-f]{6,}$/;
    const nodes: Array<{ id: string; versionedId: string }> = [
      ...(repo.functions ?? []),
      ...repo.files,
      ...repo.classes,
      ...repo.interfaces,
      ...repo.enums,
      ...repo.typeAliases,
      ...repo.entities,
      ...repo.entrypoints,
      ...repo.dbOperations,
      ...repo.externalCalls,
    ];
    const bad = nodes.filter((n) => !n.versionedId || n.versionedId === `${n.id}@1` || !checksum.test(n.versionedId));
    expect(bad.map((n) => n.id)).toEqual([]);
    expect(repo.calls.every((c) => Boolean(c.id) && Boolean(c.callerId))).toBe(true);
  });
});

/**
 * `GoProfile` documents every knob as optional with a code-level default so a bare
 * `{ parserId, substrate }` profile already extracts meaningfully. Gating extraction on the
 * PRESENCE of a key would contradict that: omitting `entities` would yield zero entities AND zero
 * db-ops with no error — the silent hole this substrate exists to avoid.
 */
describe('go substrate — a bare profile uses defaults, not opt-out', () => {
  let root: string;
  let bare: GoParsedRepo;

  beforeAll(async () => {
    root = writeFixture();
    bare = await parseGoRepo(root, 'bare', {}, {
      parserId: 'bare',
      substrate: { language: 'go', include: ['**/*.go'] },
    } as GoProfile);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('yields modules, files, functions and types', () => {
    expect(bare.packages.length).toBeGreaterThan(0);
    expect(bare.files.length).toBeGreaterThan(0);
    expect((bare.functions ?? []).length).toBeGreaterThan(0);
    expect(bare.classes.length).toBeGreaterThan(0);
    expect(bare.interfaces.length).toBeGreaterThan(0);
  });

  it('reaches ParseStats with the db-op resolution record', () => {
    // The lane's own unit test proves the counting; this proves it survives the assembly that
    // fills `stats` — the merge/unit tests alone never cross the parser boundary (spec AC-3).
    // The EXACT triple of this fixture: one sqlc site (`s.q.ListUsers(ctx)`), bound to the
    // `users` entity the .sql file declares, nothing out of scope. A `> 0` assertion would still
    // pass with a lost counter or a site counted in the wrong sub-lane.
    expect(bare.parseStats.dbOpResolution).toEqual({ dbOpSites: 1, boundDbOps: 1, outOfScopeDbOps: 0 });
  });

  it('yields entities, db-ops, entrypoints and calls with no knobs declared', () => {
    expect(bare.entities.length).toBeGreaterThan(0);
    expect(bare.dbOperations.length).toBeGreaterThan(0);
    expect(bare.entrypoints.length).toBeGreaterThan(0);
    expect(bare.calls.length).toBeGreaterThan(0);
  });
});
