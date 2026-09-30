/**
 * Acceptance for `routes.fileConvention`: Next.js pages- and app-router page files
 * become RouteNodes with no declaration site, resolving componentId through the page's
 * `export default` — and never emitting a dangling componentId.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const page = (name: string): string => `export default function ${name}() {\n  return <div>${name}</div>;\n}\n`;

const FILES: Record<string, string> = {
  'apps/studio/pages/index.tsx': page('HomePage'),
  'apps/studio/pages/project/[ref]/editor.tsx': page('EditorPage'),
  'apps/studio/pages/docs/[...slug].tsx': page('DocsPage'),
  // Not a detected component: the default export names a plain object.
  'apps/studio/pages/legacy.tsx': 'const LegacyRedirect = { to: "/" };\nexport default LegacyRedirect;\n',
  'apps/studio/pages/_app.tsx': page('AppShell'),
  'apps/studio/pages/api/health.ts': 'export default function handler() {\n  return 1;\n}\n',
  'apps/docs/app/(app)/guides/[...slug]/page.tsx': page('GuidePage'),
  'apps/docs/app/layout.tsx': page('DocsLayout'),
};

const PROFILE: ExtractionProfile = {
  parserId: 'test-file-convention-routes',
  substrate: { language: 'ts', include: ['**/*.ts', '**/*.tsx'], exclude: ['**/node_modules/**'] },
  components: {
    framework: 'react',
    functional: true,
    functionalInExtensions: ['.tsx'],
    childComponents: 'jsx-walk',
    idResolution: 'import+tsconfig',
    imports: {},
  },
  routes: {
    fileConvention: [
      { framework: 'next-pages', routeDir: 'apps/studio/pages' },
      { framework: 'next-app', routeDir: 'apps/docs/app' },
    ],
  },
};

describe('routes.fileConvention — Next.js pages + app router', () => {
  it('emits a route per page file and resolves componentId only for real components', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-fc-routes-'));
    for (const [rel, source] of Object.entries(FILES)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    const { repo } = await runProfile(PROFILE, dir, 'fc-routes-test');
    const routes = (repo.routes ?? [])
      .map((r) => [r.path, r.componentName, r.componentId ? 'resolved' : 'name-only'])
      .sort();

    // `_app.tsx`, `pages/api/**` and the app-router `layout.tsx` are not routes.
    expect(routes).toEqual([
      ['/', 'HomePage', 'resolved'],
      ['/docs/{slug}', 'DocsPage', 'resolved'],
      ['/guides/{slug}', 'GuidePage', 'resolved'],
      ['/legacy', 'LegacyRedirect', 'name-only'],
      ['/project/{ref}/editor', 'EditorPage', 'resolved'],
    ]);

    const home = (repo.routes ?? []).find((r) => r.path === '/');
    expect(home?.isLazy).toBe(false);
    expect(home?.location?.filePath).toBe('apps/studio/pages/index.tsx');
    // Route ids hash the declaring file, so same-path pages in two apps stay distinct.
    expect(new Set((repo.routes ?? []).map((r) => r.id)).size).toBe(routes.length);
    // Never dangle: every componentId must be an emitted component.
    const componentIds = new Set((repo.components ?? []).map((c) => c.id));
    for (const r of repo.routes ?? []) if (r.componentId) expect(componentIds.has(r.componentId)).toBe(true);
  });

  // `routeDir` is a directory PREFIX, unlike the same-named-until-now
  // `FileConventionHttpRule.routeRoot`, which is a single path SEGMENT found anywhere in
  // the path. Handing this rule the segment form matches no file at all.
  it('matches routeDir as a repo-relative prefix, not as a path segment', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-fc-routes-dir-'));
    for (const [rel, source] of Object.entries(FILES)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    const { repo } = await runProfile(
      { ...PROFILE, routes: { fileConvention: [{ framework: 'next-pages', routeDir: 'pages' }] } },
      dir,
      'fc-routes-dir-test',
    );
    expect(repo.routes ?? []).toEqual([]);
  });
});
