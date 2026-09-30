/**
 * Graph-wide invariant suite (ADR-20260724-precision-first-verification).
 *
 * The per-concern tests assert positive/negative outcomes on tiny fixtures. This file does the
 * OTHER thing the ADR mandates: scan the WHOLE assembled `ParsedRepo` for property violations,
 * sample-free (O(edges)). The fixture is deliberately shaped to have TRIGGERED the 14-bug classes
 * the post-hoc `/review` found — two apps with a same-named class + the same route path, a chained
 * queryset write, a host-only egress URL beside a real one, an unnamed-group `re_path`. A
 * regression of ANY of those classes fabricates a violation here, not just on the specific fixture
 * a point test happens to cover.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FunctionNode, HttpEntrypointDetails } from '@coredoc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PythonProfile } from '../../types.js';
import { type PythonParsedRepo, parsePythonRepo } from './python-parser.js';

const FILES: Record<string, string> = {
  'app_a/__init__.py': '',
  'app_a/models.py': `from django.db import models
class Widget(models.Model):
    name = models.CharField(max_length=50)
`,
  // Same class name (Svc) as app_b — a name-only method index would cross-link the two.
  'app_a/service.py': `import requests
from app_a.models import Widget
class Svc:
    def run(self):
        return self.helper()
    def helper(self):
        Widget.objects.filter(name="x").update(name="y")
        requests.post("https://api.svc/orders/", json={})
        return requests.get("https://external.svc")
`,
  'app_a/urls.py': `from django.urls import path, re_path
from app_a import views
urlpatterns = [
    path('widgets/<int:pk>/', views.detail),
    re_path(r'^widgets/([0-9]+)/edit/$', views.edit),
]
`,
  'app_b/__init__.py': '',
  'app_b/service.py': `class Svc:
    def run(self):
        return self.helper()
    def helper(self):
        return 1
`,
  // Same local route path as app_a — a global de-dup would collapse the two handlers.
  'app_b/urls.py': `from django.urls import path
from app_b import views
urlpatterns = [ path('widgets/<int:pk>/', views.detail) ]
`,
};

const PROFILE: PythonProfile = {
  parserId: 'inv',
  repoType: 'backend',
  substrate: { language: 'python', include: ['**/*.py'] },
  entities: { baseClasses: ['models.Model'] },
  dbOperations: {},
  entrypoints: { djangoRoutes: { routeFileGlobs: ['**/urls.py'] } },
  egress: { clientModules: ['requests', 'httpx', 'aiohttp'] },
};

describe('python substrate — graph-wide invariants (ADR-20260724)', () => {
  let root: string;
  let repo: PythonParsedRepo;
  let fnById: Map<string, FunctionNode>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'py-invariants-'));
    for (const [rel, src] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, src);
    }
    repo = await parsePythonRepo(root, 'inv', {}, PROFILE);
    fnById = new Map(repo.functions.map((f) => [f.id, f]));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Bug class 1 — a `self.`/`cls.` (py-self) edge must never cross a file boundary. Two
  // `class Svc` in different apps must each resolve run->helper within their OWN file.
  it('no py-self CALL edge crosses a file boundary', () => {
    const offenders = repo.calls
      .filter((e) => e.provenance === 'py-self' && e.calleeId)
      .filter((e) => fnById.get(e.callerId)?.location.filePath !== fnById.get(e.calleeId as string)?.location.filePath);
    expect(offenders).toEqual([]);
    // non-vacuous: both same-file self-edges were actually resolved
    expect(repo.calls.filter((e) => e.provenance === 'py-self').length).toBeGreaterThanOrEqual(2);
  });

  // Bug class 4 — a host-only URL must not emit a bare '/' template; no egress template is empty.
  it('no egress edge has a bare "/" or empty path template', () => {
    for (const x of repo.externalCalls) {
      const p = x.targetDescriptor?.http?.pathTemplate;
      expect(p).toBeTruthy();
      expect(p).not.toBe('/');
    }
    // the real egress survived with its path; the host-only one was dropped
    expect(repo.externalCalls.map((x) => x.targetDescriptor?.http?.pathTemplate)).toContain('/orders/');
  });

  // Bug class 5 — no http route template leaks raw regex or an unrendered `{}` placeholder.
  it('no http entrypoint fullPath contains raw regex or an unrendered {}', () => {
    const bad = repo.entrypoints
      .filter((e) => e.type === 'http')
      .map((e) => (e.details as HttpEntrypointDetails).fullPath)
      .filter((p) => /[()\\]|\{\}/.test(p));
    expect(bad).toEqual([]);
  });

  // Bug class 6 — the same route path in two apps' urls.py stays two distinct entrypoints.
  it('same route path in two files yields two distinct http entrypoints (file-scoped de-dup)', () => {
    const widgets = repo.entrypoints.filter(
      (e) => e.type === 'http' && (e.details as HttpEntrypointDetails).fullPath.includes('widgets/{pk}'),
    );
    expect(widgets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(widgets.map((e) => e.id)).size).toBe(widgets.length); // ids are distinct
  });

  // Bug class 7 + id consistency — every DbOperation performer resolves to a real FunctionNode,
  // and the chained `.filter().update()` write was captured (not silently dropped).
  it('every DbOperation performer id resolves to a real FunctionNode', () => {
    const orphans = repo.dbOperations.filter((op) => !fnById.has(op.performerId));
    expect(orphans).toEqual([]);
    expect(repo.dbOperations.some((op) => op.operation === 'update')).toBe(true);
  });

  // G1 — referential integrity of the structure nodes: nothing in the graph may reference a
  // file/class/package node the target did not emit (the whole failure mode G1 describes).
  it('no node references a file, class or package that was not emitted', () => {
    const fileIds = new Set(repo.files.map((f) => f.id));
    const classIds = new Set(repo.classes.map((c) => c.id));
    const pkgIds = new Set(repo.packages.map((p) => p.id));
    expect(repo.functions.filter((f) => !fileIds.has(f.fileId)).map((f) => f.id)).toEqual([]);
    expect(repo.entities.filter((e) => !fileIds.has(e.fileId)).map((e) => e.id)).toEqual([]);
    expect(repo.imports.filter((i) => !fileIds.has(i.sourceFileId)).map((i) => i.id)).toEqual([]);
    expect(
      repo.imports.filter((i) => i.targetFileId !== undefined && !fileIds.has(i.targetFileId)).map((i) => i.id),
    ).toEqual([]);
    expect(repo.functions.filter((f) => f.classId !== undefined && !classIds.has(f.classId)).map((f) => f.id)).toEqual(
      [],
    );
    expect(repo.files.filter((f) => !pkgIds.has(f.packageId)).map((f) => f.path)).toEqual([]);
    // non-vacuous: the fixture really does have classes, methods and cross-file imports
    expect(repo.classes.length).toBeGreaterThan(0);
    expect(repo.functions.some((f) => f.classId !== undefined)).toBe(true);
    expect(repo.imports.some((i) => i.targetFileId !== undefined)).toBe(true);
  });

  // Two-ID integrity — every emitted node/edge carries a real content checksum, never @1 or missing.
  it('every node/edge versionedId is a real checksum (id@hex, never @1)', () => {
    const checksum = /@[0-9a-f]{6,}$/;
    const nodes: Array<{ id: string; versionedId: string }> = [
      ...repo.functions,
      ...repo.classes,
      ...repo.files,
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
 * `PythonProfile` documents every knob as optional with a code-level default so that "a bare
 * `{ parserId, substrate }` profile parses a Django/DRF/Celery repo out of the box". Gating
 * extraction on the PRESENCE of the `entities` key contradicted that: omitting it yielded
 * zero entities AND zero db-ops with no error — a silent hole in the substrate whose whole
 * purpose is to not have them.
 */
describe('python substrate — a bare profile uses defaults, not opt-out', () => {
  let root: string;
  let bare: PythonParsedRepo;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'py-bare-'));
    for (const [rel, src] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, src);
    }
    bare = await parsePythonRepo(root, 'bare', {}, {
      parserId: 'bare',
      repoType: 'backend',
      substrate: { language: 'python', include: ['**/*.py'] },
    } as PythonProfile);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('extracts entities with the default Django base class', () => {
    expect(bare.entities.map((e) => e.name)).toContain('Widget');
  });

  it('extracts db operations without a declared `entities` key', () => {
    expect(bare.dbOperations.length).toBeGreaterThan(0);
  });

  it('still extracts routes, calls and egress', () => {
    expect(bare.entrypoints.length).toBeGreaterThan(0);
    expect(bare.calls.length).toBeGreaterThan(0);
    expect(bare.externalCalls.length).toBeGreaterThan(0);
  });
});
