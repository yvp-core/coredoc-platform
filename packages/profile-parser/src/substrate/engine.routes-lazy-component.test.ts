/**
 * Acceptance for route componentId resolution when the route's component is a
 * LAZY binding: `const X = lazy(() => import('./x.js').then(m => ({ default:
 * m.X })))` (and the default-export form `lazy(() => import('./x.js'))`).
 *
 * Field evidence (apps/web/src/router.tsx): the three lazy routes (/explorer,
 * /roadmap, the dashboards index) resolved `componentName` but left
 * `componentId` null while every statically-imported sibling route resolved —
 * the local `const` is a SCIP `local N` symbol, so neither the JSX-tag SCIP
 * path nor the import+tsconfig path could reach the component's declaration.
 *
 * The invariant under test stays: componentId is only ever set when it matches
 * a really-emitted component id (no fabrication).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const EXPLORER = `export function WorkspaceExplorer(): JSX.Element {
  return <div>explorer</div>;
}
`;

const ROADMAP = `function DashboardRoadmap(): JSX.Element {
  return <div>roadmap</div>;
}
export default DashboardRoadmap;
`;

const OVERVIEW = `export function WorkspaceOverview(): JSX.Element {
  return <div>overview</div>;
}
`;

const ROUTER = `import { lazy } from 'react';
import { WorkspaceOverview } from './pages/overview.js';

declare function createRoute(cfg: Record<string, unknown>): unknown;

const WorkspaceExplorer = lazy(() =>
  import('./pages/explorer.js').then((m) => ({ default: m.WorkspaceExplorer })),
);
const DashboardRoadmap = lazy(() => import('./pages/roadmap.js'));

const overviewRoute = createRoute({
  path: '/overview',
  component: WorkspaceOverview,
});

const explorerRoute = createRoute({
  path: '/explorer',
  component: WorkspaceExplorer,
});

const roadmapRoute = createRoute({
  path: '/roadmap',
  component: DashboardRoadmap,
});
`;

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-lazy-routes-'));
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  // scip-typescript's prerequisite check is the presence of node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'lazy-routes-fixture', version: '1.0.0', type: 'module' }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve' },
      include: ['src'],
    }),
  );
  writeFileSync(join(root, 'src', 'pages', 'explorer.tsx'), EXPLORER);
  writeFileSync(join(root, 'src', 'pages', 'roadmap.tsx'), ROADMAP);
  writeFileSync(join(root, 'src', 'pages', 'overview.tsx'), OVERVIEW);
  writeFileSync(join(root, 'src', 'router.tsx'), ROUTER);
  return root;
}

const PROFILE: ExtractionProfile = {
  parserId: 'test-lazy-routes',
  substrate: { language: 'ts', include: ['src/**/*.tsx'], exclude: ['**/node_modules/**'] },
  components: { framework: 'react', functionalInExtensions: ['.tsx'], imports: {} },
  routes: { configArray: true },
};

describe('routes — lazy(() => import(…)) component resolution', () => {
  it('resolves componentId (and marks isLazy) for both lazy shapes, alongside static routes', async () => {
    dir = writeFixture();
    const { repo } = await runProfile(PROFILE, dir, 'lazy-routes');
    const byPath = new Map((repo.routes ?? []).map((r) => [r.path, r]));
    const componentIdOf = (file: string, name: string): string | undefined =>
      (repo.components ?? []).find((c) => c.location.filePath === file && c.name === name)?.id;

    const explorerComponent = componentIdOf('src/pages/explorer.tsx', 'WorkspaceExplorer');
    const roadmapComponent = componentIdOf('src/pages/roadmap.tsx', 'DashboardRoadmap');
    const overviewComponent = componentIdOf('src/pages/overview.tsx', 'WorkspaceOverview');
    expect(explorerComponent).toBeDefined();
    expect(roadmapComponent).toBeDefined();
    expect(overviewComponent).toBeDefined();

    // Static sibling — the pre-existing path, kept as the control.
    expect(byPath.get('/overview')?.componentId).toBe(overviewComponent);
    expect(byPath.get('/overview')?.isLazy).toBe(false);

    // `.then(m => ({ default: m.Named }))` — the named-export lazy shape.
    expect(byPath.get('/explorer')?.componentId).toBe(explorerComponent);
    expect(byPath.get('/explorer')?.isLazy).toBe(true);

    // `lazy(() => import('./x.js'))` — the default-export lazy shape.
    expect(byPath.get('/roadmap')?.componentId).toBe(roadmapComponent);
    expect(byPath.get('/roadmap')?.isLazy).toBe(true);
  });
});
