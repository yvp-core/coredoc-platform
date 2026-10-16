/**
 * Tests for Go entrypoint extraction — HTTP routes, generated gRPC services, gated CLI commands.
 *
 * The load-bearing property throughout is the FULL SERVED PATH. A leaf path emitted without its
 * mount prefix names a route the server does not serve, and it breaks the cross-repo path join at
 * both ends — so every mount form is asserted on the whole joined string, never on the leaf.
 *
 * The CLI lane's dependency gate gets a negative twin: a `cobra.Command`-shaped literal in a repo
 * that does not require cobra must emit NOTHING, because the shape alone is not evidence.
 */
import type { CliEntrypointDetails, GrpcEntrypointDetails, HttpEntrypointDetails } from '@coredoc/core';
import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type GoFile } from './go-cst.js';
import { extractGoEntrypoints } from './go-entrypoints.js';
import type { GoModule } from './go-modules.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

const ID = new StableIdGenerator('/demo', 'demo');

function mod(...dependencies: string[]): GoModule[] {
  return [
    {
      modulePath: 'github.com/acme/api',
      path: '.',
      manifestFile: 'go.mod',
      dependencies: new Set(dependencies),
      isWorkspace: false,
    },
  ];
}

async function gf(relPath: string, source: string): Promise<GoFile> {
  return { relPath, source, root: await parseSource('go', source) };
}

/** Every http entrypoint as `METHOD /full/path`, sorted — the shape a client actually calls. */
function httpPaths(files: GoFile[], modules: GoModule[] = mod()): string[] {
  return extractGoEntrypoints(files, ID, { modules })
    .filter((e) => e.type === 'http')
    .map((e) => {
      const d = e.details as HttpEntrypointDetails;
      return `${d.method} ${d.fullPath}`;
    })
    .sort();
}

describe('http — router registration shapes', () => {
  it('extracts a chi registration and resolves the handler to a real func id', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

import "net/http"

func setup(r chi.Router) {
	r.Get("/users", listUsers)
}

func listUsers(w http.ResponseWriter, r *http.Request) {}
`,
      ),
    ];
    const [ep] = extractGoEntrypoints(files, ID, { modules: mod() });
    expect((ep.details as HttpEntrypointDetails).fullPath).toBe('/users');
    expect((ep.details as HttpEntrypointDetails).method).toBe('GET');
    // A resolvable handler points at the REAL function node, not a synthetic id.
    expect(ep.handlerId).toBe(ID.functionId('api/routes.go', 'listUsers'));
  });

  it('reads gin/echo UPPERCASE verbs as well as chi/stdlib TitleCase', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(e *echo.Echo) {
	e.GET("/a", h)
	e.POST("/b", h)
	e.DELETE("/c", h)
}
`,
      ),
    ];
    expect(httpPaths(files)).toEqual(['DELETE /c', 'GET /a', 'POST /b']);
  });

  it('joins a NESTED chi Route into the full served path', async () => {
    // Lexical composition: the inner registration is a CST descendant of the mount call.
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(router chi.Router) {
	router.Route("/api", func(r chi.Router) {
		r.Route("/v1", func(r chi.Router) {
			r.Get("/users", listUsers)
			r.Post("/users/{id}", createUser)
		})
	})
}
`,
      ),
    ];
    expect(httpPaths(files)).toEqual(['GET /api/v1/users', 'POST /api/v1/users/{id}']);
  });

  it('joins a BOUND gin Group prefix through the variable', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(r *gin.Engine) {
	v1 := r.Group("/api/v1")
	v1.GET("/users", listUsers)
}
`,
      ),
    ];
    expect(httpPaths(files)).toEqual(['GET /api/v1/users']);
  });

  it("does NOT treat chi's closure-form Group as a path prefix", async () => {
    // chi and gin spell two different things `Group`. gin's takes a PATH (`r.Group("/api/v1")`,
    // covered above); chi's takes only a closure and exists to scope MIDDLEWARE — it contributes
    // no path at all. Treating it as a prefix invents routes the server does not serve, and it is
    // the dominant shape in a real chi router, so nesting a real prefix inside it is the case
    // that has to stay right. `With(...)` likewise chains without adding a path.
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(middleware.Auth)
		r.Get("/api/me", getMe)
		r.Route("/api/workspaces", func(r chi.Router) {
			r.Get("/", listWorkspaces)
			r.Get("/{id}", getWorkspace)
		})
	})
	r.With(middleware.RequireHuman).Post("/api/usage", upsertUsage)
}
`,
      ),
    ];
    expect(httpPaths(files)).toEqual([
      'GET /api/me',
      'GET /api/workspaces',
      'GET /api/workspaces/{id}',
      'POST /api/usage',
    ]);
  });

  it('joins a TRANSITIVE chain of bound groups', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(r *gin.Engine) {
	v1 := r.Group("/api/v1")
	beta := v1.Group("/beta")
	beta.GET("/users", listUsers)
}
`,
      ),
    ];
    expect(httpPaths(files)).toEqual(['GET /api/v1/beta/users']);
  });

  it('reads gorilla verbs off a chained .Methods(...)', async () => {
    // The registration call itself carries no verb; the restriction hangs off its return value.
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(r *mux.Router) {
	r.HandleFunc("/users", listUsers).Methods("GET", "POST")
}
`,
      ),
    ];
    expect(httpPaths(files)).toEqual(['GET /users', 'POST /users']);
  });

  it('reads the Go 1.22 ServeMux verb-in-pattern form', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(mux *http.ServeMux) {
	mux.HandleFunc("GET /items", listItems)
	mux.HandleFunc("/legacy", legacy)
}
`,
      ),
    ];
    // The verb is stripped out of the path; a verbless pattern falls back to GET.
    expect(httpPaths(files)).toEqual(['GET /items', 'GET /legacy']);
  });

  it('reads the explicit-verb form where the path is argument 1', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(r chi.Router) {
	r.Method("PUT", "/users/{id}", updateUser)
}
`,
      ),
    ];
    expect(httpPaths(files)).toEqual(['PUT /users/{id}']);
  });

  it('templatizes gin/echo and gorilla params into the linker`s {param} form', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(r *gin.Engine) {
	r.GET("/users/:id", show)
	r.GET("/files/*path", serve)
}

func other(m *mux.Router) {
	m.HandleFunc("/orders/{id:[0-9]+}", getOrder).Methods("GET")
}
`,
      ),
    ];
    // The cross-repo linker joins on the PATH, so the param spelling has to be normalised or a
    // caller's `/users/{id}` never matches this route.
    expect(httpPaths(files)).toEqual(['GET /files/{path}', 'GET /orders/{id}', 'GET /users/{id}']);
  });

  it('SKIPS a registration whose path is not a string literal', async () => {
    // A const or a runtime-built path is not statically decidable — reporting it at a guessed
    // path would name a route the server does not serve.
    const files = [
      await gf(
        'api/routes.go',
        `package api

const userPath = "/users"

func setup(r chi.Router) {
	r.Get(userPath, listUsers)
	r.Get("/ok", ok)
}
`,
      ),
    ];
    expect(httpPaths(files)).toEqual(['GET /ok']);
  });

  it('does NOT mistake a same-named non-router call for a registration', async () => {
    // The registration-path gate's whole reason for existing. `r.Header.Get("Authorization")` is in
    // essentially every authenticated Go handler, and map-like `Get`s are everywhere else; without
    // the rooted-path requirement each one fabricates a route (`GET /Authorization`) — and since
    // go-signals excludes them from the DENOMINATOR, the fabrication would read as a PASS.
    const files = [
      await gf(
        'api/handler.go',
        `package api

func setup(r chi.Router) {
	r.Get("/real", handle)
}

func handle(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("Authorization")
	page := r.URL.Query().Get("page")
	level := viper.Get("log.level")
	_, _, _ = token, page, level
}
`,
      ),
    ];
    // Exactly the one real route — non-vacuous, so this cannot pass by extracting nothing at all.
    expect(httpPaths(files)).toEqual(['GET /real']);
  });

  it('resolves an inline closure handler and a receiver-method handler to real ids', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

type Server struct{}

func (s *Server) Routes(r chi.Router) {
	r.Get("/users", s.ListUsers)
	r.Get("/inline", func(w http.ResponseWriter, req *http.Request) {})
}

func (s *Server) ListUsers(w http.ResponseWriter, r *http.Request) {}
`,
      ),
    ];
    const eps = extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'http');
    const byPath = new Map(eps.map((e) => [(e.details as HttpEntrypointDetails).fullPath, e]));
    expect(byPath.get('/users')?.handlerId).toBe(ID.methodId('api/routes.go', 'Server', 'ListUsers'));
    // The closure's id is minted by the same goFunctionId the def index uses, so it is a real node.
    expect(byPath.get('/inline')?.handlerId).toBeDefined();
  });

  it('resolves a handler on a local CONSTRUCTED in another package, keyed by the type`s owner', async () => {
    // The dominant real-world router: `main` builds the handler and mounts its methods, but the
    // methods are declared in the handler package. A lookup keyed on the REGISTERING file's
    // directory finds nothing here, which is what left a real repo's routes handler-less.
    const files = [
      await gf(
        'cmd/server/router.go',
        `package main

import "github.com/acme/api/internal/handler"

func NewRouter(r chi.Router) {
	h := handler.New(nil)
	r.Get("/api/me", h.GetMe)
}
`,
      ),
      await gf(
        'internal/handler/handler.go',
        `package handler

import "net/http"

type Handler struct{}

func New(q *Queries) *Handler { return &Handler{} }

type Queries struct{}

func (h *Handler) GetMe(w http.ResponseWriter, r *http.Request) {}
`,
      ),
    ];
    const [ep] = extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'http');
    expect((ep.details as HttpEntrypointDetails).fullPath).toBe('/api/me');
    expect(ep.handlerId).toBe(ID.methodId('internal/handler/handler.go', 'Handler', 'GetMe'));
  });

  it('resolves a handler on a PARAMETER of the router builder', async () => {
    // The other half of the same idiom: the handler is injected rather than constructed, so the
    // type comes off the signature instead of off a constructor's declared result.
    const files = [
      await gf(
        'cmd/server/router.go',
        `package main

import "github.com/acme/api/internal/handler"

func NewRouter(r chi.Router, h *handler.Handler) {
	r.Get("/api/me", h.GetMe)
}
`,
      ),
      await gf(
        'internal/handler/handler.go',
        `package handler

import "net/http"

type Handler struct{}

func (h *Handler) GetMe(w http.ResponseWriter, r *http.Request) {}
`,
      ),
    ];
    const [ep] = extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'http');
    expect(ep.handlerId).toBe(ID.methodId('internal/handler/handler.go', 'Handler', 'GetMe'));
  });

  it('never binds a handler to a SAME-NAMED method in the registering package', async () => {
    // Precision, not recall: the registering package declares its own `Handler.GetMe`. Resolving
    // the mount against the caller's directory would attach the route to that one — a wrong edge,
    // which is indistinguishable from a real one to every downstream reader.
    const files = [
      await gf(
        'cmd/server/router.go',
        `package main

import "github.com/acme/api/internal/handler"

type Handler struct{}

func (h *Handler) GetMe(w http.ResponseWriter, r *http.Request) {}

func NewRouter(r chi.Router) {
	h := handler.New()
	r.Get("/api/me", h.GetMe)
}
`,
      ),
      await gf(
        'internal/handler/handler.go',
        `package handler

import "net/http"

type Handler struct{}

func New() *Handler { return &Handler{} }

func (h *Handler) GetMe(w http.ResponseWriter, r *http.Request) {}
`,
      ),
    ];
    const [ep] = extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'http');
    expect(ep.handlerId).toBe(ID.methodId('internal/handler/handler.go', 'Handler', 'GetMe'));
    expect(ep.handlerId).not.toBe(ID.methodId('cmd/server/router.go', 'Handler', 'GetMe'));
  });

  it('falls back to a synthetic id for a handler the type environment cannot decide', async () => {
    // An INTERFACE-typed field resolves to the interface, whose method specs have no bodies. The
    // route is kept — a listed route with no handler is honest; a route pointing at the one struct
    // that happens to implement the interface is not. A handler FACTORY is decidable: the request
    // lands in the closure the package func returns.
    const files = [
      await gf(
        'cmd/server/router.go',
        `package main

import "net/http"

type API interface {
	GetMe(w http.ResponseWriter, r *http.Request)
}

type Impl struct{}

func (i *Impl) GetMe(w http.ResponseWriter, r *http.Request) {}

type Server struct {
	api API
}

func (s *Server) Routes(r chi.Router) {
	r.Get("/api/me", s.api.GetMe)
	r.Get("/api/health", makeHealth("ok"))
}

func makeHealth(msg string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {}
}
`,
      ),
    ];
    const eps = extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'http');
    const byPath = new Map(eps.map((e) => [(e.details as HttpEntrypointDetails).fullPath, e]));
    expect(byPath.get('/api/me')?.handlerId).toBe(ID.functionId('cmd/server/router.go', 'GET /api/me'));
    expect(byPath.get('/api/me')?.handlerId).not.toBe(ID.methodId('cmd/server/router.go', 'Impl', 'GetMe'));
    expect(byPath.get('/api/health')?.handlerId).toContain('router.go:makeHealth.(anonymous)');
  });

  it('honours a profile that narrows routerMethods to one spelling', async () => {
    const files = [
      await gf('api/routes.go', 'package api\n\nfunc setup(r chi.Router) {\n\tr.Get("/a", h)\n\tr.GET("/b", h)\n}\n'),
    ];
    const eps = extractGoEntrypoints(files, ID, { modules: mod(), routerMethods: ['Get'] });
    expect(eps.map((e) => (e.details as HttpEntrypointDetails).fullPath)).toEqual(['/a']);
  });

  it('de-dupes the same route registered twice in ONE file, but keeps two files apart', async () => {
    const same = [
      await gf(
        'api/a.go',
        `package api

func setup(r chi.Router) {
	r.Get("/users", listUsers)
}

func setupAgain(r chi.Router) {
	r.Get("/users", listUsers)
}
`,
      ),
    ];
    expect(httpPaths(same)).toEqual(['GET /users']);

    // The entrypoint id is file-qualified, so the SAME path registered from two files stays two
    // sites — they are two real registrations, and collapsing them would hide one.
    const split = [
      await gf('api/a.go', 'package api\n\nfunc setup(r chi.Router) {\n\tr.Get("/users", listUsers)\n}\n'),
      await gf('api/b.go', 'package api\n\nfunc setup2(r chi.Router) {\n\tr.Get("/users", listUsers)\n}\n'),
    ];
    expect(httpPaths(split)).toEqual(['GET /users', 'GET /users']);
  });
});

describe('http — huma operations behind a dependency gate', () => {
  const HUMA = 'github.com/danielgtaylor/huma/v2';
  const SOURCE = `package api

import (
	"net/http"

	"github.com/danielgtaylor/huma/v2"
)

const Prefix = "/v1/mgmt"

var (
	groupsPath  = Prefix + "/companies/{companyUuid}/groups"
	membersPath = groupsPath + "/{groupUuid}"
)

type Reader struct{}

func (r *Reader) handleGroups() {}

func handleSources(dep int) func() {
	return func() {}
}

func register(api huma.API, r *Reader) {
	huma.Register(api, huma.Operation{
		OperationID: "groups",
		Method:      http.MethodGet,
		Path:        groupsPath,
	}, r.handleGroups)
	huma.Register(api, huma.Operation{Method: "POST", Path: membersPath}, r.handleGroups)
	huma.Register(api, huma.Operation{Method: http.MethodGet, Path: Prefix + "/sources"}, handleSources(1))
	huma.Delete(api, Prefix+"/cache", r.handleGroups)
}
`;

  it('reads Method and a const-concatenated Path off huma.Operation, plus the verb helpers', async () => {
    const files = [await gf('api/routes.go', SOURCE)];
    expect(httpPaths(files, mod(HUMA))).toEqual([
      'DELETE /v1/mgmt/cache',
      'GET /v1/mgmt/companies/{companyUuid}/groups',
      'GET /v1/mgmt/sources',
      'POST /v1/mgmt/companies/{companyUuid}/groups/{groupUuid}',
    ]);
  });

  it('resolves a method handler and the closure a handler FACTORY returns', async () => {
    const files = [await gf('api/routes.go', SOURCE)];
    const eps = extractGoEntrypoints(files, ID, { modules: mod(HUMA) });
    const byPath = new Map(eps.map((e) => [(e.details as HttpEntrypointDetails).fullPath, e.handlerId]));
    expect(byPath.get('/v1/mgmt/companies/{companyUuid}/groups')).toContain('Reader.handleGroups');
    expect(byPath.get('/v1/mgmt/sources')).toContain('handleSources.(anonymous)');
  });

  it('emits NOTHING when huma is not a dependency', async () => {
    const files = [await gf('api/routes.go', SOURCE)];
    expect(httpPaths(files, mod())).toEqual([]);
  });

  it('ignores a Register call whose qualifier is not the huma import', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

import "github.com/acme/registry"

func setup() {
	registry.Register(api, registry.Operation{Method: "GET", Path: "/x"}, h)
}
`,
      ),
    ];
    expect(httpPaths(files, mod(HUMA))).toEqual([]);
  });
});

describe('grpc — generated service registration', () => {
  it('names the service from the Register call and the methods from the impl type', async () => {
    const files = [
      await gf(
        'grpcsrv/server.go',
        `package grpcsrv

import "context"

type userServer struct{}

func (s *userServer) GetUser(ctx context.Context, id int64) error { return nil }

func (s *userServer) ListUsers(ctx context.Context) error { return nil }

func (s *userServer) internalOnly() {}

func (s *userServer) mustEmbedUnimplementedUserServiceServer() {}

func Register(s *Registrar) {
	RegisterUserServiceServer(s, &userServer{})
}

type Registrar struct{}

func RegisterUserServiceServer(s *Registrar, srv interface{}) {}
`,
      ),
    ];
    const grpc = extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'grpc');
    const details = grpc.map((e) => e.details as GrpcEntrypointDetails);
    expect(details.map((d) => d.methodName).sort()).toEqual(['GetUser', 'ListUsers']);
    expect(new Set(details.map((d) => d.serviceName))).toEqual(new Set(['UserService']));
    expect(details[0].streaming).toBe('unary');
    // Unexported methods have no wire presence, and the generated forward-compat guard is not an
    // endpoint — both must stay out.
    expect(details.map((d) => d.methodName)).not.toContain('internalOnly');
    expect(details.map((d) => d.methodName)).not.toContain('mustEmbedUnimplementedUserServiceServer');
  });

  it('resolves an impl bound to a variable earlier in the file', async () => {
    const files = [
      await gf(
        'grpcsrv/server.go',
        `package grpcsrv

type userServer struct{}

func (s *userServer) GetUser() error { return nil }

func Register(g *Registrar) {
	srv := &userServer{}
	RegisterUserServiceServer(g, srv)
}

type Registrar struct{}

func RegisterUserServiceServer(g *Registrar, s interface{}) {}
`,
      ),
    ];
    const grpc = extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'grpc');
    expect(grpc.map((e) => (e.details as GrpcEntrypointDetails).methodName)).toEqual(['GetUser']);
  });

  it('emits nothing when the impl type is not statically resolvable', async () => {
    const files = [
      await gf(
        'grpcsrv/server.go',
        `package grpcsrv

func Register(g *Registrar, impl interface{}) {
	RegisterUserServiceServer(g, impl)
}

type Registrar struct{}

func RegisterUserServiceServer(g *Registrar, s interface{}) {}
`,
      ),
    ];
    expect(extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'grpc')).toEqual([]);
  });
});

describe('cli — framework literals behind a dependency gate', () => {
  const COBRA = `package cmd

import "github.com/spf13/cobra"

var serveCmd = &cobra.Command{
	Use:  "serve [flags]",
	RunE: runServe,
}

func runServe(cmd *cobra.Command, args []string) error { return nil }
`;

  it('extracts a cobra command when the module is required', async () => {
    const files = [await gf('cmd/serve.go', COBRA)];
    const cli = extractGoEntrypoints(files, ID, { modules: mod('github.com/spf13/cobra') }).filter(
      (e) => e.type === 'cli',
    );
    // cobra's `Use` is a USAGE string — the command is its first word.
    expect(cli.map((e) => (e.details as CliEntrypointDetails).command)).toEqual(['serve']);
    expect(cli[0].handlerId).toBe(ID.functionId('cmd/serve.go', 'runServe'));
  });

  it('emits NOTHING for the same literal when cobra is not a dependency', async () => {
    // The literal shape alone is not evidence: a repo may define its own `cobra.Command`-shaped
    // type. The gate is what keeps a fabricated command out of the graph.
    const files = [await gf('cmd/serve.go', COBRA)];
    expect(extractGoEntrypoints(files, ID, { modules: mod() }).filter((e) => e.type === 'cli')).toEqual([]);
  });

  it('extracts an urfave command behind its own gate', async () => {
    const files = [
      await gf(
        'cmd/app.go',
        `package cmd

import "github.com/urfave/cli/v2"

var cmd = &cli.Command{
	Name:   "migrate",
	Action: runMigrate,
}

func runMigrate(c *cli.Context) error { return nil }
`,
      ),
    ];
    const cli = extractGoEntrypoints(files, ID, { modules: mod('github.com/urfave/cli/v2') }).filter(
      (e) => e.type === 'cli',
    );
    expect(cli.map((e) => (e.details as CliEntrypointDetails).command)).toEqual(['migrate']);
  });

  it('refuses to run an UNKNOWN framework name from a profile', async () => {
    // An unknown name has no gate module, so running it would be exactly the fabrication the gate
    // exists to prevent.
    const files = [await gf('cmd/serve.go', COBRA)];
    const eps = extractGoEntrypoints(files, ID, {
      modules: mod('github.com/spf13/cobra'),
      cliFrameworks: ['madeup'],
    });
    expect(eps.filter((e) => e.type === 'cli')).toEqual([]);
  });
});

describe('extractGoEntrypoints — ids and defaults', () => {
  it('mints every id through idGen and stamps a real checksum', async () => {
    const files = [
      await gf(
        'api/routes.go',
        'package api\n\nfunc setup(r chi.Router) {\n\tr.Get("/users", listUsers)\n}\n\nfunc listUsers() {}\n',
      ),
    ];
    const eps = extractGoEntrypoints(files, ID, { modules: mod() });
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) {
      expect(ID.belongsToRepo(ep.id)).toBe(true);
      expect(ID.parseId(ep.id)?.type).toBe('entrypoint');
      expect(ep.versionedId).toMatch(/@[0-9a-f]{6,}$/);
    }
  });

  it('extracts with NO knobs declared — absence means defaults, not opt-out', async () => {
    const files = [
      await gf(
        'api/routes.go',
        `package api

func setup(router chi.Router) {
	router.Route("/api", func(r chi.Router) {
		r.Get("/users", listUsers)
	})
}
`,
      ),
    ];
    expect(extractGoEntrypoints(files, ID, { modules: mod() })).toHaveLength(1);
  });
});
