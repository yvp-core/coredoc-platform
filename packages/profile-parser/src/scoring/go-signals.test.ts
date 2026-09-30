import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoProfile } from '../types/go-profile.js';
import { goSourceSignals } from './go-signals.js';
import { categoryScore } from './score-core.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo(files: Record<string, string>, checkoutDir = ''): string {
  const base = mkdtempSync(join(tmpdir(), 'go-signals-'));
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

const profile: GoProfile = {
  parserId: 'go-v1',
  substrate: { language: 'go', include: ['**/*.go'] },
};

describe('goSourceSignals', () => {
  it('counts router registration and mount call sites for http', () => {
    const root = repo({
      'internal/api/router.go': `package api

func build() {
	r.Get("/users", listUsers)
	r.Post("/users", createUser)
	r.Route("/admin", func(r chi.Router) {
		r.Get("/stats", stats)
	})
	mux.HandleFunc("/healthz", healthz)
	v1 := e.Group("/api/v1")
	v1.GET("/orders", listOrders)
}
`,
    });
    // `grep -c` counts matching LINES: 2 verbs + 1 Route + 1 nested Get + 1 HandleFunc + 1 Group
    // + 1 GET = 7. An order-of-magnitude signal, not an exact route count.
    expect(goSourceSignals(root, profile).http).toBe(7);
  });

  it('does NOT count `Header.Get("…")`, which appears in every Go handler', () => {
    // Without the `["`]/` path guard the http denominator inflates by an order of magnitude and a
    // correctly-extracted repo becomes a permanent FAIL.
    const root = repo({
      'internal/api/h.go': `package api

func h(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("Authorization")
	ct := r.Header.Get("Content-Type")
	_ = token
	_ = ct
}
`,
    });
    expect(goSourceSignals(root, profile).http).toBe(0);
  });

  it('counts CREATE TABLE DDL plus the structs in files carrying persistence evidence', () => {
    const root = repo({
      // Depth-agnostic: a multi-module Go repo keeps migrations under the owning module.
      'services/api/migrations/0001_init.sql':
        'CREATE TABLE users (id BIGSERIAL PRIMARY KEY);\ncreate table orders (id INT);\n',
      'internal/db/models.go': `package db

type User struct {
	ID    int64  ${'`db:"id"`'}
	Email string ${'`db:"email"`'}
}

type Order struct {
	ID int64 ${'`db:"id"`'}
}
`,
      'internal/db/gorm.go': `package db

type Session struct {
	gorm.Model
	Token string
}
`,
    });
    // 2 DDL tables + 2 structs in the tagged file + 1 struct in the gorm.Model file.
    // Crucially the FIELDS are not counted: three tagged columns would put columns over tables.
    expect(goSourceSignals(root, profile).entities).toBe(5);
  });

  it('ignores a struct in a file with no persistence evidence', () => {
    const root = repo({
      'internal/api/dto.go': 'package api\n\ntype LoginRequest struct {\n\tEmail string\n}\n',
    });
    expect(goSourceSignals(root, profile).entities).toBe(0);
  });

  it('omits queue, cli and the externalCalls/dbOperations signals so those rows stay self-relative', () => {
    const root = repo({ 'main.go': 'package main\n\nfunc main() {}\n' });
    const signals = goSourceSignals(root, profile);
    expect(signals.http).toBe(0);
    expect(signals.queue).toBeUndefined();
    expect(signals.cli).toBeUndefined();
    expect(signals.externalCalls).toBeUndefined();
    expect(signals.dbOperations).toBeUndefined();

    // A repo with no HTTP surface must score `not_applicable` (→ PASS), never an HTTP FAIL.
    const http = categoryScore('http', signals.http, 0);
    expect(http.status).toBe('not_applicable');
    expect(http.verdict).toBe('PASS');
    // cli self-relative: emitted 1 against source 1 → PASS.
    expect(categoryScore('cli', 1, 1).verdict).toBe('PASS');
  });

  it('honors configured router methods and struct tags', () => {
    const root = repo({
      'internal/api/x.go': `package api

func b() {
	r.Register("/x", h)
	r.Get("/y", h)
}

type M struct {
	ID int ${'`sql:"id"`'}
}
`,
    });
    const tuned: GoProfile = {
      ...profile,
      entrypoints: { http: { routerMethods: ['Register'], mountMethods: [] } },
      entities: { structTags: ['sql'] },
    };
    const signals = goSourceSignals(root, tuned);
    expect(signals.http).toBe(1); // `.Get(` is no longer configured
    expect(signals.entities).toBe(1);
  });

  it('does not let the CHECKOUT path zero the denominators', () => {
    // grep echoes absolute paths, so testing the noise exclusion against the whole line makes a
    // repo living under `~/vendor/…` (or testdata/node_modules) drop every match. A zero
    // denominator scores `not_applicable` → PASS, so the failure mode is a false PASS.
    for (const dir of ['vendor/api', 'testdata/api', 'node_modules/api']) {
      const root = repo(
        {
          'internal/api/router.go': 'package api\n\nfunc b() {\n\tr.Get("/users", h)\n}\n',
          'migrations/0001.sql': 'CREATE TABLE users (id UUID PRIMARY KEY);\n',
        },
        dir,
      );
      const signals = goSourceSignals(root, profile);
      expect(signals.http, `http under ${dir}`).toBe(1);
      expect(signals.entities, `entities under ${dir}`).toBe(1);
    }
  });

  it('still excludes in-repo vendor/testdata/generated noise', () => {
    const root = repo({
      'internal/api/router.go': 'package api\n\nfunc b() {\n\tr.Get("/users", h)\n}\n',
      'vendor/github.com/x/y/r.go': 'package y\n\nfunc b() {\n\tr.Get("/vendored", h)\n}\n',
      'internal/api/testdata/fixture.go': 'package api\n\nfunc b() {\n\tr.Get("/fixture", h)\n}\n',
      'internal/api/gen.pb.go': 'package api\n\nfunc b() {\n\tr.Get("/generated", h)\n}\n',
      'internal/api/router_test.go': 'package api\n\nfunc b() {\n\tr.Get("/tested", h)\n}\n',
    });
    expect(goSourceSignals(root, profile).http).toBe(1);
  });

  it('scopes the grep to the include roots', () => {
    const root = repo({
      'services/api/router.go': 'package api\n\nfunc b() {\n\tr.Get("/a", h)\n}\n',
      'other/router.go': 'package other\n\nfunc b() {\n\tr.Get("/b", h)\n}\n',
    });
    const scoped: GoProfile = { ...profile, substrate: { language: 'go', include: ['services/**/*.go'] } };
    expect(goSourceSignals(root, scoped).http).toBe(1);
  });

  it('uses the parser-owned source set for profile-authored generated exclusions', () => {
    const root = repo({
      'internal/api/router.go': 'package api\n\nfunc b() {\n\tr.Get("/live", h)\n}\n',
      'generated/routes.go':
        'package generated\n\nfunc b() {\n\tr.Get("/one", h)\n\tr.Get("/two", h)\n\tr.Get("/three", h)\n}\n',
    });
    const scoped: GoProfile = {
      ...profile,
      substrate: { language: 'go', include: ['**/*.go'], exclude: ['generated/**'] },
    };

    expect(goSourceSignals(root, scoped).http).toBe(1);
  });

  describe('dbOperations basis disclosure', () => {
    // score-core scores db-ops against the EMITTED ENTITY count and caps the ratio at 1, so a
    // sqlc repo (far more operations than tables) reads a permanent 100% PASS however badly
    // attribution is working. The basis column is what carries the diagnostic number.
    const parsed = (entities: string[], ops: Array<string | undefined>) =>
      ({
        entities: entities.map((id) => ({ id })),
        dbOperations: ops.map((entityId) => ({ entityId })),
      }) as unknown as Parameters<typeof goSourceSignals>[2];

    it('reports the share of entities carrying at least one db-op', () => {
      const root = repo({ 'a/x.go': 'package a\n' });
      const signals = goSourceSignals(root, profile, parsed(['e1', 'e2', 'e3', 'e4'], ['e1', 'e1', 'e2']));
      expect(signals.dbOperationsNote).toContain('2/4 entities carry a db-op (50%)');
      expect(signals.dbOperationsNote).toContain('3 ops emitted');
    });

    it('counts ops that resolved to no entity separately', () => {
      const root = repo({ 'a/x.go': 'package a\n' });
      const signals = goSourceSignals(root, profile, parsed(['e1'], ['e1', undefined, undefined]));
      expect(signals.dbOperationsNote).toContain('1/1 entities carry a db-op (100%)');
      expect(signals.dbOperationsNote).toContain('2 unlinked to an entity');
    });

    it('ignores an op pointing at an entity id that was never emitted', () => {
      // A dangling entityId must not inflate the share — that is the failure this discloses.
      const root = repo({ 'a/x.go': 'package a\n' });
      const signals = goSourceSignals(root, profile, parsed(['e1', 'e2'], ['ghost', 'ghost']));
      expect(signals.dbOperationsNote).toContain('0/2 entities carry a db-op (0%)');
    });

    it('omits the note when there is nothing to disclose', () => {
      const root = repo({ 'a/x.go': 'package a\n' });
      expect(goSourceSignals(root, profile).dbOperationsNote).toBeUndefined();
      expect(goSourceSignals(root, profile, parsed([], [])).dbOperationsNote).toBeUndefined();
    });
  });
});
