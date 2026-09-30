/**
 * Path derivation for file-convention frontend routes (Next.js pages + app router).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveNextRoutePath,
  derivePagesRoutePath,
  httpMethodFromCallee,
  isPagesApiRouteFile,
  isPagesRouteFile,
  nextSegmentsToRoutePath,
  packageLocalRouteRootIndex,
} from './path-helpers.js';

describe('package-local Next.js convention roots', () => {
  it('ignores app/pages segments that belong to the workspace package path', () => {
    expect(packageLocalRouteRootIndex('apps/app/app/api/health/route.ts', 'app', 'apps/app')).toBe(2);
    expect(packageLocalRouteRootIndex('apps/pages/pages/api/health.ts', 'pages', 'apps/pages')).toBe(2);
  });

  it('derives an App Router path from the convention root, not the package name', () => {
    expect(deriveNextRoutePath('apps/app/app/api/health/route.ts', 'app', 'apps/app')).toBe('/api/health');
  });
});

describe('derivePagesRoutePath — next-pages', () => {
  it('maps index files to their parent directory', () => {
    expect(derivePagesRoutePath('index.tsx')).toBe('/');
    expect(derivePagesRoutePath('project/index.tsx')).toBe('/project');
  });

  it('keeps nested segments and strips the extension', () => {
    expect(derivePagesRoutePath('org/settings/billing.tsx')).toBe('/org/settings/billing');
    expect(derivePagesRoutePath('sign-in.jsx')).toBe('/sign-in');
  });

  it('maps dynamic and catch-all segments to braces', () => {
    expect(derivePagesRoutePath('project/[ref]/editor.tsx')).toBe('/project/{ref}/editor');
    expect(derivePagesRoutePath('docs/[...slug].tsx')).toBe('/docs/{slug}');
    expect(derivePagesRoutePath('project/[ref]/index.tsx')).toBe('/project/{ref}');
  });
});

describe('isPagesRouteFile — next-pages exclusions', () => {
  it('accepts js/ts page modules', () => {
    for (const f of ['index.tsx', 'a.ts', 'b.jsx', 'c.js']) expect(isPagesRouteFile(f)).toBe(true);
  });

  it('rejects non-module files', () => {
    expect(isPagesRouteFile('privacy.mdx')).toBe(false);
    expect(isPagesRouteFile('README.md')).toBe(false);
  });

  it('rejects framework internals and the api subtree', () => {
    expect(isPagesRouteFile('_app.tsx')).toBe(false);
    expect(isPagesRouteFile('_document.tsx')).toBe(false);
    expect(isPagesRouteFile('_components/Chart.tsx')).toBe(false);
    expect(isPagesRouteFile('api/health.ts')).toBe(false);
    expect(isPagesRouteFile('api/v1/[id].ts')).toBe(false);
    // `api` only excludes the ROOT subtree — a nested `api` directory is routable.
    expect(isPagesRouteFile('project/api/keys.tsx')).toBe(true);
  });
});

describe('isPagesApiRouteFile — next-pages-api inclusions', () => {
  it('accepts every module under the api subtree, including index and dynamic files', () => {
    for (const f of ['api/health.ts', 'api/v1/[id].ts', 'api/platform/index.ts', 'api/legacy/list.js'])
      expect(isPagesApiRouteFile(f)).toBe(true);
  });

  it('rejects anything outside the root api subtree — it is the complement of isPagesRouteFile', () => {
    expect(isPagesApiRouteFile('index.tsx')).toBe(false);
    expect(isPagesApiRouteFile('project/api/keys.tsx')).toBe(false);
    for (const f of ['api/health.ts', 'index.tsx', 'project/api/keys.tsx'])
      expect(isPagesApiRouteFile(f)).toBe(!isPagesRouteFile(f) && f.startsWith('api/'));
  });

  it('rejects framework internals and non-module files', () => {
    expect(isPagesApiRouteFile('api/_utils/db.ts')).toBe(false);
    expect(isPagesApiRouteFile('api/_middleware.ts')).toBe(false);
    expect(isPagesApiRouteFile('api/schema.graphql')).toBe(false);
    expect(isPagesApiRouteFile('api/types.d.ts')).toBe(false);
  });
});

describe('httpMethodFromCallee — from-callee verb gate', () => {
  const rule = { method: 'from-callee' } as never;
  it('accepts HTTP verbs, maps del→DELETE and all→ALL', () => {
    expect(httpMethodFromCallee('get', rule)).toBe('GET');
    expect(httpMethodFromCallee('del', rule)).toBe('DELETE');
    expect(httpMethodFromCallee('all', rule)).toBe('ALL');
  });

  it('rejects non-verb callees (client-router navigations, mounts)', () => {
    for (const m of ['push', 'replace', 'navigate', 'mount', 'use', 'param'])
      expect(httpMethodFromCallee(m, rule)).toBeUndefined();
  });
});

describe('nextSegmentsToRoutePath — next-app directory chains', () => {
  it('drops route groups and slots', () => {
    expect(nextSegmentsToRoutePath(['(app)', 'blog'])).toBe('/blog');
    expect(nextSegmentsToRoutePath(['@modal', 'photo'])).toBe('/photo');
    expect(nextSegmentsToRoutePath([])).toBe('/');
  });

  it('maps dynamic and catch-all segments to braces', () => {
    expect(nextSegmentsToRoutePath(['guides', '[...slug]'])).toBe('/guides/{slug}');
    expect(nextSegmentsToRoutePath(['blog', '[slug]'])).toBe('/blog/{slug}');
    expect(nextSegmentsToRoutePath(['guides', 'database', '[[...slug]]'])).toBe('/guides/database/{slug}');
  });
});
